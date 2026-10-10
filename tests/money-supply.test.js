import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdList, syncResidentAggregates } from "../src/systems/households.js";
import { issueTownVouchers, issueVouchersFromWheat, transferVouchers, voucherBalance, validateCurrencyInvariant } from "../src/economy/currency.js";
import { currentPaymentComposition, maximumPayableValueUnits, settleMonetaryPayment } from "../src/economy/payment.js";
import { bankLedgerInvariant, depositToBank, ensureBankState, settleBankDay } from "../src/systems/bank.js";
import { householdWealthUnits } from "../src/systems/household-budget.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function farmerHousehold(state) {
  return householdList(state).find(h => (h.jobs?.farmers || 0) > 0) || householdList(state)[0];
}

// 把镇库粮券全部转给一户，使镇库余额为 0。
function drainTownVouchers(state, householdId) {
  const balance = voucherBalance(state, "town");
  if (balance > 0) {
    const moved = transferVouchers(state, "town", `household:${householdId}`, balance, CONTENT, "test_drain", "测试清空镇库粮券");
    assert.equal(moved.ok, true, moved.reason);
  }
  assert.equal(voucherBalance(state, "town"), 0);
}

// 发给住户粮券：先印制（发行量同增），再从镇库转入，守恒校验不被破坏。
function grantHouseholdVouchers(state, household, units) {
  const minted = issueTownVouchers(state, units, CONTENT, "测试：镇库印券发给住户");
  assert.equal(minted.ok, true, minted.reason);
  const moved = transferVouchers(state, "town", `household:${household.id}`, units, CONTENT, "test_income", "测试收入");
  assert.equal(moved.ok, true, moved.reason);
}

// 收走住户手上的全部粮券（转入镇库，发行量不变）。
function takeHouseholdVouchers(state, household) {
  const cash = household.voucherUnits || 0;
  if (cash <= 0) return;
  const moved = transferVouchers(state, `household:${household.id}`, "town", cash, CONTENT, "test_expense", "测试支出");
  assert.equal(moved.ok, true, moved.reason);
}

function depositsTotal(state) {
  return Object.values(state.bank?.deposits || {}).reduce((sum, units) => sum + (units || 0), 0);
}

test("换券仍只能动用镇库已有粮券：镇库余额为 0 时换券被拒，发行量与余额都不变", () => {
  const state = legacyVoucherState({ seed: 9104 });
  const household = farmerHousehold(state);
  drainTownVouchers(state, household.id);
  const issuedBefore = state.currency.issuedUnits;
  const householdBefore = household.voucherUnits;
  const exchange = issueVouchersFromWheat(state, `household:${household.id}`, I, CONTENT, "测试换券");
  assert.equal(exchange.ok, false);
  assert.match(exchange.reason, /粮券余额不足/);
  assert.equal(state.currency.issuedUnits, issuedBefore);
  assert.equal(household.voucherUnits, householdBefore);
  assert.equal(validateCurrencyInvariant(state).valid, true);
});

// 模拟银行亏损把现金见底：现金经真实转账付给一户（粮券守恒），留存利润同额减少，台账仍守恒。
function drainBankCash(state) {
  const cash = state.bank.cashVoucherUnits;
  if (cash <= 0) return;
  const [household] = householdList(state);
  const moved = transferVouchers(state, "bank", `household:${household.id}`, cash, CONTENT, "test_bank_loss", "测试：银行亏损");
  assert.equal(moved.ok, true, moved.reason);
  state.bank.retainedVoucherUnits -= cash;
}

function depositorFixture(seed, depositorCount = 8) {
  const state = legacyVoucherState({ seed });
  const depositors = householdList(state).slice(0, depositorCount);
  for (const household of depositors) grantHouseholdVouchers(state, household, 100000 * V);
  for (const household of depositors) {
    const result = depositToBank(state, household.id, 1000 * V, CONTENT);
    assert.equal(result.ok, true, result.reason);
  }
  return { state, depositors };
}

test("存款利息由银行自付：银行现金充足时镇库不动，利息并入存款、计为银行费用（留存利润减少），台账守恒", () => {
  const { state } = depositorFixture(9201);
  issueTownVouchers(state, 200000 * V, CONTENT, "测试：镇库印券");
  const townBefore = voucherBalance(state, "town");
  assert.equal(bankLedgerInvariant(state).valid, true);

  for (let day = 0; day < 60; day += 1) {
    settleBankDay(state, CONTENT);
    const check = bankLedgerInvariant(state);
    assert.equal(check.valid, true, `第${day + 1}天存款台账与银行现金不守恒：${JSON.stringify(check)}`);
  }
  const paid = state.bank.stats.interestPaidVoucherUnits;
  assert.ok(paid > 0, "存款应当计息");
  assert.equal(voucherBalance(state, "town"), townBefore, "银行现金够付息，镇库不动");
  assert.equal(state.bank.debtToTownUnits || 0, 0, "没有垫付就没有欠镇库");
  assert.equal(state.bank.interestPayableUnits, 0, "当日付清，没有顺延");
  assert.equal(state.bank.cumulative.depositInterestExpense, paid, "银行费用 = 计入存款的利息");
  assert.equal(state.bank.retainedVoucherUnits, -paid, "没有贷款与国债时，留存利润 = −存款利息费用");
  assert.equal(simulation.validateState(state).valid, true);
});

