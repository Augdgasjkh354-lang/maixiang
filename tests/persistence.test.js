import test from "node:test";
import assert from "node:assert/strict";
import { jobCount } from "../src/systems/households.js";
import Legacy from "./fixtures/engine-v1.cjs";
import { CONTENT, extendContent } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { SAVE_KEY, exportState, importState, loadState, saveState } from "../src/persistence/storage.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { populationStats } from "../src/selectors/labor.js";
import { SimulationClock } from "../src/ui/simulation-clock.js";
import { addInventory } from "../src/economy/inventory.js";

function memoryStorage(entries) {
  const values = new Map(Object.entries(entries || {}));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    keys() { return [...values.keys()]; }
  };
}

test("old local saves are detected without automatic migration or deletion", () => {
  const old = Legacy.createNewState();
  Legacy.startBuild(old, "mill", "east");
  for (let day = 0; day < 10; day += 1) Legacy.tickDay(old);
  old.autoRelief = false;
  const raw = JSON.stringify(old);
  const storage = memoryStorage({ [SAVE_KEY]: raw });

  const loaded = loadState(storage, CONTENT);
  assert.equal(loaded.migrated, false);
  assert.equal(loaded.legacy, true);
  assert.equal(loaded.legacyVersion, 1);
  assert.equal(loaded.state, null);
  assert.equal(storage.getItem(SAVE_KEY), raw);
  const backups = storage.keys().filter(key => key.startsWith(SAVE_KEY + ".backup-v1-"));
  assert.equal(backups.length, 0);
});

test("unreadable local save stays untouched", () => {
  const raw = "{not-json";
  const storage = memoryStorage({ [SAVE_KEY]: raw });
  assert.throws(() => loadState(storage, CONTENT), /无法读取/);
  assert.equal(storage.getItem(SAVE_KEY), raw);
  assert.equal(storage.keys().length, 1);
});

test("旧存档拒绝迁移，当前版本仍补齐新增内容项", () => {
  const content = extendContent(CONTENT, {
    items: { timber: Object.freeze({ id: "timber", name: "木材", unit: "根", category: "material", edible: false, qeq: null }) }
  });
  assert.throws(() => migrateSave(Legacy.createNewState(), content), /旧版存档不兼容/);

  const current = simulation.createInitialState();
  delete current.accounts.residents.timber;
  delete current.accounts.town.timber;
  for (const household of Object.values(current.households.byId)) delete household.inventory.timber;
  const restored = migrateSave(current, content);
  assert.equal(restored.accounts.residents.timber, 0);
  assert.equal(restored.accounts.town.timber, 0);
  assert.ok(Object.values(restored.households.byId).every(household => household.inventory.timber === 0));
});
test("export and import round-trip a resumable paused save and preserve replaced data", () => {
  const state = simulation.createInitialState({ seed: 2718 });
  simulation.advanceDays(state, 70);
  const storage = memoryStorage();
  saveState(storage, state, CONTENT);
  const exported = exportState(state);
  const replacement = simulation.createInitialState({ seed: 99 });
  saveState(storage, replacement, CONTENT);
  const imported = importState(storage, exported, CONTENT);
  assert.equal(imported.day, 70);
  assert.equal(imported.rng.state, state.rng.state);
  assert.equal(storage.getItem(SAVE_KEY + ".backup-before-import-" + hashText(JSON.stringify(replacement))) !== null, true);

  const reloaded = loadState(storage, CONTENT).state;
  const nextA = JSON.parse(JSON.stringify(imported));
  const nextB = JSON.parse(JSON.stringify(reloaded));
  simulation.advanceDays(nextA, 365);
  simulation.advanceDays(nextB, 365);
  assert.deepEqual(nextA, nextB);
  assert.equal(populationStats(nextA).total,
    populationStats(nextA).children + populationStats(nextA).workers + populationStats(nextA).elders);
});

