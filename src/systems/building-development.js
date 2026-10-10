import { atomicInventoryTransaction, quantityToUnits, returnConstructionMaterial } from "../economy/inventory.js";
import { recordEvent } from "../economy/ledger.js";
import { employmentSnapshot } from "./employment.js";
import { populationStats } from "../selectors/labor.js";
import { selectHousing } from "../selectors/housing.js";
import { procureTownMaterial, previewTownMaterialProcurement, clearPublicProcurementIntent, checkTownMaterialShortfall } from "./public-procurement.js";
import { householdList, releaseJobFromHousehold } from "./households.js";
import { staffProject } from "./construction.js";
import { windUpCollectiveShop } from "./shops.js";
import { currentPaymentComposition, maximumPayableValueUnits, quoteMonetaryPayment, settleMonetaryPayment } from "../economy/payment.js";
import { currentUnitPrice } from "../economy/prices.js";
import { allocateInputToTown } from "./wholesale-market.js";
import { buildingOwner, companyOfBuilding, daySerialOf, jobKeyForOwner, valueUnitsOfGoods } from "./ownership.js";
import { householdConvertibleWheatUnits } from "./households.js";
import { readJobCount } from "../selectors/labor.js";
import { privateWageRate, townWageRate } from "./payroll.js";

function materialLines(rows, content) {
  return (rows || []).map(row => ({
    owner: "town", itemId: row.itemId,
    quantityUnits: quantityToUnits(row.quantity, content), sourceOwner: "town"
  }));
}

// 该建筑是否已有在建工程（新建占其地块，或正在原地升级）。
function projectsForBuilding(state, building) {
  return (state.projects || []).filter(project =>
    project.buildingId === building.id || project.plotId === building.plotId);
}

export function selectUpgradePreview(state, buildingId, content) {
  const building = state.buildings.find(row => row.id === buildingId);
  if (!building) return { available: false, reason: "建筑不存在" };
  // 镇库只升级镇营建筑：含公司/民营经营权的，镇库出钱别人受益，不予升级（之前不校验）。
  const ownership = building.ownership || {};
  if ((ownership.privateLevels || 0) > 0 || (ownership.listedLevels || 0) > 0) {
    return { available: false, reason: "含公司/民营经营权的建筑由业主出资升级，镇库不垫付" };
  }
  const definition = content.buildings[building.typeId];
  const config = definition?.upgrade;
  const level = Math.max(1, building.level || 1);
  if (!config) return { available: false, reason: "此建筑不能升级" };
  if (level >= (config.maxLevel || content.rules.buildingMaxLevel || 10)) return { available: false, reason: "已达到最高等级", level };
  if (projectsForBuilding(state, building).length) return { available: false, reason: "这座建筑已有一处工程在施工", level };
  const required = materialLines(config.materialRequirements, content).map(line => {
    const scale = content.precision.inventoryUnitsPerJin;
    const townUnits = state.accounts.town[line.itemId] || 0;
    const marketNeedUnits = Math.max(0, line.quantityUnits - townUnits);
    const market = previewTownMaterialProcurement(state, line.itemId, marketNeedUnits, content);
    return {
      ...line, name: content.items[line.itemId]?.name || line.itemId,
      unit: content.items[line.itemId]?.unit || "单位",
      required: line.quantityUnits / scale,
      available: townUnits / scale,
      marketAvailable: market.companyAvailableUnits / scale,
      marketPurchasable: market.purchasableUnits / scale,
      marketCostVoucher: market.costVoucherUnits / content.precision.currencyUnitsPerVoucher,
      missing: Math.max(0, line.quantityUnits - townUnits - market.purchasableUnits) / scale
    };
  });
  const recommended = config.recommendedWorkers || definition.construction.recommendedWorkers;
  const labor = employmentSnapshot(state, content);
  const wage = townWageRate(state, "builders", content);
  // 本工程可招募人数只受“当前待业劳力”约束，不再受其他工程占用的全局上限挤压。
  const builders = Math.max(0, Math.min(recommended, labor.idle));
  const days = builders > 0 ? Math.ceil(config.workDays / builders) : null;
  return {
    available: true, buildingId, name: definition.name, currentLevel: level,
    nextLevel: level + 1, workDays: config.workDays,
    recommendedWorkers: config.recommendedWorkers || definition.construction.recommendedWorkers,
    estimatedDays: days, estimatedWageJin: days ? days * builders * wage : 0,
    availableBuilders: builders, waitingForWorkers: builders <= 0,
    materials: required,
    materialsAffordable: required.every(row => row.missing <= 1 / content.precision.inventoryUnitsPerJin)
  };
}

