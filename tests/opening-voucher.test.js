// 开局即粮券（docs/…、AGENTS.md "货币阶段"）：新开局直接处于粮券阶段，开局发行不经银行闸门；
// 旧档读档仍以存档自带的阶段为准（小麦阶段的旧档读回后还是小麦阶段）。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { issueTownVouchers, validateCurrencyInvariant, voucherBalance } from "../src/economy/currency.js";
import { householdList, householdPopulation } from "../src/systems/households.js";
import { wheatEraState } from "./helpers-monetary.js";
import { listingGate } from "../src/systems/stock-exchange.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;
const I = CONTENT.precision.inventoryUnitsPerJin;
const clone = value => JSON.parse(JSON.stringify(value));

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

test("新开局即粮券阶段，时点为开局第 1 天，没有兼容银行入口", () => {
  const state = simulation.createInitialState({ seed: 4101 });
  assert.equal(state.monetaryReform.stage, "voucher");
  assert.equal(state.monetaryReform.legacyBankAccess, false);
  assert.deepEqual(state.monetaryReform.started, { year: 1, day: 1 });
  assert.deepEqual(state.monetaryReform.completed, { year: 1, day: 1 });
  assertValid(state, "开局");
});

test("开局发行 1000 万斤粮券：居民每人 1000 斤（按户人口），镇库券池 670 万斤，发行量与账户余额一致", () => {
  const state = simulation.createInitialState({ seed: 4102 });
  const households = householdList(state);
  const population = households.reduce((sum, household) => sum + householdPopulation(household), 0);
  assert.equal(population, 3300);
  for (const household of households) {
    assert.equal(household.voucherUnits, householdPopulation(household) * 1000 * V, household.id);
  }
  assert.equal(voucherBalance(state, "town"), 6700000 * V);
  assert.equal(state.currency.balances.residents, 3300 * 1000 * V);
  assert.equal(state.currency.issuedUnits, 10000000 * V);
  assert.equal(validateCurrencyInvariant(state).valid, true);
  assertValid(state, "开局发行");
});

test("开局粮券不动小麦：居民与镇库的小麦库存保持开局值", () => {
  const state = simulation.createInitialState({ seed: 4103 });
  assert.equal(state.accounts.town.wheat, 3000000 * I);
  assert.equal(state.accounts.residents.wheat, 3000000 * I);
});

test("开局发行不经银行闸门，但之后的印券仍需银行", () => {
  const state = simulation.createInitialState({ seed: 4104 });
  const issued = issueTownVouchers(state, 1000 * V, CONTENT, "测试印券");
  assert.equal(issued.ok, false);
  assert.match(issued.reason, /银行/);
  assert.equal(simulation.startCurrencyReform(state).ok, false, "粮券阶段不能再次切换");
  assertValid(state, "无银行印券失败后");
});

test("国债与交易所都要求先建成银行 / 交易所，并给出玩家可见的原因", () => {
  const state = simulation.createInitialState({ seed: 4105 });
  const bond = simulation.issueGovernmentBond(state, { totalVoucher: 1000, termYears: 1, rateAnnualPercent: 5 });
  assert.equal(bond.ok, false);
  assert.match(bond.reason, /建成银行/);
  // 交易所门槛：没有交易所就不能上市、不能交易股票（listingGate 同时供上市与股票交易使用）。
  assert.equal(listingGate(state), "尚未建成交易所");
});

test("开局推进 30 天：每日状态合法、粮券守恒", () => {
  const state = simulation.createInitialState({ seed: 4106 });
  for (let day = 0; day < 30; day += 1) {
    simulation.advanceDay(state);
    assert.equal(validateCurrencyInvariant(state).valid, true, `第 ${day + 1} 天粮券不守恒`);
  }
  assertValid(state, "30天后");
});

test("新开局存档往返：读回仍是粮券阶段，发行量与余额不变", () => {
  const state = simulation.createInitialState({ seed: 4107 });
  const loaded = migrateSave(clone(state), CONTENT);
  assert.equal(loaded.monetaryReform.stage, "voucher");
  assert.equal(loaded.currency.issuedUnits, state.currency.issuedUnits);
  assert.equal(voucherBalance(loaded, "town"), voucherBalance(state, "town"));
  assertValid(loaded, "新档读回");
});

test("旧小麦阶段存档读回后仍是小麦阶段，不被开局的粮券阶段覆盖，且校验通过", () => {
  const old = wheatEraState({ seed: 4108 });
  for (let day = 0; day < 20; day += 1) simulation.advanceDay(old);
  const raw = clone(old);
  assert.equal(raw.monetaryReform.stage, "wheat");
  const loaded = migrateSave(raw, CONTENT);
  assert.equal(loaded.monetaryReform.stage, "wheat");
  assert.equal(loaded.monetaryReform.started, null);
  assert.equal(loaded.currency.issuedUnits, 0);
  assert.deepEqual(loaded._loadReport.repaired, [], "读回不应有修复项");
  assertValid(loaded, "小麦旧档读回");
});

test("更老的存档没有货币改革字段：按小麦阶段读回", () => {
  const old = wheatEraState({ seed: 4109 });
  const raw = clone(old);
  delete raw.monetaryReform;
  const loaded = migrateSave(raw, CONTENT);
  assert.equal(loaded.monetaryReform.stage, "wheat");
  assertValid(loaded, "无货币字段旧档读回");
});

test("已进入粮券阶段的旧档读回后仍是粮券阶段", () => {
  const state = simulation.createInitialState({ seed: 4110 });
  const raw = clone(state);
  raw.monetaryReform = { stage: "voucher", legacyBankAccess: true, started: { year: 1, day: 5 }, completed: { year: 1, day: 5 } };
  const loaded = migrateSave(raw, CONTENT);
  assert.equal(loaded.monetaryReform.stage, "voucher");
  assert.deepEqual(loaded.monetaryReform.started, { year: 1, day: 5 });
  assert.equal(loaded.monetaryReform.legacyBankAccess, true);
});
