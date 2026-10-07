import { changeInventory, quantityToUnits } from "../economy/inventory.js";
import { bookAddAll, ensureBook } from "../economy/books.js";
import { recordEvent, recordLedger } from "../economy/ledger.js";
import { jobAssignments, jobCount, distributeResidentInventory, householdList, householdIdleWorkers, householdEmploymentCount } from "./households.js";
import { addTownCostBasis } from "../economy/business.js";
import { recordHouseholdInKind, recordHouseholdWageDue } from "./household-life.js";
import { emptyReclaimState, emptyReclaimPeriod } from "../core/state.js";
import { currencyScale } from "../economy/currency.js";
import { currentPaymentComposition, settleMonetaryPayment } from "../economy/payment.js";
import { makeTransactionId } from "../economy/ledger.js";

// ── 耕地开荒 ────────────────────────────────────────────────────────────────
// 亩数是权威数据：state.agriculture.reclaimedAcres 记录已开荒亩数，
// 供农人容量、收成上限与面板显示统一读取；content.agriculture.acres 只作为新档初始值。

export function ensureAgricultureState(state, content) {
  state.agriculture ||= {};
  const maximum = reclaimedAcresMaximum(content);
  if (!Number.isFinite(state.agriculture.reclaimedAcres)) {
    state.agriculture.reclaimedAcres = Math.max(0, Math.min(maximum, content.agriculture.acres));
  }
  state.agriculture.reclaimedAcres = Math.max(0, Math.min(maximum, Math.floor(state.agriculture.reclaimedAcres)));
  state.agriculture.reclaim ||= emptyReclaimState();
  ensureBook(state.agriculture.reclaim, emptyReclaimPeriod);
  return state.agriculture;
}

export function reclaimedAcresMaximum(content) {
  const configured = content.agriculture.acresMaximum;
  return Number.isFinite(configured) && configured > 0 ? configured : content.agriculture.acres;
}

export function reclaimedAcres(state, content) {
  return ensureAgricultureState(state, content).reclaimedAcres;
}

export function reclaimWorkDaysPerAcre(content) {
  const batch = content.agriculture.reclaimAcresPerBatch || 100;
  const days = content.agriculture.reclaimWorkDaysPerBatch || 100;
  return days / batch;
}

// 每 100 亩 100 工日，等价于 1 亩 1 工日；亩数取整后按现有比例函数换算，避免硬编码。
export function reclaimWorkDaysForAcres(acres, content) {
  const value = Math.max(0, Math.floor(Number(acres) || 0));
  return Math.round(value * reclaimWorkDaysPerAcre(content));
}

export function reclaimCostEstimate(state, content, acres) {
  ensureAgricultureState(state, content);
  const maximum = reclaimedAcresMaximum(content);
  const current = state.agriculture.reclaimedAcres;
  const requested = Math.max(0, Math.floor(Number(acres) || 0));
  const allowed = Math.min(requested, Math.max(0, maximum - current));
  const workDays = reclaimWorkDaysForAcres(allowed, content);
  const wageRoleId = content.agriculture.reclaimWageRoleId || "builders";
  const wagePerWorkerDay = state.employment?.wageRates?.[wageRoleId] ?? 0;
  return { requested, allowed, clamped: allowed < requested, maximum, current,
    remaining: Math.max(0, maximum - current), workDays, wageRoleId, wagePerWorkerDay,
    estimatedVoucher: workDays * wagePerWorkerDay };
}

