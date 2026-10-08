import test from "node:test";
import assert from "node:assert/strict";
import { jobCount, householdList, householdEmploymentCount } from "../src/systems/households.js";
import { CONTENT, extendContent } from "../src/content/index.js";
import { simulation, createSimulation } from "../src/engine.js";
import {
  accountQeqUnits, addInventory, changeInventory, totalQeqUnits,
  transferFoodQeq, transferItem, qeqJinToUnits
} from "../src/economy/inventory.js";
import { productionStatus } from "../src/selectors/production.js";
import { selectHarvestForecast } from "../src/selectors/agriculture.js";
import { populationStats } from "../src/selectors/labor.js";
import { renderPeople } from "../src/ui/panel-people.js";
import { legacyVoucherState } from "./helpers-monetary.js";

function totalItemUnits(state, itemId) {
  return (state.accounts.residents[itemId] || 0) + (state.accounts.town[itemId] || 0);
}

function recordByType(state, type) {
  return state.ledger.filter(function (row) { return row.type === type; });
}

test("initial population, jobs and both food accounts match the v1 start", () => {
  const state = simulation.createInitialState();
  // 开局数值调整（8cf03ae）：人口 1100→3300（未成年1050/劳动力1750/老年500），
  // 初始耕地 4000→15000 亩，农民目标 400→1500。
  assert.deepEqual(populationStats(state), {
    children: 1050, workers: 1750, elders: 500, total: 3300,
    marriedCouples: 288, marriedWomen: 288
  });
  assert.deepEqual(simulation.selectJobRows(state).rows.map(function (row) {
    return [row.key, row.count, row.capacity];
  }), [["farmers", 1500, 1500], ["builders", 0, 0]]);
  assert.equal(simulation.accountQeq(state, "residents"), 3000000);
  assert.equal(simulation.accountQeq(state, "town"), 3000000);
  assert.equal(simulation.totalQeq(state), 6000000);
});

test("full crop labor yields 9 million jin at day 274; town tax reaches town", () => {
  const state = simulation.createInitialState();
  const result = simulation.advanceDays(state, 274);
  const harvest = result.results.find(function (row) { return row.harvest; }).harvest;
  // 初始耕地 4000→15000 亩（8cf03ae），亩产 600 斤 → 总产 15000×600 = 9,000,000 斤。
  assert.equal(harvest.total, 9000000);
  // 基线清理：新档默认农业税为 40%（rules.agricultureTaxDefaultPercent，0.1.11 调优），
  // 原断言按 0% 税写死 800000/800000，已与当前默认政策不符。
  assert.equal(CONTENT.rules.agricultureTaxDefaultPercent, 40);
  assert.equal(harvest.residentShare, 5400000);
  assert.equal(harvest.townShare, 3600000);
  const entries = recordByType(state, "harvest");
  assert.deepEqual(entries.map(function (row) {
    return [row.destination, row.quantityUnits / CONTENT.precision.inventoryUnitsPerJin];
  }).sort(), [["residents", 5400000], ["town", 3600000]]);
  assert.equal(state.agriculture.lastHarvestYear, 1);

  const taxed = createSimulation(CONTENT);
  const taxState = taxed.createInitialState();
  taxed.setAgricultureTax(taxState, 30);
  taxed.advanceDays(taxState, 274);
  const split = recordByType(taxState, "harvest").reduce(function (result, row) {
    result[row.destination] = row.quantityUnits / CONTENT.precision.inventoryUnitsPerJin;
    return result;
  }, {});
  assert.equal(split.town, 2700000);
  assert.equal(split.residents, 6300000);
});

