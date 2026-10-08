import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { jobKeyForBuilding } from "../src/selectors/labor.js";
import { setJobCount } from "../src/systems/households.js";
import { renderBuildingArt } from "../src/ui/building-art.js";
import { buildingSymbol } from "../src/ui/art.js";
import { renderOutsideTown } from "../src/ui/panel-outside-town.js";
import { renderSite } from "../src/ui/panel-site.js";
import { renderMap } from "../src/ui/map.js";

// 运力建筑界面：美术、外贸运力行、站点运力、河岸地块选点高亮。
const RULES = CONTENT.rules;

function freePlot(state, feature = null) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => (feature ? row.feature === feature : !row.feature) && !used.has(row.id));
  assert.ok(plot, "需要空地");
  return plot;
}

function addBuilding(state, id, typeId, plot) {
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return id;
}

// 外贸房 + 物流中心 + 码头（河岸）各派工；池子给一点，便于界面显示。
function freightState(seed = 7301) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "ftrade", "foreign_trade_house", freePlot(state));
  setJobCount(state, "ftrade::trade_staff", 2, CONTENT);
  addBuilding(state, "lc1", "logistics_center", freePlot(state));
  setJobCount(state, jobKeyForBuilding("lc1", "porters"), 3, CONTENT);
  addBuilding(state, "dock1", "dock", freePlot(state, "riverside"));
  setJobCount(state, jobKeyForBuilding("dock1", "dockers"), 2, CONTENT);
  state.logistics.poolJin = 500;
  return state;
}

function houseFallback() {
  return renderBuildingArt("__no_such_building__", { level: 1 });
}

test("运力建筑有自己的美术，不退回通用民居", () => {
  const fallback = houseFallback();
  for (const type of ["logistics_center", "dock", "trade_center"]) {
    const art = renderBuildingArt(type, { level: 1 });
    assert.ok(art.length > 200, `${type} 美术为空`);
    assert.notEqual(art, fallback, `${type} 仍是通用民居`);
  }
  assert.notEqual(renderBuildingArt("dock", { level: 1 }), renderBuildingArt("logistics_center", { level: 1 }));
  assert.notEqual(renderBuildingArt("trade_center", { level: 1 }), renderBuildingArt("trade_center", { level: 3 }));
});

test("建造面板卡片图标：运力建筑使用同款美术", () => {
  for (const type of ["logistics_center", "dock", "trade_center"]) {
    const card = buildingSymbol(type, "idle");
    assert.ok(card.includes(`building-art ${type} idle`), `${type} 卡片缺少类名`);
    assert.ok(card.includes("ink-building"), `${type} 卡片未使用建筑美术`);
  }
});

test("外贸面板：运力行显示今日可用、日运力与三个来源", () => {
  const state = freightState();
  const view = simulation.selectDashboard(state, { panel: "business" });
  const html = renderOutsideTown(view);
  const src = view.logistics.capacityBySource;
  assert.equal(src.foreignTradeHouse, RULES.tradeBaseCapacityJin);
  assert.equal(src.logisticsCenter, 3 * RULES.logisticsJinPerWorker);
  assert.equal(src.dock, 2 * RULES.dockJinPerWorker);
  const daily = src.foreignTradeHouse + src.logisticsCenter + src.dock;
  assert.ok(html.includes("freight-row"), "缺少运力行");
  assert.ok(html.includes(`日运力 ${daily.toLocaleString("zh-CN")} 斤`), "日运力数字不对");
  assert.ok(html.includes(`今日可用 ${Math.round(view.logistics.poolJin).toLocaleString("zh-CN")} 斤`), "今日可用数字不对");
  assert.ok(html.includes(`外贸房 ${src.foreignTradeHouse.toLocaleString("zh-CN")} / 物流 ${src.logisticsCenter.toLocaleString("zh-CN")} / 码头 ${src.dock.toLocaleString("zh-CN")}`));
});

test("站点面板：物流中心与码头显示本座运力（在岗 × 每人每日运力）", () => {
  const state = freightState();
  const lc = simulation.selectDashboard(state, { panel: "site", site: "building:lc1" });
  const lcHtml = renderSite(lc);
  assert.ok(lcHtml.includes(`本座运力`), "物流中心缺少运力行");
  assert.ok(lcHtml.includes(`在岗3人 × 60斤 = 180斤/日`), `物流中心运力文案不对：${lcHtml.match(/本座运力[^<]*<\/span><strong[^>]*>[^<]*/)?.[0]}`);
  const dock = simulation.selectDashboard(state, { panel: "site", site: "building:dock1" });
  const dockHtml = renderSite(dock);
  assert.ok(dockHtml.includes(`在岗2人 × 120斤 = 240斤/日`), "码头运力文案不对");
});

test("建造选点：码头只高亮河岸地块，普通建筑不出现河岸选点", () => {
  const state = freightState();
  const nav = (buildType, activePanel = "build") => ({ activePanel, buildType, previewPlotId: null, selectedSite: null });
  const dockView = simulation.selectDashboard(state, { panel: "build" });
  const dockOption = dockView.constructionOptions.find(row => row.id === "dock");
  assert.ok(dockOption, "码头应在建造选项中");
  const dockMap = renderMap({ ...dockView, buildMode: true }, nav("dock"));
  const riversideTargets = (dockMap.match(/class="plot-target[^"]*riverside-site/g) || []).length;
  const riversidePlots = state.plots.filter(plot => plot.feature === "riverside" && !state.buildings.some(row => row.plotId === plot.id));
  assert.equal(riversideTargets, riversidePlots.length, "码头选点应高亮全部空河岸地块");
  assert.ok(riversideTargets > 0);

  const wholesaleOption = dockView.constructionOptions.find(row => row.id === "wholesale_market");
  assert.ok(wholesaleOption, "批发市场应在建造选项中");
  const wholesaleMap = renderMap({ ...dockView, buildMode: true }, nav("wholesale_market"));
  assert.equal((wholesaleMap.match(/riverside-site/g) || []).length, 0, "普通建筑不应出现河岸选点");
});
