import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { validateState } from "../src/core/validation.js";
import {
  applyRenames, mergeOntoBase, sanitizeNumbers, emptyLoadReport
} from "../src/persistence/save-compat.js";
import { migrateSave, loadReportMessage } from "../src/persistence/migrations.js";

const clone = value => JSON.parse(JSON.stringify(value));

// 一局玩过 2 年多的存档（JSON 形式），整个文件共用一份，避免重复模拟。
let cachedPlayedJson = null;
function playedJson() {
  if (cachedPlayedJson === null) {
    const state = simulation.createInitialState();
    simulation.advanceDays(state, 2 * CONTENT.rules.daysPerYear + 40);
    cachedPlayedJson = JSON.stringify(state);
  }
  return cachedPlayedJson;
}
const played = () => JSON.parse(playedJson());

function assertValid(state) {
  const { errors } = validateState(state, simulation.content);
  assert.deepEqual(errors, []);
}

test("round trip: a current save loads back to the same JSON with no load report", () => {
  const original = playedJson();
  const loaded = migrateSave(JSON.parse(original), simulation.content);
  assert.equal(JSON.stringify(loaded), original);
  assert.equal(loadReportMessage(loaded), null);
  assert.deepEqual(loaded._loadReport, { renamed: [], repaired: [], reset: [] });
});

test("missing new systems come back with defaults while progress is kept", () => {
  const save = played();
  const fresh = simulation.createInitialState();
  const goodId = Object.keys(save.outsideTowns.minzhen.stocks)[0];
  const originalYear = save.year;
  const originalDay = save.day;
  const originalBuildings = save.buildings.length;
  const originalWheat = save.accounts.town.wheat;
  const originalHouseholds = Object.keys(save.households.byId).length;

  delete save.industryExperience;
  delete save.goodsDemand;
  delete save.outsideTowns.wangzhen;
  delete save.outsideTowns.minzhen.stocks[goodId];
  delete save.policy.wageControl;

  const loaded = migrateSave(save, simulation.content);
  assert.deepEqual(loaded.industryExperience, fresh.industryExperience);
  assert.deepEqual(loaded.goodsDemand, fresh.goodsDemand);
  assert.deepEqual(loaded.outsideTowns.wangzhen, fresh.outsideTowns.wangzhen);
  assert.equal(loaded.outsideTowns.minzhen.stocks[goodId], fresh.outsideTowns.minzhen.stocks[goodId]);
  assert.deepEqual(loaded.policy.wageControl, fresh.policy.wageControl);

  assert.equal(loaded.year, originalYear);
  assert.equal(loaded.day, originalDay);
  assert.equal(loaded.buildings.length, originalBuildings);
  assert.equal(loaded.accounts.town.wheat, originalWheat);
  assert.equal(Object.keys(loaded.households.byId).length, originalHouseholds);
  assertValid(loaded);

  simulation.advanceDays(loaded, 30);
  assertValid(loaded);
});

test("households.byId is taken wholesale from the save and never refilled from the base", () => {
  const save = played();
  const freshCount = Object.keys(simulation.createInitialState().households.byId).length;
  const ids = Object.keys(save.households.byId);
  assert.equal(ids.length, freshCount);

  // 游戏里家庭 id 不会自然消失，所以人工构造：把最后一户并入前一户（人口、库存、粮券总量不变），
  // 得到一份比新开局少一户的存档。
  const removed = save.households.byId[ids[ids.length - 1]];
  const target = save.households.byId[ids[ids.length - 2]];
  for (const key of ["children", "workers", "elders"]) target.ageBands[key] += removed.ageBands[key];
  for (const itemId of Object.keys(removed.inventory)) target.inventory[itemId] += removed.inventory[itemId];
  target.voucherUnits += removed.voucherUnits;
  delete save.households.byId[removed.id];
  assert.equal(Object.keys(save.households.byId).length, freshCount - 1);

  const loaded = migrateSave(save, simulation.content);
  assert.equal(Object.keys(loaded.households.byId).length, freshCount - 1);
  assert.deepEqual(Object.keys(loaded.households.byId).sort(), Object.keys(save.households.byId).sort());
  assert.equal(loaded.households.byId[removed.id], undefined);
  assertValid(loaded);
});

test("plots always come from the current content, even if the save tampers with them", () => {
  const save = played();
  save.plots[0].label = "被篡改的地块";
  const loaded = migrateSave(save, simulation.content);
  const contentPlot = CONTENT.plots.find(plot => plot.id === save.plots[0].id);
  assert.equal(loaded.plots[0].label, contentPlot.label);
  assert.notEqual(loaded.plots[0].label, "被篡改的地块");
});

