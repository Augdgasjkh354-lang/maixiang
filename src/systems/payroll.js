import { payDayFor } from "./paydays.js";
import { addWageExpense } from "../economy/business.js";
import { currencyScale } from "../economy/currency.js";
import { currentPaymentComposition, settleMonetaryPayment } from "../economy/payment.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { withDeferredHouseholdSync, jobAssignments, householdList, householdIdleWorkers, householdPopulation, householdFoodQeqUnits } from "./households.js";
import { accrueWages, payWages, wageArrears } from "./employer.js";
import { ensureSocialSecurity, payFromFund } from "./social-security.js";

function ensurePayroll(state) {
  state.payroll ||= { arrearsVoucherUnits: {}, totals: {}, year: {} };
  state.payroll.arrearsVoucherUnits ||= state.payroll.arrearsWheatUnits || {};
  // Compatibility mirror for old reports/tests. Values are now voucher units, not physical wheat.
  state.payroll.arrearsWheatUnits = state.payroll.arrearsVoucherUnits;
  state.payroll.totals ||= {};
  state.payroll.year ||= {};
  return state.payroll;
}

// 工资调控分类：公务员类（政务/警察/银行/交易所）与镇营产业类（其余镇营岗位）。
// 上市公司工资走 payListedCompanyWages，不在此调控范围内。
export const WAGE_CONTROL_CIVIL_ROLE_IDS = Object.freeze(["civil_servants", "police", "bank_staff", "exchange_staff", "social_staff"]);

export function wageControlFactor(state, roleId) {
  const control = state.policy?.wageControl;
  if (!control) return 1;
  if (WAGE_CONTROL_CIVIL_ROLE_IDS.includes(roleId)) {
    const value = Number(control.civil);
    return Number.isFinite(value) && value >= 0 ? value : 1;
  }
  const value = Number(control.industry);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

// 镇营岗位实际日薪：基础日薪 × 工资调控系数（与 payroll.js 实发同一口径）。
export function townWageRate(state, jobId, content) {
  const job = content.roles?.[jobId] || Object.values(content.buildings || {})
    .flatMap(definition => definition.jobs || []).find(row => row.id === jobId);
  const base = state.employment?.wageRates?.[jobId] ?? job?.wagePerWorkerDay ?? 0;
  return Math.max(0, base) * wageControlFactor(state, jobId);
}

// 民营建筑实际日薪：业主定的 building.privateWage；没定过时取镇营同岗位实际日薪（见 private-wage.js）。
export function privateWageRate(state, building, job, content) {
  const stored = building?.privateWage?.wagePerWorkerDay;
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= 0) return stored;
  return Math.round(townWageRate(state, job.id, content) * 2) / 2;
}

export function ensureWageControl(state) {
  state.policy ||= {};
  state.policy.wageControl ||= { civil: 1.0, industry: 1.0 };
  state.policy.wageControl.civil ??= 1.0;
  state.policy.wageControl.industry ??= 1.0;
  return state.policy.wageControl;
}

// 政策命令：调整工资调控系数（公务员类 / 镇营产业类）。
export function setWageControlPolicy(state, patch) {
  const control = ensureWageControl(state);
  if (patch.civil !== undefined) {
    const value = Number(patch.civil);
    if (!Number.isFinite(value) || value < 0 || value > 10) return { ok: false, reason: "公务员类系数须在0—10之间" };
    control.civil = value;
  }
  if (patch.industry !== undefined) {
    const value = Number(patch.industry);
    if (!Number.isFinite(value) || value < 0 || value > 10) return { ok: false, reason: "镇营产业类系数须在0—10之间" };
    control.industry = value;
  }
  return { ok: true, wageControl: { ...control } };
}

function recordWageExpense(state, row, voucherUnits, kind, content) {
  if (voucherUnits <= 0) return;
  const transactionId = makeTransactionId(state);
  recordLedger(state, {
    type: "wage_expense", transactionId,
    source: kind === "construction" ? "construction" : (row.buildingId || "town_workshop"),
    destination: "wage_expense", itemId: "grain_voucher",
    quantityUnits: voucherUnits, qeqUnits: 0,
    reason: (row.buildingName || row.name) + "本日粮券工资已计提"
  }, content);
  const building = row.buildingId && state.buildings.find(item => item.id === row.buildingId);
  const sector = building ? (content.buildings[building.typeId]?.accountingSector || "bread") : "bread";
  addWageExpense(state, kind, voucherUnits, sector);
}

