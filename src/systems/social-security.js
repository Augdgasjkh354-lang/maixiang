import { currencyScale, voucherBalance } from "../economy/currency.js";
import { currentPaymentComposition, settleMonetaryPayment } from "../economy/payment.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { accountQeqUnits } from "../economy/inventory.js";
import { householdList, isActiveHousehold, syncResidentAggregates } from "./households.js";

// 社保基金（镇库子账模式）：基金是镇库资金的一个记账标签，物理资金始终在镇库。
// 收缴：从本日实际发放的工资中按人头代扣，household -> town，同时基金余额增加。
// 发放：失业金（沿用现有 policy.unemploymentBenefit 设置）与养老金从基金支出；
//       基金不足时镇库自动兜底（超出基金余额的部分由镇库一般资金承担）。

export const DEFAULT_SS_DAILY_JIN = 1;
export const DEFAULT_SS_PENSION_JIN = 2;

export function ensureSocialSecurity(state) {
  state.socialSecurity ||= {};
  const ss = state.socialSecurity;
  ss.enabled ??= false;
  ss.balanceUnits ??= 0;
  ss.dailyPerWorkerJin ??= DEFAULT_SS_DAILY_JIN;
  ss.pensionPerElderJin ??= DEFAULT_SS_PENSION_JIN;
  ss.totalInjectedUnits ??= 0;
  ss.totalCollectedUnits ??= 0;
  ss.totalPaidUnits ??= 0;
  return ss;
}

// 从基金扣除：返回实际从基金出的部分；不足部分由镇库兜底（调用方直接从镇库支付即可）。
export function deductFromFund(state, units) {
  const ss = ensureSocialSecurity(state);
  const fromFund = Math.max(0, Math.min(ss.balanceUnits || 0, units));
  ss.balanceUnits = (ss.balanceUnits || 0) - fromFund;
  return { fromFund, fromTown: Math.max(0, units - fromFund) };
}

export function fundBalanceUnits(state) {
  return ensureSocialSecurity(state).balanceUnits || 0;
}

// 政策命令：开关 / 缴费标准 / 养老金标准。
export function setSocialSecurityPolicy(state, patch) {
  const ss = ensureSocialSecurity(state);
  if (patch.enabled !== undefined) ss.enabled = Boolean(patch.enabled);
  if (patch.dailyPerWorkerJin !== undefined) {
    const value = Number(patch.dailyPerWorkerJin);
    if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "每日缴费须为有限的非负数" };
    ss.dailyPerWorkerJin = value;
  }
  if (patch.pensionPerElderJin !== undefined) {
    const value = Number(patch.pensionPerElderJin);
    if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "养老金须为有限的非负数" };
    ss.pensionPerElderJin = value;
  }
  return { ok: true, socialSecurity: { enabled: ss.enabled, dailyPerWorkerJin: ss.dailyPerWorkerJin, pensionPerElderJin: ss.pensionPerElderJin } };
}

// 手动注资：镇库一般资金 -> 社保基金（记账划转，物理资金不动）。
export function injectSocialSecurity(state, amountJin, content) {
  const ss = ensureSocialSecurity(state);
  const scale = currencyScale(content);
  const requested = Math.round(Math.max(0, Number(amountJin) || 0) * scale);
  if (requested <= 0) return { ok: false, reason: "注资金额必须大于0" };
  // 镇库总财富（小麦等值单位）：qeq 包含库存小麦与粮券。
  const townQeqUnits = accountQeqUnits(state, "town", content);
  const townValueUnits = Math.round(townQeqUnits * scale / content.precision.qeqUnitsPerJin);
  const available = Math.max(0, townValueUnits - (ss.balanceUnits || 0));
  const injected = Math.min(requested, available);
  if (injected <= 0) return { ok: false, reason: "镇库可用资金不足" };
  ss.balanceUnits = (ss.balanceUnits || 0) + injected;
  ss.totalInjectedUnits = (ss.totalInjectedUnits || 0) + injected;
  const transactionId = makeTransactionId(state);
  recordLedger(state, {
    type: "social_security_inject", transactionId, source: "town", destination: "social_security_fund",
    itemId: "money_value", quantityUnits: injected, qeqUnits: 0,
    reason: `镇库向社保基金注资${injected}小麦等值单位`
  }, content);
  return { ok: true, injectedValueUnits: injected, injectedJin: injected / scale };
}