test("银行现金不够付息时镇库托底垫付（记为欠镇库），镇库也不够的部分顺延为应付、下日补付，不透支，台账仍守恒", () => {
  const { state } = depositorFixture(9202);
  // 模拟银行亏损：现金见底，留存利润同额减少（台账仍守恒）；镇库没有粮券。
  drainBankCash(state);
  assert.equal(voucherBalance(state, "town"), 0);
  assert.equal(bankLedgerInvariant(state).valid, true);
  const depositsBefore = depositsTotal(state);

  settleBankDay(state, CONTENT);
  assert.equal(state.bank.stats.interestPaidVoucherUnits, 0, "银行与镇库都没有现金时不计入存款");
  assert.ok(state.bank.interestPayableUnits > 0, "应付利息顺延，不丢");
  assert.equal(state.bank.debtToTownUnits || 0, 0, "镇库没有粮券，不垫付");
  assert.equal(voucherBalance(state, "town"), 0, "镇库不透支");
  assert.ok(depositsTotal(state) >= depositsBefore, "没有利息入账时存款不减少");
  assert.equal(bankLedgerInvariant(state).valid, true);
  assert.ok(state.events.some(event => event.text.includes("顺延为应付")), "顺延要留下事件");

  // 镇库有少量粮券：先垫付再付息；应付 = 原应付 + 本日费用 − 本日实付（逐笔对账）。
  const payableBefore = state.bank.interestPayableUnits;
  const expenseBefore = state.bank.cumulative.depositInterestExpense;
  const paidBefore = state.bank.stats.interestPaidVoucherUnits;
  // 第一日的存款流入已进入银行现金，第二日先把现金清零（模拟银行仍无现金）。
  drainBankCash(state);
  issueTownVouchers(state, 3 * V, CONTENT, "测试：镇库少量粮券");
  settleBankDay(state, CONTENT);
  const advanced = state.bank.totalAdvancedUnits;
  assert.ok(advanced > 0 && advanced <= 3 * V, "镇库垫付不超过它手上的粮券");
  assert.ok(state.bank.stats.interestPaidVoucherUnits > paidBefore, "垫付后付出了利息");
  assert.equal(state.bank.interestPayableUnits,
    payableBefore + (state.bank.cumulative.depositInterestExpense - expenseBefore) - (state.bank.stats.interestPaidVoucherUnits - paidBefore),
    "应付利息逐笔对账");
  assert.ok(voucherBalance(state, "town") >= 0);
  assert.equal(bankLedgerInvariant(state).valid, true);
});

test("存款算家底：存入银行只是从现金挪到存款，家底不变", () => {
  const state = legacyVoucherState({ seed: 9301 });
  const household = farmerHousehold(state);
  household.inventory.wheat = 0;
  syncResidentAggregates(state, CONTENT);
  grantHouseholdVouchers(state, household, 1000 * V);
  const wealthBefore = householdWealthUnits(state, household, CONTENT);
  assert.equal(wealthBefore, 1000 * V);

  assert.equal(depositToBank(state, household.id, 1000 * V, CONTENT).ok, true);
  assert.equal(household.voucherUnits, 0);
  assert.equal(state.bank.deposits[household.id], 1000 * V);
  assert.equal(householdWealthUnits(state, household, CONTENT), wealthBefore, "存款计入家底");
});

test("手头无现金的家庭付款时先从存款取回，不必换券", () => {
  const state = legacyVoucherState({ seed: 9302 });
  const household = farmerHousehold(state);
  const townWheatBefore = state.accounts.town.wheat;
  household.inventory.wheat = 0;
  syncResidentAggregates(state, CONTENT);
  grantHouseholdVouchers(state, household, 1000 * V);
  assert.equal(depositToBank(state, household.id, 1000 * V, CONTENT).ok, true);
  assert.equal(household.voucherUnits, 0);
  assert.ok(maximumPayableValueUnits(state, `household:${household.id}`, CONTENT) >= 1000 * V, "可付额包含存款");

  const payment = settleMonetaryPayment(state, `household:${household.id}`, "town", currentPaymentComposition(state, 300 * V), CONTENT,
    "test_pay", "测试付款", { requireFull: true });
  assert.equal(payment.ok, true, payment.reason);
  assert.equal(voucherBalance(state, "town"), 300 * V, "镇库收到付款");
  assert.equal(state.bank.deposits[household.id], 700 * V, "存款被取回的部分");
  assert.equal(state.bank.cashVoucherUnits, 700 * V, "银行现金同步减少");
  assert.equal(household.voucherUnits, 0);
  assert.equal(state.accounts.town.wheat, townWheatBefore, "没有换券发生");
  assert.equal(bankLedgerInvariant(state).valid, true);
  assert.equal(validateCurrencyInvariant(state).valid, true);
});

