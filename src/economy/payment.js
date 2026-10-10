import { issueTownVouchers, issueVouchersFromWheat, transferVouchers, voucherBalance } from "./currency.js";
import { householdIdOf, isHouseholdOwner, parseOwner, paymentWheatSlot, readSlot } from "./accounts.js";
import { addTownCostBasis, applyTownCostRemoval, quoteTownCostRemoval } from "./business.js";
import { makeTransactionId, recordLedger } from "./ledger.js";
import { voucherUnitsForWheatUnits, wheatUnitsForVoucherUnits } from "./money-units.js";
import { distributeResidentInventory, takeResidentInventory, syncResidentAggregates, applyResidentAggregateDelta, householdConvertibleWheatUnits, householdExchangeAllowanceUnits, householdList, hasHouseholds, isActiveHousehold, withDeferredHouseholdSync } from "../systems/households.js";
import { recordHouseholdVoucherTransfer } from "../systems/household-life.js";
import { withdrawFromBank } from "./deposits.js";

// 货币制度只有两段：小麦结算 → 粮券结算。启动货币改革即一次性切换，没有过渡期。
export const MONETARY_STAGE_WHEAT = "wheat";
export const MONETARY_STAGE_VOUCHER = "voucher";

export function ensureMonetaryReform(state) {
  state.monetaryReform ||= { stage: MONETARY_STAGE_WHEAT, legacyBankAccess: false, started: null, completed: null };
  const reform = state.monetaryReform;
  if (reform.stage !== MONETARY_STAGE_VOUCHER) reform.stage = MONETARY_STAGE_WHEAT;
  reform.legacyBankAccess = Boolean(reform.legacyBankAccess);
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
  if (isHouseholdOwner(owner)) {
    const household = state.households?.byId?.[householdIdOf(owner)];
    if (!household) return 0;
    units = Math.min(
      householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30),
      householdExchangeAllowanceUnits(state, household.id, content)
    );
  } else if (owner === "residents") {
    units = householdList(state).reduce((sum, household) => sum + Math.min(
      householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30),
      householdExchangeAllowanceUnits(state, household.id, content)
    ), 0);
  } else if (["company", "shop"].includes(parseOwner(owner).kind)) {
    units = paymentWheatBalanceUnits(state, owner);
  }
  if (Number.isSafeInteger(options.maxWheatUnits)) units = Math.min(units, Math.max(0, options.maxWheatUnits));
  return Math.max(0, units);
}

function autoExchangeForPayment(state, owner, voucherNeedUnits, dueWheatValueUnits, content, options = {}) {
  if (voucherNeedUnits <= 0 || !["residents", "household", "company", "shop"].includes(parseOwner(owner).kind)) return { wheatUnits: 0, voucherUnits: 0 };
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
  return readSlot(paymentWheatSlot(state, owner));
}

// 银行取款的镇库托底（银行负债，见 economy/deposits.js）：银行现金不够时，镇库粮券可以垫付缺口。
// 镇库无存款、不参与换券以外的付款，所以它的可垫付额就是镇库粮券余额，与 maximumPayableValueUnits(state, "town") 同口径。
function townAdvanceCapacityUnits(state) {
  return Math.max(0, voucherBalance(state, "town"));
}

// 存款可随时取回付款：住户存款与“银行现金 + 镇库可垫付额”的较小者。
// 银行现金不够时由镇库垫付（记为银行欠镇库的债），所以只有镇库也没钱时才取不出来。
// 只有家庭（以及居民汇总，即全体家庭之和）有存款；其他经济主体返回 0。O(户数)。
export function depositWithdrawableUnits(state, owner) {
  const bank = state.bank;
  if (!bank) return 0;
  const liquidity = Math.max(0, bank.cashVoucherUnits || 0) + townAdvanceCapacityUnits(state);
  if (liquidity <= 0) return 0;
  const kind = parseOwner(owner).kind;
  if (kind === "household") return Math.min(liquidity, Math.max(0, bank.deposits?.[householdIdOf(owner)] || 0));
  if (owner === "residents" && hasHouseholds(state)) {
    let deposits = 0;
    for (const [householdId, units] of Object.entries(bank.deposits || {})) {
      const household = state.households?.byId?.[householdId];
      if (household && isActiveHousehold(household)) deposits += Math.max(0, units || 0);
    }
    return Math.min(liquidity, deposits);
  }
  return 0;
}

// 换券用的镇库粮券池。镇库粮券同时是存款取回的垫付来源；付款顺序是
// 手头粮券 → 存款取回（含镇库垫付）→ 换券，所以换券只发生在存款全部取回之后，此时垫付额 = 可取回额 − 银行现金。
// withdrawableUnits 必须是 depositWithdrawableUnits 的结果，保证报价与结算用同一口径。
function exchangeVoucherPoolUnits(state, owner, withdrawableUnits) {
  if (owner === "town") return 0;
  const advance = Math.max(0, withdrawableUnits - Math.max(0, state.bank?.cashVoucherUnits || 0));
  return Math.max(0, townAdvanceCapacityUnits(state) - advance);
}