// 工资代扣：payDailyWages 在发放完毕后调用。
// workerPay/currentPaidByKey/paidByHousehold 来自 payDailyWages 的结算结果。
export function collectSocialContributions(state, workerPay, currentPaidByKey, paidByHousehold, content) {
  const ss = ensureSocialSecurity(state);
  if (!ss.enabled) return { collected: 0 };
  const scale = currencyScale(content);
  const perWorker = Math.round(Math.max(0, Number(ss.dailyPerWorkerJin) || 0) * scale);
  if (perWorker <= 0) return { collected: 0 };
  let collected = 0;
  for (const row of workerPay) {
    const payable = row.payable || 0;
    const currentPaid = currentPaidByKey[row.payrollKey] || 0;
    if (payable <= 0 || currentPaid <= 0 || !(row.count > 0)) continue;
    // 按本日工资实际发放比例折算缴费人数。
    const ratio = Math.min(1, currentPaid / payable);
    const contribTotal = Math.round(row.count * ratio * perWorker);
    if (contribTotal <= 0) continue;
    const paidRows = paidByHousehold[row.payrollKey] || {};
    const paidTotal = Object.values(paidRows).reduce((sum, value) => sum + (value || 0), 0);
    if (paidTotal <= 0) continue;
    for (const [householdId, hpaid] of Object.entries(paidRows)) {
      const share = Math.round(contribTotal * (hpaid || 0) / paidTotal);
      if (share <= 0) continue;
      const household = state.households?.byId?.[householdId];
      if (!household) continue;
      const result = settleMonetaryPayment(state, `household:${householdId}`, "town",
        currentPaymentComposition(state, share), content,
        "social_security_contribution", `${household.name}缴纳社保（从工资代扣）`,
        { requireFull: false });
      const deducted = result.paidValueUnits || 0;
      if (deducted > 0) {
        ss.balanceUnits = (ss.balanceUnits || 0) + deducted;
        ss.totalCollectedUnits = (ss.totalCollectedUnits || 0) + deducted;
        collected += deducted;
      }
    }
  }
  if (collected > 0) {
    const transactionId = makeTransactionId(state);
    recordLedger(state, {
      type: "social_security_collect", transactionId, source: "residents", destination: "social_security_fund",
      itemId: "money_value", quantityUnits: collected, qeqUnits: 0,
      reason: `本日从工资代扣社保缴费${collected}小麦等值单位`
    }, content);
    syncResidentAggregates(state, content);
  }
  return { collectedValueUnits: collected };
}

// 每日养老金：按老人人数发放到老人所在家庭账（走现有家庭收入逻辑）。
export function payPensions(state, content) {
  const ss = ensureSocialSecurity(state);
  if (!ss.enabled) return { paid: 0 };
  const scale = currencyScale(content);
  const perElder = Math.round(Math.max(0, Number(ss.pensionPerElderJin) || 0) * scale);
  if (perElder <= 0) return { paid: 0 };
  const dueRows = [];
  let totalDue = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const elders = Math.max(0, household.ageBands?.elders || 0);
    if (elders <= 0) continue;
    const due = elders * perElder;
    dueRows.push({ household, due });
    totalDue += due;
  }
  if (totalDue <= 0 || !dueRows.length) return { paid: 0, due: 0 };
  const { fromFund } = deductFromFund(state, totalDue);
  let paid = 0;
  for (const row of dueRows) {
    const result = settleMonetaryPayment(state, "town", `household:${row.household.id}`,
      currentPaymentComposition(state, row.due), content,
      "pension_payment", `社保基金发放养老金${row.household.ageBands.elders}位老人；基金不足部分由镇库兜底`,
      { requireFull: false });
    paid += result.paidValueUnits || 0;
  }
  ss.totalPaidUnits = (ss.totalPaidUnits || 0) + paid;
  if (paid > 0) {
    const transactionId = makeTransactionId(state);
    recordLedger(state, {
      type: "pension_payment", transactionId, source: fromFund > 0 ? "social_security_fund" : "town", destination: "residents",
      itemId: "money_value", quantityUnits: paid, qeqUnits: 0,
      reason: `本日发放养老金${paid}小麦等值单位（基金承担${fromFund}，镇库兜底${Math.max(0, paid - fromFund)}）`
    }, content);
    syncResidentAggregates(state, content);
  }
  return { paidValueUnits: paid, fromFundValueUnits: Math.min(fromFund, paid), dueValueUnits: totalDue };
}

export function selectSocialSecurityStats(state, content) {
  const ss = ensureSocialSecurity(state);
  const scale = currencyScale(content);
  return {
    enabled: Boolean(ss.enabled),
    dailyPerWorkerJin: ss.dailyPerWorkerJin,
    pensionPerElderJin: ss.pensionPerElderJin,
    balanceJin: (ss.balanceUnits || 0) / scale,
    totalInjectedJin: (ss.totalInjectedUnits || 0) / scale,
    totalCollectedJin: (ss.totalCollectedUnits || 0) / scale,
    totalPaidJin: (ss.totalPaidUnits || 0) / scale
  };
}
