import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { migrateMonetaryReform } from "../src/economy/payment.js";

function stateWithBank(seed) {
  const state = simulation.createInitialState({ seed });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({ id: "bank-t", typeId: "bank", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return state;
}

test("货币改革一键切换：直接进入粮券阶段，镇库按小麦存量印制等额粮券", () => {
  const state = stateWithBank(9101);
  const wheat = state.accounts.town.wheat;
  const result = simulation.startCurrencyReform(state);
  assert.equal(result.ok, true, result.reason);
  assert.equal(state.monetaryReform.stage, "voucher");
  assert.equal(state.currency.balances.town, Math.floor(wheat * CONTENT.precision.currencyUnitsPerVoucher / CONTENT.precision.inventoryUnitsPerJin));
  assert.equal(simulation.startCurrencyReform(state).ok, false);
  simulation.advanceDays(state, 30);
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true);
});

test("没有银行不能启动货币改革", () => {
  const state = simulation.createInitialState({ seed: 9102 });
  assert.equal(simulation.startCurrencyReform(state).ok, false);
  assert.equal(state.monetaryReform.stage, "wheat");
});

test("旧档过渡期载入后视为已完成改革", () => {
  const state = stateWithBank(9103);
  Object.assign(state.monetaryReform, { stage: "transition", targetVoucherBps: 3000, residentExchangeEnabled: true, paymentHistory: [], voucherShortfallByKey: { x: 1 } });
  migrateMonetaryReform(state);
  assert.equal(state.monetaryReform.stage, "voucher");
  assert.equal(state.monetaryReform.targetVoucherBps, undefined);
  assert.equal(state.monetaryReform.voucherShortfallByKey, undefined);
});
