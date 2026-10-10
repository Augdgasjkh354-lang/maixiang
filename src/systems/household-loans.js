// 民间贷款（银行向住户放贷，规格 docs/LENDING.md）。
//
// - 第一版用途：开店启动资金（purpose "shop"，24 月）、购买别墅（purpose "villa"，60 月）。
// - 贷款记在 bank.loans 里（borrowerKind "household"），与公司贷款共用台账守恒式；放款、还款都走 economy/ 的转账原语。
// - 月供按发放时的本金、年利率、期数等额本息算出并定死；日计息沿用 settleBankLoansDay（利息滚入余额）。
// - 还款每日在 settleBankDay 的 bank 步骤里处理（先于新贷款）：到期扣月供，不够记欠期，有富余自动补还。
// - 违约不关店、不收资产；只有整户无人（escheatHousehold）时才核销剩余余额。
//
// 本模块在 bank.js 与 household-budget.js 之间共享"住户贷款余额"口径，不依赖 DOM。
import { currencyScale, transferVouchers } from "../economy/currency.js";
import { spendableVoucherUnits } from "../economy/payment.js";
import { recordEvent } from "../economy/ledger.js";
import { voucherText, withdrawFromBank } from "../economy/deposits.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { householdPopulation, isActiveHousehold, householdConvertibleWheatUnits } from "./households.js";
import { householdRecentIncomeUnitsPerDay } from "./household-life.js";
import { wholesalePrice } from "./wholesale-price.js";
import { HOUSEHOLD_RESERVE_DAYS } from "./investment-preference.js";
import { householdLoanBalanceMap, householdLoanBalanceUnits } from "../economy/loan-balance.js";
import { bankAvailable, bankLoanableVoucherUnits, DEFAULT_LOAN_RATE_ANNUAL_PERCENT, ensureBankState, setHouseholdLoanRepayHook } from "./bank.js";
import { householdGrossWealthUnits, invalidateHouseholdBudgets } from "./household-budget.js";

const REPAY_INTERVAL_DAYS = 30;

export function lendingRules(content) {
  const rules = content.rules.lending || {};
  return {
    maxDebtToWealthShare: Number(rules.maxDebtToWealthShare ?? 0.6),
    maxServiceShareOfIncome: Number(rules.maxServiceShareOfIncome ?? 0.3),
    maxPerHouseholdJin: Number(rules.maxPerHouseholdJin ?? 20000),
    shopTermMonths: Number(rules.shopTermMonths ?? 24),
    villaTermMonths: Number(rules.villaTermMonths ?? 60)
  };
}

// 只读：当前政策的贷款年利率（缺省按默认值，不写 state）。
function currentLoanRateAnnualPercent(state) {
  const value = state.policy?.bank?.loanRateAnnualPercent;
  return Number.isFinite(value) ? value : DEFAULT_LOAN_RATE_ANNUAL_PERCENT;
}

// 等额本息的月供系数：每借 1 券每月还多少券（未取整）。年利率按月利率 = 年利率 ÷ 12 计。
function instalmentFactor(annualPercent, termMonths) {
  const rate = annualPercent / 100 / 12;
  if (!(termMonths > 0)) return 0;
  if (rate === 0) return 1 / termMonths;
  return rate / (1 - Math.pow(1 + rate, -termMonths));
}

// 月供（券单位，向上取整，保证期满能还清）。
export function householdLoanInstalmentUnits(principalUnits, annualPercent, termMonths) {
  if (!(principalUnits > 0)) return 0;
  return Math.ceil(principalUnits * instalmentFactor(annualPercent, termMonths));
}

// 住户"手头 + 存款"按口粮折算的可动用总值（与开店、购别墅的资金口径一致：粮券 + 超出 30 天口粮的小麦）。
export function householdLiquidValueUnits(state, household, content) {
  const vouchers = spendableVoucherUnits(state, `household:${household.id}`);
  const wheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
  return vouchers + voucherUnitsForWheatUnits(wheatUnits, content, "floor");
}

