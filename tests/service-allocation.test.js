import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT, simulation } from "../src/engine.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "../src/systems/households.js";
import { householdIdleWorkers } from "../src/systems/households.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { accrueServiceDemand, processServiceDemand, serviceUnitPrice, SERVICE_DEMAND_SCALE } from "../src/systems/services.js";
import { prepareShopsForDay, finishShopsDay, resetShopDaily } from "../src/systems/shops.js";
import { householdBudgets, invalidateHouseholdBudgets } from "../src/systems/household-budget.js";
import { ensureHouseholdLife } from "../src/systems/household-life.js";
import { totalVoucherBalances } from "../src/economy/currency.js";
import { setHouseholdVoucherUnits } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const DEMAND = SERVICE_DEMAND_SCALE;

function addStreet(state, id, level = 2) {
  const def = CONTENT.buildings.commercial_street;
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, "需要一块空地建商业街");
  const building = { id, typeId: "commercial_street", level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: state.day + 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function openService(state, street, typeId, owner) {
  const result = simulation.openResidentShop(state, street.id, typeId, owner.id);
  assert.equal(result.ok, true, result.reason);
  return state.shops[result.shopId];
}

// 把一户的服务预算（当日，单位：券的整数单位）设成 targetUnits。
// 收入清零，服务预算与家底成正比，所以先试探一次求比例，再按比例设家底，并回读确认。
function setServiceBudget(state, household, targetUnits) {
  ensureHouseholdLife(household, CONTENT).day = {};
  household.incomeExpectationJin = 0;
  household.recentIncomeUnits = 0;
  const keepJin = householdPopulation(household) * CONTENT.rules.foodPerPersonDay * CONTENT.rules.householdBudget.wealthFoodReserveDays;
  household.inventory.wheat = Math.round(keepJin * I);
  household.inventory.flour = 0;
  household.inventory.bread = 0;
  const probe = wealthUnits => {
    setHouseholdVoucherUnits(state, household, wealthUnits);
    syncResidentAggregates(state, CONTENT);
    invalidateHouseholdBudgets(state);
    return householdBudgets(state, CONTENT).get(household.id).serviceBudgetUnits;
  };
  const base = 1000 * V;
  const per = probe(base);
  assert.ok(per > 0, "服务预算应随家底增长");
  // 预算对家底略非线性（取整、支付能力上限），迭代几次逼近目标。
  let wealth = Math.round(targetUnits * base / per);
  let got = probe(wealth);
  for (let i = 0; i < 4 && Math.abs(got - targetUnits) > 1; i += 1) {
    wealth = Math.round(wealth * targetUnits / got);
    got = probe(wealth);
  }
  assert.ok(Math.abs(got - targetUnits) <= Math.max(2, targetUnits * 0.001), `服务预算应约为 ${targetUnits}，实际 ${got}`);
  return got;
}

function budgetUnits(state, household) {
  invalidateHouseholdBudgets(state);
  return householdBudgets(state, CONTENT).get(household.id).serviceBudgetUnits;
}

// 一天的服务结算（不再累计需求，需求由测试逐日设定为"每项 1 次"或指定次数）。
function runServiceDay(state) {
  const sv = state.services;
  sv.day = { demandedUses: {}, attemptedUses: {}, servedUses: {}, unaffordableUses: {}, capacityUnmetUses: {}, spendingVoucherUnits: 0 };
  resetShopDaily(state, CONTENT);
  prepareShopsForDay(state, CONTENT);
  const result = processServiceDemand(state, CONTENT);
  finishShopsDay(state, CONTENT, false);
  state.day += 1;
  return result;
}

function setDemand(state, household, serviceId, uses) {
  state.services.demandByHousehold[household.id] ||= {};
  state.services.demandByHousehold[household.id][serviceId] = uses * DEMAND;
}

// 同一户、四种服务（理发、茶馆、修补、饭店），每项需求各 n 次；店主用空闲劳力家庭，互不相同。
function serviceWorld(seed, types = ["haircut", "tea", "repair", "restaurant"]) {
  const state = simulation.createInitialState({ seed });
  const subject = householdList(state).find(isActiveHousehold);
  const owners = householdList(state).filter(h => h.id !== subject.id && isActiveHousehold(h) && householdIdleWorkers(h) > 0);
  assert.ok(owners.length >= types.length, "需要足够的空闲劳力家庭当店主");
  const shops = {};
  types.forEach((typeId, i) => {
    const street = addStreet(state, `street-${seed}-${typeId}`);
    shops[typeId] = openService(state, street, typeId, owners[i]);
  });
  return { state, subject, shops };
}

test("[服务分配] 同一户预算只够一部分服务时，低敏感度服务先满足，高敏感度（茶馆）被砍；连续 6 天结果稳定", () => {
  const { state, subject } = serviceWorld(8101, ["haircut", "tea"]);
  const total0 = totalVoucherBalances(state);
  // 预算 5.5 券：理发（票价 4、门槛 4）先买 1 次，剩 1.5 券；茶馆门槛 4.8 券，买不起。
  // 若先排茶馆（票价 3），5.5 券够买 1 次茶，剩 2.5 券，理发就买不起了——顺序确实决定了谁被砍。
  const outcomes = [];
  for (let day = 0; day < 6; day += 1) {
    setServiceBudget(state, subject, 5.5 * V);
    setDemand(state, subject, "haircut", 1);
    setDemand(state, subject, "tea", 1);
    const result = runServiceDay(state);
    outcomes.push({ haircut: result.servedUses.haircut || 0, tea: result.servedUses.tea || 0 });
    assert.equal(result.unaffordableUses.tea, 1, `第 ${day + 1} 天茶馆应因没钱未成交`);
  }
  for (const row of outcomes) assert.deepEqual(row, { haircut: 1, tea: 0 }, "每天的成交结果应相同（不再逐日轮换）");
  assert.equal(totalVoucherBalances(state), total0, "粮券总量守恒");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));
});

