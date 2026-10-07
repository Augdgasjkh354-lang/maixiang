import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import {
  householdList, householdIdleWorkers, householdReserveQeqUnits, syncResidentAggregates
} from "../src/systems/households.js";
import { qeqUnitsForInventoryUnits } from "../src/economy/inventory.js";
import { transferVouchers } from "../src/economy/currency.js";
import { sellCompanyProduct } from "../src/systems/companies.js";
import { saveState } from "../src/persistence/storage.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const def = CONTENT.buildings[typeId];
  const required = def.requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = {
    id, typeId, level,
    ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [],
    completed: { year: state.year, day: 1 }
  };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
}

test("r06 过渡期家庭从公司直购也必须保护基本口粮", () => {
  const state = simulation.createInitialState({ seed: 110601 });
  state.monetaryReform = {
    stage: "transition", targetVoucherBps: 5000, residentExchangeEnabled: true, legacyBankAccess: true,
    started: { year: 1, day: 1 }, completed: null, paymentHistory: [], voucherShortfallByKey: {}
  };
  assert.equal(simulation.issueGrainVouchers(state, "town", 20).ok, true);
  const household = householdList(state)[0];
  assert.ok(household);
  for (const [itemId, item] of Object.entries(CONTENT.items)) if (item.edible) household.inventory[itemId] = 0;
  const reserveQeq = householdReserveQeqUnits(state, household, CONTENT, CONTENT.rules.basicCommerceFoodReserveDays ?? 30);
  const wheatQeqPerUnit = qeqUnitsForInventoryUnits(CONTENT.items.wheat, 1, CONTENT);
  household.inventory.wheat = Math.ceil(reserveQeq / wheatQeqPerUnit);
  household.voucherUnits = 0;
  syncResidentAggregates(state, CONTENT);
  assert.equal(transferVouchers(state, "town", `household:${household.id}`, 5 * V, CONTENT, "r06_test_fund", "测试购买资金").ok, true);

  const mill = addBuilding(state, "mill", "r06-company-mill", 1);
  const created = simulation.createCompany(state, mill.id, { name: "口粮约束公司", levels: 1, operatingCapitalVoucher: 0, initialMaterials: {} });
  assert.equal(created.ok, true, created.reason);
  const company = state.companies[created.companyId];
  company.inventory.flour = I;
  company.inventoryCostVoucherUnits.flour = 0;
  const wheatBefore = household.inventory.wheat;

  const sale = sellCompanyProduct(state, company.id, `household:${household.id}`, "flour", I, 10, CONTENT, "家庭从公司购买面粉");
  assert.equal(sale.ok, false, "家庭只有基本口粮时，公司直购不得绕开生活储备");
  assert.equal(household.inventory.wheat, wheatBefore, "失败交易不得动用基本口粮");
  assert.equal(company.inventory.flour, I, "失败交易不得减少公司库存");
});

test("r06 合法的4商人20店员商业街状态必须能通过存档校验并保存", () => {
  const state = legacyVoucherState({ seed: 110602 });
  assert.equal(simulation.issueGrainVouchers(state, "town", 500).ok, true);
  const street = addBuilding(state, "commercial_street", "r06-street", 1);
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.ok(owner);
  assert.equal(transferVouchers(state, "town", `household:${owner.id}`, 200 * V, CONTENT, "r06_shop_startup", "测试开店资金").ok, true);
  const opened = simulation.openResidentShop(state, street.id, "tea", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shopId = opened.shopId;
  const merchants = simulation.configureShopMerchants(state, shopId, 4);
  const clerks = simulation.configureShopClerks(state, shopId, 20);
  assert.equal(merchants.ok, true, merchants.reason);
  assert.equal(clerks.ok, true, clerks.reason);
  assert.equal(merchants.assigned, 4);
  assert.equal(clerks.assigned, 20);

  const validation = simulation.validateState(state);
  assert.equal(validation.valid, true, validation.errors?.join("；"));
  assert.doesNotThrow(() => saveState(memoryStorage(), state, CONTENT));
});

test("r06 上市公司划回一级后必须同步收缩未售出报价，不能制造不可保存状态", () => {
  const state = legacyVoucherState({ seed: 110603 });
  addBuilding(state, "stock_exchange", "r06-stock-exchange", 1);
  const mill = addBuilding(state, "mill", "r06-listed-mill", 2);
  const created = simulation.createCompany(state, mill.id, { name: "缩股测试公司", levels: 2, operatingCapitalVoucher: 0, initialMaterials: {} });
  assert.equal(created.ok, true, created.reason);
  const listed = simulation.listCompanyShares(state, created.companyId, {
    ticker: "603", totalShares: 2000, offeredShares: 2000, priceVoucherPerShare: 1
  });
  assert.equal(listed.ok, true, listed.reason);

  const removed = simulation.removeCompanyOperatingLevel(state, created.companyId);
  assert.equal(removed.ok, true, removed.reason);
  const company = state.companies[created.companyId];
  assert.equal(company.townShares, 1000);
  assert.equal(company.shareSale.offeredShares, 1000, "未售出报价不能超过缩股后的镇库持股");
  const validation = simulation.validateState(state);
  assert.equal(validation.valid, true, validation.errors?.join("；"));
  assert.doesNotThrow(() => saveState(memoryStorage(), state, CONTENT));
});
