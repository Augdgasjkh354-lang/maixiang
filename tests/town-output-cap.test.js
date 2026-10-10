import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { householdList, householdIdleWorkers, setJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { processBuilding } from "../src/systems/production.js";
import { processPrivateBuilding } from "../src/systems/private-industry.js";
import { privateJobKeyForBuilding, populationStats } from "../src/selectors/labor.js";
import { productionStatus } from "../src/selectors/production.js";
import { ensureWholesaleMarket, resetWholesaleDay, runWholesaleIntake, snapshotWholesaleHistory,
  wholesaleAvgDemandUnits, recordTownInputConsumption } from "../src/systems/wholesale-market.js";

const I = CONTENT.precision.inventoryUnitsPerJin;

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

function staff(state, building, count) {
  const role = CONTENT.buildings[building.typeId].jobs.find(job => job.id === CONTENT.buildings[building.typeId].productionRoleId);
  const result = setJobCount(state, `${building.id}::${role.id}`, count, CONTENT, { type: "town", id: building.id });
  assert.equal(result.assigned, count);
}

// 把历史快照写进批发市场，模拟过去 N 天的售出与镇营领用（需求口径）。
function seedHistory(state, days, { itemId, soldJin = 0, townConsumedJin = 0 }) {
  const market = ensureWholesaleMarket(state, CONTENT);
  market.history = Array.from({ length: days }, (_, index) => ({
    year: 1, day: index + 1, inventory: {}, price: {},
    sold: { [itemId]: Math.round(soldJin * I) },
    townConsumed: { [itemId]: Math.round(townConsumedJin * I) }
  }));
}

test("镇营磨坊：市场面粉库存超过目标（无销量时为最低备货 200 斤）则停产，库存回落后恢复", () => {
  const state = legacyVoucherState({ seed: 91001 });
  addBuilding(state, "wholesale_market", "wm-a");
  const mill = addBuilding(state, "mill", "mill-a");
  staff(state, mill, 4);
  const market = ensureWholesaleMarket(state, CONTENT);

  market.inventory.flour = 5000 * I;
  const wheatBefore = state.accounts.town.wheat;
  const blocked = processBuilding(state, mill, CONTENT);
  assert.equal(blocked.batches, 0);
  assert.equal(blocked.status, "market_capped");
  assert.equal(state.accounts.town.wheat, wheatBefore, "积压时不应领走镇库小麦");
  assert.equal(productionStatus(state, mill, CONTENT).label, "市场积压，减产");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));

  market.inventory.flour = 0;
  const resumed = processBuilding(state, mill, CONTENT);
  assert.ok(resumed.batches > 0, "库存回落后应恢复生产");
  assert.ok(state.accounts.town.wheat < wheatBefore, "恢复生产后应消耗镇库小麦");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("镇营磨坊：需求高时目标库存随之抬高，市场余量只够几批时只开几批", () => {
  const state = legacyVoucherState({ seed: 91002 });
  addBuilding(state, "wholesale_market", "wm-b");
  const mill = addBuilding(state, "mill", "mill-b");
  staff(state, mill, 4);
  const market = ensureWholesaleMarket(state, CONTENT);

  // 过去 7 天每天售出 100 斤面粉 → 目标库存 = 100 × 360 = 36000 斤
  seedHistory(state, 7, { itemId: "flour", soldJin: 100 });
  assert.equal(wholesaleAvgDemandUnits(state, "flour", CONTENT, 7), 100 * I);
  market.inventory.flour = 35990 * I; // 余量 10 斤 → 一批面粉 16 斤，只够 1 批
  const result = processBuilding(state, mill, CONTENT);
  assert.equal(result.batches, 1);
  assert.equal(result.status, "market_capped");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("镇营自身领用原料（面包房领面粉）计入需求，并记入当日/本年/累计账", () => {
  const state = legacyVoucherState({ seed: 91003 });
  addBuilding(state, "wholesale_market", "wm-c");
  const bakery = addBuilding(state, "bakery", "bakery-c");
  staff(state, bakery, 1);
  const market = ensureWholesaleMarket(state, CONTENT);
  market.inventory.flour = 1000 * I;
  const result = processBuilding(state, bakery, CONTENT);
  assert.ok(result.batches > 0, "面包房应能从市场领面粉生产");
  const consumed = 5 * result.batches * I;
  assert.equal(market.day.townConsumedUnits.flour, consumed);
  assert.equal(market.year.townConsumedUnits.flour, consumed);
  assert.equal(market.cumulative.townConsumedUnits.flour, consumed);
  // 日结翻页后当日账清零，累计保留
  resetWholesaleDay(state, CONTENT);
  assert.equal(market.day.townConsumedUnits.flour, 0);
  assert.equal(market.cumulative.townConsumedUnits.flour, consumed);
  // 快照里带上当日领用量，需求口径（7 日平均）能读到：前一日 0 斤、当日 700 斤 → 平均 350 斤
  snapshotWholesaleHistory(state, CONTENT);
  recordTownInputConsumption(state, "flour", 700 * I, CONTENT);
  snapshotWholesaleHistory(state, CONTENT);
  assert.equal(state.wholesaleMarket.history.at(-1).townConsumed.flour, 700 * I);
  assert.equal(wholesaleAvgDemandUnits(state, "flour", CONTENT, 7), (700 * I) / 2, "两天平均：0 与 700 斤");
});

test("镇营面包房：面包库存超过目标时停产，不领面粉", () => {
  const state = legacyVoucherState({ seed: 91004 });
  addBuilding(state, "wholesale_market", "wm-d");
  const bakery = addBuilding(state, "bakery", "bakery-d");
  staff(state, bakery, 4);
  const market = ensureWholesaleMarket(state, CONTENT);
  market.inventory.flour = 1000 * I;
  market.inventory.bread = 5000 * I;
  const result = processBuilding(state, bakery, CONTENT);
  assert.equal(result.batches, 0);
  assert.equal(result.status, "market_capped");
  assert.equal(market.inventory.flour, 1000 * I, "积压时不应领走面粉");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("长期不卖面粉：每日结算后市场库存被压在目标附近，不会无限堆积", () => {
  const state = legacyVoucherState({ seed: 91005 });
  addBuilding(state, "wholesale_market", "wm-e");
  const mill = addBuilding(state, "mill", "mill-e");
  staff(state, mill, 4);
  const market = ensureWholesaleMarket(state, CONTENT);
  const dayLoop = days => {
    for (let d = 0; d < days; d++) {
      resetWholesaleDay(state, CONTENT);
      const production = [processBuilding(state, mill, CONTENT)];
      runWholesaleIntake(state, production, [], CONTENT, { includeTownAllocation: false });
      snapshotWholesaleHistory(state, CONTENT);
    }
  };
  dayLoop(60);
  const minStock = CONTENT.rules.townOutputMinStockJin * I;
  const oneBatch = 16 * I;
  assert.ok(market.inventory.flour <= minStock + oneBatch, `库存应压在最低备货附近：${market.inventory.flour / I} 斤`);
  assert.ok(market.inventory.flour >= minStock - oneBatch, "库存也不应远低于最低备货");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("镇营磨坊不得把镇库小麦压到口粮储备以下，储备线上只领超出的部分", () => {
  const state = legacyVoucherState({ seed: 91006 });
  addBuilding(state, "wholesale_market", "wm-f");
  const mill = addBuilding(state, "mill", "mill-f");
  staff(state, mill, 4);
  const population = populationStats(state).total;
  const reserve = population * CONTENT.rules.foodPerPersonDay * CONTENT.rules.townWheatReserveDays * I;
  // 只比储备多出一批小麦（20 斤）
  state.accounts.town.wheat = reserve + 20 * I;
  const first = processBuilding(state, mill, CONTENT);
  assert.equal(first.batches, 1, "储备之上的一批小麦可以磨");
  assert.equal(state.accounts.town.wheat, reserve, "磨完正好停在储备线");
  const second = processBuilding(state, mill, CONTENT);
  assert.equal(second.batches, 0);
  assert.equal(second.status, "wheat_reserve");
  assert.equal(state.accounts.town.wheat, reserve, "储备线以下不得再领用");
  assert.equal(productionStatus(state, mill, CONTENT).label, "保留口粮储备，减产");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("民营磨坊不受镇营产出闸门影响：同样面粉积压时照常生产", () => {
  const state = legacyVoucherState({ seed: 91007 });
  addBuilding(state, "wholesale_market", "wm-g");
  assert.equal(simulation.issueGrainVouchers(state, "town", 100000).ok, true);
  state.accounts.town.wheat += 5000 * I;
  const market = ensureWholesaleMarket(state, CONTENT);
  market.inventory.flour = 50000 * I; // 远超镇营目标库存

  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 20000, CONTENT, owner.id).ok, true);
  owner.inventory.wheat = 0;
  syncResidentAggregates(state, CONTENT);
  const privateMill = addBuilding(state, "mill", "mill-g-private");
  privateMill.ownership = { townLevels: 0, privateLevels: 1, listedLevels: 0 };
  privateMill.privateOwners = [owner.id];
  const millJob = privateJobKeyForBuilding(privateMill.id, CONTENT.buildings.mill.jobs[0].id);
  assert.equal(setJobCount(state, millJob, 1, CONTENT, { type: "private", id: privateMill.id }).assigned, 1);
  const result = processPrivateBuilding(state, privateMill, CONTENT);
  assert.ok(result.batches > 0, `民营磨坊不应被镇营闸门限产：${result.reason || result.status}`);
  assert.notEqual(result.status, "market_capped");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("采集类镇营（伐木场）不设市场闸门：开局木材库存高于最低备货也照常伐木", () => {
  const state = legacyVoucherState({ seed: 91008 });
  addBuilding(state, "wholesale_market", "wm-h");
  const lumberyard = addBuilding(state, "lumberyard", "ly-h");
  staff(state, lumberyard, 4);
  const market = ensureWholesaleMarket(state, CONTENT);
  market.inventory.wood = 5000 * I;
  const result = processBuilding(state, lumberyard, CONTENT);
  assert.ok(result.batches > 0, "伐木没有投入原料，不应被市场积压限产");
  assert.notEqual(result.status, "market_capped");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});
