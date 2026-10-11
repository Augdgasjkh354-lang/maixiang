// 四种酒（普通啤酒、高档啤酒、普通白酒、高档白酒）：一座酒坊同出四种酒的配方、建筑、需求、外镇、旧档迁移。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { renameItemIds, renameLiquorBuildings } from "../src/persistence/save-compat.js";
import { planProductionAccounting } from "../src/economy/business.js";
import { townOutputMarketBatchCap } from "../src/selectors/production.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const LIQUORS = ["beer", "beer_premium", "baijiu", "baijiu_premium"];
const OLD_TYPES = ["brewery", "craft_brewery", "premium_winery"];

test("四种酒物品：单位斤、household、流通标记齐全，且不再有 wine", () => {
  for (const id of LIQUORS) {
    const item = CONTENT.items[id];
    assert.ok(item, `${id} 存在`);
    assert.equal(item.unit, "斤");
    assert.equal(item.category, "household");
    assert.equal(item.edible, false);
    assert.equal(item.liquor, true, `${id} 带酒类标记`);
    assert.ok(item.wholesale && item.retail && item.storeOnly && item.optionalRetail, `${id} 流通标记齐全`);
  }
  assert.equal(CONTENT.items.wine, undefined, "wine 已删除");
  assert.equal(CONTENT.rules.marketPricesVoucherPerUnit.wine, undefined);
  assert.equal(CONTENT.rules.householdGoods.wine, undefined);
});

test("配方：酒坊只有一个弹性配方 winery_brewing：一工日一批，总产能 12 斤，四种酒按缺口分配，无损耗；名义配比小麦 8.4 斤/批", () => {
  const recipe = CONTENT.recipes.winery_brewing;
  assert.ok(recipe, "winery_brewing 存在");
  assert.deepEqual([...recipe.flex.itemIds], LIQUORS, "四种酒都可分配");
  assert.equal(recipe.flex.totalJin, 12);
  assert.deepEqual(recipe.flex.inputsPerJin, { beer: { wheat: 0.2 }, beer_premium: { wheat: 0.2 }, baijiu: { wheat: 1 }, baijiu_premium: { wheat: 1 } });
  assert.equal(recipe.batchesPerWorkerDay, 1, "每工日一批");
  assert.deepEqual(recipe.losses, [], "无损耗");
  assert.ok(Math.abs(recipe.inputs[0].quantity - 8.4) < 1e-9, "名义配比：3 斤/种 × 麦耗 = 8.4 斤");
  for (const id of ["brewery_beer", "craft_brewery_beer", "winery_baijiu", "premium_winery_baijiu"]) assert.equal(CONTENT.recipes[id], undefined, `${id} 已删除`);
});

test("一工日产值：四种酒等量（每种 3 斤）时 3 × (5 + 12 + 20 + 100) = 411 券（批发默认售价）；日薪 5", () => {
  const recipe = CONTENT.recipes.winery_brewing;
  const price = id => CONTENT.rules.wholesaleDefaultSalePrices[id];
  const value = recipe.outputs.reduce((sum, row) => sum + row.quantity * price(row.itemId), 0);
  assert.ok(Math.abs(value - 411) < 1e-9, `名义一工日产值 ${value}`);
  const wage = CONTENT.buildings.winery.jobs[0].wagePerWorkerDay;
  assert.equal(wage, 5);
});

test("建筑：酒坊 winery 是唯一的酒类建筑，有 jobs、带 industryTier、岗位 brewers 为产出角色；旧三种建筑已删除", () => {
  const b = CONTENT.buildings.winery;
  assert.ok(b, "winery 存在");
  assert.equal(b.recipeId, "winery_brewing");
  assert.equal(b.industryTier, 1, "加工产业");
  assert.equal(b.productionRoleId, "brewers");
  assert.deepEqual(b.jobs.map(job => [job.id, job.slots, job.wagePerWorkerDay]), [["brewers", 8, 5]], "岗位 brewers 8 个/级，日薪 5");
  for (const typeId of OLD_TYPES) assert.equal(CONTENT.buildings[typeId], undefined, `${typeId} 已删除`);
});