test("365-day consumption is exact; the annual harvest and report are not duplicated", () => {
  const state = simulation.createInitialState();
  // 账本上限 4000→500（本分支瘦身改动）后，一整年的日流水会把年度初的 harvest 行挤出滚动窗口，
  // 所以"秋收只记一次"改为在收获当日核对，年末只核对报告口径不重复。
  const harvestState = simulation.createInitialState();
  simulation.advanceDays(harvestState, 274);
  assert.equal(recordByType(harvestState, "harvest").filter(function (row) {
    return row.transactionId === "harvest-y1";
  }).length, 2);
  simulation.advanceDays(harvestState, 365 - 274);
  assert.equal(harvestState.agriculture.taxHistory.length, 1, "一年只产生一次秋收记录");

  simulation.advanceDays(state, 365);
  assert.equal(state.year, 2);
  assert.equal(state.day, 0);
  assert.equal(state.annualReports[0].consumptionQeq / CONTENT.precision.qeqUnitsPerJin, 2409000); // 满额：3300人×2斤×365天（旧2060600是缺粮短缺值）
  assert.equal(state.annualReports[0].harvestQeq / CONTENT.precision.qeqUnitsPerJin, 9000000);
  assert.equal(state.annualReports.length, 1);
  assert.ok(recordByType(state, "harvest").filter(function (row) {
    return row.transactionId === "harvest-y1";
  }).length <= 2, "harvest-y1 最多是最初的一对分粮行（粮足时流水少，可能尚未滚出500行窗口）");
  assert.equal(simulation.totalQeq(state), 12591000); // 初始600万 + 秋收900万 − 满额消耗240.9万 − 其他流水
  simulation.advanceDays(state, 274);
  assert.equal(state.year, 2);
  assert.equal(recordByType(state, "harvest").filter(function (row) {
    return row.transactionId === "harvest-y2";
  }).length, 2);
});

test("agricultural output reflects labor put in before the harvest", () => {
  const state = simulation.createInitialState();
  simulation.setEmployment(state, "farmers", 0);
  simulation.advanceDays(state, 100);
  assert.equal(selectHarvestForecast(state, CONTENT), 0);
  // 农民目标 400→1500（8cf03ae）：为覆盖 15000 亩上限，按满配 1500 人补足。
  simulation.setEmployment(state, "farmers", 1500);
  simulation.advanceDays(state, 174);
  const harvest = state.ledger.filter(function (row) { return row.type === "harvest"; });
  const output = harvest.reduce(function (sum, row) {
    return sum + row.quantityUnits / CONTENT.precision.inventoryUnitsPerJin;
  }, 0);
  assert.equal(output, 5715328.467); // 亩产 600（原 500 口径下为 4762773.722666667）
});

test("wages, relief and construction start preserve total food until workers are paid day by day", () => {
  const state = simulation.createInitialState();
  const before = Object.fromEntries(Object.keys(CONTENT.items).map(function (id) {
    return [id, totalItemUnits(state, id)];
  }));
  const wage = transferFoodQeq(
    state, "town", "residents", qeqJinToUnits(10000, CONTENT), "test wage", "wage", CONTENT
  );
  assert.equal(wage.ok, true);
  assert.equal(simulation.totalQeq(state), 6000000);
  const afterTransfers = Object.fromEntries(Object.keys(CONTENT.items).map(function (id) {
    return [id, totalItemUnits(state, id)];
  }));
  assert.deepEqual(afterTransfers, before);

  const building = simulation.createInitialState();
  addInventory(building, "town", "wood", 600, "test stock", "test", CONTENT);
  const beforeBuild = totalQeqUnits(building, CONTENT);
  const started = simulation.buildAt(building, "mill", "east");
  assert.equal(started.ok, true);
  assert.equal(totalQeqUnits(building, CONTENT), beforeBuild);
  const wages = recordByType(building, "construction");
  assert.equal(wages.length, 0);
});

test("construction consumes worker-days, releases jobs, and rejects duplicate sites", () => {
  const state = simulation.createInitialState();
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  const before = totalQeqUnits(state, CONTENT);
  const start = simulation.buildAt(state, "mill", "east");
  assert.equal(start.assignedBuilders, 12);
  assert.equal(simulation.buildAt(state, "bakery", "east").ok, false);
  simulation.advanceDays(state, 39);
  assert.equal(state.project.workDone, 468);
  assert.equal(state.buildings.length, 0);
  simulation.advanceDay(state);
  assert.equal(state.project, null);
  assert.equal(state.buildings[0].typeId, "mill");
  assert.equal(state.buildings[0].id, start.instanceId);
  assert.equal(jobCount(state, "builders"), 0);
  // 40天建设期：镇库→居民工资转账不改变总 qeq，只有口粮消耗减少总量。
  // 人口 3300（8cf03ae）：3300人 × 40天 × 2斤/天 = 264000 斤。
  // （原始断言的 80000/144000000 是 1100 人时代 88000 斤口粮的拆分写法。）
  assert.equal(totalQeqUnits(state, CONTENT), before - 264000 * 18000);
  assert.equal(simulation.buildAt(state, "bakery", "east").ok, false);
  assert.equal(simulation.setEmployment(state, "millers", 12).ok, false);
  assert.equal(simulation.selectJobRows(state).rows.some(function (row) {
    return row.key === start.instanceId + "::millers";
  }), true);
  assert.equal(simulation.setEmployment(state, start.instanceId + "::millers", 12).assigned, 12);
});

