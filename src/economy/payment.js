import { issueVouchersFromWheat, transferVouchers, voucherBalance } from "./currency.js";
import { addTownCostBasis, applyTownCostRemoval, quoteTownCostRemoval } from "./business.js";
import { makeTransactionId, recordLedger } from "./ledger.js";
import { voucherUnitsForWheatUnits, wheatUnitsForVoucherUnits } from "./money-units.js";
import { distributeResidentInventory, takeResidentInventory, syncResidentAggregates, householdConvertibleWheatUnits, householdExchangeAllowanceUnits, householdList } from "../systems/households.js";
import { recordHouseholdVoucherTransfer } from "../systems/household-life.js";

export const MONETARY_STAGE_WHEAT = "wheat";
export const MONETARY_STAGE_TRANSITION = "transition";
export const MONETARY_STAGE_VOUCHER = "voucher";

export function ensureMonetaryReform(state) {
  state.monetaryReform ||= {
    stage: MONETARY_STAGE_WHEAT,
    targetVoucherBps: 0,
    residentExchangeEnabled: false,
    legacyBankAccess: false,
    started: null,
    completed: null,
    paymentHistory: [],
    voucherShortfallByKey: {}
  };
  const reform = state.monetaryReform;
  if (![MONETARY_STAGE_WHEAT, MONETARY_STAGE_TRANSITION, MONETARY_STAGE_VOUCHER].includes(reform.stage)) reform.stage = MONETARY_STAGE_WHEAT;
  reform.targetVoucherBps = Math.max(0, Math.min(10000, Math.round(Number(reform.targetVoucherBps) || 0)));
  reform.residentExchangeEnabled = Boolean(reform.residentExchangeEnabled);
  reform.legacyBankAccess = Boolean(reform.legacyBankAccess);
  if (!Array.isArray(reform.paymentHistory)) reform.paymentHistory = [];
  reform.voucherShortfallByKey ||= {};
  return reform;
}

export function hasCompletedBank(state) {
  return (state.buildings || []).some(row => row.typeId === "bank");
}

export function hasBankAccess(state) {
  const reform = ensureMonetaryReform(state);
  return hasCompletedBank(state) || reform.legacyBankAccess;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function exactExchangeForVoucherNeed(voucherNeedUnits, maxWheatUnits, content) {
  const need = Math.max(0, Math.floor(voucherNeedUnits));
  const maxWheat = Math.max(0, Math.floor(maxWheatUnits));
  if (!need || !maxWheat) return { wheatUnits: 0, voucherUnits: 0 };
  const common = gcd(content.precision.inventoryUnitsPerJin, content.precision.currencyUnitsPerVoucher);
  const wheatStep = content.precision.inventoryUnitsPerJin / common;
  const voucherStep = content.precision.currencyUnitsPerVoucher / common;
  const wantedSteps = Math.ceil(need / voucherStep);
  const availableSteps = Math.floor(maxWheat / wheatStep);
  const steps = Math.min(wantedSteps, availableSteps);
  return { wheatUnits: steps * wheatStep, voucherUnits: steps * voucherStep };
}

function autoExchangeableWheatUnits(state, owner, content, options = {}) {
  const reform = ensureMonetaryReform(state);
  if (reform.stage === MONETARY_STAGE_WHEAT) return 0;
  let units = 0;
  if (owner?.startsWith("household:")) {
    if (!reform.residentExchangeEnabled) return 0;
    const household = state.households?.byId?.[owner.slice(10)];
    if (!household) return 0;
    units = Math.min(
      householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30),
      householdExchangeAllowanceUnits(state, household.id, content)
    );
  } else if (owner === "residents") {
    if (!reform.residentExchangeEnabled) return 0;
    units = householdList(state).reduce((sum, household) => sum + Math.min(
      householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30),
      householdExchangeAllowanceUnits(state, household.id, content)
    ), 0);
  } else if (owner?.startsWith("company:") || owner?.startsWith("shop:")) {
    units = paymentWheatBalanceUnits(state, owner);
  }
  if (Number.isSafeInteger(options.maxWheatUnits)) units = Math.min(units, Math.max(0, options.maxWheatUnits));
  return Math.max(0, units);
}

