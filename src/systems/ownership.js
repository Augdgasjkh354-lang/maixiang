// 所有制（docs/OWNERSHIP.md）：一栋产业建筑整栋只有一个主人——镇里、某一户人家，或一家公司。
//
// 数据表示：building.ownership = { townLevels, privateLevels, listedLevels }，三者恰好一个等于 building.level，其余为 0。
//   镇里     townLevels = level
//   一户人家 privateLevels = level，building.privateOwners = [householdId]（长度恰好 1）
//   公司     listedLevels = level，company.buildingId 指向它，company.listedLevels = level
//
// 所有换主人、等级归属变化都经过本模块：transferBuildingOwnership / syncOwnershipLevels。
// 不要在别处直接改 ownership 或 privateOwners。

import { householdList, jobAssignments, setHouseholdJobCount } from "./households.js";
import { jobKeyForBuilding, privateJobKeyForBuilding, listedJobKeyForBuilding, readJobCount } from "../selectors/labor.js";
import { currencyScale } from "../economy/currency.js";
import { currentUnitPrice } from "../economy/prices.js";

export const OWNER_KINDS = Object.freeze(["town", "household", "company"]);

export function companyOfBuilding(state, buildingId) {
  return Object.values(state.companies || {}).find(company => company.buildingId === buildingId) || null;
}

// 当前主人：{ kind: "town"|"household"|"company", id }。镇营的 id 为 null。
export function buildingOwner(state, building) {
  const ownership = building.ownership || {};
  if ((ownership.privateLevels || 0) > 0) return { kind: "household", id: (building.privateOwners || [])[0] || null };
  if ((ownership.listedLevels || 0) > 0) return { kind: "company", id: companyOfBuilding(state, building.id)?.id || null };
  return { kind: "town", id: null };
}

// 某主人对应的岗位键（岗位键不变：镇营/民营/公司各一把）。
export function jobKeyForOwner(kind, buildingId, roleId) {
  if (kind === "household") return privateJobKeyForBuilding(buildingId, roleId);
  if (kind === "company") return listedJobKeyForBuilding(buildingId, roleId);
  return jobKeyForBuilding(buildingId, roleId);
}

function ownershipFor(kind, level) {
  return {
    townLevels: kind === "town" ? level : 0,
    privateLevels: kind === "household" ? level : 0,
    listedLevels: kind === "company" ? level : 0
  };
}

function industryJobs(building, content) {
  return (content.buildings[building.typeId]?.jobs || []).filter(job => !job.managedBy);
}

// 把在岗人数从其他主人的岗位键整体搬到新主人的岗位键，不超过新主人的岗位上限；超出的人回归待业。
function moveWorkersToOwnerKeys(state, building, toKind, content) {
  const level = Math.max(1, building.level || 1);
  let moved = 0;
  for (const job of industryJobs(building, content)) {
    const targetKey = jobKeyForOwner(toKind, building.id, job.id);
    let room = Math.max(0, job.slots * level - readJobCount(state, targetKey));
    for (const fromKind of OWNER_KINDS) {
      if (fromKind === toKind) continue;
      const fromKey = jobKeyForOwner(fromKind, building.id, job.id);
      const rows = jobAssignments(state, fromKey).map(row => ({ householdId: row.householdId, count: row.count }));
      if (!rows.length) continue;
      for (const row of rows) setHouseholdJobCount(state, row.householdId, fromKey, 0, null);
      for (const row of rows) {
        const keep = Math.min(row.count, room);
        if (keep <= 0) continue;
        const current = state.households?.byId?.[row.householdId]?.jobs?.[targetKey] || 0;
        setHouseholdJobCount(state, row.householdId, targetKey, current + keep, null);
        room -= keep;
        moved += keep;
      }
    }
  }
  return moved;
}