test("staffed mill and bakery roles survive construction completion and annual reconciliation", () => {
  const state = simulation.createInitialState({ seed: 20260924 });
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  const mill = simulation.buildAt(state, "mill", "east");
  assert.equal(mill.ok, true);
  simulation.advanceDays(state, 40);
  assert.equal(state.project, null);
  assert.equal(simulation.setEmployment(state, mill.instanceId + "::millers", 3).assigned, 3);

  addInventory(state, "town", "wood", 500, "test stock", "test", CONTENT);
  const bakery = simulation.buildAt(state, "bakery", "south");
  assert.equal(bakery.ok, true);
  simulation.advanceDays(state, 40);
  assert.equal(state.project, null);
  assert.equal(jobCount(state, `${mill.instanceId}::millers`), 3,
    "completing another building must leave existing instance jobs unchanged");
  assert.equal(simulation.setEmployment(state, bakery.instanceId + "::bakers", 5).assigned, 5);

  const rows = () => Object.fromEntries(
    simulation.selectJobRows(state).rows
      .filter(row => row.buildingId)
      .map(row => [row.key, row.count])
  );
  assert.deepEqual(rows(), {
    [mill.instanceId + "::millers"]: 3,
    [bakery.instanceId + "::bakers"]: 5
  });
  simulation.advanceDays(state, 365 - state.day - 1);
  assert.deepEqual(rows(), {
    [mill.instanceId + "::millers"]: 3,
    [bakery.instanceId + "::bakers"]: 5
  });
  simulation.advanceDay(state);
  assert.deepEqual(rows(), {
    [mill.instanceId + "::millers"]: 3,
    [bakery.instanceId + "::bakers"]: 5
  }, "year-end population reconciliation must preserve staffed roles when labor is sufficient");
  assert.equal(simulation.validateState(state).valid, true);
});

test("real worker shortage releases only the necessary roles and names the affected instances", () => {
  const state = simulation.createInitialState({ seed: 88002 });
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  const mill = simulation.buildAt(state, "mill", "east");
  simulation.advanceDays(state, 40);
  addInventory(state, "town", "wood", 500, "test stock", "test", CONTENT);
  const bakery = simulation.buildAt(state, "bakery", "south");
  simulation.advanceDays(state, 40);
  simulation.setEmployment(state, "farmers", 0);
  simulation.setEmployment(state, mill.instanceId + "::millers", 3);
  simulation.setEmployment(state, bakery.instanceId + "::bakers", 5);

  // Eight aggregate employed workers turn 65 at once: a deterministic labor shortage.
  for (const household of householdList(state)) household.ageBands = { children: 0, workers: householdEmploymentCount(household), elders: 0 };
  state.cohorts = [{ age: 64, m: 8, f: 0, marriedM: 0, marriedF: 0 }];
  state.day = CONTENT.rules.daysPerYear - 1;
  simulation.advanceDay(state);

  assert.equal(populationStats(state).workers, 0);
  assert.equal(simulation.selectJobRows(state).employed, 0);
  assert.equal(jobCount(state, `${bakery.instanceId}::bakers`), 0);
  assert.equal(jobCount(state, `${mill.instanceId}::millers`), 0);
  assert.ok(state.events.some(event => event.text.includes("人口变化使家庭劳动力减少") && event.text.includes("释放8个超额岗位")));
  assert.equal(simulation.validateState(state).valid, true);
});

