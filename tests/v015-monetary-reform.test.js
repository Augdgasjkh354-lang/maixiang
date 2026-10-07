import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { currentPaymentComposition, settleMonetaryPayment, finalizeMonetaryPaymentDay, monetaryReformProgress } from "../src/economy/payment.js";
import { householdList, syncResidentAggregates } from "../src/systems/households.js";
import { validateCurrencyInvariant } from "../src/economy/currency.js";
import { selectDemolitionPreview } from "../src/systems/building-development.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBank(state, id = "test-bank") {
  const plot = state.plots.find(row => !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, "需要空地放置测试银行");
  state.buildings.push({ id, typeId: "bank", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: state.day + 1 } });
  return id;
}

function reformState(target = 0) {
  const state = simulation.createInitialState({ seed: 1501 + target });
  addBank(state);
  assert.equal(simulation.startCurrencyReform(state).ok, true);
  assert.equal(simulation.setVoucherPaymentTarget(state, target).ok, true);
  return state;
}

test("0.1.5 新局从小麦制度开始，粮券与储备均为0；无银行不能改革", () => {
  const state = simulation.createInitialState({ seed: 150100 });
  assert.equal(state.monetaryReform.stage, "wheat");
  assert.equal(state.currency.issuedUnits, 0);
  assert.equal(state.currency.reserveWheatUnits, 0);
  assert.equal(state.currency.balances.town, 0);
  assert.equal(state.accounts.residents.wheat > 0, true);
  assert.equal(state.accounts.town.wheat > 0, true);
  assert.deepEqual(simulation.startCurrencyReform(state), { ok: false, reason: "需先建成银行" });
  assert.equal(simulation.validateState(state).valid, true);
});

test("银行能在无粮券新局施工，建筑工资使用小麦支付", () => {
  const state = simulation.createInitialState({ seed: 150101 });
  state.accounts.town.wood = 800 * I;
  const plot = state.plots.find(row => !state.buildings.some(building => building.plotId === row.id) && !row.feature);
  assert.ok(plot);
  const beforeWheat = state.accounts.town.wheat;
  const started = simulation.buildAt(state, "bank", plot.id);
  assert.equal(started.ok, true, started.reason);
  assert.equal(state.project.typeId, "bank");
  let days = 0;
  while (state.project && days < 80) { simulation.advanceDay(state); days += 1; }
  assert.equal(state.project, null, "银行应在短期定向模拟中建成");
  assert.equal(state.buildings.some(row => row.typeId === "bank"), true);
  assert.equal(state.currency.issuedUnits, 0, "施工不得隐式发行粮券");
  assert.equal(state.accounts.town.wheat < beforeWheat, true, "施工工资应扣镇库自有小麦");
  assert.equal(simulation.startCurrencyReform(state).ok, true);
});

test("0%、30%、100% 应付构成由统一支付层固定形成", () => {
  const state = reformState(0);
  assert.deepEqual(currentPaymentComposition(state, 1000), { valueUnits: 1000, voucherValueUnits: 0, wheatValueUnits: 1000 });
  simulation.setVoucherPaymentTarget(state, 30);
  assert.deepEqual(currentPaymentComposition(state, 1000), { valueUnits: 1000, voucherValueUnits: 300, wheatValueUnits: 700 });
  simulation.setVoucherPaymentTarget(state, 100);
  assert.deepEqual(currentPaymentComposition(state, 1000), { valueUnits: 1000, voucherValueUnits: 1000, wheatValueUnits: 0 });
});

test("过渡期缺券由付款人自己的小麦补付；两种资产都不足时不产生半笔交易", () => {
  const state = reformState(30);
  const household = householdList(state)[0];
  const owner = `household:${household.id}`;
  household.voucherUnits = 0;
  household.inventory.wheat = 100 * I;
  syncResidentAggregates(state, CONTENT);
  const townBefore = state.accounts.town.wheat;
  const result = settleMonetaryPayment(state, owner, "town", currentPaymentComposition(state, 10 * V), CONTENT,
    "test_payment", "测试混合支付", { requireFull: true, maxWheatUnits: 100 * I });
  assert.equal(result.ok, true);
  assert.equal(result.voucherPaidValueUnits, 0);
  assert.equal(result.wheatPaidValueUnits, 10 * V);
  assert.equal(result.fallbackWheatValueUnits, 3 * V);
  assert.equal(state.accounts.town.wheat - townBefore, 10 * I);

  household.voucherUnits = 0;
  household.inventory.wheat = 2 * I;
  syncResidentAggregates(state, CONTENT);
  const townWheat = state.accounts.town.wheat;
  const householdWheat = household.inventory.wheat;
  const ledgerLength = state.ledger.length;
  const failed = settleMonetaryPayment(state, owner, "town", currentPaymentComposition(state, 10 * V), CONTENT,
    "test_payment", "测试失败原子性", { requireFull: true, maxWheatUnits: 2 * I });
  assert.equal(failed.ok, false);
  assert.equal(failed.paidValueUnits, 0);
  assert.equal(state.accounts.town.wheat, townWheat);
  assert.equal(household.inventory.wheat, householdWheat);
  assert.equal(state.ledger.length, ledgerLength);
});

