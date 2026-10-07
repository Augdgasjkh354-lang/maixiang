import { currencyScale, ensureCurrencyState, voucherBalance } from "../economy/currency.js";
import { recordEvent } from "../economy/ledger.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { wholesalePrice } from "./wealth-stats.js";
import { bankLoanableVoucherUnits, bankPolicy, ensureBankState } from "./bank.js";
import { liquidityInvestRatio } from "./liquidity.js";

// 国债系统（金融扩展第三期）：镇库发行，拍卖定价。
// - 认购期7天；认购踊跃则票面利率下调，认购不足则上浮；不足3成流拍退款
// - 购买方：住户（存款后剩余闲钱）、银行（闲置可贷额度）；票面须高于存款利率才有人买
// - 每年付息，到期还本；镇库没钱先展期（最多2次，利率+1%），再还不上违约（持有者血本无归，信用惩罚+2%）
export const BOND_SUBSCRIBE_DAYS = 7;
export const BOND_MIN_SUBSCRIBE_RATIO = 0.3;
export const BOND_HOT_RATIO = 1.5;
export const BOND_RATE_STEP_PERCENT = 1;
export const BOND_MAX_EXTENSIONS = 2;
export const BOND_DEFAULT_PENALTY_BPS = 200;

export function ensureBondState(state) {
  state.bonds ||= {};
  const bonds = state.bonds;
  bonds.seq ||= 0;
  if (!Array.isArray(bonds.issues)) bonds.issues = [];
  bonds.creditPenaltyBps ||= 0;
  bonds.townOwesBankVoucherUnits ||= 0;
  return bonds;
}

export function bondAvailable(state) {
  return state.monetaryReform?.stage === "voucher";
}

function townCashUnits(state) {
  return voucherBalance(state, "town");
}

function addTownCashUnits(state, units) {
  const currency = ensureCurrencyState(state);
  currency.balances.town = (currency.balances.town || 0) + units;
}

function holderKeyOf(kind, id) {
  return `${kind}:${id}`;
}

function payToHolder(state, holderKey, units, content = null) {
  const [kind, id] = holderKey.split(":");
  if (kind === "household") {
    const household = state.households?.byId?.[id];
    if (household) {
      household.voucherUnits = (household.voucherUnits || 0) + units;
      // 居民汇总粮券是缓存值：改动家庭券后必须同步，否则粮券总账守恒校验失败。
      if (content) syncResidentAggregates(state, content);
    }
  } else if (kind === "bank") {
    const bank = ensureBankState(state);
    bank.cashVoucherUnits = (bank.cashVoucherUnits || 0) + units;
  }
}

export function bondOutstandingVoucherUnits(state) {
  // 只读查询：选择器（dashboard/policy 面板）会调用它，绝不能在此初始化 state.bonds，
  // 否则违反"selector 只读不写"，首次渲染就会给 state 写入新字段。
  const bonds = state.bonds;
  if (!bonds || !Array.isArray(bonds.issues)) return 0;
  let total = 0;
  for (const issue of bonds.issues) {
    if (issue.status !== "active") continue;
    for (const holding of issue.holdings || []) total += holding.principalVoucherUnits || 0;
  }
  return total;
}

export function issueGovernmentBond(state, options, content) {
  if (!bondAvailable(state)) return { ok: false, reason: "需完成货币改革（粮券阶段）才能发行国债" };
  const scale = currencyScale(content);
  const totalVoucher = Number(options?.totalVoucher);
  const totalUnits = Math.round(totalVoucher * scale);
  const termYears = Math.floor(Number(options?.termYears) || 0);
  const startRate = Number(options?.startRateAnnualPercent);
  if (!Number.isFinite(totalVoucher) || totalVoucher <= 0 || !Number.isSafeInteger(totalUnits) || totalUnits <= 0) {
    return { ok: false, reason: "发行总额必须为正数（券）" };
  }
  if (!Number.isSafeInteger(termYears) || termYears < 1 || termYears > 10) return { ok: false, reason: "期限须为1—10年" };
  if (!Number.isFinite(startRate) || startRate < 0 || startRate > 20) return { ok: false, reason: "起拍票面年利率须在0—20%之间" };
  const bonds = ensureBondState(state);
  if (bonds.issues.some(issue => issue.status === "subscribing")) {
    return { ok: false, reason: "已有国债正在认购，暂勿重复发行" };
  }
  const daysPerYear = content.rules.daysPerYear || 360;
  bonds.seq += 1;
  const issue = {
    id: `GB${bonds.seq}`,
    totalVoucherUnits: totalUnits,
    subscribedVoucherUnits: 0,
    subscriptions: {},
    holdings: [],
    termDays: termYears * daysPerYear,
    startRateAnnualPercent: startRate,
    couponRateAnnualPercent: startRate,
    status: "subscribing",
    issuedDayIndex: (state.year - 1) * daysPerYear + state.day,
    lastCouponDayIndex: (state.year - 1) * daysPerYear + state.day,
    extensions: 0,
    stats: { couponPaidVoucherUnits: 0, principalRepaidVoucherUnits: 0 }
  };
  bonds.issues.push(issue);
  recordEvent(state, `镇库发行国债${issue.id}：总额${totalVoucher}券，${termYears}年期，起拍票面年利率${startRate}%，认购期${BOND_SUBSCRIBE_DAYS}天。`, content);
  return { ok: true, issue };
}

