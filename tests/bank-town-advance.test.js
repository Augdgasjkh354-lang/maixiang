// 银行镇库托底：住户取回存款时银行现金不够，缺口由镇库垫付，记为银行欠镇库的债；现金富余时每日还债。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { setBankPolicy as setBankPolicyCommand, repayBankDebtToTown } from "../src/core/commands.js";
import { householdList, syncResidentAggregates } from "../src/systems/households.js";
import { issueTownVouchers, transferVouchers, validateCurrencyInvariant, voucherBalance } from "../src/economy/currency.js";
import { currentPaymentComposition, depositWithdrawableUnits, maximumFullyPayableValueUnits, maximumPayableValueUnits, quoteMonetaryPayment, settleMonetaryPayment, spendableVoucherUnits } from "../src/economy/payment.js";
import { withdrawFromBank } from "../src/economy/deposits.js";
import { bankDebtRepayableUnits, bankLedgerInvariant, depositToBank, ensureBankState, settleBankDay, settleBankDebtRepay } from "../src/systems/bank.js";
import { settleWealthTax } from "../src/systems/redistribution.js";
import { selectDashboard } from "../src/selectors/dashboard.js";
import { legacyVoucherState, setHouseholdVoucherUnits } from "./helpers-monetary.js";
import { richestHousehold } from "./helpers-v16.js";

const SCALE = CONTENT.precision.currencyUnitsPerVoucher;
const I = CONTENT.precision.inventoryUnitsPerJin;

// 测试夹具：镇库先印一批粮券（legacy 夹具的镇库余额为 0，守恒需要先有发行量）。
function fixtureState(seed = 7301) {
  const state = legacyVoucherState({ seed });
  const issued = issueTownVouchers(state, 1000000 * SCALE, CONTENT, "测试：镇库印券");
  assert.equal(issued.ok, true, issued.reason);
  return state;
}

// 把镇库粮券压到 keep（多出的转给另一户，守恒）。
function setTownVouchers(state, keep, exceptId) {
  const surplus = voucherBalance(state, "town") - keep;
  if (surplus > 0) {
    const other = householdList(state).find(h => h.id !== exceptId);
    const moved = transferVouchers(state, "town", `household:${other.id}`, surplus, CONTENT, "test_town_cash", "测试：镇库现金设定");
    assert.equal(moved.ok, true, moved.reason);
  }
  assert.equal(voucherBalance(state, "town"), keep);
}

// 造一个“存款多、银行现金少”的银行：存款来自住户，多出的现金作为银行亏损转回镇库，留存利润为负（台账仍守恒）。
function weakBank(state, household, { deposit, cash }) {
  ensureBankState(state);
  household.inventory.wheat = 0;
  setHouseholdVoucherUnits(state, household, deposit);
  const deposited = depositToBank(state, household.id, deposit, CONTENT);
  assert.equal(deposited.ok, true, deposited.reason);
  const excess = deposit - cash;
  if (excess > 0) {
    const moved = transferVouchers(state, "bank", "town", excess, CONTENT, "test_bank_loss", "测试：银行现金流失");
    assert.equal(moved.ok, true, moved.reason);
  }
  state.bank.retainedVoucherUnits = cash - deposit;
  assert.equal(state.bank.cashVoucherUnits, cash);
  assert.equal(state.bank.deposits[household.id], deposit);
  assert.equal(bankLedgerInvariant(state).valid, true, "夹具本身台账守恒");
  return household;
}

// 隔离其他户：他们的粮券划给镇库、小麦清零，使税基只来自 keepId 一户（守恒）。
function isolateHousehold(state, keepId) {
  for (const other of householdList(state)) {
    if (other.id === keepId) continue;
    if ((other.voucherUnits || 0) > 0) {
      const moved = transferVouchers(state, `household:${other.id}`, "town", other.voucherUnits, CONTENT, "test_isolate", "测试：隔离其他户");
      assert.equal(moved.ok, true, moved.reason);
    }
    other.inventory.wheat = 0;
  }
  syncResidentAggregates(state, CONTENT);
}

// 另一户存入 units 券（银行现金与存款同增）。
function otherDeposits(state, exceptId, units) {
  const other = householdList(state).find(h => h.id !== exceptId);
  setHouseholdVoucherUnits(state, other, units);
  assert.equal(depositToBank(state, other.id, units, CONTENT).ok, true);
}

function snapshotMoney(state, householdId) {
  return JSON.stringify({
    town: voucherBalance(state, "town"),
    bank: state.bank,
    issued: state.currency.issuedUnits,
    household: state.households.byId[householdId].voucherUnits,
    deposits: state.bank.deposits,
    balances: state.currency.balances
  });
}

