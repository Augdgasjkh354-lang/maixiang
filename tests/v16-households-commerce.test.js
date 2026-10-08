import test from "node:test";
import assert from "node:assert/strict";
import { jobCount, householdEmploymentCount, householdIdleWorkers } from "../src/systems/households.js";
import { simulation, CONTENT } from "../src/engine.js";
import { maximumResidentExchangeWheatUnits, householdList } from "../src/systems/households.js";
import { initializeBuildingJobs, reconcileEmployment } from "../src/systems/employment.js";
import {
  prepareShopsForDay, finishShopsDay, sellShopProduct, settleShopTaxAndDistribution
} from "../src/systems/shops.js";
import { transferVouchers } from "../src/economy/currency.js";
import { transferTownToWholesale } from "../src/systems/wholesale-market.js";
import { exportState, importState } from "../src/persistence/storage.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addCompletedBuilding(state, typeId, id, level = 1) {
  const def = CONTENT.buildings[typeId];
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = {
    id, typeId, level,
    ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: state.day + 1 }
  };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function fundedHousehold(state, amount = 1000, exclude = new Set()) {
  const household = householdList(state).find(row => !exclude.has(row.id) && householdIdleWorkers(row) > 0);
  assert.ok(household);
  assert.equal(grantResidentVouchers(state, amount, CONTENT, household.id).ok, true);
  return household;
}

