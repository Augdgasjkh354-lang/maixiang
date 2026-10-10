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

test("[slow] export and import round-trip a resumable paused save and preserve replaced data", () => {
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

test("[slow] auto-save and reload retain each workshop's assigned people through year end", () => {
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
  // 原为 120 天；速度无关性只需跨过几次帧推进即可，缩为 30 天（全量耗时）。
  const days = 30;
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

