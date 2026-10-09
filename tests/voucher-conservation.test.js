import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { voucherBalance, validateCurrencyInvariant } from "../src/economy/currency.js";
import { householdList } from "../src/systems/households.js";
import { grantResidentVouchers, setHouseholdInventoryJin } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;

function valid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
  const currency = validateCurrencyInvariant(state, CONTENT);
  assert.equal(currency.valid, true, `${label} 货币总账：余额 ${currency.balances} ≠ 发行量 ${currency.issuedUnits}`);
}

test("货币改革后开救济，跑 60 天：发行量不变（无玩家印券/注销），货币总账守恒", () => {
  const state = legacyVoucherState({ seed: 9401 });
  assert.equal(simulation.issueGrainVouchers(state, "town", 100).ok, true);
  const issuedBefore = state.currency.issuedUnits;
  assert.equal(simulation.toggleAutomaticRelief(state, true), true);
  // 让一户没有口粮，救济路径真正发生。
  const household = householdList(state)[0];
  for (const [itemId, item] of Object.entries(CONTENT.items)) {
    if (item.edible) setHouseholdInventoryJin(state, household.id, itemId, 0, CONTENT);
  }
  valid(state, "开救济前");
  simulation.advanceDays(state, 60);
  assert.equal(state.currency.issuedUnits, issuedBefore, "救济、兑换、工资都不改变发行量");
  valid(state, "救济 60 天后");
});

test("居民兑小麦：镇库粮券余额增加等量，发行量不变；家庭兑小麦同理", () => {
  const state = legacyVoucherState({ seed: 9402 });
  grantResidentVouchers(state, 50);
  const household = householdList(state)[0];
  grantResidentVouchers(state, 20, CONTENT, household.id);
  const issuedBefore = state.currency.issuedUnits;
  const townBefore = voucherBalance(state, "town");
  const residentsBefore = voucherBalance(state, "residents");
  const wheatBefore = state.accounts.town.wheat;

  const redeemed = simulation.redeemGrainVouchers(state, "residents", 10);
  assert.equal(redeemed.ok, true, redeemed.reason);
  assert.equal(voucherBalance(state, "town") - townBefore, 10 * V, "镇库粮券余额增加 10 券");
  assert.equal(voucherBalance(state, "residents") - residentsBefore, -10 * V, "居民粮券减少 10 券");
  assert.equal(state.accounts.town.wheat, wheatBefore - redeemed.wheatUnits, "镇库小麦按兑出量减少");
  assert.equal(state.currency.issuedUnits, issuedBefore, "居民兑回不注销发行量");
  valid(state, "居民兑小麦后");

  const townMid = voucherBalance(state, "town");
  const householdRedeemed = simulation.redeemGrainVouchers(state, `household:${household.id}`, 5);
  assert.equal(householdRedeemed.ok, true, householdRedeemed.reason);
  assert.equal(voucherBalance(state, "town") - townMid, 5 * V, "家庭兑小麦同样把券交回镇库");
  assert.equal(state.currency.issuedUnits, issuedBefore, "家庭兑回也不注销发行量");
  valid(state, "家庭兑小麦后");
});

test("镇库注销仍减少发行量：镇库余额与发行量同减，小麦不动", () => {
  const state = legacyVoucherState({ seed: 9403 });
  assert.equal(simulation.issueGrainVouchers(state, "town", 100).ok, true);
  const issuedBefore = state.currency.issuedUnits;
  const townBefore = voucherBalance(state, "town");
  const wheatBefore = state.accounts.town.wheat;

  const retired = simulation.redeemGrainVouchers(state, "town", 40);
  assert.equal(retired.ok, true, retired.reason);
  assert.equal(state.currency.issuedUnits, issuedBefore - 40 * V, "发行量减少 40 券");
  assert.equal(voucherBalance(state, "town"), townBefore - 40 * V, "镇库余额减少 40 券");
  assert.equal(state.accounts.town.wheat, wheatBefore, "注销不动小麦");
  valid(state, "镇库注销后");
});