// 开荒：设定本次亩数与投入人数。工资由镇库承担，按人日发到投入开荒的家庭，并逐户记账。
export function reclaimFarmland(state, content, options = {}) {
  const agriculture = ensureAgricultureState(state, content);
  const estimate = reclaimCostEstimate(state, content, options.acres);
  if (estimate.requested <= 0) return { ok: false, reason: "开荒亩数须为正整数" };
  if (estimate.allowed <= 0) return { ok: false, reason: "已开荒耕地达到上限 " + estimate.maximum + " 亩" };
  // 工资率为0时拒绝开荒，避免免费送地（之前不校验直接加亩数）。
  if (!(estimate.wagePerWorkerDay > 0)) return { ok: false, reason: "开荒工资率未设定，无法开工" };
  const requestedWorkers = Math.max(0, Math.floor(Number(options.workers) || 0));
  if (requestedWorkers <= 0) return { ok: false, reason: "投入开荒人数须为正整数" };
  const workDays = estimate.workDays;
  const wageRoleId = estimate.wageRoleId;
  const wagePerWorkerDay = estimate.wagePerWorkerDay;
  // 工日 ÷ 每工日人数 = 需要的天数；不足一天的按一天结算，人数不得超过工日总量。
  const workers = Math.min(requestedWorkers, Math.max(1, workDays));
  const days = Math.max(1, Math.ceil(workDays / workers));
  const scale = currencyScale(content);
  const dueVoucherUnits = Math.round(workDays * wagePerWorkerDay * scale);
  const transactionId = makeTransactionId(state);
  const wageRows = reclaimWageAllocation(state, workers);
  let paidVoucherUnits = 0;
  if (dueVoucherUnits > 0 && wageRows.length > 0) {
    paidVoucherUnits = payReclaimWages(state, wageRows, workers, workDays, dueVoucherUnits, content, transactionId);
  }
  const unpaidVoucherUnits = Math.max(0, dueVoucherUnits - paidVoucherUnits);
  recordLedger(state, {
    type: "reclaim_wage_expense", transactionId,
    source: "town", destination: "wage_expense", itemId: "grain_voucher",
    quantityUnits: paidVoucherUnits, qeqUnits: 0,
    reason: "开荒 " + estimate.allowed + " 亩，投入 " + workers + " 人合 " + workDays + " 工日；镇库实付工资"
  }, content);
  if (unpaidVoucherUnits > 0) {
    recordLedger(state, {
      type: "reclaim_wage_shortfall", transactionId,
      source: "town", destination: "unpaid", itemId: "grain_voucher",
      quantityUnits: unpaidVoucherUnits, qeqUnits: 0,
      reason: "镇库可支付资产不足，开荒工资未能足额支付"
    }, content);
  }
  agriculture.reclaimedAcres = Math.min(estimate.maximum, agriculture.reclaimedAcres + estimate.allowed);
  const period = { acres: estimate.allowed, workDays, paidVoucherUnits };
  bookAddAll(agriculture.reclaim, period);
  agriculture.reclaim.last = {
    year: state.year, day: state.day + 1, ...period, workers, days, requested: estimate.requested,
    clamped: estimate.clamped, wagePerWorkerDay, maximum: estimate.maximum,
    reclaimedAcres: agriculture.reclaimedAcres, unpaidVoucherUnits,
    paidVoucher: paidVoucherUnits / scale, dueVoucher: dueVoucherUnits / scale
  };
  agriculture.reclaim.history.push({ year: state.year, day: state.day + 1, ...period, workers, days });
  if (agriculture.reclaim.history.length > 40) agriculture.reclaim.history = agriculture.reclaim.history.slice(-40);
  recordEvent(state, "开荒 " + estimate.allowed + " 亩（投入 " + workers + " 人、" + workDays +
    " 工日），镇库支付开荒工资 " + Math.round(paidVoucherUnits / scale).toLocaleString("zh-CN") +
    "粮券；已开荒 " + agriculture.reclaimedAcres + " / " + estimate.maximum + "亩。", content);
  return {
    ok: true, transactionId, acres: estimate.allowed, requested: estimate.requested, clamped: estimate.clamped,
    workDays, workers, days, wagePerWorkerDay, dueVoucherUnits, paidVoucherUnits, unpaidVoucherUnits,
    dueVoucher: dueVoucherUnits / scale, paidVoucher: paidVoucherUnits / scale,
    wageRows, reclaimedAcres: agriculture.reclaimedAcres, maximum: estimate.maximum
  };
}

// 开荒工人从全镇待业劳动力中按确定性顺序抽取；岗位不常设，只在本次开荒内结算工资。
function reclaimWageAllocation(state, workers) {
  const households = householdList(state)
    .filter(household => householdIdleWorkers(household) > 0)
    .sort((a, b) => householdEmploymentCount(a) - householdEmploymentCount(b) || a.id.localeCompare(b.id));
  const rows = [];
  let left = Math.max(0, workers);
  for (const household of households) {
    if (left <= 0) break;
    const count = Math.min(left, householdIdleWorkers(household));
    if (count <= 0) continue;
    rows.push({ householdId: household.id, count });
    left -= count;
  }
  return rows;
}

function payReclaimWages(state, wageRows, workers, workDays, dueVoucherUnits, content, transactionId) {
  const totalWorkers = Math.max(1, workers);
  let paidVoucherUnits = 0;
  for (const row of wageRows) {
    const due = Math.min(dueVoucherUnits - paidVoucherUnits,
      Math.round(dueVoucherUnits * row.count / totalWorkers));
    if (due <= 0) continue;
    const result = settleMonetaryPayment(state, "town", "household:" + row.householdId,
      currentPaymentComposition(state, due), content,
      "land_reclamation_wage", "开荒工资：镇库承担，按投入人日结算",
      { requireFull: false, transactionId });
    const paid = result.paidValueUnits || 0;
    paidVoucherUnits += paid;
    recordLedger(state, {
      type: "reclaim_wage", transactionId,
      source: "town", destination: "household:" + row.householdId, itemId: "grain_voucher",
      quantityUnits: paid, qeqUnits: 0,
      reason: "开荒工资：投入 " + row.count + " 人·" + workDays + "工日；镇库支付"
    }, content);
    if (paid > 0) recordHouseholdWageDue(state, row.householdId, paid, content);
  }
  return paidVoucherUnits;
}

