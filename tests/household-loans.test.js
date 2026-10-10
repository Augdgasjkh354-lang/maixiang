// 民间贷款（docs/LENDING.md 测试清单 1—11）：银行向住户放贷（开店启动资金、购房），月供还款，欠期与补还，
// 整户无人核销，利率固定，净家底口径，存档往返，长期模拟守恒。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdList, householdIdleWorkers, householdPopulation, syncResidentAggregates } from "../src/systems/households.js";
import { issueTownVouchers, totalVoucherBalances, transferVouchers, voucherBalance } from "../src/economy/currency.js";
import { settleBankDay, bankLedgerInvariant, bankLoanableVoucherUnits, bankPolicy, ensureBankState } from "../src/systems/bank.js";
import {
  quoteHouseholdLoan, issueHouseholdLoan, cancelHouseholdLoan,
  householdFoodReserveVoucherUnits, householdLiquidValueUnits, householdLoanInstalmentUnits, householdLoanBalanceUnits
} from "../src/systems/household-loans.js";
import { settleVillaPurchases, setVillaPolicy } from "../src/systems/villas.js";
import { openResidentShop } from "../src/core/commands.js";
import { settleEscheat, wealthDistributionRows } from "../src/systems/redistribution.js";
import { householdGrossWealthUnits, householdWealthUnits } from "../src/systems/household-budget.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { setHouseholdVoucherUnits } from "./helpers-monetary.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;
const DAYS = CONTENT.rules.daysPerYear || 360;

// 带覆盖项的内容副本（CONTENT 冻结，不能直接改 rules.lending）。
function lendingContent(overrides) {
  return { ...CONTENT, rules: { ...CONTENT.rules, lending: { ...CONTENT.rules.lending, ...overrides } } };
}

// 新开局 + 银行（建成即可用）。
function bankState(seed) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "bank-loan", "bank", 0);
  return state;
}

function addBuilding(state, id, typeId, plotIndex) {
  const plot = state.plots.filter(row => !row.feature)[plotIndex];
  state.buildings.push({ id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
}

// 让银行有现金：镇库注资（粮券从镇库转入银行，留存利润同额增加，台账守恒；不增加住户存款，免得住户因存款而买得起）。
function fundBank(state, units) {
  ensureBankState(state);
  assert.equal(issueTownVouchers(state, units, CONTENT, "测试：镇库注资银行").ok, true);
  assert.equal(transferVouchers(state, "town", "bank", units, CONTENT, "test_bank_capital", "测试：镇库注资").ok, true);
  state.bank.retainedVoucherUnits += units;
  assert.equal(bankLedgerInvariant(state).valid, true);
}

// 其余住户粮券清零（移到镇库），让测试对象是唯一有钱的人；所有住户的小麦也清空（超额小麦计入可动用资金）。
function onlyHousehold(state, target, units) {
  for (const household of householdList(state)) {
    if (household.id !== target.id) setHouseholdVoucherUnits(state, household, 0);
    household.inventory.wheat = 0;
  }
  setHouseholdVoucherUnits(state, target, units);
}

// 只清空这一户的小麦（不动粮券）。
function noSurplusWheat(state, household) {
  household.inventory.wheat = 0;
  syncResidentAggregates(state, CONTENT);
}

// 夹具：给足日收入（还款能力不是本测试的重点，别让收入上限抢先生效）。
function setIncome(household, unitsPerDay) {
  household.recentIncomeUnits = unitsPerDay;
}

// 按缺口放款：需要的钱 = 现有可动用总值 + 缺口。夹具里顺带给足收入。
function issueGap(state, household, purpose, gapUnits) {
  setIncome(household, 1000 * V);
  const need = householdLiquidValueUnits(state, household, CONTENT) + gapUnits;
  return issueHouseholdLoan(state, household.id, purpose, need, CONTENT);
}

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, (check.errors || []).join("；"));
}

function advanceBankDays(state, days) {
  for (let i = 0; i < days; i += 1) {
    state.day += 1;
    if (state.day >= DAYS) { state.day = 0; state.year += 1; }
    settleBankDay(state, CONTENT);
  }
}

function loanOf(state, id) {
  return state.bank.loans.find(loan => loan.id === id);
}