function assertBooksBalance(state) {
  assert.equal(validateCurrencyInvariant(state, CONTENT).valid, true, "粮券总账守恒");
  assert.equal(bankLedgerInvariant(state).valid, true, "银行台账守恒（含欠镇库）");
  const check = simulation.validateState(state, CONTENT);
  assert.equal(check.valid, true, check.errors.join("；"));
}

test("取款：银行现金不够时镇库垫付缺口，镇库 −X、银行现金与欠镇库同步、住户拿到全额", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  const townBefore = voucherBalance(state, "town");
  const handBefore = household.voucherUnits;
  const result = withdrawFromBank(state, household.id, 500 * SCALE, CONTENT);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.advancedUnits, 400 * SCALE, "缺口 = 取款额 − 银行现金");
  assert.equal(voucherBalance(state, "town"), townBefore - 400 * SCALE, "镇库垫付 −X");
  assert.equal(state.bank.debtToTownUnits, 400 * SCALE, "银行欠镇库 +X");
  assert.equal(state.bank.totalAdvancedUnits, 400 * SCALE);
  assert.equal(state.bank.totalRepaidUnits, 0);
  assert.equal(state.bank.cashVoucherUnits, 0, "现金 100 + 垫付 400 − 取款 500");
  assert.equal(state.bank.deposits[household.id], 300 * SCALE);
  assert.equal(household.voucherUnits, handBefore + 500 * SCALE, "住户拿到全额");
  assertBooksBalance(state);
});

test("取款：银行现金够时不垫付，不改欠镇库", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 600 * SCALE });
  const townBefore = voucherBalance(state, "town");
  const result = withdrawFromBank(state, household.id, 500 * SCALE, CONTENT);
  assert.equal(result.ok, true);
  assert.equal(result.advancedUnits, 0);
  assert.equal(voucherBalance(state, "town"), townBefore);
  assert.equal(state.bank.debtToTownUnits || 0, 0);
  assert.equal(state.bank.cashVoucherUnits, 100 * SCALE);
  assertBooksBalance(state);
});

test("取款：镇库也垫付不了时整笔拒绝，银行、镇库、住户一分不动", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  setTownVouchers(state, 50 * SCALE, household.id);
  const before = snapshotMoney(state, household.id);
  const result = withdrawFromBank(state, household.id, 500 * SCALE, CONTENT);
  assert.equal(result.ok, false);
  assert.match(result.reason, /镇库垫付也不够/);
  assert.equal(snapshotMoney(state, household.id), before, "没有半付");
  assertBooksBalance(state);
});

test("付款：存款付款时银行现金不够，镇库垫付后全额付清，守恒", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  const due = 600 * SCALE;
  const townBefore = voucherBalance(state, "town");
  const result = settleMonetaryPayment(state, `household:${household.id}`, "town", currentPaymentComposition(state, due), CONTENT, "test_pay", "测试付款");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.paidValueUnits, due);
  assert.equal(result.remainingValueUnits, 0);
  assert.equal(state.bank.debtToTownUnits, 500 * SCALE, "缺口 600 − 现金 100");
  assert.equal(voucherBalance(state, "town"), townBefore - 500 * SCALE + due, "镇库：垫付 −500，收款 +600");
  assert.equal(state.bank.deposits[household.id], 200 * SCALE);
  assertBooksBalance(state);
});

test("多阶段付款：手头粮券先付，存款取回与镇库垫付只补剩余部分，不重复支付", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  setHouseholdVoucherUnits(state, household, 50 * SCALE);
  const due = 700 * SCALE;
  const result = settleMonetaryPayment(state, `household:${household.id}`, "town", currentPaymentComposition(state, due), CONTENT, "test_pay", "测试两段付款");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.paidValueUnits, due, "手头 50 + 取款 650 = 700，只付一次");
  assert.equal(state.bank.deposits[household.id], 150 * SCALE, "存款取走 650");
  assert.equal(state.bank.debtToTownUnits, 550 * SCALE, "取款 650 − 现金 100");
  assertBooksBalance(state);
});

test("报价与结算一致：报价说能付就必须付成功；报价说不能付时结算整笔拒绝且不动账", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  setHouseholdVoucherUnits(state, household, 30 * SCALE);
  setTownVouchers(state, 200 * SCALE, household.id);
  // 可付上限 = 手头 30 + 可取回 min(现金 100 + 镇库 200, 存款 800) = 330
  const limit = maximumFullyPayableValueUnits(state, `household:${household.id}`, 2000 * SCALE, CONTENT);
  assert.equal(limit, 330 * SCALE, "可付上限 = 手头 + min(银行现金 + 镇库可垫付, 存款)");
  const values = [0, 1, 29 * SCALE, 30 * SCALE, 200 * SCALE, limit - 1, limit, limit + 1, limit + SCALE, 800 * SCALE];
  for (const value of values) {
    const quote = quoteMonetaryPayment(state, `household:${household.id}`, currentPaymentComposition(state, value), CONTENT);
    const clone = structuredClone(state);
    const before = JSON.stringify(clone);
    const result = settleMonetaryPayment(clone, `household:${household.id}`, "town", currentPaymentComposition(clone, value), CONTENT, "test_quote", "报价一致");
    assert.equal(result.ok, quote.full, `金额 ${value}：报价 ${quote.full} 与结算 ${result.ok} 不一致`);
    if (!result.ok) assert.equal(JSON.stringify(clone), before, `金额 ${value}：拒绝时不得改动任何账`);
    else assert.equal(validateCurrencyInvariant(clone, CONTENT).valid && bankLedgerInvariant(clone).valid, true, `金额 ${value}：付款后守恒`);
  }
});