// 30 天口粮钱（与银行存款的生活储备同口径：人均 2 斤/天 × 30 天 × 小麦价）。
export function householdFoodReserveVoucherUnits(state, household, content) {
  const pop = householdPopulation(household);
  const wheatPricePerJin = wholesalePrice(state, "wheat", content) || 0;
  if (!(pop > 0) || !(wheatPricePerJin > 0)) return 0;
  return Math.ceil(pop * 2 * HOUSEHOLD_RESERVE_DAYS * wheatPricePerJin * currencyScale(content));
}

// 住户的未还本息余额（只算 active 的住户贷款）。
export function householdActiveLoans(state, householdId) {
  return (state.bank?.loans || []).filter(loan => loan.borrowerKind === "household" && loan.status === "active" && loan.borrowerId === householdId);
}

function householdInstalmentTotalUnits(state, householdId) {
  return householdActiveLoans(state, householdId).reduce((sum, loan) => sum + (loan.instalmentVoucherUnits || 0), 0);
}

function householdHasMissedInstalment(state, householdId) {
  return householdActiveLoans(state, householdId).some(loan => (loan.missedInstalments || 0) > 0);
}

// 最大本金：使月供不超过 room 的最大整数（月供随本金单调不减）。
function maxPrincipalForInstalment(roomUnits, annualPercent, termMonths) {
  if (!(roomUnits > 0)) return 0;
  const factor = instalmentFactor(annualPercent, termMonths);
  if (!(factor > 0)) return 0;
  let principal = Math.floor(roomUnits / factor);
  while (principal > 0 && householdLoanInstalmentUnits(principal, annualPercent, termMonths) > roomUnits) principal -= 1;
  return principal;
}

// 放款报价（只读）。needUnits 是该用途要的总额（启动资金 + 生活储备，或别墅房价 + 生活储备）；
// 缺口 = needUnits − 住户可动用总值。额度为各项上限的最小值，covers 表示能否补齐整个缺口。
export function quoteHouseholdLoan(state, householdId, purpose, needUnits, content) {
  if (!bankAvailable(state)) return { ok: false, reason: "银行尚未可用（需先建成银行）" };
  if (purpose !== "shop" && purpose !== "villa") return { ok: false, reason: "不支持的贷款用途" };
  const household = state.households?.byId?.[householdId];
  if (!household || !isActiveHousehold(household)) return { ok: false, reason: "住户不存在或已迁出" };
  if (householdHasMissedInstalment(state, householdId)) return { ok: false, reason: "该户有欠期贷款，暂不放贷" };
  const rules = lendingRules(content);
  const scale = currencyScale(content);
  const termMonths = purpose === "villa" ? rules.villaTermMonths : rules.shopTermMonths;
  const rateAnnualPercent = currentLoanRateAnnualPercent(state);

  const gapUnits = Math.max(0, Math.ceil(Number(needUnits) - householdLiquidValueUnits(state, household, content)));
  if (!(gapUnits > 0)) return { ok: false, reason: "无需贷款", gapUnits: 0 };

  const grossWealth = householdGrossWealthUnits(state, household, content);
  const debtBefore = householdLoanBalanceUnits(state, householdId);
  const netBefore = grossWealth - debtBefore;
  if (!(netBefore > 0)) return { ok: false, reason: "净家底不为正，不予放贷", gapUnits };

  const incomeMonthUnits = householdRecentIncomeUnitsPerDay(household, content) * 30;
  const serviceRoomUnits = Math.floor(rules.maxServiceShareOfIncome * incomeMonthUnits) - householdInstalmentTotalUnits(state, householdId);
  const limits = {
    gap: gapUnits,
    netWealth: Math.floor(netBefore),
    debtToWealth: Math.floor(rules.maxDebtToWealthShare * grossWealth) - debtBefore,
    perHousehold: Math.floor(rules.maxPerHouseholdJin * scale) - debtBefore,
    serviceCapacity: maxPrincipalForInstalment(serviceRoomUnits, rateAnnualPercent, termMonths),
    bankLoanable: bankLoanableVoucherUnits(state)
  };
  let limit = "gap";
  let amountUnits = gapUnits;
  for (const [key, value] of Object.entries(limits)) {
    if (key === "gap") continue;
    if (value < amountUnits) { amountUnits = value; limit = key; }
  }
  amountUnits = Math.max(0, Math.floor(amountUnits));
  if (!(amountUnits > 0)) return { ok: false, reason: `贷款额度为零（受限于${LIMIT_NAMES[limit] || limit}）`, gapUnits, limit, limits };
  return {
    ok: true, covers: amountUnits >= gapUnits, amountUnits, gapUnits, limit, limits,
    purpose, termMonths, rateAnnualPercent,
    instalmentUnits: householdLoanInstalmentUnits(amountUnits, rateAnnualPercent, termMonths)
  };
}

