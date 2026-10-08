import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { PLOTS } from "../src/content/world.js";
import { createSimulation } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";

const sim = createSimulation();
const PARCEL_W = 96;
const PARCEL_H = 72;
// 地块在地图上的矩形（与 map.js 的 renderParcel 一致：中心 x*12、y*10，宽 96、高 72）。
function parcelRect(plot) {
  const cx = plot.x * 12;
  const cy = plot.y * 10;
  return { left: cx - PARCEL_W / 2, right: cx + PARCEL_W / 2, top: cy - PARCEL_H / 2, bottom: cy + PARCEL_H / 2 };
}

test("plot ids are unique and positions are distinct", () => {
  const ids = PLOTS.map(plot => plot.id);
  assert.equal(new Set(ids).size, ids.length, "地块 id 重复");
  const spots = PLOTS.map(plot => `${plot.x},${plot.y}`);
  assert.equal(new Set(spots).size, spots.length, "地块坐标重复");
});

test("no two plot parcels overlap", () => {
  for (let i = 0; i < PLOTS.length; i += 1) {
    for (let j = i + 1; j < PLOTS.length; j += 1) {
      const a = parcelRect(PLOTS[i]);
      const b = parcelRect(PLOTS[j]);
      const apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      assert.ok(apart, `地块重叠：${PLOTS[i].id} / ${PLOTS[j].id}`);
    }
  }
});

test("there are at least 48 regular buildable plots", () => {
  const regular = PLOTS.filter(plot => !plot.feature);
  assert.ok(regular.length >= 48, `普通空地只有 ${regular.length} 块`);
});

test("there are 4 riverside plots, labelled 河岸 and kept off ordinary building lists", () => {
  const riverside = PLOTS.filter(plot => plot.feature === "riverside");
  assert.equal(riverside.length, 4);
  for (const plot of riverside) assert.match(plot.label, /^河岸/);
  const state = sim.createInitialState();
  const ordinary = state.plots.filter(plot => !plot.feature).map(plot => plot.id);
  for (const plot of riverside) assert.ok(!ordinary.includes(plot.id));
});

test("riverside plots: only the dock requires them; the foreign trade house may also use them", () => {
  const users = Object.values(CONTENT.buildings).filter(def => def.requiredPlotFeature === "riverside");
  assert.deepEqual(users.map(def => def.id), ["dock"]);
  assert.deepEqual([...CONTENT.buildings.foreign_trade_house.allowedPlotFeatures], ["riverside"]);
});

test("an old save without the new plots loads with every plot from content", () => {
  const state = sim.createInitialState();
  const newIds = new Set(PLOTS.map(plot => plot.id));
  const legacyIds = ["east", "south", "village-01", "village-22", "forest-logging-01", "forest-salt-01"];
  const beforeCount = PLOTS.length;
  // 模拟旧档：只保留一部分地块（删掉若干新增地块）。
  state.plots = state.plots.filter(plot => !(plot.id.startsWith("riverside-") || ["village-30", "village-40", "village-46"].includes(plot.id)));
  assert.ok(state.plots.length < beforeCount);
  const raw = JSON.parse(JSON.stringify(state));
  const loaded = migrateSave(raw, CONTENT);
  assert.equal(loaded.plots.length, beforeCount);
  assert.deepEqual(loaded.plots.map(plot => plot.id).sort(), PLOTS.map(plot => plot.id).sort());
  for (const id of legacyIds) assert.ok(loaded.plots.some(plot => plot.id === id), `旧地块 ${id} 丢失`);
  for (const id of newIds) assert.ok(loaded.plots.some(plot => plot.id === id), `新地块 ${id} 未加载`);
});