// 付款可动用的粮券 = 手头粮券 + 可取回的存款。所有"能不能付、最多付多少"的判断都用它。
export function spendableVoucherUnits(state, owner) {
  return Math.max(0, voucherBalance(state, owner)) + depositWithdrawableUnits(state, owner);
}

// 现金不够时先从存款取回（住户存款在银行台账里，取回后粮券回到住户手里再付款）。
// 调用顺序：手头粮券 → 存款取回（银行现金不足部分由镇库垫付）→ 换券（小麦）。居民汇总从存款最多的家庭开始取。
// 取款总额不超过 depositWithdrawableUnits，所以镇库垫付一定够；垫付总额 = 取款总额 − 银行原有现金。
function withdrawDepositsForPayment(state, owner, needUnits, content) {
  let left = Math.min(Math.max(0, needUnits), depositWithdrawableUnits(state, owner));
  if (left <= 0) return;
  if (parseOwner(owner).kind === "household") {
    const result = withdrawFromBank(state, householdIdOf(owner), left, content);
    if (!result.ok) throw new Error("存款取款预检后失败：" + result.reason);
    return;
  }
  withDeferredHouseholdSync(state, content, () => {
    const rows = Object.entries(state.bank.deposits || {})
      .filter(([householdId, units]) => {
        const household = state.households?.byId?.[householdId];
        return (units || 0) > 0 && Boolean(household) && isActiveHousehold(household);
      })
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [householdId, units] of rows) {
      if (left <= 0) break;
      const take = Math.min(left, units);
      if (take <= 0) continue;
      const result = withdrawFromBank(state, householdId, take, content);
      if (!result.ok) throw new Error("存款取款预检后失败：" + result.reason);
      left -= take;
    }
  });
}

function canCreditWheat(state, owner, wheatUnits) {
  if (!Number.isSafeInteger(wheatUnits) || wheatUnits < 0) return false;
  const current = paymentWheatBalanceUnits(state, owner);
  return Number.isSafeInteger(current + wheatUnits);
}

function setSimpleWheatBalance(state, owner, value, content) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("支付小麦余额无效");
  // 居民汇总的小麦要落到具体家庭，由 transferPaymentWheat 单独处理。
  const slot = owner === "residents" ? null : paymentWheatSlot(state, owner);
  if (!slot) throw new Error("未知小麦支付账户：" + owner);
  const before = readSlot(slot);
  slot.holder[slot.key] = value;
  if (isHouseholdOwner(owner)) applyResidentAggregateDelta(state, content, 0, "wheat", value - before);
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

function paymentCompositionForStage(stage, valueUnits) {
  if (!Number.isSafeInteger(valueUnits) || valueUnits < 0) throw new RangeError("应付价值必须为非负整数");
  if (stage === MONETARY_STAGE_VOUCHER) return { valueUnits, wheatValueUnits: 0, voucherValueUnits: valueUnits };
  return { valueUnits, wheatValueUnits: valueUnits, voucherValueUnits: 0 };
}

function paymentCompositionFromContext(context, valueUnits) {
  return paymentCompositionForStage(context.stage, valueUnits);
}