export function startBuildingUpgrade(state, buildingId, content, options = {}) {
  const preview = selectUpgradePreview(state, buildingId, content);
  if (!preview.available) return { ok: false, reason: preview.reason };
  if (!preview.materialsAffordable) {
    const missing = preview.materials.find(row => row.missing > 0);
    return { ok: false, reason: `镇库及企业市场${missing.name}不足或镇库粮券不足，尚缺${missing.missing}${missing.name}` };
  }
  const building = state.buildings.find(row => row.id === buildingId);
  const definition = content.buildings[building.typeId];
  const lines = materialLines(definition.upgrade.materialRequirements, content);
  // 先确认非木材材料充足，再采购木材：避免采购后因其他材料不足导致扣除失败时已采购无法回滚
  const shortfall = checkTownMaterialShortfall(state, lines, content);
  if (!shortfall.ok) return shortfall;
  for (const row of preview.materials) {
    const townShortfall = Math.max(0, row.required - row.available);
    if (townShortfall > 0 && row.itemId === "wood") {
      const wantedUnits = Math.round(townShortfall * content.precision.inventoryUnitsPerJin);
      const market = previewTownMaterialProcurement(state, row.itemId, wantedUnits, content);
      if (market.purchasableUnits < wantedUnits) {
        return { ok: false, reason: `企业市场${row.name}或镇库粮券不足，无法完成采购` };
      }
      const bought = procureTownMaterial(state, row.itemId, wantedUnits, content);
      if (bought.boughtUnits < wantedUnits) return { ok: false, reason: `采购${row.name}未完整成交，升级未开工` };
    }
  }
  return openUpgradeProject(state, building, definition, preview, lines, content, options, null);
}

// 开工一个升级工程：材料从镇库扣（开工时一次性入工程），建立工程并招募建筑工。
// prepaid（业主自主升级）= { payer, valueUnits, transactionId }：材料与费用已由业主付给镇库，工程照常由镇里施工。
function openUpgradeProject(state, building, definition, preview, lines, content, options = {}, prepaid = null) {
  if (lines.length) {
    const charged = atomicInventoryTransaction(state, {
      inputs: lines.map(({ owner, itemId, quantityUnits }) => ({ owner, itemId, quantityUnits })),
      inputType: "construction_material", inputDestination: "construction_asset",
      reason: `${definition.name}升至${preview.nextLevel}级；材料开工时一次性入工程`
    }, content);
    if (!charged.ok) return { ok: false, reason: charged.reason || "升级材料扣除失败" };
    for (const row of lines) row.transactionId = charged.transactionId;
  }
  const instanceId = `upgrade-${building.id}-level-${preview.nextLevel}`;
  const project = {
    kind: "upgrade", instanceId, buildingId: building.id, typeId: building.typeId,
    plotId: building.plotId, targetLevel: preview.nextLevel,
    workDone: 0, workRequired: definition.upgrade.workDays,
    recommendedWorkers: definition.upgrade.recommendedWorkers || definition.construction.recommendedWorkers,
    workers: 0,
    materialsConsumed: lines.map(row => ({ itemId: row.itemId, quantityUnits: row.quantityUnits, sourceOwner: row.sourceOwner, transactionId: row.transactionId })),
    started: { year: state.year, day: Math.min(content.rules.daysPerYear, state.day + 1) }
  };
  if (prepaid) project.prepaid = { payer: prepaid.payer, valueUnits: prepaid.valueUnits, transactionId: prepaid.transactionId || null };
  state.projects.push(project);
  const requested = Number.isFinite(options.workers)
    ? options.workers : project.recommendedWorkers;
  const staffing = staffProject(state, project, requested, content);
  const payerText = prepaid ? `，业主已一次性付给镇库${Math.round(prepaid.valueUnits / content.precision.currencyUnitsPerVoucher)}券` : "";
  recordEvent(state, `${definition.name}开始原地扩建至${preview.nextLevel}级；原有岗位与产能在施工期间保持不变${payerText}。`, content, { day: state.day + 1 });
  clearPublicProcurementIntent(state, "wood");
  return { ok: true, projectId: instanceId, assignedBuilders: staffing.assigned, workers: staffing.assigned, preview };
}

