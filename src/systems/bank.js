import { currencyScale, transferVouchers, voucherBalance } from "../economy/currency.js";
import { recordEvent } from "../economy/ledger.js";
import { noteBankDebtGrowth, voucherText, withdrawFromBank } from "../economy/deposits.js";
import { bookAdd } from "../economy/books.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { recordHouseholdBudgetIncome } from "./household-life.js";
import { wholesalePrice } from "./wholesale-price.js";
import { companyWorkingCapitalReserve } from "./companies.js";
import { ensureHouseholdInvestPropensity, householdInvestableVoucherUnits, HOUSEHOLD_RESERVE_DAYS } from "./investment-preference.js";

// 银行系统（金融扩展第二期）：镇营银行。
// - 只存粮券不存粮食；存款按日计息；可向上市公司放贷
// - 存款利息由银行自付（计入存款、费用记在留存利润上）：当日应付利息 = 银行费用，留存利润同额减少，
//   并记为银行应付利息（bank.interestPayableUnits）；付息前银行现金须能覆盖付息额，不够时镇库托底垫付
//   （bank_town_advance，计入欠镇库）；镇库也付不起的部分顺延为应付，下日补付，不丢。
//   付息的现金经住户当即并入存款，净额为零：现金只因镇库垫付增加，付息本身不减少银行现金（双分录下的唯一自洽写法）。
// - 准备金率限制可贷额度；存贷利差等银行利润记入 bank.retainedVoucherUnits 留存，不自动上缴镇库；留存利润可为负
// - 镇库托底：住户取回存款时银行现金不够，缺口由镇库垫付，记为银行欠镇库的债（bank.debtToTownUnits）。
//   现金超出 准备金 + 安全垫 的部分每日自动还给镇库（bank_town_repay），玩家也可手动还（repayBankDebtToTown）。
// - 粮券恒等式：银行现金计入 totalVoucherBalances（currency.js）。存款台账的守恒关系是
//   存款 + 欠镇库 + 应付利息 = 银行现金 + 在贷余额 + 持有国债 − 留存利润（bankLedgerInvariant，validateState 校验）。
export const DEFAULT_DEPOSIT_RATE_ANNUAL_PERCENT = 2;
export const DEFAULT_LOAN_RATE_ANNUAL_PERCENT = 6;
export const DEFAULT_RESERVE_REQUIREMENT_PERCENT = 10;
// 还债时银行必须保留的安全垫（占存款比例），规则键 rules.bankDebtRepayBufferShare。
export const DEFAULT_BANK_DEBT_REPAY_BUFFER_SHARE = 0.05;
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
  // 镇库托底：必须先于留存利润补齐（留存利润的反推口径要减去欠镇库的债）。
  bank.debtToTownUnits ??= 0;
  bank.totalAdvancedUnits ??= 0;
  bank.totalRepaidUnits ??= 0;
  // 存款利息应付：镇库也付不起的部分顺延到下日补付（留存利润的反推口径要减去它）。
  bank.interestPayableUnits ??= 0;
  if (!Number.isSafeInteger(bank.retainedVoucherUnits)) bank.retainedVoucherUnits = bankRetainedVoucherUnits(state);
  return bank;
}