// 每条工资行付完都会全量同步居民汇总（250 户 × 全部物品）；整天合并成结束时同步一次。
export function payDailyWages(state, laborAtStart, content) {
  return withDeferredHouseholdSync(state, content, () => payDailyWagesNow(state, laborAtStart, content));
}

function payDailyWagesNow(state, laborAtStart, content) {
  const payroll = ensurePayroll(state);
  payroll.creditorClaims ||= {};
  payroll.creditorPaymentClaims ||= {};
  const arrears = payroll.arrearsVoucherUnits;

  const baseRows = laborAtStart.rows.filter(row => !["private", "listed", "shop"].includes(row.scope));
  const scale = currencyScale(content);
  // 镇营岗位（含批发市场）工资一律由镇库发放。
  // 营造岗位按工程拆分：每个在建工程各自是一条工资行，各自抵扣自己的旧预付款，
  // 工资总额仍等于各工程投入人数之和乘同一日薪，不新增任何工资标准。
  const rows = baseRows.flatMap(row => {
    if (row.key !== "builders") return [row];
    const projects = (state.projects || []).filter(project => Math.max(0, Math.floor(project.workers || 0)) > 0);
    if (!projects.length) return [];
    return projects.map(project => ({
      ...row,
      key: "builders",
      payrollKey: "builders::" + project.instanceId,
      projectInstanceId: project.instanceId,
      buildingId: project.instanceId,
      buildingName: (content.buildings[project.typeId]?.name || project.typeId) + "施工",
      count: Math.max(0, Math.floor(project.workers || 0))
    }));
  });
  const workerPay = [];
  // 月薪（systems/employer.js）：每天计提进本月待发，镇库每月 5 号结清上月及以前的待发；过了发薪日付不清的才是欠薪。
  payroll.creditorPending ||= {};
  const bookFor = payrollKey => ({
    claimsVoucherUnits: payroll.creditorClaims[payrollKey] ||= {},
    claimsPayment: payroll.creditorPaymentClaims[payrollKey] ||= {},
    pendingByMonth: payroll.creditorPending[payrollKey] ||= {}
  });

  // 计提今天的工资费用与家庭待发。
  for (const row of rows) {
    const baseRate = Number.isFinite(row.wagePerWorkerDay) ? row.wagePerWorkerDay : (state.employment.wageRates?.[row.roleId] ?? 0);
    // 工资统一调控：按公务员类 / 镇营产业类系数调整实际计提日薪。
    const rate = baseRate * wageControlFactor(state, row.roleId);
    const due = Math.round(Math.max(0, row.count * rate) * scale);
    if (!due) continue;
    const isConstruction = row.key === "builders";
    const project = isConstruction && row.projectInstanceId
      ? (state.projects || []).find(item => item.instanceId === row.projectInstanceId) : null;
    const payrollKey = isConstruction && project ? "builders::" + project.instanceId : row.key;
    accrueWages(state, bookFor(payrollKey), jobAssignments(state, row.key), due, content);
    recordWageExpense(state, row, due, isConstruction ? "construction" : "operating", content);
    workerPay.push({ key: row.key, payrollKey, scope: row.scope, roleId: row.roleId, buildingId: row.buildingId || (isConstruction ? project?.instanceId : null), buildingName: row.buildingName || (isConstruction ? "施工工程" : null), name: row.name, count: row.count, rate, due, credit: 0, payable: due });
  }

  // 发薪：所有工资账（含已结束工程的旧账）到了发薪日都结清；付不清的计入欠薪，之后每天补付。
  const payDay = payDayFor(state, "town");
  const arrearsBefore = {};
  const maturedByKey = {};
  const paidByKey = {};
  for (const payrollKey of new Set([...Object.keys(payroll.creditorClaims), ...Object.keys(payroll.creditorPending)])) {
    const book = bookFor(payrollKey);
    arrearsBefore[payrollKey] = wageArrears(book);
    const construction = payrollKey.startsWith("builders::");
    const result = payWages(state, book, "town", content, construction ? "construction_wage_payment" : "wage_payment", "镇库发放工资", { payDay });
    maturedByKey[payrollKey] = result.matured || 0;
    paidByKey[payrollKey] = result.paid || 0;
    arrears[payrollKey] = wageArrears(book);
    if (!arrears[payrollKey]) delete arrears[payrollKey];
  }
  // 今天付的钱先算作还旧欠薪，再算作本月到期工资；"新增欠薪" = 今天到期却没付上的部分。
  const arrearsPaidByKey = {};
  const currentPaidByKey = {};
  for (const payrollKey of Object.keys(paidByKey)) {
    const fromArrears = Math.min(arrearsBefore[payrollKey] || 0, paidByKey[payrollKey]);
    arrearsPaidByKey[payrollKey] = fromArrears;
    currentPaidByKey[payrollKey] = paidByKey[payrollKey] - fromArrears;
  }
  const arrearsPaid = Object.values(arrearsPaidByKey).reduce((a, b) => a + b, 0);
  const currentPaid = Object.values(currentPaidByKey).reduce((a, b) => a + b, 0);
  const maturedToday = Object.values(maturedByKey).reduce((a, b) => a + b, 0);
  const unpaidCurrent = Math.max(0, maturedToday - currentPaid);
  const outstanding = Object.values(arrears).reduce((a, b) => a + b, 0);
  const expected = workerPay.reduce((sum, row) => sum + row.due, 0);
  const totalPaid = arrearsPaid + currentPaid;
  for (const group of [payroll.totals, payroll.year]) {
    group.paidVoucherUnits = (group.paidVoucherUnits || 0) + totalPaid;
    group.currentPaidVoucherUnits = (group.currentPaidVoucherUnits || 0) + currentPaid;
    group.arrearsPaidVoucherUnits = (group.arrearsPaidVoucherUnits || 0) + arrearsPaid;
    group.accruedVoucherUnits = (group.accruedVoucherUnits || 0) + expected;
    group.unpaidVoucherUnits = (group.unpaidVoucherUnits || 0) + Math.max(0, unpaidCurrent);
    group.paidWheatUnits = group.paidVoucherUnits; group.currentPaidWheatUnits = group.currentPaidVoucherUnits;
    group.arrearsPaidWheatUnits = group.arrearsPaidVoucherUnits; group.accruedWheatUnits = group.accruedVoucherUnits; group.unpaidWheatUnits = group.unpaidVoucherUnits;
  }
  payroll.totals.unpaidBalanceVoucherUnits = outstanding; payroll.totals.unpaidBalanceWheatUnits = outstanding;
  payroll.lastDay = {
    workers: workerPay.map(row => ({ key: row.key, payrollKey: row.payrollKey, roleId: row.roleId, buildingId: row.buildingId, name: row.buildingName ? row.buildingName + " · " + row.name : row.name, count: row.count, dailyRateVoucher: row.rate, dailyRateJin: row.rate, expectedVoucher: row.due / scale, expectedWheatJin: row.due / scale, prepaidCreditVoucher: row.credit / scale, prepaidCreditWheatJin: row.credit / scale, currentPaidVoucher: (currentPaidByKey[row.payrollKey] || 0) / scale, currentPaidWheatJin: (currentPaidByKey[row.payrollKey] || 0) / scale, arrearsPaidVoucher: (arrearsPaidByKey[row.payrollKey] || 0) / scale, arrearsPaidWheatJin: (arrearsPaidByKey[row.payrollKey] || 0) / scale, unpaidCurrentVoucher: Math.max(0, (maturedByKey[row.payrollKey] || 0) - (currentPaidByKey[row.payrollKey] || 0)) / scale, unpaidCurrentWheatJin: Math.max(0, (maturedByKey[row.payrollKey] || 0) - (currentPaidByKey[row.payrollKey] || 0)) / scale, arrearsBalanceVoucher: (arrears[row.payrollKey] || 0) / scale, arrearsBalanceWheatJin: (arrears[row.payrollKey] || 0) / scale })),
    expectedVoucher: expected / scale, expectedWheatJin: expected / scale, currentPaidVoucher: currentPaid / scale, currentPaidWheatJin: currentPaid / scale,
    arrearsPaidVoucher: arrearsPaid / scale, arrearsPaidWheatJin: arrearsPaid / scale, totalPaidVoucher: totalPaid / scale, totalPaidWheatJin: totalPaid / scale,
    unpaidCurrentVoucher: Math.max(0, unpaidCurrent) / scale, unpaidCurrentWheatJin: Math.max(0, unpaidCurrent) / scale, arrearsBalanceVoucher: outstanding / scale, arrearsBalanceWheatJin: outstanding / scale
  };
  if (unpaidCurrent > 0) recordEvent(state, `镇库支付能力不足，发薪日新增欠薪 ${(unpaidCurrent / scale).toLocaleString("zh-CN")}斤小麦等值。`, content, {
    day: state.day + 1, mergeKey: "town-wage-arrears", mergeWindowDays: 3, amount: unpaidCurrent,
    mergedText: (count, amount) => `近3日镇库支付能力不足，累计新增欠薪 ${(amount / scale).toLocaleString("zh-CN")}斤小麦等值（${count}次）。`
  });
  return payroll.lastDay;
}

