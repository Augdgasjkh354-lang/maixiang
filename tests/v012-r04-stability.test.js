import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { householdFoodQeqUnits, householdIdleWorkers, householdList, householdPopulation, jobAssignments, jobCount, releaseJobFromHousehold, syncResidentAggregates } from "../src/systems/households.js";
import { syncShopEmployment, prepareShopsForDay } from "../src/systems/shops.js";
import { planFoodTransfer, transferFoodQeq } from "../src/economy/inventory.js";
import { consumeDailyRations, planDailyFoodConsumption } from "../src/systems/consumption.js";
import { applyAutomaticRelief } from "../src/systems/finance.js";
import { transferVouchers } from "../src/economy/currency.js";
import { loadState, saveState, SAVE_KEY } from "../src/persistence/storage.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { numberMax, shortageJin } from "../src/ui/format.js";
import { renderOverview } from "../src/ui/panel-overview.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const Q = CONTENT.precision.qeqUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function memoryStorage(raw = null) {
  const data = new Map(raw == null ? [] : [[SAVE_KEY, raw]]);
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    raw() { return data.get(SAVE_KEY); }
  };
}

function addStreet(state, id) {
  const plot = state.plots.find(row => !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot);
  const building = { id, typeId: "commercial_street", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function openStaffedShop(state, street, seedAmount = 3000) {
  const owner = householdList(state).find(household => householdIdleWorkers(household) > 0);
  assert.ok(owner);
  assert.equal(grantResidentVouchers(state, seedAmount, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "grain", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const staffed = simulation.configureShopClerks(state, opened.shopId, 1);
  assert.equal(staffed.ok, true, staffed.reason);
  assert.equal(staffed.assigned, 1);
  return { owner, shop: state.shops[opened.shopId] };
}

function merchantKey(shop) { return `shop:${shop.id}:merchant`; }
function clerkKey(shop) { return `shop:${shop.id}:clerk`; }

function householdFoodTotal(state) {
  return householdList(state).reduce((sum, household) => sum + householdFoodQeqUnits(state, household, CONTENT), 0);
}

test("r04 商人岗位失效暂停时立即遣散店员，旧欠薪保留，保存读取后继续一天一致", () => {
  const state = legacyVoucherState({ seed: 120401 });
  const street = addStreet(state, "r04-street-retire");
  const { owner, shop } = openStaffedShop(state, street);
  const clerkAssignment = jobAssignments(state, clerkKey(shop))[0];
  assert.ok(clerkAssignment);

  if (shop.cashVoucherUnits > 0) {
    assert.equal(transferVouchers(state, `shop:${shop.id}`, `household:${owner.id}`, shop.cashVoucherUnits, CONTENT,
      "r04_test_drain", "测试抽干店铺现金").ok, true);
  }
  prepareShopsForDay(state, CONTENT);
  // 月薪：本月工资先进待发；推进到下个月 25 号（店铺默认发薪日）时镇库之外的店铺付不出，才形成欠薪。
  state.day = (Math.floor(state.day / CONTENT.rules.monthDays) + 1) * CONTENT.rules.monthDays + 24;
  prepareShopsForDay(state, CONTENT);
  const wageBeforePause = shop.liabilities.wageVoucherUnits;
  assert.ok(wageBeforePause > 0, "需先形成旧欠薪以验证暂停不抹债权");

  assert.equal(releaseJobFromHousehold(state, owner.id, merchantKey(shop), 1), 1);
  syncShopEmployment(state, CONTENT);
  assert.equal(shop.status, "paused");
  assert.equal(shop.statusReason, "商人缺位，店员已遣散");
  assert.equal(jobCount(state, merchantKey(shop)), 0);
  assert.equal(jobCount(state, clerkKey(shop)), 0);
  assert.equal(simulation.selectDashboard(state).shops.find(row => row.id === shop.id).capacityJin, 0);
  assert.deepEqual(simulation.configureShopClerks(state, shop.id, 0), { ok: true, assigned: 0, paused: true });

  prepareShopsForDay(state, CONTENT);
  // 暂停时待发工资立即到期并入欠薪；之后不再新增：再过一天欠薪不变。
  const wageAfterPause = shop.liabilities.wageVoucherUnits;
  assert.ok(wageAfterPause >= wageBeforePause, "暂停不抹旧欠薪");
  prepareShopsForDay(state, CONTENT);
  assert.equal(shop.liabilities.wageVoucherUnits, wageAfterPause, "暂停后不再新增店员工资");

  const storage = memoryStorage();
  assert.equal(saveState(storage, state, CONTENT), true);
  const loaded = loadState(storage, CONTENT).state;
  const loadedShop = loaded.shops[shop.id];
  assert.equal(loadedShop.status, "paused");
  assert.equal(jobCount(loaded, merchantKey(loadedShop)), 0);
  assert.equal(jobCount(loaded, clerkKey(loadedShop)), 0);
  assert.equal(loadedShop.liabilities.wageVoucherUnits, wageAfterPause);
  simulation.advanceDay(loaded);
  assert.equal(loadedShop.status, "paused");
  assert.equal(loadedShop.liabilities.wageVoucherUnits, wageAfterPause);
  assert.equal(simulation.validateState(loaded).valid, true, simulation.validateState(loaded).errors.join("；"));
});

test("r04 读取已有 paused 存档会清理残留店员岗位，不绕过校验", () => {
  const state = legacyVoucherState({ seed: 120402 });
  const street = addStreet(state, "r04-street-load-paused");
  const { owner, shop } = openStaffedShop(state, street);
  assert.equal(releaseJobFromHousehold(state, owner.id, merchantKey(shop), 1), 1);
  shop.status = "paused";
  shop.statusReason = "商人缺位，暂停经营";
  assert.equal(jobCount(state, clerkKey(shop)), 1);
  const loaded = loadState(memoryStorage(JSON.stringify(state)), CONTENT).state;
  const loadedShop = loaded.shops[shop.id];
  assert.equal(loadedShop.status, "paused");
  assert.equal(loadedShop.statusReason, "商人缺位，店员已遣散");
  assert.equal(jobCount(loaded, merchantKey(loadedShop)), 0);
  assert.equal(jobCount(loaded, clerkKey(loadedShop)), 0);
  assert.equal(simulation.validateState(loaded).valid, true, simulation.validateState(loaded).errors.join("；"));
});

test("r04 每日口粮只吸收最小库存单位取整残差，planFoodTransfer 转账语义保持不变", () => {
  const account = { bread: 1, wheat: 300000, flour: 0 };
  const demand = 2 * Q;
  const transferPlan = planFoodTransfer(account, demand, CONTENT, true);
  assert.equal(transferPlan.movedQeqUnits, demand - 1);
  assert.equal(transferPlan.remainingQeqUnits, 1, "转账规划仍保持原有不超额语义");

  const mealPlan = planDailyFoodConsumption(account, demand, CONTENT);
  assert.equal(mealPlan.remainingQeqUnits, 0);
  assert.equal(mealPlan.movedQeqUnits, demand + 5);
  assert.equal(mealPlan.roundingExcessQeqUnits, 5, "额外扣除的实际口粮必须明确记录为取整超额");
  assert.equal(mealPlan.moves.reduce((sum, move) => sum + move.qeqUnits, 0), mealPlan.movedQeqUnits);
  assert.equal(mealPlan.moves.reduce((sum, move) => sum + move.quantityUnits, 0), 6001);
});

test("r04 真实库存不足仍保留正缺口，极小缺口显示不足0.01斤而不是0斤", () => {
  const demand = 6;
  const plan = planDailyFoodConsumption({ bread: 1, wheat: 0, flour: 0 }, demand, CONTENT);
  assert.equal(plan.movedQeqUnits, 5);
  assert.equal(plan.remainingQeqUnits, 1);
  assert.equal(plan.roundingExcessQeqUnits, 0);
  assert.equal(shortageJin(1, Q), "不足0.01斤");
  assert.equal(numberMax(1028.44, 1), "1,028.4");

  const html = renderOverview({
    people: { workers: 600 }, shortageQeq: 1, qeqUnitsPerJin: Q, forecast: 0,
    residentFoodDays: 1028.44, accounts: { residents: { qeq: 1 }, town: { qeq: 0 } }, satisfaction: 75,
    autoRelief: false, manualReliefAmountJin: 30000, season: { name: "春", field: "春耕" },
    labor: { rows: [{ roleId: "farmers", count: 400 }], employed: 400, idle: 200 },
    farmCapacity: 400, farmWorkPercent: 0, growingDays: 274, farmMaximumHarvest: 0
  });
  assert.match(html, /不足0\.01斤/);
  assert.doesNotMatch(html, /口粮短缺 0斤/);
  assert.match(html, /1,028\.4天/);
});

test("r04 连续多日消费按实际库存扣减守恒，取整超额只在需要时产生", () => {
  const state = legacyVoucherState({ seed: 120403 });
  const households = householdList(state);
  for (const household of households) {
    household.inventory.wheat = householdPopulation(household) * CONTENT.rules.foodPerPersonDay * 5 * I;
    household.inventory.flour = 0;
    household.inventory.bread = 0;
  }
  households[0].inventory.bread = 1;
  syncResidentAggregates(state, CONTENT);
  const before = householdFoodTotal(state);
  let consumed = 0;
  let excess = 0;
  for (let day = 0; day < 5; day += 1) {
    const result = consumeDailyRations(state, simulation.populationStats(state).total, CONTENT);
    assert.equal(result.missingQeqUnits, 0);
    consumed += result.consumedQeqUnits;
    excess += result.roundingExcessQeqUnits;
    state.day += 1;
  }
  const after = householdFoodTotal(state);
  assert.equal(before - after, consumed, "库存减少的口粮当量必须等于账面实际消费");
  assert.equal(state.yearTotals.consumptionQeq, consumed);
  assert.equal(excess, 5);
  const consumeRows = state.ledger.filter(row => row.type === "consume");
  assert.equal(consumeRows.reduce((sum, row) => sum + row.qeqUnits, 0), consumed);
  assert.equal(consumeRows.reduce((sum, row) => sum + (row.roundingExcessQeqUnits || 0), 0), excess);
});

test("r04 转账与自动救济继续使用不超额的 planFoodTransfer 语义", () => {
  const transferState = legacyVoucherState({ seed: 120404 });
  const receiver = householdList(transferState)[0];
  for (const itemId of ["wheat", "flour", "bread"]) receiver.inventory[itemId] = 0;
  transferState.accounts.town.wheat = 300000;
  transferState.accounts.town.flour = 0;
  transferState.accounts.town.bread = 1;
  syncResidentAggregates(transferState, CONTENT);
  const transfer = transferFoodQeq(transferState, "town", `household:${receiver.id}`, 2 * Q,
    "r04转账回归", "transfer", CONTENT, { allowPartial: true });
  assert.equal(transfer.movedQeqUnits, 2 * Q - 1);
  assert.equal(transfer.missingQeqUnits, 1);
  assert.equal(receiver.inventory.bread, 1);
  assert.equal(receiver.inventory.wheat, 5999);

  const reliefState = legacyVoucherState({ seed: 120405 });
  const needy = householdList(reliefState)[0];
  for (const itemId of ["wheat", "flour", "bread"]) needy.inventory[itemId] = 0;
  needy.voucherUnits = 0;
  syncResidentAggregates(reliefState, CONTENT);
  reliefState.autoRelief = true;
  const townBefore = reliefState.accounts.town.wheat;
  const result = applyAutomaticRelief(reliefState, simulation.populationStats(reliefState).total, CONTENT);
  assert.ok(result.movedQeqUnits > 0);
  assert.equal(result.redeemedWheatUnits, 0);
  assert.equal(townBefore - reliefState.accounts.town.wheat,
    result.movedQeqUnits / (Q / I), "纯小麦救济仍按真实转移量扣镇库，不引入消费取整语义");
});
