import test from "node:test";
import { daysUntilHarvest, invalidateHouseholdBudgets } from "../src/systems/household-budget.js";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { initializeBuildingJobs, refillAgricultureToTarget, reconcileEmployment } from "../src/systems/employment.js";
import { householdList, householdPopulation, householdIdleWorkers, jobCount, setHouseholdJobCount, setJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { ensureHouseholdLife } from "../src/systems/household-life.js";
import { accrueServiceDemand, processServiceDemand } from "../src/systems/services.js";
import { prepareShopsForDay, finishShopsDay, resetShopDaily, sellShopProduct, shopSalesCapacityUnits } from "../src/systems/shops.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { exportState, parseSaveFile } from "../src/persistence/storage.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { advancePopulation } from "../src/systems/population.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addStreet(state, id = "street", level = 1) {
  const def = CONTENT.buildings.commercial_street;
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot);
  const building = { id, typeId: "commercial_street", level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: state.day + 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function idleHouseholds(state, count = 2) {
  const rows = householdList(state).filter(h => householdIdleWorkers(h) > 0);
  assert.ok(rows.length >= count);
  return rows.slice(0, count);
}

// 服务预算 = 家底 / wealthSpendDays × serviceShare（household-budget）。这里把"每日可花"设成 voucherPerDay：
// 家底 = voucherPerDay × wealthSpendDays，全放在粮券里，小麦清零以免多出来的存粮也算进家底。
function setBudget(household, voucherPerDay, state = null) {
  ensureHouseholdLife(household, CONTENT).day = {};
  const rules = CONTENT.rules.householdBudget;
  const keepDays = (state ? daysUntilHarvest(state, CONTENT) : CONTENT.rules.daysPerYear) + rules.harvestBufferDays;
  const keepJin = householdPopulation(household) * CONTENT.rules.foodPerPersonDay * keepDays;
  household.voucherUnits = 0;
  for (const itemId of ["flour", "bread"]) household.inventory[itemId] = 0;
  household.inventory.wheat = Math.round((keepJin + voucherPerDay * rules.wealthSpendDays) * CONTENT.precision.inventoryUnitsPerJin);
  budgetDirty = true;
}
let budgetDirty = false;
function refreshBudgets(state) {
  if (budgetDirty) { invalidateHouseholdBudgets(state); budgetDirty = false; }
}

function openService(state, street, typeId, owner) {
  const result = simulation.openResidentShop(state, street.id, typeId, owner.id);
  assert.equal(result.ok, true, result.reason);
  return state.shops[result.shopId];
}

test("农业目标与实际在岗分离：退休缺员自动补足、无人可补保留缺员、主动减员不反弹", () => {
  const state = simulation.createInitialState({ seed: 161601 });
  // 初始耕地 15000 亩、农民目标 1500（8cf03ae）。
  assert.equal(state.employment.targets.farmers, 1500);
  assert.equal(jobCount(state, "farmers"), 1500);

  // 释放一名实际农人，不改变目标；有待业劳动力时自动补回。
  const farmerHousehold = householdList(state).find(h => (h.jobs?.farmers || 0) > 0);
  assert.ok(farmerHousehold);
  assert.equal(setHouseholdJobCount(state, farmerHousehold.id, "farmers", farmerHousehold.jobs.farmers - 1, CONTENT).ok, true);
  assert.equal(jobCount(state, "farmers"), 1499);
  const refill = refillAgricultureToTarget(state, CONTENT);
  assert.equal(refill.after, 1500);
  assert.equal(refill.target, 1500);

  // 把全部闲置劳动力（1750-1500=250）占到别的岗位，再模拟一名农人退休：总劳动力与岗位同时减1，没有人可补。
  assert.equal(setJobCount(state, "test:other", 250, CONTENT).assigned, 250);
  const retiring = householdList(state).find(h => (h.jobs?.farmers || 0) > 0 && h.ageBands.workers > 0);
  const workerCohort = state.cohorts.find(row => row.age >= 18 && row.age < 65 && (row.m + row.f) > 0);
  const elderCohort = state.cohorts.find(row => row.age >= 65);
  assert.ok(retiring && workerCohort && elderCohort);
  setHouseholdJobCount(state, retiring.id, "farmers", retiring.jobs.farmers - 1, CONTENT);
  retiring.ageBands.workers -= 1;
  retiring.ageBands.elders += 1;
  if (workerCohort.m > 0) { workerCohort.m -= 1; elderCohort.m += 1; } else { workerCohort.f -= 1; elderCohort.f += 1; }
  const shortage = refillAgricultureToTarget(state, CONTENT);
  assert.equal(shortage.after, 1499);
  assert.equal(shortage.shortage, 1);
  assert.equal(state.employment.targets.farmers, 1500);

  // 玩家主动调低目标后，以新目标为准，不补回1500。
  const lowered = simulation.setEmployment(state, "farmers", 1490);
  assert.equal(lowered.target, 1490);
  reconcileEmployment(state, CONTENT);
  assert.equal(state.employment.targets.farmers, 1490);
  assert.equal(jobCount(state, "farmers"), 1490);
  const restored = parseSaveFile(exportState(state), CONTENT);
  assert.equal(restored.employment.targets.farmers, 1490);
  assert.equal(jobCount(restored, "farmers"), 1490);
});

test("真实年度人口结算释放退休农人后，会在下一用工快照前按目标自动补员", () => {
  const state = simulation.createInitialState({ seed: 161608 });
  simulation.setEmployment(state, "farmers", 200);
  assert.equal(jobCount(state, "farmers"), 200);
  // 开局数值调整（8cf03ae）后户均 13—14 人、每户 6 名农人且另有待业，人口结算自然减少 1 名劳动力
  // 已不构成"就业超过劳动力"的超额（原先 4—5 人小户会超额）。这里显式制造超额：
  // 把某户劳动力降到低于其农人岗位数，人口结算时必然释放该户的农人岗位。
  const farmerHousehold = householdList(state).find(h => (h.jobs?.farmers || 0) > 0);
  assert.ok(farmerHousehold);
  const farmersInHousehold = farmerHousehold.jobs.farmers;
  // 留 3 人的超额，抵消当年"成年→劳动力"补入后仍必然触发释放。
  farmerHousehold.ageBands.workers = Math.max(1, farmersInHousehold - 3);
  // 家庭人口必须与 cohort 一致，故同步减少 3 个劳动年龄人口。
  const workerCohort = state.cohorts.find(row => row.age >= 18 && row.age < 65 && row.m > 2);
  assert.ok(workerCohort);
  workerCohort.m -= 3;
  const result = advancePopulation(state, CONTENT);
  assert.ok(state.lastDemography.householdAllocation.retirees > 0);
  assert.ok(result.householdAllocation.employmentReleases.some(row => row.jobKey === "farmers"), "应实际释放超额农业岗位");
  assert.equal(state.employment.targets.farmers, 200);
  assert.equal(jobCount(state, "farmers"), 200, "人口结算中的岗位释放应立即按新目标补回");
  const snapshot = simulation.selectJobRows(state);
  const farmer = snapshot.rows.find(row => row.key === "farmers");
  assert.equal(farmer.count, 200);
  assert.equal(farmer.targetCount, 200);
});

test("综合商店三种商品共用接待能力，库存与成本按商品独立", () => {
  const state = simulation.createInitialState({ seed: 161602 });
  const street = addStreet(state);
  const [owner, buyer] = idleHouseholds(state, 2);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  assert.equal(simulation.configureShopClerks(state, shop.id, 1).ok, true);
  // 三种商品共用一份卖货能力：前两笔正好用完，第三笔被拒。
  const half = shopSalesCapacityUnits(state, shop, CONTENT) / 2;
  const stock = Math.round(half / I) + 30;
  for (const itemId of ["flour", "bread", "salt"]) shop.inventory[itemId] = stock * I;
  shop.inventoryCostVoucherUnits.flour = stock * V;
  shop.inventoryCostVoucherUnits.bread = 2 * stock * V;
  shop.inventoryCostVoucherUnits.salt = 3 * stock * V;
  const first = sellShopProduct(state, shop.id, `household:${buyer.id}`, half, CONTENT, "测试面粉零售", "flour");
  const second = sellShopProduct(state, shop.id, `household:${buyer.id}`, half, CONTENT, "测试面包零售", "bread");
  const third = sellShopProduct(state, shop.id, `household:${buyer.id}`, 1 * I, CONTENT, "测试盐零售", "salt");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  assert.match(third.reason, /接待能力/);
  assert.equal(shop.accounts.day.soldUnits.flour, half);
  assert.equal(shop.accounts.day.soldUnits.bread, half, "卖货能力由多商品共用");
  assert.equal(shop.inventoryCostVoucherUnits.flour, 30 * V);
  assert.equal(shop.inventoryCostVoucherUnits.bread, 60 * V);
  assert.equal(shop.inventoryCostVoucherUnits.salt, 3 * stock * V);
  assert.equal(shop.accounts.day.cogsVoucherUnits, 3 * (stock - 30) * V);
});

test("服务需求在店铺间共享且家庭共用一份服务预算，成交后不会被第二家重复满足", () => {
  const state = simulation.createInitialState({ seed: 161603 });
  const street = addStreet(state, "street-service", 2);
  const [ownerA, ownerB, ownerC, buyer] = idleHouseholds(state, 4);
  const teaA = openService(state, street, "tea", ownerA);
  const teaB = openService(state, street, "tea", ownerB);
  const haircut = openService(state, street, "haircut", ownerC);
  setBudget(buyer, 15, state);
  state.services.demandByHousehold[buyer.id] = { tea: 1000, haircut: 1000, repair: 0 };
  refreshBudgets(state);
  const result = processServiceDemand(state, CONTENT);
  const totalUses = (teaA.accounts.day.serviceUses.tea || 0) + (teaB.accounts.day.serviceUses.tea || 0) + (haircut.accounts.day.serviceUses.haircut || 0);
  assert.equal(totalUses, 1, "5券服务预算不能被每个服务系统重复使用");
  assert.equal(Object.values(result.servedUses).reduce((a, b) => a + b, 0), 1);
  const remaining = state.services.demandByHousehold[buyer.id];
  assert.equal((remaining.tea || 0) + (remaining.haircut || 0), 1000, "只核销实际购买的一项需求");

  // 同类两店共享一份需求，并用轮换避免长期固定第一家。
  teaA.accounts.day.serviceUses = {}; teaB.accounts.day.serviceUses = {}; haircut.accounts.day.serviceUses = {};
  state.services.demandByHousehold[buyer.id] = { tea: 1000, haircut: 0, repair: 0 };
  setBudget(buyer, 15, state);
  refreshBudgets(state);
  processServiceDemand(state, CONTENT);
  const firstSeller = (teaA.accounts.day.serviceUses.tea || 0) ? teaA.id : teaB.id;
  teaA.accounts.day.serviceUses = {}; teaB.accounts.day.serviceUses = {};
  state.services.demandByHousehold[buyer.id].tea = 1000;
  setBudget(buyer, 15, state);
  refreshBudgets(state);
  processServiceDemand(state, CONTENT);
  const secondSeller = (teaA.accounts.day.serviceUses.tea || 0) ? teaA.id : teaB.id;
  assert.notEqual(secondSeller, firstSeller);
});

async function servicePaymentCase(stage, targetBps) {
  const state = simulation.createInitialState({ seed: 161604 + targetBps });
  const street = addStreet(state);
  const [owner, buyer] = idleHouseholds(state, 2);
  const shop = openService(state, street, "haircut", owner);
  if (stage !== "wheat") {
    state.monetaryReform.stage = stage;
    state.monetaryReform.targetVoucherBps = targetBps;
    state.monetaryReform.residentExchangeEnabled = false;
    state.monetaryReform.legacyBankAccess = true;
    const issued = issueTownVouchers(state, 100 * V, CONTENT, "测试印制");
    assert.equal(issued.ok, true, issued.reason);
    const transfer = transferVouchers(state, "town", `household:${buyer.id}`, 20 * V, CONTENT, "test_income", "测试服务消费资金");
    assert.equal(transfer.ok, true, transfer.reason);
  }
  setBudget(buyer, 20, state);
  state.services.demandByHousehold[buyer.id] = { haircut: 1000, repair: 0, tea: 0 };
  const before = { voucher: shop.cashVoucherUnits, wheat: shop.cashWheatUnits };
  const result = processServiceDemand(state, CONTENT);
  assert.equal(result.servedUses.haircut, 1);
  return { voucherDelta: shop.cashVoucherUnits - before.voucher, wheatDelta: shop.cashWheatUnits - before.wheat, state };
}

test("服务成交、店员工资、店租与利润税均形成真实资金流", () => {
  const state = simulation.createInitialState({ seed: 161605 });
  const street = addStreet(state);
  // 只用到第一个有空闲劳动力的户主；人口调整后有空闲劳力的家庭变少，不再需要预留 50 户。
  const owners = idleHouseholds(state, 1);
  const owner = owners[0];
  const shop = openService(state, street, "haircut", owner);
  assert.equal(simulation.configureShopClerks(state, shop.id, 1).assigned, 1);
  prepareShopsForDay(state, CONTENT);
  const buyers = householdList(state).filter(h => h.id !== owner.id).slice(0, 50);
  for (const buyer of buyers) {
    setBudget(buyer, 20, state);
    state.services.demandByHousehold[buyer.id] = { haircut: 1000, repair: 0, tea: 0 };
  }
  processServiceDemand(state, CONTENT);
  const uses = shop.accounts.day.serviceUses.haircut || 0;
  assert.equal(uses, 50, "扩容后1商人+1店员在50个买家场景下可全部接待");
  const townBeforeFinish = state.accounts.town.wheat;
  finishShopsDay(state, CONTENT, true);
  // 基线清理：店主商人不领固定工资，仅1店员计 5*V（默认日薪 10→5 斤，8cf03ae）。
  assert.equal(shop.accounts.day.wageExpenseVoucherUnits, 5 * V);
  assert.equal(shop.accounts.day.rentExpenseVoucherUnits, 1 * V);
  assert.ok(shop.accounts.day.taxExpenseVoucherUnits > 0);
  assert.equal(shop.liabilities.wageVoucherUnits, 0);
  assert.equal(shop.liabilities.rentVoucherUnits, 0);
  assert.equal(shop.liabilities.taxVoucherUnits, 0);
  assert.ok(state.accounts.town.wheat >= townBeforeFinish, "租税应真实进入镇库而非只记账");
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true);
});

