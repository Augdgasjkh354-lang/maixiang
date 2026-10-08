// 统一雇主：镇库、民营、公司、店铺发工资都用同一套"工资债权簿"。
//
//   book.claimsVoucherUnits[householdId]  欠这户的工资（价值单位）
//   book.claimsPayment[householdId]       同一笔债的支付构成（小麦/粮券），按原构成偿付
//
// 每天：accrueWages 按岗位分配记账 → payWages 由一个或多个付款方按户偿付；欠薪 = wageArrears(book)。

import { allocateIntegerByWeight } from "../core/allocation.js";
import { addPaymentObligation, currentPaymentComposition, normalizePaymentObligation, settleMonetaryPayment } from "../economy/payment.js";
import { recordHouseholdWageDue } from "./household-life.js";
import { jobAssignments, syncResidentAggregates } from "./households.js";

export function wageBook(holder) {
  holder.claimsVoucherUnits ||= {};
  holder.claimsPayment ||= {};
  return holder;
}

export function wageArrears(book) {
  return Object.values(book?.claimsVoucherUnits || {}).reduce((sum, value) => sum + Math.max(0, value || 0), 0);
}

// 把 dueUnits 按各户在岗人数分到家庭债权上。返回 [{ householdId, units }]。
export function accrueWages(state, book, assignments, dueUnits, content) {
  wageBook(book);
  if (dueUnits <= 0 || !assignments?.length) return [];
  const weights = {};
  for (const row of assignments) if (row?.householdId && row.count > 0) weights[row.householdId] = (weights[row.householdId] || 0) + row.count;
  const households = Object.keys(weights).map(id => state.households?.byId?.[id]).filter(Boolean);
  const allocation = allocateIntegerByWeight(dueUnits, households, household => weights[household.id] || 0);
  if (!allocation.ok) return [];
  const rows = [];
  for (const { recipient: household, units } of allocation.rows) {
    if (units <= 0) continue;
    book.claimsVoucherUnits[household.id] = (book.claimsVoucherUnits[household.id] || 0) + units;
    book.claimsPayment[household.id] = addPaymentObligation(book.claimsPayment[household.id], currentPaymentComposition(state, units));
    recordHouseholdWageDue(state, household.id, units, content);
    rows.push({ householdId: household.id, units });
  }
  return rows;
}

// 按户偿付工资债权。payers：付款方账户名，或 { id, maxWheatUnits }（家庭业主要留口粮），按顺序轮流付。
// 返回 { paid, rows: [{ householdId, units }] }。
export function payWages(state, book, payers, content, type, reason) {
  wageBook(book);
  const list = (Array.isArray(payers) ? payers : [payers]).map(payer => typeof payer === "string" ? { id: payer } : payer);
  const previousDefer = Boolean(state._deferHouseholdSync);
  state._deferHouseholdSync = true;
  let paid = 0;
  const rows = [];
  for (const householdId of Object.keys(book.claimsVoucherUnits).sort()) {
    const due = book.claimsVoucherUnits[householdId] || 0;
    if (due <= 0) continue;
    let obligation = normalizePaymentObligation(book.claimsPayment[householdId] || due, state);
    let householdPaid = 0;
    for (const payer of list) {
      if (obligation.valueUnits <= 0) break;
      const result = settleMonetaryPayment(state, payer.id, `household:${householdId}`, obligation, content, type, reason,
        { requireFull: false, maxWheatUnits: payer.maxWheatUnits });
      householdPaid += result.paidValueUnits || 0;
      obligation = result.remainingComposition;
    }
    book.claimsVoucherUnits[householdId] = Math.max(0, due - householdPaid);
    book.claimsPayment[householdId] = obligation;
    if (householdPaid > 0) rows.push({ householdId, units: householdPaid });
    paid += householdPaid;
  }
  state._deferHouseholdSync = previousDefer;
  if (!previousDefer && state._householdSyncDirty) syncResidentAggregates(state, content);
  return { paid, rows };
}

// 实物抵欠薪（民营收回、公司清算）：按户先到先抵，从债权上扣减 valueUnits，返回实际抵掉的价值。
export function offsetWageClaims(state, book, valueUnits, content) {
  wageBook(book);
  const start = Math.max(0, Math.floor(valueUnits || 0));
  let left = start;
  for (const householdId of Object.keys(book.claimsVoucherUnits).sort()) {
    if (left <= 0) break;
    const due = book.claimsVoucherUnits[householdId] || 0;
    const cut = Math.min(Math.max(0, due), left);
    const next = due - cut;
    left -= cut;
    if (next > 0) {
      book.claimsVoucherUnits[householdId] = next;
      book.claimsPayment[householdId] = currentPaymentComposition(state, next);
    } else {
      delete book.claimsVoucherUnits[householdId];
      delete book.claimsPayment[householdId];
    }
  }
  return start - left;
}

// 把剩余债权整体转给镇营：记入镇库的历史债权表（按岗位键），之后由镇库经既有工资流程偿付。
export function transferWageClaimsToTown(state, book, payrollKey) {
  wageBook(book);
  const payroll = state.payroll ||= { arrearsVoucherUnits: {}, totals: {}, year: {} };
  payroll.creditorClaims ||= {};
  payroll.creditorPaymentClaims ||= {};
  payroll.arrearsVoucherUnits ||= {};
  const claims = payroll.creditorClaims[payrollKey] ||= {};
  const claimPayments = payroll.creditorPaymentClaims[payrollKey] ||= {};
  let total = 0;
  for (const [householdId, due] of Object.entries(book.claimsVoucherUnits)) {
    if (!(due > 0)) continue;
    claims[householdId] = (claims[householdId] || 0) + due;
    claimPayments[householdId] = addPaymentObligation(claimPayments[householdId], book.claimsPayment[householdId] || currentPaymentComposition(state, due));
    total += due;
  }
  book.claimsVoucherUnits = {};
  book.claimsPayment = {};
  if (total > 0) payroll.arrearsVoucherUnits[payrollKey] = (payroll.arrearsVoucherUnits[payrollKey] || 0) + total;
  return total;
}

// ---------------------------------------------------------------- 生产共用

// 行业生产税（实物）：按税率从产出里扣，零头记在 carry[carryKey] 里下次累计。
export function productionTaxUnits(state, typeId, carry, carryKey, outputUnits, content) {
  const rate = state.policy?.privateProductionTaxPercent?.[typeId] ?? content.rules.privateProductionTaxDefaultPercent ?? 10;
  const numerator = outputUnits * Math.round(rate * 100) + (carry[carryKey] || 0);
  return { taxUnits: Math.floor(numerator / 10000), carryAfter: numerator % 10000 };
}

// 招工：在不超过闲置劳力的前提下把岗位调到 desired。setCount(n) 实际设置人数，readCount() 读回。
// 返回新的闲置劳力数。
export function hireToward(desired, idle, readCount, setCount) {
  const current = readCount();
  setCount(Math.min(desired, current + idle));
  return idle - (readCount() - current);
}