// ---------------------------------------------------------------- 民营/公司业主自主升级（docs/OWNERSHIP.md 第 4 条）
// 镇营由镇长手动升级；民营与公司每 ownerUpgradeCheckDays 天检查一次：
//   近 ownerUpgradeProfitDays 天利润 > 0；在岗 ≥ 岗位上限 × ownerUpgradeStaffingRatio；
//   现金 ≥ 升级花费 + ownerUpgradeReserveWageDays 天工资。
// 升级花费 = 材料按批发价折算 + 工日 × 建筑工工资，一次性付给镇库；之后工程照常由镇里施工（材料不再由镇库付钱）。

function ownerWageRate(state, building, owner, job, content) {
  if (owner.kind === "company") {
    const company = companyOfBuilding(state, building.id);
    if (Number.isFinite(company?.settings?.wagePerWorkerDay)) return company.settings.wagePerWorkerDay;
  }
  if (owner.kind === "household") return privateWageRate(state, building, job, content);
  return state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 5;
}

function ownerRecentProfitUnits(state, building, owner, content) {
  const days = content.rules.ownerUpgradeProfitDays ?? 60;
  const serial = daySerialOf(state, content);
  const rows = owner.kind === "household"
    ? (building.privateProfitHistory || [])
    : (companyOfBuilding(state, building.id)?.history || []);
  return rows.filter(row => Number.isInteger(row.serial) && row.serial > serial - days && row.serial <= serial)
    .reduce((sum, row) => sum + (row.profitVoucherUnits || 0), 0);
}

