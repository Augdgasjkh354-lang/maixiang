// 酒坊动态酒品阀门：一工人一日 12 斤酒，四种酒按批发市场缺口分配；小麦按产出折算；单产出配方行为不变。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { processBuilding } from "../src/systems/production.js";
import { flexAllocate, flexPlan, flexRoomUnits } from "../src/systems/flex-recipe.js";
import { townOutputTargetUnits } from "../src/systems/wholesale-market.js";
import { setJobCount } from "../src/systems/households.js";
import { migrateSave } from "../src/persistence/migrations.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const LIQUORS = ["beer", "beer_premium", "baijiu", "baijiu_premium"];
const recipe = CONTENT.recipes.winery_brewing;
const flex = recipe.flex;

// 银行、批发市场、一座酒坊（已派工）。level 决定产能等级。
function world(seed, { workers = 8, level = 1, typeId = "winery", role = "brewers" } = {}) {
  const state = simulation.createInitialState({ seed });
  const plots = state.plots.filter(p => !p.feature);
  let n = 0;
  const add = (type, lvl, id) => {
    const p = plots[n++];
    state.buildings.push({ id, typeId: type, level: lvl, ownership: { townLevels: lvl, privateLevels: 0, listedLevels: 0 }, plotId: p.id, x: p.x, y: p.y, materialInvestments: [], completed: { year: 1, day: 1 } });
    return id;
  };
  add("wholesale_market", 1, "mkt-f");
  simulation.setEmployment(state, `mkt-f::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 1);
  add(typeId, level, "prod-f");
  simulation.setEmployment(state, `prod-f::${role}`, workers);
  return state;
}

const stockOf = (state, id) => (state.wholesaleMarket?.inventory?.[id] || 0) + (state.accounts.town[id] || 0);
const setStockToTarget = (state, id) => { state.wholesaleMarket.inventory[id] = Math.round(townOutputTargetUnits(state, id, CONTENT)); };

test("配方：弹性产出 12 斤/批，一工日一批，小麦名义配比 0.2 / 1；没有固定配比的硬上限或损耗", () => {
  assert.deepEqual([...flex.itemIds], LIQUORS);
  assert.equal(flex.totalJin, 12, "一工人一日总产能 12 斤");
  assert.equal(recipe.batchesPerWorkerDay, 1);
  assert.deepEqual(flex.inputsPerJin, { beer: { wheat: 0.2 }, beer_premium: { wheat: 0.2 }, baijiu: { wheat: 1 }, baijiu_premium: { wheat: 1 } });
  assert.deepEqual(recipe.losses, []);
  assert.equal(CONTENT.rules.townOutputHardCapMultiple, undefined, "硬上限规则已删除");
  assert.equal(CONTENT.buildings.winery.jobs[0].slots, 8, "岗位不变");
});

test("分配：四种酒库存都低（缺口相等）时按缺口占比平分 12 斤/工人；Σ = 批次 × 12", () => {
  const state = world(9401, { workers: 8 });
  const rooms = Object.fromEntries(LIQUORS.map(id => [id, 1000 * I]));
  const cap = 8 * 12 * I;
  const plan = flexPlan(recipe, rooms, cap, 1e12, CONTENT);
  for (const id of LIQUORS) assert.equal(plan.units[id], 24 * I, `${id} 各得 2 斤/工人的 1/4 …`);
  assert.equal(plan.totalUnits, 96 * I, "8 人共 96 斤");
  const result = processBuilding(state, state.buildings.find(b => b.id === "prod-f"), CONTENT);
  assert.equal(result.status, "ready");
  const total = LIQUORS.reduce((sum, id) => sum + (result.outputUnits[id] || 0), 0);
  assert.equal(total, 96 * I, "实际产出 = 8 人 × 12 斤");
  assert.equal(new Set(LIQUORS.map(id => result.outputUnits[id])).size, 1, "缺口相等时四种酒产量相等");
});

test("分配：某种酒库存已满时不再分配给它，产能流向缺口大的酒", () => {
  const rooms = { beer: 0, beer_premium: 600 * I, baijiu: 300 * I, baijiu_premium: 300 * I };
  const plan = flexPlan(recipe, rooms, 600 * I, 1e12, CONTENT);
  assert.equal(plan.units.beer, 0, "啤酒已满，不分配");
  assert.equal(plan.units.beer_premium, 300 * I, "高档啤酒占缺口一半");
  assert.equal(plan.units.baijiu, 150 * I);
  assert.equal(plan.units.baijiu_premium, 150 * I);
  assert.equal(plan.totalUnits, 600 * I, "产能不超过缺口总量时全部用完");
});

test("分配：单品不超过它的缺口，剩余产能按剩余缺口重分（多轮）", () => {
  const alloc = flexAllocate({ a: 10, b: 1000, c: 1000 }, 1500);
  assert.ok(alloc.a <= 10, "a 只有 10 的缺口");
  assert.ok(Math.abs(alloc.a + alloc.b + alloc.c - 1500) <= 2, "剩余产能给 b、c");
  assert.ok(Math.abs(alloc.b - alloc.c) <= 2);
});

test("全满停产：四种酒缺口都为 0 时当日不开工，不付小麦", () => {
  const state = world(9403, { workers: 8 });
  for (const id of LIQUORS) setStockToTarget(state, id);
  const wheatBefore = state.accounts.town.wheat;
  const result = processBuilding(state, state.buildings.find(b => b.id === "prod-f"), CONTENT);
  assert.equal(result.batches, 0);
  assert.equal(result.status, "market_capped");
  assert.equal(state.accounts.town.wheat, wheatBefore, "没有产出就不付小麦");
});

test("小麦：用量 = Σ 各酒产出 × 每斤麦耗（啤酒 0.2、白酒 1）", () => {
  const state = world(9404, { workers: 8 });
  const wheatBefore = state.accounts.town.wheat;
  const result = processBuilding(state, state.buildings.find(b => b.id === "prod-f"), CONTENT);
  const expected = Math.floor(result.outputUnits.beer * 0.2) + Math.floor(result.outputUnits.beer_premium * 0.2)
    + result.outputUnits.baijiu + result.outputUnits.baijiu_premium;
  assert.equal(wheatBefore - state.accounts.town.wheat, expected, "小麦扣减与产出折算一致");
});

test("小麦受口粮储备线限制：可用小麦不足时按比例缩减各酒产出", () => {
  const rooms = Object.fromEntries(LIQUORS.map(id => [id, 1000 * I]));
  const full = flexPlan(recipe, rooms, 96 * I, 1e12, CONTENT);
  const short = flexPlan(recipe, rooms, 96 * I, full.wheatUnits / 2, CONTENT);
  assert.ok(short.wheatUnits <= full.wheatUnits / 2 + 1);
  assert.ok(Math.abs(short.totalUnits - full.totalUnits / 2) <= 4 * LIQUORS.length, "产出约减半");
});

test("成本分摊账平：四种酒成本基础增加 + 小麦成本基础减少 = 0，validateState 通过", () => {
  const state = world(9405, { workers: 8 });
  const costSum = () => LIQUORS.reduce((sum, id) => sum + (state.business.inventoryCostWheatUnits.town[id] || 0), 0);
  const wheatCost = () => state.business.inventoryCostWheatUnits.town.wheat || 0;
  const liquorBefore = costSum();
  const wheatBefore = wheatCost();
  processBuilding(state, state.buildings.find(b => b.id === "prod-f"), CONTENT);
  assert.equal(costSum() - liquorBefore, wheatBefore - wheatCost(), "投入小麦的成本全部转入四种酒");
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, v.errors.join("；"));
});

test("生产率系数乘进总产能：2 级酒坊（等级加成 +10%）10 人日产 12 × 10 × 1.1 = 132 斤（批次按整批取）", () => {
  const state = world(9406, { workers: 10, level: 2 });
  const result = processBuilding(state, state.buildings.find(b => b.id === "prod-f"), CONTENT);
  const total = LIQUORS.reduce((sum, id) => sum + (result.outputUnits[id] || 0), 0);
  assert.equal(total, 132 * I, `总产出 ${total / I} 斤`);
});

test("民营酒坊：有业主时也按缺口分配，产出进业主家庭（扣税后）与税货入市，validateState 通过", () => {
  const state = simulation.createInitialState({ seed: 9407 });
  const plots = state.plots.filter(p => !p.feature);
  const hid = Object.keys(state.households.byId)[0];
  state.buildings.push({ id: "wholesale_market-p", typeId: "wholesale_market", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plots[0].id, x: plots[0].x, y: plots[0].y, materialInvestments: [], completed: { year: 1, day: 1 } });
  state.buildings.push({ id: "winery-p", typeId: "winery", level: 1, ownership: { townLevels: 0, privateLevels: 1, listedLevels: 0 }, plotId: plots[1].id, x: plots[1].x, y: plots[1].y, materialInvestments: [], completed: { year: 1, day: 1 }, privateOwners: [hid] });
  simulation.setEmployment(state, "wholesale_market-p::" + CONTENT.buildings.wholesale_market.jobs[0].id, 2);
  setJobCount(state, "winery-p::brewers::private", 6, CONTENT);
  for (let d = 0; d < 20; d++) simulation.advanceDay(state);
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, v.errors.join("；"));
  const produced = state.privateEconomy.cumulative?.producedUnits || {};
  const made = LIQUORS.filter(id => (produced[id] || 0) > 0);
  assert.ok(made.length >= 2, `民营酒坊应产出多种酒：${made.join("、") || "无"}`);
});

test("旧行为不变：磨坊每批 16 斤面粉（逐位），面包房每批 6 斤面包", () => {
  const mill = world(9408, { typeId: "mill", role: "millers", workers: 12 });
  const mb = CONTENT.recipes[CONTENT.buildings.mill.recipeId];
  mill.wholesaleMarket.inventory.flour = 0;
  const target = townOutputTargetUnits(mill, "flour", CONTENT);
  mill.wholesaleMarket.inventory.flour = Math.max(0, Math.round(target - mb.outputs[0].quantity * I));
  const flourBefore = mill.accounts.town.flour || 0;
  const r = processBuilding(mill, mill.buildings.find(b => b.id === "prod-f"), CONTENT);
  assert.equal(r.batches, 1, "闸门按余量给 1 批");
  assert.equal(mill.accounts.town.flour - flourBefore, Math.round(mb.outputs[0].quantity * r.batches * I), "面粉全部入镇库");
  const bake = world(9409, { typeId: "bakery", role: "bakers", workers: 10 });
  bake.accounts.town.flour = 10000 * I;
  const breadRecipe = CONTENT.recipes[CONTENT.buildings.bakery.recipeId];
  const r2 = processBuilding(bake, bake.buildings.find(b => b.id === "prod-f"), CONTENT);
  assert.ok(r2.batches > 0);
  assert.equal(bake.accounts.town.bread, Math.round(breadRecipe.outputs[0].quantity * r2.batches * I), "面包逐位");
  assert.equal(bake.accounts.town.flour, 10000 * I - Math.round(breadRecipe.inputs[0].quantity * r2.batches * I), "面粉逐位");
});

test("缺口计算：flexRoomUnits 对四种酒都给出目标库存 − 现存（不为负）", () => {
  const state = world(9410);
  for (const id of LIQUORS) state.wholesaleMarket.inventory[id] = 10 ** 9;
  const rooms = flexRoomUnits(state, recipe, CONTENT);
  for (const id of LIQUORS) assert.equal(rooms[id], 0, `${id} 满了缺口为 0`);
});

test("旧档价格：读档时已存的批发售价（玩家调过的价）保持不动，新开局用新价格", () => {
  const fresh = simulation.createInitialState({ seed: 9411 });
  assert.equal(fresh.wholesaleMarket.pricesVoucherPerUnit.baijiu_premium, 100, "新开局高档白酒售价 100");
  const raw = JSON.parse(JSON.stringify(fresh));
  raw.wholesaleMarket.pricesVoucherPerUnit.beer = 0.5;
  raw.wholesaleMarket.pricesVoucherPerUnit.baijiu = 2.8;
  delete raw.wholesaleMarket.pricesVoucherPerUnit.beer_premium;
  const loaded = migrateSave(raw, CONTENT);
  assert.equal(loaded.wholesaleMarket.pricesVoucherPerUnit.beer, 0.5, "旧档已存价格不被覆盖");
  assert.equal(loaded.wholesaleMarket.pricesVoucherPerUnit.baijiu, 2.8);
  assert.equal(loaded.wholesaleMarket.pricesVoucherPerUnit.baijiu_premium, 100, "旧档缺的键补新默认价");
  assert.equal(simulation.validateState(loaded).valid, true);
});