const LIMIT_NAMES = {
  netWealth: "净家底", debtToWealth: "负债占家底上限", perHousehold: "单户余额上限",
  serviceCapacity: "还款能力", bankLoanable: "银行可贷额度"
};

const PURPOSE_NAMES = { shop: "开店启动资金", villa: "购房" };

// 放款（已报价）：粮券从银行现金转入住户手头，登记贷款。
function issueQuotedLoan(state, householdId, quote, content) {
  const bank = ensureBankState(state);
  const household = state.households.byId[householdId];
  const amount = quote.amountUnits;
  const transfer = transferVouchers(state, "bank", `household:${householdId}`, amount, content, "household_loan_issue",
    `银行向${household.name}发放${PURPOSE_NAMES[quote.purpose]}贷款`);
  if (!transfer.ok) return { ok: false, reason: transfer.reason };
  const daysPerYear = content.rules.daysPerYear || 360;
  const dayIndex = (state.year - 1) * daysPerYear + state.day;
  bank.seq += 1;
  const loan = {
    id: `BL${bank.seq}`,
    borrowerKind: "household",
    borrowerId: householdId,
    purpose: quote.purpose,
    termMonths: quote.termMonths,
    termDays: quote.termMonths * REPAY_INTERVAL_DAYS,
    principalVoucherUnits: amount,
    outstandingVoucherUnits: amount,
    accruedInterestVoucherUnits: 0,
    repaidVoucherUnits: 0,
    instalmentVoucherUnits: quote.instalmentUnits,
    rateAnnualPercent: quote.rateAnnualPercent,
    issuedDayIndex: dayIndex,
    nextDueDayIndex: dayIndex + REPAY_INTERVAL_DAYS,
    missedInstalments: 0,
    overdueDays: 0,
    status: "active"
  };
  bank.loans.push(loan);
  bank.stats.loansIssuedCount += 1;
  bank.stats.loansIssuedVoucherUnits += amount;
  recordEvent(state, `银行向${household.name}发放${PURPOSE_NAMES[quote.purpose]}贷款${voucherText(amount, currencyScale(content))}券，${quote.termMonths}个月还清，月供${voucherText(quote.instalmentUnits, currencyScale(content))}券。`, content);
  invalidateHouseholdBudgets(state);
  return { ok: true, loan, amountUnits: amount };
}

// 为某用途放款补缺口：报价不能补齐整个缺口时不放（放了也付不了，只会留下空贷款）。
export function issueHouseholdLoan(state, householdId, purpose, needUnits, content) {
  const quote = quoteHouseholdLoan(state, householdId, purpose, needUnits, content);
  if (!quote.ok) return quote;
  if (!quote.covers) return { ok: false, reason: `贷款额度不足以补齐缺口（受限于${LIMIT_NAMES[quote.limit] || quote.limit}）`, quote };
  return issueQuotedLoan(state, householdId, quote, content);
}