test("[服务分配] 高敏感服务（茶馆）：预算低于门槛（票价×敏感度）不买，过门槛后按实际票价买够", () => {
  const { state, subject } = serviceWorld(8102, ["tea"]);
  const price = serviceUnitPrice(state, "tea", CONTENT) * V;
  const gate = Math.ceil(price * CONTENT.rules.serviceTypes.tea.incomeSensitivity);
  assert.equal(price, 3 * V, "茶馆票价 3 券");
  assert.equal(gate, Math.ceil(3 * V * 1.6), "茶馆门槛 = 票价 × 1.6");

  // 预算 4.7 券 < 门槛 4.8 券：一次也不买。
  setServiceBudget(state, subject, 4.7 * V);
  setDemand(state, subject, "tea", 3);
  let result = runServiceDay(state);
  assert.equal(result.servedUses.tea || 0, 0, "未过门槛不买茶");
  assert.equal(result.unaffordableUses.tea, 3);

  // 预算 6 券：过门槛，按票价 3 券买 floor(6/3) = 2 次（剩余预算不作废，需求 3 次只成交 2 次）。
  setServiceBudget(state, subject, 6 * V);
  setDemand(state, subject, "tea", 3);
  result = runServiceDay(state);
  assert.equal(result.servedUses.tea, 2, "预算 6 券、票价 3 券，应买 2 次");
  assert.equal(result.unaffordableUses.tea, 1, "第 3 次因预算不足未买");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));
});

test("[服务分配] 敏感度 ≤ 1 的服务（理发 0.8、饭店 1.0）：门槛不高于票价，等同按实际票价买", () => {
  const { state, subject, shops } = serviceWorld(8103, ["haircut", "restaurant"]);
  // 饭店只接待店员（employeeOnlyCapacity），先请两名店员。
  const hired = simulation.configureShopClerks(state, shops.restaurant.id, 2, CONTENT);
  assert.equal(hired.ok, true, hired.reason);
  for (const serviceId of ["haircut", "restaurant"]) {
    const price = serviceUnitPrice(state, serviceId, CONTENT) * V;
    const def = CONTENT.rules.serviceTypes[serviceId];
    assert.ok(def.incomeSensitivity <= 1);
    // 预算 9 券、票价 4 券，需求 5 次：应按实际票价买 floor(9/4) = 2 次。
    // 逐项单独测：清掉其他服务的需求，否则共用预算会先被理发吃掉。
    for (const other of ["haircut", "restaurant"]) setDemand(state, subject, other, other === serviceId ? 5 : 0);
    setServiceBudget(state, subject, 9 * V);
    const result = runServiceDay(state);
    assert.equal(result.servedUses[serviceId], Math.floor(9 * V / price), `${serviceId} 应按票价买 2 次`);
    assert.equal(result.unaffordableUses[serviceId], 3, `${serviceId} 其余 3 次因没钱未买`);
    setDemand(state, subject, serviceId, 0);
  }
});

test("[服务分配] rotation.services 不再增长（字段保留，值保持不变）", () => {
  const { state, subject } = serviceWorld(8104, ["haircut", "tea"]);
  const before = state.services.rotation.services || 0;
  for (let day = 0; day < 5; day += 1) {
    setServiceBudget(state, subject, 20 * V);
    setDemand(state, subject, "haircut", 1);
    setDemand(state, subject, "tea", 1);
    runServiceDay(state);
  }
  assert.equal(state.services.rotation.services || 0, before, "rotation.services 不应再递增");
});

test("[服务分配] 多户多服务多天：粮券总量守恒，validateState 通过", () => {
  const { state } = serviceWorld(8105, ["haircut", "tea", "repair", "restaurant"]);
  const buyers = householdList(state).filter(isActiveHousehold).slice(0, 12);
  const total0 = totalVoucherBalances(state);
  for (let day = 0; day < 4; day += 1) {
    buyers.forEach((h, i) => {
      setServiceBudget(state, h, (3 + i * 2) * V);
      for (const serviceId of ["haircut", "tea", "repair", "restaurant"]) setDemand(state, h, serviceId, 2);
    });
    runServiceDay(state);
    assert.equal(totalVoucherBalances(state), total0, `第 ${day + 1} 天粮券总量应守恒`);
    assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));
  }
});
