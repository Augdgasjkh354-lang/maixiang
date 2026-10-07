import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { createSimulation } from "../src/engine.js";

// 别墅群没有岗位定义时，建成后 selectDashboard 遍历 definition.jobs 崩溃，整个界面卡死。
test("别墅群建成后 selectDashboard 不崩溃", () => {
  for (const [typeId, definition] of Object.entries(CONTENT.buildings)) {
    assert.ok(Array.isArray(definition.jobs), `${typeId} 必须有 jobs 数组（可为空）`);
  }
  const sim = createSimulation();
  const state = sim.createInitialState({ seed: 1 });
  state.accounts.town.wood = (state.accounts.town.wood || 0) + 5000 * CONTENT.precision.inventoryUnitsPerJin;
  assert.equal(sim.buildAt(state, "villa_complex", "village-01").ok, true);
  for (const project of state.projects) sim.setProjectWorkers(state, project.id, 100);
  for (let day = 0; day < 400 && !state.buildings.length; day++) sim.advanceDay(state);
  const villa = state.buildings.find(building => building.typeId === "villa_complex");
  assert.ok(villa, "别墅群应已建成");
  assert.doesNotThrow(() => sim.selectDashboard(state, {}));
  const view = sim.selectDashboard(state, { site: `building:${villa.id}` });
  assert.deepEqual(view.buildings.find(building => building.id === villa.id).jobs, []);
});