// 1. 发放：额度各上限分别生效；放款后粮券总量不变，银行台账守恒。
test("1 发放额度：各上限分别生效；放款后粮券总量不变、台账守恒", () => {
  const state = bankState(101);
  fundBank(state, 100000 * V);
  const target = householdList(state)[1];
  setHouseholdVoucherUnits(state, target, 2000 * V);
  noSurplusWheat(state, target);
  setIncome(target, 100 * V);
  const need = 3000 * V;
  const quote = quoteHouseholdLoan(state, target.id, "shop", need, CONTENT);
  assert.equal(quote.ok, true, quote.reason);
  assert.equal(quote.gapUnits, need - householdLiquidValueUnits(state, target, CONTENT), "缺口 = 需要 − 可动用总值");
  assert.equal(quote.covers, true, "资金充裕时能补齐整个缺口");
  assert.equal(quote.amountUnits, quote.gapUnits, "额度取缺口");

  // 单户余额上限：maxPerHouseholdJin 很小 → 该项最紧。
  const perHousehold = quoteHouseholdLoan(state, target.id, "shop", need, lendingContent({ maxPerHouseholdJin: 1 }));
  assert.equal(perHousehold.limit, "perHousehold");
  // 负债占家底上限为零 → 不放。
  const debtRatio = quoteHouseholdLoan(state, target.id, "shop", need, lendingContent({ maxDebtToWealthShare: 0 }));
  assert.equal(debtRatio.ok, false);
  assert.equal(debtRatio.limit, "debtToWealth");
  // 还款能力为零（月供占收入上限为 0）→ 不放。
  const service = quoteHouseholdLoan(state, target.id, "shop", need, lendingContent({ maxServiceShareOfIncome: 0 }));
  assert.equal(service.ok, false);
  assert.equal(service.limit, "serviceCapacity");
  // 银行可贷额度：抽干银行现金（经真实转账付给一户，同时冲减留存利润，台账守恒）。
  const cash = state.bank.cashVoucherUnits;
  const drained = transferVouchers(state, "bank", `household:${householdList(state)[2].id}`, cash, CONTENT, "test_drain", "测试：银行现金流失");
  assert.equal(drained.ok, true);
  state.bank.retainedVoucherUnits -= cash;
  assert.equal(bankLoanableVoucherUnits(state), 0);
  const drainedQuote = quoteHouseholdLoan(state, target.id, "shop", need, CONTENT);
  assert.equal(drainedQuote.ok, false);
  assert.equal(drainedQuote.limit, "bankLoanable");
  // 恢复现金后放款：粮券总量不变，台账守恒，住户可动用总值增加放款额。
  assert.equal(transferVouchers(state, `household:${householdList(state)[2].id}`, "bank", cash, CONTENT, "test_restore", "测试：现金归还").ok, true);
  state.bank.retainedVoucherUnits += cash;
  assert.equal(bankLedgerInvariant(state).valid, true);
  const totalBefore = totalVoucherBalances(state);
  const liquidBefore = householdLiquidValueUnits(state, target, CONTENT);
  const issued = issueHouseholdLoan(state, target.id, "shop", need, CONTENT);
  assert.equal(issued.ok, true, issued.reason);
  assert.equal(totalVoucherBalances(state), totalBefore, "放款只是银行现金转入住户，粮券总量不变");
  assert.equal(householdLiquidValueUnits(state, target, CONTENT) - liquidBefore, issued.amountUnits);
  assert.equal(bankLedgerInvariant(state).valid, true);
  valid(state);
});

// 2. 开店：没人付得起启动资金时，贷款补缺口后开成店；开店失败当天冲销，无残留贷款。
test("2 开店：贷款补缺口后开成店；开店失败当天冲销，无残留贷款", () => {
  const state = bankState(102);
  addBuilding(state, "street-loan", "commercial_street", 1);
  fundBank(state, 50000 * V);
  // 所有人都没钱；目标户手头 200 券（启动资金 + 生活储备，凑不齐）。
  const target = householdList(state).find(household => householdIdleWorkers(household) > 0);
  onlyHousehold(state, target, 200 * V);
  setIncome(target, 1000 * V);
  const opened = openResidentShop(state, "street-loan", "general", target.id, CONTENT);
  assert.equal(opened.ok, true, opened.reason);
  const loan = state.bank.loans.find(row => row.borrowerKind === "household" && row.borrowerId === target.id);
  assert.ok(loan, "应放出一笔开店贷款");
  assert.equal(loan.purpose, "shop");
  assert.equal(loan.termMonths, 24);
  assert.ok(state.shops[opened.shopId], "店铺已开");
  valid(state);

  // 足额时不借款。
  const rich = bankState(103);
  addBuilding(rich, "street-rich", "commercial_street", 1);
  fundBank(rich, 50000 * V);
  const richHolder = householdList(rich).find(household => householdIdleWorkers(household) > 0);
  onlyHousehold(rich, richHolder, 2000 * V);
  assert.equal(openResidentShop(rich, "street-rich", "general", richHolder.id, CONTENT).ok, true);
  assert.equal(rich.bank.loans.length, 0, "足额时不借款");
  valid(rich);

  // 同日冲销：放款后原路退回，粮券与台账复原，贷款记录消失。
  const cancelState = bankState(104);
  fundBank(cancelState, 50000 * V);
  const holder = householdList(cancelState)[4];
  setHouseholdVoucherUnits(cancelState, holder, 1000 * V);
  noSurplusWheat(cancelState, holder);
  const issued = issueGap(cancelState, holder, "shop", 500 * V);
  assert.equal(issued.ok, true, issued.reason);
  const totalBefore = totalVoucherBalances(cancelState);
  const cancelled = cancelHouseholdLoan(cancelState, issued.loan.id, CONTENT);
  assert.equal(cancelled.ok, true, cancelled.reason);
  assert.equal(cancelState.bank.loans.length, 0, "无残留贷款");
  assert.equal(cancelState.bank.stats.loansIssuedCount, 0);
  assert.equal(voucherBalance(cancelState, `household:${holder.id}`), 1000 * V, "钱原路退回，回到放款前的余额");
  assert.equal(totalVoucherBalances(cancelState), totalBefore);
  valid(cancelState);
});