// 同日冲销：开店或购房失败时，把刚放的贷款原路退回银行并撤销这笔贷款。只允许未计息、未还款的贷款（同日必然如此）。
export function cancelHouseholdLoan(state, loanId, content) {
  const bank = state.bank;
  const index = (bank?.loans || []).findIndex(loan => loan.id === loanId && loan.borrowerKind === "household" && loan.status === "active");
  if (index < 0) return { ok: false, reason: "贷款不存在" };
  const loan = bank.loans[index];
  if ((loan.accruedInterestVoucherUnits || 0) > 0 || (loan.repaidVoucherUnits || 0) > 0 || loan.outstandingVoucherUnits !== loan.principalVoucherUnits) {
    return { ok: false, reason: "贷款已计息或已还款，不能同日冲销" };
  }
  const amount = loan.principalVoucherUnits;
  const transfer = transferVouchers(state, `household:${loan.borrowerId}`, "bank", amount, content, "household_loan_cancel",
    "开店或购房未成，当天原路退回贷款");
  if (!transfer.ok) return { ok: false, reason: transfer.reason };
  bank.loans.splice(index, 1);
  bank.stats.loansIssuedCount -= 1;
  bank.stats.loansIssuedVoucherUnits -= amount;
  invalidateHouseholdBudgets(state);
  return { ok: true, amountUnits: amount };
}

// 从住户取款还银行。keepReserve：是否留住 30 天口粮钱（日常还款留，整户无人时不留）。返回实还额。
function repayFromHousehold(state, content, householdId, dueUnits, keepReserve) {
  const household = state.households?.byId?.[householdId];
  if (!household || !(dueUnits > 0)) return 0;
  const reserve = keepReserve ? householdFoodReserveVoucherUnits(state, household, content) : 0;
  const hand = Math.max(0, household.voucherUnits || 0);
  const deposit = Math.max(0, state.bank?.deposits?.[householdId] || 0);
  const capacity = Math.max(0, hand + deposit - reserve);
  const pay = Math.min(dueUnits, capacity);
  if (!(pay > 0)) return 0;
  let amount = Math.min(pay, hand);
  if (pay > hand) {
    const withdrawn = withdrawFromBank(state, householdId, pay - hand, content);
    if (withdrawn.ok) amount = pay;
  }
  if (!(amount > 0)) return 0;
  const result = transferVouchers(state, `household:${householdId}`, "bank", amount, content, "household_loan_repay", "住户偿还银行贷款");
  return result.ok ? amount : 0;
}

// 还款入账：先冲利息再冲本金；余额归零则结清。
function applyLoanRepayment(state, content, loan, paidUnits) {
  if (!(paidUnits > 0)) return;
  const bank = state.bank;
  const interestPart = Math.min(paidUnits, loan.accruedInterestVoucherUnits || 0);
  loan.accruedInterestVoucherUnits = (loan.accruedInterestVoucherUnits || 0) - interestPart;
  loan.outstandingVoucherUnits -= paidUnits;
  loan.repaidVoucherUnits = (loan.repaidVoucherUnits || 0) + paidUnits;
  bank.stats.loansRepaidVoucherUnits += paidUnits;
  bank.stats.interestEarnedVoucherUnits += interestPart;
  if (loan.outstandingVoucherUnits <= 0) {
    loan.outstandingVoucherUnits = 0;
    loan.accruedInterestVoucherUnits = 0;
    loan.missedInstalments = 0;
    loan.overdueDays = 0;
    loan.status = "repaid";
    recordEvent(state, `${state.households?.byId?.[loan.borrowerId]?.name || "住户"}的银行贷款${loan.id}已还清。`, content);
  }
}

