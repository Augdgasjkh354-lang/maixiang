// 四种酒（普通啤酒、高档啤酒、普通白酒、高档白酒）：配方、建筑、需求、外镇、旧档 wine 迁移。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { renameItemIds } from "../src/persistence/save-compat.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const LIQUORS = ["beer", "beer_premium", "baijiu", "baijiu_premium"];

const RECIPE_OF = { brewery: "brewery_beer", craft_brewery: "craft_brewery_beer", winery: "winery_baijiu", premium_winery: "premium_winery_baijiu" };

test("四种酒物品：单位斤、household、流通标记与普通酒一致，且不再有 wine", () => {
  for (const id of LIQUORS) {
    const item = CONTENT.items[id];
    assert.ok(item, `${id} 存在`);
    assert.equal(item.unit, "斤");
    assert.equal(item.category, "household");
    assert.equal(item.edible, false);
    assert.ok(item.wholesale && item.retail && item.storeOnly && item.optionalRetail, `${id} 流通标记齐全`);
  }
  assert.equal(CONTENT.items.wine, undefined, "wine 已删除");
  assert.equal(CONTENT.rules.marketPricesVoucherPerUnit.wine, undefined);
  assert.equal(CONTENT.rules.householdGoods.wine, undefined);
});

test("配方：啤酒 1 斤麦出 5 斤，白酒 1 斤麦出 1 斤，均无损耗；高档款与普通款出粮比相同、每工日批数为 1/3", () => {
  const recipe = id => CONTENT.recipes[id];
  for (const id of Object.values(RECIPE_OF).map(r => r)) assert.ok(recipe(id), `${id} 配方存在`);
  const beer = recipe("brewery_beer"), craft = recipe("craft_brewery_beer");
  const baijiu = recipe("winery_baijiu"), premium = recipe("premium_winery_baijiu");
  for (const r of [beer, craft, baijiu, premium]) {
    assert.deepEqual(r.inputs.map(x => x.itemId), ["wheat"], `${r.id} 只用小麦`);
    assert.deepEqual(r.losses, [], `${r.id} 无损耗`);
  }
  assert.equal(beer.outputs[0].itemId, "beer");
  assert.equal(beer.outputs[0].quantity / beer.inputs[0].quantity, 5, "啤酒出粮比 5:1");
  assert.equal(craft.outputs[0].itemId, "beer_premium");
  assert.equal(craft.outputs[0].quantity / craft.inputs[0].quantity, 5, "高档啤酒出粮比与普通相同");
  assert.equal(baijiu.outputs[0].itemId, "baijiu");
  assert.equal(baijiu.outputs[0].quantity / baijiu.inputs[0].quantity, 1, "白酒出粮比 1:1");
  assert.equal(premium.outputs[0].itemId, "baijiu_premium");
  assert.equal(premium.outputs[0].quantity / premium.inputs[0].quantity, 1);
  assert.equal(craft.batchesPerWorkerDay * 3, beer.batchesPerWorkerDay, "高档啤酒工时为普通的 1/3");
  assert.equal(premium.batchesPerWorkerDay * 3, baijiu.batchesPerWorkerDay, "高档白酒工时为普通的 1/3");
});

test("一工日产值与原酒坊（约 54 券）同量级：每工日产值 54—90 券（批发售价计）", () => {
  for (const [buildingId, recipeId] of Object.entries(RECIPE_OF)) {
    const recipe = CONTENT.recipes[recipeId];
    const out = recipe.outputs[0];
    const perWorkerDayJin = recipe.batchesPerWorkerDay * out.quantity;
    const price = CONTENT.rules.wholesaleDefaultSalePrices[out.itemId];
    const value = perWorkerDayJin * price;
    assert.ok(value >= 54 && value <= 90, `${buildingId} 一工日产 ${perWorkerDayJin} 斤 × ${price} = ${value.toFixed(1)} 券，应在 54—90 之间`);
  }
});

test("批发价：收购价约为售价的 0.78—0.8，高档约为普通的 2.5—3 倍", () => {
  const sale = CONTENT.rules.wholesaleDefaultSalePrices;
  const purchase = CONTENT.rules.wholesaleDefaultPurchasePrices;
  for (const id of LIQUORS) {
    const ratio = purchase[id] / sale[id];
    assert.ok(ratio >= 0.75 && ratio <= 0.82, `${id} 收购/售价 ${ratio.toFixed(3)}`);
  }
  assert.ok(sale.beer_premium / sale.beer >= 2.5 && sale.beer_premium / sale.beer <= 3, "高档啤酒约 2.5—3 倍");
  assert.ok(sale.baijiu_premium / sale.baijiu >= 2.5 && sale.baijiu_premium / sale.baijiu <= 3, "高档白酒约 2.5—3 倍");
});

test("建筑：四栋酒坊各跑一个配方，都有 jobs、带 industryTier、岗位 id 与产出角色对得上", () => {
  for (const [buildingId, recipeId] of Object.entries(RECIPE_OF)) {
    const b = CONTENT.buildings[buildingId];
    assert.ok(b, `${buildingId} 存在`);
    assert.equal(b.recipeId, recipeId);
    assert.equal(b.industryTier, 1, "加工产业");
    assert.ok(Array.isArray(b.jobs) && b.jobs.length, `${buildingId} 有岗位`);
    assert.ok(b.jobs.some(job => job.id === b.productionRoleId), `${buildingId} 产出角色是它的岗位`);
  }
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

test("开局新游戏 validateState 通过；四栋酒坊建成并派工后 10 天，四种酒都有产出且状态合法", () => {
  const state = simulation.createInitialState({ seed: 7711 });
  const plots = state.plots.filter(p => !p.feature);
  const typeIds = ["wholesale_market", "brewery", "craft_brewery", "winery", "premium_winery"];
  typeIds.forEach((typeId, i) => {
    state.buildings.push({ id: `${typeId}-t`, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
      plotId: plots[i].id, x: plots[i].x, y: plots[i].y, materialInvestments: [], completed: { year: 1, day: 1 } });
  });
  state.accounts.town.wood += 5000 * I;
  simulation.setEmployment(state, "brewery-t::beer_brewers", 2);
  simulation.setEmployment(state, "craft_brewery-t::craft_brewers", 2);
  simulation.setEmployment(state, "winery-t::brewers", 2);
  simulation.setEmployment(state, "premium_winery-t::cellar_brewers", 2);
  simulation.setEmployment(state, `wholesale_market-t::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 1);
  simulation.advanceDays(state, 10);
  const stock = id => (state.wholesaleMarket?.inventory?.[id] || 0) + (state.accounts.town[id] || 0);
  for (const id of LIQUORS) assert.ok(stock(id) > 0, `${id} 应有产出`);
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, v.errors.join("；"));
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