// 3. 别墅：资金不足的候选借款买下别墅。
test("3 别墅：资金不足的候选借款买下别墅", () => {
  const state = bankState(105);
  addBuilding(state, "villa-loan", "villa_complex", 1);
  fundBank(state, 50000 * V);
  setVillaPolicy(state, { priceWheatJin: 1000 });
  const target = householdList(state)[5];
  onlyHousehold(state, target, 800 * V);
  setIncome(target, 1000 * V);
  const sold = settleVillaPurchases(state, CONTENT);
  assert.equal(sold.sold, 1, "借款后买下一栋");
  assert.ok(state.villas.sold.find(entry => entry.householdId === target.id), "别墅归该户");
  const loan = state.bank.loans.find(entry => entry.borrowerId === target.id);
  assert.equal(loan.purpose, "villa");
  assert.equal(loan.termMonths, 60);
  valid(state);
});

// 4. 月供：全额按期还，12 期后余额与等额本息一致（误差 ≤ 期数，单位券）；末期结清为 repaid。
test("[slow] 4 月供：全额按期还，12 期后余额与等额本息一致，末期结清为 repaid", () => {
  const state = bankState(106);
  fundBank(state, 200000 * V);
  const target = householdList(state)[6];
  setHouseholdVoucherUnits(state, target, 50000 * V);
  const issued = issueGap(state, target, "shop", 10000 * V);
  assert.equal(issued.ok, true, issued.reason);
  const loanId = issued.loan.id;
  const principal = issued.amountUnits;
  const rate = issued.loan.rateAnnualPercent / 100 / 12;
  const instalment = issued.loan.instalmentVoucherUnits;
  assert.equal(instalment, householdLoanInstalmentUnits(principal, issued.loan.rateAnnualPercent, 24));
  advanceBankDays(state, 12 * 30);
  const loan = loanOf(state, loanId);
  assert.equal(loan.missedInstalments, 0, "全额按期还，无欠期");
  assert.equal(loan.status, "active");
  // 等额本息余额：B_k = P(1+r)^k − I((1+r)^k − 1)/r。
  const k = 12;
  const expected = principal * Math.pow(1 + rate, k) - instalment * ((Math.pow(1 + rate, k) - 1) / rate);
  const tolerance = k * V;
  assert.ok(Math.abs(loan.outstandingVoucherUnits - expected) <= tolerance,
    `余额 ${loan.outstandingVoucherUnits / V} 券 应接近公式 ${expected / V} 券（误差 ≤ ${k} 券）`);
  advanceBankDays(state, 12 * 30);
  assert.equal(loanOf(state, loanId).status, "repaid", "24 期还清");
  assert.equal(loanOf(state, loanId).outstandingVoucherUnits, 0);
  assert.equal(householdLoanBalanceUnits(state, target.id), 0);
  valid(state);
});

