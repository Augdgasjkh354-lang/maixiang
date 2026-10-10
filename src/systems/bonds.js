import { currencyScale, ensureCurrencyState, voucherBalance } from "../economy/currency.js";
import { recordEvent } from "../economy/ledger.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { wholesalePrice } from "./wealth-stats.js";
import { bankLoanableVoucherUnits, bankPolicy, ensureBankState } from "./bank.js";
import { liquidityInvestRatio } from "./liquidity.js";

// 国债：镇库按玩家定的固定票面利率发行，发行当天由住户（存款后剩余闲钱）与银行（闲置可贷额度）
// 直接认购，卖出多少算多少；票面须高于存款利率住户才会买。每年付息、到期还本，
// 镇库没钱先展期（最多2次，利率不变），再还不上则违约（持有者血本无归）。
export const BOND_MAX_EXTENSIONS = 2;

export function ensureBondState(state) {
  state.bonds ||= {};
  const bonds = state.bonds;
  bonds.seq ||= 0;
  if (!Array.isArray(bonds.issues)) bonds.issues = [];
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

// incomeUnits：其中属于利息收入的部分（银行持券时计入留存利润，本金回收不计）。
function payToHolder(state, holderKey, units, content = null, incomeUnits = 0) {
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
    bank.retainedVoucherUnits += incomeUnits;
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

// 只读：存续期国债中各住户持有的本金（内部单位），Map<householdId, units>。
// 富人税与遗产税的征税口径、贫富统计都用它；不计银行持有的部分。选择器会调用，绝不写 state。
export function householdBondPrincipalMap(state) {
  const map = new Map();
  const issues = state.bonds?.issues;
  if (!Array.isArray(issues)) return map;
  for (const issue of issues) {
    if (issue.status !== "active") continue;
    for (const holding of issue.holdings || []) {
      const key = String(holding.holderKey || "");
      if (!key.startsWith("household:")) continue;
      const id = key.slice("household:".length);
      const units = Math.max(0, holding.principalVoucherUnits || 0);
      if (units > 0) map.set(id, (map.get(id) || 0) + units);
    }
  }
  return map;
}

export function issueGovernmentBond(state, options, content) {
  if (!bondAvailable(state)) return { ok: false, reason: "需完成货币改革（粮券阶段）才能发行国债" };
  const scale = currencyScale(content);
  const totalVoucher = Number(options?.totalVoucher);
  const totalUnits = Math.round(totalVoucher * scale);
  const termYears = Math.floor(Number(options?.termYears) || 0);
  const rate = Number(options?.rateAnnualPercent ?? options?.startRateAnnualPercent);
  if (!Number.isFinite(totalVoucher) || totalVoucher <= 0 || !Number.isSafeInteger(totalUnits) || totalUnits <= 0) {
    return { ok: false, reason: "发行总额必须为正数（券）" };
  }
  if (!Number.isSafeInteger(termYears) || termYears < 1 || termYears > 10) return { ok: false, reason: "期限须为1—10年" };
  if (!Number.isFinite(rate) || rate < 0 || rate > 20) return { ok: false, reason: "票面年利率须在0—20%之间" };
  const bonds = ensureBondState(state);
  const daysPerYear = content.rules.daysPerYear || 360;
  const dayIndex = (state.year - 1) * daysPerYear + state.day;
  const issue = {
    id: `GB${bonds.seq + 1}`,
    totalVoucherUnits: totalUnits,
    subscribedVoucherUnits: 0,
    subscriptions: {},
    holdings: [],
    termDays: termYears * daysPerYear,
    couponRateAnnualPercent: rate,
    status: "active",
    issuedDayIndex: dayIndex,
    lastCouponDayIndex: dayIndex,
    extensions: 0,
    stats: { couponPaidVoucherUnits: 0, principalRepaidVoucherUnits: 0 }
  };
  bonds.issues.push(issue);
  autoSubscribe(state, issue, content);
  if (issue.subscribedVoucherUnits <= 0) {
    bonds.issues.pop();
    return { ok: false, reason: "无人认购：票面利率需高于存款利率，且住户或银行要有闲钱" };
  }
  bonds.seq += 1;
  issue.totalVoucherUnits = issue.subscribedVoucherUnits;
  issue.holdings = Object.entries(issue.subscriptions).map(([holderKey, units]) => ({ holderKey, principalVoucherUnits: units }));
  issue.subscriptions = {};
  const soldVoucher = issue.totalVoucherUnits / scale;
  recordEvent(state, `镇库发行国债${issue.id}：售出${soldVoucher}券（计划${totalVoucher}券），${termYears}年期，票面年利率${rate}%。`, content);
  return { ok: true, issue, soldVoucher };
}

export function subscribeBond(state, issueId, holderKind, holderId, voucherUnits, content) {
  const bonds = ensureBondState(state);
  const issue = bonds.issues.find(row => row.id === issueId);
  if (!issue) return { ok: false, reason: "国债不存在" };
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

function autoSubscribe(state, issue, content) {
  const remaining = issue.totalVoucherUnits - issue.subscribedVoucherUnits;
  if (remaining <= 0) return;
  const scale = currencyScale(content);
  const depositRate = bankPolicy(state).depositRateAnnualPercent;
  // 票面不高于存款利率时无人问津（收益阶梯）
  if (issue.couponRateAnnualPercent > depositRate) {
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
  if (left > 0 && issue.couponRateAnnualPercent > 0) {
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
        payToHolder(state, holding.holderKey, part, content, part);
        distributed += part;
      }
    }
    // floor 分摊的余数补给最大持有人：镇库已全额扣款，余数凭空销毁会打破货币守恒。
    const leftover = pay - distributed;
    if (leftover > 0 && topHolding) {
      payToHolder(state, topHolding.holderKey, leftover, content, leftover);
      distributed += leftover;
    }
    issue.stats.couponPaidVoucherUnits += distributed;
  }
  if (pay < totalDue) recordEvent(state, `镇库无力足额支付国债${issue.id}利息，少付${totalDue - pay}券。`, content);
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
    issue.termDays += content.rules.daysPerYear || 360;
    recordEvent(state, `镇库现金不足，国债${issue.id}展期1年（第${issue.extensions}次）。`, content);
    return;
  }
  // 违约：剩余持有者血本无归。银行持有的本金随之消失，留存利润等额减少。
  const bankLoss = (issue.holdings || []).filter(holding => holding.holderKey === "bank:bank")
    .reduce((sum, holding) => sum + (holding.principalVoucherUnits || 0), 0);
  if (bankLoss > 0) ensureBankState(state).retainedVoucherUnits -= bankLoss;
  issue.holdings = [];
  issue.status = "defaulted";
  recordEvent(state, `国债${issue.id}违约！镇库无力偿还，持有者血本无归。`, content);
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
  payToHolder(state, holderKey, total, content, accrued);
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
    if (issue.status === "active") {
      if (dayIndex - issue.lastCouponDayIndex >= daysPerYear) {
        payCoupon(state, issue, content);
        issue.lastCouponDayIndex = dayIndex;
      }
      if (dayIndex >= issue.issuedDayIndex + issue.termDays) settleMaturity(state, issue, content);
    }
  }
  return { issues: bonds.issues.length, outstandingVoucherUnits: bondOutstandingVoucherUnits(state) };
}