function autoExchangeForPayment(state, owner, voucherNeedUnits, dueWheatValueUnits, content, options = {}) {
  if (voucherNeedUnits <= 0 || !(owner === "residents" || owner?.startsWith("household:") || owner?.startsWith("company:") || owner?.startsWith("shop:"))) return { wheatUnits: 0, voucherUnits: 0 };
  const actualWheat = paymentWheatBalanceUnits(state, owner);
  const paymentWheatLimit = Math.min(actualWheat, Number.isSafeInteger(options.maxWheatUnits) ? Math.max(0, options.maxWheatUnits) : actualWheat);
  const wheatNeededForOriginalWheat = wheatUnitsForVoucherUnits(Math.max(0, dueWheatValueUnits), content, "ceil");
  const spareForExchange = Math.max(0, paymentWheatLimit - wheatNeededForOriginalWheat);
  const exchangeable = Math.min(spareForExchange, autoExchangeableWheatUnits(state, owner, content, options));
  const townVoucherPool = Math.max(0, voucherBalance(state, "town"));
  const exact = exactExchangeForVoucherNeed(Math.min(voucherNeedUnits, townVoucherPool), exchangeable, content);
  if (exact.wheatUnits <= 0) return exact;
  const issued = issueVouchersFromWheat(state, owner, exact.wheatUnits, content, "按银行开放规则为支付自动换券");
  return issued.ok ? { wheatUnits: issued.wheatUnits, voucherUnits: issued.voucherUnits } : { wheatUnits: 0, voucherUnits: 0 };
}

export function paymentWheatBalanceUnits(state, owner) {
  if (owner === "town") return state.accounts?.town?.wheat || 0;
  if (owner === "residents") return state.accounts?.residents?.wheat || 0;
  if (owner?.startsWith("household:")) return state.households?.byId?.[owner.slice(10)]?.inventory?.wheat || 0;
  if (owner?.startsWith("company:")) return state.companies?.[owner.slice(8)]?.cashWheatUnits || 0;
  if (owner?.startsWith("shop:")) return state.shops?.[owner.slice(5)]?.cashWheatUnits || 0;
  if (owner === "social") return state.socialSecurity?.cashWheatUnits || 0;
  return 0;
}

function canCreditWheat(state, owner, wheatUnits) {
  if (!Number.isSafeInteger(wheatUnits) || wheatUnits < 0) return false;
  const current = paymentWheatBalanceUnits(state, owner);
  return Number.isSafeInteger(current + wheatUnits);
}

function setSimpleWheatBalance(state, owner, value, content) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("支付小麦余额无效");
  if (owner === "town") state.accounts.town.wheat = value;
  else if (owner?.startsWith("household:")) {
    const household = state.households?.byId?.[owner.slice(10)];
    if (!household) throw new Error("家庭不存在");
    household.inventory.wheat = value;
    syncResidentAggregates(state, content);
  } else if (owner?.startsWith("company:")) {
    const company = state.companies?.[owner.slice(8)];
    if (!company) throw new Error("企业不存在");
    company.cashWheatUnits = value;
  } else if (owner?.startsWith("shop:")) {
    const shop = state.shops?.[owner.slice(5)];
    if (!shop) throw new Error("店铺不存在");
    shop.cashWheatUnits = value;
  } else if (owner === "social") {
    state.socialSecurity ||= {};
    state.socialSecurity.cashWheatUnits = value;
  } else throw new Error("未知小麦支付账户：" + owner);
}