test("居民需求：普通款面向所有人（弹性约 1），高档款弹性 2 且年均量小；舒心值合计约 2", () => {
  const cfg = CONTENT.rules.householdGoods;
  for (const id of LIQUORS) assert.ok(cfg[id], `${id} 进日用品表`);
  assert.ok(cfg.beer.incomeElasticity <= 1.2 && cfg.baijiu.incomeElasticity <= 1.5, "普通款弹性不高");
  assert.ok(cfg.beer_premium.incomeElasticity >= 1.8 && cfg.baijiu_premium.incomeElasticity >= 1.8, "高档款弹性 1.8—2.2");
  assert.ok(cfg.beer_premium.annualPerPerson < cfg.beer.annualPerPerson);
  assert.ok(cfg.baijiu_premium.annualPerPerson < cfg.baijiu.annualPerPerson);
  const comfort = LIQUORS.reduce((sum, id) => sum + cfg[id].comfortMaximum, 0);
  assert.ok(Math.abs(comfort - 2) < 1e-9, `酒的舒心值合计 ${comfort}，应与旧 wine 的 2 持平`);
});

test("批发价：收购价 = 售价 × 0.8，高档款按新价格的倍数", () => {
  const sale = CONTENT.rules.wholesaleDefaultSalePrices;
  const purchase = CONTENT.rules.wholesaleDefaultPurchasePrices;
  for (const id of LIQUORS) {
    const ratio = purchase[id] / sale[id];
    assert.ok(Math.abs(ratio - 0.8) < 1e-9, `${id} 收购/售价 ${ratio.toFixed(3)}`);
  }
  assert.ok(Math.abs(sale.beer_premium / sale.beer - 2.4) < 1e-9, "高档啤酒 12 / 普通 5 = 2.4 倍");
  assert.ok(Math.abs(sale.baijiu_premium / sale.baijiu - 5) < 1e-9, "高档白酒 100 / 普通 20 = 5 倍");
  assert.deepEqual([sale.beer, sale.beer_premium, sale.baijiu, sale.baijiu_premium], [5, 12, 20, 100], "新批发售价");
});

test("综合商店进四种酒；外镇各有四种酒，王镇量与价更高，都不卖给我们", () => {
  const general = CONTENT.rules.shopTypes.general.itemIds;
  for (const id of LIQUORS) assert.ok(general.includes(id), `综合商店卖${id}`);
  assert.ok(!general.includes("wine"));
  for (const townId of ["minzhen", "wangzhen"]) {
    const goods = CONTENT.outsideTowns[townId].goods;
    for (const id of LIQUORS) {
      assert.ok(goods[id], `${townId} 有 ${id}`);
      assert.equal(goods[id].sellsToUs, false);
    }
    assert.equal(goods.wine, undefined);
  }
  const yearly = townId => LIQUORS.reduce((sum, id) => sum + CONTENT.outsideTowns[townId].goods[id].needPerPersonDay * 365, 0);
  assert.ok(Math.abs(yearly("minzhen") - 6) < 1e-9, "民镇年人均需求合计 6 斤（原 wine）");
  assert.ok(Math.abs(yearly("wangzhen") - 10) < 1e-9, "王镇年人均需求合计 10 斤（原 wine）");
  assert.ok(CONTENT.outsideTowns.wangzhen.goods.baijiu.basePrice > CONTENT.outsideTowns.minzhen.goods.baijiu.basePrice);
});

test("成本分摊按批发默认售价的价值比例：一批四种酒的成本比 = 产值比（允许 1 个内部单位的取整误差）", () => {
  const state = simulation.createInitialState({ seed: 7713 });
  const recipe = CONTENT.recipes.winery_brewing;
  const plan = planProductionAccounting(state, { id: "winery-x", typeId: "winery" }, recipe, 100, CONTENT);
  const byItem = Object.fromEntries(plan.outputs.map(row => [row.itemId, row.costWheatUnits]));
  const price = id => CONTENT.rules.wholesaleDefaultSalePrices[id];
  const value = id => recipe.outputs.find(row => row.itemId === id).quantity * price(id);
  const total = Object.values(byItem).reduce((sum, v) => sum + v, 0);
  const totalValue = LIQUORS.reduce((sum, id) => sum + value(id), 0);
  // splitCost 逐项向下取整、末项收尾，四项误差合计不超过 4 个内部单位（3000 单位 = 1 斤）。
  for (const id of LIQUORS) {
    const expected = total * value(id) / totalValue;
    assert.ok(Math.abs(byItem[id] - expected) <= 4, `${id} 成本 ${byItem[id]} ≈ ${expected.toFixed(1)}`);
  }
  assert.equal(plan.outputs.reduce((sum, row) => sum + row.costWheatUnits, 0), total, "成本分完不漏");
});

