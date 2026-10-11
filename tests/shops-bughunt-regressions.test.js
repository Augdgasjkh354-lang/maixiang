import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdIdleWorkers, householdList, setJobCount } from "../src/systems/households.js";
import { collectiveStranded, refundCollectiveIfStranded } from "../src/systems/shops.js";
import { payTariff } from "../src/systems/trading-houses.js";
import { addPaymentObligation, currentPaymentComposition } from "../src/economy/payment.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;

function valid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true, `${label} 货币账不平`);
}

function freePlot(state) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => !row.feature && !used.has(row.id));
  assert.ok(plot, "需要空地");
  return plot;
}

function addBuilding(state, typeId, id) {
  const plot = freePlot(state);
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return id;
}

function serialNow(state) {
  return (Math.max(1, state.year || 1) - 1) * CONTENT.rules.daysPerYear + (state.day || 0);
}

function generalShopWithCash(seed, cashVoucher) {
  const state = legacyVoucherState({ seed });
  const street = addBuilding(state, "commercial_street", "fix-street");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.ok(owner, "需要一户有空闲劳力的店主");
  assert.equal(grantResidentVouchers(state, 3000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street, "general", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, 0).assigned, 0);
  issueTownVouchers(state, 5000 * V, CONTENT, "测试");
  if (cashVoucher > 0) transferVouchers(state, "town", `shop:${opened.shopId}`, cashVoucher * V, CONTENT, "test", "测试店资金");
  return { state, shop: state.shops[opened.shopId] };
}

test("关税付不起的欠款同步登记支付构成，之后日结能收回（不被旧的空支付构成压成 0）", () => {
  const { state, shop } = generalShopWithCash(5, 100);
  const cashBefore = shop.cashVoucherUnits;
  assert.ok(cashBefore > 0 && cashBefore < 300 * V, "测试前提：店里现金不足以付关税");
  const paidUnits = payTariff(state, shop, 300 * V, "测试", CONTENT);
  assert.equal(paidUnits, 300 * V);
  // 店里现金全部付了关税（部分支付 ok 为假，也必须按实付额入账），剩下的记为欠税，且支付构成与欠款一致。
  const unpaid = 300 * V - cashBefore;
  assert.equal(shop.cashVoucherUnits, 0, "店里的钱应全部付了关税");
  assert.equal(shop.liabilities.taxVoucherUnits, unpaid);
  assert.equal(shop.liabilities.taxPaymentClaim.valueUnits, unpaid);
  // 店里有钱了，日结应把欠税全部收回镇库。
  transferVouchers(state, "town", `shop:${shop.id}`, 1000 * V, CONTENT, "test", "补资");
  simulation.advanceDay(state);
  assert.equal(shop.liabilities.taxVoucherUnits, 0, "欠税应被日结收回");
  valid(state, "关税收回后");
});

test("利润税支付构成落后于欠款（claim 为 0）时，日结仍按欠款付款，不会恒为 0", () => {
  const { state, shop } = generalShopWithCash(6, 0);
  shop.liabilities.taxVoucherUnits = 300 * V;
  shop.liabilities.taxPaymentClaim = addPaymentObligation(undefined, currentPaymentComposition(state, 0));
  transferVouchers(state, "town", `shop:${shop.id}`, 1000 * V, CONTENT, "test", "补资");
  simulation.advanceDay(state);
  assert.equal(shop.liabilities.taxVoucherUnits, 0, "claim 落后时也应付清欠税");
  valid(state, "落后支付构成");
});

test("清算核销坏账时，三类支付构成（租金、利润税、工资债权）一并清零", () => {
  const { state, shop } = generalShopWithCash(7, 0);
  const owner = householdList(state).find(h => h.id !== shop.ownerHouseholdId) || householdList(state)[0];
  shop.status = "liquidating";
  shop.statusReason = "测试清算";
  shop.liquidatingSinceSerial = serialNow(state) - 31;
  shop.liabilities.taxVoucherUnits = 100 * V;
  shop.liabilities.rentVoucherUnits = 50 * V;
  shop.liabilities.taxPaymentClaim = addPaymentObligation(undefined, currentPaymentComposition(state, 100 * V));
  shop.liabilities.rentPaymentClaim = addPaymentObligation(undefined, currentPaymentComposition(state, 50 * V));
  shop.liabilities.claimsVoucherUnits = { [owner.id]: 10 * V };
  shop.liabilities.claimsPayment = { [owner.id]: currentPaymentComposition(state, 10 * V) };
  simulation.closeResidentShop(state, shop.id, CONTENT);
  const after = state.shops[shop.id];
  if (after) {
    assert.equal(after.liabilities.taxVoucherUnits, 0);
    assert.equal(after.liabilities.rentVoucherUnits, 0);
    assert.equal(after.liabilities.rentPaymentClaim.valueUnits, 0, "核销后租金支付构成应清零");
    assert.equal(after.liabilities.taxPaymentClaim.valueUnits, 0, "核销后利润税支付构成应清零");
    assert.deepEqual(after.liabilities.claimsPayment || {}, {}, "核销后工资债权支付构成应清零");
  }
  valid(state, "坏账核销后");
});

