import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { householdList, householdIdleWorkers, setJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { purchaseItemForResidents } from "../src/systems/consumer-market.js";
import { shopTradePrices } from "../src/economy/operating-plan.js";
import { serviceShopCapacityUses, shopDailyCustomerCapacity, prepareShopsForDay } from "../src/systems/shops.js";
import { ensureHouseholdLife } from "../src/systems/household-life.js";
import { processServiceDemand } from "../src/systems/services.js";
import { consumeDailyRations } from "../src/systems/consumption.js";
import { processBuilding } from "../src/systems/production.js";
import { processPrivateBuilding } from "../src/systems/private-industry.js";
import { processListedCompany, sellCompanyOutputsToWholesale } from "../src/systems/companies.js";
import { privateJobKeyForBuilding, listedJobKeyForBuilding } from "../src/selectors/labor.js";
import { transferVouchers } from "../src/economy/currency.js";
import { runWholesaleIntake, setWholesaleTownAllocation, transferTownToWholesale } from "../src/systems/wholesale-market.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const def = CONTENT.buildings[typeId];
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = { id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: state.day + 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function fundedOwner(state, amount = 5000) {
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.ok(owner);
  assert.equal(grantResidentVouchers(state, amount, CONTENT, owner.id).ok, true);
  return owner;
}

test("居民购买面粉、面包、盐只认综合商店，综合商店按批发价固定加价20%", () => {
  const state = legacyVoucherState({ seed: 110801 });
  for (const itemId of ["flour", "bread", "salt"]) state.accounts.town[itemId] = 100 * I;
  assert.equal(grantResidentVouchers(state, 10000, CONTENT).ok, true);
  for (const itemId of ["flour", "bread", "salt"]) {
    const result = purchaseItemForResidents(state, itemId, 10 * I, 1, CONTENT, "r08 restricted retail");
    assert.equal(result.purchasedUnits, 0, `${itemId} must not be bought directly from town/company/household`);
  }
  assert.equal(simulation.configureWholesalePrice(state, "flour", 2).ok, true);
  const prices = shopTradePrices(state, "general", CONTENT, "flour");
  assert.equal(prices.wholesaleVoucherPerUnit, 2);
  assert.equal(prices.retailVoucherPerUnit, 2.4);
});

test("综合商店50店员，接待能力按人计（店员+商人 × 20 户），店员未满30日不能解雇", () => {
  const state = legacyVoucherState({ seed: 110802 });
  const street = addBuilding(state, "commercial_street", "r08-street");
  const owner = fundedOwner(state);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  assert.equal(simulation.configureShopClerks(state, shop.id, 50).ok, true);
  // 50 店员 + 1 商人 = 51 人 × 20 户 = 1020 户/日（未触及 generalStoreMaxDailyCustomers 的 2000 上限）。
  const perStaff = CONTENT.rules.generalStoreCustomersPerStaff;
  assert.equal(shopDailyCustomerCapacity(state, shop, CONTENT), (50 + 1) * perStaff);
  const early = simulation.configureShopClerks(state, shop.id, 49);
  assert.equal(early.ok, false);
  assert.match(early.reason, /30天/);
  state.day = 30;
  assert.equal(simulation.configureShopClerks(state, shop.id, 49).ok, true);
  // 49 店员 + 1 商人 = 50 人 × 20 户 = 1000 户/日。
  assert.equal(shopDailyCustomerCapacity(state, shop, CONTENT), (49 + 1) * perStaff, "49名店员加商人的接待能力");
  assert.equal(simulation.selectDashboard(state, { panel: "site" }).shops.find(row => row.id === shop.id).maxClerks, 50);
});

test("镇营磨坊直接用镇库小麦生产，产出进入批发市场", () => {
  const state = legacyVoucherState({ seed: 110803 });
  addBuilding(state, "wholesale_market", "r08-wholesale");
  const mill = addBuilding(state, "mill", "r08-mill");
  const role = CONTENT.buildings.mill.jobs[0];
  assert.equal(setJobCount(state, `${mill.id}::${role.id}`, 1, CONTENT, { type: "town", id: mill.id }).assigned, 1);
  const beforeTownWheat = state.accounts.town.wheat;
  assert.ok(beforeTownWheat > 0);
  // 小麦由镇库直管，无需先投放批发市场
  const produced = processBuilding(state, mill, CONTENT);
  assert.ok(produced.batches > 0);
  const outputIntake = runWholesaleIntake(state, [produced], [], CONTENT, { includeTownAllocation: false });
  assert.ok(outputIntake.intakeUnits.flour > 0);
});

test("学堂100儿童上限且学费可调；饭店每餐耗2斤小麦并抵1人当日口粮", () => {
  const schoolState = legacyVoucherState({ seed: 110804 });
  const schoolStreet = addBuilding(schoolState, "commercial_street", "r08-school-street");
  const schoolOwner = fundedOwner(schoolState);
  const schoolOpen = simulation.openResidentShop(schoolState, schoolStreet.id, "school", schoolOwner.id);
  assert.equal(schoolOpen.ok, true, schoolOpen.reason);
  const school = schoolState.shops[schoolOpen.shopId];
  assert.equal(serviceShopCapacityUses(schoolState, school, CONTENT), 0);
  assert.equal(simulation.configureShopClerks(schoolState, school.id, 1).ok, true);
  assert.equal(serviceShopCapacityUses(schoolState, school, CONTENT), 50);
  assert.equal(simulation.configureShopClerks(schoolState, school.id, 2).ok, true);
  assert.equal(serviceShopCapacityUses(schoolState, school, CONTENT), 100, "school capacity stays capped at 100 children");
  assert.equal(simulation.configureServicePrice(schoolState, "school", 1.5).ok, true);
  assert.equal(schoolState.services.pricesVoucherPerUse.school, 1.5);

  const state = legacyVoucherState({ seed: 110805 });
  const street = addBuilding(state, "commercial_street", "r08-restaurant-street");
  const owner = fundedOwner(state, 5000);
  const opened = simulation.openResidentShop(state, street.id, "restaurant", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  assert.equal(simulation.configureShopClerks(state, shop.id, 1).ok, true);
  assert.equal(serviceShopCapacityUses(state, shop, CONTENT), 50);
  shop.inventory.wheat = 10 * I;
  shop.inventoryCostVoucherUnits.wheat = 10 * V;
  const life = ensureHouseholdLife(owner, CONTENT);
  life.recent = [{ incomeVoucherUnits: 100 * V, lifeExpenseVoucherUnits: 0 }];
  life.day = { incomeVoucherUnits: 100 * V, lifeExpenseVoucherUnits: 0 };
  state.services.demandByHousehold[owner.id] ||= {};
  state.services.demandByHousehold[owner.id].restaurant = 1000;
  const beforeRestaurantWheat = shop.inventory.wheat;
  const beforeFoodWheat = owner.inventory.wheat;
  const service = processServiceDemand(state, CONTENT);
  assert.equal(service.servedUses.restaurant, 1);
  assert.equal(beforeRestaurantWheat - shop.inventory.wheat, 2 * I);
  assert.equal(state.services.mealsByHousehold[owner.id], 1);
  consumeDailyRations(state, simulation.populationStats(state).total, CONTENT);
  const expectedFoodUse = Math.max(0, owner.ageBands.children + owner.ageBands.workers + owner.ageBands.elders - 1) * CONTENT.rules.foodPerPersonDay * I;
  assert.equal(beforeFoodWheat - owner.inventory.wheat, expectedFoodUse);
});


test("民营、公司与综合商店的原料采购统一经过批发市场", () => {
  const state = legacyVoucherState({ seed: 110806 });
  addBuilding(state, "wholesale_market", "r08-chain-wholesale");
  assert.equal(simulation.issueGrainVouchers(state, "town", 100000).ok, true);
  state.accounts.town.wheat += 5000 * I;

  const privateOwner = fundedOwner(state, 20000);
  privateOwner.inventory.wheat = 0;
  syncResidentAggregates(state, CONTENT);
  const privateMill = addBuilding(state, "mill", "r08-private-mill");
  privateMill.ownership = { townLevels: 0, privateLevels: 1, listedLevels: 0 };
  privateMill.privateOwners = [privateOwner.id];
  const millJob = privateJobKeyForBuilding(privateMill.id, CONTENT.buildings.mill.jobs[0].id);
  assert.equal(setJobCount(state, millJob, 1, CONTENT, { type: "private", id: privateMill.id }).assigned, 1);
  const privateResult = processPrivateBuilding(state, privateMill, CONTENT);
  assert.ok(privateResult.batches > 0, privateResult.reason);
  assert.ok(privateResult.inputPurchases.some(row => row.itemId === "wheat" && row.purchasedUnits > 0));
  const privateIntake = runWholesaleIntake(state, [], [privateResult], CONTENT, { includeTownAllocation: false });
  assert.ok(privateIntake.intakeUnits.flour > 0, "民营磨坊产出应被批发市场吸纳");

  const bakery = addBuilding(state, "bakery", "r08-company-bakery");
  const created = simulation.listCompany(state, bakery.id, { levels: 1, operatingCapitalVoucher: 10000, initialMaterialQuantity: 0 });
  assert.equal(created.ok, true, created.reason);
  const company = state.companies[created.companyId];
  const bakeryJob = listedJobKeyForBuilding(bakery.id, CONTENT.buildings.bakery.jobs[0].id);
  assert.equal(setJobCount(state, bakeryJob, 1, CONTENT, { type: "company", id: company.id }).assigned, 1);
  const companyResult = processListedCompany(state, company, CONTENT);
  assert.ok(companyResult.batches > 0, "公司面包房应从批发市场买面粉后生产");
  assert.ok((company.accounts.day.purchasedInputUnits.flour || 0) > 0);
  const companyIntake = sellCompanyOutputsToWholesale(state, CONTENT);
  assert.ok((companyIntake.soldUnits.bread || 0) > 0, "公司产出的面包应回到批发市场");

  const street = addBuilding(state, "commercial_street", "r08-chain-street");
  const shopOwner = fundedOwner(state, 5000);
  const opened = simulation.openResidentShop(state, street.id, "general", shopOwner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  assert.equal(simulation.configureShopClerks(state, shop.id, 1).ok, true);
  assert.equal(transferVouchers(state, "town", `shop:${shop.id}`, 1000 * V, CONTENT, "test_shop_capital", "补足测试进货资金").ok, true);
  prepareShopsForDay(state, CONTENT);
  assert.ok((shop.accounts.day.purchasedUnits.bread || 0) > 0, "综合商店面包库存只能从批发市场补货");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});
