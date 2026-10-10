// 交易所与公司界面（docs/OWNERSHIP.md）：交易所建筑面板的标签页与挂牌列表（一次只展开一栋），
// 公司经营控件搬到公司所在建筑的面板，经营面板只留摘要与跳转。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { householdList } from "../src/systems/households.js";
import { renderSite } from "../src/ui/panel-site.js";
import { renderEconomy } from "../src/ui/panel-economy.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { formCompany } from "./helpers-ipo.js";

function addBuilding(state, typeId, id, { level = 1, owner = "town", ownerId = null } = {}) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  const ownership = { townLevels: 0, privateLevels: 0, listedLevels: 0 };
  ownership[owner === "household" ? "privateLevels" : "townLevels"] = level;
  const building = { id, typeId, level, ownership, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } };
  if (owner === "household") building.privateOwners = [ownerId];
  state.buildings.push(building);
  return building;
}

function listedCompanyOn(state, buildingId, { ticker = "088", offer = 0 } = {}) {
  assert.equal(simulation.issueGrainVouchers(state, "town", 20000).ok, true);
  const formed = formCompany(state, buildingId, { name: `${buildingId}公司`, levels: 1, operatingCapitalVoucher: 1000, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker, totalShares: 1000, priceVoucherPerShare: 1, offeredShares: offer });
  assert.equal(listed.ok, true, listed.reason);
  return formed.companyId;
}

function exchangeView(state, extras = {}) {
  const view = simulation.selectDashboard(state, { panel: "site", site: "building:exchange-t", paused: true, speed: 1 });
  return { ...view, numericDrafts: {}, exchangeTab: "listing", ipoExpandedBuildingId: null, ...extras };
}

function baseState() {
  const state = legacyVoucherState({ seed: 11 });
  addBuilding(state, "stock_exchange", "exchange-t");
  addBuilding(state, "mill", "mill-t");
  addBuilding(state, "saltworks", "salt-t");
  return state;
}

test("交易所面板：摘要卡、四个标签页，挂牌列表每栋一行且一次只展开一栋的上市表单", () => {
  const state = baseState();
  const html = renderSite(exchangeView(state));
  for (const tab of ["listing", "applications", "companies", "status"]) assert.match(html, new RegExp(`data-exchange-tab="${tab}"`));
  assert.match(html, /已上市公司/);
  assert.match(html, /待批上市申请/);
  assert.match(html, /可上市建筑/);
  assert.match(html, /总市值/);
  // 挂牌列表：每栋镇营产业一行，只有 [上市] 按钮，表单不展开。
  assert.match(html, /data-ipo-expand="mill-t"/);
  assert.match(html, /data-ipo-expand="salt-t"/);
  assert.doesNotMatch(html, /data-ipo-list=/);
  // 点开其中一栋：只展开这一栋的表单。
  const opened = renderSite(exchangeView(state, { ipoExpandedBuildingId: "mill-t" }));
  assert.equal((opened.match(/data-ipo-list=/g) || []).length, 1);
  assert.match(opened, /data-ipo-list="mill-t"/);
  assert.match(opened, /data-ipo-ticker="mill-t"/);
});

test("交易所面板：民营申请标签页含批准/驳回，公司标签页含上市、售股、回购与认购预览", () => {
  const state = baseState();
  const owner = householdList(state)[0];
  addBuilding(state, "mill", "mill-p", { owner: "household", ownerId: owner.id });
  state.ipoApplications = { "mill-p": { householdId: owner.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 1 } };
  const applications = renderSite(exchangeView(state, { exchangeTab: "applications" }));
  assert.match(applications, /data-ipo-approve="mill-p"/);
  assert.match(applications, /data-ipo-reject="mill-p"/);
  assert.doesNotMatch(applications, /data-ipo-expand=/);

  const companyId = listedCompanyOn(state, "mill-t", { offer: 200 });
  formCompany(state, "salt-t", { name: "盐未上市公司", levels: 1, operatingCapitalVoucher: 1000, initialMaterialQuantity: 0 });
  const companies = renderSite(exchangeView(state, { exchangeTab: "companies" }));
  assert.match(companies, new RegExp(`data-share-preview="${companyId}"`));
  assert.match(companies, new RegExp(`data-company-buyback-preview="${companyId}"`));
  assert.match(companies, /data-stock-list-preview=/);
  assert.match(companies, /data-open-building="mill-t"/);
});