test("居民汇总付款也能动用存款：先取回存款最多的家庭的钱，再付给镇库", () => {
  const { state, depositors } = depositorFixture(9303, 3);
  for (const household of depositors) {
    household.inventory.wheat = 0;
    syncResidentAggregates(state, CONTENT);
    takeHouseholdVouchers(state, household);
  }
  syncResidentAggregates(state, CONTENT);
  assert.equal(voucherBalance(state, "residents"), 0, "居民手头没有现金");
  const depositsBefore = depositsTotal(state);
  const townBefore = voucherBalance(state, "town");
  const payment = settleMonetaryPayment(state, "residents", "town", currentPaymentComposition(state, 1500 * V), CONTENT,
    "test_pay", "居民汇总付款", { requireFull: true });
  assert.equal(payment.ok, true, payment.reason);
  assert.equal(depositsBefore - depositsTotal(state), 1500 * V, "居民存款减少的正是付款额");
  assert.equal(voucherBalance(state, "town") - townBefore, 1500 * V, "镇库收到付款");
  assert.equal(bankLedgerInvariant(state).valid, true);
  assert.equal(validateCurrencyInvariant(state).valid, true);
});

test("银行持有国债：票息作为利息收入计入留存利润，存款台账守恒", async () => {
  const { issueGovernmentBond, settleBondsDay } = await import("../src/systems/bonds.js");
  const { state } = depositorFixture(9204);
  issueTownVouchers(state, 200000 * V, CONTENT, "测试：镇库印券");
  // 票面高于存款利率（默认 2%），住户与银行才会认购。
  // 发行额要大于住户认购之和，剩下的才轮到银行按可贷额度认购。
  const issued = issueGovernmentBond(state, { totalVoucher: 1000000, termYears: 2, rateAnnualPercent: 6 }, CONTENT);
  assert.equal(issued.ok, true, issued.reason);
  const bankHolding = (issued.issue.holdings || []).filter(row => row.holderKey === "bank:bank")
    .reduce((sum, row) => sum + row.principalVoucherUnits, 0);
  assert.ok(bankHolding > 0, "银行应当认购国债");
  assert.equal(bankLedgerInvariant(state).valid, true);

  // 逐日推进日历（票息按年结算，dayIndex 依赖 year/day）。
  for (let absDay = 1; absDay <= 400; absDay += 1) {
    state.year = 1 + Math.floor(absDay / CONTENT.rules.daysPerYear);
    state.day = absDay % CONTENT.rules.daysPerYear;
    settleBankDay(state, CONTENT);
    settleBondsDay(state, CONTENT);
    const check = bankLedgerInvariant(state);
    assert.equal(check.valid, true, `第${absDay}天不守恒：${JSON.stringify(check)}`);
  }
  assert.ok(state.bonds.issues[0].stats.couponPaidVoucherUnits > 0, "一年一次的票息已经付给银行与住户");
  // 银行付存款利息（费用）、收票息（收入）：没有贷款时留存利润 = 票息收入 − 存款利息费用，票息收入须为正。
  assert.ok(state.bank.retainedVoucherUnits + state.bank.cumulative.depositInterestExpense > 0, "银行的票息收入计入留存利润");
  assert.equal(bankLedgerInvariant(state).bonds >= 0, true);
  assert.equal(validateCurrencyInvariant(state).valid, true);
});

test("旧存档：存款台账超出现金（旧版利息只记账不付现金）时仍能读入，差额记为银行留存利润为负，存款人余额不变", () => {
  const state = legacyVoucherState({ seed: 9401 });
  const household = farmerHousehold(state);
  grantHouseholdVouchers(state, household, 1000 * V);
  assert.equal(depositToBank(state, household.id, 1000 * V, CONTENT).ok, true);
  // 模拟旧版存档：台账多出 100 券的利息，银行现金里没有这笔钱，也没有留存利润字段。
  state.bank.deposits[household.id] += 100 * V;
  delete state.bank.retainedVoucherUnits;
  assert.equal(simulation.validateState(state).valid, true, "旧存档应能通过读档校验");

  ensureBankState(state);
  assert.equal(state.bank.retainedVoucherUnits, -100 * V, "无现金支撑的利息记为银行负的留存利润");
  assert.equal(state.bank.deposits[household.id], 1100 * V, "存款人余额保持不变");
  assert.equal(bankLedgerInvariant(state).valid, true);
});
