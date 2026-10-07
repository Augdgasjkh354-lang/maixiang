import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulation, CONTENT } from "../src/engine.js";
import { renderResidents } from "../src/ui/panel-residents.js";
import { renderEconomy } from "../src/ui/panel-economy.js";
import { renderPolicy } from "../src/ui/panel-policy.js";
import { renderBuild } from "../src/ui/panel-build.js";
import { renderSite } from "../src/ui/panel-site.js";
import { renderMap, mapSignature } from "../src/ui/map.js";
import { createDashboardViewCache } from "../src/ui/dashboard-view-cache.js";
import { createDashboardRuntime } from "../src/selectors/dashboard-runtime.js";
import { selectJobRows } from "../src/selectors/labor.js";
import { householdRecentTotals, householdRecentTotalsReadonly } from "../src/systems/household-life.js";
import { companySummary, previewShareSubscription } from "../src/systems/companies.js";
import { shopSummaries } from "../src/systems/shops.js";

function addBuilding(state, typeId, id, level = 1) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row =>
    (required ? row.feature === required : !row.feature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = {
    id, typeId, level,
    ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 }
  };
  state.buildings.push(building);
  return building;
}

function activeTown(seed = 1801) {
  const state = simulation.createInitialState({ seed });
  for (const [typeId, count] of [
    ["mill", 2], ["bakery", 2], ["lumberyard", 1], ["saltworks", 1],
    ["commercial_street", 2], ["public_housing", 1], ["bank", 1], ["stock_exchange", 1]
  ]) {
    for (let i = 0; i < count; i++) addBuilding(state, typeId, `${typeId}-${i}`, 2);
  }
  state.monetaryReform = {
    stage: "voucher", targetVoucherBps: 10000, residentExchangeEnabled: true,
    legacyBankAccess: true, started: null, completed: { legacy: true },
    paymentHistory: [], voucherShortfallByKey: {}
  };
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  assert.equal(simulation.issueGrainVouchers(state, "town", 100000).ok, true);
  let ticker = 1;
  for (const buildingId of ["mill-0", "bakery-0", "lumberyard-0", "saltworks-0"]) {
    const formed = simulation.createCompany(state, buildingId, {
      name: `${buildingId}公司`, levels: 1, operatingCapitalVoucher: 1000, initialMaterialQuantity: 0
    });
    assert.equal(formed.ok, true, formed.reason);
    const listed = simulation.listCompanyShares(state, formed.companyId, {
      ticker: String(ticker++).padStart(3, "0"), totalShares: 1000,
      priceVoucherPerShare: 1, offeredShares: 100
    });
    assert.equal(listed.ok, true, listed.reason);
  }
  assert.equal(simulation.validateState(state).valid, true);
  return state;
}

function uiView(view) {
  return {
    ...view,
    numericDrafts: {},
    upgradePreviewId: null,
    demolitionPreviewId: null,
    rightSalePreviewId: null,
    currencyPreview: null,
    listingPreview: null,
    stockListingPreview: null,
    sharePreviewCompanyId: null,
    buybackPreview: null,
    companyLevelPreview: null,
    reformFinishConfirm: false
  };
}

function freeOrdinaryPlot(state) {
  return state.plots.find(plot => !plot.feature && !state.buildings.some(building => building.plotId === plot.id) && state.project?.plotId !== plot.id)?.id || null;
}

test("0.1.8 当前面板视图与全量视图对实际面板渲染字段保持一致", () => {
  const state = activeTown();
  const buildPlot = freeOrdinaryPlot(state);
  const cases = [
    ["residents", renderResidents, { site: null, build: null, plotId: null }],
    ["business", renderEconomy, { site: null, build: null, plotId: null }],
    ["policy", renderPolicy, { site: null, build: null, plotId: null }],
    ["build", renderBuild, { site: null, build: "mill", plotId: buildPlot }],
    ["site", renderSite, { site: "building:mill-0", build: null, plotId: null }]
  ];
  for (const [panel, render, extra] of cases) {
    const selection = { panel, paused: true, speed: 1, ...extra };
    const partial = uiView(simulation.selectDashboard(state, selection));
    const full = uiView(simulation.selectDashboard(state, { ...selection, panel: "all" }));
    assert.equal(render(partial), render(full), `${panel} panel markup drifted`);

    const nav = {
      activePanel: panel,
      selectedSite: extra.site,
      buildType: extra.build,
      previewPlotId: extra.plotId
    };
    assert.equal(renderMap(partial, nav), renderMap(full, nav), `${panel} map markup drifted`);
    assert.equal(mapSignature(partial, nav), mapSignature(full, nav), `${panel} map signature drifted`);
  }
});

test("0.1.8 selector按面板读取不修改游戏状态，且岗位索引与原查询结果一致", () => {
  const state = activeTown(1802);
  const before = structuredClone(state);
  for (const panel of ["none", "residents", "business", "policy", "build", "site", "settings"]) {
    simulation.selectDashboard(state, {
      panel, paused: true, speed: 1,
      site: panel === "site" ? "building:mill-0" : null,
      build: panel === "build" ? "mill" : null,
      plotId: panel === "build" ? freeOrdinaryPlot(state) : null
    });
  }
  assert.deepEqual(state, before);
  const indexed = selectJobRows(state, CONTENT, createDashboardRuntime(state));
  const direct = selectJobRows(state, CONTENT);
  assert.deepEqual(indexed, direct);
});