export function subscribeBond(state, issueId, holderKind, holderId, voucherUnits, content) {
  const bonds = ensureBondState(state);
  const issue = bonds.issues.find(row => row.id === issueId);
  if (!issue || issue.status !== "subscribing") return { ok: false, reason: "该国债不在认购期" };
  const units = Math.floor(Number(voucherUnits) || 0);
  if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, reason: "认购金额必须为正整数" };
  const key = holderKeyOf(holderKind, holderId);
  if (holderKind === "household") {
    const household = state.households?.byId?.[holderId];
    if (!household || !isActiveHousehold(household)) return { ok: false, reason: "住户不存在或已迁出" };
    if ((household.voucherUnits || 0) < units) return { ok: false, reason: "住户粮券不足" };
    household.voucherUnits -= units;
    // 居民汇总粮券是缓存值：改动家庭券后必须同步，否则粮券总账守恒校验失败。
    syncResidentAggregates(state, content);
  } else if (holderKind === "bank") {
    const bank = ensureBankState(state);
    if ((bank.cashVoucherUnits || 0) < units) return { ok: false, reason: "银行现金不足" };
    bank.cashVoucherUnits -= units;
  } else {
    return { ok: false, reason: "未知认购方" };
  }
  addTownCashUnits(state, units);
  issue.subscriptions[key] = (issue.subscriptions[key] || 0) + units;
  issue.subscribedVoucherUnits += units;
  return { ok: true, issueId, holderKey: key, voucherUnits: units };
}

// 流拍退款：认购款已进镇库，但认购期内镇库可能已把钱花出去。
// 镇库现金只够退多少就退多少，退不出的部分挂为家庭对镇库的持久应收
// （household.townOwesVoucherUnits，与开店失败垫付同一机制，每日由 shops 结算优先偿付），
// 绝不把镇库余额扣成负数。
function refundSubscription(state, issue, content) {
  for (const [key, units] of Object.entries(issue.subscriptions)) {
    if (!(units > 0)) continue;
    const townCash = Math.max(0, townCashUnits(state));
    const refundable = Math.min(units, townCash);
    if (refundable > 0) {
      addTownCashUnits(state, -refundable);
      payToHolder(state, key, refundable, content);
    }
    const shortfall = units - refundable;
    if (shortfall > 0) {
      if (key.startsWith("household:")) {
        const household = state.households?.byId?.[key.slice(10)];
        if (household) {
          household.townOwesVoucherUnits ||= 0;
          household.townOwesVoucherUnits += shortfall;
        }
      } else {
        // 银行认购退不出：同样挂为镇库对银行的应付款，日结算时优先补付。
        state.bonds.townOwesBankVoucherUnits = (state.bonds.townOwesBankVoucherUnits || 0) + shortfall;
      }
      recordEvent(state, `国债${issue.id}流拍退款：镇库现金不足，${shortfall}券暂记为应付，日后优先偿付。`, content);
    }
  }
  issue.subscriptions = {};
  issue.subscribedVoucherUnits = 0;
}

function finalizeSubscription(state, issue, content) {
  const bonds = ensureBondState(state);
  const ratio = issue.subscribedVoucherUnits / issue.totalVoucherUnits;
  if (ratio < BOND_MIN_SUBSCRIBE_RATIO) {
    refundSubscription(state, issue, content);
    issue.status = "failed";
    recordEvent(state, `国债${issue.id}认购不足（${Math.round(ratio * 100)}%），流拍，已退款。`, content);
    return;
  }
  let rate = issue.startRateAnnualPercent + bonds.creditPenaltyBps / 100;
  if (ratio >= BOND_HOT_RATIO) rate = Math.max(0.5, rate - BOND_RATE_STEP_PERCENT);
  else if (ratio < 1) rate += BOND_RATE_STEP_PERCENT * 2;
  issue.couponRateAnnualPercent = Math.round(rate * 100) / 100;
  issue.totalVoucherUnits = issue.subscribedVoucherUnits;
  issue.holdings = Object.entries(issue.subscriptions)
    .filter(([, units]) => units > 0)
    .map(([holderKey, units]) => ({ holderKey, principalVoucherUnits: units }));
  issue.subscriptions = {};
  issue.status = "active";
  recordEvent(state, `国债${issue.id}发行成功：认购${Math.round(ratio * 100)}%，票面年利率${issue.couponRateAnnualPercent}%。`, content);
}

