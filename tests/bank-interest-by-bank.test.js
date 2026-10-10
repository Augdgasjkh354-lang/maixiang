// 存款利息由银行自付（见 systems/bank.js 文件头）：现金够付时镇库不动；现金不够镇库托底（欠镇库）；
// 镇库也不够则顺延为应付、下日补付；费用三段记账；守恒与 validateState。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdList } from "../src/systems/households.js";
import { bankLedgerInvariant, bankLoanableVoucherUnits, depositToBank, settleBankDay } from "../src/systems/bank.js";
import { issueTownVouchers, transferVouchers, voucherBalance, validateCurrencyInvariant } from "../src/economy/currency.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;

function grantVouchers(state, household, units) {
  assert.equal(issueTownVouchers(state, units, CONTENT, "测试：印券发给住户").ok, true);
  assert.equal(transferVouchers(state, "town", `household:${household.id}`, units, CONTENT, "test_income", "测试收入").ok, true);
}

function depositorFixture(seed, count = 8) {
  const state = legacyVoucherState({ seed });
  const depositors = householdList(state).slice(0, count);
  for (const household of depositors) grantVouchers(state, household, 100000 * V);
  for (const household of depositors) assert.equal(depositToBank(state, household.id, 1000 * V, CONTENT).ok, true);
  return state;
}

// 模拟银行亏损把现金见底：现金经真实转账付给一户（粮券守恒），留存利润同额减少，台账仍守恒。
function drainBankCash(state) {
  const cash = state.bank.cashVoucherUnits;
  if (cash <= 0) return;
  const [household] = householdList(state);
  const moved = transferVouchers(state, "bank", `household:${household.id}`, cash, CONTENT, "test_bank_loss", "测试：银行亏损");
  assert.equal(moved.ok, true, moved.reason);
  state.bank.retainedVoucherUnits -= cash;
}

function expenseTotal(state) {
  return state.bank.cumulative?.depositInterestExpense || 0;
}

function bankNoticeEvents(state, text) {
  return state.events.filter(event => event.text.includes(text));
}

test("银行现金充足：存款利息由银行自付，镇库不动，费用计入银行三段账（日、年、累计）", () => {
  const state = depositorFixture(9301);
  issueTownVouchers(state, 50000 * V, CONTENT, "测试：镇库印券");
  const townBefore = voucherBalance(state, "town");

  settleBankDay(state, CONTENT);
  const dayOne = state.bank.day.depositInterestExpense;
  assert.ok(dayOne > 0, "当日计息");
  assert.equal(state.bank.day.depositInterestExpense, expenseTotal(state), "首日：日段 = 累计");
  assert.equal(state.bank.year.depositInterestExpense, expenseTotal(state), "首日：年段 = 累计");
  assert.equal(state.bank.interestPayableUnits, 0, "现金够付，当日付清");
  assert.equal(voucherBalance(state, "town"), townBefore, "镇库不动");
  assert.equal(state.bank.debtToTownUnits || 0, 0, "没有垫付");
  assert.equal(bankLedgerInvariant(state).valid, true);

  settleBankDay(state, CONTENT);
  const dayTwo = state.bank.day.depositInterestExpense;
  assert.equal(dayTwo, expenseTotal(state) - dayOne, "次日：日段只含当日费用（每日重置）");
  assert.equal(state.bank.year.depositInterestExpense, expenseTotal(state), "同年：年段累计");
  assert.equal(state.bank.stats.interestPaidVoucherUnits, expenseTotal(state), "付给存款人的利息 = 费用");
  assert.equal(state.bank.retainedVoucherUnits, -expenseTotal(state), "没有贷款与国债时留存利润 = −费用");
  assert.equal(voucherBalance(state, "town"), townBefore, "镇库仍不动");
  assert.equal(bankLedgerInvariant(state).valid, true);
  assert.equal(validateCurrencyInvariant(state, CONTENT).valid, true, "利息只是台账转移，粮券总账守恒");
});

test("银行现金不够付息：镇库托底垫付（bank_town_advance），记为欠镇库；镇库有粮券时当日付清", () => {
  const state = depositorFixture(9302);
  drainBankCash(state);
  issueTownVouchers(state, 500 * V, CONTENT, "测试：镇库粮券托底付息");
  const townBefore = voucherBalance(state, "town");

  settleBankDay(state, CONTENT);
  const due = expenseTotal(state);
  assert.ok(due > 0, "当日计息");
  // 当日存款流入会让现金超出准备金，已存在的还债步骤随即还清，所以以累计垫付衡量。
  assert.equal(state.bank.totalAdvancedUnits, due, "垫付额 = 现金不足的付息额（付息前银行现金为零）");
  assert.equal(townBefore - voucherBalance(state, "town"), state.bank.debtToTownUnits, "镇库净流出 = 银行欠镇库余额");
  assert.equal(state.bank.debtToTownUnits, state.bank.totalAdvancedUnits - state.bank.totalRepaidUnits, "欠镇库 = 累计垫付 − 累计还款");
  assert.equal(state.bank.interestPayableUnits, 0, "镇库够付，当日付清");
  assert.equal(state.bank.stats.interestPaidVoucherUnits, due, "利息全部计入存款");
  assert.equal(bankNoticeEvents(state, "存款利息时银行现金不足").length, 1, "欠镇库增长要有一次提示");
  assert.ok(bankNoticeEvents(state, "存款利息时银行现金不足")[0].text.includes(`镇库垫付${String(Math.round(due / V * 100) / 100)}券`), "提示写明金额");
  assert.equal(bankLedgerInvariant(state).valid, true);
  assert.equal(validateCurrencyInvariant(state, CONTENT).valid, true);
});

