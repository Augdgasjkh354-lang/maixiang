import { currencyScale, voucherBalance } from "../economy/currency.js";
import { recordEvent } from "../economy/ledger.js";
import { currentPaymentComposition, settleMonetaryPayment } from "../economy/payment.js";
import { withdrawFromBank } from "../economy/deposits.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { wholesalePrice } from "./wealth-stats.js";
import { companyWorkingCapitalReserve } from "./companies.js";
import { ensureHouseholdInvestPropensity, householdInvestableVoucherUnits, HOUSEHOLD_RESERVE_DAYS } from "./investment-preference.js";

// 银行系统（金融扩展第二期）：镇营银行。
// - 只存粮券不存粮食；存款按日计息；可向上市公司放贷
// - 存款利息由镇库付现金（付款类型 bank_deposit_interest）：每笔计息都有等额粮券进入银行现金；
//   镇库现金不够时只计实付部分，绝不透支记账
// - 准备金率限制可贷额度；存贷利差等银行利润记入 bank.retainedVoucherUnits 留存，不自动上缴镇库
// - 粮券恒等式：银行现金计入 totalVoucherBalances（currency.js）。存款台账的守恒关系是
//   存款 = 银行现金 + 在贷余额 + 持有国债 − 留存利润（bankLedgerInvariant，validateState 校验）。
export const DEFAULT_DEPOSIT_RATE_ANNUAL_PERCENT = 2;
export const DEFAULT_LOAN_RATE_ANNUAL_PERCENT = 6;
export const DEFAULT_RESERVE_REQUIREMENT_PERCENT = 10;
// 投资比例改由流动性算法按日自动调整（五期），见 liquidity.js。
// 生活储备天数与 investment-preference.js 共用同一常量，避免分流口径漂移。
export const BANK_HOUSEHOLD_RESERVE_DAYS = HOUSEHOLD_RESERVE_DAYS;
export const BANK_LOAN_TERM_DAYS = 90;
export const BANK_LOAN_WRITEOFF_OVERDUE_DAYS = 30;

export function bankPolicy(state) {
  state.policy ||= {};
  const policy = state.policy.bank ||= {};
  policy.depositRateAnnualPercent ??= DEFAULT_DEPOSIT_RATE_ANNUAL_PERCENT;
  policy.loanRateAnnualPercent ??= DEFAULT_LOAN_RATE_ANNUAL_PERCENT;
  policy.reserveRequirementPercent ??= DEFAULT_RESERVE_REQUIREMENT_PERCENT;
  return policy;
}

export function setBankPolicy(state, patch) {
  const policy = bankPolicy(state);
  if (patch.depositRateAnnualPercent !== undefined) {
    const value = Number(patch.depositRateAnnualPercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, reason: "存款年利率须在0—100%之间" };
    policy.depositRateAnnualPercent = value;
  }
  if (patch.loanRateAnnualPercent !== undefined) {
    const value = Number(patch.loanRateAnnualPercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, reason: "贷款年利率须在0—100%之间" };
    policy.loanRateAnnualPercent = value;
  }
  if (patch.reserveRequirementPercent !== undefined) {
    const value = Number(patch.reserveRequirementPercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, reason: "准备金率须在0—100%之间" };
    policy.reserveRequirementPercent = value;
  }
  return { ok: true, policy: { ...policy } };
}

export function ensureBankState(state) {
  state.bank ||= {};
  const bank = state.bank;
  bank.cashVoucherUnits ||= 0;
  bank.deposits ||= {};
  if (!Array.isArray(bank.loans)) bank.loans = [];
  bank.seq ||= 0;
  bank.stats ||= {};
  const stats = bank.stats;
  stats.depositsCount ||= 0;
  stats.interestPaidVoucherUnits ||= 0;
  stats.interestEarnedVoucherUnits ||= 0;
  stats.loansIssuedCount ||= 0;
  stats.loansIssuedVoucherUnits ||= 0;
  stats.loansRepaidVoucherUnits ||= 0;
  stats.badDebtVoucherUnits ||= 0;
  if (!Number.isSafeInteger(bank.retainedVoucherUnits)) bank.retainedVoucherUnits = bankRetainedVoucherUnits(state);
  return bank;
}