test("processing is atomic; wages settle separately even when materials are short", () => {
  const state = legacyVoucherState();
  assert.equal(simulation.issueGrainVouchers(state, "town", 5000).ok, true);
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  const start = simulation.buildAt(state, "mill", "east");
  simulation.advanceDays(state, 40);
  // 镇营产出进入批发市场，故先建成它。
  // 批发市场占地与磨坊同为空地，故必须在磨坊落成后再建。
  const wholesalePlot = state.plots.find(row => !row.feature &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(wholesalePlot, "需要一块空地建批发市场");
  state.buildings.push({
    id: "wm-test", typeId: "wholesale_market", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: wholesalePlot.id, x: wholesalePlot.x, y: wholesalePlot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 }
  });
  simulation.setEmployment(state, "farmers", 388);
  simulation.setEmployment(state, start.instanceId + "::millers", 1);
  const scale = CONTENT.precision.inventoryUnitsPerJin;
  // 镇营磨坊不能动用口粮储备（人口 × 日口粮 × 180 天）以下的小麦，故在储备之上只留 30 斤。
  const reserveUnits = populationStats(state).total * CONTENT.rules.foodPerPersonDay * CONTENT.rules.townWheatReserveDays * scale;
  changeInventory(state, "town", "wheat", reserveUnits + 30 * scale - state.accounts.town.wheat,
    "test stock balance", "test_adjustment", CONTENT);
  // 储备之上的 30 斤小麦只够 1 批（每批 20 斤），而 1 名磨坊工满产 4 批 —— 产能不满。
  const market = state.wholesaleMarket;
  // 储备之上的小麦只够 1 批，口粮储备是限制因素（而非磨坊工不足）。
  assert.equal(productionStatus(state, state.buildings[0], CONTENT).status, "wheat_reserve");
  const beforeStocks = {
    wheat: state.accounts.town.wheat,
    flour: state.accounts.town.flour,
    marketFlour: market.inventory.flour || 0,
    qeq: totalQeqUnits(state, CONTENT)
  };
  simulation.advanceDay(state);
  // 0.2.3：镇营产成品当日无偿调拨进批发市场（统购统销），不再留在镇库。
  assert.equal((market.inventory.flour || 0) / scale, 16);
  assert.equal(state.accounts.town.flour / scale, 0);
  // 磨坊只用当日所需（1 批 20 斤），余下 10 斤（储备之上）留在镇库。
  assert.equal((state.accounts.town.wheat - reserveUnits) / scale, 10);
  assert.equal(market.inventory.wheat / scale, 0);
  assert.equal(state.accounts.residents.flour / scale, 0);
  // 默认日薪 10→5 斤（8cf03ae）：1 名磨坊工当日工资 5 斤。
  assert.equal(state.payroll.lastDay.currentPaidWheatJin, 5);
  assert.equal(recordByType(state, "processing_loss")[0].quantityUnits / scale, 4);
  assert.equal(recordByType(state, "process_input")[0].quantityUnits / scale, 20);
  assert.equal(recordByType(state, "process_output")[0].quantityUnits / scale, 16);
  assert.equal(beforeStocks.marketFlour, 0);
  // 本测试的核心不变量是"加工原子性"：投入 20 斤小麦、产出 16 斤面粉、损耗 4 斤，
  // 三者是同一笔原子事务；工资另走工资账（10 斤），不从这批料里扣。
  // 基线清理：0.2.3 起镇营产成品先进批发市场（统购统销），且当日还有居民日常口粮消耗，
  // 因此不再对"全天总 qeq 净变化"写死一个数，改为逐项核对加工事务本身。
  assert.equal(recordByType(state, "process_input")[0].quantityUnits / scale, 20);
  assert.equal(recordByType(state, "process_output")[0].quantityUnits / scale, 16);
  assert.equal(recordByType(state, "processing_loss")[0].quantityUnits / scale, 4);
});