test("市场闸门取最宽松的产出：高档白酒到顶不停产（其余酒还有余量）；四种酒都到顶才停产", () => {
  const state = simulation.createInitialState({ seed: 7714 });
  const recipe = CONTENT.recipes.winery_brewing;
  const plots = state.plots.filter(p => !p.feature);
  state.buildings.push({ id: "wholesale_market-g", typeId: "wholesale_market", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plots[0].id, x: plots[0].x, y: plots[0].y, materialInvestments: [], completed: { year: 1, day: 1 } });
  state.wholesaleMarket ||= { inventory: {} };
  const open = townOutputMarketBatchCap(state, recipe, CONTENT);
  assert.ok(open >= 100, `无库存时闸门开着（${open} 批）`);
  state.wholesaleMarket.inventory.baijiu_premium = 10 ** 9;
  assert.ok(townOutputMarketBatchCap(state, recipe, CONTENT) > 0, "高档白酒到顶，其余酒仍开工");
  for (const id of LIQUORS) state.wholesaleMarket.inventory[id] = 10 ** 9;
  assert.equal(townOutputMarketBatchCap(state, recipe, CONTENT), 0, "四种酒都到顶即停产");
});

test("开局新游戏 validateState 通过；酒坊 2 人建成派工后一日，四种酒按缺口平分 24 斤（每种 6 斤），小麦 = Σ产出 × 麦耗", () => {
  const state = simulation.createInitialState({ seed: 7711 });
  const plots = state.plots.filter(p => !p.feature);
  ["wholesale_market", "winery"].forEach((typeId, i) => {
    state.buildings.push({ id: `${typeId}-t`, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
      plotId: plots[i].id, x: plots[i].x, y: plots[i].y, materialInvestments: [], completed: { year: 1, day: 1 } });
  });
  state.accounts.town.wood += 5000 * I;
  simulation.setEmployment(state, "winery-t::brewers", 2);
  simulation.setEmployment(state, `wholesale_market-t::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 1);
  const wheatBefore = state.accounts.town.wheat;
  simulation.advanceDay(state);
  const made = state.business.buildings["winery-t"].yearOutputUnits;
  for (const id of LIQUORS) assert.equal(made[id], 6 * I, `${id} 6 斤`);
  assert.equal(wheatBefore - state.accounts.town.wheat, Math.round(6 * 0.2 * I) * 2 + Math.round(6 * 1 * I) * 2, "小麦 = 啤酒 1.2 + 高档啤酒 1.2 + 白酒 6 + 高档白酒 6（斤）");
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, v.errors.join("；"));
});

test("旧档：啤酒坊 / 精酿坊 / 窖坊改成酒坊（保留等级、归属、岗位人数），岗位键改成 brewers，经验工日并入酒坊", () => {
  const state = simulation.createInitialState({ seed: 7715 });
  const raw = JSON.parse(JSON.stringify(state));
  const plots = state.plots.filter(p => !p.feature);
  const hids = Object.keys(raw.households.byId);
  const old = (id, typeId, level, ownership, i, extra = {}) => raw.buildings.push({ id, typeId, level, ownership, plotId: plots[i].id, x: plots[i].x, y: plots[i].y, materialInvestments: [], completed: { year: 1, day: 1 }, ...extra });
  old("brewery-5", "brewery", 2, { townLevels: 2, privateLevels: 0, listedLevels: 0 }, 0);
  old("craft_brewery-6", "craft_brewery", 2, { townLevels: 2, privateLevels: 0, listedLevels: 0 }, 1);
  old("premium_winery-7", "premium_winery", 1, { townLevels: 1, privateLevels: 0, listedLevels: 0 }, 2);
  for (const hid of hids.slice(0, 3)) raw.households.byId[hid].jobs = {};
  raw.households.byId[hids[0]].jobs["brewery-5::beer_brewers"] = 1;
  raw.households.byId[hids[1]].jobs["craft_brewery-6::craft_brewers"] = 1;
  raw.households.byId[hids[2]].jobs["premium_winery-7::cellar_brewers"] = 1;
  raw.industryExperience = { brewery: 100, craft_brewery: 40, winery: 10, premium_winery: 5 };
  const loaded = migrateSave(raw, CONTENT);
  const byId = Object.fromEntries(loaded.buildings.map(b => [b.id, b]));
  assert.equal(byId["brewery-5"].typeId, "winery");
  assert.equal(byId["brewery-5"].level, 2);
  assert.deepEqual(byId["brewery-5"].ownership, { townLevels: 2, privateLevels: 0, listedLevels: 0 });
  assert.equal(byId["craft_brewery-6"].typeId, "winery");
  assert.equal(byId["craft_brewery-6"].level, 2);
  assert.deepEqual(byId["craft_brewery-6"].ownership, { townLevels: 2, privateLevels: 0, listedLevels: 0 }, "镇营归属保留");
  assert.equal(byId["premium_winery-7"].typeId, "winery");
  assert.equal(loaded.households.byId[hids[0]].jobs["brewery-5::brewers"], 1, "岗位键改成 brewers，人数不变");
  assert.equal(loaded.households.byId[hids[1]].jobs["craft_brewery-6::brewers"], 1);
  assert.equal(loaded.households.byId[hids[2]].jobs["premium_winery-7::brewers"], 1);
  assert.equal(loaded.industryExperience.winery, 155, "工日相加并入酒坊");
  assert.equal(loaded.industryExperience.brewery, undefined);
  const v = simulation.validateState(loaded);
  assert.equal(v.valid, true, v.errors.join("；"));
  for (let i = 0; i < 30; i++) simulation.advanceDay(loaded);
  assert.equal(simulation.validateState(loaded).valid, true, "推进 30 天后仍合法");
});

test("renameLiquorBuildings：类型、配方、岗位角色段改名；同名数值表（工日）相加；幂等", () => {
  const raw = {
    buildings: [{ id: "brewery-3", typeId: "brewery" }, { id: "winery-4", typeId: "winery" }],
    jobs: { "brewery-3::beer_brewers": 2, "craft_brewery-8::craft_brewers::listed": 1, "winery-4::brewers": 3 },
    industryExperience: { brewery: 5, winery: 1 },
    productionRecipe: "brewery_beer",
    policy: { privateProductionTaxPercent: { winery: 10, brewery: 12 } }
  };
  renameLiquorBuildings(raw);
  assert.equal(raw.buildings[0].typeId, "winery");
  assert.equal(raw.buildings[1].typeId, "winery");
  assert.deepEqual(raw.jobs, { "brewery-3::brewers": 2, "craft_brewery-8::brewers::listed": 1, "winery-4::brewers": 3 });
  assert.deepEqual(raw.industryExperience, { winery: 6 });
  assert.equal(raw.productionRecipe, "winery_brewing");
  assert.deepEqual(raw.policy.privateProductionTaxPercent, { winery: 10 }, "税率取酒坊已有的值");
  const again = structuredClone(raw);
  renameLiquorBuildings(again);
  assert.deepEqual(again, raw, "幂等");
});

test("旧档 wine 迁移：库存、家庭、店铺里的 wine 1:1 并入 baijiu，wineConsumedUnits 改名，校验通过", () => {
  const state = simulation.createInitialState({ seed: 7712 });
  const raw = JSON.parse(JSON.stringify(state));
  raw.wholesaleMarket ||= { inventory: {} };
  raw.wholesaleMarket.inventory.wine = 500 * I;
  const hid = Object.keys(raw.households.byId)[0];
  raw.households.byId[hid].inventory.wine = 40 * I;
  raw.households.byId[hid].life = { day: { wineConsumedUnits: 7 } };
  const loaded = migrateSave(raw, CONTENT);
  assert.equal(loaded.wholesaleMarket.inventory.wine, undefined, "wine 键已删除");
  assert.equal(loaded.wholesaleMarket.inventory.baijiu, 500 * I, "批发库存并入白酒");
  assert.equal(loaded.households.byId[hid].inventory.baijiu, 40 * I, "家庭库存并入白酒");
  assert.equal(loaded.households.byId[hid].inventory.wine, undefined);
  assert.equal(simulation.validateState(loaded).valid, true, simulation.validateState(loaded).errors.join("；"));
});

test("renameItemIds：同名键数值相加、字符串 itemId 改名、无 wine 时为空操作", () => {
  const raw = { a: { wine: 3, baijiu: 2 }, list: [{ itemId: "wine" }], winery: { x: 1 }, nested: { wineConsumedUnits: 4 } };
  renameItemIds(raw);
  assert.deepEqual(raw.a, { baijiu: 5 });
  assert.equal(raw.list[0].itemId, "baijiu");
  assert.deepEqual(raw.winery, { x: 1 }, "酒坊建筑相关键不改");
  assert.equal(raw.nested.baijiuConsumedUnits, 4);
  const clean = { a: { baijiu: 1 } };
  assert.deepEqual(renameItemIds(structuredClone(clean)), clean);
});
