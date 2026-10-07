import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { simulation, CONTENT } from "../src/engine.js";
import { renderBuild } from "../src/ui/panel-build.js";
import { createNavigationState, isChoosingBuildPlot } from "../src/ui/navigation-state.js";

function firstPlainPlot(state) {
  return state.plots.find(plot => !plot.feature && !state.buildings.some(building => building.plotId === plot.id));
}

function confirmationView(state, typeId, plotId) {
  return simulation.selectDashboard(state, { build: typeId, plotId, paused: true, speed: 1 });
}

test("手机建造：材料不足时直接进入确认页、显示缺口并禁用开工，预览不扣料", () => {
  const state = simulation.createInitialState();
  const plot = firstPlainPlot(state);
  const beforeWood = state.accounts.town.wood || 0;
  const html = renderBuild(confirmationView(state, "public_housing", plot.id));

  assert.match(html, /公租住宅区 · 开工确认/);
  assert.match(html, new RegExp(plot.label));
  assert.match(html, /预计工期/);
  assert.match(html, /预计工资/);
  assert.match(html, /还缺2,000木材/);
  assert.match(html, /data-start-building disabled/);
  assert.match(html, /data-cancel-build>重新选址/);
  assert.doesNotMatch(html, /class="building-option/,
    "选中地块后不应继续展示建筑列表");
  assert.equal(state.accounts.town.wood || 0, beforeWood, "选址预览不得扣材料");

  const failed = simulation.buildAt(state, "public_housing", plot.id);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /还缺2,000木材/);
  assert.equal(state.project, null);
  assert.equal(state.accounts.town.wood || 0, beforeWood);
});

test("手机建造：材料充足时确认开工只扣一次，重复确认不会再次扣料", () => {
  const state = simulation.createInitialState();
  const plot = firstPlainPlot(state);
  const requiredUnits = 2000 * CONTENT.precision.inventoryUnitsPerJin;
  state.accounts.town.wood = requiredUnits;

  const html = renderBuild(confirmationView(state, "public_housing", plot.id));
  assert.match(html, /材料已备齐/);
  assert.match(html, /data-start-building >确认开工/);
  assert.doesNotMatch(html, /data-start-building disabled/);
  assert.equal(state.accounts.town.wood, requiredUnits, "仅预览时材料仍应完整保留");

  const started = simulation.buildAt(state, "public_housing", plot.id);
  assert.equal(started.ok, true);
  assert.equal(state.accounts.town.wood, 0, "确认开工时应恰好扣除一次材料");
  const second = simulation.buildAt(state, "public_housing", plot.id);
  assert.equal(second.ok, false);
  assert.equal(state.accounts.town.wood, 0, "重复确认不得产生第二次扣料");
});

test("手机建造：重新选址与取消都保留正常导航语义", () => {
  const nav = createNavigationState();
  nav.chooseBuild("public_housing");
  nav.choosePlot("east");
  assert.equal(isChoosingBuildPlot(nav.state), false);

  nav.reselectBuildPlot();
  assert.equal(nav.state.buildType, "public_housing");
  assert.equal(nav.state.previewPlotId, null);
  assert.equal(nav.state.activePanel, "build");
  assert.equal(isChoosingBuildPlot(nav.state), true, "重新选址应回到地图选地状态");

  nav.choosePlot("east");
  nav.closePanel();
  assert.equal(nav.state.activePanel, null);
  assert.equal(nav.state.buildType, null);
  assert.equal(nav.state.previewPlotId, null, "取消/关闭应正常退出建造流程");
});

test("手机建造确认操作栏固定到底部并适配安全区域", () => {
  const css = fs.readFileSync(new URL("../src/styles/main.css", import.meta.url), "utf8");
  assert.match(css, /\.build-confirm-actions\s*\{[^}]*position:\s*sticky;/s);
  assert.match(css, /\.build-confirm-actions\s*\{[^}]*bottom:\s*0;/s);
  assert.match(css, /\.build-confirm-actions\s*\{[^}]*safe-area-inset-bottom/s);
});
