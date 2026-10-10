import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { setJobCount } from "../src/systems/households.js";
import { renderSite } from "../src/ui/panel-site.js";
import { renderEconomy } from "../src/ui/panel-economy.js";
import { renderOutsideTown } from "../src/ui/panel-outside-town.js";
import { wholesaleItemIds } from "../src/content/assemble.js";

const I = CONTENT.precision.inventoryUnitsPerJin;

// 测试夹具：在第一块无地形的空地上落一座建筑（与 outside-town-ui 的写法一致）。
function addBuilding(state, typeId, id) {
  const def = CONTENT.buildings[typeId];
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = {
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function tradingState(seed) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "foreign_trade_house", "ftrade");
  setJobCount(state, "ftrade::trade_staff", 2, CONTENT);
  addBuilding(state, "wholesale_market", "wmarket");
  state.logistics.poolJin = 1000000;
  state.accounts.town.salt = (state.accounts.town.salt || 0) + 50000 * I;
  state.accounts.town.flour = (state.accounts.town.flour || 0) + 50000 * I;
  return state;
}

function siteHtml(state, site) {
  return renderSite(simulation.selectDashboard(state, { panel: "site", site }));
}

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

test("外贸房面板：长协签约、行情买卖、小麦贷款都在外贸房里，且带人员排班", () => {
  const state = tradingState(7101);
  const html = siteHtml(state, "building:ftrade");
  assert.match(html, /<h2>外贸房 · /);
  assert.match(html, /data-agreement-sign="1" data-town="minzhen"/);
  assert.match(html, /data-outside-buy="[a-z]+" data-town="minzhen"/);
  assert.match(html, /data-outside-sell="salt" data-town="minzhen"/);
  assert.match(html, /data-wheat-loan-issue="1"/);
  assert.match(html, /data-outside-town="wangzhen"/);
  assert.match(html, /data-job="ftrade::trade_staff"/, "外贸房面板应保留人员排班");
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("经营面板：外贸只剩摘要与前往外贸房按钮，不再含长协签约与行情买卖", () => {
  const state = tradingState(7102);
  const html = renderEconomy(simulation.selectDashboard(state, { panel: "business" }));
  assert.doesNotMatch(html, /data-agreement-sign/);
  assert.doesNotMatch(html, /data-outside-buy/);
  assert.doesNotMatch(html, /data-outside-sell/);
  assert.match(html, /data-open-building="ftrade"/);
  assert.match(html, /前往外贸房/);
  assert.match(html, /长协 0 份/);
  assert.match(html, /运力今日/);
  assert.match(html, /freight-row/, "运力池摘要应保留在经营");
});

test("经营面板：没有外贸房时前往按钮禁用，并提示尚未建外贸房", () => {
  const state = simulation.createInitialState({ seed: 7103 });
  const html = renderEconomy(simulation.selectDashboard(state, { panel: "business" }));
  assert.match(html, /尚未建外贸房/);
  assert.match(html, /<button class="secondary" disabled>前往外贸房<\/button>/);
});

test("外贸房面板的外贸功能与外贸面板函数一致（同一个 view）", () => {
  const state = tradingState(7104);
  const view = simulation.selectDashboard(state, { panel: "site", site: "building:ftrade" });
  const page = renderOutsideTown(view);
  assert.ok(siteHtml(state, "building:ftrade").includes(page), "外贸房面板应直接嵌入 renderOutsideTown 的输出");
});

test("选中其他建筑时外贸数据不计算（界面不被拖慢）", () => {
  const state = tradingState(7105);
  const view = simulation.selectDashboard(state, { panel: "site", site: "building:wmarket" });
  assert.equal(view.outsideTown, null);
  assert.equal(view.tradeAgreements, null);
  assert.equal(view.logistics, null);
});

test("批发市场面板：每种商品是可折叠的 details，汇总卡带全部展开/收起按钮，做市控件数量不变", () => {
  const state = tradingState(7106);
  const html = siteHtml(state, "building:wmarket");
  const itemCount = wholesaleItemIds(CONTENT).length;
  assert.equal(count(html, /<details class="detail-block wholesale-item" data-wholesale-item="/g), itemCount);
  assert.equal(count(html, /data-wholesale-stockpile="/g), itemCount, "收储按钮数量应保持不变");
  assert.equal(count(html, /data-wholesale-release="/g), itemCount, "投放按钮数量应保持不变");
  assert.equal(count(html, /data-draft-kind="wholesale-purchase-price"/g), itemCount, "收购价输入应保持不变");
  assert.equal(count(html, /data-draft-kind="wholesale-price"/g), itemCount, "售价输入应保持不变");
  assert.equal(count(html, /data-wholesale-toggle-all="1"/g), 1);
  // 摘要行：名称 · 库存 · 售价 · 可售天数。
  assert.match(html, /<span class="wholesale-brief">库存[\d.,]+斤 · 售[\d.,]+粮券\/斤 · (可售[\d.,]+天|无销量)<\/span>/);
});

test("批发市场面板：商品卡默认收起", () => {
  const state = tradingState(7107);
  const html = siteHtml(state, "building:wmarket");
  assert.equal(count(html, /<details class="detail-block wholesale-item" data-wholesale-item="[^"]*" data-detail-key="[^"]*" open/g), 0);
});

test("价格输入唯一：面粉/面包/木材的售价只在批发市场面板出现一次", () => {
  const state = tradingState(7108);
  const wholesale = siteHtml(state, "building:wmarket");
  const economy = renderEconomy(simulation.selectDashboard(state, { panel: "all", paused: true, speed: 1 }));
  for (const itemId of ["flour", "bread", "wood"]) {
    assert.equal(count(wholesale, new RegExp(`data-draft-key="wholesale-price:${itemId}"`, "g")), 1, `${itemId} 售价输入在批发面板应唯一`);
  }
  assert.doesNotMatch(economy, /data-intermediate-price/, "经营面板不应再有中间品价格输入");
  assert.doesNotMatch(economy, /data-draft-kind="bread-price"/, "经营面板不应再有面包售价输入");
  assert.doesNotMatch(economy, /data-draft-key="intermediate:/);
  assert.doesNotMatch(economy, /data-draft-kind="wholesale-price"/, "经营面板不应有批发售价输入");
  assert.match(economy, /data-open-building="wmarket"/, "经营面板的价格区应提供前往批发市场");
});

test("价格显示同步：改批发售价后，经营面板的面包与面粉价格随之更新", () => {
  const state = tradingState(7109);
  const result = simulation.configureWholesalePrice(state, "bread", 3.5);
  assert.equal(result.ok, true);
  const economy = renderEconomy(simulation.selectDashboard(state, { panel: "business" }));
  assert.match(economy, /面包<\/span><strong class="value">3\.5\d*/);
});
