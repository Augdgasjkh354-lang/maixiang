import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";

test("外交房已并入外贸房：旧档里的外交房载入时拆除，外贸房在岗维护关系分", () => {
  const state = simulation.createInitialState({ seed: 7301 });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({ id: "dip-1", typeId: "diplomacy_house", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  const loaded = migrateSave(JSON.parse(JSON.stringify(state)), CONTENT);
  assert.equal(loaded.buildings.some(row => row.typeId === "diplomacy_house"), false);
  assert.equal(CONTENT.buildings.diplomacy_house, undefined);
  assert.equal(simulation.validateState(loaded).valid, true);
});