function autoSubscribe(state, issue, content) {
  const remaining = issue.totalVoucherUnits - issue.subscribedVoucherUnits;
  if (remaining <= 0) return;
  const scale = currencyScale(content);
  const depositRate = bankPolicy(state).depositRateAnnualPercent;
  // 票面不高于存款利率时无人问津（收益阶梯）
  if (issue.startRateAnnualPercent > depositRate) {
    const wheatPricePerJin = wholesalePrice(state, "wheat", content) || 0;
    for (const household of householdList(state)) {
      if (!isActiveHousehold(household)) continue;
      const pop = householdPopulation(household);
      if (!(pop > 0) || !(wheatPricePerJin > 0)) continue;
      // 银行吸储后的剩余闲钱，按流动性投资比例的一半认购（五期算法自动调整）
      const investRatio = liquidityInvestRatio(state, content);
      const reserveUnits = Math.ceil(pop * 2 * 30 * wheatPricePerJin * scale);
      const surplus = (household.voucherUnits || 0) - reserveUnits;
      if (surplus <= 0) continue;
      const left = issue.totalVoucherUnits - issue.subscribedVoucherUnits;
      const amount = Math.min(Math.floor(surplus * investRatio * 0.5), left);
      if (amount > 0) subscribeBond(state, issue.id, "household", household.id, amount, content);
    }
  }
  // 银行：闲置可贷额度的一半认购
  const left = issue.totalVoucherUnits - issue.subscribedVoucherUnits;
  if (left > 0 && issue.startRateAnnualPercent > 0) {
    const loanable = bankLoanableVoucherUnits(state);
    const amount = Math.min(Math.floor(loanable * 0.5), left);
    if (amount > 0) subscribeBond(state, issue.id, "bank", "bank", amount, content);
  }
}

function payCoupon(state, issue, content) {
  let totalDue = 0;
  for (const holding of issue.holdings) {
    totalDue += Math.floor((holding.principalVoucherUnits || 0) * issue.couponRateAnnualPercent / 100);
  }
  if (totalDue <= 0) return;
  let cash = townCashUnits(state);
  const pay = Math.min(cash, totalDue);
  if (pay > 0) {
    addTownCashUnits(state, -pay);
    // 按持有比例分摊
    let distributed = 0;
    let topHolding = null;
    let topDue = -1;
    for (const holding of issue.holdings) {
      const due = Math.floor((holding.principalVoucherUnits || 0) * issue.couponRateAnnualPercent / 100);
      if (due > topDue) { topDue = due; topHolding = holding; }
      const part = totalDue > 0 ? Math.floor(pay * due / totalDue) : 0;
      if (part > 0) {
        payToHolder(state, holding.holderKey, part, content);
        distributed += part;
      }
    }
    // floor 分摊的余数补给最大持有人：镇库已全额扣款，余数凭空销毁会打破货币守恒。
    const leftover = pay - distributed;
    if (leftover > 0 && topHolding) {
      payToHolder(state, topHolding.holderKey, leftover, content);
      distributed += leftover;
    }
    issue.stats.couponPaidVoucherUnits += distributed;
  }
  if (pay < totalDue) {
    issue.couponRateAnnualPercent = Math.round((issue.couponRateAnnualPercent + 0.5) * 100) / 100;
    recordEvent(state, `镇库无力足额支付国债${issue.id}利息，票面利率上浮至${issue.couponRateAnnualPercent}%以安抚持有者。`, content);
  }
}

