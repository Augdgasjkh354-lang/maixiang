// 所有制界面（docs/OWNERSHIP.md）：整栋卖给民营、镇里按估值收回、整栋上市表单、民营上市申请、欠薪徽章、业主自主升级。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { householdList } from "../src/systems/households.js";
import { renderSite } from "../src/ui/panel-site.js";
import { renderEconomy } from "../src/ui/panel-economy.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, { level = 1, owner = "town", ownerId = null } = {}) {
  const plot = state.plots.find(row => !row.feature && !state.buildings.some(b => b.plotId === row.id));
  const ownership = { townLevels: 0, privateLevels: 0, listedLevels: 0 };
  ownership[owner === "household" ? "privateLevels" : "townLevels"] = level;
  const building = { id, typeId, level, ownership, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } };
  if (owner === "household") building.privateOwners = [ownerId];
  state.buildings.push(building);
  return building;
}

function siteHtml(state, id, extras = {}) {
  const view = simulation.selectDashboard(state, { panel: "all", site: `building:${id}`, paused: true, speed: 1 });
  return renderSite({ ...view, ...extras });
}

function baseState() {
  const state = legacyVoucherState({ seed: 7 });
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  addBuilding(state, "wholesale_market", "market-t");
  return state;
}

test("镇营产业详情显示整栋卖给民营，不再显示旧的出售一级经营权与合资买家", () => {
  const state = baseState();
  addBuilding(state, "saltworks", "salt-t", { level: 2 });
  const html = siteHtml(state, "salt-t");
  assert.match(html, /整栋卖给民营/);
  assert.match(html, /预览出售/);
  assert.match(html, /要价/);
  assert.doesNotMatch(html, /出售一级经营权/);
  assert.doesNotMatch(html, /合资/);
  assert.doesNotMatch(html, /data-buyback/);
});

test("民营建筑显示镇里按估值收回按钮；估值为零时按钮禁用并给出原因", () => {
  const state = baseState();
  const owner = householdList(state)[0];
  addBuilding(state, "saltworks", "salt-p", { owner: "household", ownerId: owner.id });
  const html = siteHtml(state, "salt-p");
  assert.match(html, /data-buyback="salt-p"/);
  assert.match(html, /镇里按估值收回/);
  assert.doesNotMatch(html, /data-right-preview/);
  if (!(simulation.selectDashboard(state, { panel: "all", site: "building:salt-p", paused: true, speed: 1 }).buildings.find(b => b.id === "salt-p").operatingRight.valuationWheatJin > 0)) {
    assert.match(html, /整栋暂无正估值，无法收回/);
    assert.match(html, /data-buyback="salt-p" disabled/);
  }
});

test("民营建筑欠薪显示欠薪徽章与30天收回提示，并标出业主", () => {
  const state = baseState();
  const owner = householdList(state)[0];
  addBuilding(state, "saltworks", "salt-p", { owner: "household", ownerId: owner.id });
  state.privateEconomy.payrollByBuilding["salt-p"] = { arrearsVoucherUnits: 300 * V, cumulativeAccruedVoucherUnits: 300 * V, cumulativePaidVoucherUnits: 0 };
  state.ownershipWatch = { arrearsDaysByBuilding: { "salt-p": 12 }, arrearsDaysByCompany: {} };
  const extras = {
    ownershipExtras: {
      "salt-p": { ownerName: owner.name, arrears: true, arrearsVoucher: 300, arrearsDays: 12 }
    }
  };
  const html = siteHtml(state, "salt-p", extras);
  assert.match(html, /class="badge red">欠薪/);
  assert.match(html, /欠薪超过30天将被镇里收回/);
  assert.ok(html.includes(owner.name));
  assert.doesNotMatch(siteHtml(state, "salt-p"), /class="badge red">欠薪/, "没有界面附加信息时不显示徽章");
});

test("民营待批上市申请在地方详情给出提示", () => {
  const state = baseState();
  const owner = householdList(state)[0];
  addBuilding(state, "saltworks", "salt-p", { owner: "household", ownerId: owner.id });
  state.ipoApplications = { "salt-p": { householdId: owner.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 1 } };
  assert.match(siteHtml(state, "salt-p"), /待镇长在企业面板批准/);
});

test("公司或民营建筑用业主自主升级说明代替镇里升级按钮", () => {
  const state = baseState();
  const owner = householdList(state)[0];
  addBuilding(state, "saltworks", "salt-p", { owner: "household", ownerId: owner.id });
  const html = siteHtml(state, "salt-p");
  assert.match(html, /业主自主升级（每30天评估）/);
  assert.doesNotMatch(html, /data-upgrade-preview="salt-p"/);
  const townHtml = siteHtml(state, "market-t");
  assert.doesNotMatch(townHtml, /业主自主升级/);
});

test("企业面板：镇营产业整栋上市表单、民营申请批准/驳回按钮，且没有公司等级按钮或成立公司入口", () => {
  const state = baseState();
  addBuilding(state, "mill", "mill-t");
  const owner = householdList(state)[0];
  addBuilding(state, "saltworks", "salt-p", { owner: "household", ownerId: owner.id });
  state.ipoApplications = { "salt-p": { householdId: owner.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 1 } };
  const html = renderEconomy(simulation.selectDashboard(state, { panel: "all", paused: true, speed: 1 }));
  assert.match(html, /整栋上市/);
  assert.match(html, /data-ipo-list="mill-t"/);
  assert.match(html, /data-ipo-approve="salt-p"/);
  assert.match(html, /data-ipo-reject="salt-p"/);
  assert.doesNotMatch(html, /预览成立公司/);
  assert.doesNotMatch(html, /data-company-level-preview/);
  assert.doesNotMatch(html, /data-company-preview/);
});

test("民营建筑地方详情没有镇营排班、镇营工资和镇库产量，只显示业主用工", () => {
  const state = baseState();
  const owner = householdList(state)[0];
  addBuilding(state, "saltworks", "salt-p", { owner: "household", ownerId: owner.id });
  const html = siteHtml(state, "salt-p");
  assert.doesNotMatch(html, /镇营排班/);
  assert.doesNotMatch(html, /data-job="salt-p::/);
  assert.doesNotMatch(html, /预计每日工资/);
  assert.doesNotMatch(html, /今日产量/);
  assert.match(html, /状态 \/ 用工/);
  assert.match(html, /产权详情/);
  assert.match(html, /整栋一个主人/);
});

test("镇营建筑地方详情保留镇营排班与镇库产量", () => {
  const state = baseState();
  addBuilding(state, "saltworks", "salt-t");
  const html = siteHtml(state, "salt-t");
  assert.match(html, /镇营排班/);
  assert.match(html, /data-job="salt-t::/);
  assert.match(html, /今日产量/);
});

test("公司建筑地方详情显示公司状态与只读用工，没有镇营排班", () => {
  const state = baseState();
  addBuilding(state, "lumberyard", "lumber-t");
  const listed = simulation.listBuilding(state, "lumber-t", { ticker: "101", totalShares: 100000, offerPercent: 49, priceVoucherPerShare: 1 });
  assert.equal(listed.ok, true, listed.reason);
  const html = siteHtml(state, "lumber-t");
  assert.match(html, /公司 · 1级/);
  assert.match(html, /由业主自主经营/);
  assert.match(html, /公司经营/);
  assert.doesNotMatch(html, /镇营排班/);
  assert.doesNotMatch(html, /data-job="lumber-t::/);
  assert.doesNotMatch(html, /镇营 \/ 民营 \/ 公司/);
});
