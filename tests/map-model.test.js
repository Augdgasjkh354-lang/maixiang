import test from "node:test";
import assert from "node:assert/strict";
import { MAP_PRESENTATION, canvasBackingSize, createMapModel } from "../src/ui/map-model.js";

function makeView() {
  const plots = [
    { id: "east", label: "溪畔空地", x: 76.5, y: 58.5 },
    { id: "village-01", label: "空地 1", x: 22, y: 52 },
    { id: "village-02", label: "空地 2", x: 34, y: 52 }
  ];
  return {
    season: { key: "summer" },
    paused: true,
    plots,
    buildings: [{
      id: "building-7", typeId: "mill", plotId: "east", x: 76.5, y: 58.5,
      status: { status: "ready", label: "运转中", batches: 3 },
      jobs: [{ id: "millers", workers: 3, capacity: 8 }]
    }],
    project: { instanceId: "building-8", typeId: "bakery", plotId: "village-01", percent: 42 }
  };
}

test("map display model follows real instance IDs, job rows and plot occupancy", () => {
  const view = makeView();
  const model = createMapModel(view, {
    activePanel: "build", buildType: "mill", previewPlotId: "village-02"
  });

  assert.equal(model.buildings[0].instanceId, "building-7");
  assert.equal(model.buildings[0].plotId, "east");
  assert.deepEqual(model.buildings[0].jobs, [{ id: "millers", workers: 3, capacity: 8 }]);
  assert.equal(model.buildings[0].working, true);
  assert.equal(model.project.instanceId, "building-8");
  assert.equal(model.project.progress, 0.42);
  assert.equal(model.plots.find(plot => plot.id === "east").occupied, true);
  assert.equal(model.plots.find(plot => plot.id === "village-01").occupied, true);
  assert.equal(model.previewPlot.id, "village-02");
  assert.equal(model.freePlots.length, 1);

  const buildingTile = Object.values(model.world.tiles).find(tile => tile.plotId === "east");
  const projectTile = Object.values(model.world.tiles).find(tile => tile.plotId === "village-01");
  assert.equal(buildingTile.building.instanceId, "building-7");
  assert.equal(projectTile.project.instanceId, "building-8");
});

test("map presentation includes the full land grid and restrained southern/western scenery", () => {
  const model = createMapModel(makeView(), { activePanel: null });
  assert.equal(model.world.width * model.world.height, 750);
  assert.equal(Object.keys(model.world.tiles).length, 750);
  assert.equal(model.world.tiles["0,4"].terrain, "water");
  assert.equal(model.world.tiles["6,6"].terrain, "farmland");
  assert.equal(model.world.tiles["15,22"].terrain, "forest");
  assert.deepEqual(MAP_PRESENTATION, { width: 1200, height: 1000, tileSize: 40, columns: 30, rows: 25 });
});

test("canvas backing dimensions respect CSS size and high-density screens", () => {
  assert.deepEqual(canvasBackingSize(390, 844, 2), { width: 780, height: 1688, ratio: 2 });
  assert.deepEqual(canvasBackingSize(1200, 1000, 6), { width: 3600, height: 3000, ratio: 3 });
});
