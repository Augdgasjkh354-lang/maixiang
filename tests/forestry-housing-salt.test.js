import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { changeInventory, addInventory } from "../src/economy/inventory.js";
import { selectHousing } from "../src/selectors/housing.js";
import { accrueSaltNeed, buySaltForResidents, consumeDailySalt } from "../src/systems/salt.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { renderPeople } from "../src/ui/panel-people.js";
import { grantResidentVouchers, setResidentInventoryJin } from "./helpers-v16.js";
import { householdFoodQeqUnits, householdIdleWorkers, householdList, householdReserveQeqUnits, setJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { shopTradePrices } from "../src/economy/operating-plan.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const SCALE = CONTENT.precision.inventoryUnitsPerJin;

function totalItem(state, id) {
  return (state.accounts.residents[id] || 0) + (state.accounts.town[id] || 0);
}

function totalResidentAndTownSalt(state) {
  return (state.accounts.residents.salt || 0) + (state.accounts.town.salt || 0);
}

// 基线清理：0.2.3 后镇营/商业街建筑需要在建成的商业街上开店，
// 这里给出与 tests/v023-circulation-reform.test.js 一致的建楼助手。
function addBuilding(state, typeId, id, level = 1) {
  const definition = CONTENT.buildings[typeId];
  const plot = state.plots.find(row => (!definition.requiredPlotFeature || row.feature === definition.requiredPlotFeature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, `缺少可建 ${typeId} 的地块`);
  const building = {
    id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [],
    completed: { year: state.year, day: state.day + 1 }
  };
  state.buildings.push(building);
  return building;
}

function setStock(state, owner, id, quantity) {
  if (owner === "residents") return setResidentInventoryJin(state, id, quantity, CONTENT);
  const target = Math.round(quantity * SCALE);
  return changeInventory(state, owner, id, target - state.accounts[owner][id],
    "测试备料", "test_adjustment", CONTENT);
}

test("伐木场与盐场按岗位人数生产；行业工资不混入面包链", () => {
  const state = simulation.createInitialState();
  assert.equal(simulation.buildAt(state, "lumberyard", "east").reason, "伐木场只能建在南部森林资源点地块");
  const build = simulation.buildAt(state, "lumberyard", "forest-logging-01");
  assert.equal(build.ok, true);
  simulation.advanceDays(state, 20);
  assert.equal(state.project, null);
  assert.equal(simulation.setEmployment(state, build.instanceId + "::lumberjacks", 7).assigned, 7);
  const wheatBefore = totalItem(state, "wheat");
  simulation.advanceDay(state);

  assert.equal(state.accounts.town.wood / SCALE, 7);
  assert.equal(state.accounts.residents.wood, 0);
  assert.equal(state.industries.forestry.day.producedUnits.wood / SCALE, 7);
  // 默认日薪 10→5 斤（8cf03ae）：7 名伐木工 × 5 = 35 斤。
  assert.equal(state.industries.forestry.day.operatingWagesWheatUnits / SCALE, 35);
  assert.equal(state.business.day.producedUnits.wood, undefined);
  assert.equal(state.business.day.operatingWagesWheatUnits, 0);
  // 人口 3300：当日口粮消耗 2200→6600 斤。
  assert.equal(totalItem(state, "wheat"), wheatBefore - 6600 * SCALE);

  const saltState = simulation.createInitialState();
  addInventory(saltState, "town", "wood", 100, "test stock", "test", CONTENT);
  const saltworks = simulation.buildAt(saltState, "saltworks", "forest-salt-01");
  assert.equal(saltworks.ok, true);
  simulation.advanceDays(saltState, 30);
  assert.equal(saltState.project, null);
  assert.equal(simulation.setEmployment(saltState, saltworks.instanceId + "::salt_workers", 6).assigned, 6);
  simulation.advanceDay(saltState);
  assert.ok(Math.abs(saltState.accounts.town.salt / SCALE -
    (30 - saltState.salt.day.satisfiedUnits / SCALE)) < 1e-10);
  assert.equal(saltState.industries.salt.day.producedUnits.salt / SCALE, 30);
  // 默认日薪 10→5 斤（8cf03ae）：6 名盐工 × 5 = 30 斤。
  assert.equal(saltState.industries.salt.day.operatingWagesWheatUnits / SCALE, 30);
  assert.equal(saltState.business.day.operatingWagesWheatUnits, 0);
  assert.equal(simulation.validateState(saltState).valid, true);
});

test("年度盐需求精确；六名盐工连续生产365日的物理产能按工资口径记账", () => {
  const demandState = simulation.createInitialState({ seed: 1501 });
  simulation.advanceDays(demandState, 365);
  // 人口 1100→3300（8cf03ae）：年盐需求 11000→33000（人均 10/年）。
  assert.equal(demandState.annualReports[0].populationAtClose, 3300);
  assert.equal(demandState.annualReports[0].salt.demandUnits / SCALE, 33000);
  assert.equal(demandState.annualReports[0].salt.satisfiedUnits, 0);
  assert.equal(demandState.salt.graceDaysElapsed, 30);

  const state = simulation.createInitialState({ seed: 1501 });
  addInventory(state, "town", "wood", 100, "test stock", "test", CONTENT);
  const build = simulation.buildAt(state, "saltworks", "forest-salt-01");
  simulation.advanceDays(state, 30);
  assert.equal(state.project, null);
  simulation.setEmployment(state, build.instanceId + "::salt_workers", 6);

  // Stage a fresh year after construction so the 365 counted production days are exact.
  state.year = 1;
  state.day = 0;
  state.salt.demandCarry = 0;
  state.salt.graceDaysElapsed = 0;
  state.salt.history = [];
  state.salt.day = { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 };
  state.salt.year = { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 };
  state.salt.lifetime = { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 };
  for (const group of [state.industries.salt.day, state.industries.salt.year, state.industries.salt.cumulative]) {
    group.producedUnits = {};
    group.soldUnits = 0;
    group.revenueWheatUnits = 0;
    group.operatingWagesWheatUnits = 0;
  }
  state.agriculture.lastHarvestYear = 0;

  assert.equal(grantResidentVouchers(state, 300000, CONTENT).ok, true);
  simulation.advanceDays(state, 365);
  // 基线清理：年度报告经 annualPeriod() 展平（src/systems/annual-reports.js），
  // industries.salt 直接就是年度累计，不再有 .cumulative 层。
  const saltYear = state.annualReports[0].industries.salt;
  // 基准 6 名盐工 × 5 斤/日 × 365 = 10950 斤；一年 2190 工日的熟练度让人均产出逐日略升（年末约 +5%）。
  const produced = saltYear.producedUnits.salt / SCALE;
  assert.ok(produced > 10950 && produced < 10950 * 1.06, `盐产量应略高于基准，实际${produced}`);
  assert.equal(state.annualReports[0].salt.demandUnits / SCALE, 33000);
  // 默认日薪 10→5 斤（8cf03ae）：6 名盐工年工资 21900→10950 斤。
  assert.equal(saltYear.operatingWagesWheatUnits / SCALE, 10950);
  // 基线清理：0.2.3 起面粉/面包/盐只能经综合商店零售（consumer-market.js generalStoreOnly），
  // 本 fixture 只有盐场、没有商业街/综合商店，所以产出的盐全部留存镇库、零成交。
  assert.equal(saltYear.soldUnits / SCALE, 0);
  assert.equal(saltYear.revenueWheatUnits / SCALE, 0);
  assert.equal(state.annualReports[0].salt.satisfiedUnits / SCALE, 0);
  assert.equal(state.accounts.town.salt / SCALE, produced);
  assert.equal(state.accounts.residents.salt, 0);
});

test("食盐原子交易守恒，单独消费且居民粮储线会限购", () => {
  // 基线清理：0.2.3 起面粉/面包/盐不再由镇库直售给居民
  // （consumer-market.js generalStoreOnly 只允许综合商店作为卖家），
  // 因此本测试改为经由"商业街 + 综合商店 + 店员"这条现行零售通道验证同样的三件事：
  // 原子守恒（盐总量与 qeq 不变）、盐单独消费、居民口粮保护线对购盐的限购。
  const state = legacyVoucherState({ seed: 4402 });
  const street = addBuilding(state, "commercial_street", "salt-street");
  const owner = householdList(state).find(household => householdIdleWorkers(household) > 0);
  assert.ok(owner, "需要一个有空闲劳动力的商户家庭");
  assert.equal(grantResidentVouchers(state, 20000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  // 660 户（3300 人）每户需求很小，综合商店客流上限 = 人手 × 20：要卖满 10 斤需约 200 客，故雇 12 名店员。
  assert.equal(setJobCount(state, `shop:${opened.shopId}:clerk`, 12, CONTENT,
    { type: "shop", id: opened.shopId }).ok, true);
  const shop = state.shops[opened.shopId];
  shop.inventory.salt = 10 * SCALE;
  shop.inventoryCostVoucherUnits.salt = 10 * SCALE * CONTENT.items.salt.openingCostWheatPerJin;

  grantResidentVouchers(state, 500000, CONTENT);
  const saltBefore = totalResidentAndTownSalt(state);
  const qeqBefore = simulation.totalQeq(state);
  const demandUnits = accrueSaltNeed(state, 1000, CONTENT);
  const trade = buySaltForResidents(state, CONTENT);
  assert.ok(demandUnits > 0);
  assert.equal(trade.purchasedUnits, 10 * SCALE);
  assert.equal(shop.inventory.salt, 0, "综合商店库存按成交量原子扣减");
  assert.equal(simulation.totalQeq(state), qeqBefore);
  const meal = consumeDailySalt(state, CONTENT);
  // 赶集：买到的人家一次买够 5 天，当天只用掉 1 天的量，其余留在家里。
  assert.ok(meal.satisfiedUnits > 0 && meal.satisfiedUnits <= 10 * SCALE);
  assert.equal(totalResidentAndTownSalt(state), saltBefore + 10 * SCALE - meal.satisfiedUnits, "居民与镇库的盐 = 原有 + 从商店买入 − 当天用掉");
  assert.equal(simulation.totalQeq(state), qeqBefore);

  // 居民只留略高于 30 日口粮保护线的可换券小麦：盐虽有货、也买得起一部分，
  // 但成交量必须被"保护线 + 今日就业换券额度"压住，不得击穿保护线。
  const reserveState = legacyVoucherState({ seed: 4402 });
  const reserveStreet = addBuilding(reserveState, "commercial_street", "salt-reserve-street");
  const reserveOwner = householdList(reserveState).find(household => householdIdleWorkers(household) > 0);
  assert.equal(grantResidentVouchers(reserveState, 20000, CONTENT, reserveOwner.id).ok, true);
  const reserveOpened = simulation.openResidentShop(reserveState, reserveStreet.id, "general", reserveOwner.id);
  assert.equal(reserveOpened.ok, true, reserveOpened.reason);
  assert.equal(setJobCount(reserveState, `shop:${reserveOpened.shopId}:clerk`, 5, CONTENT,
    { type: "shop", id: reserveOpened.shopId }).ok, true);
  const reserveShop = reserveState.shops[reserveOpened.shopId];
  reserveShop.inventory.salt = 10000 * SCALE;
  reserveShop.inventoryCostVoucherUnits.salt = 10000 * SCALE * CONTENT.items.salt.openingCostWheatPerJin;
  const protectedWheatJin = 60010;
  setResidentInventoryJin(reserveState, "wheat", protectedWheatJin, CONTENT);
  const reserveDemand = accrueSaltNeed(reserveState, 1000, CONTENT);
  const limited = buySaltForResidents(reserveState, CONTENT);
  assert.ok(limited.purchasedUnits > 0, "居民仍会按可换券额度买到一部分盐");
  assert.ok(limited.purchasedUnits < reserveDemand, "成交量被换券额度/保护线限制，远低于当日需求");
  // 基线清理：0.2.3 起盐经综合商店零售，成交价是"批发进价 ×(1+目标利润率)"，
  // 不再是镇库直售的 priceWheatPerJin，故按商店挂牌零售价核对付款额。
  const retailPrice = shopTradePrices(reserveState, "general", CONTENT, "salt", reserveShop).retailVoucherPerUnit;
  assert.equal(limited.paidVoucherUnits,
    Math.round(limited.purchasedUnits / SCALE * retailPrice * CONTENT.precision.currencyUnitsPerVoucher),
    "家庭级限购仍按实际成交量付款");
  assert.ok(simulation.accountQeq(reserveState, "residents") >= 60000, "家庭换券不得突破全镇30日口粮保护线");
  assert.match(limited.limitReason, /保护线|预算|储备|换券额度|粮券/);
});

test("公租房只在开工时扣木材；按真实入住计租并保护口粮储备", () => {
  const state = legacyVoucherState({ seed: 812 });
  state.cohorts[0].m += 10;
  state.cohorts[0].f += 10;
  householdList(state)[0].ageBands.children += 20;
  syncResidentAggregates(state, CONTENT);
  assert.equal(simulation.validateState(state).valid, true);
  setStock(state, "town", "wood", 2000);
  const woodBefore = totalItem(state, "wood");
  const start = simulation.buildAt(state, "public_housing", "east");
  assert.equal(start.ok, true);
  assert.equal(totalItem(state, "wood"), woodBefore - 2000 * SCALE);
  assert.equal(state.ledger.filter(row => row.type === "construction_material").length, 1);
  assert.match(simulation.buildAt(state, "public_housing", "village-01").reason, /木材不足/);
  simulation.advanceDays(state, 100);
  assert.equal(state.project, null);
  assert.equal(state.buildings[0].typeId, "public_housing");
  assert.equal(totalItem(state, "wood"), woodBefore - 2000 * SCALE);
  let housing = selectHousing(state, CONTENT);
  assert.equal(housing.capacity, 2000);
  assert.equal(housing.villageOccupied, 1000);
  // 人口 1100→3300（8cf03ae）：无房户远超公租房容量，入住直接顶满 1000（原先只有 120 人无房）。
  assert.equal(housing.rentals[0].occupied, 1000);
  assert.equal(housing.rentals[0].dailyRentDueWheatJin, 1000);

  const wheatBeforeRentDay = totalItem(state, "wheat") + state.currency.reserveWheatUnits;
  simulation.advanceDay(state);
  assert.equal(state.fiscal.lastRentDay.dueWheatJin, 1000, "聚合家庭中的1000名真实公租房入住者应计租");
  assert.equal(state.fiscal.lastRentDay.collectedWheatJin, 0);
  assert.equal(state.fiscal.lastRentDay.waivedWheatJin, 1000);
  // 当日全镇口粮 3300人×2斤=6600斤，加上 40 斤其他支出，共 6640 斤。
  assert.equal(totalItem(state, "wheat") + state.currency.reserveWheatUnits, wheatBeforeRentDay - 6600 * SCALE - 120000);

  assert.equal(state.currency.balances.town, 0, "被口粮保护线减免的租金不会凭空形成镇库粮券");
  setStock(state, "residents", "wheat", 61200);
  const arrearsBeforeProtectedRent = Object.values(state.payroll.arrearsWheatUnits).reduce((sum, value) => sum + value, 0);
  simulation.advanceDay(state);
  assert.equal(state.fiscal.lastRentDay.dueWheatJin, 1000);
  assert.equal(state.fiscal.lastRentDay.collectedWheatJin, 0);
  assert.equal(state.fiscal.lastRentDay.waivedWheatJin, 1000);
  assert.equal(Object.values(state.payroll.arrearsWheatUnits).reduce((sum, value) => sum + value, 0), arrearsBeforeProtectedRent);
  assert.equal(state.ledger.some(row => row.type === "rent_waiver"), true);
});

test("v3旧存档不再自动迁移", () => {
  const state = simulation.createInitialState();
  state.version = 3;
  state.schemaVersion = 3;
  assert.throws(() => migrateSave(state, CONTENT), /旧版存档不兼容/);
});