// 每日还款（settleBankDay 中在 settleBankLoansDay 之后）。
export function settleHouseholdLoanRepayDay(state, content) {
  const bank = state.bank;
  if (!bank) return 0;
  const daysPerYear = content.rules.daysPerYear || 360;
  const dayIndex = (state.year - 1) * daysPerYear + state.day;
  let repaidTotal = 0;
  for (const loan of bank.loans) {
    if (loan.borrowerKind !== "household" || loan.status !== "active") continue;
    const instalment = loan.instalmentVoucherUnits || 0;
    if (dayIndex >= loan.nextDueDayIndex) {
      // 最后一期（第 termMonths 期及以后）把余额一次结清：等额本息取整后的尾差不留到期外。
      const periodNo = Math.round((loan.nextDueDayIndex - loan.issuedDayIndex) / REPAY_INTERVAL_DAYS);
      const due = periodNo >= loan.termMonths
        ? loan.outstandingVoucherUnits
        : Math.min(instalment * (1 + loan.missedInstalments), loan.outstandingVoucherUnits);
      const paid = repayFromHousehold(state, content, loan.borrowerId, due, true);
      applyLoanRepayment(state, content, loan, paid);
      repaidTotal += paid;
      if (loan.status === "active") loan.missedInstalments = paid >= due ? 0 : loan.missedInstalments + 1;
      loan.nextDueDayIndex += REPAY_INTERVAL_DAYS;
    }
    // 有欠期：每天检查一次，有富余就补还，直到欠期清零（部分补还按整期折减欠期数）。
    if (loan.status === "active" && loan.missedInstalments > 0 && instalment > 0) {
      const arrears = Math.min(instalment * loan.missedInstalments, loan.outstandingVoucherUnits);
      const paid = repayFromHousehold(state, content, loan.borrowerId, arrears, true);
      applyLoanRepayment(state, content, loan, paid);
      repaidTotal += paid;
      if (loan.status === "active") {
        loan.missedInstalments = paid >= arrears ? 0 : Math.max(0, loan.missedInstalments - Math.floor(paid / instalment));
      }
    }
    if (loan.status === "active") loan.overdueDays = loan.missedInstalments > 0 ? (loan.overdueDays || 0) + 1 : 0;
  }
  if (repaidTotal > 0) invalidateHouseholdBudgets(state);
  return repaidTotal;
}

// 整户无人（家产归镇库）前调用：先用该户手头与存款还一部分（不留口粮），剩余余额核销。
// 核销：坏账计入 stats.badDebtVoucherUnits，留存利润等额减少（资产消失、无现金进账）。不关店、不收房。
export function settleHouseholdLoansAtEscheat(state, household, content) {
  const bank = state.bank;
  const result = { repaidVoucherUnits: 0, writtenOffVoucherUnits: 0 };
  if (!bank) return result;
  for (const loan of bank.loans) {
    if (loan.borrowerKind !== "household" || loan.status !== "active" || loan.borrowerId !== household.id) continue;
    const paid = repayFromHousehold(state, content, household.id, loan.outstandingVoucherUnits, false);
    applyLoanRepayment(state, content, loan, paid);
    result.repaidVoucherUnits += paid;
    if (loan.status !== "active") continue;
    const rest = loan.outstandingVoucherUnits;
    loan.status = "written_off";
    loan.outstandingVoucherUnits = 0;
    loan.accruedInterestVoucherUnits = 0;
    loan.missedInstalments = 0;
    bank.stats.badDebtVoucherUnits += rest;
    bank.retainedVoucherUnits -= rest;
    result.writtenOffVoucherUnits += rest;
    recordEvent(state, `${household.name}整户无人，银行贷款${loan.id}余额${voucherText(rest, currencyScale(content))}券核销为坏账。`, content);
  }
  if (result.repaidVoucherUnits || result.writtenOffVoucherUnits) invalidateHouseholdBudgets(state);
  return result;
}

setHouseholdLoanRepayHook(settleHouseholdLoanRepayDay);

export { householdLoanBalanceMap, householdLoanBalanceUnits };
