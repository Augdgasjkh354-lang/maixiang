import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { shopSalesCapacityUnits, stallItemIds } from "../src/systems/shops.js";
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
  assert.equal(state.monetaryReform.stage, "voucher"); // 开局即粮券阶段
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
  // 肉是主食：居民买肉走主食口径（market.js），综合商店只卖给居民，卖出即居民买到。
  assert.ok((state.shops[storeId].accounts.cumulative.soldUnits?.pork || 0) > 0, "商店卖出猪肉（居民买到）");
  valid(state);
});

test("养殖场按商店缺口加人：需求大于一人产量时会雇饲养员", () => {
  const { state, base } = town(6103, { square: false });
  const id = simulation.openResidentShop(state, base, "pig_farm").shopId;
  simulation.advanceDays(state, 40);
  const hands = Object.values(state.households.byId).reduce((sum, h) => sum + (h.jobs?.[`shop:${id}:clerk`] || 0), 0);
  assert.ok(hands >= 2, `猪肉需求约 ${Math.round(3300 * 8 / CONTENT.rules.daysPerYear)} 斤/日，应雇多名饲养员，实际 ${hands}`);
});

function keepersOf(state, shop) {
  return Object.values(state.households.byId).reduce((sum, h) => sum + (h.jobs?.[`shop:${shop.id}:merchant`] || 0), 0);
}

function collective(state) {
  return Object.values(state.shops).find(s => s.typeId === "stall" && s.collective);
}

test("时代广场：一个集体集市，只卖日用品和肉、与商店同价、每人每日最多 25 斤、按摊交租", () => {
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
  assert.equal(stallPrice, storePrice, `集市价 ${stallPrice} 应与商店价 ${storePrice} 相同（stallUndercutPercent 为 0）`);
  for (let day = 0; day < 15; day++) {
    const keepers = keepersOf(state, market); // 摊租按早上在摊的人数收
    simulation.advanceDay(state);
    const sold = Object.values(market.accounts.day.soldUnits || {}).reduce((a, b) => a + b, 0);
    assert.ok(sold <= keepers * 25 * I + 1, "每人每日最多 25 斤");
    assert.ok(Object.keys(market.accounts.day.soldUnits || {}).every(itemId => stallItemIds(CONTENT).includes(itemId)), "只卖日用品和肉");
    assert.equal(market.accounts.day.rentExpenseVoucherUnits || 0, Math.ceil(keepers / 2) * 2 * V, "按占用摊位交租，每摊 2");
  }
  assert.ok((market.accounts.cumulative.soldUnits?.wine || 0) > 0, "集市卖出了酒");
  valid(state);
});

test("集市利润按人头 ×0.8—1.2 随机分给摆摊家庭；摆摊人数不超过允许人数", () => {
  const { state } = town(6105);
  state.wholesaleMarket.inventory.wine = 50000 * I;
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

test("肉是主食：四种肉不再是日用品，都在综合商店货架上，吃了加 meatComfort 且计入口粮", () => {
  for (const itemId of MEATS) {
    assert.equal(CONTENT.rules.householdGoods[itemId], undefined, `${itemId} 不应再是日用品`);
    assert.ok(CONTENT.rules.shopTypes.general.itemIds.includes(itemId), itemId);
    assert.equal(CONTENT.items[itemId].edible, true, itemId);
    assert.equal(CONTENT.items[itemId].category, "food", itemId);
    assert.deepEqual(CONTENT.items[itemId].qeq, { numerator: 2, denominator: 1 }, `${itemId} 1 斤顶 2 斤口粮`);
  }
  const { state, base, storeId } = town(6111, { square: false });
  simulation.openResidentShop(state, base, "chicken_farm");
  simulation.advanceDays(state, 40);
  const comforts = Object.values(state.households.byId).map(h => h.life?.lastFactors?.meatComfort || 0);
  assert.ok(comforts.some(v => v > 0), "吃到肉的家庭应有 meatComfort 舒心值");
  assert.ok(comforts.every(v => v <= CONTENT.rules.meatStaple.comfortMaximum + 1e-9), "meatComfort 不超过上限");
  assert.ok((state.shops[storeId].accounts.cumulative.soldUnits?.chicken || 0) > 0, "综合商店卖出鸡肉");
  valid(state);
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

test("集市免租：三个月/半年/一年/三年，免租期内不交摊租，到期恢复；只能选这四档", () => {
  const { state } = town(6109);
  state.wholesaleMarket.inventory.wine = 3000 * I;
  assert.equal(simulation.setStallRentFree(state, 45).ok, false);
  assert.equal(simulation.setStallRentFree(state, 90).ok, true);
  simulation.advanceDays(state, 10);
  const market = collective(state);
  assert.equal(market.accounts.cumulative.rentExpenseVoucherUnits || 0, 0, "免租期内不交租");
  assert.ok((market.accounts.cumulative.rentWaivedVoucherUnits || 0) > 0, "记下免掉的租");
  assert.equal(simulation.setStallRentFree(state, 0).ok, true, "可以取消");
  simulation.advanceDays(state, 5);
  assert.ok((market.accounts.cumulative.rentExpenseVoucherUnits || 0) > 0, "取消后恢复收租");
  for (const days of CONTENT.rules.stallRentFreeOptionsDays.slice(1)) assert.equal(simulation.setStallRentFree(state, days).ok, true);
  valid(state);
});

test("集市批发特价三档：进价每斤少 0.1/0.2/0.4，差价记为补贴；售价与综合商店同价、不低于进价", () => {
  const { state } = town(6110);
  state.wholesaleMarket.inventory.wine = 3000 * I;
  simulation.advanceDays(state, 2);
  const market = collective(state);
  const store = Object.values(state.shops).find(s => s.typeId === "general");
  const list = shopTradePrices(state, "stall", CONTENT, "wine", market).listWholesaleVoucherPerUnit;
  for (const [tier, cut] of [[0, 0], [1, 0.1], [2, 0.2], [3, 0.4]]) {
    assert.equal(simulation.setStallDiscountTier(state, tier).ok, true);
    const prices = shopTradePrices(state, "stall", CONTENT, "wine", market);
    assert.ok(Math.abs(prices.wholesaleVoucherPerUnit - (list - cut)) < 1e-9, `第${tier}档进价`);
    const storePrice = shopTradePrices(state, "general", CONTENT, "wine", store).retailVoucherPerUnit;
    // 集市售价跟综合商店同价（stallUndercutPercent 为 0），特价再低也不低于进价。
    assert.ok(Math.abs(prices.retailVoucherPerUnit - storePrice) < 1e-9, `第${tier}档售价 ${prices.retailVoucherPerUnit} 应与商店价 ${storePrice} 相同`);
    assert.ok(prices.retailVoucherPerUnit >= prices.wholesaleVoucherPerUnit);
  }
  assert.equal(simulation.setStallDiscountTier(state, 4).ok, false);
  simulation.advanceDays(state, 10);
  assert.ok((market.accounts.cumulative.subsidyVoucherUnits || 0) > 0, "特价进货记了补贴");
  valid(state);
});