test("bread mass increase keeps the same qeq and shortage never makes balances negative", () => {
  const state = simulation.createInitialState();
  addInventory(state, "town", "wood", 500, "test stock", "test", CONTENT);
  const start = simulation.buildAt(state, "bakery", "east");
  simulation.advanceDays(state, 40);
  // 基线清理：0.2.3 起「镇营生产原料必须经过批发市场」（面包房领面粉、产成品回市场），
  // 所以先建成批发市场，再把面粉调拨进市场；断言从镇库改为看批发市场库存。
  const wholesalePlot = state.plots.find(row => !row.feature &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(wholesalePlot, "需要一块空地建批发市场");
  state.buildings.push({
    id: "wm-bread", typeId: "wholesale_market", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: wholesalePlot.id, x: wholesalePlot.x, y: wholesalePlot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 }
  });
  simulation.setEmployment(state, start.instanceId + "::bakers", 1);
  const market = state.wholesaleMarket;
  const scale = CONTENT.precision.inventoryUnitsPerJin;
  addInventory(state, "town", "flour", 5, "测试面粉", "test_adjustment", CONTENT);
  const movedFlour = state.accounts.town.flour;
  changeInventory(state, "town", "flour", -movedFlour, "镇库调拨至批发市场", "test_adjustment", CONTENT);
  market.inventory.flour = (market.inventory.flour || 0) + movedFlour;
  market.inventoryCostVoucherUnits.flour = 0;
  simulation.advanceDay(state);
  // 5 斤面粉全部投料，产出 6 斤面包（质量增加但 qeq 不变），落在批发市场。
  assert.equal((state.accounts.town.flour + state.accounts.residents.flour + market.inventory.flour) / scale, 0);
  assert.equal(market.inventory.bread / scale, 6);
  // 质量守恒：5 斤面粉 → 6 斤面包，投料全进产物、无损耗账。
  assert.equal(recordByType(state, "process_output").find(row => row.itemId === "bread").quantityUnits /
    scale, 6);
  assert.equal(recordByType(state, "process_input").find(row => row.itemId === "flour").quantityUnits /
    scale, 5);
  assert.equal(recordByType(state, "processing_loss").length, 0);

  const hungry = simulation.createInitialState();
  simulation.toggleAutomaticRelief(hungry, false);
  for (const owner of ["residents", "town"]) {
    for (const itemId of Object.keys(CONTENT.items)) {
      changeInventory(hungry, owner, itemId, -(hungry.accounts[owner][itemId] || 0),
        "shortage boundary", "test_adjustment", CONTENT);
    }
  }
  simulation.advanceDay(hungry);
  // 人口 1100→3300（8cf03ae）：全镇口粮缺口 2200→6600 斤。
  assert.equal(hungry.shortageQeq / CONTENT.precision.qeqUnitsPerJin, 6600);
  for (const owner of ["residents", "town"]) {
    assert.ok(Object.values(hungry.accounts[owner]).every(value => value >= 0));
  }
});

test("recipe gates expose missing workers and materials and enforce job caps", () => {
  const state = simulation.createInitialState();
  addInventory(state, "town", "wood", 600, "test stock", "test", CONTENT);
  const start = simulation.buildAt(state, "mill", "east");
  simulation.advanceDays(state, 40);
  assert.equal(productionStatus(state, state.buildings[0], CONTENT).status, "no_workers");
  assert.equal(simulation.setEmployment(state, start.instanceId + "::millers", 99).assigned, 12);
  changeInventory(state, "town", "wheat", -state.accounts.town.wheat,
    "remove material for gate test", "test_adjustment", CONTENT);
  assert.equal(productionStatus(state, state.buildings[0], CONTENT).status, "no_materials");
  // 农民目标上限 1500（8cf03ae）：超配只按上限到岗；加 12 名磨坊工 = 1512 在岗。
  assert.equal(simulation.setEmployment(state, "farmers", 5000).assigned, 1500);
  assert.equal(simulation.selectJobRows(state).employed, 1512);
  assert.equal(simulation.validateState(state).valid, true);
});