function transferPaymentWheat(state, from, to, wheatUnits, valueUnits, content, type, reason, transactionId) {
  if (wheatUnits <= 0) return { ok: true, wheatUnits: 0, valueUnits: 0, transactionId };
  if (paymentWheatBalanceUnits(state, from) < wheatUnits) return { ok: false, reason: "可支付小麦不足" };
  if (!canCreditWheat(state, to, wheatUnits)) return { ok: false, reason: "收款账户超过安全范围" };

  let residentDebitRows = [];
  let residentCreditRows = [];
  let townCostQuote = null;
  if (from === "residents") {
    const result = takeResidentInventory(state, "wheat", wheatUnits, content);
    if (!result.ok) return result;
    residentDebitRows = result.rows;
  } else {
    if (from === "town") {
      townCostQuote = quoteTownCostRemoval(state, "wheat", wheatUnits, content);
      applyTownCostRemoval(state, townCostQuote);
    }
    setSimpleWheatBalance(state, from, paymentWheatBalanceUnits(state, from) - wheatUnits, content);
  }

  if (to === "residents") {
    const result = distributeResidentInventory(state, "wheat", wheatUnits, content);
    if (!result.ok) {
      // to 端分配失败时回滚 from 端已扣减的小麦（与 transferVouchers 的 from 端回滚对称），避免小麦凭空消失
      if (from === "residents") {
        for (const row of residentDebitRows) state.households.byId[row.householdId].inventory.wheat += row.units;
        syncResidentAggregates(state, content);
      } else {
        setSimpleWheatBalance(state, from, paymentWheatBalanceUnits(state, from) + wheatUnits, content);
        if (from === "town" && townCostQuote) addTownCostBasis(state, "wheat", townCostQuote.costWheatUnits);
      }
      return { ok: false, reason: "支付小麦预检后居民分配失败：" + (result.reason || "") };
    }
    residentCreditRows = result.rows;
  } else {
    setSimpleWheatBalance(state, to, paymentWheatBalanceUnits(state, to) + wheatUnits, content);
    if (to === "town") addTownCostBasis(state, "wheat", valueUnits);
  }

  recordLedger(state, {
    type, transactionId, source: from, destination: to, itemId: "wheat",
    quantityUnits: wheatUnits,
    qeqUnits: wheatUnits * content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin,
    reason: `${reason}；以小麦结算`
  }, content);
  recordHouseholdVoucherTransfer(state, {
    from, to, type, voucherUnits: valueUnits,
    householdDebits: residentDebitRows.map(row => ({ householdId: row.householdId, units: voucherUnitsForWheatUnits(row.units, content, "floor") })),
    householdCredits: residentCreditRows.map(row => ({ householdId: row.householdId, units: voucherUnitsForWheatUnits(row.units, content, "floor") }))
  }, content);
  return { ok: true, wheatUnits, valueUnits, transactionId };
}

function paymentCompositionForStage(stage, targetVoucherBps, valueUnits) {
  if (!Number.isSafeInteger(valueUnits) || valueUnits < 0) throw new RangeError("应付价值必须为非负整数");
  if (stage === MONETARY_STAGE_WHEAT) return { valueUnits, wheatValueUnits: valueUnits, voucherValueUnits: 0 };
  if (stage === MONETARY_STAGE_VOUCHER) return { valueUnits, wheatValueUnits: 0, voucherValueUnits: valueUnits };
  const voucherValueUnits = Math.round(valueUnits * targetVoucherBps / 10000);
  return { valueUnits, voucherValueUnits, wheatValueUnits: valueUnits - voucherValueUnits };
}

function paymentCompositionFromContext(context, valueUnits) {
  return paymentCompositionForStage(context.stage, context.targetVoucherBps, valueUnits);
}

// Short-lived derived data for one synchronous quote search. Never stored on state or carried across a settlement.
export function createPaymentCapabilityContext(state, owner, content, options = {}) {
  const reform = ensureMonetaryReform(state);
  const actualWheatUnits = paymentWheatBalanceUnits(state, owner);
  const wheatLimitUnits = Math.min(actualWheatUnits,
    Number.isSafeInteger(options.maxWheatUnits) ? Math.max(0, options.maxWheatUnits) : actualWheatUnits);
  return {
    content,
    stage: reform.stage,
    targetVoucherBps: reform.targetVoucherBps,
    voucherUnits: Math.max(0, voucherBalance(state, owner)),
    actualWheatUnits,
    wheatLimitUnits,
    autoExchangeableWheatUnits: autoExchangeableWheatUnits(state, owner, content, options),
    exchangeVoucherPoolUnits: owner === "town" ? 0 : Math.max(0, voucherBalance(state, "town")),
    allowVoucherFallback: options.allowVoucherFallback !== false
  };
}