// 5. 还不起：欠期累加、不关店；之后有富余自动补还，欠期清零。
test("5 欠期：欠期累加不关店；有富余后自动补还，欠期清零", () => {
  const state = bankState(107);
  fundBank(state, 100000 * V);
  const target = householdList(state)[7];
  setHouseholdVoucherUnits(state, target, 20000 * V);
  const issued = issueGap(state, target, "shop", 5000 * V);
  assert.equal(issued.ok, true, issued.reason);
  const loanId = issued.loan.id;
  const instalment = issued.loan.instalmentVoucherUnits;
  // 到期前清空住户（粮券与存款），到期时付不出。
  setHouseholdVoucherUnits(state, target, 0);
  state.bank.deposits[target.id] = 0;
  advanceBankDays(state, 30);
  let loan = loanOf(state, loanId);
  assert.equal(loan.missedInstalments, 1, "到期付不出，欠一期");
  assert.equal(loan.status, "active", "不关店、不收资产，贷款仍挂着");
  assert.ok(loan.overdueDays >= 1);
  // 再过一期仍付不出：欠期累加。
  advanceBankDays(state, 30);
  loan = loanOf(state, loanId);
  assert.equal(loan.missedInstalments, 2, "欠期累加");
  // 有富余：当天就补还欠款（欠期清零）。
  setHouseholdVoucherUnits(state, target, 20000 * V);
  const outstandingBefore = loan.outstandingVoucherUnits;
  advanceBankDays(state, 1);
  loan = loanOf(state, loanId);
  assert.equal(loan.missedInstalments, 0, "有富余后欠期清零");
  assert.ok(outstandingBefore - loan.outstandingVoucherUnits >= instalment, "补还至少一期");
  assert.equal(loan.overdueDays, 0);
  valid(state);
});

// 6. 口粮保护：还款后住户仍留够 30 天口粮钱。
test("6 口粮保护：还款后住户仍留够 30 天口粮钱", () => {
  const state = bankState(108);
  fundBank(state, 100000 * V);
  const target = householdList(state)[8];
  setHouseholdVoucherUnits(state, target, 20000 * V);
  const issued = issueGap(state, target, "shop", 5000 * V);
  assert.equal(issued.ok, true, issued.reason);
  const reserve = householdFoodReserveVoucherUnits(state, target, CONTENT);
  assert.ok(reserve > 0, "有口粮钱");
  const instalment = issued.loan.instalmentVoucherUnits;
  // 手头只比口粮钱多半期月供：付不足整期，但不能动口粮钱。
  setHouseholdVoucherUnits(state, target, reserve + Math.floor(instalment / 2));
  state.bank.deposits[target.id] = 0;
  advanceBankDays(state, 30);
  assert.ok(target.voucherUnits + (state.bank.deposits[target.id] || 0) >= reserve, "还款后手头 + 存款仍不少于 30 天口粮钱");
  assert.equal(loanOf(state, issued.loan.id).missedInstalments, 1, "不够付整期，记一期欠期");
  valid(state);
});

// 7. 整户无人：剩余核销，留存利润减少，台账守恒，validateState 通过。
test("7 整户无人：剩余余额核销，留存利润减少，台账守恒", () => {
  const state = bankState(109);
  fundBank(state, 100000 * V);
  const target = householdList(state)[9];
  setHouseholdVoucherUnits(state, target, 20000 * V);
  const issued = issueGap(state, target, "shop", 5000 * V);
  assert.equal(issued.ok, true, issued.reason);
  const loanId = issued.loan.id;
  // 手头只有 1000 券：整户无人时先还这一部分，其余核销。
  setHouseholdVoucherUnits(state, target, 1000 * V);
  state.bank.deposits[target.id] = 0;
  const retainedBefore = state.bank.retainedVoucherUnits;
  const badBefore = state.bank.stats.badDebtVoucherUnits;
  // 整户去世：人口并入邻户（总人口不变，cohort 守恒），本户职务清空、人口归零。
  const neighbour = householdList(state)[13];
  for (const band of ["children", "workers", "elders"]) neighbour.ageBands[band] += target.ageBands[band];
  target.ageBands = { children: 0, workers: 0, elders: 0 };
  target.jobs = {};
  assert.equal(bankLedgerInvariant(state).valid, true);
  settleEscheat(state, CONTENT);
  const loan = loanOf(state, loanId);
  assert.equal(loan.status, "written_off");
  assert.equal(loan.outstandingVoucherUnits, 0);
  const rest = issued.amountUnits - 1000 * V;
  assert.ok(state.bank.stats.badDebtVoucherUnits - badBefore >= rest, "剩余计入坏账");
  assert.ok(state.bank.retainedVoucherUnits < retainedBefore, "留存利润减少");
  assert.equal(bankLedgerInvariant(state).valid, true, "台账守恒");
  valid(state);
});