test("报价与结算一致：有可换券小麦时，换券只用垫付之后镇库剩余的粮券，不被重复计算", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  household.inventory.wheat = 5000 * I;
  setTownVouchers(state, 200 * SCALE, household.id);
  const full = maximumFullyPayableValueUnits(state, `household:${household.id}`, 3000 * SCALE, CONTENT);
  const max = maximumPayableValueUnits(state, `household:${household.id}`, CONTENT);
  assert.ok(full >= 300 * SCALE, "至少包括存款可取回部分（现金 100 + 镇库 200）");
  for (const value of [full, full + 1, max]) {
    const quote = quoteMonetaryPayment(state, `household:${household.id}`, currentPaymentComposition(state, value), CONTENT);
    const clone = structuredClone(state);
    const result = settleMonetaryPayment(clone, `household:${household.id}`, "town", currentPaymentComposition(clone, value), CONTENT, "test_exchange", "报价一致（换券）");
    assert.equal(result.ok, quote.full, `金额 ${value}：报价与结算不一致`);
    if (result.ok) assert.equal(bankLedgerInvariant(clone).valid && validateCurrencyInvariant(clone, CONTENT).valid, true);
  }
});

test("镇库粮券有限：可取回额 = min(银行现金 + 镇库粮券, 存款)，超出部分报价与结算都拒绝", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  setHouseholdVoucherUnits(state, household, 0);
  setTownVouchers(state, 200 * SCALE, household.id);
  assert.equal(depositWithdrawableUnits(state, `household:${household.id}`), 300 * SCALE);
  assert.equal(spendableVoucherUnits(state, `household:${household.id}`), 300 * SCALE);
  assert.equal(quoteMonetaryPayment(state, `household:${household.id}`, currentPaymentComposition(state, 301 * SCALE), CONTENT).full, false);
  const before = JSON.stringify(state);
  const refused = settleMonetaryPayment(state, `household:${household.id}`, "town", currentPaymentComposition(state, 301 * SCALE), CONTENT, "test_cap", "超额");
  assert.equal(refused.ok, false);
  assert.equal(JSON.stringify(state), before, "整笔拒绝，不半付");
  const paid = settleMonetaryPayment(state, `household:${household.id}`, "town", currentPaymentComposition(state, 300 * SCALE), CONTENT, "test_cap", "刚好付清");
  assert.equal(paid.ok, true);
  assert.equal(state.bank.debtToTownUnits, 200 * SCALE, "垫付到镇库上限");
  // 镇库 200 −200（垫付）+300（收款）= 300。
  assert.equal(voucherBalance(state, "town"), 300 * SCALE);
  assertBooksBalance(state);
});

test("富人税：存款靠镇库垫付仍全额收到（修复前只能收到银行现金 + 手头粮券）", () => {
  const state = fixtureState();
  simulation.setWealthTax(state, { ratesPercent: [20, 20, 20] });
  const household = weakBank(state, richestHousehold(state), { deposit: 50000 * SCALE, cash: 100 * SCALE });
  setHouseholdVoucherUnits(state, household, 10 * SCALE);
  isolateHousehold(state, household.id);
  const result = settleWealthTax(state, CONTENT);
  assert.ok(result.dueUnits > 110 * SCALE, `应纳 ${result.dueUnits} 应超过修复前的可收上限 110 券`);
  assert.equal(result.collectedUnits, result.dueUnits, "全额收到");
  assert.equal(state.redistribution.year.wealthTaxWaivedUnits || 0, 0, "没有免征");
  assertBooksBalance(state);
});