test("auto-save and reload retain each workshop's assigned people through year end", () => {
  const state = simulation.createInitialState({ seed: 80721 });
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  addInventory(state, "town", "wood", 500, "test stock", "test", CONTENT);
  const mill = simulation.buildAt(state, "mill", "east");
  simulation.advanceDays(state, 40);
  const bakery = simulation.buildAt(state, "bakery", "south");
  simulation.advanceDays(state, 40);
  simulation.setEmployment(state, mill.instanceId + "::millers", 3);
  simulation.setEmployment(state, bakery.instanceId + "::bakers", 5);
  const storage = memoryStorage();
  saveState(storage, state, CONTENT);

  const restored = loadState(storage, CONTENT).state;
  assert.equal(jobCount(restored, `${mill.instanceId}::millers`), 3);
  assert.equal(jobCount(restored, `${bakery.instanceId}::bakers`), 5);
  simulation.advanceDays(restored, 365 - restored.day);
  assert.equal(jobCount(restored, `${mill.instanceId}::millers`), 3);
  assert.equal(jobCount(restored, `${bakery.instanceId}::bakers`), 5);
  assert.equal(simulation.validateState(restored).valid, true);
});

test("clock starts paused, pauses without advancing, and equal simulated days ignore speed", () => {
  const slowState = simulation.createInitialState({ seed: 123 });
  const fastState = simulation.createInitialState({ seed: 123 });
  const slowClock = new SimulationClock(CONTENT);
  const fastClock = new SimulationClock(CONTENT);
  assert.equal(slowClock.paused, true);
  assert.equal(slowClock.advanceFrame(100, () => simulation.advanceDay(slowState)), 0);

  slowClock.setSpeed(1);
  fastClock.setSpeed(16);
  const days = 120;
  const slowAdvanced = slowClock.advanceFrame(days / CONTENT.rules.dailyDaysPerSecond,
    () => simulation.advanceDay(slowState));
  const fastAdvanced = fastClock.advanceFrame(days / (CONTENT.rules.dailyDaysPerSecond * 16),
    () => simulation.advanceDay(fastState));
  assert.equal(slowAdvanced, days);
  assert.equal(fastAdvanced, days);
  assert.deepEqual(slowState, fastState);
  slowClock.pause();
  assert.equal(slowClock.advanceFrame(20, () => simulation.advanceDay(slowState)), 0);
  assert.equal(slowState.day, days);
});

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

test("0.1.4 v11 存档按已完成改革接入，旧兑付储备释放回镇库并提供兼容银行入口", () => {
  const old = simulation.createInitialState({ seed: 11415 });
  const I = CONTENT.precision.inventoryUnitsPerJin;
  const V = CONTENT.precision.currencyUnitsPerVoucher;
  old.version = 11;
  old.schemaVersion = 11;
  delete old.monetaryReform;
  delete old.currency.reserveWheatCostVoucherUnits;
  delete old.currency.reserveModel;
  const originalTownWheat = old.accounts.town.wheat;
  old.accounts.town.wheat -= 100 * I;
  old.currency.reserveWheatUnits = 100 * I;
  old.currency.issuedUnits = 100 * V;
  old.currency.issuedCumulativeUnits = 100 * V;
  old.currency.balances.town = 100 * V;
  const restored = migrateSave(old, CONTENT);
  assert.equal(restored.version, 15);
  assert.equal(restored.schemaVersion, 15);
  assert.equal(restored.monetaryReform.stage, "voucher");
  assert.equal(restored.monetaryReform.targetVoucherBps, 10000);
  assert.equal(restored.monetaryReform.legacyBankAccess, true);
  assert.equal(restored.currency.reserveWheatUnits, 0);
  assert.equal(restored.accounts.town.wheat, originalTownWheat, "旧储备中的实际小麦应一次性回到镇库可用库存");
  assert.equal(restored.currency.issuedUnits, 100 * V);
  assert.equal(restored.currency.balances.town, 100 * V);
  assert.equal(simulation.selectDashboard(restored).monetaryReform.hasBankAccess, true);
  assert.equal(simulation.validateState(restored).valid, true, simulation.validateState(restored).errors.join("；"));
});