// 银行资产：现金 + 在贷余额（含应计利息）+ 持有的国债本金。只读。
function bankAssetVoucherUnits(state) {
  const bank = state.bank || {};
  let assets = bank.cashVoucherUnits || 0;
  for (const loan of bank.loans || []) if (loan.status === "active") assets += loan.outstandingVoucherUnits || 0;
  for (const issue of state.bonds?.issues || []) {
    for (const holding of issue.holdings || []) if (holding.holderKey === "bank:bank") assets += holding.principalVoucherUnits || 0;
  }
  return assets;
}

function bankDepositTotalVoucherUnits(state) {
  let total = 0;
  for (const units of Object.values(state.bank?.deposits || {})) total += units || 0;
  return total;
}

// 银行留存利润（可为负）：贷款利息应计 − 坏账核销 + 国债利息收入 − 国债违约损失。
// 旧存档没有这个字段：此时按"资产 − 存款"反推。旧版存款利息只记台账不付现金，
// 反推出的负数正是这部分无现金支撑的利息，存款人余额保持不变。
export function bankRetainedVoucherUnits(state) {
  const bank = state.bank || {};
  if (Number.isSafeInteger(bank.retainedVoucherUnits)) return bank.retainedVoucherUnits;
  return bankAssetVoucherUnits(state) - bankDepositTotalVoucherUnits(state);
}

// 存款台账守恒（只读）：存款 = 现金 + 在贷余额 + 国债本金 − 留存利润。
export function bankLedgerInvariant(state) {
  const bank = state.bank || {};
  const deposits = bankDepositTotalVoucherUnits(state);
  const cash = bank.cashVoucherUnits || 0;
  let loans = 0;
  for (const loan of bank.loans || []) if (loan.status === "active") loans += loan.outstandingVoucherUnits || 0;
  let bonds = 0;
  for (const issue of state.bonds?.issues || []) {
    for (const holding of issue.holdings || []) if (holding.holderKey === "bank:bank") bonds += holding.principalVoucherUnits || 0;
  }
  const retained = bankRetainedVoucherUnits(state);
  return { deposits, cash, loans, bonds, retained, valid: deposits === cash + loans + bonds - retained };
}

export function bankAvailable(state) {
  const reform = state.monetaryReform || {};
  const hasBank = Boolean(reform.legacyBankAccess) || (state.buildings || []).some(row => row.typeId === "bank");
  return hasBank && reform.stage === "voucher";
}

export function bankTotals(state) {
  const bank = ensureBankState(state);
  let totalDeposits = 0;
  for (const units of Object.values(bank.deposits)) totalDeposits += units || 0;
  let outstandingLoans = 0;
  for (const loan of bank.loans) {
    if (loan.status === "active") outstandingLoans += loan.outstandingVoucherUnits || 0;
  }
  return {
    totalDepositsVoucherUnits: totalDeposits,
    outstandingLoansVoucherUnits: outstandingLoans,
    cashVoucherUnits: bank.cashVoucherUnits || 0
  };
}

// 可贷额度 = 银行现金 - 法定准备金（存款×准备金率）
export function bankLoanableVoucherUnits(state) {
  const policy = bankPolicy(state);
  const totals = bankTotals(state);
  const required = Math.floor(totals.totalDepositsVoucherUnits * (policy.reserveRequirementPercent / 100));
  return Math.max(0, totals.cashVoucherUnits - required);
}

