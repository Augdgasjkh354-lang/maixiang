import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { employmentSnapshot, initializeBuildingJobs } from "./employment.js";
import { atomicInventoryTransaction, quantityToUnits } from "../economy/inventory.js";
import { procureTownMaterial, previewTownMaterialProcurement, clearPublicProcurementIntent, checkTownMaterialShortfall } from "./public-procurement.js";
import { readJobCount } from "../selectors/labor.js";
import { setJobCount } from "./households.js";
import { syncOwnershipLevels } from "./ownership.js";

// 建筑工总量即各工程投入人数之和；不再有“一次一个工程”的人为上限。
export function totalProjectWorkers(state) {
  return (state.projects || []).reduce(function (sum, project) {
    return sum + Math.max(0, Math.floor(project.workers || 0));
  }, 0);
}

// 从全镇劳力中为本工程招募指定人数：按增量调整，不吞掉其他工程或岗位的人。
// 可用来源＝全镇待业劳力 + 尚未挂到任何工程上的营造工（旧存档或外部设置的建筑工）。
// 自然约束只有“全镇可用劳力总数”；营造岗位容量本身就是各工程人数之和，不另设人为上限。
export function staffProject(state, project, requested, content) {
  const target = Math.max(0, Math.floor(Number(requested) || 0));
  const own = Math.max(0, Math.floor(project.workers || 0));
  const others = totalProjectWorkers(state) - own;
  const snapshot = employmentSnapshot(state, content);
  const unassignedBuilders = Math.max(0, readJobCount(state, "builders") - totalProjectWorkers(state));
  // 本工程现有工人可继续留用；再加上待业劳力与其他未挂工程的营造工。
  const limit = Math.max(0, own + others + snapshot.idle + unassignedBuilders);
  const wanted = Math.min(target, limit);
  const total = others + wanted;
  const currentTotal = readJobCount(state, "builders");
  if (total !== currentTotal) {
    setJobCount(state, "builders", total, content, { type: "town", id: "projects" });
  }
  // setJobCount 可能因家庭劳力上限而少分：以实际在岗人数为准，避免虚报投入人数。
  const actualTotal = readJobCount(state, "builders");
  const assigned = Math.max(0, Math.min(wanted, actualTotal - others));
  project.workers = assigned;
  return { ok: true, requested: target, assigned, limit, idle: snapshot.idle, unassignedBuilders };
}

// 调整某个在建工程的投入人数。减少的人数回归待业（由 setJobCount 增量归还）。
export function setProjectWorkers(state, projectId, workers, content) {
  const project = (state.projects || []).find(function (row) { return row.instanceId === projectId; });
  if (!project) return { ok: false, reason: "工程不存在或已完工" };
  const requested = Math.max(0, Math.floor(Number(workers) || 0));
  const result = staffProject(state, project, requested, content);
  return { ok: true, changed: result.assigned !== (project.workers || 0), assigned: result.assigned,
    requested, limit: result.limit, reason: result.assigned < requested ? "全镇待业劳力不足" : null };
}