export function payUnemploymentBenefit(state, laborAtStart, content) {
  const payroll = ensurePayroll(state);
  const policy = state.policy?.unemploymentBenefit;
  const scale = currencyScale(content);
  const idleRows = householdList(state).map(household => ({ household, idle: householdIdleWorkers(household) }))
    .filter(row => row.idle > 0);
  if (!policy?.enabled) {
    state.policy.lastDay = { eligible: laborAtStart.idle, eligibleHouseholds: idleRows.length, paidPeople: 0, uncoveredPeople: laborAtStart.idle, expectedVoucher: 0, paidVoucher: 0, shortVoucher: 0,
      expectedWheatJin: 0, paidWheatJin: 0, shortWheatJin: 0 };
    return state.policy.lastDay;
  }
  // 政策开启时才按"越穷越先领"排序；关闭时跳过排序省一次 O(n log n)。
  idleRows.sort((a, b) => {
    const af = householdFoodQeqUnits(state, a.household, content) / Math.max(1, householdPopulation(a.household));
    const bf = householdFoodQeqUnits(state, b.household, content) / Math.max(1, householdPopulation(b.household));
    return af - bf || (a.household.voucherUnits || 0) - (b.household.voucherUnits || 0) || a.household.id.localeCompare(b.household.id);
  });
  const perWorker = Math.max(0, Number(policy.dailyPerWorkerJin) || 0);
  const expectedUnits = Math.round(laborAtStart.idle * perWorker * scale);
  const perPersonUnits = Math.round(perWorker * scale);
  // 社保基金开启时，失业金由基金支付（不足部分镇库垫付并计入基金负债）；未开启时由镇库直付。
  const useFund = Boolean(ensureSocialSecurity(state).enabled);
  let paid = 0;
  let paidPeople = 0;
  for (const row of idleRows) {
    if (perPersonUnits <= 0) break;
    const due = row.idle * perPersonUnits;
    const rowPaid = useFund
      ? payFromFund(state, row.household.id, due, content, "unemployment_benefit", "社保基金发放失业金").paidValueUnits
      : (settleMonetaryPayment(state, "town", `household:${row.household.id}`, currentPaymentComposition(state, due), content,
        "unemployment_benefit", "劳动年龄待业者失业金；镇库不足时优先口粮与货币储备更少的家庭",
        { requireFull: false }).paidValueUnits || 0);
    paid += rowPaid;
    paidPeople += Math.min(row.idle, Math.floor(rowPaid / perPersonUnits));
  }
  const short = Math.max(0, expectedUnits - paid);
  payroll.totals.unemploymentPaidVoucherUnits = (payroll.totals.unemploymentPaidVoucherUnits || 0) + paid;
  payroll.year.unemploymentPaidVoucherUnits = (payroll.year.unemploymentPaidVoucherUnits || 0) + paid;
  payroll.totals.unemploymentPaidWheatUnits = payroll.totals.unemploymentPaidVoucherUnits;
  payroll.year.unemploymentPaidWheatUnits = payroll.year.unemploymentPaidVoucherUnits;
  state.policy.lastDay = { eligible: laborAtStart.idle, eligibleHouseholds: idleRows.length, paidPeople, uncoveredPeople: Math.max(0, laborAtStart.idle - paidPeople),
    expectedVoucher: expectedUnits / scale, paidVoucher: paid / scale, shortVoucher: short / scale,
    expectedWheatJin: expectedUnits / scale, paidWheatJin: paid / scale, shortWheatJin: short / scale };
  if (short > 0) {
    recordLedger(state, { type: "unemployment_shortfall", transactionId: makeTransactionId(state),
      source: "town", destination: "unpaid", itemId: "money_value", quantityUnits: short, qeqUnits: 0,
      reason: "镇库可支付资产不足；失业金不足部分不形成债务" }, content);
  }
  return state.policy.lastDay;
}