function tryOwnerUpgrade(state, building, owner, content) {
  const definition = content.buildings[building.typeId];
  const config = definition?.upgrade;
  const job = definition?.jobs?.[0];
  if (!config || !job || !owner.id) return null;
  const level = Math.max(1, building.level || 1);
  const base = { buildingId: building.id, ownerKind: owner.kind, ownerId: owner.id, nextLevel: level + 1 };
  if (level >= (config.maxLevel || content.rules.buildingMaxLevel || 10)) return null;
  if (projectsForBuilding(state, building).length) return null;
  const moneyScale = content.precision.currencyUnitsPerVoucher;
  const workers = readJobCount(state, jobKeyForOwner(owner.kind, building.id, job.id));
  const staffNeeded = Math.ceil(job.slots * level * (content.rules.ownerUpgradeStaffingRatio ?? 0.9));
  if (workers < staffNeeded) return { ...base, status: "skipped", reason: "在岗人数不足岗位上限的九成" };
  if (ownerRecentProfitUnits(state, building, owner, content) <= 0) return { ...base, status: "skipped", reason: "近期利润不为正" };
  const lines = materialLines(config.materialRequirements, content);
  for (const line of lines) {
    const available = (state.accounts.town[line.itemId] || 0) + (state.wholesaleMarket?.inventory?.[line.itemId] || 0);
    if (available < line.quantityUnits) return { ...base, status: "skipped", reason: `${content.items[line.itemId]?.name || line.itemId}不足` };
  }
  const materialCostUnits = lines.reduce((sum, line) =>
    sum + valueUnitsOfGoods(line.quantityUnits, currentUnitPrice(state, line.itemId, content), content), 0);
  const builderWage = townWageRate(state, "builders", content);
  const labourCostUnits = Math.round(config.workDays * builderWage * moneyScale);
  const costUnits = materialCostUnits + labourCostUnits;
  const dailyWageUnits = Math.round(workers * ownerWageRate(state, building, owner, job, content) * moneyScale);
  const reserveUnits = dailyWageUnits * (content.rules.ownerUpgradeReserveWageDays ?? 60);
  const payer = owner.kind === "household" ? `household:${owner.id}` : `company:${owner.id}`;
  const household = owner.kind === "household" ? state.households?.byId?.[owner.id] : null;
  const payOptions = household ? { maxWheatUnits: householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30) } : {};
  const payable = maximumPayableValueUnits(state, payer, content, payOptions);
  if (payable < costUnits + reserveUnits) return { ...base, status: "skipped", reason: "现金不足（需另留60天工资）", costVoucher: costUnits / moneyScale };
  const quote = quoteMonetaryPayment(state, payer, currentPaymentComposition(state, costUnits), content, payOptions);
  if (!quote.full) return { ...base, status: "skipped", reason: "现金不足（需另留60天工资）", costVoucher: costUnits / moneyScale };
  // 先在镇内把缺的材料从批发市场调到镇库（内部无偿，不付钱），再收款；收款失败则货留在镇库，不丢钱。
  for (const line of lines) {
    const short = Math.max(0, line.quantityUnits - (state.accounts.town[line.itemId] || 0));
    if (short > 0) allocateInputToTown(state, line.itemId, short, content, `${definition.name}业主升级：批发市场调拨材料`);
  }
  const payment = settleMonetaryPayment(state, payer, "town", currentPaymentComposition(state, costUnits), content,
    "owner_upgrade_payment", `${owner.kind === "company" ? "公司" : "民营业主"}出资升级${definition.name}至${level + 1}级`,
    { requireFull: true, ...payOptions });
  if (!payment.ok) return { ...base, status: "skipped", reason: payment.reason || "付款失败", costVoucher: costUnits / moneyScale };
  const opened = openUpgradeProject(state, building, definition, { nextLevel: level + 1 }, lines, content, {},
    { payer, valueUnits: costUnits, transactionId: payment.transactionId });
  if (!opened.ok) return { ...base, status: "failed", reason: opened.reason };
  return { ...base, status: "started", costVoucher: costUnits / moneyScale, materialCostVoucher: materialCostUnits / moneyScale, labourCostVoucher: labourCostUnits / moneyScale, projectId: opened.projectId };
}

// 日结步骤 ownerUpgrades：按检查周期扫描民营与公司建筑，满足条件的业主自主升级。
export function settleOwnerUpgrades(state, content) {
  const checkDays = Math.max(1, content.rules.ownerUpgradeCheckDays || 30);
  if (daySerialOf(state, content) % checkDays !== 0) return [];
  const rows = [];
  for (const building of state.buildings.slice()) {
    const owner = buildingOwner(state, building);
    if (owner.kind === "town") continue;
    const row = tryOwnerUpgrade(state, building, owner, content);
    if (row) rows.push(row);
  }
  return rows;
}