function settleMaturity(state, issue, content) {
  let cash = townCashUnits(state);
  for (const holding of issue.holdings) {
    if (cash <= 0) break;
    const pay = Math.min(cash, holding.principalVoucherUnits || 0);
    if (pay > 0) {
      addTownCashUnits(state, -pay);
      payToHolder(state, holding.holderKey, pay, content);
      cash -= pay;
      holding.principalVoucherUnits -= pay;
      issue.stats.principalRepaidVoucherUnits += pay;
    }
  }
  issue.holdings = issue.holdings.filter(holding => (holding.principalVoucherUnits || 0) > 0);
  if (issue.holdings.length === 0) {
    issue.status = "matured";
    recordEvent(state, `国债${issue.id}到期，已全额还本。`, content);
    return;
  }
  if (issue.extensions < BOND_MAX_EXTENSIONS) {
    issue.extensions += 1;
    issue.termDays += 360;
    issue.couponRateAnnualPercent = Math.round((issue.couponRateAnnualPercent + 1) * 100) / 100;
    recordEvent(state, `镇库现金不足，国债${issue.id}展期1年（第${issue.extensions}次），票面利率上浮至${issue.couponRateAnnualPercent}%。`, content);
    return;
  }
  // 违约：剩余持有者血本无归
  issue.holdings = [];
  issue.status = "defaulted";
  const bonds = ensureBondState(state);
  bonds.creditPenaltyBps += BOND_DEFAULT_PENALTY_BPS;
  recordEvent(state, `国债${issue.id}违约！镇库无力偿还，持有者血本无归；镇库信用受损，今后发债利率上浮${BOND_DEFAULT_PENALTY_BPS / 100}%。`, content);
}

// 提前赎回：拿回本金 + 持有期应计利息的 50%（API；界面后续接）
export function redeemBondEarly(state, issueId, holderKey, content) {
  const bonds = ensureBondState(state);
  const issue = bonds.issues.find(row => row.id === issueId);
  if (!issue || issue.status !== "active") return { ok: false, reason: "该国债不在存续期" };
  const holding = (issue.holdings || []).find(row => row.holderKey === holderKey);
  if (!holding || !(holding.principalVoucherUnits > 0)) return { ok: false, reason: "未持有该国债" };
  const daysPerYear = content.rules.daysPerYear || 360;
  const dayIndex = (state.year - 1) * daysPerYear + state.day;
  const heldDays = Math.max(0, dayIndex - Math.max(issue.lastCouponDayIndex, issue.issuedDayIndex));
  const accrued = Math.floor(holding.principalVoucherUnits * issue.couponRateAnnualPercent / 100 * heldDays / daysPerYear * 0.5);
  const total = holding.principalVoucherUnits + accrued;
  if (townCashUnits(state) < total) return { ok: false, reason: "镇库现金不足，暂无法赎回" };
  addTownCashUnits(state, -total);
  payToHolder(state, holderKey, total, content);
  issue.holdings = issue.holdings.filter(row => row !== holding);
  return { ok: true, principalVoucherUnits: holding.principalVoucherUnits, interestVoucherUnits: accrued };
}

// 流拍退款挂账的镇库应付：每日用镇库现有现金尽量补付给银行，绝不透支。
function settleTownBondPayables(state, bonds, content) {
  const owed = bonds.townOwesBankVoucherUnits || 0;
  if (owed <= 0) return;
  const pay = Math.min(owed, Math.max(0, townCashUnits(state)));
  if (pay <= 0) return;
  addTownCashUnits(state, -pay);
  const bank = ensureBankState(state);
  bank.cashVoucherUnits = (bank.cashVoucherUnits || 0) + pay;
  bonds.townOwesBankVoucherUnits = owed - pay;
  recordEvent(state, `镇库补付国债流拍退款${pay}券给银行。`, content);
}

export function settleBondsDay(state, content) {
  if (!bondAvailable(state)) return null;
  const bonds = ensureBondState(state);
  const daysPerYear = content.rules.daysPerYear || 360;
  const dayIndex = (state.year - 1) * daysPerYear + state.day;
  // 镇库欠银行/住户的流拍退款：镇库有钱就优先补付（家庭侧由 shops 结算的 townOwes 一并处理）。
  settleTownBondPayables(state, bonds, content);
  for (const issue of bonds.issues) {
    if (issue.status === "subscribing") {
      autoSubscribe(state, issue, content);
      if (dayIndex >= issue.issuedDayIndex + BOND_SUBSCRIBE_DAYS) finalizeSubscription(state, issue, content);
    } else if (issue.status === "active") {
      if (dayIndex - issue.lastCouponDayIndex >= daysPerYear) {
        payCoupon(state, issue, content);
        issue.lastCouponDayIndex = dayIndex;
      }
      if (dayIndex >= issue.issuedDayIndex + issue.termDays) settleMaturity(state, issue, content);
    }
  }
  return { issues: bonds.issues.length, outstandingVoucherUnits: bondOutstandingVoucherUnits(state) };
}
