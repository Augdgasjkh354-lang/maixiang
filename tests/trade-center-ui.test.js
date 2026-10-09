import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { selectTradeHouseView } from "../src/selectors/trade-houses.js";
import { renderBuild, setBuildCategory } from "../src/ui/panel-build.js";
import { renderPolicy } from "../src/ui/panel-policy.js";
import { renderSite } from "../src/ui/panel-site.js";
import { renderOutsideTown } from "../src/ui/panel-outside-town.js";
import { freightLimitNote } from "../src/ui/freight-note.js";

// 贸易中心 / 贸易行界面：建造分类、政策门控、站点卡片（无零售货架，有买卖数字与店员手动增减）、
// 外贸面板的贸易行汇总，以及"受运力限制"提示。

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
}

// 贸易中心 + 一家开着的贸易行（店主之外另有商人和店员）。
function tradeCenterState(seed = 7401) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "tc1", "trade_center", freePlot(state));
  const opened = simulation.openResidentShop(state, "tc1", "trading_house");
  assert.ok(opened.ok, opened.reason);
  return { state, shopId: opened.shopId || Object.values(state.shops).find(row => row.typeId === "trading_house").id };
}

function siteView(state) {
  const view = simulation.selectDashboard(state, { panel: "site", site: "building:tc1" });
  return { ...view, tradeHouses: selectTradeHouseView(state, CONTENT) };
}

test("建造面板：贸易中心在商业分类里", () => {
  const { state } = tradeCenterState();
  const view = simulation.selectDashboard(state, { panel: "build" });
  setBuildCategory("commercial");
  const html = renderBuild(view);
  setBuildCategory("production");
  assert.ok(html.includes(`data-build="trade_center"`), "商业分类应含贸易中心");
});

test("政策页：有贸易中心时显示家庭与商业卡片", () => {
  const state = simulation.createInitialState({ seed: 7402 });
  addBuilding(state, "tc2", "trade_center", freePlot(state));
  const view = simulation.selectDashboard(state, { panel: "policy" });
  assert.ok(renderPolicy(view).includes(`data-detail-key="policy-commerce"`), "贸易中心应开启商业卡片");
});

test("站点：贸易中心显示开贸易行入口与贸易行卡片（无零售货架，有店员手动增减）", () => {
  const { state } = tradeCenterState();
  const html = renderSite(siteView(state));
  assert.ok(html.includes(`data-shop-open="trading_house"`), "缺少开贸易行按钮");
  assert.ok(html.includes("贸易中心"), "标题应是贸易中心");
  assert.ok(html.includes("trade-shop"), "缺少贸易行卡片");
  assert.ok(html.includes("暂无可做的买卖"), "新开的贸易行应显示暂无可做的买卖");
  assert.ok(html.includes("近7日出口 / 进口") && html.includes("运费 今日 / 近7日") && html.includes("持有小麦"));
  assert.ok(!html.includes("data-shop-clerk") && html.includes("（自动）"), "贸易行店员由系统自动增减，不再有手动按钮");
  assert.ok(!html.includes("shop-stock-grid"), "贸易行不应有零售货架");
});

test("站点：没有贸易行数据时贸易中心仍能渲染（不报错）", () => {
  const { state } = tradeCenterState();
  const view = simulation.selectDashboard(state, { panel: "site", site: "building:tc1" });
  assert.doesNotThrow(() => renderSite({ ...view, tradeHouses: null }));
});

test("外贸面板：贸易行汇总与合计一致", () => {
  const { state } = tradeCenterState();
  const view = simulation.selectDashboard(state, { panel: "business" });
  const html = renderOutsideTown({ ...view, tradeHouses: selectTradeHouseView(state, CONTENT) });
  assert.ok(html.includes("trade-house-summary"), "缺少贸易行汇总");
  assert.ok(html.includes("1家"), "应显示贸易行家数");
  const none = renderOutsideTown({ ...view, tradeHouses: null });
  assert.ok(!none.includes("trade-house-summary"), "没有贸易行时不显示汇总");
});

test("运力提示：请求量大于成交量且运力池几乎用尽时才提示受运力限制", () => {
  assert.equal(freightLimitNote(1500, 900, 900), "（受运力限制）");
  assert.equal(freightLimitNote(500, 500, 900), "", "足量成交不提示");
  assert.equal(freightLimitNote(1500, 900, 5000), "", "池子还有余量（资金或库存限制）不提示");
  assert.equal(freightLimitNote(NaN, 900, 900), "");
});