test("每日还债：超出准备金与安全垫的现金还给镇库，债清为止", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 1000 * SCALE, cash: 100 * SCALE });
  assert.equal(withdrawFromBank(state, household.id, 300 * SCALE, CONTENT).ok, true);
  assert.equal(state.bank.debtToTownUnits, 200 * SCALE);
  // 另一户存入 1000 券：现金 1000、存款 1700，准备金 170 + 安全垫 85，可还 745，债 200 全还。
  otherDeposits(state, household.id, 1000 * SCALE);
  assert.equal(bankDebtRepayableUnits(state, CONTENT), 200 * SCALE);
  const townBefore = voucherBalance(state, "town");
  assert.equal(settleBankDebtRepay(state, CONTENT), 200 * SCALE);
  assert.equal(state.bank.debtToTownUnits, 0);
  assert.equal(state.bank.totalRepaidUnits, 200 * SCALE);
  assert.equal(voucherBalance(state, "town"), townBefore + 200 * SCALE);
  assertBooksBalance(state);
});

test("每日还债：现金只够还一部分时按可还额还，剩余留到下次；手动还款受同一上限约束", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 1000 * SCALE, cash: 100 * SCALE });
  withdrawFromBank(state, household.id, 300 * SCALE, CONTENT);
  // 存款 700 + 300 = 1000，现金 300：准备金 100 + 安全垫 50，可还 150，债 200 还 150。
  otherDeposits(state, household.id, 300 * SCALE);
  assert.equal(bankDebtRepayableUnits(state, CONTENT), 150 * SCALE);
  assert.equal(settleBankDebtRepay(state, CONTENT), 150 * SCALE);
  assert.equal(state.bank.debtToTownUnits, 50 * SCALE);
  assert.equal(bankDebtRepayableUnits(state, CONTENT), 0, "现金已降到准备金 + 安全垫，不再还");
  const manual = repayBankDebtToTown(state, 10, CONTENT);
  assert.equal(manual.ok, false);
  assert.match(manual.reason, /暂不能还债/);
  assertBooksBalance(state);
});

test("手动还款：金额不超过可还额与欠款；欠款为 0 时拒绝", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 1000 * SCALE, cash: 100 * SCALE });
  assert.equal(repayBankDebtToTown(state, 1, CONTENT).ok, false, "没有欠款");
  withdrawFromBank(state, household.id, 300 * SCALE, CONTENT);
  otherDeposits(state, household.id, 1000 * SCALE);
  const partial = repayBankDebtToTown(state, 50, CONTENT);
  assert.equal(partial.ok, true, partial.reason);
  assert.equal(partial.repaidValueUnits, 50 * SCALE);
  assert.equal(state.bank.debtToTownUnits, 150 * SCALE);
  const rest = repayBankDebtToTown(state, 1000, CONTENT);
  assert.equal(rest.ok, true);
  assert.equal(rest.repaidValueUnits, 150 * SCALE, "最多还到欠款余额 150");
  assert.equal(state.bank.debtToTownUnits, 0);
  assertBooksBalance(state);
});

test("欠镇库不误报资不抵债：现金为正时日结不写告警", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  withdrawFromBank(state, household.id, 500 * SCALE, CONTENT);
  assert.ok(state.bank.cashVoucherUnits >= 0);
  settleBankDay(state, CONTENT);
  assert.equal(state.events.some(event => String(event.text || "").includes("资不抵债")), false);
});

test("旧存档没有镇库托底字段：读入后补零，校验通过；负数被校验拦下", () => {
  const state = fixtureState();
  ensureBankState(state);
  delete state.bank.debtToTownUnits;
  delete state.bank.totalAdvancedUnits;
  delete state.bank.totalRepaidUnits;
  ensureBankState(state);
  assert.equal(state.bank.debtToTownUnits, 0);
  assert.equal(state.bank.totalAdvancedUnits, 0);
  assert.equal(state.bank.totalRepaidUnits, 0);
  assert.equal(simulation.validateState(state, CONTENT).valid, true);
  state.bank.debtToTownUnits = -5;
  const check = simulation.validateState(state, CONTENT);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(text => text.includes("镇库托底账无效")));
});

test("选择器只读：bankStats 暴露欠镇库、累计垫付与累计还款，且不改 state", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  withdrawFromBank(state, household.id, 500 * SCALE, CONTENT);
  const before = JSON.stringify(state);
  const dashboard = selectDashboard(state, CONTENT);
  const bankStats = dashboard.policy.bankStats;
  assert.equal(JSON.stringify(state), before, "selector 不写 state");
  assert.equal(bankStats.debtToTownJin, 400);
  assert.equal(bankStats.totalAdvancedJin, 400);
  assert.equal(bankStats.totalRepaidJin, 0);
  assert.equal(bankStats.debtRepayableJin, 0);
});

test("改准备金率之后托底仍然守恒", () => {
  const state = fixtureState();
  const household = weakBank(state, richestHousehold(state), { deposit: 800 * SCALE, cash: 100 * SCALE });
  assert.equal(setBankPolicyCommand(state, { reserveRequirementPercent: 20 }).ok, true);
  withdrawFromBank(state, household.id, 500 * SCALE, CONTENT);
  assertBooksBalance(state);
});