test("type mismatches are replaced by defaults and recorded as repairs", () => {
  const save = played();
  save.market.operatingPlan = "garbage";
  save.satisfaction = null;
  const loaded = migrateSave(save, simulation.content);
  const fresh = simulation.createInitialState();
  assert.deepEqual(loaded.market.operatingPlan, fresh.market.operatingPlan);
  assert.equal(typeof loaded.satisfaction, "number");
  assert.ok(loaded._loadReport.repaired.includes("market.operatingPlan"));
  assert.ok(loaded._loadReport.repaired.includes("satisfaction"));
  assert.match(loadReportMessage(loaded), /修复坏数据 \d+ 处/);
  assertValid(loaded);

  simulation.advanceDays(loaded, 10);
  assertValid(loaded);
});

test("NaN in the in-memory save becomes 0 and is listed in the report", () => {
  const save = played();
  save.policy.villa.taxRatePercent = NaN;
  const loaded = migrateSave(save, simulation.content);
  assert.equal(loaded.policy.villa.taxRatePercent, 0);
  assert.ok(loaded._loadReport.repaired.includes("policy.villa.taxRatePercent"));
});

test("version guards: newer saves and pre-17 saves are refused with clear messages", () => {
  const newer = played();
  newer.version = 18;
  newer.schemaVersion = 18;
  assert.throws(() => migrateSave(newer, simulation.content), /更新版本/);

  const older = played();
  older.version = 16;
  older.schemaVersion = 16;
  assert.throws(() => migrateSave(older, simulation.content), /旧版存档不兼容/);
});

test("applyRenames with the current empty RENAMES list is a no-op", () => {
  const raw = { a: 1, b: { c: 2 } };
  const report = emptyLoadReport();
  assert.deepEqual(applyRenames(clone(raw), report), raw);
  assert.deepEqual(report.renamed, []);
});

test("mergeOntoBase deep-merges objects, takes arrays and entity maps from the save", () => {
  assert.deepEqual(
    mergeOntoBase({ a: { b: 1, c: 2 } }, { a: { b: 5, d: 6 } }),
    { a: { b: 5, c: 2, d: 6 } }
  );
  assert.deepEqual(mergeOntoBase({ list: [1, 2, 3] }, { list: [9] }), { list: [9] });
  assert.deepEqual(
    mergeOntoBase({ households: { byId: { h1: { id: "h1" } } } }, { households: { byId: {} } }, "", null),
    { households: { byId: {} } }
  );
});

test("mergeOntoBase records type mismatches and keeps the base value", () => {
  const report = emptyLoadReport();
  const merged = mergeOntoBase({ a: { b: 1 }, n: 2 }, { a: "text", n: null }, "", report);
  assert.deepEqual(merged, { a: { b: 1 }, n: 2 });
  assert.deepEqual(report.repaired, ["a", "n"]);
});

test("sanitizeNumbers zeroes NaN and Infinity at any depth and reports the path", () => {
  const report = emptyLoadReport();
  const node = { x: NaN, nested: { y: Infinity, list: [1, -Infinity] } };
  sanitizeNumbers(node, report);
  assert.deepEqual(node, { x: 0, nested: { y: 0, list: [1, 0] } });
  assert.deepEqual(report.repaired, ["x", "nested.y", "nested.list[1]"]);
});

test("a subsystem that fails validation but passes the type merge is reset and reported", () => {
  const save = played();
  const fresh = simulation.createInitialState();
  const originalYear = save.year;
  const originalDay = save.day;
  const originalHouseholds = Object.keys(save.households.byId).length;
  save.socialSecurity.cashWheatUnits = -5;

  const loaded = migrateSave(save, simulation.content);
  // 只重置出错的那个字段，社保子系统的其余数据保留。
  assert.deepEqual(loaded._loadReport.reset, ["socialSecurity.cashWheatUnits"]);
  assert.equal(loaded.socialSecurity.cashWheatUnits, fresh.socialSecurity.cashWheatUnits);
  assert.equal(loaded.year, originalYear);
  assert.equal(loaded.day, originalDay);
  assert.equal(Object.keys(loaded.households.byId).length, originalHouseholds);
  assert.match(loadReportMessage(loaded), /重置子系统：socialSecurity\.cashWheatUnits/);
  assertValid(loaded);
});

test("坏一个政策字段只重置这一个字段，其余政策设置保留", () => {
  const save = played();
  save.policy.shopRentVoucher = -1;
  save.policy.villa.priceWheatJin = 123;
  const loaded = migrateSave(save, simulation.content);
  assert.deepEqual(loaded._loadReport.reset, ["policy.shopRentVoucher"]);
  assert.equal(loaded.policy.villa.priceWheatJin, 123);
  assertValid(loaded);
});

test("存档里的 __proto__ 等键被丢弃，不会进入原型链", () => {
  const merged = mergeOntoBase({ a: { b: 1 } }, JSON.parse('{"a":{"__proto__":{"polluted":1},"b":2}}'));
  assert.equal(merged.a.b, 2);
  assert.equal(merged.a.polluted, undefined);
  assert.equal(Object.getPrototypeOf(merged.a), Object.prototype);
});