export function startConstruction(state, typeId, plotId, content, options = {}) {
  const definition = content.buildings[typeId];
  if (!definition) return { ok: false, reason: "未知建筑" };
  const existingCount = state.buildings.filter(function (building) {
    return building.typeId === typeId;
  }).length;
  const pendingCount = state.projects.filter(function (project) {
    return project.kind !== "upgrade" && project.typeId === typeId;
  }).length;
  if (existingCount + pendingCount >= (definition.maxInstances ?? Infinity)) {
    return { ok: false, reason: "同类建筑已达到可建数量" };
  }
  const plot = state.plots.find(function (item) { return item.id === plotId; });
  if (!plot) return { ok: false, reason: "请在地图空地上选址" };
  if (definition.requiredPlotFeature && plot.feature !== definition.requiredPlotFeature) {
    const featureName = definition.requiredPlotFeature === "salt_mine" ? "盐矿" : "南部森林资源点";
    return { ok: false, reason: definition.name + "只能建在" + featureName + "地块" };
  }
  if (state.buildings.some(function (building) { return building.plotId === plotId; })) {
    return { ok: false, reason: "这块地已经有建筑" };
  }
  if (state.projects.some(function (project) { return project.plotId === plotId; })) {
    return { ok: false, reason: "这块地已有工程" };
  }

  let materialTransactionId = null;
  const materialLines = (definition.materialRequirements || []).map(function (item) {
    return {
      owner: "town", sourceOwner: "town", itemId: item.itemId,
      quantityUnits: quantityToUnits(item.quantity, content)
    };
  });
  if (materialLines.length) {
    // 先确认非木材材料充足，再采购木材：避免采购后因其他材料不足导致扣除失败时已采购无法回滚
    const shortfall = checkTownMaterialShortfall(state, materialLines, content);
    if (!shortfall.ok) return shortfall;
    for (const line of materialLines) {
      const missing = Math.max(0, line.quantityUnits - (state.accounts.town[line.itemId] || 0));
      if (missing > 0 && line.itemId === "wood") {
        const market = previewTownMaterialProcurement(state, line.itemId, missing, content);
        if (market.purchasableUnits < missing) {
          const item = content.items[line.itemId];
          const missingJin = (missing - market.purchasableUnits) / content.precision.inventoryUnitsPerJin;
          return { ok: false, reason: `镇库及企业市场${item?.name || line.itemId}不足或镇库粮券不足，还缺${missingJin.toLocaleString("zh-CN", { maximumFractionDigits: 3 })}${item?.name || line.itemId}` };
        }
        const bought = procureTownMaterial(state, line.itemId, missing, content);
        if (bought.boughtUnits < missing) return { ok: false, reason: `采购${content.items[line.itemId]?.name || line.itemId}未完整成交，未扣施工材料` };
      }
    }
    const materialTransaction = atomicInventoryTransaction(state, {
      inputs: materialLines,
      inputType: "construction_material",
      inputDestination: "construction_asset",
      reason: definition.name + "施工材料；开工时一次性入工程"
    }, content);
    if (!materialTransaction.ok) {
      const item = content.items[materialTransaction.itemId];
      const needed = materialLines.find(row => row.itemId === materialTransaction.itemId)?.quantityUnits || 0;
      const available = state.accounts.town[materialTransaction.itemId] || 0;
      const missing = Math.max(0, needed - available) / content.precision.inventoryUnitsPerJin;
      return {
        ok: false,
        reason: "镇库" + (item?.name || materialTransaction.itemId) + "不足，还缺" +
          missing.toLocaleString("zh-CN", { maximumFractionDigits: 3 }) + (item?.name || materialTransaction.itemId)
      };
    }
    materialTransactionId = materialTransaction.transactionId;
  }

  const construction = definition.construction;
  const instanceNumber = state.nextInstanceNumber || 1;
  const instanceId = "building-" + instanceNumber;
  state.nextInstanceNumber = instanceNumber + 1;
  const project = {
    kind: "build",
    instanceId,
    typeId,
    plotId,
    workDone: 0,
    workRequired: construction.workDays,
    recommendedWorkers: construction.recommendedWorkers,
    workers: 0,
    materialsConsumed: materialLines.map(line => ({ itemId: line.itemId, quantityUnits: line.quantityUnits, sourceOwner: line.sourceOwner, transactionId: materialTransactionId })),
    started: (() => {
      // 年末最后一天开工，年份进位（之前只封顶天数，年份没进位）。
      const nextDay = (state.day || 0) + 1;
      const daysPerYear = content.rules.daysPerYear || 365;
      return nextDay > daysPerYear
        ? { year: (state.year || 1) + 1, day: 1 }
        : { year: state.year, day: nextDay };
    })()
  };
  state.projects.push(project);
  // 只按本工程设定人数招募；不再“有多少要多少”式全局招募其他工程的施工队。
  const requested = Number.isFinite(options.workers)
    ? options.workers : construction.recommendedWorkers;
  const staffing = staffProject(state, project, requested, content);
  const assigned = staffing.assigned;
  recordEvent(
    state,
    "在" + plot.label + "动工修建" + definition.name + "，投入建筑工" + assigned + "人，按实际施工日领取粮券工资。",
    content,
    { day: state.day + 1 }
  );
  clearPublicProcurementIntent(state, "wood");
  return { ok: true, assignedBuilders: assigned, instanceId, workers: assigned };
}