test("全粮券阶段新交易不自动回退小麦；旧粮食债务仍按原构成偿付", () => {
  const state = reformState(100);
  const household = householdList(state)[0];
  const owner = `household:${household.id}`;
  const oldWheatDebt = currentPaymentComposition({ ...state, monetaryReform: { ...state.monetaryReform, stage: "wheat" } }, 5 * V);
  // 直接切到完成态用于媒介边界测试；完成条件另有独立测试。
  state.monetaryReform.stage = "voucher";
  state.monetaryReform.targetVoucherBps = 10000;
  household.voucherUnits = 0;
  household.inventory.wheat = 100 * I;
  syncResidentAggregates(state, CONTENT);
  const newTrade = settleMonetaryPayment(state, owner, "town", currentPaymentComposition(state, 5 * V), CONTENT,
    "test_full_voucher", "全粮券新交易", { requireFull: true, maxWheatUnits: 100 * I });
  assert.equal(newTrade.ok, false);
  assert.match(newTrade.reason, /粮券不足/);
  const oldDebt = settleMonetaryPayment(state, owner, "town", oldWheatDebt, CONTENT,
    "test_old_debt", "旧粮食债务", { requireFull: true, maxWheatUnits: 100 * I });
  assert.equal(oldDebt.ok, true);
  assert.equal(oldDebt.wheatPaidValueUnits, 5 * V);
  assert.equal(oldDebt.voucherPaidValueUnits, 0);
});

test("r05 镇库直接印制粮券且不建立独立兑付储备", () => {
  const state = reformState(30);
  const townWheatBefore = state.accounts.town.wheat;
  const issued = simulation.issueGrainVouchers(state, "town", 100);
  assert.equal(issued.ok, true, issued.reason);
  assert.equal(state.accounts.town.wheat, townWheatBefore);
  assert.equal(state.currency.reserveWheatUnits, 0);
  assert.equal(state.currency.issuedUnits, 100 * V);
  assert.equal(state.currency.balances.town, 100 * V);
  assert.equal(validateCurrencyInvariant(state, CONTENT).valid, true);
  const redeemed = simulation.redeemGrainVouchers(state, "town", 25);
  assert.equal(redeemed.ok, true, redeemed.reason);
  assert.equal(state.accounts.town.wheat, townWheatBefore);
  assert.equal(state.currency.reserveWheatUnits, 0);
  assert.equal(state.currency.issuedUnits, 75 * V);
  assert.equal(validateCurrencyInvariant(state, CONTENT).valid, true);
});

test("居民换券开关只控制粮食换券，不影响已有粮券兑回", () => {
  const state = reformState(0);
  const household = householdList(state).find(h => (h.jobs?.farmers || 0) > 0);
  assert.ok(household);
  assert.equal(simulation.setResidentExchangeEnabled(state, true).ok, true);
  assert.equal(simulation.issueGrainVouchers(state, "town", 10).ok, true);
  const issued = simulation.issueGrainVouchers(state, `household:${household.id}`, 1);
  assert.equal(issued.ok, true, issued.reason);
  assert.equal(simulation.setResidentExchangeEnabled(state, false).ok, true);
  const blocked = simulation.issueGrainVouchers(state, `household:${household.id}`, 1);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /关闭/);
  const redeemed = simulation.redeemGrainVouchers(state, `household:${household.id}`, 1);
  assert.equal(redeemed.ok, true, redeemed.reason);
});

test("结束过渡期不能被无交易绕过；连续7日真实粮券支付后才可确认", () => {
  const noTrade = reformState(100);
  for (let i = 0; i < 7; i += 1) { finalizeMonetaryPaymentDay(noTrade, CONTENT); noTrade.day += 1; }
  assert.equal(monetaryReformProgress(noTrade, CONTENT).eligibleToComplete, false);
  assert.equal(simulation.finishCurrencyReform(noTrade).ok, false);

  const state = reformState(100);
  const issued = simulation.issueGrainVouchers(state, "town", 20);
  assert.equal(issued.ok, true, issued.reason);
  const household = householdList(state)[0];
  for (let i = 0; i < 7; i += 1) {
    const paid = settleMonetaryPayment(state, "town", `household:${household.id}`, currentPaymentComposition(state, V), CONTENT,
      "test_reform_payment", "改革进度测试", { requireFull: true });
    assert.equal(paid.ok, true);
    assert.equal(paid.voucherPaidValueUnits, V);
    assert.equal(paid.wheatPaidValueUnits, 0);
    finalizeMonetaryPaymentDay(state, CONTENT);
    state.day += 1;
  }
  const progress = monetaryReformProgress(state, CONTENT);
  assert.equal(progress.consecutiveSevenDays, true);
  assert.equal(progress.recentVoucherBps, 10000);
  assert.equal(progress.recentFallbackWheatValueUnits, 0);
  assert.equal(progress.eligibleToComplete, true);
  assert.equal(simulation.finishCurrencyReform(state).ok, true);
  assert.equal(state.monetaryReform.stage, "voucher");
});

test("改革启动后银行不可拆除", () => {
  const state = reformState(0);
  const bank = state.buildings.find(row => row.typeId === "bank");
  const preview = selectDemolitionPreview(state, bank.id, CONTENT);
  assert.equal(preview.available, false);
  assert.match(preview.reason, /不能拆除/);
});