function normalizePaymentObligationFromContext(value, context) {
  if (Number.isSafeInteger(value)) return paymentCompositionFromContext(context, value);
  const total = Math.max(0, Math.round(Number(value?.valueUnits) || 0));
  const wheat = Math.max(0, Math.round(Number(value?.wheatValueUnits) || 0));
  const voucher = Math.max(0, Math.round(Number(value?.voucherValueUnits) || 0));
  const sum = wheat + voucher;
  if (sum === total) return { valueUnits: total, wheatValueUnits: wheat, voucherValueUnits: voucher };
  if (typeof console !== "undefined") console.warn("[麦乡支付] 支付义务分项之和与总额不一致，已按分项之和改写", { valueUnits: total, wheatValueUnits: wheat, voucherValueUnits: voucher });
  return { valueUnits: sum, wheatValueUnits: wheat, voucherValueUnits: voucher };
}

function quoteMonetaryPaymentFromCapability(due, capability, content) {
  const regularWheatNeedUnits = wheatUnitsForVoucherUnits(due.wheatValueUnits, content, "ceil");
  const spareWheatForExchange = Math.max(0, capability.wheatLimitUnits - regularWheatNeedUnits);
  const potentialExchangeWheat = Math.min(spareWheatForExchange, capability.autoExchangeableWheatUnits);
  const potentialExchange = exactExchangeForVoucherNeed(
    Math.min(Math.max(0, due.voucherValueUnits - capability.voucherUnits), capability.exchangeVoucherPoolUnits || 0),
    potentialExchangeWheat, content
  );
  const voucherAvailable = capability.voucherUnits + potentialExchange.voucherUnits;
  const regularVoucherPaid = Math.min(due.voucherValueUnits, voucherAvailable);
  let voucherRemaining = due.voucherValueUnits - regularVoucherPaid;
  const fallbackAllowed = capability.stage === MONETARY_STAGE_TRANSITION && capability.allowVoucherFallback;
  const availableWheatUnits = Math.max(0, capability.wheatLimitUnits - potentialExchange.wheatUnits);
  const availableWheatValue = voucherUnitsForWheatUnits(availableWheatUnits, content, "floor");
  const regularWheatPaidValue = Math.min(due.wheatValueUnits, availableWheatValue);
  const wheatCapacityLeft = Math.max(0, availableWheatValue - regularWheatPaidValue);
  const fallbackWheatValue = fallbackAllowed ? Math.min(voucherRemaining, wheatCapacityLeft) : 0;
  voucherRemaining -= fallbackWheatValue;
  const remainingWheatValue = due.wheatValueUnits - regularWheatPaidValue;
  const remainingValue = remainingWheatValue + voucherRemaining;
  return { due, full: remainingValue === 0, voucherPaidValueUnits: regularVoucherPaid,
    wheatPaidValueUnits: regularWheatPaidValue + fallbackWheatValue, fallbackWheatValueUnits: fallbackWheatValue,
    remainingValueUnits: remainingValue, remainingComposition: { valueUnits: remainingValue, wheatValueUnits: remainingWheatValue, voucherValueUnits: voucherRemaining },
    voucherShortfallValueUnits: voucherRemaining, availableWheatUnits };
}

export function quoteMonetaryPaymentWithContext(context, dueInput) {
  const due = normalizePaymentObligationFromContext(dueInput, context);
  return quoteMonetaryPaymentFromCapability(due, context, context.content);
}