test("0.1.8 公司与店铺摘要对缺省旧字段只读归一化，不回写游戏状态", () => {
  const state = activeTown(1804);
  const company = Object.values(state.companies)[0];
  delete company.accounts;
  delete company.payroll;
  delete company.settings;
  delete company.inventoryCostVoucherUnits;
  const companyBefore = structuredClone(state);
  companySummary(state, company, CONTENT);
  previewShareSubscription(state, company.id, CONTENT);
  assert.deepEqual(state, companyBefore);

  const owner = Object.values(state.households.byId)[0];
  state.shops = {
    "legacy-shop": {
      id: "legacy-shop", name: "旧店铺", buildingId: "commercial_street-0",
      typeId: "general", ownerHouseholdId: owner.id, status: "open"
    }
  };
  const shopBefore = structuredClone(state);
  const rows = shopSummaries(state, CONTENT);
  assert.equal(rows.length, 1);
  assert.deepEqual(state, shopBefore);
});

test("0.1.8 家庭观察窗与近期汇总口径相同时直接复用结果且数值一致", () => {
  const state = activeTown(1803);
  for (let i = 0; i < 4; i++) simulation.advanceDay(state);
  const household = Object.values(state.households.byId)[0];
  const days = CONTENT.rules.satisfactionObservationDays || 14;
  assert.deepEqual(
    householdRecentTotalsReadonly(household, days, CONTENT),
    householdRecentTotals(household, days, CONTENT)
  );
});

test("0.1.8 Dashboard运行期缓存：静止帧只构造一次，失效、面板、速度和换档会刷新", () => {
  let calls = 0;
  const cache = createDashboardViewCache((state, selection) => ({ stamp: ++calls, stateId: state.id, ...selection }));
  const stateA = { id: "A" };
  const selection = { panel: "residents", paused: true, speed: 1, site: null, build: null, plotId: null };

  for (let frame = 0; frame < 300; frame++) cache.get(stateA, selection);
  assert.equal(calls, 1, "paused/no-op frames should reuse one Dashboard");

  cache.invalidateState();
  assert.equal(cache.get(stateA, selection).stamp, 2, "state-changing action/day close should invalidate");
  assert.equal(cache.get(stateA, { ...selection, panel: "business" }).stamp, 3, "panel switch should refresh");
  assert.equal(cache.get(stateA, { ...selection, panel: "site", site: "building:b1" }).stamp, 4, "selected building should refresh");
  assert.equal(cache.get(stateA, { ...selection, panel: "build", build: "mill", plotId: "plot:a" }).stamp, 5, "construction preview should refresh");
  assert.equal(cache.get(stateA, { ...selection, paused: false }).stamp, 6, "pause change should refresh");
  assert.equal(cache.get(stateA, { ...selection, paused: false, speed: 4 }).stamp, 7, "speed change should refresh");
  assert.equal(cache.get({ id: "B" }, selection).stamp, 8, "load/switch save state should refresh");
  cache.clear();
  assert.equal(cache.get(stateA, selection).stamp, 9, "new/load clear should force refresh");
});

test("0.1.8 地图签名覆盖状态文字、等级、选择和施工进度", () => {
  const base = {
    season: { key: "spring" },
    buildings: [{ id: "b1", typeId: "mill", plotId: "p1", level: 1, status: { status: "ready", label: "生产中" }, jobs: [{ id: "millers", workers: 2, capacity: 3 }] }],
    project: { instanceId: "pr1", kind: "build", typeId: "bakery", plotId: "p2", workDone: 10, workRequired: 100, percent: 10 }
  };
  const nav = { activePanel: "site", selectedSite: "building:b1", buildType: null, previewPlotId: null };
  const signature = mapSignature(base, nav);
  const changed = [
    [{ ...base, buildings: [{ ...base.buildings[0], status: { status: "ready", label: "待料" } }] }, nav],
    [{ ...base, buildings: [{ ...base.buildings[0], level: 2 }] }, nav],
    [base, { ...nav, selectedSite: "field" }],
    [{ ...base, project: { ...base.project, workDone: 11, percent: 11 } }, nav]
  ];
  for (const [view, changedNav] of changed) assert.notEqual(mapSignature(view, changedNav), signature);
});

test("0.1.8 动画帧不再直接构造Dashboard，数字草稿不进入经济视图缓存键", () => {
  const appSource = readFileSync(new URL("../src/ui/app.js", import.meta.url), "utf8");
  const frameBody = appSource.slice(appSource.indexOf("function frame(now)"), appSource.indexOf("async function bootstrapPersistence"));
  assert.doesNotMatch(frameBody, /buildView\s*\(/);
  assert.doesNotMatch(frameBody, /dashboardViews\.get\s*\(/);

  const cacheSource = readFileSync(new URL("../src/ui/dashboard-view-cache.js", import.meta.url), "utf8");
  assert.doesNotMatch(cacheSource, /numericDraft/i);
  assert.match(cacheSource, /selection\.panel/);
  assert.match(cacheSource, /selection\.site/);
  assert.match(cacheSource, /selection\.build/);
  assert.match(cacheSource, /selection\.plotId/);
  assert.match(cacheSource, /selection\.paused/);
  assert.match(cacheSource, /selection\.speed/);
  assert.match(appSource, /numericDrafts:\s*Object\.fromEntries\(numericDrafts\)/);
  assert.match(appSource, /function changed\([^)]*\)\s*\{[\s\S]*?invalidateStateView\(\)/);
  assert.match(frameBody, /simulation\.advanceDay\(state\)[\s\S]*?invalidateStateView\(\)/);
  assert.match(appSource, /function adoptSave\([^)]*\)\s*\{[\s\S]*?dashboardViews\.clear\(\)/);
});
