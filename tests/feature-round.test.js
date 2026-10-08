import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { createSimulation, simulation } from "../src/engine.js";
import {
  addInventory, atomicItemExchange, changeInventory, qeqJinToUnits, totalQeqUnits, transferFoodQeq, transferItem
} from "../src/economy/inventory.js";
import { breadDemandShare, buyBreadForResidents } from "../src/systems/market.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { populationStats, selectJobRows } from "../src/selectors/labor.js";
import { openShop } from "../src/systems/shops.js";
import { householdIdleWorkers, householdList, setJobCount } from "../src/systems/households.js";
import { grantResidentVouchers, setResidentInventoryJin } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const SCALE = CONTENT.precision.inventoryUnitsPerJin;
function totalItemUnits(state, itemId) {
  return (state.accounts.residents[itemId] || 0) + (state.accounts.town[itemId] || 0);
}
function rows(state, type) { return state.ledger.filter(row => row.type === type); }

// 基线清理：0.1.10-r08 起面粉/面包/盐只经综合商店零售，
// 综合商店又必须先有商业街、店员和铺货，这里给出可复用的零售夹具。
function addTestBuilding(state, typeId, id, level = 1) {
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

function openBreadShopFixture({ grantResidentVouchers: grantVouchers = 5000 } = {}) {
  const state = legacyVoucherState();
  addTestBuilding(state, "wholesale_market", "bread-test-market");
  const street = addTestBuilding(state, "commercial_street", "bread-test-street", 2);
  const owner = householdList(state).find(household => householdIdleWorkers(household) > 0);
  assert.ok(owner, "需要一个有空闲劳动力的商户家庭");
  assert.equal(grantResidentVouchers(state, 20000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(setJobCount(state, `shop:${opened.shopId}:clerk`, 20, CONTENT,
    { type: "shop", id: opened.shopId }).ok, true);
  const shop = state.shops[opened.shopId];
  // 人口 1100→3300（8cf03ae）后单日面包需求升到约 1584 斤，铺货须高于该量才不会被供给卡住。
  shop.inventory.bread = 3000 * SCALE;
  shop.inventoryCostVoucherUnits.bread = 3000 * SCALE * (5 / 6);
  if (grantVouchers > 0) assert.equal(grantResidentVouchers(state, grantVouchers, CONTENT).ok, true);
  return { state, shop };
}
test("expanded map permits separate same-type buildings and job rosters", () => {
  const game = simulation;
  const state = game.createInitialState();
  // 地图扩容后：48 个普通地块 + 2 个资源点 + 4 个河岸地块。
  assert.equal(state.plots.length, 54);
  assert.equal(new Set(state.plots.map(plot => plot.id)).size, 54);
  assert.equal(new Set(state.plots.map(plot => plot.x + "," + plot.y)).size, 54);
  // At a 300px-wide mobile map, plot targets and building icons still do not cover neighbors.
  for (let i = 0; i < state.plots.length; i += 1) {
    for (let j = i + 1; j < state.plots.length; j += 1) {
      const a = state.plots[i];
      const b = state.plots[j];
      const dx = Math.abs(a.x - b.x) * 3;
      const dy = Math.abs(a.y - b.y) * 2.56;
      assert.ok(dx >= 34 || dy >= 32, `地图点击区重叠：${a.id}/${b.id}`);
    }
  }
  const landmarks = [[18, 28], [82, 23], [66, 37], [57, 50]];
  for (const plot of state.plots) {
    for (const [x, y] of landmarks) {
      const dx = Math.abs(plot.x - x) * 3;
      const dy = Math.abs(plot.y - y) * 2.56;
      assert.ok(dx >= 32.5 || dy >= 32, `地图地标与空地点击区重叠：${plot.id}`);
    }
  }
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  const first = game.buildAt(state, "mill", "east");
  assert.equal(first.ok, true);
  assert.equal(game.buildAt(state, "mill", "east").ok, false);
  game.advanceDays(state, 40);
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  const second = game.buildAt(state, "mill", "village-01");
  assert.equal(second.ok, true);
  game.advanceDays(state, 40);
  assert.equal(state.buildings.filter(row => row.typeId === "mill").length, 2);
  assert.equal(state.buildings[0].plotId, "east");
  assert.equal(state.buildings[1].plotId, "village-01");
  assert.equal(game.setEmployment(state, first.instanceId + "::millers", 3).assigned, 3);
  assert.equal(game.setEmployment(state, second.instanceId + "::millers", 5).assigned, 5);
  const jobs = game.selectJobRows(state).rows.filter(row => row.roleId === "millers");
  assert.deepEqual(jobs.map(row => row.count), [3, 5]);
  assert.equal(game.validateState(state).valid, true);
});

test("wage arrears keep their old amount and pay separately from current wages", () => {
  const state = legacyVoucherState();
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  const start = simulation.buildAt(state, "mill", "east");
  changeInventory(state, "town", "wheat", -state.accounts.town.wheat, "empty treasury", "test_adjustment", CONTENT);
  simulation.advanceDay(state);
  const first = state.payroll.lastDay;
  // 默认日薪 10→5 斤（8cf03ae）：12 名建筑工当日应付 120→60 斤。
  assert.equal(first.expectedWheatJin, 60);
  assert.equal(first.currentPaidWheatJin, 0);
  assert.equal(first.unpaidCurrentWheatJin, 60);
  assert.equal(state.payroll.arrearsWheatUnits["builders::" + start.instanceId], 60 * SCALE);
  simulation.setWageRate(state, "builders", 20);
  transferItem(state, "residents", "town", "wheat", 360, "补充镇库小麦", CONTENT);
  assert.equal(simulation.issueGrainVouchers(state, "town", 360).ok, true);
  simulation.advanceDay(state);
  const second = state.payroll.lastDay;
  assert.equal(second.expectedWheatJin, 240);
  assert.equal(second.arrearsPaidWheatJin, 60);
  assert.equal(second.currentPaidWheatJin, 240);
  assert.equal(second.arrearsBalanceWheatJin, 0);
  assert.equal(state.payroll.totals.paidWheatUnits / SCALE, 300);
  assert.equal(state.business.cumulative.constructionWagesWheatUnits / SCALE, 300);
  assert.equal(totalQeqUnits(state, CONTENT), 53762400000); // 初始库存 73万→300万/账户
});

test("unemployment benefit is limited to idle workers, can be disabled, and creates no debt", () => {
  const state = legacyVoucherState();
  assert.equal(state.policy.unemploymentBenefit.enabled, false);
  simulation.setUnemploymentPolicy(state, { enabled: true, dailyPerWorkerJin: 1 });
  changeInventory(state, "town", "wheat", -state.accounts.town.wheat, "empty treasury", "test_adjustment", CONTENT);
  addInventory(state, "town", "wheat", 50, "test fund", "test_adjustment", CONTENT);
  assert.equal(simulation.issueGrainVouchers(state, "town", 50).ok, true);
  simulation.advanceDay(state);
  // 人口 1100→3300（8cf03ae）：合格失业劳动力 200→250，镇库 50 斤只够 50 人，缺口 200 斤。
  assert.equal(state.policy.lastDay.eligible, 250);
  assert.equal(state.policy.lastDay.paidPeople, 50);
  assert.equal(state.policy.lastDay.paidWheatJin, 50);
  assert.equal(state.policy.lastDay.shortWheatJin, 200);
  assert.equal(rows(state, "unemployment_benefit").reduce((sum, row) => sum + row.quantityUnits, 0) / CONTENT.precision.currencyUnitsPerVoucher, 50);
  assert.equal(rows(state, "unemployment_shortfall")[0].quantityUnits / CONTENT.precision.currencyUnitsPerVoucher, 200);
  assert.deepEqual(state.payroll.arrearsWheatUnits, {});
  assert.equal(simulation.setUnemploymentPolicy(state, { dailyPerWorkerJin: 0 }).dailyPerWorkerJin, 0);

  const funded = legacyVoucherState();
  simulation.setUnemploymentPolicy(funded, { enabled: true, dailyPerWorkerJin: 1 });
  assert.equal(simulation.issueGrainVouchers(funded, "town", 100000).ok, true);
  simulation.advanceDays(funded, 365);
  // 合格人数扩大后年度失业金同步放大（250 人 × 365 天）。
  assert.equal(funded.annualReports[0].payroll.unemploymentPaidVoucherUnits / CONTENT.precision.currencyUnitsPerVoucher, 91250);
});

test("bread barter is atomic, price sensitive, uses existing stock and protects thirty days", () => {
  // 基线清理（A+C）：
  // A) `buyBreadForResidents` 已是 `buyStaplesForResidents` 的兼容壳，
  //    面包份额改读固定规则 `rules.stapleDemandShares.bread`（0.2），
  //    不再是按当前价算出的 `breadDemandShare`（该函数仍在，单独断言）。
  // C) 0.1.10-r08 起面包只经综合商店零售（consumer-market.js generalStoreOnly），
  //    原 fixture 直接把面包塞进镇库，居民永远买不到（"市场没有可售库存"）；
  //    这里改为铺设"批发市场 + 商业街 + 综合商店 + 店员 + 铺货"。
  const { state: barterState, shop: barterShop } = openBreadShopFixture();
  // 面包总量在"综合商店 → 居民"之间守恒（totalItemUnits 只统计镇库+居民，
  // 故把商店库存也计入基准）。
  const breadBefore = totalItemUnits(barterState, "bread") + (barterShop.inventory.bread || 0);
  const voucherBefore = totalQeqUnits(barterState, CONTENT);
  const satisfaction = barterState.satisfaction;
  const traded = buyBreadForResidents(barterState, 1000, CONTENT);
  // 面包比例随家庭宽裕度变化（household-budget），这里只验证买到了面包。
  assert.ok(traded.targetShare > 0 && traded.targetBreadQeqJin > 0);
  assert.ok(traded.purchasedBreadJin > 0, `应买到面包，实际${traded.purchasedBreadJin}`);
  assert.equal(barterState.satisfaction, satisfaction);
  assert.equal(totalItemUnits(barterState, "bread") + (barterShop.inventory.bread || 0), breadBefore,
    "买面包只是把面包从商店搬到居民，总量不变");
  assert.equal(totalQeqUnits(barterState, CONTENT), voucherBefore);
  const meal = simulation.advanceDay(barterState).meal;
  // 人口 1100→3300（8cf03ae）：全镇口粮消耗 2200→6600 斤（逐户取整有微小误差）。
  assert.ok(Math.abs(meal.consumedQeqUnits / CONTENT.precision.qeqUnitsPerJin - 6600) < 1,
    `口粮消耗应接近6600，实际${meal.consumedQeqUnits / CONTENT.precision.qeqUnitsPerJin}`);
  // 面包份额随宽裕度变化，这里只验证吃到了面包、且不超过买到的量加原有库存。
  const breadMove = meal.moves.find(row => row.itemId === "bread").quantityUnits / SCALE;
  assert.ok(breadMove > 0, `应吃到面包，实际${breadMove}`);

  // 居民已有面包时，按"净需求"少买。
  const { state: existing } = openBreadShopFixture();
  setResidentInventoryJin(existing, "bread", 300, CONTENT);
  assert.ok(buyBreadForResidents(existing, 1000, CONTENT).purchasedBreadJin < traded.purchasedBreadJin);

  // 没有粮券、存粮也不够吃到秋收的人家没有家底（household-budget），口粮吃自家小麦，几乎不买面包。
  const { state: reserve } = openBreadShopFixture({ grantResidentVouchers: 0 });
  setResidentInventoryJin(reserve, "wheat", 60010, CONTENT);
  const limited = buyBreadForResidents(reserve, 1000, CONTENT);
  assert.ok(limited.purchasedBreadJin < 600, `穷户几乎不买面包，实际${limited.purchasedBreadJin}`);

  assert.ok(breadDemandShare(4, CONTENT) < breadDemandShare(2, CONTENT));
  assert.ok(breadDemandShare(1, CONTENT) > breadDemandShare(2, CONTENT));
  assert.ok(breadDemandShare(0.01, CONTENT) <= 0.5);
  assert.equal(simulation.setBreadPrice(reserve, 0).ok, false);

  // 原子交换：任一腿不足则整笔回滚，账户保持原样。
  const beforeAtomic = JSON.stringify(reserve.accounts);
  const atomic = atomicItemExchange(reserve, [
    { from: "residents", to: "town", itemId: "wheat", quantityUnits: 999999999999 },
    { from: "town", to: "residents", itemId: "bread", quantityUnits: SCALE }
  ], "failing exchange", CONTENT);
  assert.equal(atomic.ok, false);
  assert.equal(JSON.stringify(reserve.accounts), beforeAtomic);
});

test("mill to bakery accounting counts sold stock once and keeps unsold cost in inventory", () => {
  // 基线清理（C：原 fixture 不可构造）：
  // 1) 0.1.10-r08 起镇营生产的原料必须经过批发市场（production.js →
  //    procureTownInputFromWholesale，没有市场就 no_materials），原 fixture 只建磨坊+面包店，
  //    磨坊永远不产粉，故 day.producedUnits.flour 为 undefined → NaN。这里补建批发市场。
  // 2) 同一时期面粉/面包/盐只经综合商店零售（consumer-market.js generalStoreOnly），
  //    镇库的面包不可能卖给居民，soldBreadUnits/revenueWheatUnits/breadCogsWheatUnits
  //    按设计恒为 0（tradeAccounting 已无调用方），故删去这部分"镇营直销"断言，
  //    改为核对产成品无偿调拨入市后的库存与成本基础。
  const state = legacyVoucherState();
  assert.equal(simulation.issueGrainVouchers(state, "town", 20000).ok, true);
  addInventory(state, "town", "wood", 1200, "test market stock", "test", CONTENT);
  const market = simulation.buildAt(state, "wholesale_market", "village-01");
  assert.equal(market.ok, true, market.reason);
  // 本测试测生产核算，关闭每日小麦补贴以隔离变量
  state.policy ||= {};
  state.policy.wholesaleDailyWheatJin = 0;
  simulation.advanceDays(state, 60);
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  const mill = simulation.buildAt(state, "mill", "east");
  simulation.advanceDays(state, 40);
  addInventory(state, "town", "wood", 500, "test stock", "test", CONTENT);
  const bakery = simulation.buildAt(state, "bakery", "south");
  simulation.advanceDays(state, 40);
  simulation.setEmployment(state, mill.instanceId + "::millers", 1);
  simulation.setEmployment(state, bakery.instanceId + "::bakers", 1);
  // 面粉由统购统销从镇库小麦磨出后进市场；这里先垫 60 斤面粉，让面包房当日有料。
  state.wholesaleMarket.inventory.flour = 60 * SCALE;
  state.wholesaleMarket.inventoryCostVoucherUnits.flour = 60 * SCALE;
  assert.equal(grantResidentVouchers(state, 5000, CONTENT).ok, true);
  const before = simulation.totalQeq(state);
  simulation.advanceDay(state);
  const day = state.business.day;
  assert.equal(day.producedUnits.flour / SCALE, 64);
  // 生产先上游后下游：面包房除了垫的 60 斤，还能用磨坊当天磨的面粉，按 1 名面包师的产能出 96 斤。
  assert.equal(day.producedUnits.bread / SCALE, 96);
  assert.equal(day.rawInputCostWheatUnits / SCALE, 80);
  assert.equal(day.processingLossWheatUnits / SCALE, 16);
  // 默认日薪 10→5 斤（8cf03ae）：磨坊工 + 面包师各 1 人，合计 10 斤。
  assert.equal(day.operatingWagesWheatUnits / SCALE, 10);
  // 0.2.3 镇营统购统销：产成品无偿调拨进批发市场，成本基础随货转移，镇库不再留存。
  assert.equal(state.accounts.town.flour, 0);
  assert.equal(state.accounts.town.bread, 0);
  assert.ok(state.wholesaleMarket.inventory.flour > 0, "面粉产出应留在批发市场");
  assert.ok(state.wholesaleMarket.monopoly.allocatedInValueUnits > 0, "统购统销应记录调拨入库价值");
  assert.ok(state.wholesaleMarket.monopoly.allocatedInputValueUnits > 0, "原料无偿调拨应记录转移成本");
  const view = simulation.selectDashboard(state);
  const millView = view.buildings.find(row => row.id === mill.instanceId);
  const bakeryView = view.buildings.find(row => row.id === bakery.instanceId);
  assert.equal(millView.jobs[0].workers, 1);
  assert.equal(bakeryView.jobs[0].workers, 1);
  assert.equal(millView.jobs[0].outputToday.flour / SCALE, 64);
  const millPay = view.payroll.lastDay.workers.find(row => row.buildingId === mill.instanceId);
  const bakeryPay = view.payroll.lastDay.workers.find(row => row.buildingId === bakery.instanceId);
  // 默认日薪 10→5 斤（8cf03ae）：每名工人实发 5 斤。
  assert.equal(millPay.currentPaidWheatJin, 5);
  assert.equal(bakeryPay.currentPaidWheatJin, 5);
});

test("v2旧存档不再自动迁移", () => {
  const old = simulation.createInitialState();
  old.version = 2;
  old.schemaVersion = 2;
  assert.throws(() => migrateSave(old, CONTENT), /旧版存档不兼容/);
});
test("fifteen-year headless run keeps age, job and inventory ledgers consistent", () => {
  const state = simulation.createInitialState({ seed: 884422 });
  simulation.advanceDays(state, 365 * 15);
  assert.equal(state.annualReports.length, 15);
  assert.equal(state.year, 16);
  assert.equal(state.day, 0);
  assert.equal(state.agriculture.lastHarvestYear, 15);
  const people = populationStats(state);
  const jobs = selectJobRows(state, CONTENT);
  assert.equal(people.total, people.children + people.workers + people.elders);
  assert.equal(jobs.employed + jobs.idle, people.workers);
  for (const owner of ["residents", "town"]) {
    for (const quantity of Object.values(state.accounts[owner])) assert.ok(Number.isSafeInteger(quantity) && quantity >= 0);
  }
  assert.equal(simulation.validateState(state).valid, true);
});
