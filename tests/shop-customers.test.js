import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { sellShopProduct, shopDailyCustomerCapacity, resetShopDaily } from "../src/systems/shops.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

// 与 livestock-stalls.test.js 的 town() 同口径：银行、批发市场、商业街，货币改革后开综合商店。
function town(seed) {
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
  simulation.setEmployment(state, `${market}::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  assert.equal(state.monetaryReform.stage, "voucher"); // 开局即粮券阶段
  grantResidentVouchers(state, 300000);
  const store = simulation.openResidentShop(state, street, "general");
  assert.equal(store.ok, true, store.reason);
  issueTownVouchers(state, 5000 * V, CONTENT, "测试");
  transferVouchers(state, "town", `shop:${store.shopId}`, 5000 * V, CONTENT, "test", "测试商店资金");
  simulation.configureShopClerks(state, store.shopId, 0);
  const shop = state.shops[store.shopId];
  for (const itemId of ["salt", "flour", "wine", "pork"]) shop.inventory[itemId] = 1000 * I;
  return { state, shopId: store.shopId, ownerId: shop.ownerHouseholdId };
}

function fund(state, householdId, voucher = 500) {
  const r = grantResidentVouchers(state, voucher, CONTENT, householdId);
  assert.equal(r.ok, true, r.reason);
}

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

test("同一家庭当日在综合商店买多样商品，只算一个客人", () => {
  const { state, shopId } = town(7301);
  const hid = Object.keys(state.households.byId)[0];
  fund(state, hid);
  const shop = state.shops[shopId];
  for (const itemId of ["salt", "flour", "wine"]) {
    const sale = sellShopProduct(state, shopId, `household:${hid}`, I, CONTENT, "测试", itemId);
    assert.equal(sale.ok, true, sale.reason);
  }
  assert.equal(shop.accounts.day.customerCount, 1);
  assert.equal(shop.accounts.year.customerCount, 1);
  assert.equal(shop.accounts.cumulative.customerCount, 1);
  valid(state);
});

test("两个家庭各买一次，客人数为 2", () => {
  const { state, shopId } = town(7302);
  const [a, b] = Object.keys(state.households.byId);
  fund(state, a);
  fund(state, b);
  assert.equal(sellShopProduct(state, shopId, `household:${a}`, I, CONTENT, "测试", "salt").ok, true);
  assert.equal(sellShopProduct(state, shopId, `household:${a}`, I, CONTENT, "测试", "pork").ok, true);
  assert.equal(sellShopProduct(state, shopId, `household:${b}`, I, CONTENT, "测试", "salt").ok, true);
  assert.equal(state.shops[shopId].accounts.day.customerCount, 2);
  valid(state);
});

test("客流满后，新家庭被拒；已计入的家庭仍可继续购买", () => {
  const { state, shopId } = town(7303);
  const shop = state.shops[shopId];
  const capacity = shopDailyCustomerCapacity(state, shop, CONTENT);
  assert.ok(capacity > 0 && capacity < 200, `容量应为小正数，实际 ${capacity}`);
  const ids = Object.keys(state.households.byId).slice(0, capacity + 1);
  assert.equal(ids.length, capacity + 1, "测试需要足够的家庭");
  for (const hid of ids) fund(state, hid);

  for (const hid of ids.slice(0, capacity)) {
    assert.equal(sellShopProduct(state, shopId, `household:${hid}`, I, CONTENT, "测试", "salt").ok, true);
  }
  assert.equal(shop.accounts.day.customerCount, capacity);

  const rejectedBefore = shop.accounts.day.rejectedCustomerCount;
  const newcomer = ids[capacity];
  const refused = sellShopProduct(state, shopId, `household:${newcomer}`, I, CONTENT, "测试", "salt");
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /客流接待能力已满/);
  assert.equal(shop.accounts.day.customerCount, capacity, "被拒的新家庭不计入客人");
  assert.equal(shop.accounts.day.rejectedCustomerCount, rejectedBefore + 1, "新家庭被拒记一次拒客");

  // 同一被拒家庭当日再试，不重复计拒客。
  assert.equal(sellShopProduct(state, shopId, `household:${newcomer}`, I, CONTENT, "测试", "pork").ok, false);
  assert.equal(shop.accounts.day.rejectedCustomerCount, rejectedBefore + 1);

  // 已计入的家庭在客流满后仍能再买其他商品。
  const returning = ids[0];
  const again = sellShopProduct(state, shopId, `household:${returning}`, I, CONTENT, "测试", "flour");
  assert.equal(again.ok, true, again.reason);
  assert.equal(shop.accounts.day.customerCount, capacity, "回头客不重复计数");
  valid(state);
});

test("次日重置后客流从零重算；归档行只存数字，不存家庭集合", () => {
  const { state, shopId } = town(7304);
  const shop = state.shops[shopId];
  const hid = Object.keys(state.households.byId)[0];
  fund(state, hid);
  sellShopProduct(state, shopId, `household:${hid}`, I, CONTENT, "测试", "salt");
  sellShopProduct(state, shopId, `household:${hid}`, I, CONTENT, "测试", "wine");
  assert.ok(shop.accounts.day.customerHouseholds?.[hid]);

  state.day += 1;
  resetShopDaily(state, CONTENT);
  assert.equal(shop.accounts.day.customerCount, 0);
  assert.equal(shop.accounts.day.customerHouseholds, undefined, "新一天的账本不带上一日的家庭集合");
  const row = shop.history.at(-1);
  assert.equal(typeof row.customerCount, "number");
  assert.equal(row.customerCount, 1);
  assert.equal(row.customerHouseholds, undefined);
  valid(state);
});
