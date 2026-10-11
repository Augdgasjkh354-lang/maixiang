// 联产配方（一批同出几种，如酒坊）的市场闸门（最宽松）、库存硬上限与加工损耗记账；单产出配方行为不变。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { processBuilding } from "../src/systems/production.js";
import { townOutputMarketBatchCap } from "../src/selectors/production.js";
import { townOutputMarketRoomUnits, townOutputTargetUnits } from "../src/systems/wholesale-market.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const LIQUORS = ["beer", "beer_premium", "baijiu", "baijiu_premium"];
const recipe = CONTENT.recipes.winery_brewing;

// 银行、批发市场、一座酒坊（已派工，level 2，16 人）。
function world(seed, { winery = true, typeId = "winery", workers = 16, level = 2 } = {}) {
  const state = simulation.createInitialState({ seed });
  const plots = state.plots.filter(p => !p.feature);
  let n = 0;
  const add = (type, lvl, id) => {
    const p = plots[n++];
    state.buildings.push({ id, typeId: type, level: lvl, ownership: { townLevels: lvl, privateLevels: 0, listedLevels: 0 }, plotId: p.id, x: p.x, y: p.y, materialInvestments: [], completed: { year: 1, day: 1 } });
    return id;
  };
  add("wholesale_market", 2, "mkt-j");
  simulation.setEmployment(state, `mkt-j::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  if (winery) {
    add(typeId, level, "prod-j");
    const role = CONTENT.buildings[typeId].productionRoleId;
    simulation.setEmployment(state, `prod-j::${role}`, workers);
  }
  return state;
}

const stockOf = (state, id) => (state.wholesaleMarket?.inventory?.[id] || 0) + (state.accounts.town[id] || 0);

test("最宽松闸门：高档白酒库存爆了，其他酒仍有余量时继续生产（闸门 = 各产出余量折算批次的最大值）", () => {
  const state = world(9301, { winery: false });
  state.wholesaleMarket.inventory.baijiu_premium = 10 ** 9;
  const cap = townOutputMarketBatchCap(state, recipe, CONTENT);
  assert.ok(cap > 0, "只要有一种产出还有余量，闸门就开");
  assert.equal(cap, Math.max(...LIQUORS.map(id => {
    const perBatch = recipe.outputs.find(row => row.itemId === id).quantity * I;
    return Math.ceil(townOutputMarketRoomUnits(state, id, CONTENT) / perBatch);
  })), "闸门取各产出余量折算批次的最大值");
  assert.equal(townOutputMarketRoomUnits(state, "baijiu_premium", CONTENT), 0, "高档白酒余量为 0");
});

test("最宽松闸门：四种酒都到顶才停产（闸门为 0）", () => {
  const state = world(9302, { winery: false });
  for (const id of LIQUORS) state.wholesaleMarket.inventory[id] = 10 ** 9;
  assert.equal(townOutputMarketBatchCap(state, recipe, CONTENT), 0);
});

test("硬上限：超过目标库存 × 2 的部分当批不入库，记加工损耗；成本守恒（产出成本 + 损耗成本 = 投入小麦成本）", () => {
  const state = world(9303);
  const building = state.buildings.find(row => row.id === "prod-j");
  const hardCap = Math.floor(townOutputTargetUnits(state, "baijiu_premium", CONTENT) * CONTENT.rules.townOutputHardCapMultiple);
  // 把高档白酒的市场库存填到硬上限：本批的高档白酒全部超出。
  state.wholesaleMarket.inventory.baijiu_premium = hardCap;
  const liquorCost = () => LIQUORS.reduce((sum, id) => sum + (state.business.inventoryCostWheatUnits.town[id] || 0), 0);
  const lossCost = () => state.business.day?.processingLossWheatUnits || 0;
  const wheatCost = () => state.business.inventoryCostWheatUnits.town.wheat || 0;
  const before = { town: state.accounts.town.baijiu_premium || 0, liquor: liquorCost(), loss: lossCost(), wheat: wheatCost(), ledger: (state.ledger || []).length };
  const result = processBuilding(state, building, CONTENT);
  assert.ok(result.batches > 0, `应有批次：${result.batches}`);
  const premiumUnits = Math.round(recipe.outputs.find(row => row.itemId === "baijiu_premium").quantity * result.batches * I);
  assert.equal(state.accounts.town.baijiu_premium - before.town, 0, "硬上限已满：高档白酒一斤都不入库");
  const lossRows = (state.ledger || []).slice(before.ledger).filter(row => row.type === "processing_loss" && row.itemId === "baijiu_premium");
  const lostUnits = lossRows.reduce((sum, row) => sum + row.quantityUnits, 0);
  assert.equal(lostUnits, premiumUnits, "超出部分全部记为加工损耗");
  // 其余三种酒照常入库（未到顶）。
  assert.equal(state.accounts.town.beer, Math.round(2 * result.batches * I), "普通啤酒照常入库");
  // 成本守恒：小麦成本基础减少量 = 四种酒成本基础增加量 + 加工损耗成本增加量。
  const wheatDrop = before.wheat - wheatCost();
  const liquorGain = liquorCost() - before.liquor;
  const lossGain = lossCost() - before.loss;
  assert.ok(lossGain > 0, "损耗成本记入加工损耗账");
  assert.equal(liquorGain + lossGain, wheatDrop, "账平：投入成本 = 留下的产出成本 + 损耗成本");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("硬上限：库存够用时不产生损耗（与无硬上限的行为一致）", () => {
  const state = world(9304);
  const building = state.buildings.find(row => row.id === "prod-j");
  const ledgerBefore = (state.ledger || []).length;
  const result = processBuilding(state, building, CONTENT);
  assert.ok(result.batches > 0);
  const losses = (state.ledger || []).slice(ledgerBefore).filter(row => row.type === "processing_loss");
  assert.equal(losses.length, 0, "没有超出硬上限就没有损耗");
  assert.equal(state.accounts.town.baijiu_premium, Math.round(recipe.outputs.find(row => row.itemId === "baijiu_premium").quantity * result.batches * I), "四种酒全部入库");
});

test("单产出配方不变：磨坊只开到余量为止（闸门），面粉全部入镇库、不记损耗", () => {
  const state = world(9305, { winery: true, typeId: "mill", workers: 12, level: 1 });
  const building = state.buildings.find(row => row.id === "prod-j");
  const millRecipe = CONTENT.recipes[CONTENT.buildings.mill.recipeId];
  // 面粉余量只够 1 批：闸门给 1 批，产出全部入镇库（单产出不设硬上限）。
  const target = townOutputTargetUnits(state, "flour", CONTENT);
  state.wholesaleMarket.inventory.flour = Math.max(0, Math.round(target - millRecipe.outputs[0].quantity * I));
  const flourBefore = state.accounts.town.flour || 0;
  const ledgerBefore = (state.ledger || []).length;
  const result = processBuilding(state, building, CONTENT);
  assert.equal(result.batches, 1, "闸门按余量给 1 批");
  assert.equal(state.accounts.town.flour - flourBefore, Math.round(millRecipe.outputs[0].quantity * result.batches * I), "面粉全部入镇库");
  assert.equal((state.ledger || []).slice(ledgerBefore).filter(row => row.type === "processing_loss" && row.itemId === "flour").length, 0);
});

test("单产出配方不变：面包房逐位一致（每批 6 斤面包，每批耗 5 斤面粉）", () => {
  const state = world(9306, { winery: true, typeId: "bakery", workers: 10, level: 1 });
  const building = state.buildings.find(row => row.id === "prod-j");
  state.accounts.town.flour = 10000 * I;
  const breadRecipe = CONTENT.recipes[CONTENT.buildings.bakery.recipeId];
  const result = processBuilding(state, building, CONTENT);
  assert.ok(result.batches > 0);
  assert.equal(state.accounts.town.bread, Math.round(breadRecipe.outputs[0].quantity * result.batches * I), "面包逐位");
  assert.equal(state.accounts.town.flour, 10000 * I - Math.round(breadRecipe.inputs[0].quantity * result.batches * I), "面粉逐位");
});