// 换主人：整栋建筑归新主人。newOwner = { kind, id }。
// 同时改写 ownership、privateOwners、公司 listedLevels、家庭 operatingRights，并搬移岗位人数，最后让经营计划失效。
// 调用方负责先处理旧公司（清算/删除）或新公司（先建公司对象）。
export function transferBuildingOwnership(state, building, newOwner, content) {
  const kind = newOwner?.kind;
  if (!OWNER_KINDS.includes(kind)) throw new Error("未知主人类型：" + kind);
  if (kind === "household" && !state.households?.byId?.[newOwner.id]) throw new Error("新业主家庭不存在：" + newOwner.id);
  if (kind === "company") {
    const company = companyOfBuilding(state, building.id);
    if (!company || company.id !== newOwner.id) throw new Error("新业主公司与建筑不对应：" + building.id);
  }
  const before = buildingOwner(state, building);
  const level = Math.max(1, building.level || 1);
  const movedWorkers = moveWorkersToOwnerKeys(state, building, kind, content);
  building.ownership = ownershipFor(kind, level);
  if (kind === "household") building.privateOwners = [newOwner.id];
  else delete building.privateOwners;
  // 民营工资是业主自己定的，换主人后新业主从镇营行情起步。
  delete building.privateWage;
  if (kind === "company") {
    const company = companyOfBuilding(state, building.id);
    company.listedLevels = level;
  }
  for (const household of householdList(state)) {
    if (!Array.isArray(household.operatingRights)) continue;
    const kept = household.operatingRights.filter(row => row.buildingId !== building.id);
    if (kept.length !== household.operatingRights.length) household.operatingRights = kept;
  }
  if (kind === "household") {
    const household = state.households.byId[newOwner.id];
    household.operatingRights ||= [];
    household.operatingRights.push({ buildingId: building.id, level });
  }
  if (state.market?.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  return { ok: true, from: before, to: buildingOwner(state, building), movedWorkers };
}

// 等级变化（原地升级完工）后，把新等级记到当前主人名下；公司的 listedLevels 同步。
export function syncOwnershipLevels(state, building) {
  const owner = buildingOwner(state, building);
  const level = Math.max(1, building.level || 1);
  building.ownership = ownershipFor(owner.kind, level);
  if (owner.kind === "company") {
    const company = companyOfBuilding(state, building.id);
    if (company) company.listedLevels = level;
  }
  return building.ownership;
}

// 把 units（斤×精度）按每斤价（粮券）折算成价值单位，四舍五入。
export function valueUnitsOfGoods(units, pricePerJin, content) {
  return Math.round(units / content.precision.inventoryUnitsPerJin * pricePerJin * currencyScale(content));
}

// 所有制监视（欠薪连续天数）。惰性创建，旧档无此字段也能读。
export function ownershipWatch(state) {
  state.ownershipWatch ||= { arrearsDaysByBuilding: {}, arrearsDaysByCompany: {} };
  state.ownershipWatch.arrearsDaysByBuilding ||= {};
  state.ownershipWatch.arrearsDaysByCompany ||= {};
  return state.ownershipWatch;
}

export function daySerialOf(state, content) {
  return (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
}

// 建筑的材料价值（内部单位）：建造 + 历次升级的材料量按当前批发价折算。估值为 0 时（新建筑没有利润记录）用作兜底。
export function buildingMaterialValueUnits(state, building, content) {
  const definition = content.buildings[building.typeId];
  if (!definition) return 0;
  const level = Math.max(1, building.level || 1);
  const rows = [...(definition.materialRequirements || [])];
  for (let step = 2; step <= level; step += 1) rows.push(...(definition.upgrade?.materialRequirements || []));
  let voucherPerScale = 0;
  for (const row of rows) {
    const price = Math.max(0, Number(currentUnitPrice(state, row.itemId, content)) || 0);
    voucherPerScale += Math.max(0, Number(row.quantity) || 0) * price;
  }
  return Math.round(voucherPerScale * currencyScale(content));
}