export function advanceConstruction(state, content) {
  const projects = state.projects || [];
  if (!projects.length) return null;
  const results = [];
  const completed = [];
  // 每个工程按各自投入的工人数推进；工人不足的工程原地等待，不影响其他工程。
  for (const project of projects.slice()) {
    const workers = Math.max(0, Math.floor(project.workers || 0));
    if (workers <= 0) {
      results.push({ instanceId: project.instanceId, status: "no_workers", completed: false, workers: 0 });
      continue;
    }
    project.workDone = Math.min(project.workRequired, project.workDone + workers);
    if (project.workDone < project.workRequired) {
      results.push({ instanceId: project.instanceId, status: "working", completed: false, workers, workDone: project.workDone });
      continue;
    }
    completed.push(finishProject(state, project, content, results));
  }
  // 完工工程退出数组；其建筑工回归待业劳力池，其余工程继续施工。
  for (const project of completed) {
    state.projects = state.projects.filter(function (row) { return row.instanceId !== project.instanceId; });
  }
  if (!state.projects.length) {
    // 没有在建工程时清空营造岗位；有工程时保留，人数由各工程 workers 决定。
    if (readJobCount(state, "builders") !== 0) setJobCount(state, "builders", 0, content);
  }
  return {
    status: completed.length ? "completed" : (results.some(row => row.status === "working") ? "working" : "no_workers"),
    completed: completed.length > 0,
    projects: results,
    finished: completed.map(row => row.result)
  };
}

// 完成一个工程：落成或升级，并把该工程投入的建筑工归还待业（不动其他工程的人）。
function finishProject(state, project, content, results) {
  if (project.kind === "upgrade") {
    const upgraded = state.buildings.find(row => row.id === project.buildingId);
    if (!upgraded) throw new Error("升级工程关联的建筑实例不存在");
    upgraded.level = project.targetLevel;
    // 新等级归当前主人：镇营、民营业主或公司（整栋一个主人，见 systems/ownership.js）。
    syncOwnershipLevels(state, upgraded);
    upgraded.materialInvestments ||= [];
    for (const row of project.materialsConsumed || []) {
      upgraded.materialInvestments.push({
        itemId: row.itemId, quantityUnits: row.quantityUnits,
        sourceOwner: row.sourceOwner || "town", projectId: project.instanceId,
        transactionId: row.transactionId || null, purpose: "upgrade", level: project.targetLevel
      });
    }
    const name = content.buildings[project.typeId]?.name || project.typeId;
    releaseProjectWorkers(state, project, content);
    recordEvent(state, `${name}原地扩建完成，现为${upgraded.level}级；新增岗位保持空缺。`, content, { day: state.day + 1 });
    results.push({ instanceId: project.instanceId, status: "completed", completed: true, upgraded: true, building: upgraded, workers: 0 });
    return { instanceId: project.instanceId, result: { status: "completed", completed: true, building: upgraded, upgraded: true } };
  }
  const plot = state.plots.find(function (item) { return item.id === project.plotId; });
  const definition = content.buildings[project.typeId];
  const building = {
    id: project.instanceId,
    typeId: project.typeId,
    level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    materialInvestments: (project.materialsConsumed || []).map(row => ({
      itemId: row.itemId, quantityUnits: row.quantityUnits,
      sourceOwner: row.sourceOwner || "town", projectId: project.instanceId,
      transactionId: row.transactionId || null, purpose: "construction", level: 1
    })),
    plotId: project.plotId,
    x: plot.x,
    y: plot.y,
    housingCapacity: definition.housingCapacity || 0,
    completed: { year: state.year, day: Math.min(content.rules.daysPerYear, state.day + 1) }
  };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, content);
  const name = definition ? definition.name : project.typeId;
  releaseProjectWorkers(state, project, content);
  recordEvent(state, name + "落成，可以安排工人开工了。", content,
    { day: state.day + 1 });
  results.push({ instanceId: project.instanceId, status: "completed", completed: true, building, workers: 0 });
  return { instanceId: project.instanceId, result: { status: "completed", completed: true, building } };
}

// 该工程投入的建筑工归还待业：按增量从营造岗位总量中减去本工程人数。
function releaseProjectWorkers(state, project, content) {
  const workers = Math.max(0, Math.floor(project.workers || 0));
  project.workers = 0;
  if (workers <= 0) return 0;
  const current = readJobCount(state, "builders");
  const next = Math.max(0, current - workers);
  if (next !== current) setJobCount(state, "builders", next, content);
  return workers;
}
