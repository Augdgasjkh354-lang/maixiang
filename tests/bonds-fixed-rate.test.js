import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdList, syncResidentAggregates } from "../src/systems/households.js";
import { migrateBonds } from "../src/systems/bonds.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;

function voucherTown(seed) {
  const state = simulation.createInitialState({ seed });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({ id: "bank-b", typeId: "bank", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  assert.equal(simulation.startCurrencyReform(state).ok, true);
  return state;
}

test("国债按固定利率发行：发行当天认购，利率不随认购变化，粮券守恒", () => {
  const state = voucherTown(8801);
  // 给住户一笔闲钱，确保有人认购
  for (const household of householdList(state).slice(0, 20)) household.voucherUnits = 5000 * V;
  state.currency.balances.town -= 20 * 5000 * V;
  syncResidentAggregates(state, CONTENT);
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true);
  const result = simulation.issueGovernmentBond(state, { totalVoucher: 10000, termYears: 2, rateAnnualPercent: 5 });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.issue.status, "active");
  assert.equal(result.issue.couponRateAnnualPercent, 5);
  assert.ok(result.soldVoucher > 0 && result.soldVoucher <= 10000);
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true);
  simulation.advanceDays(state, 30);
  assert.equal(state.bonds.issues[0].couponRateAnnualPercent, 5);
  assert.equal(simulation.validateState(state).valid, true);
});

test("利率不高于存款利率且银行无闲钱时无人认购，不发行", () => {
  const state = voucherTown(8802);
  const result = simulation.issueGovernmentBond(state, { totalVoucher: 1000, termYears: 1, rateAnnualPercent: 0 });
  assert.equal(result.ok, false);
  assert.equal((state.bonds?.issues || []).length, 0);
});

test("旧档认购中的国债载入时按已认购部分生效", () => {
  const state = { bonds: { seq: 1, creditPenaltyBps: 200, issues: [{ id: "GB1", status: "subscribing", startRateAnnualPercent: 3, couponRateAnnualPercent: 3, subscribedVoucherUnits: 300, subscriptions: { "bank:bank": 300 }, holdings: [] }] } };
  migrateBonds(state);
  assert.equal(state.bonds.issues[0].status, "active");
  assert.deepEqual(state.bonds.issues[0].holdings, [{ holderKey: "bank:bank", principalVoucherUnits: 300 }]);
  assert.equal(state.bonds.creditPenaltyBps, undefined);
});