export function depositToBank(state, householdId, voucherUnits, content = null) {
  if (!bankAvailable(state)) return { ok: false, reason: "银行尚未可用（需建成银行并完成货币改革）" };
  const units = Math.floor(Number(voucherUnits) || 0);
  if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, reason: "存款金额必须为正整数" };
  const household = state.households?.byId?.[householdId];
  if (!household || !isActiveHousehold(household)) return { ok: false, reason: "住户不存在或已迁出" };
  if ((household.voucherUnits || 0) < units) return { ok: false, reason: "住户粮券不足" };
  const bank = ensureBankState(state);
  household.voucherUnits -= units;
  bank.cashVoucherUnits += units;
  bank.deposits[householdId] = (bank.deposits[householdId] || 0) + units;
  bank.stats.depositsCount += 1;
  // 居民汇总粮券是缓存值，改动家庭券后必须同步，否则粮券总账守恒校验失败。
  if (content) syncResidentAggregates(state, content);
  return { ok: true, householdId, voucherUnits: units };
}

// 取款原语定义在 economy/deposits.js（避免 payment.js ↔ bank.js 循环引用），这里重新导出。
export { withdrawFromBank };

function borrowerCashUnits(state, loan) {
  if (loan.borrowerKind === "company") return state.companies?.[loan.borrowerId]?.cashVoucherUnits || 0;
  return 0;
}

function setBorrowerCashUnits(state, loan, units) {
  if (loan.borrowerKind === "company" && state.companies?.[loan.borrowerId]) {
    state.companies[loan.borrowerId].cashVoucherUnits = units;
  }
}

function borrowerName(state, loan) {
  if (loan.borrowerKind === "company") return state.companies?.[loan.borrowerId]?.name || "未知公司";
  return "未知";
}

export function issueBankLoan(state, borrowerKind, borrowerId, voucherUnits, content, termDays = BANK_LOAN_TERM_DAYS) {
  if (!bankAvailable(state)) return { ok: false, reason: "银行尚未可用" };
  const units = Math.floor(Number(voucherUnits) || 0);
  if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, reason: "贷款金额必须为正整数" };
  if (borrowerKind !== "company" || !state.companies?.[borrowerId]) return { ok: false, reason: "当前仅支持向上市公司放贷" };
  const loanable = bankLoanableVoucherUnits(state);
  if (loanable < units) return { ok: false, reason: `可贷额度不足（剩${loanable}）` };
  const bank = ensureBankState(state);
  const daysPerYear = content.rules.daysPerYear || 360;
  const dayIndex = (state.year - 1) * daysPerYear + state.day;
  bank.seq += 1;
  const loan = {
    id: `BL${bank.seq}`,
    borrowerKind,
    borrowerId,
    principalVoucherUnits: units,
    outstandingVoucherUnits: units,
    accruedInterestVoucherUnits: 0,
    repaidVoucherUnits: 0,
    rateAnnualPercent: bankPolicy(state).loanRateAnnualPercent,
    termDays,
    issuedDayIndex: dayIndex,
    overdueDays: 0,
    status: "active"
  };
  bank.cashVoucherUnits -= units;
  setBorrowerCashUnits(state, loan, borrowerCashUnits(state, loan) + units);
  bank.loans.push(loan);
  bank.stats.loansIssuedCount += 1;
  bank.stats.loansIssuedVoucherUnits += units;
  recordEvent(state, `银行向${borrowerName(state, loan)}发放贷款${units}券，期限${termDays}天。`, content);
  return { ok: true, loan };
}