function serviceIncomeScenario(disposableVoucherPerDay) {
  const state = simulation.createInitialState({ seed: 161607 });
  const street = addStreet(state, "street-income", 2);
  const owners = idleHouseholds(state, 3);
  const haircut = openService(state, street, "haircut", owners[0]);
  const repair = openService(state, street, "repair", owners[1]);
  const tea = openService(state, street, "tea", owners[2]);
  for (let day = 0; day < 18; day += 1) {
    resetShopDaily(state, CONTENT);
    for (const household of householdList(state)) setBudget(household, disposableVoucherPerDay, state);
    refreshBudgets(state);
    accrueServiceDemand(state, CONTENT);
    prepareShopsForDay(state, CONTENT);
    processServiceDemand(state, CONTENT);
    finishShopsDay(state, CONTENT, false);
    state.day += 1;
  }
  const shops = [haircut, repair, tea];
  return {
    served: shops.reduce((sum, shop) => sum + (shop.history || []).reduce((s, row) => s + Object.values(row.serviceUses || {}).reduce((a, b) => a + b, 0), 0) + Object.values(shop.accounts.day.serviceUses || {}).reduce((a, b) => a + b, 0), 0),
    clerks: shops.reduce((sum, shop) => sum + jobCount(state, `shop:${shop.id}:clerk`), 0),
    state
  };
}

test("同人口同种子下，可支配收入提高会增加服务消费与可持续服务就业，但不会强制吸收全部失业", () => {
  const low = serviceIncomeScenario(0.5);
  const high = serviceIncomeScenario(30);
  assert.ok(high.served > low.served * 3 + 10, `高收入服务次数应明显更高：low=${low.served}, high=${high.served}`);
  assert.equal(low.clerks, 0, "真实需求不足的新店只由商人试营业，不应无条件招满店员");
  assert.ok(high.clerks > low.clerks, `高收入应支持更多店员：low=${low.clerks}, high=${high.clerks}`);
  assert.ok(simulation.selectJobRows(high.state).idle > 0, "服务业扩张不预设消灭全部失业");
});
