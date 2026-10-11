// 酒馆（商业街新店型，与综合商店同规则）与酒类专售令（policy.liquorMonopoly）。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { shopDailyCustomerCapacity, shopDefinition } from "../src/systems/shops.js";
import { shopMayStockItem, usesGeneralRules } from "../src/systems/shop-types.js";
import { isDynamicPricingShop } from "../src/systems/shop-pricing.js";
import { migrateSave } from "../src/persistence/migrations.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const LIQUORS = ["beer", "beer_premium", "baijiu", "baijiu_premium"];

// 银行、批发市场、商业街、一座酒坊（已派工）；市场备足四种酒；综合商店与酒馆各开一家，店员各 3 人。
function world(seed, { tavern = true } = {}) {
  const state = simulation.createInitialState({ seed });
  const plots = state.plots.filter(p => !p.feature);
  let n = 0;
  const add = typeId => {
    const p = plots[n++];
    const id = `${typeId}-t`;
    state.buildings.push({ id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: p.id, x: p.x, y: p.y, materialInvestments: [], completed: { year: 1, day: 1 } });
    return id;
  };
  add("bank");
  const market = add("wholesale_market");
  const street = add("commercial_street");
  const winery = add("winery");
  simulation.setEmployment(state, `${market}::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  simulation.setEmployment(state, `${winery}::brewers`, 8);
  grantResidentVouchers(state, 300000);
  const general = simulation.openResidentShop(state, street, "general");
  assert.equal(general.ok, true, general.reason);
  const shops = { general: general.shopId };
  if (tavern) {
    const opened = simulation.openResidentShop(state, street, "tavern");
    assert.equal(opened.ok, true, opened.reason);
    shops.tavern = opened.shopId;
  }
  issueTownVouchers(state, 5000 * V, CONTENT, "测试");
  for (const shopId of Object.values(shops)) {
    transferVouchers(state, "town", `shop:${shopId}`, 3000 * V, CONTENT, "test", "测试商店资金");
    simulation.configureShopClerks(state, shopId, 3);
  }
  for (const itemId of LIQUORS) state.wholesaleMarket.inventory[itemId] = 4000 * I;
  return { state, street, shops };
}

function soldLiquors(state, shopId) {
  const sold = state.shops[shopId]?.accounts?.cumulative?.soldUnits || {};
  return LIQUORS.reduce((sum, id) => sum + (sold[id] || 0), 0);
}

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

test("酒馆店型：零售店，只卖四种酒，与综合商店同规则（动态加价、接待能力、店员上限）", () => {
  const tavern = CONTENT.rules.shopTypes.tavern;
  assert.equal(tavern.kind, "retail");
  assert.deepEqual([...tavern.itemIds].sort(), [...LIQUORS].sort(), "货架只有四种酒");
  assert.equal(tavern.hostBuildingTypeId, undefined, "默认开在商业街");
  assert.equal(usesGeneralRules(tavern), true);
  assert.equal(usesGeneralRules(CONTENT.rules.shopTypes.general), true);
  assert.equal(usesGeneralRules(CONTENT.rules.shopTypes.tea), false, "服务店不同规则");
  const { state, shops } = world(8101);
  assert.equal(isDynamicPricingShop(state.shops[shops.tavern], CONTENT), true, "酒馆动态调价");
  assert.equal(isDynamicPricingShop(state.shops[shops.general], CONTENT), true);
  assert.equal(shopDailyCustomerCapacity(state, state.shops[shops.tavern], CONTENT), shopDailyCustomerCapacity(state, state.shops[shops.general], CONTENT),
    "同样的店员数，接待能力相同");
  valid(state);
});

test("开酒馆走商业街（与综合商店同流程，占店位）；酒馆进货只从批发市场，居民买酒有销量", () => {
  const { state, shops } = world(8102);
  simulation.advanceDays(state, 40);
  const tavern = state.shops[shops.tavern];
  assert.equal(tavern.typeId, "tavern");
  assert.deepEqual([...tavern.itemIds].sort(), [...LIQUORS].sort());
  assert.ok(LIQUORS.some(id => (tavern.inventory[id] || 0) > 0 || (tavern.accounts.cumulative.soldUnits?.[id] || 0) > 0), "酒馆进了货");
  assert.ok(soldLiquors(state, shops.tavern) > 0, "居民在酒馆买过酒");
  valid(state);
});

test("专售令开关：布尔校验、无酒馆时需确认、开启/关闭写入 policy", () => {
  const { state } = world(8103, { tavern: false });
  assert.equal(state.policy.liquorMonopoly, false, "默认关");
  assert.equal(simulation.setLiquorMonopoly(state, "yes").ok, false, "非布尔拒绝");
  const first = simulation.setLiquorMonopoly(state, true);
  assert.equal(first.ok, false);
  assert.equal(first.needsConfirm, true, "没有酒馆时开启要确认");
  assert.equal(state.policy.liquorMonopoly, false, "未确认不改");
  const second = simulation.setLiquorMonopoly(state, true, { confirmed: true });
  assert.equal(second.ok, true);
  assert.equal(state.policy.liquorMonopoly, true);
  assert.equal(simulation.setLiquorMonopoly(state, false).ok, true, "关闭不需要确认");
  assert.equal(state.policy.liquorMonopoly, false);
  state.policy.liquorMonopoly = "yes";
  assert.ok(simulation.validateState(state).errors.some(message => message.includes("酒类专售令")), "校验报出非布尔");
});

test("专售令开启后：综合商店与时代广场不经营酒，居民买酒只去酒馆；关闭后恢复", () => {
  const { state, shops } = world(8104);
  simulation.advanceDays(state, 20);
  assert.ok(soldLiquors(state, shops.general) > 0, "开令前综合商店也卖酒");
  assert.equal(simulation.setLiquorMonopoly(state, true).ok, true, "有酒馆，直接开启");
  const generalBefore = soldLiquors(state, shops.general);
  const tavernBefore = soldLiquors(state, shops.tavern);
  simulation.advanceDays(state, 20);
  assert.equal(soldLiquors(state, shops.general), generalBefore, "综合商店不再卖酒");
  assert.ok(soldLiquors(state, shops.tavern) > tavernBefore, "酒馆照常卖酒");
  valid(state);
  // 时代广场（集市）：不经营酒。
  const stall = { id: "stall", kind: "stall" };
  for (const itemId of LIQUORS) assert.equal(shopMayStockItem(state, stall, itemId, CONTENT), false, `集市不得卖${itemId}`);
  assert.equal(shopMayStockItem(state, shopDefinition(CONTENT, "tavern"), "baijiu", CONTENT), true, "酒馆可卖酒");
  assert.equal(shopMayStockItem(state, shopDefinition(CONTENT, "general"), "flour", CONTENT), true, "专售令不影响其他商品");
  // 关闭后恢复。
  simulation.setLiquorMonopoly(state, false);
  const generalAfter = soldLiquors(state, shops.general);
  simulation.advanceDays(state, 30);
  assert.ok(soldLiquors(state, shops.general) > generalAfter, "关闭专售令后综合商店恢复卖酒");
  valid(state);
});

test("无酒馆时开启专售令：居民买酒的需求落空（不报错），状态合法", () => {
  const { state, shops } = world(8105, { tavern: false });
  simulation.setLiquorMonopoly(state, true, { confirmed: true });
  simulation.advanceDays(state, 15);
  assert.equal(soldLiquors(state, shops.general), 0, "没有任何店卖酒");
  valid(state);
});

test("旧档没有 liquorMonopoly 字段：读档后为 false", () => {
  const { state } = world(8106, { tavern: false });
  const raw = JSON.parse(JSON.stringify(state));
  delete raw.policy.liquorMonopoly;
  const loaded = migrateSave(raw, CONTENT);
  assert.equal(loaded.policy.liquorMonopoly, false);
  valid(loaded);
});
