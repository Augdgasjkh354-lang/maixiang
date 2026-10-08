import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { addInventory } from "../src/economy/inventory.js";
import { CONTENT } from "../src/content/index.js";
import { villaCapacityOf, selectVillaVacancies } from "../src/systems/villas.js";
import { renderBuildingArt } from "../src/ui/building-art.js";

const MAX_LEVEL = 10;

function advanceUntilIdle(state, limit = 3000) {
  for (let i = 0; i < limit && state.project; i += 1) simulation.advanceDay(state);
  assert.equal(state.project, null, "upgrade project should finish within the day limit");
}

// 建成一座别墅群（镇库木材跳过开局）。
function builtVilla() {
  const state = simulation.createInitialState({ seed: 1 });
  addInventory(state, "town", "wood", 1500, "test villa stock", "test", CONTENT);
  const built = simulation.buildAt(state, "villa_complex", "village-01");
  assert.equal(built.ok, true, built.reason);
  for (const project of state.projects) simulation.setProjectWorkers(state, project.id, 100);
  for (let day = 0; day < 1200 && !state.buildings.length; day += 1) simulation.advanceDay(state);
  const villa = state.buildings.find(row => row.id === built.instanceId);
  assert.ok(villa, "villa complex should be built");
  return { state, villa };
}

test("villa complex defines an upgrade block capped at the general level cap", () => {
  const def = CONTENT.buildings.villa_complex;
  assert.ok(def.upgrade, "villa_complex must have an upgrade block");
  assert.equal(def.upgrade.maxLevel, CONTENT.rules.buildingMaxLevel);
  assert.equal(def.upgrade.maxLevel, MAX_LEVEL);
  assert.ok(def.upgrade.workDays > 0);
});

test("a villa complex can be upgraded step by step to level 10 and level 11 is refused", () => {
  const { state, villa } = builtVilla();
  assert.equal(villa.level, 1);
  assert.equal(simulation.validateState(state).valid, true);

  for (let level = 1; level < MAX_LEVEL; level += 1) {
    addInventory(state, "town", "wood", CONTENT.buildings.villa_complex.upgrade.materialRequirements[0].quantity,
      `test villa upgrade to ${level + 1}`, "test", CONTENT);
    const result = simulation.upgradeBuilding(state, villa.id);
    assert.equal(result.ok, true, `villa upgrade from ${level} failed: ${result.reason}`);
    advanceUntilIdle(state);
    assert.equal(villa.level, level + 1);
    assert.equal(simulation.validateState(state).valid, true, `state valid at villa level ${level + 1}`);
  }

  assert.equal(villa.level, MAX_LEVEL);
  addInventory(state, "town", "wood", 1500, "test villa over-cap stock", "test", CONTENT);
  const refused = simulation.upgradeBuilding(state, villa.id);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /最高等级/);
  assert.equal(villa.level, MAX_LEVEL);
  assert.equal(simulation.validateState(state).valid, true);
});

test("villa capacity grows per level: level 10 holds 10x the level-1 capacity", () => {
  const { state, villa } = builtVilla();
  const perLevel = CONTENT.buildings.villa_complex.villaCapacity;
  assert.equal(villaCapacityOf(villa, CONTENT), perLevel, "level 1 capacity");
  // 开局几十天内别墅可能已被富户买走，所以空置数按“容量 - 已售”校验，而不是直接等于容量。
  assert.equal(selectVillaVacancies(state, CONTENT).length, perLevel - state.villas.sold.length);

  for (let level = 1; level < MAX_LEVEL; level += 1) {
    addInventory(state, "town", "wood", 1500, `test villa upgrade to ${level + 1}`, "test", CONTENT);
    assert.equal(simulation.upgradeBuilding(state, villa.id).ok, true);
    advanceUntilIdle(state);
  }

  const capacity = perLevel * MAX_LEVEL;
  assert.equal(villaCapacityOf(villa, CONTENT), capacity, "level 10 capacity");
  assert.ok(villaCapacityOf(villa, CONTENT) > perLevel, "level 10 holds more than level 1");
  const sold = state.villas.sold.length;
  assert.equal(selectVillaVacancies(state, CONTENT).length, capacity - sold);
  const stats = simulation.selectDashboard(state, {}).policy.villaStats;
  assert.equal(stats.capacity, capacity);
  assert.equal(stats.sold, sold);
  assert.equal(stats.vacant, capacity - sold);
  assert.equal(simulation.validateState(state).valid, true);
});

test("villa building art renders levels 1..10 without bad numbers", () => {
  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    const svg = renderBuildingArt("villa_complex", { level, status: "complete" });
    assert.ok(svg.length > 0, `villa level ${level} renders`);
    assert.doesNotMatch(svg, /NaN|undefined/, `villa level ${level} has no bad numbers`);
  }
});