function settleBankLoansDay(state, content, bank, policy, dayIndex) {
  const daysPerYear = content.rules.daysPerYear || 360;
  const dailyLoanRate = policy.loanRateAnnualPercent / 100 / daysPerYear;
  for (const loan of bank.loans) {
    if (loan.status !== "active") continue;
    const interest = Math.floor((loan.outstandingVoucherUnits || 0) * dailyLoanRate);
    if (interest > 0) {
      loan.outstandingVoucherUnits += interest;
      loan.accruedInterestVoucherUnits += interest;
      // 应计利息是银行收入（资产增加、无人付现金）：计入留存利润，保证台账守恒。
      bank.retainedVoucherUnits += interest;
    }
    if (dayIndex < loan.issuedDayIndex + loan.termDays) continue;
    // 到期：从借款方现金自动扣款
    const cash = borrowerCashUnits(state, loan);
    const pay = Math.min(cash, loan.outstandingVoucherUnits);
    if (pay > 0) {
      setBorrowerCashUnits(state, loan, cash - pay);
      bank.cashVoucherUnits += pay;
      loan.outstandingVoucherUnits -= pay;
      loan.repaidVoucherUnits += pay;
      bank.stats.loansRepaidVoucherUnits += pay;
      // 还款先冲利息再冲本金
      const interestPart = Math.min(pay, loan.accruedInterestVoucherUnits);
      loan.accruedInterestVoucherUnits -= interestPart;
      bank.stats.interestEarnedVoucherUnits += interestPart;
    }
    if (loan.outstandingVoucherUnits <= 0) {
      loan.status = "repaid";
      recordEvent(state, `银行贷款${loan.id}（${borrowerName(state, loan)}）已还清。`, content);
    } else {
      loan.overdueDays += 1;
      if (loan.overdueDays > BANK_LOAN_WRITEOFF_OVERDUE_DAYS) {
        loan.status = "written_off";
        bank.stats.badDebtVoucherUnits += loan.outstandingVoucherUnits;
        // 核销：资产消失、无现金进账，留存利润等额减少。
        bank.retainedVoucherUnits -= loan.outstandingVoucherUnits;
        recordEvent(state, `银行贷款${loan.id}（${borrowerName(state, loan)}）逾期${loan.overdueDays}天，${loan.outstandingVoucherUnits}券核销为坏账。`, content);
        loan.outstandingVoucherUnits = 0;
      }
    }
  }
}

// 存款利息：镇库付现金给银行，银行同时计入存款台账（一笔计息对应一笔等额现金）。
// 镇库现金不够时按比例少计，台账只记实际到账的部分，绝不透支。
function settleDepositInterestDay(state, content, bank, dailyDepositRate) {
  if (!(dailyDepositRate > 0)) return;
  const rows = [];
  let due = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const deposited = bank.deposits[household.id] || 0;
    if (deposited <= 0) continue;
    const interest = Math.floor(deposited * dailyDepositRate);
    if (interest > 0) { rows.push({ householdId: household.id, interest }); due += interest; }
  }
  if (due <= 0) return;
  const paidCap = Math.min(due, Math.max(0, voucherBalance(state, "town")));
  let credited = 0;
  const credits = [];
  for (const row of rows) {
    const credit = paidCap >= due ? row.interest : Math.floor(row.interest * paidCap / due);
    if (credit > 0) { credits.push({ householdId: row.householdId, credit }); credited += credit; }
  }
  if (credited > 0) {
    const payment = settleMonetaryPayment(state, "town", "bank", currentPaymentComposition(state, credited), content,
      "bank_deposit_interest", "银行存款利息（镇库付现）", { requireFull: false });
    if (!payment.ok || payment.paidValueUnits !== credited) throw new Error("存款利息付款预检后失败");
    for (const { householdId, credit } of credits) {
      bank.deposits[householdId] = (bank.deposits[householdId] || 0) + credit;
      bank.stats.interestPaidVoucherUnits += credit;
    }
  }
  if (credited < due) {
    recordEvent(state, "镇库现金不足，存款利息未能足额计入。", content, {
      mergeKey: "bank_interest_shortfall",
      mergeWindowDays: 7,
      amount: due - credited,
      mergedText: count => `镇库现金连续${count}天不足，存款利息未能足额计入。`
    });
  }
}