test("v16初始家庭保持3300人口、1750劳动力和居民总财富汇总一致", () => {
  const state = legacyVoucherState();
  const households = householdList(state);
  assert.equal(households.length, 250);
  assert.equal(state.households.members, undefined);
  // 开局数值调整（8cf03ae）：人口 1100→3300（未成年1050/劳动力1750/老年500）。
  assert.equal(households.reduce((sum, h) => sum + h.ageBands.children + h.ageBands.workers + h.ageBands.elders, 0), 3300);
  assert.equal(simulation.populationStats(state).children, 1050);
  assert.equal(simulation.populationStats(state).workers, 1750);
  assert.equal(simulation.populationStats(state).elders, 500);
  const occupations = simulation.selectDashboard(state).households.occupations;
  assert.equal(occupations["农民"], 1500);
  const summedWheat = households.reduce((sum, h) => sum + (h.inventory.wheat || 0), 0);
  const summedVouchers = households.reduce((sum, h) => sum + (h.voucherUnits || 0), 0);
  assert.equal(state.accounts.residents.wheat, summedWheat);
  assert.equal(state.currency.balances.residents, summedVouchers);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("就业换券额度按实际在岗成员每日生成，换岗不刷新，收入不占额度", () => {
  const state = legacyVoucherState();
  // 基线清理：居民换券是把小麦交给镇库、换回镇库**已发行**的粮券
  // （issueVouchersFromWheat 要求 voucherBalance(town) >= 兑换额）。本用例原先没印券，
  // 镇库余额为 0，换券必然被"镇库已发行粮券余额不足"挡下——是测试夹具缺前置，不是逻辑退化。
  assert.equal(simulation.issueGrainVouchers(state, "town", 8000).ok, true);
  // 换券额度按在岗农人计：农民 1500 人，新局默认每人每日 5 斤，共 7500 斤。
  assert.equal(maximumResidentExchangeWheatUnits(state, CONTENT) / I, 7500);
  assert.equal(simulation.issueGrainVouchers(state, "residents", 7500).ok, true);
  assert.equal(maximumResidentExchangeWheatUnits(state, CONTENT), 0);
  assert.equal(simulation.issueGrainVouchers(state, "residents", 1).ok, false);
  simulation.setEmployment(state, "farmers", 1499);
  simulation.setEmployment(state, "farmers", 1500);
  assert.equal(maximumResidentExchangeWheatUnits(state, CONTENT), 0, "同日离岗再入岗不得刷新额度");

  const beforeIncome = state.currency.balances.residents;
  assert.equal(grantResidentVouchers(state, 100, CONTENT).ok, true);
  assert.equal(state.currency.balances.residents - beforeIncome, 100 * V);
  assert.equal(maximumResidentExchangeWheatUnits(state, CONTENT), 0, "工资/收入类转账不应消耗或刷新换券额度");

  state.day += 1;
  assert.equal(maximumResidentExchangeWheatUnits(state, CONTENT) / I, 7500, "额度次日重置且不累计");
  assert.equal(simulation.setEmploymentExchangeQuota(state, 0).ok, true);
  state.day += 1;
  assert.equal(maximumResidentExchangeWheatUnits(state, CONTENT), 0);
  assert.equal(simulation.setEmploymentExchangeQuota(state, 10).ok, true);
  state.day += 1;
  assert.equal(maximumResidentExchangeWheatUnits(state, CONTENT) / I, 15000);
});

test("公务员与警察需求按全镇人口计算，3300人为7、3701人为8且不按建筑重复", () => {
  const state = legacyVoucherState();
  const hallA = addCompletedBuilding(state, "town_hall", "hall-a");
  addCompletedBuilding(state, "town_hall", "hall-b");
  const policeA = addCompletedBuilding(state, "police_station", "police-a");
  let jobs = simulation.selectJobRows(state);
  // 需求 = ceil(人口 / 500)：3300 → 7（8cf03ae 人口调整）。
  assert.equal(jobs.publicServiceDemand, 7);
  assert.equal(simulation.setEmployment(state, `${hallA.id}::civil_servants`, 10).assigned, 7);
  assert.equal(simulation.setEmployment(state, `${policeA.id}::police`, 10).assigned, 7);
  assert.equal(simulation.setEmployment(state, "hall-b::civil_servants", 10).assigned, 0, "第二栋不能再复制一份全镇需求");

  // 加401人（3300→3701），跨过3500阈值，需求从7变8
  const workerCohort = state.cohorts.find(row => row.age >= 18 && row.age < 65);
  const extraHousehold = householdList(state)[0];
  workerCohort.m += 401;
  extraHousehold.ageBands.workers += 401;
  jobs = simulation.selectJobRows(state);
  assert.equal(jobs.publicServiceDemand, 8);
  assert.equal(simulation.setEmployment(state, `${hallA.id}::civil_servants`, 10).assigned, 8);
  assert.equal(simulation.setEmployment(state, `${policeA.id}::police`, 10).assigned, 8);

  workerCohort.m -= 401;
  extraHousehold.ageBands.workers -= 401;
  reconcileEmployment(state, CONTENT);
  jobs = simulation.selectJobRows(state);
  assert.equal(jobs.publicServiceDemand, 7);
  assert.equal(jobs.civilServants, 7);
  assert.equal(jobs.police, 7);
});

test("商业街每级2铺、综合商店每铺最多50店员且所有岗位占用真实唯一劳动力", () => {
  const state = legacyVoucherState();
  const street = addCompletedBuilding(state, "commercial_street", "street-a");
  const ownerA = fundedHousehold(state, 1000);
  const ownerB = fundedHousehold(state, 1000, new Set([ownerA.id]));
  const first = simulation.openResidentShop(state, street.id, "bakery", ownerA.id);
  const second = simulation.openResidentShop(state, street.id, "salt", ownerB.id);
  assert.equal(first.ok, true, first.reason);
  assert.equal(second.ok, true, second.reason);
  assert.equal(simulation.openResidentShop(state, street.id, "grain", null).ok, false);
  assert.equal(simulation.configureShopClerks(state, first.shopId, 50).assigned, 50);
  assert.equal(simulation.configureShopClerks(state, second.shopId, 50).assigned, 50);
  assert.equal(simulation.configureShopClerks(state, first.shopId, 60).assigned, 50);

  assert.equal(jobCount(state, `shop:${first.shopId}:merchant`) + jobCount(state, `shop:${second.shopId}:merchant`), 2);
  assert.equal(jobCount(state, `shop:${first.shopId}:clerk`) + jobCount(state, `shop:${second.shopId}:clerk`), 100);
  assert.ok(householdList(state).every(h => householdEmploymentCount(h) <= h.ageBands.workers));
  const rows = simulation.selectJobRows(state).rows.filter(row => row.buildingId === street.id);
  assert.equal(rows.find(row => row.roleId === "merchants").count, 2);
  assert.equal(rows.find(row => row.roleId === "shop_clerks").count, 100);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("店铺未售库存不计销售成本，正利润征税、亏损不征税", () => {
  const state = legacyVoucherState();
  const street = addCompletedBuilding(state, "commercial_street", "street-books");
  const owner = fundedHousehold(state, 1000);
  const buyer = fundedHousehold(state, 1000, new Set([owner.id]));
  addCompletedBuilding(state, "wholesale_market", "wholesale-books");
  state.accounts.town.bread = 1000 * I;
  assert.ok(transferTownToWholesale(state, "bread", 1000 * I, CONTENT).movedUnits > 0);
  const opened = simulation.openResidentShop(state, street.id, "bakery", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  state.employment.wageRates.merchants = 0;
  state.employment.wageRates.shop_clerks = 0;
  assert.equal(simulation.configureShopClerks(state, shop.id, 1).assigned, 1);
  prepareShopsForDay(state, CONTENT);
  const purchased = shop.accounts.day.purchasedUnits.bread || 0;
  // 基线清理：商人计入接待能力（1 店员 + 1 商人 = 2 人），试进货量相应翻倍；每店员接待从40提到60。
  assert.equal(purchased, 137307);
  assert.equal(shop.accounts.day.cogsVoucherUnits, 0, "未售库存不能直接计销售成本");
  assert.equal(shop.accounts.day.profitVoucherUnits, -1 * V, "进货不是费用，未销售时仅计租金");

  const sale = sellShopProduct(state, shop.id, `household:${buyer.id}`, 5 * I, CONTENT, "测试零售");
  assert.equal(sale.ok, true, sale.reason);
  // 0.2.3 流通改革：批发市场做市商默认面包售价 2.6，综合商店固定加价 20% → 零售 3.12；
  // 5 单位售价 15.6 粮券，进货成本 2.6 × 5 = 13 粮券，利润 2.6 粮券。
  assert.equal(sale.paidVoucherUnits, Math.round(3.12 * 5 * V));
  // 基线清理：允许 1 单位舍入误差（进货量变化导致平均成本微差）。
  assert.ok(Math.abs(sale.cogsVoucherUnits - Math.round(2.6 * 5 * V)) <= 1);
  // 毛利 (3.12−2.6)×5 = 2.6 粮券，减去当日店租 1 粮券 = 1.6 粮券（4800 单位，允许 1 单位舍入误差）。
  assert.ok(Math.abs(shop.accounts.day.profitVoucherUnits - (Math.round((3.12 - 2.6) * 5 * V) - 1 * V)) <= 1);
  shop.settlement.days = 30;
  const settlement = settleShopTaxAndDistribution(state, shop, CONTENT, false);
  assert.equal(settlement.settled, true);
  // 商业利润税 10%，按本期结算利润（4800 单位）计征。
  const periodProfit = Math.round((3.12 - 2.6) * 5 * V) - 1 * V;
  assert.ok(Math.abs(settlement.taxVoucherUnits - Math.floor(periodProfit * 0.1)) <= 2, String(settlement.taxVoucherUnits));

  const lossState = legacyVoucherState();
  const lossStreet = addCompletedBuilding(lossState, "commercial_street", "street-loss");
  const lossOwner = fundedHousehold(lossState, 1000);
  const lossOpen = simulation.openResidentShop(lossState, lossStreet.id, "bakery", lossOwner.id);
  const lossShop = lossState.shops[lossOpen.shopId];
  lossShop.settlement.profitVoucherUnits = -50 * V;
  lossShop.settlement.days = 30;
  const loss = settleShopTaxAndDistribution(lossState, lossShop, CONTENT, false);
  assert.equal(loss.taxVoucherUnits, 0);
  assert.equal(loss.lossCarryVoucherUnits, -50 * V);
});

test("店铺欠薪欠租会保留，长期无法经营自动停业并释放商人和店员", () => {
  const state = legacyVoucherState();
  const street = addCompletedBuilding(state, "commercial_street", "street-close");
  const owner = fundedHousehold(state, 1000);
  const opened = simulation.openResidentShop(state, street.id, "salt", owner.id);
  assert.equal(opened.ok, true);
  const shop = state.shops[opened.shopId];
  assert.equal(simulation.configureShopClerks(state, shop.id, 2).assigned, 2);
  assert.equal(jobCount(state, `shop:${shop.id}:merchant`), 1);
  assert.equal(jobCount(state, `shop:${shop.id}:clerk`), 2);
  if (shop.cashVoucherUnits > 0) {
    const drained = transferVouchers(state, `shop:${shop.id}`, `household:${owner.id}`, shop.cashVoucherUnits, CONTENT, "test_drain", "测试抽干店铺现金");
    assert.equal(drained.ok, true);
  }
  prepareShopsForDay(state, CONTENT);
  // 基线清理：店主商人不领固定工资，仅2店员计 2×5×V（默认日薪 10→5 斤，8cf03ae）。
  assert.equal(shop.liabilities.wageVoucherUnits, 10 * V);
  assert.equal(shop.liabilities.rentVoucherUnits, 1 * V);
  shop.badDays = CONTENT.rules.shopClosureBadDays - 1;
  const result = finishShopsDay(state, CONTENT).find(row => row.shopId === shop.id);
  assert.equal(result.closed, true);
  assert.equal(shop.status, "liquidating");
  assert.ok(shop.liabilities.wageVoucherUnits > 0 || shop.liabilities.rentVoucherUnits > 0);
  assert.equal(jobCount(state, `shop:${shop.id}:merchant`), 0);
  assert.equal(jobCount(state, `shop:${shop.id}:clerk`), 0);
  const streetRows = simulation.selectJobRows(state).rows.filter(row => row.buildingId === street.id);
  assert.equal(streetRows.find(row => row.roleId === "merchants").count, 0);
  assert.equal(streetRows.find(row => row.roleId === "shop_clerks").count, 0);
});

test("家庭、职业和店铺归属可保存恢复且恢复后仍通过一致性校验", () => {
  const state = legacyVoucherState({ seed: 1600 });
  const street = addCompletedBuilding(state, "commercial_street", "street-save");
  const owner = fundedHousehold(state, 1000);
  const opened = simulation.openResidentShop(state, street.id, "grain", owner.id);
  assert.equal(opened.ok, true);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, 1).assigned, 1);
  const restored = importState({ getItem() { return null; }, setItem() {} }, exportState(state), CONTENT);
  const shop = restored.shops[opened.shopId];
  assert.equal(shop.ownerHouseholdId, owner.id);
  assert.equal(restored.households.byId[owner.id].jobs[`shop:${shop.id}:merchant`], 1);
  assert.equal(jobCount(restored, `shop:${shop.id}:clerk`), 1);
  assert.equal(restored.households.members, undefined);
  assert.equal(simulation.validateState(restored).valid, true, simulation.validateState(restored).errors.join("；"));
});
