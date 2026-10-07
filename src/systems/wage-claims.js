import { allocateIntegerByWeight } from "../core/allocation.js";
import { addPaymentObligation, currentPaymentComposition, normalizePaymentObligation, settleMonetaryPayment } from "../economy/payment.js";
import { recordHouseholdWageDue } from "./household-life.js";

export function ensureClaimMap(owner) { owner.claimsVoucherUnits ||= {}; return owner.claimsVoucherUnits; }
export function ensurePaymentClaimMap(owner) { owner.claimsPayment ||= {}; return owner.claimsPayment; }

export function accrueWageClaims(state, owner, assignments, dueUnits, content) {
  const claims = ensureClaimMap(owner);
  const paymentClaims = ensurePaymentClaimMap(owner);
  if (dueUnits <= 0 || !assignments?.length) return [];
  const weights = {};
  for (const row of assignments) if (row?.householdId && row.count > 0) weights[row.householdId] = (weights[row.householdId] || 0) + row.count;
  const households = Object.keys(weights).map(id => state.households?.byId?.[id]).filter(Boolean);
  const allocation = allocateIntegerByWeight(dueUnits, households, household => weights[household.id] || 0);
  if (!allocation.ok) return [];
  const rows = [];
  for (const { recipient: household, units } of allocation.rows) {
    if (units <= 0) continue;
    claims[household.id] = (claims[household.id] || 0) + units;
    paymentClaims[household.id] = addPaymentObligation(paymentClaims[household.id], currentPaymentComposition(state, units));
    recordHouseholdWageDue(state, household.id, units, content);
    rows.push({ householdId: household.id, units });
  }
  return rows;
}

export function attributeLegacyUnattributedWageClaims(state, owner, legacyUnits, assignments = []) {
  const total = Math.max(0, Math.round(Number(legacyUnits) || 0));
  if (total <= 0) return { attributed: 0, rows: [] };
  const byId = state.households?.byId || {};
  const weights = {};
  for (const row of assignments || []) {
    if (!row?.householdId || !byId[row.householdId] || row.count <= 0) continue;
    weights[row.householdId] = (weights[row.householdId] || 0) + row.count;
  }
  let households = Object.keys(weights).map(id => byId[id]).filter(Boolean);
  if (!households.length) {
    households = Object.values(byId).filter(household => {
      const bands = household?.ageBands || {};
      return Math.max(0, (bands.children || 0) + (bands.workers || 0) + (bands.elders || 0)) > 0;
    });
    for (const household of households) {
      const bands = household.ageBands || {};
      weights[household.id] = Math.max(1, (bands.children || 0) + (bands.workers || 0) + (bands.elders || 0));
    }
  }
  if (!households.length) return { attributed: 0, rows: [] };
  const allocation = allocateIntegerByWeight(total, households, household => weights[household.id] || 0);
  if (!allocation.ok) return { attributed: 0, rows: [] };
  const claims = ensureClaimMap(owner);
  const paymentClaims = ensurePaymentClaimMap(owner);
  const rows = [];
  for (const { recipient: household, units } of allocation.rows) {
    if (units <= 0) continue;
    claims[household.id] = (claims[household.id] || 0) + units;
    // 旧版只有总额、没有债权人和支付媒介明细；当时该字段以粮券价值记账。
    paymentClaims[household.id] = addPaymentObligation(paymentClaims[household.id], {
      valueUnits: units, wheatValueUnits: 0, voucherValueUnits: units
    });
    rows.push({ householdId: household.id, units });
  }
  return { attributed: rows.reduce((sum, row) => sum + row.units, 0), rows };
}

export function claimTotal(owner) { return Object.values(ensureClaimMap(owner)).reduce((sum, value) => sum + (value || 0), 0); }

export function payWageClaims(state, owner, availableUnits, payHousehold) {
  const claims = ensureClaimMap(owner);
  let available = Math.max(0, availableUnits || 0);
  let paid = 0;
  const rows = [];
  for (const householdId of Object.keys(claims).sort()) {
    if (available <= 0) break;
    const due = claims[householdId] || 0;
    if (due <= 0) continue;
    const amount = Math.min(due, available);
    const actual = payHousehold(householdId, amount) || 0;
    if (actual <= 0) continue;
    claims[householdId] = Math.max(0, due - actual);
    available -= actual;
    paid += actual;
    rows.push({ householdId, units: actual });
  }
  return { paid, rows, remaining: claimTotal(owner) };
}

export function payMonetaryWageClaims(state, owner, payer, content, type, reason, options = {}) {
  const claims = ensureClaimMap(owner);
  const paymentClaims = ensurePaymentClaimMap(owner);
  let paid = 0;
  const rows = [];
  for (const householdId of Object.keys(claims).sort()) {
    const due = claims[householdId] || 0;
    if (due <= 0) continue;
    const obligation = normalizePaymentObligation(paymentClaims[householdId] || due, state);
    const result = settleMonetaryPayment(state, payer, `household:${householdId}`, obligation, content, type, reason,
      { requireFull: false });
    const actual = result.paidValueUnits || 0;
    claims[householdId] = Math.max(0, due - actual);
    paymentClaims[householdId] = result.remainingComposition;
    if (actual > 0) rows.push({ householdId, units: actual, payment: result });
    paid += actual;
  }
  return { paid, rows, remaining: claimTotal(owner) };
}

export function payMonetaryWageClaimsFromPayers(state, owner, payers, content, type, reason, options = {}) {
  const claims = ensureClaimMap(owner);
  const paymentClaims = ensurePaymentClaimMap(owner);
  let paid = 0;
  const rows = [];
  for (const householdId of Object.keys(claims).sort()) {
    const original = claims[householdId] || 0;
    if (original <= 0) continue;
    let obligation = normalizePaymentObligation(paymentClaims[householdId] || original, state);
    let householdPaid = 0;
    for (const payer of payers) {
      if (obligation.valueUnits <= 0) break;
      const payerId = typeof payer === "string" ? payer : payer.id;
      const maxWheatUnits = typeof payer === "string" ? undefined : payer.maxWheatUnits;
      const result = settleMonetaryPayment(state, payerId, `household:${householdId}`, obligation, content, type, reason,
        { requireFull: false, maxWheatUnits });
      householdPaid += result.paidValueUnits || 0;
      obligation = result.remainingComposition;
    }
    claims[householdId] = Math.max(0, original - householdPaid);
    paymentClaims[householdId] = obligation;
    if (householdPaid > 0) rows.push({ householdId, units: householdPaid });
    paid += householdPaid;
  }
  return { paid, rows, remaining: claimTotal(owner) };
}
