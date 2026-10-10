// 开局即粮券（AGENTS.md "货币阶段"）：粮券是唯一货币，开局发行不经银行闸门；
// 印券仍需银行（或 legacyBankAccess 兼容入口）。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { issueTownVouchers, validateCurrencyInvariant, voucherBalance } from "../src/economy/currency.js";
import { householdList, householdPopulation } from "../src/systems/households.js";
import { listingGate } from "../src/systems/stock-exchange.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;
const I = CONTENT.precision.inventoryUnitsPerJin;
const clone = value => JSON.parse(JSON.stringify(value));

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

test("新开局粮券是唯一货币，monetaryReform 只剩 legacyBankAccess，没有兼容银行入口", () => {
  const state = simulation.createInitialState({ seed: 4101 });
  assert.deepEqual(state.monetaryReform, { legacyBankAccess: false });
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
  assert.equal(loaded.currency.issuedUnits, state.currency.issuedUnits);
  assert.equal(voucherBalance(loaded, "town"), voucherBalance(state, "town"));
  assertValid(loaded, "新档读回");
});

test("旧档的 legacyBankAccess 读回后保留；过时的货币阶段字段被丢弃", () => {
  const state = simulation.createInitialState({ seed: 4110 });
  const raw = clone(state);
  raw.monetaryReform = { stage: "voucher", legacyBankAccess: true, started: { year: 1, day: 5 }, completed: { year: 1, day: 5 } }; // 过时字段，读档时丢弃
  const loaded = migrateSave(raw, CONTENT);
  assert.deepEqual(loaded.monetaryReform, { legacyBankAccess: true });
  assertValid(loaded, "旧档读回");
});
