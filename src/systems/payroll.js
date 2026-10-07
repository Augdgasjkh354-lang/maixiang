import { addWageExpense } from "../economy/business.js";
import { currencyScale } from "../economy/currency.js";
import { addPaymentObligation, currentPaymentComposition, normalizePaymentObligation, settleMonetaryPayment } from "../economy/payment.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { jobAssignments, householdList, householdIdleWorkers, householdPopulation, householdFoodQeqUnits, syncResidentAggregates } from "./households.js";
import { allocateIntegerByWeight } from "../core/allocation.js";
import { recordHouseholdWageDue } from "./household-life.js";
import { attributeLegacyUnattributedWageClaims } from "./wage-claims.js";
import { collectSocialContributions, ensureSocialSecurity, payFromFund } from "./social-security.js";

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

function householdAllocationForJob(state, jobKey) {
  const weights = Object.fromEntries(jobAssignments(state, jobKey).map(row => [row.householdId, row.count]));
  return { householdIds: Object.keys(weights), weights };
}

function claimMapTotal(claims) {
  return Object.values(claims || {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

function attributeLegacyTownWageClaims(state, payroll) {
  payroll.creditorClaims ||= {};
  payroll.creditorPaymentClaims ||= {};
  payroll.legacyUnattributedArrearsVoucherUnits ||= {};
  payroll.legacyUnattributedPaymentClaims ||= {};
  const keys = new Set([
    ...Object.keys(payroll.arrearsVoucherUnits || {}),
    ...Object.keys(payroll.legacyUnattributedArrearsVoucherUnits || {})
  ]);
  for (const payrollKey of [...keys].sort()) {
    const totalArrears = Math.max(0, Math.round(Number(payroll.arrearsVoucherUnits?.[payrollKey]) || 0));
    const claims = payroll.creditorClaims[payrollKey] ||= {};
    const paymentClaims = payroll.creditorPaymentClaims[payrollKey] ||= {};
    const unrepresented = Math.max(0, totalArrears - claimMapTotal(claims));
    if (unrepresented <= 0) {
      delete payroll.legacyUnattributedArrearsVoucherUnits[payrollKey];
      delete payroll.legacyUnattributedPaymentClaims[payrollKey];
      continue;
    }
    // 历史版本可能只保存岗位总欠薪，没有债权家庭。当前岗位仍在时按原岗位分配；
    // 岗位已撤销/退休时由兼容分配器落到仍存在的家庭账户，保证债务有可偿还对象。
    const owner = { claimsVoucherUnits: claims, claimsPayment: paymentClaims };
    const currentJobKey = payrollKey.startsWith("builders::") ? "builders" : payrollKey;
    const result = attributeLegacyUnattributedWageClaims(state, owner, unrepresented, jobAssignments(state, currentJobKey));
    const remaining = Math.max(0, totalArrears - claimMapTotal(claims));
    if (remaining > 0) {
      payroll.legacyUnattributedArrearsVoucherUnits[payrollKey] = remaining;
      payroll.legacyUnattributedPaymentClaims[payrollKey] = { valueUnits: remaining, wheatValueUnits: 0, voucherValueUnits: remaining };
    } else {
      delete payroll.legacyUnattributedArrearsVoucherUnits[payrollKey];
      delete payroll.legacyUnattributedPaymentClaims[payrollKey];
    }
    if (result.attributed <= 0) continue;
  }
}

export function payDailyWages(state, laborAtStart, content) {
  const payroll = ensurePayroll(state);
  payroll.creditorClaims ||= {};
  payroll.creditorPaymentClaims ||= {};
  const arrears = payroll.arrearsVoucherUnits;

  // 商业街岗位由各店铺自己的工资债权/统一支付链承担。r03 曾把商业街的聚合展示行
  // 错送入镇库工资循环，且该聚合 key 没有家庭分配，形成“只有总欠薪、没有债权人”的幽灵欠薪。
  // 这里只清理由内容定义明确标记为 shop 的聚合 key，不触碰任何真实镇营岗位债权。
  const invalidShopPayrollKeys = new Set(laborAtStart.rows.filter(item => item.scope === "shop").map(row => row.key));
  // 即使商业街建筑后来已拆除，r03 遗留的聚合岗位 key 仍可辨认；这些岗位从未应由镇库承担。
  for (const key of Object.keys(arrears)) {
    if (key.endsWith("::merchants") || key.endsWith("::shop_clerks")) invalidShopPayrollKeys.add(key);
  }
  for (const payrollKey of invalidShopPayrollKeys) {
    delete arrears[payrollKey];
    delete payroll.creditorClaims[payrollKey];
    delete payroll.creditorPaymentClaims[payrollKey];
    delete payroll.legacyUnattributedArrearsVoucherUnits?.[payrollKey];
    delete payroll.legacyUnattributedPaymentClaims?.[payrollKey];
    const prefix = `town-wage:${payrollKey}:`;
    for (const key of Object.keys(state.monetaryReform?.voucherShortfallByKey || {})) {
      if (key.startsWith(prefix)) delete state.monetaryReform.voucherShortfallByKey[key];
    }
  }

  attributeLegacyTownWageClaims(state, payroll);
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
  const builderCreditFor = row => row.projectInstanceId
    ? ((state.projects || []).find(project => project.instanceId === row.projectInstanceId)?.prepaidWageCreditUnits || 0)
    : 0;
  const workerPay = [];
  const oldClaimTotals = {};
  const arrearsPaidByKey = {};
  const currentPaidByKey = {};
  const currentDue = {};

  // 历史债权先独立偿付，不依赖当前岗位、工资设置或建筑是否还存在。
  // 债权的付款构成保存在 creditorPaymentClaims 中；统一支付层会按原构成继续结算并同步改革缺券记录。
  for (const payrollKey of Object.keys(payroll.creditorClaims).sort()) {
    const claims = payroll.creditorClaims[payrollKey] || {};
    const paymentClaims = payroll.creditorPaymentClaims[payrollKey] ||= {};
    oldClaimTotals[payrollKey] = Object.values(claims).reduce((sum, value) => sum + (value || 0), 0);
    let paidKey = 0;
    const payer = "town";
    for (const householdId of Object.keys(claims).sort()) {
      const amount = claims[householdId] || 0;
      if (amount <= 0) continue;
      const obligation = normalizePaymentObligation(paymentClaims[householdId] || amount, state);
      const construction = payrollKey.startsWith("builders::");
      const result = settleMonetaryPayment(state, payer, `household:${householdId}`, obligation, content,
        construction ? "construction_wage_arrears_payment" : "wage_arrears_payment", "偿付原债权家庭历史欠薪",
        { requireFull: false, trackUnpaid: true, shortfallKey: `${payer}-wage:${payrollKey}:${householdId}` });
      const paid = result.paidValueUnits || 0;
      claims[householdId] = Math.max(0, amount - paid);
      paymentClaims[householdId] = result.remainingComposition;
      arrears[payrollKey] = Math.max(0, (arrears[payrollKey] || 0) - paid);
      paidKey += paid;
    }
    arrearsPaidByKey[payrollKey] = paidKey;
  }

  // 历史债权处理后，才计提今天的工资费用与家庭债权；不会因偿还旧债重复计费。
  for (const row of rows) {
    const baseRate = Number.isFinite(row.wagePerWorkerDay) ? row.wagePerWorkerDay : (state.employment.wageRates?.[row.roleId] ?? 0);
    // 工资统一调控：按公务员类 / 镇营产业类系数调整实际计提日薪。
    const rate = baseRate * wageControlFactor(state, row.roleId);
    const due = Math.round(Math.max(0, row.count * rate) * scale);
    if (!due) continue;
    const isConstruction = row.key === "builders";
    const builderCredit = isConstruction ? builderCreditFor(row) : 0;
    const credit = isConstruction ? Math.min(due, builderCredit) : 0;
    const project = isConstruction && row.projectInstanceId
      ? (state.projects || []).find(item => item.instanceId === row.projectInstanceId) : null;
    if (credit && project) project.prepaidWageCreditUnits -= credit;
    const payable = due - credit;
    const payrollKey = isConstruction && project ? "builders::" + project.instanceId : row.key;
    const claims = payroll.creditorClaims[payrollKey] ||= {};
    const paymentClaims = payroll.creditorPaymentClaims[payrollKey] ||= {};
    oldClaimTotals[payrollKey] ??= 0;
    arrearsPaidByKey[payrollKey] ||= 0;
    const allocationByHousehold = householdAllocationForJob(state, row.key);
    const weights = allocationByHousehold.weights;
    const households = allocationByHousehold.householdIds.map(id => state.households?.byId?.[id]).filter(Boolean);
    const allocation = allocateIntegerByWeight(payable, households, household => weights[household.id] || 0);
    if (allocation.ok) for (const { recipient: household, units } of allocation.rows) {
      claims[household.id] = (claims[household.id] || 0) + units;
      paymentClaims[household.id] = addPaymentObligation(paymentClaims[household.id], currentPaymentComposition(state, units));
      recordHouseholdWageDue(state, household.id, units, content);
    }
    currentDue[payrollKey] = (currentDue[payrollKey] || 0) + payable;
    arrears[payrollKey] = (arrears[payrollKey] || 0) + payable;
    recordWageExpense(state, row, payable, isConstruction ? "construction" : "operating", content);
    if (credit > 0) recordLedger(state, { type: "wage_prepaid_credit", transactionId: makeTransactionId(state), source: project.instanceId, destination: "construction_payroll", itemId: "legacy_prepaid_wage", quantityUnits: credit, qeqUnits: 0, reason: "旧版工程已预付工资抵扣本日应付；不再次支付" }, content);
    workerPay.push({ key: row.key, payrollKey, scope: row.scope, roleId: row.roleId, buildingId: row.buildingId || (isConstruction ? project?.instanceId : null), buildingName: row.buildingName || (isConstruction ? "施工工程" : null), name: row.name, count: row.count, rate, due, credit, payable });
  }

  // 再处理当日工资。若同一债权家庭仍有历史余额，统一债权表天然保持旧债在前一次偿付后留下的余额，且改革缺券键仍使用同一债权键。
  const paidByHousehold = {};
  for (const row of workerPay) {
    const claims = payroll.creditorClaims[row.payrollKey] || {};
    const paymentClaims = payroll.creditorPaymentClaims[row.payrollKey] ||= {};
    let paidKey = 0;
    const payer = "town";
    const paidRows = (paidByHousehold[row.payrollKey] ||= {});
    for (const householdId of Object.keys(claims).sort()) {
      const amount = claims[householdId] || 0;
      if (amount <= 0) continue;
      const obligation = normalizePaymentObligation(paymentClaims[householdId] || amount, state);
      const result = settleMonetaryPayment(state, payer, `household:${householdId}`, obligation, content,
        row.key === "builders" ? "construction_wage_payment" : "wage_payment", "支付具体债权家庭本日工资",
        { requireFull: false, trackUnpaid: true, shortfallKey: `${payer}-wage:${row.payrollKey}:${householdId}` });
      const paid = result.paidValueUnits || 0;
      paymentClaims[householdId] = result.remainingComposition;
      claims[householdId] = Math.max(0, amount - paid);
      arrears[row.payrollKey] = Math.max(0, (arrears[row.payrollKey] || 0) - paid);
      paidKey += paid;
      if (paid > 0) paidRows[householdId] = (paidRows[householdId] || 0) + paid;
    }
    const historicalRemainingBeforeCurrent = Math.max(0, (oldClaimTotals[row.payrollKey] || 0) - (arrearsPaidByKey[row.payrollKey] || 0));
    const historicalPaidNow = Math.min(historicalRemainingBeforeCurrent, paidKey);
    arrearsPaidByKey[row.payrollKey] = (arrearsPaidByKey[row.payrollKey] || 0) + historicalPaidNow;
    currentPaidByKey[row.payrollKey] = (currentPaidByKey[row.payrollKey] || 0) + Math.max(0, paidKey - historicalPaidNow);
  }

  // 社保收缴：基金开启时，从本日实际发放的工资中按人头代扣缴费。
  const socialCollected = collectSocialContributions(state, workerPay, currentPaidByKey, paidByHousehold, content);

  const arrearsPaid = Object.values(arrearsPaidByKey).reduce((a,b)=>a+b,0);
  const currentPaid = Object.values(currentPaidByKey).reduce((a,b)=>a+b,0);
  const unpaidCurrent = Object.values(currentDue).reduce((a,b)=>a+b,0) - currentPaid;
  const outstanding = Object.values(arrears).reduce((a,b)=>a+b,0);
  const expected = rows.reduce((sum, row) => {
    const baseRate = Number.isFinite(row.wagePerWorkerDay) ? row.wagePerWorkerDay : (state.employment.wageRates?.[row.roleId] ?? 0);
    return sum + Math.round(Math.max(0, row.count * baseRate * wageControlFactor(state, row.roleId)) * scale);
  }, 0);
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
    workers: workerPay.map(row => ({ key: row.key, payrollKey: row.payrollKey, roleId: row.roleId, buildingId: row.buildingId, name: row.buildingName ? row.buildingName + " · " + row.name : row.name, count: row.count, dailyRateVoucher: row.rate, dailyRateJin: row.rate, expectedVoucher: row.due / scale, expectedWheatJin: row.due / scale, prepaidCreditVoucher: row.credit / scale, prepaidCreditWheatJin: row.credit / scale, currentPaidVoucher: (currentPaidByKey[row.payrollKey] || 0) / scale, currentPaidWheatJin: (currentPaidByKey[row.payrollKey] || 0) / scale, arrearsPaidVoucher: (arrearsPaidByKey[row.payrollKey] || 0) / scale, arrearsPaidWheatJin: (arrearsPaidByKey[row.payrollKey] || 0) / scale, unpaidCurrentVoucher: Math.max(0, row.payable - (currentPaidByKey[row.payrollKey] || 0)) / scale, unpaidCurrentWheatJin: Math.max(0, row.payable - (currentPaidByKey[row.payrollKey] || 0)) / scale, arrearsBalanceVoucher: (arrears[row.payrollKey] || 0) / scale, arrearsBalanceWheatJin: (arrears[row.payrollKey] || 0) / scale })),
    expectedVoucher: expected / scale, expectedWheatJin: expected / scale, currentPaidVoucher: currentPaid / scale, currentPaidWheatJin: currentPaid / scale,
    arrearsPaidVoucher: arrearsPaid / scale, arrearsPaidWheatJin: arrearsPaid / scale, totalPaidVoucher: totalPaid / scale, totalPaidWheatJin: totalPaid / scale,
    unpaidCurrentVoucher: Math.max(0, unpaidCurrent) / scale, unpaidCurrentWheatJin: Math.max(0, unpaidCurrent) / scale, arrearsBalanceVoucher: outstanding / scale, arrearsBalanceWheatJin: outstanding / scale
  };
  if (unpaidCurrent > 0) recordEvent(state, `镇库支付能力不足，本日新增欠薪 ${(unpaidCurrent / scale).toLocaleString("zh-CN")}斤小麦等值。`, content, {
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
        { requireFull: false, countsForReform: true }).paidValueUnits || 0);
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

