import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount } from "../src/systems/households.js";
import { ensureWholesaleMarket, townOutputMarketRoomUnits } from "../src/systems/wholesale-market.js";
import { processBuilding } from "../src/systems/production.js";
import { townOutputMarketBatchCap } from "../src/selectors/production.js";
import { jobKeyForBuilding } from "../src/selectors/labor.js";
import { grantResidentVouchers } from "./helpers-v16.js";

// 面包备货天数单独覆盖（rules.townOutputStockDaysByItem）：面包是易囤的成品，只备 30 天销量；
// 其他商品仍按全局 townOutputStockDays（360 天）。覆盖表缺省时回退全局值。
// 夹具口径同 operating-plan-town.test.js：直接放建成的建筑，跳过施工。

const I = CONTENT.precision.inventoryUnitsPerJin;
const BAKERY_RECIPE = CONTENT.recipes[CONTENT.buildings.bakery.recipeId];
const FLOUR_PER_BATCH = BAKERY_RECIPE.inputs[0].quantity * I;

function addBuilding(state, typeId, id, { level = 1, townLevels = level, privateLevels = 0 } = {}) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) &&
    !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `缺少地块 ${typeId}`);
  state.buildings.push({ id, typeId, level, ownership: { townLevels, privateLevels, listedLevels: 0 }, plotId: plot.id,
    x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return state.buildings.at(-1);
}

// 近 7 日每天售出 jinPerDay 斤（需求 = 售出 + 镇营自用）；多次调用按商品叠加。
function demandHistory(state, itemId, jinPerDay) {
  const history = state.wholesaleMarket.history ||= [];
  for (let d = 0; d < 7; d++) {
    history[d] ||= { sold: {}, townConsumed: {} };
    history[d].sold[itemId] = jinPerDay * I;
  }
}

// 不带覆盖表的内容：备货天数全部回退全局 360 天（对照组）。
function contentWithoutOverrides() {
  return { ...CONTENT, rules: { ...CONTENT.rules, townOutputStockDaysByItem: undefined } };
}

function marketState({ seed }) {
  const state = simulation.createInitialState({ seed });
  assert.equal(grantResidentVouchers(state, 300000, CONTENT).ok, true);
  addBuilding(state, "wholesale_market", "town-market", { level: 1, townLevels: 1 });
  ensureWholesaleMarket(state, CONTENT);
  return state;
}

test("面包备货目标按 30 天销量，其他商品（面粉、盐）仍按 360 天", () => {
  const state = marketState({ seed: 9101 });
  demandHistory(state, "bread", 100);
  demandHistory(state, "flour", 100);
  demandHistory(state, "salt", 100);
  // 面包：目标 = 100 斤/天 × 30 天 = 3000 斤；面粉、盐：目标 = 100 × 360 = 36000 斤。
  assert.equal(townOutputMarketRoomUnits(state, "bread", CONTENT), 3000 * I, "面包余量按 30 天");
  assert.equal(townOutputMarketRoomUnits(state, "flour", CONTENT), 36000 * I, "面粉余量仍按 360 天");
  assert.equal(townOutputMarketRoomUnits(state, "salt", CONTENT), 36000 * I, "盐余量仍按 360 天");
});

test("面包库存超过 30 天需求时面包房停产，且不再从市场领走面粉", () => {
  const state = marketState({ seed: 9102 });
  const bakery = addBuilding(state, "bakery", "town-bakery", { level: 1, townLevels: 1 });
  setJobCount(state, jobKeyForBuilding("town-bakery", "bakers"), 10, CONTENT);
  demandHistory(state, "bread", 100);
  state.wholesaleMarket.inventory.flour = 5000 * I;
  state.wholesaleMarket.inventory.bread = 3500 * I; // 超过 30 天需求 3000 斤

  assert.equal(townOutputMarketBatchCap(state, BAKERY_RECIPE, CONTENT), 0, "面包余量为零，批次上限为 0");
  const flourBefore = state.wholesaleMarket.inventory.flour;
  const breadBefore = state.wholesaleMarket.inventory.bread;
  processBuilding(state, bakery, CONTENT);
  assert.equal(state.wholesaleMarket.inventory.flour, flourBefore, "面粉不被面包房领走");
  assert.equal(state.wholesaleMarket.inventory.bread, breadBefore, "面包不增加");
});

test("面包库存低于 30 天需求时面包房照常开工并领用面粉（对照）", () => {
  const state = marketState({ seed: 9103 });
  const bakery = addBuilding(state, "bakery", "town-bakery", { level: 1, townLevels: 1 });
  setJobCount(state, jobKeyForBuilding("town-bakery", "bakers"), 10, CONTENT);
  demandHistory(state, "bread", 100);
  state.wholesaleMarket.inventory.flour = 5000 * I;
  state.wholesaleMarket.inventory.bread = 0;

  assert.ok(townOutputMarketBatchCap(state, BAKERY_RECIPE, CONTENT) > 0, "面包缺货时有批次余量");
  const flourBefore = state.wholesaleMarket.inventory.flour;
  processBuilding(state, bakery, CONTENT);
  assert.ok(state.wholesaleMarket.inventory.flour < flourBefore, "面包房领用了面粉");
  assert.ok(state.wholesaleMarket.inventory.flour <= flourBefore - FLOUR_PER_BATCH, "至少消耗一批面粉");
});

test("rules 没有覆盖表时面包回退全局 townOutputStockDays（360 天）", () => {
  const state = marketState({ seed: 9104 });
  demandHistory(state, "bread", 100);
  const plain = contentWithoutOverrides();
  assert.equal(townOutputMarketRoomUnits(state, "bread", plain), 36000 * I, "无覆盖表：面包按全局 360 天");
  state.wholesaleMarket.inventory.bread = 3500 * I;
  assert.equal(townOutputMarketRoomUnits(state, "bread", plain), (36000 - 3500) * I, "无覆盖表：库存 3500 斤仍远低于目标");
  assert.equal(townOutputMarketRoomUnits(state, "bread", CONTENT), 0, "有覆盖表：同库存已超过 30 天目标");
});

test("覆盖表存在但不含该商品时回退全局值", () => {
  const state = marketState({ seed: 9105 });
  const custom = { ...CONTENT, rules: { ...CONTENT.rules, townOutputStockDays: 100, townOutputStockDaysByItem: { bread: 30 } } };
  demandHistory(state, "flour", 10);
  assert.equal(townOutputMarketRoomUnits(state, "flour", custom), 1000 * I, "面粉不在覆盖表中，按全局 100 天");
  demandHistory(state, "bread", 10);
  assert.equal(townOutputMarketRoomUnits(state, "bread", custom), 300 * I, "面包覆盖为 30 天");
});