// Short-lived derived data for one synchronous quote search. Never stored on state or carried across a settlement.
export function createPaymentCapabilityContext(state, owner, content, options = {}) {
  const reform = ensureMonetaryReform(state);
  const actualWheatUnits = paymentWheatBalanceUnits(state, owner);
  const wheatLimitUnits = Math.min(actualWheatUnits,
    Number.isSafeInteger(options.maxWheatUnits) ? Math.max(0, options.maxWheatUnits) : actualWheatUnits);
  const withdrawable = depositWithdrawableUnits(state, owner);
  return {
    content,
    stage: reform.stage,
    voucherUnits: Math.max(0, voucherBalance(state, owner)) + withdrawable,
    actualWheatUnits,
    wheatLimitUnits,
    autoExchangeableWheatUnits: autoExchangeableWheatUnits(state, owner, content, options),
    exchangeVoucherPoolUnits: exchangeVoucherPoolUnits(state, owner, withdrawable)
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
  const voucherRemaining = due.voucherValueUnits - regularVoucherPaid;
  const availableWheatUnits = Math.max(0, capability.wheatLimitUnits - potentialExchange.wheatUnits);
  const availableWheatValue = voucherUnitsForWheatUnits(availableWheatUnits, content, "floor");
  const regularWheatPaidValue = Math.min(due.wheatValueUnits, availableWheatValue);
  const remainingWheatValue = due.wheatValueUnits - regularWheatPaidValue;
  const remainingValue = remainingWheatValue + voucherRemaining;
  return { due, full: remainingValue === 0, voucherPaidValueUnits: regularVoucherPaid,
    wheatPaidValueUnits: regularWheatPaidValue,
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
      wheatPaidValueUnits, remainingValueUnits,
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
  return paymentCompositionForStage(reform.stage, valueUnits);
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

export function quoteMonetaryPayment(state, from, dueInput, content, options = {}) {
  const due = normalizePaymentObligation(dueInput, state);
  const reform = ensureMonetaryReform(state);
  const actualWheatUnits = paymentWheatBalanceUnits(state, from);
  const wheatLimitUnits = Math.min(actualWheatUnits,
    Number.isSafeInteger(options.maxWheatUnits) ? Math.max(0, options.maxWheatUnits) : actualWheatUnits);
  const withdrawable = depositWithdrawableUnits(state, from);
  return quoteMonetaryPaymentFromCapability(due, {
    stage: reform.stage,
    voucherUnits: Math.max(0, voucherBalance(state, from)) + withdrawable,
    wheatLimitUnits,
    autoExchangeableWheatUnits: autoExchangeableWheatUnits(state, from, content, options),
    exchangeVoucherPoolUnits: exchangeVoucherPoolUnits(state, from, withdrawable)
  }, content);
}

export function settleMonetaryPayment(state, from, to, dueInput, content, type = "payment", reason = "货币支付", options = {}) {
  const due = normalizePaymentObligation(dueInput, state);
  if (due.valueUnits <= 0) return { ok: true, paidValueUnits: 0, voucherPaidValueUnits: 0, wheatPaidValueUnits: 0,
    remainingValueUnits: 0, remainingComposition: due, transactionId: null };
  if (options.requireFull !== false) {
    const preflight = quoteMonetaryPayment(state, from, due, content, options);
    if (!preflight.full) {
      const reasonText = (preflight.voucherShortfallValueUnits || 0) > 0 ? "粮券不足" : "可支付小麦不足";
      return { ok: false, reason: reasonText, paidValueUnits: 0, voucherPaidValueUnits: 0, wheatPaidValueUnits: 0,
        remainingValueUnits: due.valueUnits, remainingComposition: due,
        voucherShortfallValueUnits: preflight.voucherShortfallValueUnits || 0 };
    }
  }
  // 付款顺序：手头粮券 → 存款取回 → 换券（小麦）。
  const beforeVoucher = voucherBalance(state, from);
  withdrawDepositsForPayment(state, from, Math.max(0, due.voucherValueUnits - beforeVoucher), content);
  autoExchangeForPayment(state, from, Math.max(0, due.voucherValueUnits - voucherBalance(state, from)), due.wheatValueUnits, content, options);
  const voucherAvailable = voucherBalance(state, from);
  const regularVoucherPaid = Math.min(due.voucherValueUnits, voucherAvailable);
  const voucherRemaining = due.voucherValueUnits - regularVoucherPaid;
  const regularWheatNeed = due.wheatValueUnits;
  const actualWheatUnits = paymentWheatBalanceUnits(state, from);
  const availableWheatUnits = Math.min(actualWheatUnits, Number.isSafeInteger(options.maxWheatUnits) ? Math.max(0, options.maxWheatUnits) : actualWheatUnits);
  const availableWheatValue = voucherUnitsForWheatUnits(availableWheatUnits, content, "floor");
  const regularWheatPaidValue = Math.min(regularWheatNeed, availableWheatValue);
  const remainingWheatValue = regularWheatNeed - regularWheatPaidValue;
  const remainingValue = remainingWheatValue + voucherRemaining;

  if (options.requireFull !== false && remainingValue > 0) {
    const reasonText = voucherRemaining > 0 ? "粮券不足" : "可支付小麦不足";
    return { ok: false, reason: reasonText, paidValueUnits: 0, voucherPaidValueUnits: 0, wheatPaidValueUnits: 0,
      remainingValueUnits: due.valueUnits, remainingComposition: due,
      voucherShortfallValueUnits: voucherRemaining };
  }

  const voucherPaidValue = regularVoucherPaid;
  const wheatPaidValue = regularWheatPaidValue;
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
    remainingValueUnits: remainingValue,
    voucherShortfallValueUnits: voucherRemaining,
    remainingComposition: { valueUnits: remainingValue, wheatValueUnits: remainingWheatValue, voucherValueUnits: voucherRemaining }
  };
  return result;
}

export function startMonetaryReform(state, content) {
  const reform = ensureMonetaryReform(state);
  if (reform.stage !== MONETARY_STAGE_WHEAT) return { ok: false, reason: "货币改革已经完成" };
  if (!hasBankAccess(state)) return { ok: false, reason: "需先建成银行" };
  // 一次性切换：镇库按自有小麦存量印制等额粮券，保证切换当天发得出工资；居民可随时以粮换券。
  reform.stage = MONETARY_STAGE_VOUCHER;
  const townWheat = Math.max(0, state.accounts?.town?.wheat || 0);
  const printUnits = voucherUnitsForWheatUnits(townWheat, content, "floor");
  if (printUnits > 0) {
    const printed = issueTownVouchers(state, printUnits, content, "货币改革：按镇库小麦存量印制粮券");
    if (!printed.ok) { reform.stage = MONETARY_STAGE_WHEAT; return printed; }
  }
  const day = Math.min(content.rules.daysPerYear, state.day + 1);
  reform.started = { year: state.year, day };
  reform.completed = { year: state.year, day };
  return { ok: true, stage: reform.stage, printedVoucherUnits: printUnits };
}
