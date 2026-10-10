import { issueVouchersFromWheat, transferVouchers, voucherBalance } from "./currency.js";
import { householdIdOf, isHouseholdOwner, parseOwner } from "./accounts.js";
import { makeTransactionId } from "./ledger.js";
import { voucherUnitsForWheatUnits } from "./money-units.js";
import { householdConvertibleWheatUnits, householdExchangeAllowanceUnits, householdList, hasHouseholds, isActiveHousehold, withDeferredHouseholdSync } from "../systems/households.js";
import { withdrawFromBank } from "./deposits.js";

// 货币只有粮券一种：小麦是商品与口粮，不再当货币付款。
// state.monetaryReform 只剩 legacyBankAccess（没有银行建筑的测试/场景/旧入口，用来开放印券与换券）。
export function ensureMonetaryReform(state) {
  state.monetaryReform ||= { legacyBankAccess: false };
  state.monetaryReform.legacyBankAccess = Boolean(state.monetaryReform.legacyBankAccess);
  return state.monetaryReform;
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
  }
  if (Number.isSafeInteger(options.maxWheatUnits)) units = Math.min(units, Math.max(0, options.maxWheatUnits));
  return Math.max(0, units);
}

function autoExchangeForPayment(state, owner, voucherNeedUnits, content, options = {}) {
  if (voucherNeedUnits <= 0 || !["residents", "household"].includes(parseOwner(owner).kind)) return { wheatUnits: 0, voucherUnits: 0 };
  const exchangeable = autoExchangeableWheatUnits(state, owner, content, options);
  const townVoucherPool = Math.max(0, voucherBalance(state, "town"));
  const exact = exactExchangeForVoucherNeed(Math.min(voucherNeedUnits, townVoucherPool), exchangeable, content);
  if (exact.wheatUnits <= 0) return exact;
  const issued = issueVouchersFromWheat(state, owner, exact.wheatUnits, content, "按银行开放规则为支付自动换券");
  return issued.ok ? { wheatUnits: issued.wheatUnits, voucherUnits: issued.voucherUnits } : { wheatUnits: 0, voucherUnits: 0 };
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

// 同 spendableVoucherUnits(state, `household:${id}`)，直接用家庭对象，省掉拼账户名和解析（热路径：遍历全体家庭估购买力）。
export function householdSpendableVoucherUnits(state, household) {
  const hand = Math.max(0, household.voucherUnits || 0);
  const bank = state.bank;
  if (!bank) return hand;
  const deposit = bank.deposits?.[household.id] || 0;
  if (!(deposit > 0)) return hand;
  const liquidity = Math.max(0, bank.cashVoucherUnits || 0) + townAdvanceCapacityUnits(state);
  return liquidity > 0 ? hand + Math.min(liquidity, deposit) : hand;
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

// 支付义务统一成 { valueUnits, wheatValueUnits, voucherValueUnits } 的形状（接口保持不变，调用点很多）；
// 现在只有粮券一种货币，小麦分项恒为 0，旧调用传进来的小麦分项会并入粮券。
function voucherOnlyObligation(valueUnits) {
  if (!Number.isSafeInteger(valueUnits) || valueUnits < 0) throw new RangeError("应付价值必须为非负整数");
  return { valueUnits, wheatValueUnits: 0, voucherValueUnits: valueUnits };
}

// Short-lived derived data for one synchronous quote search. Never stored on state or carried across a settlement.
export function createPaymentCapabilityContext(state, owner, content, options = {}) {
  const withdrawable = depositWithdrawableUnits(state, owner);
  return {
    content,
    voucherUnits: Math.max(0, voucherBalance(state, owner)) + withdrawable,
    autoExchangeableWheatUnits: autoExchangeableWheatUnits(state, owner, content, options),
    exchangeVoucherPoolUnits: exchangeVoucherPoolUnits(state, owner, withdrawable)
  };
}

function quoteFromCapability(dueValueUnits, capability, content) {
  const potentialExchange = exactExchangeForVoucherNeed(
    Math.min(Math.max(0, dueValueUnits - capability.voucherUnits), capability.exchangeVoucherPoolUnits || 0),
    capability.autoExchangeableWheatUnits, content
  );
  const voucherAvailable = capability.voucherUnits + potentialExchange.voucherUnits;
  const paid = Math.min(dueValueUnits, voucherAvailable);
  const remaining = dueValueUnits - paid;
  return { due: voucherOnlyObligation(dueValueUnits), full: remaining === 0, voucherPaidValueUnits: paid,
    wheatPaidValueUnits: 0, remainingValueUnits: remaining,
    remainingComposition: voucherOnlyObligation(remaining), voucherShortfallValueUnits: remaining };
}

export function quoteMonetaryPaymentWithContext(context, dueInput) {
  return quoteFromCapability(normalizePaymentObligation(dueInput).valueUnits, context, context.content);
}

export function quotePaymentValueUnitsWithContext(context, valueUnits) {
  return quoteFromCapability(voucherOnlyObligation(valueUnits).valueUnits, context, context.content);
}

function maximumPayableValueUnitsFromContext(context) {
  const exchangeable = Math.min(
    voucherUnitsForWheatUnits(context.autoExchangeableWheatUnits, context.content, "floor"),
    context.exchangeVoucherPoolUnits || 0
  );
  return Math.min(Number.MAX_SAFE_INTEGER, context.voucherUnits + exchangeable);
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
  void state;
  return voucherOnlyObligation(valueUnits);
}

export function addPaymentObligation(left, right) {
  return voucherOnlyObligation(((left?.valueUnits) || 0) + ((right?.valueUnits) || 0));
}

export function paymentObligationFromLegacyVoucher(valueUnits) {
  return voucherOnlyObligation(valueUnits);
}

// 接受整数（价值）或旧形状的对象；小麦分项并入粮券。
export function normalizePaymentObligation(value, state = null) {
  void state;
  if (Number.isSafeInteger(value)) return voucherOnlyObligation(value);
  const wheat = Math.max(0, Math.round(Number(value?.wheatValueUnits) || 0));
  const voucher = Math.max(0, Math.round(Number(value?.voucherValueUnits) || 0));
  const total = Math.max(0, Math.round(Number(value?.valueUnits) || 0));
  return voucherOnlyObligation(Math.max(total, wheat + voucher));
}

export function quoteMonetaryPayment(state, from, dueInput, content, options = {}) {
  const due = normalizePaymentObligation(dueInput);
  return quoteFromCapability(due.valueUnits, createPaymentCapabilityContext(state, from, content, options), content);
}

export function settleMonetaryPayment(state, from, to, dueInput, content, type = "payment", reason = "货币支付", options = {}) {
  const due = normalizePaymentObligation(dueInput);
  if (due.valueUnits <= 0) return { ok: true, paidValueUnits: 0, voucherPaidValueUnits: 0, wheatPaidValueUnits: 0,
    remainingValueUnits: 0, remainingComposition: due, transactionId: null };
  if (options.requireFull !== false) {
    const preflight = quoteMonetaryPayment(state, from, due, content, options);
    if (!preflight.full) {
      return { ok: false, reason: "粮券不足", paidValueUnits: 0, voucherPaidValueUnits: 0, wheatPaidValueUnits: 0,
        remainingValueUnits: due.valueUnits, remainingComposition: due,
        voucherShortfallValueUnits: preflight.voucherShortfallValueUnits || 0 };
    }
  }
  // 付款顺序：手头粮券 → 存款取回（银行现金不足由镇库垫付）→ 以粮换券（镇库券池封顶）。
  const beforeVoucher = voucherBalance(state, from);
  withdrawDepositsForPayment(state, from, Math.max(0, due.valueUnits - beforeVoucher), content);
  autoExchangeForPayment(state, from, Math.max(0, due.valueUnits - voucherBalance(state, from)), content, options);
  const voucherPaid = Math.min(due.valueUnits, voucherBalance(state, from));
  const remaining = due.valueUnits - voucherPaid;
  if (options.requireFull !== false && remaining > 0) {
    return { ok: false, reason: "粮券不足", paidValueUnits: 0, voucherPaidValueUnits: 0, wheatPaidValueUnits: 0,
      remainingValueUnits: due.valueUnits, remainingComposition: due, voucherShortfallValueUnits: remaining };
  }
  const transactionId = makeTransactionId(state);
  if (voucherPaid > 0) {
    const voucher = transferVouchers(state, from, to, voucherPaid, content, type, `${reason}；粮券部分`, { transactionId });
    if (!voucher.ok) throw new Error("粮券支付预检后失败：" + voucher.reason);
  }
  return {
    ok: remaining === 0,
    reason: remaining > 0 ? "仅完成部分支付" : null,
    transactionId,
    paidValueUnits: voucherPaid,
    voucherPaidValueUnits: voucherPaid,
    wheatPaidValueUnits: 0,
    wheatPaidUnits: 0,
    remainingValueUnits: remaining,
    voucherShortfallValueUnits: remaining,
    remainingComposition: voucherOnlyObligation(remaining)
  };
}
