import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount } from "../src/systems/households.js";
import { renderOutsideTown } from "../src/ui/panel-outside-town.js";
import { ensureOutsideTowns } from "../src/systems/outside-town.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const TOWN_IDS = Object.keys(CONTENT.outsideTowns);

function tradingState(seed = 5101) {
  const state = simulation.createInitialState({ seed });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({
    id: "ftrade", typeId: "foreign_trade_house", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  setJobCount(state, "ftrade::trade_staff", 2, CONTENT);
  state.accounts.town.salt = (state.accounts.town.salt || 0) + 50000 * I;
  state.accounts.town.flour = (state.accounts.town.flour || 0) + 50000 * I;
  return state;
}

function viewFor(state, townId) {
  return simulation.selectDashboard(state, { panel: "business", outsideTownId: townId });
}

test("外贸视图：每个外镇一份，选中哪个就带哪个的数据，缺省为民镇", () => {
  const state = tradingState();
  const dflt = simulation.selectDashboard(state, { panel: "business" });
  assert.deepEqual(dflt.outsideTowns.map(row => row.id), TOWN_IDS);
  assert.equal(dflt.outsideTown.id, "minzhen");
  assert.equal(dflt.outsideTownId, "minzhen");

  const wang = viewFor(state, "wangzhen");
  assert.equal(wang.outsideTown.id, "wangzhen");
  assert.equal(wang.outsideTown.name, "王镇");
  assert.equal(wang.tradeAgreements.agreements.length, 0);
  // 未知 id 回退到默认外镇，不能让界面崩掉。
  assert.equal(simulation.selectDashboard(state, { panel: "business", outsideTownId: "nowhere" }).outsideTown.id, "minzhen");
});

test("外贸面板：顶部切换条列出全部外镇，选中项高亮，两镇的货品都有酒和布", () => {
  const state = tradingState(5102);
  const html = renderOutsideTown(viewFor(state, "wangzhen"));
  assert.match(html, /data-outside-town="minzhen"[^>]*aria-pressed="false"/);
  assert.match(html, /data-outside-town="wangzhen"[^>]*aria-pressed="true"/);
  assert.match(html, /class="build-tab selected" data-outside-town="wangzhen"/);
  assert.match(html, />民镇</);
  assert.match(html, />王镇</);
  assert.match(html, /<h2>外贸 · 王镇<\/h2>/);
  assert.match(html, /人口\d[\d,]* · 繁荣\d+ · 关系\d+/);

  for (const townId of TOWN_IDS) {
    const page = renderOutsideTown(viewFor(state, townId));
    assert.match(page, /<span class="label">酒<\/span>/, `${townId} 应有酒`);
    assert.match(page, /<span class="label">布<\/span>/, `${townId} 应有布`);
    assert.doesNotMatch(page, /undefined|NaN|Infinity/, `${townId} 不应出现 undefined/NaN`);
    // 动作按钮都带城镇 id，数量草稿键也带城镇 id。
    assert.match(page, new RegExp(`data-outside-sell="salt" data-town="${townId}"`));
    assert.match(page, new RegExp(`data-wheat-loan-issue="1" data-town="${townId}"`));
    assert.match(page, new RegExp(`data-agreement-sign="1" data-town="${townId}"`));
    assert.match(page, new RegExp(`data-draft-key="outside-qty:${townId}:salt"`));
  }
});

test("外贸面板：没有外贸房时仍能渲染切换条与两镇数据", () => {
  const state = simulation.createInitialState({ seed: 5103 });
  const html = renderOutsideTown(viewFor(state, "minzhen"));
  assert.match(html, /data-outside-town="wangzhen"/);
  assert.match(html, /无人值守/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("与王镇贸易只改变王镇的库存，民镇库存不动", () => {
  const state = tradingState(5104);
  const towns = ensureOutsideTowns(state, CONTENT);
  const minzhenBefore = { ...towns.minzhen.stocks };
  const wangBefore = towns.wangzhen.stocks.salt;
  const townSaltBefore = state.accounts.town.salt;

  const result = simulation.tradeWithOutsideTown(state, "sell", "salt", 2000, "wangzhen");
  assert.equal(result.ok, true, result.reason);

  assert.ok(towns.wangzhen.stocks.salt > wangBefore, "王镇盐库存应增加");
  assert.deepEqual(towns.minzhen.stocks, minzhenBefore, "民镇库存不应变化");
  assert.ok(state.accounts.town.salt < townSaltBefore, "镇库盐应减少");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});
