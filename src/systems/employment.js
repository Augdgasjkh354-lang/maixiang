import { dismissibleCount, dismissWorkers, minTenureDays } from "./employment-contracts.js";
import { populationStats, selectJobRows, jobKeyForBuilding, readJobCount, privateJobKeyForBuilding } from "../selectors/labor.js";
import { setJobCount, releaseExcessHouseholdEmployment, jobCount } from "./households.js";
import { reclaimedAcres } from "./agriculture.js";
import { poachWorkers } from "./labor-market.js";

function farmerCapacity(state, content) {
  return Math.max(0, Math.floor(reclaimedAcres(state, content) / content.agriculture.acresPerFarmer));
}

export function agricultureEmploymentTarget(state, content) {
  state.employment ||= { wageRates: {} };
  state.employment.targets ||= {};
  const capacity = farmerCapacity(state, content);
  const fallback = Math.min(capacity, jobCount(state, content.agriculture.farmerRoleId));
  const current = Number.isFinite(state.employment.targets.farmers) ? Math.floor(state.employment.targets.farmers) : fallback;
  state.employment.targets.farmers = Math.max(0, Math.min(capacity, current));
  return state.employment.targets.farmers;
}

export function refillAgricultureToTarget(state, content) {
  const roleId = content.agriculture.farmerRoleId;
  const target = agricultureEmploymentTarget(state, content);
  const before = jobCount(state, roleId);
  if (before >= target) return { ok: true, target, before, after: before, filled: 0, shortage: 0 };
  const result = setJobCount(state, roleId, target, content, { type: "town", id: "fields" });
  const after = jobCount(state, roleId);
  return { ok: true, target, before, after, filled: Math.max(0, after - before), shortage: Math.max(0, target - after), reason: result.reason };
}

export function assignWorkers(state, jobKey, requested, content) {
  const snapshot = selectJobRows(state, content);
  const row = snapshot.rows.find(item => item.key === jobKey);
  if (!row) return { ok: false, reason: "这个岗位目前无法安排" };
  if (row.scope === "private") return { ok: false, reason: "民营岗位由经营计划自动安排" };
  if (row.scope === "listed") return { ok: false, reason: "上市企业岗位由企业经营计划安排" };
  if (row.scope === "shop") return { ok: false, reason: "商人与店员请在商业街店铺中安排" };
  let capacity = row.capacity;
  if (row.roleId === content.agriculture.farmerRoleId && row.key === content.agriculture.farmerRoleId) {
    const target = Math.max(0, Math.min(capacity, Math.floor(Number(requested) || 0)));
    state.employment.targets ||= {};
    state.employment.targets.farmers = target;
    if (row.count > target) setJobCount(state, row.key, target, content, { type: "town", id: "fields" });
    else refillAgricultureToTarget(state, content);
    const actual = jobCount(state, row.key);
    return { ok: true, changed: target !== (row.targetCount ?? row.count), assigned: actual, target, shortage: Math.max(0, target - actual), limit: capacity };
  }
  if (row.globalDemandKind === "public_service") {
    const otherSameRole = snapshot.rows.filter(item => item.roleId === row.roleId && item.key !== row.key).reduce((sum, item) => sum + item.count, 0);
    capacity = Math.min(capacity, Math.max(0, row.globalDemand - otherSameRole));
  }
  // 用户 0.1.11：镇营建筑岗位待业不够时，按岗位日薪从低薪岗位挖人（O8 尾部 y$ 调用，不限行情）。
  const idle = Math.max(0, populationStats(state).workers - snapshot.employed);
  const poachable = row.scope === "building" ? (row.poachable || 0) : 0;
  const limit = Math.max(0, Math.min(capacity, row.count + idle + poachable));
  const value = Math.floor(Math.max(0, Math.min(limit, Number(requested) || 0)));
  const changed = value !== row.count;
  const shortage = value - row.count - idle;
  if (shortage > 0 && row.scope === "building") {
    poachWorkers(state, row.effectiveWagePerWorkerDay || 0, shortage, content, {
      toKey: jobKey,
      toLabel: `${row.buildingName || ""}${row.name || ""}`,
      allowFarmers: false
    });
  }
  // 正式员工：镇营减人是辞退——只能辞退入职满 30 天的人，镇库付一个月工资作补偿（systems/employment-contracts.js）。
  if (value < row.count && row.key !== "builders") {
    const wanted = row.count - value;
    const allowed = Math.min(wanted, dismissibleCount(state, jobKey, content));
    if (allowed <= 0) return { ok: false, changed: false, assigned: row.count, limit, reason: `入职不满${minTenureDays(content)}天的员工不能辞退` };
    const payroll = ensurePayrollBooks(state);
    const book = { claimsVoucherUnits: payroll.creditorClaims[jobKey] ||= {}, claimsPayment: payroll.creditorPaymentClaims[jobKey] ||= {}, pendingByMonth: (payroll.creditorPending ||= {})[jobKey] ||= {} };
    const result = dismissWorkers(state, jobKey, allowed, { payer: "town", dailyWage: row.effectiveWagePerWorkerDay || 0, book, reason: `${row.buildingName || ""}${row.name || ""}辞退补偿` }, content);
    const assigned = jobCount(state, jobKey);
    return { ok: true, changed: result.dismissed > 0, assigned, limit, dismissed: result.dismissed, severanceVoucherUnits: result.severanceVoucherUnits,
      reason: allowed < wanted ? `只辞退了${allowed}人：其余入职不满${minTenureDays(content)}天` : null };
  }
  const result = setJobCount(state, jobKey, value, content, { type: "town", id: row.buildingId || row.roleId });
  return { ok: result.ok, changed, assigned: result.assigned, limit, reason: result.reason };
}