export function quotePaymentValueUnitsWithContext(context, valueUnits) {
  if (context.stage === MONETARY_STAGE_WHEAT) {
    const due = paymentCompositionFromContext(context, valueUnits);
    const availableWheatValue = voucherUnitsForWheatUnits(context.wheatLimitUnits, context.content, "floor");
    const wheatPaidValueUnits = Math.min(valueUnits, availableWheatValue);
    const remainingValueUnits = valueUnits - wheatPaidValueUnits;
    return { due, full: remainingValueUnits === 0, voucherPaidValueUnits: 0,
      wheatPaidValueUnits, fallbackWheatValueUnits: 0, remainingValueUnits,
      remainingComposition: { valueUnits: remainingValueUnits, wheatValueUnits: remainingValueUnits, voucherValueUnits: 0 },
      voucherShortfallValueUnits: 0, availableWheatUnits: context.wheatLimitUnits };
  }
  return quoteMonetaryPaymentWithContext(context, paymentCompositionFromContext(context, valueUnits));
}

function maximumPayableValueUnitsFromContext(context) {
  const voucher = context.voucherUnits;
  const wheat = Math.max(0, voucherUnitsForWheatUnits(context.wheatLimitUnits, context.content, "floor"));
  if (context.stage === MONETARY_STAGE_WHEAT) return wheat;
  if (context.stage === MONETARY_STAGE_VOUCHER) {
    const exchangeable = Math.min(
      voucherUnitsForWheatUnits(context.autoExchangeableWheatUnits, context.content, "floor"),
      context.exchangeVoucherPoolUnits || 0
    );
    return Math.min(Number.MAX_SAFE_INTEGER, voucher + exchangeable);
  }
  return Math.min(Number.MAX_SAFE_INTEGER, voucher + wheat);
}

export function maximumPayableValueUnits(state, owner, content, options = {}) {
  const context = options.paymentContext || createPaymentCapabilityContext(state, owner, content, options);
  return maximumPayableValueUnitsFromContext(context);
}

export function maximumFullyPayableValueUnits(state, owner, limitValueUnits, content, options = {}) {
  const context = options.paymentContext || createPaymentCapabilityContext(state, owner, content, options);
  let low = 0;
  let high = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(limitValueUnits) || 0)));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const quote = quotePaymentValueUnitsWithContext(context, mid);
    if (quote.full) low = mid; else high = mid - 1;
  }
  return low;
}

export function currentPaymentComposition(state, valueUnits) {
  const reform = ensureMonetaryReform(state);
  return paymentCompositionForStage(reform.stage, reform.targetVoucherBps, valueUnits);
}

export function addPaymentObligation(left, right) {
  const a = left || { valueUnits: 0, wheatValueUnits: 0, voucherValueUnits: 0 };
  const b = right || { valueUnits: 0, wheatValueUnits: 0, voucherValueUnits: 0 };
  return {
    valueUnits: (a.valueUnits || 0) + (b.valueUnits || 0),
    wheatValueUnits: (a.wheatValueUnits || 0) + (b.wheatValueUnits || 0),
    voucherValueUnits: (a.voucherValueUnits || 0) + (b.voucherValueUnits || 0)
  };
}

export function paymentObligationFromLegacyVoucher(valueUnits) {
  return { valueUnits, wheatValueUnits: 0, voucherValueUnits: valueUnits };
}

export function normalizePaymentObligation(value, state = null) {
  if (Number.isSafeInteger(value)) return state ? currentPaymentComposition(state, value) : paymentObligationFromLegacyVoucher(value);
  const total = Math.max(0, Math.round(Number(value?.valueUnits) || 0));
  const wheat = Math.max(0, Math.round(Number(value?.wheatValueUnits) || 0));
  const voucher = Math.max(0, Math.round(Number(value?.voucherValueUnits) || 0));
  const sum = wheat + voucher;
  if (sum === total) return { valueUnits: total, wheatValueUnits: wheat, voucherValueUnits: voucher };
  if (typeof console !== "undefined") console.warn("[麦乡支付] 支付义务分项之和与总额不一致，已按分项之和改写", { valueUnits: total, wheatValueUnits: wheat, voucherValueUnits: voucher });
  return { valueUnits: sum, wheatValueUnits: wheat, voucherValueUnits: voucher };
}