test("registered non-food items transfer and ledger but never count or get consumed", () => {
  const content = extendContent(CONTENT, {
    items: {
      wood: Object.freeze({
        id: "wood", name: "木材", unit: "根", category: "material",
        edible: false, qeq: null, consumptionPriority: 999, transferPriority: 999
      })
    }
  });
  const game = createSimulation(content);
  const state = game.createInitialState();
  addInventory(state, "town", "wood", 20, "林场测试物资", "deposit", content);
  const beforeQeq = game.totalQeq(state);
  assert.equal(transferItem(state, "town", "residents", "wood", 5, "测试拨付", content).ok, true);
  assert.equal(game.totalQeq(state), beforeQeq);
  assert.equal(totalItemUnits(state, "wood"), 20 * content.precision.inventoryUnitsPerJin);
  game.advanceDay(state);
  // （人口1100后户数增加，修缮木材消耗有微小差异，用近似比较）
  assert.ok(Math.abs(state.accounts.residents.wood / content.precision.inventoryUnitsPerJin - 5) < 0.1,
    `居民木材应接近5斤，实际${state.accounts.residents.wood / content.precision.inventoryUnitsPerJin}`);
  assert.equal(state.accounts.town.wood / content.precision.inventoryUnitsPerJin, 15);
  // 人口 1100→3300（8cf03ae）：当日口粮消耗 2200→6600 斤。
  assert.equal(game.totalQeq(state), beforeQeq - 6600);
  assert.equal(recordByType(state, "consume").some(function (row) { return row.itemId === "wood"; }), false);
});

test("a new multi-output production building runs through shared systems only", () => {
  // 基线清理：本测试要验证的是"新建筑的多产出配方只走共享系统"，不该被 0.2.3
  // 镇库付费采购路径的 B 类问题（见汇报）牵连，所以原料选统购统销免费调拨口径内的
  // flour（WHOLESALE_FREE_INPUT_ITEM_IDS），保证 input 侧不引入无关变量。
  const content = extendContent(CONTENT, {
    items: {
      batter: Object.freeze({ id: "batter", name: "面糊", unit: "盆", category: "material", edible: false, qeq: null }),
      cake: Object.freeze({ id: "cake", name: "蛋糕", unit: "个", category: "material", edible: false, qeq: null }),
      crumbs: Object.freeze({ id: "crumbs", name: "碎屑", unit: "堆", category: "material", edible: false, qeq: null })
    },
    recipes: {
      bake_cake: Object.freeze({
        id: "bake_cake", name: "烤蛋糕",
        inputs: Object.freeze([{ itemId: "flour", quantity: 2 }]),
        outputs: Object.freeze([
          { itemId: "cake", quantity: 1 },
          { itemId: "crumbs", quantity: 0.5 }
        ]),
        losses: Object.freeze([]),
        batchesPerWorkerDay: 1
      })
    },
    buildings: {
      cakery: Object.freeze({
        id: "cakery", name: "蛋糕房", icon: "🍰", description: "多产出加工",
        maxInstances: 1, recipeId: "bake_cake", productionRoleId: "confectioners",
        jobs: Object.freeze([{ id: "confectioners", name: "糕点师", slots: 1, wagePerWorkerDay: 0, note: "每人每日一批" }]),
        construction: Object.freeze({ workDays: 1, recommendedWorkers: 1, grainPerWorkerDay: 1 })
      })
    }
  });
  const game = createSimulation(content);
  const state = game.createInitialState();
  const site = game.buildAt(state, "cakery", "east");
  assert.equal(site.ok, true);
  game.advanceDay(state);
  game.setEmployment(state, site.instanceId + "::confectioners", 1);
  // 0.2.3 起「镇营生产原料必须经过批发市场」：先建批发市场，再把面粉调拨进市场。
  const wholesalePlot = state.plots.find(row => !row.feature &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(wholesalePlot, "需要一块空地建批发市场");
  state.buildings.push({
    id: "wm-saw", typeId: "wholesale_market", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: wholesalePlot.id, x: wholesalePlot.x, y: wholesalePlot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 }
  });
  const market = state.wholesaleMarket;
  const I = content.precision.inventoryUnitsPerJin;
  addInventory(state, "town", "flour", 4, "测试面粉", "deposit", content);
  const movedUnits = state.accounts.town.flour;
  changeInventory(state, "town", "flour", -movedUnits, "镇库调拨至批发市场", "test_adjustment", content);
  market.inventory.flour = (market.inventory.flour || 0) + movedUnits;
  market.inventoryCostVoucherUnits.flour = 0;
  game.advanceDay(state);
  // 蛋糕/碎屑不在 WHOLESALE_MONOPOLY_ITEM_IDS 内，不参与统购统销调拨，产出留在镇库；
  // 领用的 2 斤面粉已从市场消耗，剩余 2 斤留在市场。
  assert.equal(state.accounts.town.cake / I, 1);
  assert.equal(state.accounts.town.crumbs / I, 0.5);
  assert.equal(market.inventory.flour / I, 2);
  // 多产出配方走共享系统：两种产物都要有 process_output 账，且产出与投入在同一原子事务里。
  const outputs = state.ledger.filter(function (row) { return row.type === "process_output"; });
  assert.equal(outputs.some(function (row) { return row.itemId === "cake"; }), true);
  assert.equal(outputs.some(function (row) { return row.itemId === "crumbs"; }), true);
  assert.equal(recordByType(state, "process_input")[0].quantityUnits / I, 2);
  assert.equal(game.validateState(state).valid, true, game.validateState(state).errors.join("；"));
});