function ensurePayrollBooks(state) {
  state.payroll ||= {};
  state.payroll.creditorClaims ||= {};
  state.payroll.creditorPaymentClaims ||= {};
  return state.payroll;
}

export function initializeBuildingJobs() {
  // v11 has no per-building employment counters to initialize. Household job allocations are authoritative.
}

export function reconcileEmployment(state, content) {
  const adjustments = [];
  releaseExcessHouseholdEmployment(state);
  let rows = selectJobRows(state, content).rows;
  for (const row of rows) {
    if (row.scope === "shop") continue;
    if (row.count > row.capacity) {
      const before = row.count;
      setJobCount(state, row.key, row.capacity, content);
      adjustments.push({ key: row.key, roleId: row.roleId, buildingId: row.buildingId || null, name: row.name,
        buildingName: row.buildingName || null, before, after: row.capacity, reason: "岗位容量变化" });
    }
  }
  rows = selectJobRows(state, content).rows;
  for (const roleId of ["civil_servants", "police"]) {
    const roleRows = rows.filter(row => row.roleId === roleId && row.globalDemandKind === "public_service");
    if (!roleRows.length) continue;
    const demand = roleRows[0].globalDemand || 0;
    let excessRole = roleRows.reduce((sum, row) => sum + row.count, 0) - demand;
    if (excessRole <= 0) continue;
    for (const row of roleRows.slice().reverse()) {
      if (excessRole <= 0) break;
      const before = readJobCount(state, row.key);
      const cut = Math.min(before, excessRole);
      if (cut <= 0) continue;
      const after = before - cut;
      setJobCount(state, row.key, after, content);
      adjustments.push({ key: row.key, roleId: row.roleId, buildingId: row.buildingId || null, name: row.name,
        buildingName: row.buildingName || null, before, after, reason: "全镇公共岗位需求变化" });
      excessRole -= cut;
    }
  }
  const refill = refillAgricultureToTarget(state, content);
  if (refill.filled > 0 || refill.shortage > 0) adjustments.push({ key: content.agriculture.farmerRoleId, roleId: content.agriculture.farmerRoleId, buildingId: null, name: "农人", buildingName: null, before: refill.before, after: refill.after, target: refill.target, shortage: refill.shortage, reason: refill.shortage > 0 ? "农业目标缺员" : "农业目标自动补员" });
  return adjustments;
}

export function setPrivateWorkers(state, buildingId, roleId, count, content = null) {
  const value = Math.max(0, Math.floor(count));
  return setJobCount(state, privateJobKeyForBuilding(buildingId, roleId), value, content, { type: "private", id: buildingId });
}

export function employmentSnapshot(state, content) {
  const result = selectJobRows(state, content);
  return { employed: result.employed, idle: result.idle, workingAge: result.workingAge, rows: result.rows };
}

export { jobKeyForBuilding };