function paymentDaySerial(state, content) {
  return (state.year - 1) * content.rules.daysPerYear + state.day + 1;
}

function paymentDayRow(state, content) {
  const reform = ensureMonetaryReform(state);
  const serial = paymentDaySerial(state, content);
  let row = reform.paymentHistory.find(item => item.serial === serial);
  if (!row) {
    row = { serial, year: state.year, day: state.day + 1, paidValueUnits: 0, voucherValueUnits: 0,
      wheatValueUnits: 0, fallbackWheatValueUnits: 0, unpaidAttemptValueUnits: 0, finalized: false };
    reform.paymentHistory.push(row);
    reform.paymentHistory.sort((a, b) => a.serial - b.serial);
    if (reform.paymentHistory.length > 60) reform.paymentHistory.splice(0, reform.paymentHistory.length - 60);
  }
  return row;
}

function recordPaymentMetric(state, result, content, unpaidAttempt = 0) {
  const row = paymentDayRow(state, content);
  row.paidValueUnits += result.paidValueUnits;
  row.voucherValueUnits += result.voucherPaidValueUnits;
  row.wheatValueUnits += result.wheatPaidValueUnits;
  row.fallbackWheatValueUnits += result.fallbackWheatValueUnits;
  row.unpaidAttemptValueUnits += Math.max(0, unpaidAttempt);
}

function updateShortfall(state, key, valueUnits) {
  if (!key) return;
  const reform = ensureMonetaryReform(state);
  if (valueUnits > 0) reform.voucherShortfallByKey[key] = valueUnits;
  else delete reform.voucherShortfallByKey[key];
}

export function quoteMonetaryPayment(state, from, dueInput, content, options = {}) {
  const due = normalizePaymentObligation(dueInput, state);
  const reform = ensureMonetaryReform(state);
  const actualWheatUnits = paymentWheatBalanceUnits(state, from);
  const wheatLimitUnits = Math.min(actualWheatUnits,
    Number.isSafeInteger(options.maxWheatUnits) ? Math.max(0, options.maxWheatUnits) : actualWheatUnits);
  return quoteMonetaryPaymentFromCapability(due, {
    stage: reform.stage,
    voucherUnits: Math.max(0, voucherBalance(state, from)),
    wheatLimitUnits,
    autoExchangeableWheatUnits: autoExchangeableWheatUnits(state, from, content, options),
    exchangeVoucherPoolUnits: from === "town" ? 0 : Math.max(0, voucherBalance(state, "town")),
    allowVoucherFallback: options.allowVoucherFallback !== false
  }, content);
}