test("欠镇库的增长提示每年最多一次：同年再次垫付只改账，不再提示；跨年再提示", () => {
  const state = depositorFixture(9303);
  state.year = 2;
  for (let round = 0; round < 3; round += 1) {
    drainBankCash(state);
    issueTownVouchers(state, 500 * V, CONTENT, "测试：镇库粮券");
    settleBankDay(state, CONTENT);
  }
  assert.equal(bankNoticeEvents(state, "存款利息时银行现金不足").length, 1, "同年只提示一次");
  assert.ok(state.bank.totalAdvancedUnits > 0, "账目照常增长");
  state.year = 3;
  drainBankCash(state);
  issueTownVouchers(state, 500 * V, CONTENT, "测试：镇库粮券");
  settleBankDay(state, CONTENT);
  assert.equal(bankNoticeEvents(state, "存款利息时银行现金不足").length, 2, "跨年后再提示一次");
  assert.equal(bankLedgerInvariant(state).valid, true);
});

test("镇库也付不起：未付部分顺延为银行应付利息，下日补付；顺延期间留存利润已先减，台账守恒", () => {
  const state = depositorFixture(9304);
  drainBankCash(state);
  assert.equal(voucherBalance(state, "town"), 0);

  settleBankDay(state, CONTENT);
  const dayOne = expenseTotal(state);
  assert.equal(state.bank.interestPayableUnits, dayOne, "全部顺延为应付");
  assert.equal(state.bank.debtToTownUnits || 0, 0, "镇库没有粮券，不垫付、不透支");
  assert.equal(state.bank.stats.interestPaidVoucherUnits, 0, "没付出的利息不计入存款");
  assert.equal(bankLedgerInvariant(state).valid, true, "应付计入台账守恒");
  assert.ok(state.bank.retainedVoucherUnits < 0, "留存利润可为负");
  assert.ok(state.events.some(event => event.text.includes("顺延为应付")), "顺延要留下事件");

  // 第二日镇库得到部分粮券（现金仍见底，第一日的存款流入已在别处）：先付当日利息的一部分，旧欠按存款分摊补付。
  const partial = Math.floor(dayOne / 2);
  drainBankCash(state);
  issueTownVouchers(state, partial, CONTENT, "测试：镇库部分粮券");
  const payableBefore = state.bank.interestPayableUnits;
  settleBankDay(state, CONTENT);
  assert.equal(state.bank.totalAdvancedUnits, partial, "垫付额 = 镇库可出的粮券");
  assert.ok(state.bank.interestPayableUnits > 0, "仍有未付清的部分继续顺延");
  assert.equal(state.bank.interestPayableUnits, payableBefore + state.bank.day.depositInterestExpense - partial,
    "应付 = 原应付 + 当日费用 − 实付（只补了一部分）");
  assert.equal(bankLedgerInvariant(state).valid, true);

  // 镇库粮券充足：全部补付清，应付归零。
  issueTownVouchers(state, 1000 * V, CONTENT, "测试：镇库粮券补付");
  settleBankDay(state, CONTENT);
  assert.equal(state.bank.interestPayableUnits, 0, "下日补付清");
  assert.equal(bankLedgerInvariant(state).valid, true);
});

test("每30天：validateState、粮券总账与银行台账同时守恒（含垫付、顺延、补付与还债）", () => {
  const state = depositorFixture(9305);
  issueTownVouchers(state, 2000 * V, CONTENT, "测试：镇库粮券");
  for (let day = 1; day <= 120; day += 1) {
    if (day === 31 || day === 61) drainBankCash(state);
    settleBankDay(state, CONTENT);
    assert.equal(bankLedgerInvariant(state).valid, true, `第${day}天银行台账不守恒`);
    assert.ok(voucherBalance(state, "town") >= 0, `第${day}天镇库不透支`);
    assert.ok(state.bank.interestPayableUnits >= 0, `第${day}天应付利息非负`);
    if (day % 30 === 0) {
      const check = simulation.validateState(state);
      assert.equal(check.valid, true, `第${day}天 validateState：${JSON.stringify((check.errors || []).slice(0, 5))}`);
      assert.equal(validateCurrencyInvariant(state, CONTENT).valid, true, `第${day}天粮券总账`);
    }
  }
  assert.ok(state.bank.totalAdvancedUnits > 0, "期间发生过镇库托底");
});

test("应付利息从可贷额度中扣除（欠存款人的钱不能再借出去）", () => {
  const state = depositorFixture(9306);
  const before = bankLoanableVoucherUnits(state);
  const owed = Math.floor(before / 4);
  // 模拟应付利息：应付 +X、留存利润 −X，台账仍守恒。
  state.bank.interestPayableUnits += owed;
  state.bank.retainedVoucherUnits -= owed;
  assert.equal(bankLedgerInvariant(state).valid, true);
  assert.equal(bankLoanableVoucherUnits(state), before - owed, "可贷额度减去应付利息");
});