export function selectDemolitionPreview(state, buildingId, content) {
  const building = state.buildings.find(row => row.id === buildingId);
  if (!building) return { available: false, reason: "建筑不存在" };
  if (projectsForBuilding(state, building).length) {
    return { available: false, reason: "这座建筑仍在施工或升级，请工程完成后再拆除" };
  }
  if ((building.ownership?.listedLevels || 0) > 0) return { available: false, reason: "建筑归公司所有，须先完成公司清算" };
  if ((building.ownership?.privateLevels || 0) > 0) return { available: false, reason: "建筑归民营业主所有，须先按估值收回" };
  if (building.typeId === "bank") {
    return { available: false, reason: "银行承担粮券印制与换券，不能拆除" };
  }
  if (building.typeId === "stock_exchange" && Object.values(state.companies || {}).some(company => company.listing?.listed)) {
    return { available: false, reason: "仍有上市公司，交易所承担挂牌与股权记录，不能拆除" };
  }
  if (content.buildings[building.typeId]?.shopHost && Object.values(state.shops || {}).some(shop => shop.buildingId === buildingId && shop.status !== "closed" && !shop.collective)) return { available: false, reason: `请先关闭${content.buildings[building.typeId].name}内的店铺` };
  if (["field", "granary", "houses"].includes(building.typeId)) return { available: false, reason: "基础村舍、麦田和粮仓不能拆除" };
  const definition = content.buildings[building.typeId];
  const materials = (building.materialInvestments || []).filter(row => row.quantityUnits > 0)
    .map(row => ({ itemId: row.itemId, owner: row.sourceOwner || "town", quantityUnits: row.quantityUnits }));
  const totals = new Map();
  for (const row of materials) {
    const key = `${row.owner}|${row.itemId}`;
    totals.set(key, (totals.get(key) || 0) + row.quantityUnits);
  }
  const refund = Array.from(totals, ([key, quantityUnits]) => {
    const [owner, itemId] = key.split("|");
    return { owner, itemId, quantityUnits,
      name: content.items[itemId]?.name || itemId,
      unit: content.items[itemId]?.unit || "单位",
      quantity: quantityUnits / content.precision.inventoryUnitsPerJin };
  });
  const workers = householdList(state).reduce((sum, household) => sum + Object.entries(household.jobs || {})
    .filter(([key]) => key.startsWith(buildingId + "::")).reduce((part, [, count]) => part + count, 0), 0);
  let housingShortage = 0;
  if (definition?.housingCapacity) {
    const housing = selectHousing(state, content);
    const remainingCapacity = housing.capacity - (definition.housingCapacity * Math.max(1, building.level || 1));
    housingShortage = Math.max(0, populationStats(state).total - remainingCapacity);
  }
  return { available: housingShortage === 0, reason: housingShortage ? `拆除后还差${housingShortage}个住房名额，暂不能安置全镇人口` : null,
    buildingId, name: definition?.name || building.typeId, level: building.level || 1,
    workers, refund, housingShortage };
}

export function demolishBuilding(state, buildingId, content) {
  const preview = selectDemolitionPreview(state, buildingId, content);
  if (!preview.available) return { ok: false, reason: preview.reason };
  const building = state.buildings.find(row => row.id === buildingId);
  for (const row of preview.refund) {
    const returned = returnConstructionMaterial(state, building.id, row.owner, row.itemId,
      row.quantityUnits, `${preview.name}拆除：返还可追溯的实际建筑材料`, content);
    if (!returned.ok) return { ok: false, reason: returned.reason };
  }
  state.demolishedBuildings ||= [];
  state.demolishedBuildings.push({ id: building.id, typeId: building.typeId, plotId: building.plotId,
    level: building.level || 1, materialInvestments: building.materialInvestments || [],
    demolished: { year: state.year, day: Math.min(content.rules.daysPerYear, state.day + 1) } });
  for (const household of householdList(state)) {
    for (const jobKey of Object.keys(household.jobs || {})) {
      if (jobKey.startsWith(buildingId + "::")) releaseJobFromHousehold(state, household.id, jobKey);
    }
  }
  for (const shop of Object.values(state.shops || {})) if (shop.buildingId === buildingId && shop.collective) windUpCollectiveShop(state, shop, content);
  state.buildings = state.buildings.filter(row => row.id !== buildingId);
  recordEvent(state, `${preview.name}已拆除，${preview.workers}名工人转为待业；工资、欠薪与经营历史继续保留。`, content, { day: state.day + 1 });
  return { ok: true, preview };
}