// 8. 利率：政策利率调整不影响已发放贷款；新开局默认 5%。
test("8 利率：政策调整不影响已发放贷款；新开局默认 5%", () => {
  const state = bankState(110);
  assert.equal(bankPolicy(state).loanRateAnnualPercent, 5, "新开局默认贷款利率 5%");
  fundBank(state, 100000 * V);
  const target = householdList(state)[10];
  setHouseholdVoucherUnits(state, target, 20000 * V);
  const issued = issueGap(state, target, "shop", 5000 * V);
  assert.equal(issued.ok, true, issued.reason);
  const loanId = issued.loan.id;
  state.policy.bank.loanRateAnnualPercent = 20;
  const before = loanOf(state, loanId).outstandingVoucherUnits;
  settleBankDay(state, CONTENT);
  const grown = loanOf(state, loanId).outstandingVoucherUnits - before;
  assert.equal(grown, Math.floor(before * (5 / 100 / DAYS)), "日计息按发放时的 5%，不随政策变化");
  assert.equal(loanOf(state, loanId).rateAnnualPercent, 5);
  valid(state);
});

// 9. 净家底：有贷款的住户税基口径下降；净家底下限 0。
test("9 净家底：贷款压低税基与宽裕度口径，下限为 0", () => {
  const state = bankState(111);
  fundBank(state, 100000 * V);
  const target = householdList(state)[11];
  setHouseholdVoucherUnits(state, target, 20000 * V);
  const gross = householdWealthUnits(state, target, CONTENT);
  const row = () => wealthDistributionRows(state, CONTENT).find(entry => entry.householdId === target.id);
  const taxBefore = row().wealth;
  const issued = issueGap(state, target, "shop", 5000 * V);
  assert.equal(issued.ok, true, issued.reason);
  // 放款后手头增加、负债相同：净家底不变（借来的钱还在身上）。
  assert.equal(householdWealthUnits(state, target, CONTENT), gross, "放款后净家底不变");
  assert.equal(row().wealth, taxBefore, "放款后税基不变");
  // 人为把负债放大到超过家底：净家底与税基下限为 0。
  const loan = loanOf(state, issued.loan.id);
  const grossNow = householdGrossWealthUnits(state, target, CONTENT);
  loan.outstandingVoucherUnits = grossNow + 1000 * V;
  loan.principalVoucherUnits = grossNow + 1000 * V;
  assert.equal(householdWealthUnits(state, target, CONTENT), 0, "净家底下限 0");
  assert.equal(row().wealth, 0, "税基下限 0");
});

// 10. 存档往返：带住户贷款的存档读回一致；旧档无这些字段正常读。
test("10 存档往返：带住户贷款的存档读回一致；旧档无贷款字段照常读", () => {
  const state = bankState(112);
  fundBank(state, 100000 * V);
  const target = householdList(state)[12];
  setHouseholdVoucherUnits(state, target, 20000 * V);
  const issued = issueGap(state, target, "shop", 5000 * V);
  assert.equal(issued.ok, true, issued.reason);
  const raw = JSON.parse(JSON.stringify(state));
  const read = migrateSave(raw, CONTENT);
  const loanBack = read.bank.loans.find(loan => loan.id === issued.loan.id);
  assert.deepEqual(loanBack, JSON.parse(JSON.stringify(issued.loan)), "贷款记录往返一致");
  assert.equal(householdLoanBalanceUnits(read, target.id), issued.amountUnits);
  assert.equal(simulation.validateState(read).valid, true);
  // 旧档：没有 bank.loans、镇库托底等字段。
  const oldState = bankState(113);
  fundBank(oldState, 1000 * V);
  const old = JSON.parse(JSON.stringify(oldState));
  delete old.bank.loans;
  delete old.bank.debtToTownUnits;
  const readOld = migrateSave(old, CONTENT);
  assert.equal(simulation.validateState(readOld).valid, true, "旧档正常读取");
});

// 11. 长期模拟（新开局 + 银行）：每 30 天 validateState 通过，粮券守恒，银行台账守恒。
test("[slow] 11 三年模拟：validateState 每 30 天通过，粮券守恒，台账守恒", () => {
  const state = bankState(2026);
  const total = totalVoucherBalances(state);
  for (let day = 1; day <= 3 * DAYS; day += 1) {
    simulation.advanceDay(state);
    if (day % 30 === 0) {
      valid(state);
      assert.equal(totalVoucherBalances(state), total, `第 ${day} 天粮券守恒`);
      assert.equal(bankLedgerInvariant(state).valid, true, `第 ${day} 天银行台账守恒`);
    }
  }
  assert.ok(householdPopulation(householdList(state)[0]) >= 0);
  syncResidentAggregates(state, CONTENT);
});