export function accumulateFarmDay(state, content) {
  if (state.day >= content.rules.growingDays) return;
  const farmerRoleId = content.agriculture.farmerRoleId;
  const count = jobCount(state, farmerRoleId);
  state.agriculture.workUnits += count;
  for (const row of jobAssignments(state, farmerRoleId)) {
    const household = state.households?.byId?.[row.householdId];
    if (household) household.agricultureWorkUnits = (household.agricultureWorkUnits || 0) + row.count;
  }
  const rateBps = Math.round((state.policy?.agricultureTaxPercent ?? content.rules.agricultureTaxDefaultPercent ?? 50) * 100);
  state.agriculture.taxDays ||= [];
  state.agriculture.taxDays.push({ year: state.year, day: state.day + 1, rateBps });
}

export function harvest(state, content) {
  if (state.agriculture.lastHarvestYear === state.year) {
    return { skipped: true, reason: "本年已经收过麦" };
  }
  const acres = reclaimedAcres(state, content);
  // 与雇佣上限口径一致：取整，避免满员也达不到100%产量。
  const capacity = Math.floor(acres / content.agriculture.acresPerFarmer);
  const maximum = acres * content.agriculture.yieldPerAcre;
  const workCapacity = capacity * content.rules.growingDays;
  const proportion = Math.max(0, Math.min(1, state.agriculture.workUnits / workCapacity));
  const totalUnits = quantityToUnits(maximum * proportion, content);
  const taxDays = (state.agriculture.taxDays || []).filter(row => row.year === state.year);
  const averageRateBps = taxDays.length
    ? Math.round(taxDays.reduce((sum, row) => sum + row.rateBps, 0) / taxDays.length)
    : Math.round((content.rules.agricultureTaxDefaultPercent ?? 50) * 100);
  const townUnits = Math.floor(totalUnits * averageRateBps / 10000);
  const residentUnits = totalUnits - townUnits;
  const cropItemId = content.agriculture.cropItemId;
  const txId = "harvest-y" + state.year;
  if (residentUnits > 0) {
    const weights = Object.fromEntries(householdList(state).map(h => [h.id, h.agricultureWorkUnits || 0]));
    const distributed = distributeResidentInventory(state, cropItemId, residentUnits, content, { weights, byMembers: false });
    // 极端情况（所有农户家庭无人口）不抛异常，改按全镇人口分配，避免整日结算崩溃。
    if (!distributed.ok) {
      const fallback = distributeResidentInventory(state, cropItemId, residentUnits, content, { byMembers: true });
      if (!fallback.ok) {
        recordEvent(state, `收获分粮失败（${distributed.reason}），${Math.round(residentUnits / content.precision.inventoryUnitsPerJin)}斤暂存镇库。`, content);
        state.accounts.town[cropItemId] = (state.accounts.town[cropItemId] || 0) + residentUnits;
      } else {
        for (const row of fallback.rows || []) {
          const qeq = row.units * content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin;
          recordHouseholdInKind(state, row.householdId, "inKindIncomeQeqUnits", qeq, content);
        }
      }
    } else {
      for (const row of distributed.rows || []) {
        const qeq = row.units * content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin;
        recordHouseholdInKind(state, row.householdId, "inKindIncomeQeqUnits", qeq, content);
      }
    }
    recordLedger(state, { type: "harvest", transactionId: txId, source: "field", destination: "residents",
      itemId: cropItemId, quantityUnits: residentUnits,
      qeqUnits: residentUnits * content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin,
      reason: "麦收：按农民实际劳动贡献分到家庭" }, content, { day: state.day });
  }
  if (townUnits > 0) {
    changeInventory(
      state, "town", cropItemId, townUnits, "麦收：入镇库的农业税粮",
      "harvest", content, txId, { day: state.day }
    );
    addTownCostBasis(state, cropItemId, townUnits);
  }
  state.yearTotals.harvestQeq += totalUnits *
    content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin;
  state.agriculture.lastHarvestYear = state.year;
  state.agriculture.taxHistory ||= [];
  state.agriculture.taxHistory.push({ year: state.year, farmDays: taxDays.length, averageRateBps,
    totalUnits, townUnits, residentUnits });
  state.agriculture.taxDays = (state.agriculture.taxDays || []).filter(row => row.year !== state.year);
  state.agriculture.workUnits = 0;
  for (const household of householdList(state)) household.agricultureWorkUnits = 0;
  const total = totalUnits / content.precision.inventoryUnitsPerJin;
  const resident = residentUnits / content.precision.inventoryUnitsPerJin;
  const town = townUnits / content.precision.inventoryUnitsPerJin;
  recordEvent(
    state,
    "麦收入仓 " + Math.round(total).toLocaleString("zh-CN") +
      "斤：居民留得 " + Math.round(resident).toLocaleString("zh-CN") +
      "斤，镇库收税粮 " + Math.round(town).toLocaleString("zh-CN") + "斤。",
    content
  );
  return { total, residentShare: resident, townShare: town, proportion, averageTaxPercent: averageRateBps / 100 };
}
