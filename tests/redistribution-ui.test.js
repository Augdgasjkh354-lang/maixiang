import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { selectInequality } from "../src/selectors/inequality.js";
import { selectTradeHouseView } from "../src/selectors/trade-houses.js";
import { renderBuild, setBuildCategory } from "../src/ui/panel-build.js";
import { renderPolicy } from "../src/ui/panel-policy.js";
import { renderPeople } from "../src/ui/panel-people.js";
import { renderSite } from "../src/ui/panel-site.js";

// 再分配工具箱界面（docs/REDISTRIBUTION.md）：政策页富人税/遗产税、社保局雇主缴费、贫富面板、商业街开店按钮、丝绸桑园。

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

function policyView(state) {
  return { ...simulation.selectDashboard(state, { panel: "policy" }), inequality: selectInequality(state, CONTENT), numericDrafts: {} };
}

test("政策页：富人税卡片显示三档门槛与税率，并有保存按钮", () => {
  const state = simulation.createInitialState({ seed: 8101 });
  const html = renderPolicy(policyView(state));
  assert.ok(html.includes(`data-detail-key="policy-wealthtax"`), "应有富人税卡片");
  assert.ok(html.includes("data-wealth-tax-save"), "富人税应有保存按钮");
  assert.ok(html.includes("超额累进，每30天收一次，付不起的部分当月免征"));
  assert.equal((html.match(/data-draft-key="wealth-tax:threshold:\d"/g) || []).length, 3);
  assert.equal((html.match(/data-draft-key="wealth-tax:rate:\d"/g) || []).length, 3);
  assert.ok(html.includes(`value="300"`) && html.includes(`value="3000"`), "默认门槛应显示");
});

test("政策页：遗产税卡片显示税率与整户无人归镇库的说明", () => {
  const state = simulation.createInitialState({ seed: 8102 });
  const html = renderPolicy(policyView(state));
  assert.ok(html.includes(`data-detail-key="policy-inheritance"`));
  assert.ok(html.includes(`data-draft-key="inheritance-tax"`));
  assert.ok(html.includes("整户无人时家产归镇库（一直生效）"));
});

test("政策页：富人税的草稿值会回显到输入框", () => {
  const state = simulation.createInitialState({ seed: 8103 });
  const view = { ...policyView(state), numericDrafts: { "wealth-tax:rate:1": { value: "7.5" } } };
  assert.ok(renderPolicy(view).includes(`value="7.5"`));
});

test("社保局：显示雇主承担比例与今日缴费拆分、欠缴", () => {
  const state = simulation.createInitialState({ seed: 8104 });
  addBuilding(state, "ss1", "social_security_office", freePlot(state));
  state.socialSecurity.employerArrears = { "town": 12000, "shop:fake": 0 };
  state.socialSecurity.lastContribution = { workers: 4, dueValueUnits: 8000, collectedValueUnits: 6000, employerDueValueUnits: 6000, employerCollectedValueUnits: 4000, householdDueValueUnits: 2000, householdCollectedValueUnits: 2000 };
  const view = simulation.selectDashboard(state, { panel: "site", site: "building:ss1" });
  const html = renderSite(view);
  assert.ok(html.includes(`data-draft-key="social-employer-share"`), "应有雇主承担比例输入");
  assert.ok(html.includes("雇主承担比例"));
  assert.ok(html.includes("社保缴费拆分（今日）"));
  assert.ok(html.includes("雇主欠缴合计"));
  assert.ok(html.includes("镇营"), "欠缴按类别应有镇营");
});

test("贫富面板：基尼系数、税档、本年再分配收入；曲线点数不足两个时不画", () => {
  const state = simulation.createInitialState({ seed: 8105 });
  const single = renderPeople(simulation.selectDashboard(state, { panel: "residents" }));
  assert.ok(single.includes("基尼系数"), "人口面板应有基尼系数");
  assert.ok(single.includes("本年富人税"));
  assert.ok(!single.includes("gini-sparkline"), "少于两年不画曲线");

  state.redistribution.giniHistory = [{ year: 1, gini: 0.31 }, { year: 2, gini: 0.36 }, { year: 3, gini: 0.34 }];
  const many = renderPeople(simulation.selectDashboard(state, { panel: "residents" }));
  assert.ok(many.includes(`class="gini-sparkline"`), "两年以上应画曲线");
  assert.ok(many.includes("<polyline"));
  assert.ok(many.includes("0.31") && many.includes("0.34"));
});

test("商业街：开店按钮从店铺定义派生，含开戏园；戏园店铺行标注宽裕度门槛", () => {
  const state = simulation.createInitialState({ seed: 8106 });
  addBuilding(state, "cs1", "commercial_street", freePlot(state));
  const html = renderSite(simulation.selectDashboard(state, { panel: "site", site: "building:cs1" }));
  assert.ok(html.includes(`data-shop-open="theater"`), "应有开戏园按钮");
  assert.ok(html.includes("开戏园"));
  assert.ok(!html.includes(`data-shop-open="trading_house"`), "商业街不应有贸易行");
  assert.ok(!html.includes(`data-shop-open="grain"`) && !html.includes(`data-shop-open="bakery"`), "旧别名不出现");

  const opened = simulation.openResidentShop(state, "cs1", "theater");
  assert.ok(opened.ok, opened.reason);
  const after = renderSite({ ...simulation.selectDashboard(state, { panel: "site", site: "building:cs1" }), tradeHouses: selectTradeHouseView(state, CONTENT) });
  assert.ok(after.includes("仅宽裕人家（宽裕度≥1.5）光顾"));
});

test("建造面板：桑园（丝绸 mod）在生产分类里", () => {
  const state = simulation.createInitialState({ seed: 8107 });
  const view = simulation.selectDashboard(state, { panel: "build" });
  setBuildCategory("production");
  assert.ok(renderBuild(view).includes(`data-build="mulberry_garden"`), "生产分类应含桑园");
});
