import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { shopSalesCapacityUnits } from "../src/systems/shops.js";
import { shopTradePrices } from "../src/economy/operating-plan.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const MEATS = ["chicken", "duck", "goose", "pork"];

function town(seed, { square = true } = {}) {
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
  const base = add("livestock_base");
  const plaza = square ? add("times_square") : null;
  simulation.setEmployment(state, `${market}::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  assert.equal(simulation.startCurrencyReform(state).ok, true);
  grantResidentVouchers(state, 300000);
  const store = simulation.openResidentShop(state, street, "general");
  assert.equal(store.ok, true, store.reason);
  issueTownVouchers(state, 5000 * V, CONTENT, "测试");
  transferVouchers(state, "town", `shop:${store.shopId}`, 5000 * V, CONTENT, "test", "测试商店资金");
  simulation.configureShopClerks(state, store.shopId, 10);
  return { state, street, base, plaza, storeId: store.shopId };
}

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

test("养殖场只能开在养殖基地，每级 4 个场位", () => {
  const { state, street, base } = town(6101, { square: false });
  assert.equal(simulation.openResidentShop(state, street, "pig_farm").ok, false);
  for (const typeId of ["chicken_farm", "duck_farm", "goose_farm", "pig_farm"]) {
    const opened = simulation.openResidentShop(state, base, typeId);
    assert.equal(opened.ok, true, opened.reason);
  }
  const fifth = simulation.openResidentShop(state, base, "pig_farm");
  assert.equal(fifth.ok, false);
  assert.match(fifth.reason, /养殖基地没有空位/);
});

test("养殖场喂小麦出肉，直接卖给综合商店，居民买到肉；钱货守恒、状态合法", () => {
  const { state, base, storeId } = town(6102, { square: false });
  const farms = ["chicken_farm", "pig_farm"].map(typeId => simulation.openResidentShop(state, base, typeId).shopId);
  simulation.advanceDays(state, 40);
  for (const id of farms) {
    const farm = state.shops[id];
    const product = CONTENT.rules.shopTypes[farm.typeId].productItemId;
    assert.ok((farm.accounts.cumulative.producedUnits?.[product] || 0) > 0, `${farm.name}应产肉`);
    assert.ok((farm.accounts.cumulative.consumedUnits?.wheat || 0) > 0, `${farm.name}应耗饲料`);
    assert.ok((farm.accounts.cumulative.storeSoldUnits?.[product] || 0) > 0, `${farm.name}应卖给商店`);
  }
  assert.ok((state.shops[storeId].accounts.cumulative.soldUnits?.pork || 0) > 0, "商店卖出猪肉");
  assert.ok((state.goodsDemand.year.purchasedUnits?.pork || 0) > 0, "居民买到猪肉");
  valid(state);
});

test("养殖场按商店缺口加人：需求大于一人产量时会雇饲养员", () => {
  const { state, base } = town(6103, { square: false });
  const id = simulation.openResidentShop(state, base, "pig_farm").shopId;
  simulation.advanceDays(state, 40);
  const hands = Object.values(state.households.byId).reduce((sum, h) => sum + (h.jobs?.[`shop:${id}:clerk`] || 0), 0);
  assert.ok(hands >= 2, `猪肉需求约 ${Math.round(3300 * 8 / 365)} 斤/日，应雇多名饲养员，实际 ${hands}`);
});

function keepersOf(state, shop) {
  return Object.values(state.households.byId).reduce((sum, h) => sum + (h.jobs?.[`shop:${shop.id}:merchant`] || 0), 0);
}

function collective(state) {
  return Object.values(state.shops).find(s => s.typeId === "stall" && s.collective);
}

test("时代广场：一个集体集市，只卖日用品、比商店便宜、每人每日最多 25 斤、按摊交租", () => {
  const { state, plaza } = town(6104);
  state.wholesaleMarket.inventory.wine = 2000 * I;
  assert.ok(!simulation.openResidentShop(state, plaza, "general").ok, "时代广场不能开综合商店");
  simulation.advanceDays(state, 2);
  const stalls = Object.values(state.shops).filter(s => s.typeId === "stall");
  assert.equal(stalls.length, 1, "一座广场只有一个集体集市");
  const market = stalls[0];
  assert.equal(market.collective, true);
  assert.equal(state.policy.stallRentVoucher, 2);
  const stallPrice = shopTradePrices(state, "stall", CONTENT, "wine", market).retailVoucherPerUnit;
  const storePrice = shopTradePrices(state, "general", CONTENT, "wine", Object.values(state.shops).find(s => s.typeId === "general")).retailVoucherPerUnit;
  assert.ok(stallPrice < storePrice, `集市价 ${stallPrice} 应低于商店价 ${storePrice}`);
  for (let day = 0; day < 15; day++) {
    const keepers = keepersOf(state, market); // 摊租按早上在摊的人数收
    simulation.advanceDay(state);
    const sold = Object.values(market.accounts.day.soldUnits || {}).reduce((a, b) => a + b, 0);
    assert.ok(sold <= keepers * 25 * I + 1, "每人每日最多 25 斤");
    assert.ok(Object.keys(market.accounts.day.soldUnits || {}).every(itemId => CONTENT.rules.householdGoods[itemId]), "只卖日用品");
    assert.equal(market.accounts.day.rentExpenseVoucherUnits || 0, Math.ceil(keepers / 2) * 2 * V, "按占用摊位交租，每摊 2");
  }
  assert.ok((market.accounts.cumulative.soldUnits?.wine || 0) > 0, "集市卖出了酒");
  valid(state);
});

test("集市利润按人头 ×0.8—1.2 随机分给摆摊家庭；摆摊人数不超过允许人数", () => {
  const { state } = town(6105);
  state.wholesaleMarket.inventory.wine = 5000 * I;
  state.wholesaleMarket.inventory.cloth = 500 * I;
  assert.equal(simulation.setStallKeeperLimit(state, 6).ok, true);
  const before = new Map(Object.values(state.households.byId).map(h => [h.id, h.voucherUnits || 0]));
  simulation.advanceDays(state, 40);
  const market = collective(state);
  assert.ok(keepersOf(state, market) > 0 && keepersOf(state, market) <= 6);
  assert.ok((market.accounts.cumulative.distributedVoucherUnits || 0) > 0, "利润分给了摆摊家庭");
  const payout = market.plan.lastPayout;
  assert.ok(payout && payout.maxPerKeeperUnits <= payout.minPerKeeperUnits * 1.5 + 1, "各户每人所得相差不超过 0.8—1.2 的范围");
  assert.ok(before.size > 0);
  simulation.setStallKeeperLimit(state, 0);
  simulation.advanceDays(state, 1);
  assert.equal(keepersOf(state, market), 0, "允许人数为 0 时没人摆摊");
  valid(state);
});

test("旧档里按户开的摊位读档后收摊清算，换成集体集市", () => {
  const { state, plaza } = town(6107);
  state.wholesaleMarket.inventory.wine = 2000 * I;
  const household = Object.values(state.households.byId).find(h => (h.voucherUnits || 0) > 500 * V);
  const legacyId = "shop-legacy";
  state.shops[legacyId] = { ...structuredClone(state.shops[Object.keys(state.shops)[0]]), id: legacyId, name: "旧摊", typeId: "stall", buildingId: plaza,
    collective: undefined, ownerHouseholdId: household.id, cashVoucherUnits: 0, cashWheatUnits: 0, inventory: {}, inventoryCostVoucherUnits: {}, history: [] };
  simulation.advanceDays(state, 3);
  assert.ok(!state.shops[legacyId], "旧摊清算完删档");
  assert.ok(collective(state), "建了集体集市");
  valid(state);
});

test("摊租可调，负数被拒", () => {
  const state = simulation.createInitialState({ seed: 6106 });
  assert.equal(simulation.setStallRent(state, 3.5).ok, true);
  assert.equal(state.policy.stallRentVoucher, 3.5);
  assert.equal(simulation.setStallRent(state, -1).ok, false);
  assert.equal(simulation.setStallKeeperLimit(state, -2).ok, false);
});

test("肉是日用品：吃了加舒心值，四种肉都在综合商店货架上", () => {
  for (const itemId of MEATS) {
    assert.ok(CONTENT.rules.householdGoods[itemId], itemId);
    assert.ok(CONTENT.rules.shopTypes.general.itemIds.includes(itemId), itemId);
  }
});

test("拆除时代广场：集市自动结束，余钱和货不凭空消失，状态合法", () => {
  const { state, plaza } = town(6108);
  state.wholesaleMarket.inventory.wine = 2000 * I;
  simulation.advanceDays(state, 10);
  assert.ok(collective(state));
  const preview = simulation.selectDemolitionPreview ? simulation.selectDemolitionPreview(state, plaza) : null;
  if (preview) assert.equal(preview.available, true, preview.reason);
  const result = simulation.demolishBuilding(state, plaza);
  assert.equal(result.ok, true, result.reason);
  assert.ok(!collective(state), "集市已结束");
  assert.ok(Object.values(state.households.byId).every(h => !Object.keys(h.jobs || {}).some(key => key.includes(":merchant") && !state.shops[key.split(":")[1]])), "摊贩都回到待业");
  valid(state);
  simulation.advanceDays(state, 2);
  valid(state);
});