export function settleMonetaryPayment(state, from, to, dueInput, content, type = "payment", reason = "货币支付", options = {}) {
  const due = normalizePaymentObligation(dueInput, state);
  if (due.valueUnits <= 0) return { ok: true, paidValueUnits: 0, voucherPaidValueUnits: 0, wheatPaidValueUnits: 0,
    fallbackWheatValueUnits: 0, remainingValueUnits: 0, remainingComposition: due, transactionId: null };
  const reform = ensureMonetaryReform(state);
  if (options.requireFull !== false) {
    const preflight = quoteMonetaryPayment(state, from, due, content, options);
    if (!preflight.full) {
      if (options.trackUnpaid) updateShortfall(state, options.shortfallKey, preflight.voucherShortfallValueUnits || 0);
      const reasonText = (preflight.voucherShortfallValueUnits || 0) > 0
        ? (reform.stage === MONETARY_STAGE_TRANSITION ? "粮券与可支付小麦均不足" : "粮券不足，当前制度不允许小麦补付")
        : "可支付小麦不足";
      return { ok: false, reason: reasonText, paidValueUnits: 0, voucherPaidValueUnits: 0, wheatPaidValueUnits: 0,
        fallbackWheatValueUnits: 0, remainingValueUnits: due.valueUnits, remainingComposition: due,
        voucherShortfallValueUnits: preflight.voucherShortfallValueUnits || 0 };
    }
  }
  const beforeVoucher = voucherBalance(state, from);
  autoExchangeForPayment(state, from, Math.max(0, due.voucherValueUnits - beforeVoucher), due.wheatValueUnits, content, options);
  const voucherAvailable = voucherBalance(state, from);
  const regularVoucherPaid = Math.min(due.voucherValueUnits, voucherAvailable);
  let voucherRemaining = due.voucherValueUnits - regularVoucherPaid;
  const fallbackAllowed = reform.stage === MONETARY_STAGE_TRANSITION && options.allowVoucherFallback !== false;
  const regularWheatNeed = due.wheatValueUnits;
  const actualWheatUnits = paymentWheatBalanceUnits(state, from);
  const availableWheatUnits = Math.min(actualWheatUnits, Number.isSafeInteger(options.maxWheatUnits) ? Math.max(0, options.maxWheatUnits) : actualWheatUnits);
  const availableWheatValue = voucherUnitsForWheatUnits(availableWheatUnits, content, "floor");
  const regularWheatPaidValue = Math.min(regularWheatNeed, availableWheatValue);
  let wheatCapacityLeft = Math.max(0, availableWheatValue - regularWheatPaidValue);
  const fallbackWheatValue = fallbackAllowed ? Math.min(voucherRemaining, wheatCapacityLeft) : 0;
  voucherRemaining -= fallbackWheatValue;
  const remainingWheatValue = regularWheatNeed - regularWheatPaidValue;
  const remainingValue = remainingWheatValue + voucherRemaining;

  if (options.requireFull !== false && remainingValue > 0) {
    const reasonText = voucherRemaining > 0 && regularVoucherPaid < due.voucherValueUnits
      ? (fallbackAllowed ? "粮券与可支付小麦均不足" : "粮券不足，当前制度不允许小麦补付")
      : "可支付小麦不足";
    if (options.trackUnpaid) updateShortfall(state, options.shortfallKey, voucherRemaining);
    return { ok: false, reason: reasonText, paidValueUnits: 0, voucherPaidValueUnits: 0, wheatPaidValueUnits: 0,
      fallbackWheatValueUnits: 0, remainingValueUnits: due.valueUnits, remainingComposition: due,
      voucherShortfallValueUnits: voucherRemaining };
  }

  const voucherPaidValue = regularVoucherPaid;
  const wheatPaidValue = regularWheatPaidValue + fallbackWheatValue;
  const wheatUnits = wheatUnitsForVoucherUnits(wheatPaidValue, content, "ceil");
  if (wheatUnits > availableWheatUnits) throw new Error("小麦支付换算预检失败");
  const transactionId = makeTransactionId(state);

  if (voucherPaidValue > 0) {
    const voucher = transferVouchers(state, from, to, voucherPaidValue, content, type, `${reason}；粮券部分`, { transactionId });
    if (!voucher.ok) throw new Error("粮券支付预检后失败：" + voucher.reason);
  }
  if (wheatPaidValue > 0) {
    const wheat = transferPaymentWheat(state, from, to, wheatUnits, wheatPaidValue, content, type, reason, transactionId);
    if (!wheat.ok) throw new Error("小麦支付预检后失败：" + wheat.reason);
  }

  const paidValue = voucherPaidValue + wheatPaidValue;
  const result = {
    ok: remainingValue === 0,
    reason: remainingValue > 0 ? "仅完成部分支付" : null,
    transactionId,
    paidValueUnits: paidValue,
    voucherPaidValueUnits: voucherPaidValue,
    wheatPaidValueUnits: wheatPaidValue,
    wheatPaidUnits: wheatUnits,
    fallbackWheatValueUnits: fallbackWheatValue,
    remainingValueUnits: remainingValue,
    voucherShortfallValueUnits: voucherRemaining,
    remainingComposition: { valueUnits: remainingValue, wheatValueUnits: remainingWheatValue, voucherValueUnits: voucherRemaining }
  };
  if (options.trackUnpaid) updateShortfall(state, options.shortfallKey, voucherRemaining);
  if (options.countsForReform !== false) recordPaymentMetric(state, result, content, options.trackUnpaid ? remainingValue : 0);
  return result;
}