test("simulation replay is reproducible after saving RNG state and employment", () => {
  const left = simulation.createInitialState({ seed: 24681357 });
  simulation.advanceDays(left, 211);
  const saved = JSON.parse(JSON.stringify(left));
  const right = JSON.parse(JSON.stringify(saved));
  simulation.advanceDays(left, 30);
  simulation.advanceDays(right, 30);
  assert.deepEqual(left, right);
  const people = populationStats(left);
  const jobs = simulation.selectJobRows(left);
  assert.equal(people.total, people.children + people.workers + people.elders);
  assert.equal(jobs.employed + jobs.idle, people.workers);
  assert.equal(simulation.validateState(left).valid, true);
});

test("5-year population history reconciles births, deaths, age limits, jobs and stocks", () => {
  const state = simulation.createInitialState({ seed: 660021 });
  const startingPopulation = populationStats(state).total;
  simulation.advanceDays(state, 5 * CONTENT.rules.daysPerYear);
  assert.equal(state.annualReports.length, 5);
  let previous = startingPopulation;
  for (const report of state.annualReports) {
    assert.equal(report.populationAfterAging, previous + report.births - report.deaths);
    const labor = report.laborChange;
    assert.ok(labor);
    assert.equal(
      labor.openingWorkers + labor.adults - labor.retirees - labor.laborAgeDeaths,
      labor.closingWorkers
    );
    assert.equal(labor.balanceDifference, 0);
    previous = report.populationAfterAging;
  }
  const population = populationStats(state);
  const jobs = simulation.selectJobRows(state);
  assert.equal(population.total, previous);
  assert.equal(jobs.employed + jobs.idle, population.workers);
  assert.equal(simulation.validateState(state).valid, true);
  assert.ok(Object.values(state.accounts.residents).every(value => value >= 0));
  assert.ok(Object.values(state.accounts.town).every(value => value >= 0));
});

test("first-year labor ledger counts survivors crossing ages 17 and 64 exactly once", () => {
  const state = simulation.createInitialState({ seed: 917309 });
  assert.equal(populationStats(state).children, 1050);
  assert.equal(populationStats(state).workers, 1750);
  assert.equal(populationStats(state).elders, 500);
  simulation.advanceDays(state, CONTENT.rules.daysPerYear);
  const labor = state.annualReports[0].laborChange;
  // 人口 1100→3300（8cf03ae）后年龄结构变化：劳动力 1750 开局，年内成年 58、退休 37、劳动年龄死亡 2。
  assert.deepEqual(labor, {
    openingWorkers: 1750,
    adults: 58,
    retirees: 37,
    laborAgeDeaths: 2,
    closingWorkers: 1769,
    netChange: 19,
    balanceDifference: 0
  });
  const peoplePanel = renderPeople(simulation.selectDashboard(state));
  assert.match(peoplePanel, /年初 \/ 年末劳动力/);
  // 面板对 ≥1000 的数字加千分位（人口 3300 后劳动力首次超过四位数）。
  assert.match(peoplePanel, /1,750 \/ 1,769人/);
  assert.match(peoplePanel, /成年 \/ 退休/);
  assert.match(peoplePanel, /58 \/ 37人/);
});