function bankInterestPayableVoucherUnits(state) {
  return Math.max(0, state.bank?.interestPayableUnits || 0);
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

// 银行欠镇库的债（镇库托底累计，只减不增于还债之外的任何口径）。
function bankDebtToTownVoucherUnits(state) {
  return Math.max(0, state.bank?.debtToTownUnits || 0);
}

// 银行留存利润（可为负）：贷款利息应计 − 坏账核销 + 国债利息收入 − 国债违约损失。
// 旧存档没有这个字段：此时按"资产 − 存款 − 欠镇库 − 应付利息"反推（应付利息旧档为 0）。
// 旧版存款利息由镇库付现金，反推值就是旧档的实际留存；新版的付息费用在日结里即时减少留存利润。
// 镇库托底的垫付与还款同时改动现金和欠镇库，不改变留存利润；付息顺延只把应付从"留存"转到"应付"，也不改留存。
export function bankRetainedVoucherUnits(state) {
  const bank = state.bank || {};
  if (Number.isSafeInteger(bank.retainedVoucherUnits)) return bank.retainedVoucherUnits;
  return bankAssetVoucherUnits(state) - bankDepositTotalVoucherUnits(state) - bankDebtToTownVoucherUnits(state)
    - bankInterestPayableVoucherUnits(state);
}

// 存款台账守恒（只读）：存款 + 欠镇库 + 应付利息 = 现金 + 在贷余额 + 国债本金 − 留存利润；应付利息不得为负。
// 留存利润可为负（付息费用超过收入时），这是银行权益为负、靠镇库托底兜底的状态，不违反守恒。
export function bankLedgerInvariant(state) {
  const bank = state.bank || {};
  const deposits = bankDepositTotalVoucherUnits(state);
  const debtToTown = bankDebtToTownVoucherUnits(state);
  const interestPayable = Number(bank.interestPayableUnits || 0);
  const cash = bank.cashVoucherUnits || 0;
  let loans = 0;
  for (const loan of bank.loans || []) if (loan.status === "active") loans += loan.outstandingVoucherUnits || 0;
  let bonds = 0;
  for (const issue of state.bonds?.issues || []) {
    for (const holding of issue.holdings || []) if (holding.holderKey === "bank:bank") bonds += holding.principalVoucherUnits || 0;
  }
  const retained = bankRetainedVoucherUnits(state);
  return { deposits, debtToTown, interestPayable, cash, loans, bonds, retained,
    valid: interestPayable >= 0 && deposits + debtToTown + interestPayable === cash + loans + bonds - retained };
}

// 还债用的安全垫比例：优先读规则 rules.bankDebtRepayBufferShare，缺省用模块默认值。
export function bankDebtRepayBufferShare(content) {
  const value = Number(content?.rules?.bankDebtRepayBufferShare);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BANK_DEBT_REPAY_BUFFER_SHARE;
}

// 本日（或本次命令）可还给镇库的现金：银行现金超出 法定准备金（存款 × 准备金率）+ 安全垫（存款 × 安全垫比例）的部分，
// 且不超过欠镇库余额。只读。
export function bankDebtRepayableUnits(state, content) {
  const debt = bankDebtToTownVoucherUnits(state);
  if (debt <= 0 || !state.bank) return 0;
  // 只读：不用 bankPolicy()（它会写入默认值），缺省时取模块默认准备金率。
  const reservePercent = state.policy?.bank?.reserveRequirementPercent ?? DEFAULT_RESERVE_REQUIREMENT_PERCENT;
  const deposits = bankDepositTotalVoucherUnits(state);
  const reserve = Math.floor(deposits * (reservePercent / 100));
  const buffer = Math.floor(deposits * bankDebtRepayBufferShare(content));
  const excess = (state.bank.cashVoucherUnits || 0) - reserve - buffer - bankInterestPayableVoucherUnits(state);
  return Math.max(0, Math.min(debt, excess));
}

// 还款：银行现金 → 镇库（统一转账，类型 bank_town_repay），欠镇库余额同步减少。
function repayBankDebtVoucherUnits(state, content, amount) {
  const bank = state.bank;
  const result = transferVouchers(state, "bank", "town", amount, content, "bank_town_repay",
    "银行向镇库还债（现金超出准备金与安全垫的部分）");
  if (!result.ok) return { ok: false, reason: result.reason };
  bank.debtToTownUnits = Math.max(0, (bank.debtToTownUnits || 0) - amount);
  bank.totalRepaidUnits = (bank.totalRepaidUnits || 0) + amount;
  return { ok: true, repaidValueUnits: amount };
}

// 每日还债步骤：把可还额一次还清（没有可还额时什么也不做）。返回本日还债额。
export function settleBankDebtRepay(state, content) {
  const amount = bankDebtRepayableUnits(state, content);
  if (amount <= 0) return 0;
  const result = repayBankDebtVoucherUnits(state, content, amount);
  return result.ok ? amount : 0;
}

// 玩家命令：从银行现金还债给镇库，金额最多为可还额（超出准备金与安全垫的现金，且不超过欠款）。
export function repayBankDebtToTown(state, amountJin, content) {
  if (!state.bank || (state.bank.debtToTownUnits || 0) <= 0) return { ok: false, reason: "银行没有欠镇库的钱" };
  const scale = currencyScale(content);
  const requested = Math.round(Math.max(0, Number(amountJin) || 0) * scale);
  if (!Number.isSafeInteger(requested) || requested <= 0) return { ok: false, reason: "还款金额必须大于0" };
  const amount = Math.min(requested, bankDebtRepayableUnits(state, content));
  if (amount <= 0) return { ok: false, reason: "银行现金需先超出准备金与安全垫，暂不能还债" };
  const result = repayBankDebtVoucherUnits(state, content, amount);
  if (!result.ok) return result;
  return { ok: true, repaidValueUnits: amount, repaidJin: amount / scale,
    debtJin: state.bank.debtToTownUnits / scale };
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

// 可贷额度 = 银行现金 - 法定准备金（存款×准备金率）- 欠镇库（镇库托底垫付的债要先还，不能把镇库的钱再借出去）
//   - 应付利息（欠存款人的利息，下日要付，同样不能借出）。
// 放贷（issueBankLoan / settleBankAutoLoans）与国债认购（bonds.js）共用这一口径。
export function bankLoanableVoucherUnits(state) {
  const policy = bankPolicy(state);
  const totals = bankTotals(state);
  const required = Math.floor(totals.totalDepositsVoucherUnits * (policy.reserveRequirementPercent / 100));
  return Math.max(0, totals.cashVoucherUnits - required - bankDebtToTownVoucherUnits(state) - bankInterestPayableVoucherUnits(state));
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

// 按权重整数分摊 amount（amount 不超过权重总和）：份额 = floor(amount × 权重 ÷ 总权重)，用 BigInt 保证精确；
// 余数逐户补 1 券（只补有权重的户），总额精确等于 amount。返回 [[住户id, 份额], ...]。
function splitByWeight(amount, pairs) {
  const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(amount > 0) || !(total > 0)) return [];
  const out = pairs.map(([id, weight]) => [id, Number(BigInt(amount) * BigInt(weight) / BigInt(total))]);
  let left = amount - out.reduce((sum, [, part]) => sum + part, 0);
  for (let i = 0; left > 0; i = (i + 1) % out.length) {
    if (pairs[i][1] > 0) { out[i][1] += 1; left -= 1; }
  }
  return out;
}

// 存款利息由银行自付（台账规则见文件头）。日结里分四步：
// 1. 计费：各活跃户存款 × 日利率取整，合计为银行费用：留存利润同额减少，计入应付利息（bank.interestPayableUnits）。
// 2. 付息能力：银行现金 + 镇库粮券。现金不够付的部分由镇库垫付（bank_town_advance，计入欠镇库，类似取款托底）。
// 3. 入账：可付额先付当日利息（按各户计息额），再付顺延的旧欠（按各户存款分摊）；并入住户存款，
//    计入居民预算收入与利息统计。付息现金经住户当即并入存款，净额为零，所以银行现金不因付息减少。
// 4. 顺延：镇库也付不起的部分留在应付利息，下日补付（不丢），留存利润已先减，台账仍守恒。
function settleDepositInterestDay(state, content, bank, dailyDepositRate) {
  const scale = currencyScale(content);
  const holders = [];
  let accrued = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const deposited = bank.deposits[household.id] || 0;
    if (deposited <= 0) continue;
    const interest = dailyDepositRate > 0 ? Math.floor(deposited * dailyDepositRate) : 0;
    holders.push({ householdId: household.id, deposited, interest });
    accrued += interest;
  }
  if (accrued > 0) {
    bank.retainedVoucherUnits -= accrued;
    bank.interestPayableUnits += accrued;
    bookAdd(bank, "depositInterestExpense", accrued);
  }
  if (bank.interestPayableUnits <= 0) return;

  const cash = Math.max(0, bank.cashVoucherUnits || 0);
  const payNow = Math.min(bank.interestPayableUnits, cash + Math.max(0, voucherBalance(state, "town")));
  const shortfall = Math.max(0, payNow - cash);
  if (shortfall > 0) {
    const advance = transferVouchers(state, "town", "bank", shortfall, content, "bank_town_advance",
      "镇库垫付银行存款利息缺口，计入银行负债");
    if (!advance.ok) throw new Error("存款利息垫付预检后失败：" + advance.reason);
    bank.debtToTownUnits = (bank.debtToTownUnits || 0) + shortfall;
    bank.totalAdvancedUnits = (bank.totalAdvancedUnits || 0) + shortfall;
    noteBankDebtGrowth(state, content, shortfall, "支付存款利息时银行现金不足");
  }

  // 先付当日利息，再付顺延的旧欠（不超过各户存款之和）。
  const dueToday = holders.reduce((sum, row) => sum + row.interest, 0);
  const todayPaid = Math.min(payNow, dueToday);
  const carryPaid = Math.min(payNow - todayPaid, holders.reduce((sum, row) => sum + row.deposited, 0));
  const credits = new Map();
  const addCredit = (householdId, units) => { if (units > 0) credits.set(householdId, (credits.get(householdId) || 0) + units); };
  for (const [householdId, units] of splitByWeight(todayPaid, holders.map(row => [row.householdId, row.interest]))) addCredit(householdId, units);
  for (const [householdId, units] of splitByWeight(carryPaid, holders.map(row => [row.householdId, row.deposited]))) addCredit(householdId, units);
  let paid = 0;
  for (const [householdId, credit] of credits) {
    bank.deposits[householdId] = (bank.deposits[householdId] || 0) + credit;
    recordHouseholdBudgetIncome(state, householdId, credit, content);
    bank.stats.interestPaidVoucherUnits += credit;
    paid += credit;
  }
  bank.interestPayableUnits -= paid;

  if (bank.interestPayableUnits > 0) {
    recordEvent(state, `银行现金与镇库粮券都不足，存款利息${voucherText(bank.interestPayableUnits, scale)}券顺延为应付，下日补付。`, content, {
      mergeKey: "bank_interest_deferred",
      mergeWindowDays: 7,
      amount: bank.interestPayableUnits,
      mergedText: (count, amount) => `银行现金与镇库粮券连续${count}天不足，存款利息顺延为应付（本轮累计${voucherText(amount, scale)}券），下日补付。`
    });
  }
}

// 银行费用三段记账（日 / 年 / 累计）：日、年周期跨界时清空对应段。
function rollBankBooks(state, bank) {
  bank.day = {};
  if (bank.booksYear !== state.year) { bank.year = {}; bank.booksYear = state.year; }
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
  rollBankBooks(state, bank);
  settleBankDepositsDay(state, content, bank, policy, daysPerYear);
  settleBankLoansDay(state, content, bank, policy, dayIndex);
  // 先还镇库托底的债，再放新贷款：超出准备金与安全垫的现金优先还债，不把垫付的钱又借给公司。
  settleBankDebtRepay(state, content);
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
    badDebtVoucherUnits: bank.stats.badDebtVoucherUnits,
    debtToTownVoucherUnits: bank.debtToTownUnits,
    interestPayableVoucherUnits: bank.interestPayableUnits
  };
}