function settleBankDepositsDay(state, content, bank, policy, daysPerYear) {
  const scale = currencyScale(content);
  const dailyDepositRate = policy.depositRateAnnualPercent / 100 / daysPerYear;
  const wheatPricePerJin = wholesalePrice(state, "wheat", content) || 0;
  settleDepositInterestDay(state, content, bank, dailyDepositRate);
  // 本循环逐户存取款，会批量改家庭钱包；推迟到循环结束再同步一次居民汇总，
  // 避免每户都做一次全量重算（O(n²)），同时保证粮券守恒口径正确。
  const previousDefer = Boolean(state._deferHouseholdSync);
  state._deferHouseholdSync = true;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const pop = householdPopulation(household);
    if (!(pop > 0) || !(wheatPricePerJin > 0)) continue;
    const reserveUnits = Math.ceil(pop * 2 * BANK_HOUSEHOLD_RESERVE_DAYS * wheatPricePerJin * scale);
    const cash = household.voucherUnits || 0;
    // 手头不够 30 天口粮储备：从存款取回补足，不再吸储
    if (cash < reserveUnits) {
      const shortfall = reserveUnits - cash;
      const canTake = Math.min(shortfall, bank.deposits[household.id] || 0);
      if (canTake > 0) withdrawFromBank(state, household.id, canTake, content);
      household.stockBuyBudgetVoucherUnits = 0;
      continue;
    }
    // 吸储：可投资金（生活储备之外 × 流动性 50%—80%）按存款倾向存入；
    // 剩余部分记为本日股票购买预算，由股票日常买入消化（投资倾向模块）。
    const investable = householdInvestableVoucherUnits(state, content, household);
    const propensity = ensureHouseholdInvestPropensity(state, content, household);
    const depositAmount = Math.floor(investable * propensity.deposit);
    if (depositAmount > 0) depositToBank(state, household.id, depositAmount, content);
    household.stockBuyBudgetVoucherUnits = investable - depositAmount;
    // 记下预算归属的绝对日：consumeHouseholdStockBudget 凭此防止同日重复消费超发。
    household.stockBudgetAbsDay = (state.year - 1) * daysPerYear + state.day;
  }
  state._deferHouseholdSync = previousDefer;
  if (!previousDefer) syncResidentAggregates(state, content);
}

function settleBankAutoLoans(state, content, bank) {
  for (const company of Object.values(state.companies || {})) {
    const reserve = companyWorkingCapitalReserve(company, state, content);
    if (!(reserve > 0)) continue;
    const cash = company.cashVoucherUnits || 0;
    if (cash >= reserve) continue;
    const hasActive = bank.loans.some(loan => loan.status === "active" && loan.borrowerKind === "company" && loan.borrowerId === company.id);
    if (hasActive) continue;
    const need = reserve - cash;
    const amount = Math.min(need, bankLoanableVoucherUnits(state));
    if (amount > 0) issueBankLoan(state, "company", company.id, amount, content, BANK_LOAN_TERM_DAYS);
  }
}

export function settleBankDay(state, content) {
  if (!bankAvailable(state)) return null;
  const bank = ensureBankState(state);
  const policy = bankPolicy(state);
  const daysPerYear = content.rules.daysPerYear || 360;
  const dayIndex = (state.year - 1) * daysPerYear + state.day;
  settleBankDepositsDay(state, content, bank, policy, daysPerYear);
  settleBankLoansDay(state, content, bank, policy, dayIndex);
  settleBankAutoLoans(state, content, bank);
  if ((bank.cashVoucherUnits || 0) < 0) {
    // 银行现金持续为负时逐日告警会刷屏；用事件合并机制折叠成一条聚合事件。
    recordEvent(state, "银行现金为负，已资不抵债！请降低准备金率或补充资金。", content, {
      mergeKey: "bank_negative_cash",
      mergeWindowDays: 7,
      amount: Math.abs(bank.cashVoucherUnits || 0),
      mergedText: (count, amount) =>
        `银行现金连续${count}天为负，已资不抵债！请降低准备金率或补充资金。`
    });
  }
  const totals = bankTotals(state);
  return {
    deposits: Object.keys(bank.deposits).length,
    totalDepositsVoucherUnits: totals.totalDepositsVoucherUnits,
    outstandingLoansVoucherUnits: totals.outstandingLoansVoucherUnits,
    loanableVoucherUnits: bankLoanableVoucherUnits(state),
    badDebtVoucherUnits: bank.stats.badDebtVoucherUnits
  };
}