export function finalizeMonetaryPaymentDay(state, content) {
  const row = paymentDayRow(state, content);
  row.finalized = true;
  return row;
}

export function monetaryReformProgress(state, content) {
  const reform = ensureMonetaryReform(state);
  const finalized = reform.paymentHistory.filter(row => row.finalized).sort((a, b) => a.serial - b.serial);
  const window = finalized.slice(-7);
  const paidValueUnits = window.reduce((sum, row) => sum + row.paidValueUnits, 0);
  const voucherValueUnits = window.reduce((sum, row) => sum + row.voucherValueUnits, 0);
  const fallbackWheatValueUnits = window.reduce((sum, row) => sum + row.fallbackWheatValueUnits, 0);
  const shortfallValueUnits = Object.values(reform.voucherShortfallByKey || {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  const consecutive = window.length === 7 && window.every((row, index) => index === 0 || row.serial === window[index - 1].serial + 1);
  const eligible = reform.stage === MONETARY_STAGE_TRANSITION && reform.targetVoucherBps === 10000 && consecutive &&
    paidValueUnits > 0 && fallbackWheatValueUnits === 0 && shortfallValueUnits === 0;
  return {
    stage: reform.stage,
    targetVoucherBps: reform.targetVoucherBps,
    recentDays: window.length,
    recentPaidValueUnits: paidValueUnits,
    recentVoucherValueUnits: voucherValueUnits,
    recentVoucherBps: paidValueUnits > 0 ? Math.round(voucherValueUnits * 10000 / paidValueUnits) : 0,
    recentFallbackWheatValueUnits: fallbackWheatValueUnits,
    voucherShortfallValueUnits: shortfallValueUnits,
    consecutiveSevenDays: consecutive,
    eligibleToComplete: eligible
  };
}

export function startMonetaryReform(state, content) {
  const reform = ensureMonetaryReform(state);
  if (reform.stage !== MONETARY_STAGE_WHEAT) return { ok: false, reason: "货币改革已经启动" };
  if (!hasBankAccess(state)) return { ok: false, reason: "需先建成银行" };
  reform.stage = MONETARY_STAGE_TRANSITION;
  reform.targetVoucherBps = 0;
  reform.residentExchangeEnabled = false;
  reform.started = { year: state.year, day: Math.min(content.rules.daysPerYear, state.day + 1) };
  return { ok: true, stage: reform.stage };
}

export function setVoucherPaymentTarget(state, percent) {
  const reform = ensureMonetaryReform(state);
  if (reform.stage !== MONETARY_STAGE_TRANSITION) return { ok: false, reason: "仅过渡期可调整粮券支付比例" };
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, reason: "粮券支付比例须为0%—100%" };
  reform.targetVoucherBps = Math.round(value * 100);
  return { ok: true, value: reform.targetVoucherBps / 100 };
}

export function setResidentExchangeEnabled(state, enabled) {
  const reform = ensureMonetaryReform(state);
  if (reform.stage === MONETARY_STAGE_WHEAT) return { ok: false, reason: "货币改革尚未启动" };
  reform.residentExchangeEnabled = Boolean(enabled);
  return { ok: true, enabled: reform.residentExchangeEnabled };
}

export function completeMonetaryReform(state, content) {
  const reform = ensureMonetaryReform(state);
  const progress = monetaryReformProgress(state, content);
  if (!progress.eligibleToComplete) return { ok: false, reason: "尚未满足结束过渡期条件", progress };
  reform.stage = MONETARY_STAGE_VOUCHER;
  reform.targetVoucherBps = 10000;
  reform.completed = { year: state.year, day: Math.min(content.rules.daysPerYear, state.day + 1) };
  return { ok: true, stage: reform.stage, progress };
}
