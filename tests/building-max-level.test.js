import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { addInventory } from "../src/economy/inventory.js";
import { CONTENT } from "../src/content/index.js";
import { levelBonus } from "../src/economy/productivity.js";
import { renderBuildingArt, BUILDING_ART_CATALOG } from "../src/ui/building-art.js";

const MAX_LEVEL = 10;

function advanceUntilIdle(state, limit = 2000) {
  for (let i = 0; i < limit && state.project; i += 1) simulation.advanceDay(state);
  assert.equal(state.project, null, "upgrade project should finish within the day limit");
}

test("building level cap is 10 and every upgrade definition agrees with it", () => {
  assert.equal(CONTENT.rules.buildingMaxLevel, MAX_LEVEL);
  for (const [id, definition] of Object.entries(CONTENT.buildings)) {
    if (!definition.upgrade) continue;
    assert.equal(definition.upgrade.maxLevel, MAX_LEVEL, `${id} upgrade.maxLevel`);
  }
});

test("a mill can be upgraded step by step to level 10 and level 11 is refused", () => {
  const state = simulation.createInitialState();
  // 镇库加木材跳过开局；镇营产出需要批发市场，先建好。
  addInventory(state, "town", "wood", 1200, "test market stock", "test", CONTENT);
  const market = simulation.buildAt(state, "wholesale_market", "village-01");
  assert.equal(market.ok, true, market.reason);
  simulation.advanceDays(state, 60);
  addInventory(state, "town", "wood", 600, "test mill stock", "test", CONTENT);
  const built = simulation.buildAt(state, "mill", "east");
  assert.equal(built.ok, true, built.reason);
  simulation.advanceDays(state, 40);
  const mill = state.buildings.find(row => row.id === built.instanceId);
  assert.ok(mill, "mill should be built");
  assert.equal(mill.level, 1);

  for (let level = 1; level < MAX_LEVEL; level += 1) {
    addInventory(state, "town", "wood", 600, `test upgrade to ${level + 1}`, "test", CONTENT);
    const result = simulation.upgradeBuilding(state, mill.id);
    assert.equal(result.ok, true, `upgrade from ${level} failed: ${result.reason}`);
    advanceUntilIdle(state);
    assert.equal(mill.level, level + 1);
    assert.equal(simulation.validateState(state).valid, true, `state valid at level ${level + 1}`);
  }

  assert.equal(mill.level, MAX_LEVEL);
  addInventory(state, "town", "wood", 600, "test over-cap stock", "test", CONTENT);
  const refused = simulation.upgradeBuilding(state, mill.id);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /最高等级/);
  assert.equal(mill.level, MAX_LEVEL);
  assert.equal(simulation.validateState(state).valid, true);
});

test("job capacity and productivity scale with level up to 10", () => {
  const state = simulation.createInitialState();
  addInventory(state, "town", "wood", 1200, "test market stock", "test", CONTENT);
  assert.equal(simulation.buildAt(state, "wholesale_market", "village-01").ok, true);
  simulation.advanceDays(state, 60);
  addInventory(state, "town", "wood", 600, "test mill stock", "test", CONTENT);
  const built = simulation.buildAt(state, "mill", "east");
  simulation.advanceDays(state, 40);
  const mill = state.buildings.find(row => row.id === built.instanceId);
  const slots = CONTENT.buildings.mill.jobs.find(job => job.id === "millers").slots;

  for (let level = 1; level < MAX_LEVEL; level += 1) {
    addInventory(state, "town", "wood", 600, `test upgrade to ${level + 1}`, "test", CONTENT);
    assert.equal(simulation.upgradeBuilding(state, mill.id).ok, true);
    advanceUntilIdle(state);
  }

  const row = simulation.selectJobRows(state).rows.find(item => item.key === `${mill.id}::millers`);
  assert.equal(row.capacity, slots * MAX_LEVEL, "capacity at level 10 is 10x slots");
  assert.ok(Math.abs(levelBonus(MAX_LEVEL) - 1.9) < 1e-9, "level bonus is +10% per level above 1");
  assert.equal(simulation.validateState(state).valid, true);
});

test("building art renders levels 1..10 for every building type without errors", () => {
  const types = new Set([...Object.keys(BUILDING_ART_CATALOG), ...Object.keys(CONTENT.buildings)]);
  for (const type of types) {
    for (let level = 1; level <= MAX_LEVEL; level += 1) {
      const svg = renderBuildingArt(type, { level, status: "complete" });
      assert.equal(typeof svg, "string", `${type} level ${level}`);
      assert.ok(svg.length > 0, `${type} level ${level} renders`);
      assert.doesNotMatch(svg, /NaN|undefined/, `${type} level ${level} has no bad numbers`);
    }
  }
});
