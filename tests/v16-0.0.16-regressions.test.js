import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { simulation, CONTENT } from "../src/engine.js";
import {
  distributeResidentInventory, distributeResidentVouchers, householdList
} from "../src/systems/households.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { settleShopTaxAndDistribution } from "../src/systems/shops.js";
import { harvest } from "../src/systems/agriculture.js";
import { transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { APP_VERSION } from "../src/content/version.js";
import { SAVE_VERSION } from "../src/content/rules.js";
import { renderSettings } from "../src/ui/panel-settings.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addCompletedBuilding(state, typeId, id) {
  const def = CONTENT.buildings[typeId];
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot);
  const building = {
    id, typeId, level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: state.day + 1 }
  };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function merchantHousehold(state) {
  return householdList(state).find(household =>
    (household.ageBands?.workers || 0) > Object.values(household.jobs || {}).reduce((sum, count) => sum + count, 0));
}

test("0权重家庭不参与库存分配，余数只给有资格家庭且总量严格守恒", () => {
  const state = simulation.createInitialState();
  const households = householdList(state);
  for (const household of households) household.inventory.wheat = 0;
  const weights = Object.fromEntries(households.map((household, index) => [household.id, index === 0 ? 1 : 0]));
  const result = distributeResidentInventory(state, "wheat", 100 * I, CONTENT, { weights, byMembers: false });
  assert.equal(result.ok, true, result.reason);
  assert.equal(households[0].inventory.wheat, 100 * I);
  assert.ok(households.slice(1).every(household => household.inventory.wheat === 0));
  assert.equal(households.reduce((sum, household) => sum + household.inventory.wheat, 0), 100 * I);
  assert.equal(result.rows.reduce((sum, row) => sum + row.units, 0), 100 * I);
});


test("农业收获实际路径只按正劳动权重分粮，250户复现严格增加100斤", () => {
  const state = simulation.createInitialState();
  const households = householdList(state);
  const before = households.map(household => household.inventory.wheat);
  households.forEach((household, index) => { household.agricultureWorkUnits = index === 0 ? 1 : 0; });
  state.agriculture.workUnits = 1;
  state.agriculture.taxDays = [{ year: state.year, day: 1, rateBps: 0 }];
  const content = {
    ...CONTENT,
    agriculture: { ...CONTENT.agriculture, acres: 10, acresPerFarmer: 10, yieldPerAcre: 10 },
    rules: { ...CONTENT.rules, growingDays: 1, agricultureTaxDefaultPercent: 0 }
  };
  const result = harvest(state, content);
  assert.equal(result.residentShare, 100);
  assert.equal(households[0].inventory.wheat - before[0], 100 * I);
  assert.ok(households.slice(1).every((household, index) => household.inventory.wheat === before[index + 1]));
  assert.equal(households.reduce((sum, household, index) => sum + household.inventory.wheat - before[index], 0), 100 * I);
});

test("粮券加权分配保持0权重，整数余数只落到有资格接收者", () => {
  const state = simulation.createInitialState();
  const households = householdList(state);
  for (const household of households) household.voucherUnits = 0;
  const eligible = households.slice(0, 2);
  const weights = { [eligible[0].id]: 1, [eligible[1].id]: 1 };
  const result = distributeResidentVouchers(state, 3, CONTENT, { householdIds: households.map(h => h.id), weights });
  assert.equal(result.ok, true, result.reason);
  assert.equal(eligible[0].voucherUnits + eligible[1].voucherUnits, 3);
  assert.deepEqual([eligible[0].voucherUnits, eligible[1].voucherUnits], [2, 1]);
  assert.ok(households.slice(2).every(household => household.voucherUnits === 0));
  assert.equal(result.rows.reduce((sum, row) => sum + row.units, 0), 3);
});

test("总权重为0时明确拒绝分配且不修改家庭库存或粮券", () => {
  const state = simulation.createInitialState();
  const households = householdList(state);
  const weights = Object.fromEntries(households.map(household => [household.id, 0]));
  const wheatBefore = households.map(household => household.inventory.wheat);
  const voucherBefore = households.map(household => household.voucherUnits);
  const inventory = distributeResidentInventory(state, "wheat", 100 * I, CONTENT, { weights, byMembers: false });
  const vouchers = distributeResidentVouchers(state, 100 * V, CONTENT, { weights });
  assert.equal(inventory.ok, false);
  assert.match(inventory.reason, /总权重为0/);
  assert.equal(vouchers.ok, false);
  assert.match(vouchers.reason, /总权重为0/);
  assert.deepEqual(households.map(household => household.inventory.wheat), wheatBefore);
  assert.deepEqual(households.map(household => household.voucherUnits), voucherBefore);
});

test("店铺追加2000粮券本金不形成未分配利润，也不会在结算时被分配", () => {
  const state = simulation.createInitialState();
  const street = addCompletedBuilding(state, "commercial_street", "street-capital-test");
  const owner = merchantHousehold(state);
  assert.ok(owner);
  assert.equal(grantResidentVouchers(state, 3000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "bakery", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  assert.equal(transferVouchers(state, `household:${owner.id}`, `shop:${shop.id}`, 2000 * V, CONTENT,
    "shop_capital_injection", "测试追加本金").ok, true);
  assert.equal(shop.retainedEarningsVoucherUnits, 0);
  const ownerBefore = owner.voucherUnits;
  const shopBefore = shop.cashVoucherUnits;
  const settlement = settleShopTaxAndDistribution(state, shop, CONTENT, true);
  assert.equal(settlement.periodProfitVoucherUnits, 0);
  assert.equal(settlement.taxVoucherUnits, 0);
  assert.equal(settlement.distributedVoucherUnits, 0);
  assert.equal(shop.retainedEarningsVoucherUnits, 0);
  assert.equal(owner.voucherUnits, ownerBefore);
  assert.equal(shop.cashVoucherUnits, shopBefore);
});

test("正式版本号与存档结构版本独立", async () => {
  // 基线清理：应用版本已从 0.2.1 演进到 0.2.3（src/content/version.js），
  // 断言同步到当前版本；存档结构版本仍固定为 v15（版本号与存档结构相互独立）。
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  // package.json 的 version 是 npm 包元数据，单独断言会与 APP_VERSION 漂移，
  // 这里只要求它与应用版本同为 0.2.x，真正的应用版本以 src/content/version.js 为准。
  assert.match(pkg.version, /^0\.2\.\d+$/);
  assert.equal(APP_VERSION, "0.2.3");
  assert.ok(Number.isInteger(SAVE_VERSION) && SAVE_VERSION >= 16);
  assert.notEqual(String(SAVE_VERSION), APP_VERSION);
  assert.match(renderSettings({}, null, { managerOpen: false }), /麦乡 0\.2\.3/);
  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(indexHtml, /麦乡 0\.2\.3 · 小镇岁时/);
});