test("公司所在建筑面板：出现公司经营控件与账目，上市控件不在建筑面板里", () => {
  const state = baseState();
  const companyId = listedCompanyOn(state, "mill-t", { offer: 200 });
  const html = renderSite({ ...simulation.selectDashboard(state, { panel: "site", site: "building:mill-t", paused: true, speed: 1 }), numericDrafts: {} });
  assert.match(html, /公司 · 1级 · 088 · 已上市/);
  for (const attr of ["data-company-wage", "data-company-target", "data-company-capital", "data-company-liquidate"]) {
    assert.match(html, new RegExp(`${attr}="${companyId}"`), attr);
  }
  assert.match(html, /data-company-price="[^"]+" data-item-id=/);
  assert.match(html, new RegExp(`data-detail-key="company-detail:${companyId}"`));
  assert.doesNotMatch(html, /data-share-preview=/);
  assert.doesNotMatch(html, /data-stock-list-preview=/);
  assert.doesNotMatch(html, /data-ipo-list=/);
});

test("交易所面板的公司标签页：每家公司一个可折叠条目，上市与售股在交易所里", () => {
  const state = baseState();
  const companyId = listedCompanyOn(state, "mill-t");
  const html = renderSite(exchangeView(state, { exchangeTab: "companies" }));
  assert.match(html, new RegExp(`data-detail-key="exchange-company:${companyId}"`));
  assert.match(html, /现价/);
});

test("经营面板只留摘要与跳转：没有整栋上市表单、民营申请、公司经营控件或交易所上市控件", () => {
  const state = baseState();
  listedCompanyOn(state, "mill-t");
  const html = renderEconomy(simulation.selectDashboard(state, { panel: "all", paused: true, speed: 1 }));
  assert.doesNotMatch(html, /data-ipo-list=/);
  assert.doesNotMatch(html, /data-ipo-expand=/);
  assert.doesNotMatch(html, /data-ipo-approve=/);
  assert.doesNotMatch(html, /data-company-wage=/);
  assert.doesNotMatch(html, /data-share-preview=/);
  assert.doesNotMatch(html, /data-stock-list-preview=/);
  assert.match(html, /可上市 \d+ 栋 · 挂牌 1 家 · 待批 0 份/);
  assert.match(html, /前往交易所/);
  assert.match(html, /data-open-building="exchange-t"/);
  assert.match(html, /前往公司所在建筑/);
});

test("旧档兼容交易所（无建筑）：经营面板给兼容入口，兼容页仍有挂牌列表", () => {
  const state = legacyVoucherState({ seed: 12 });
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  addBuilding(state, "mill", "mill-c");
  const economy = renderEconomy(simulation.selectDashboard(state, { panel: "all", paused: true, speed: 1 }));
  assert.match(economy, /data-site="exchange-compat"/);
  const compat = renderSite({ ...simulation.selectDashboard(state, { panel: "site", site: "exchange-compat", paused: true, speed: 1 }), numericDrafts: {}, exchangeTab: "listing", ipoExpandedBuildingId: null });
  assert.match(compat, /旧存档兼容入口/);
  assert.match(compat, /data-ipo-expand="mill-c"/);
});

test("app.js 委托处理交易所面板的标签页与展开，公司经营按钮有提示", () => {
  const app = readFileSync(new URL("../src/ui/app.js", import.meta.url), "utf8");
  assert.match(app, /closest\(target, "\[data-exchange-tab\]"\)/);
  assert.match(app, /closest\(target, "\[data-ipo-expand\]"\)/);
  assert.match(app, /公司日薪已设为/);
  assert.match(app, /公司目标用工已设为/);
  assert.match(app, /公司售价已设为/);
});