test("镇营综合商店没有店员时，经营状态写「无店员」而不是「销量不足」", () => {
  const state = legacyVoucherState({ seed: 8 });
  const street = addBuilding(state, "commercial_street", "fix-town-street");
  addBuilding(state, "wholesale_market", "fix-market");
  const opened = simulation.openTownShop(state, street);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, 0).assigned, 0);
  for (let i = 0; i < 3; i++) simulation.advanceDay(state);
  const shop = state.shops[opened.shopId];
  assert.equal(shop.status, "open");
  assert.equal(shop.statusReason, "无店员");
});

test("集市断货无钱、垫款未还：未满 30 天不停摆也不再垫，满 30 天后允许镇库再垫周转金（垫款累计）", () => {
  const state = legacyVoucherState({ seed: 9 });
  addBuilding(state, "times_square", "fix-square");
  issueTownVouchers(state, 5000 * V, CONTENT, "测试");
  simulation.advanceDay(state);
  const shop = Object.values(state.shops).find(row => row.collective);
  assert.ok(shop, "应开出集体摊位");
  transferVouchers(state, `shop:${shop.id}`, "town", shop.cashVoucherUnits, CONTENT, "test", "清空摊位现金");
  for (const itemId of Object.keys(shop.inventory)) shop.inventory[itemId] = 0;
  shop.townAdvanceVoucherUnits = 500 * V;
  shop.idleDays = 29;
  assert.equal(collectiveStranded(state, shop, CONTENT), false);
  const before = shop.townAdvanceVoucherUnits;
  assert.equal(refundCollectiveIfStranded(state, shop, CONTENT), false, "未满 30 天不应再垫");
  assert.equal(shop.townAdvanceVoucherUnits, before);
  shop.idleDays = 30;
  assert.equal(collectiveStranded(state, shop, CONTENT), true);
  assert.equal(refundCollectiveIfStranded(state, shop, CONTENT), true, "停摆满 30 天应再垫");
  assert.ok(shop.townAdvanceVoucherUnits > before, "垫款应累计在未还的垫款之上");
  assert.ok(shop.cashVoucherUnits > 0);
  valid(state, "集市再垫后");
});

test("集市停摆期间不再累计店租：豁免的租金记入 rentWaivedVoucherUnits", () => {
  const state = legacyVoucherState({ seed: 10 });
  addBuilding(state, "times_square", "fix-square-rent");
  simulation.advanceDay(state);
  const shop = Object.values(state.shops).find(row => row.collective);
  assert.ok(shop, "应开出集体摊位");
  // 镇库没有钱（legacy 夹具里镇库无券）无法再垫：摊位断货无钱、无成交，满 30 天即停摆。
  transferVouchers(state, `shop:${shop.id}`, "town", shop.cashVoucherUnits, CONTENT, "test", "清空摊位现金");
  for (const itemId of Object.keys(shop.inventory)) shop.inventory[itemId] = 0;
  shop.townAdvanceVoucherUnits = 500 * V;
  shop.idleDays = 30;
  setJobCount(state, `shop:${shop.id}:merchant`, 2, CONTENT, { type: "shop", id: shop.id });
  const rentBefore = shop.liabilities.rentVoucherUnits || 0;
  for (let i = 0; i < 3; i++) simulation.advanceDay(state);
  assert.equal(shop.liabilities.rentVoucherUnits || 0, rentBefore, "停摆期间不应累计店租");
  assert.ok((shop.accounts.cumulative.rentWaivedVoucherUnits || 0) > 0, "豁免的店租应记账");
  valid(state, "集市停摆豁免租金");
});
