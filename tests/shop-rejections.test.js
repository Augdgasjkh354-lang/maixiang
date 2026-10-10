import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { sellShopProduct } from "../src/systems/shops.js";
import { purchaseItemForResidents } from "../src/systems/consumer-market.js";
import { householdList, isActiveHousehold } from "../src/systems/households.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

// 与 shop-customers.test.js 的 town() 同口径：银行、批发市场、商业街，货币改革后开综合商店。
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
  return { state, shopId: store.shopId };
}

function fund(state, householdId, voucher = 500) {
  const r = grantResidentVouchers(state, voucher, CONTENT, householdId);
  assert.equal(r.ok, true, r.reason);
}

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

// 只让指定家庭有需求（其余家庭需求为 0），模拟"几户各缺若干斤"的当日情形。
function needs(state, map) {
  const out = {};
  for (const household of householdList(state).filter(isActiveHousehold)) out[household.id] = map[household.id] || 0;
  return out;
}

function sellOutFlour(state, shopId) {
  state.shops[shopId].inventory.flour = 0;
}

function rejected(state, shopId) {
  return state.shops[shopId].accounts.day.rejectedCustomerCount || 0;
}

test("一户缺 10 斤面粉，店铺断货：拒客 +1（不是按单位折算的 +5）", () => {
  const { state, shopId } = town(7401);
  const hid = householdList(state).filter(isActiveHousehold)[0].id;
  fund(state, hid);
  sellOutFlour(state, shopId);
  const shop = state.shops[shopId];
  const before = rejected(state, shopId);
  const result = purchaseItemForResidents(state, "flour", 10 * I, 1, CONTENT, "测试",
    { householdNeedsUnits: needs(state, { [hid]: 10 * I }) });
  assert.equal(result.purchasedUnits, 0);
  assert.equal(rejected(state, shopId) - before, 1);
  assert.equal(shop.accounts.day.rejectedHouseholds?.[hid], true);
  valid(state);
});

test("三户各缺面粉：拒客 +3", () => {
  const { state, shopId } = town(7402);
  const hids = householdList(state).filter(isActiveHousehold).slice(0, 3).map(h => h.id);
  for (const hid of hids) fund(state, hid);
  sellOutFlour(state, shopId);
  const map = Object.fromEntries(hids.map(hid => [hid, 10 * I]));
  const before = rejected(state, shopId);
  purchaseItemForResidents(state, "flour", 30 * I, 1, CONTENT, "测试", { householdNeedsUnits: needs(state, map) });
  assert.equal(rejected(state, shopId) - before, 3);
  valid(state);
});

test("同一家庭缺多样商品只记一次拒客", () => {
  const { state, shopId } = town(7403);
  const hid = householdList(state).filter(isActiveHousehold)[0].id;
  fund(state, hid);
  sellOutFlour(state, shopId);
  state.shops[shopId].inventory.wine = 0;
  const before = rejected(state, shopId);
  purchaseItemForResidents(state, "flour", 10 * I, 1, CONTENT, "测试", { householdNeedsUnits: needs(state, { [hid]: 10 * I }) });
  purchaseItemForResidents(state, "wine", 10 * I, 1, CONTENT, "测试", { householdNeedsUnits: needs(state, { [hid]: 10 * I }) });
  assert.equal(rejected(state, shopId) - before, 1);
  valid(state);
});

test("当日已在本店买过东西的家庭，缺另一样时不算拒客", () => {
  const { state, shopId } = town(7404);
  const hid = householdList(state).filter(isActiveHousehold)[0].id;
  fund(state, hid);
  const sale = sellShopProduct(state, shopId, `household:${hid}`, I, CONTENT, "测试", "salt");
  assert.equal(sale.ok, true, sale.reason);
  sellOutFlour(state, shopId);
  const before = rejected(state, shopId);
  purchaseItemForResidents(state, "flour", 10 * I, 1, CONTENT, "测试", { householdNeedsUnits: needs(state, { [hid]: 10 * I }) });
  assert.equal(rejected(state, shopId), before);
  assert.equal(state.shops[shopId].accounts.day.rejectedHouseholds?.[hid], undefined);
  valid(state);
});

test("先缺货被拒、之后同日又在本店成交的家庭，拒客撤销", () => {
  const { state, shopId } = town(7405);
  const hid = householdList(state).filter(isActiveHousehold)[0].id;
  fund(state, hid);
  sellOutFlour(state, shopId);
  purchaseItemForResidents(state, "flour", 10 * I, 1, CONTENT, "测试", { householdNeedsUnits: needs(state, { [hid]: 10 * I }) });
  assert.equal(rejected(state, shopId), 1);
  const sale = sellShopProduct(state, shopId, `household:${hid}`, I, CONTENT, "测试", "salt");
  assert.equal(sale.ok, true, sale.reason);
  assert.equal(rejected(state, shopId), 0);
  assert.equal(state.shops[shopId].accounts.day.customerCount, 1);
  valid(state);
});

test("断货的单位缺口仍记入 stockoutUnits，拒客按户计", () => {
  const { state, shopId } = town(7406);
  const hid = householdList(state).filter(isActiveHousehold)[0].id;
  fund(state, hid);
  sellOutFlour(state, shopId);
  const shop = state.shops[shopId];
  purchaseItemForResidents(state, "flour", 10 * I, 1, CONTENT, "测试", { householdNeedsUnits: needs(state, { [hid]: 10 * I }) });
  assert.ok((shop.accounts.day.stockoutUnits?.flour || 0) > 0, "断货单位应记入 stockoutUnits");
  assert.ok(shop.accounts.day.stockoutUnits.flour <= 10 * I);
  assert.equal(rejected(state, shopId), 1);
  valid(state);
});
