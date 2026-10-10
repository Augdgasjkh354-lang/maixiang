// 物价会动：库存/销量驱动的价格系数（综合商店零售价、批发市场自动调价）。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { nextPriceFactor } from "../src/economy/price-adjust.js";
import { shopTradePrices } from "../src/economy/operating-plan.js";
import { currentUnitPrice } from "../src/economy/prices.js";
import { ensureShopPricing, reviewShopPricing, selectShopPricingView } from "../src/systems/shop-pricing.js";
import { purchaseItemForResidents } from "../src/systems/consumer-market.js";
import { buyWholesaleForOwner, reviewWholesaleAutoPricing, snapshotWholesaleHistory } from "../src/systems/wholesale-market.js";
import { householdList, isActiveHousehold } from "../src/systems/households.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const RULES = CONTENT.rules.priceAdjust;

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

// 与 shop-rejections.test.js 的 town() 同口径：银行、批发市场、商业街，货币改革后开一家综合商店。
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
  return { state, shopId: store.shopId, shop };
}

// 日归档历史行：每天按 soldJin 斤售出（库存单位口径），可选断货需求。
function historyRows(count, soldJinPerDay, itemId = "flour", stockoutUnits = 0) {
  return Array.from({ length: count }, (_, index) => ({
    serial: index + 1,
    soldUnitsByItem: { [itemId]: Math.round(soldJinPerDay * I) },
    stockoutUnitsByItem: stockoutUnits > 0 ? { [itemId]: stockoutUnits } : {}
  }));
}

// 只有银行与批发市场、没有居民与商店的小镇：批发市场的库存只受测试控制，便于验证自动调价。
function marketTown(seed) {
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
  simulation.setEmployment(state, `${market}::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  assert.equal(state.monetaryReform.stage, "voucher"); // 开局即粮券阶段
  return state;
}

function retail(state, shop, itemId = "flour") {
  return shopTradePrices(state, "general", CONTENT, itemId, shop).retailVoucherPerUnit;
}

function review(state, shop) {
  return reviewShopPricing(state, shop, CONTENT, { force: true });
}

// ---------------------------------------------------------------- 纯函数

test("物价系数：积压降价、紧缺涨价、卖空涨得更快", () => {
  const overstock = nextPriceFactor(1, { stockUnits: 300, avgSoldUnits: 10, shortage: false }, RULES);
  assert.deepEqual(overstock, { factor: 0.95, reason: "积压降价" }, "库存够卖 30 天 > 21 天：降 5%");
  const shortage = nextPriceFactor(1, { stockUnits: 10, avgSoldUnits: 10, shortage: true }, RULES);
  assert.deepEqual(shortage, { factor: 1.05, reason: "紧缺涨价" }, "库存够卖 1 天且有断货：涨 5%");
  const soldOut = nextPriceFactor(1, { stockUnits: 0, avgSoldUnits: 5, shortage: true }, RULES);
  assert.deepEqual(soldOut, { factor: 1.1, reason: "紧缺涨价" }, "库存已空且有断货：涨 10%");
  assert.ok(soldOut.factor > shortage.factor, "卖空比紧缺涨得快");
  // 无断货、库存正常：不涨
  const normal = nextPriceFactor(1, { stockUnits: 10, avgSoldUnits: 10, shortage: false }, RULES);
  assert.deepEqual(normal, { factor: 1, reason: "" }, "正常且系数为 1：不动");
});

test("物价系数：无销量有库存视为积压；库存为空且无需求不涨", () => {
  assert.equal(nextPriceFactor(1, { stockUnits: 50, avgSoldUnits: 0, shortage: false }, RULES).factor, 0.95);
  assert.deepEqual(nextPriceFactor(1, { stockUnits: 0, avgSoldUnits: 0, shortage: false }, RULES), { factor: 1, reason: "" });
});

test("物价系数：正常时向 1 回归，每次 driftStep，不越过 1", () => {
  assert.deepEqual(nextPriceFactor(0.9, { stockUnits: 10, avgSoldUnits: 10 }, RULES), { factor: 0.92, reason: "回归正常" });
  assert.deepEqual(nextPriceFactor(1.2, { stockUnits: 10, avgSoldUnits: 10 }, RULES), { factor: 1.18, reason: "回归正常" });
  assert.deepEqual(nextPriceFactor(0.99, { stockUnits: 10, avgSoldUnits: 10 }, RULES), { factor: 1, reason: "回归正常" }, "不越过 1");
  assert.deepEqual(nextPriceFactor(1.01, { stockUnits: 10, avgSoldUnits: 10 }, RULES), { factor: 1, reason: "回归正常" }, "不越过 1");
});

test("物价系数：限制在 [minFactor, maxFactor] 内", () => {
  assert.equal(nextPriceFactor(0.71, { stockUnits: 300, avgSoldUnits: 10 }, RULES).factor, 0.7, "积压降到下限为止");
  assert.equal(nextPriceFactor(1.48, { stockUnits: 0, avgSoldUnits: 5, shortage: true }, RULES).factor, 1.5, "紧缺涨到上限为止");
  assert.equal(nextPriceFactor(0.7, { stockUnits: 300, avgSoldUnits: 10 }, RULES).factor, 0.7, "已在下限则不再降");
  assert.ok(CONTENT.rules.priceAdjust.highStockDays === 21 && CONTENT.rules.priceAdjust.wholesaleBandPercent === 30, "规则参数在 content/rules.js");
});

// ---------------------------------------------------------------- 综合商店

test("综合商店积压：分批降价，未到清库存线时不低于进货价，清库存后可降到进货价×0.7", () => {
  const { state, shopId, shop } = town(7601);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 2).ok, true);
  assert.equal(simulation.configureShopTargetMargin(state, shopId, 0).ok, true, "目标利润率 0：基准价 = 进货价");
  // 库存够卖 30 天（日均 1 斤）：积压但未到清库存线（42 天）
  shop.inventory.flour = 30 * I;
  shop.history = historyRows(7, 1);
  for (let i = 0; i < 6; i += 1) assert.equal(review(state, shop).reviewed, true);
  const pricing = ensureShopPricing(shop, CONTENT);
  assert.ok(pricing.priceFactor.flour < 1, "积压应降价");
  assert.equal(pricing.priceFactorReason.flour, "积压降价");
  assert.equal(pricing.priceClearance.flour, false, "未到清库存线");
  assert.ok(retail(state, shop) >= 2 - 1e-9, "未到清库存线不得低于进货价");
  assert.equal(retail(state, shop), 2, "降到进货价为止");
  // 不卖了：库存天数无穷大，进入清库存，售价可降到进货价 × 0.7
  shop.history = historyRows(7, 0);
  for (let i = 0; i < 8; i += 1) review(state, shop);
  assert.equal(pricing.priceClearance.flour, true, "卖不动进入清库存");
  assert.equal(pricing.priceFactor.flour, RULES.minFactor, "系数降到下限");
  assert.ok(Math.abs(retail(state, shop) - 2 * RULES.minFactor) < 1e-9, "清库存价 = 进货价 × 0.7");
  valid(state);
});

test("综合商店复核节拍：未到 7 天的非强制复核不改系数", () => {
  const { state, shop } = town(7602);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 2).ok, true);
  shop.inventory.flour = 30 * I;
  shop.history = historyRows(7, 1);
  assert.equal(review(state, shop).reviewed, true);
  const factor = ensureShopPricing(shop, CONTENT).priceFactor.flour;
  const again = reviewShopPricing(state, shop, CONTENT);
  assert.equal(again.reviewed, false, "同一周期内不再复核");
  assert.equal(ensureShopPricing(shop, CONTENT).priceFactor.flour, factor);
});

test("综合商店拒客且断货：真实断货记账后涨价", () => {
  const { state, shopId, shop } = town(7603);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 2).ok, true);
  assert.equal(simulation.configureShopTargetMargin(state, shopId, 20).ok, true);
  shop.inventory.flour = 0;
  const hid = householdList(state).filter(isActiveHousehold)[0].id;
  assert.equal(grantResidentVouchers(state, 500, CONTENT, hid).ok, true);
  const want = {};
  for (const household of householdList(state).filter(isActiveHousehold)) want[household.id] = household.id === hid ? 10 * I : 0;
  const bought = purchaseItemForResidents(state, "flour", 10 * I, 1, CONTENT, "测试", { householdNeedsUnits: want });
  assert.equal(bought.purchasedUnits, 0, "店里没货");
  assert.ok((shop.accounts.day.stockoutUnits.flour || 0) > 0, "断货需求已记账");
  // 日结归档的口径：把当日账放进历史行，再复核
  shop.history = [{ serial: 1, soldUnitsByItem: {}, stockoutUnitsByItem: { ...shop.accounts.day.stockoutUnits }, rejectedCustomerCount: 1 }];
  const result = review(state, shop);
  const pricing = ensureShopPricing(shop, CONTENT);
  assert.equal(pricing.priceFactor.flour, 1.1, "库存已空且有断货：涨 10%");
  assert.equal(pricing.priceFactorReason.flour, "紧缺涨价");
  assert.ok(result.factorChanges.some(row => row.itemId === "flour" && row.to === 1.1));
  assert.ok(Math.abs(retail(state, shop) - 2.4 * 1.1) < 1e-9, "基准价 2.4 × 1.1");
  valid(state);
});

test("利润率复核按基准价口径核算：降价去库存不会被利润率复核拉回去", () => {
  const { state, shopId, shop } = town(7604);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 2).ok, true);
  assert.equal(simulation.configureShopTargetMargin(state, shopId, 16).ok, true);
  const pricing = ensureShopPricing(shop, CONTENT);
  shop.inventory.flour = 0; // 空库存、无销量：没有库存信号，系数只做回归
  // 窗口内系数 0.9：基准价 2.4 → 实售 2.16；成本 2。按基准价口径利润率 16.7%（贴近目标 16%），按实售口径只有 7.4%。
  pricing.priceFactor.flour = 0.9;
  const units = 10 * I;
  pricing.itemRevenue.flour = Math.round(2.16 * units);
  pricing.itemCogs.flour = 2 * units;
  pricing.itemWageCost.flour = 0;
  pricing.itemSoldUnits.flour = units;
  shop.history = [];
  const result = review(state, shop);
  assert.equal(result.changes.filter(row => row.itemId === "flour").length, 0, "基准价利润率在容忍带内，不调基准价");
  assert.equal(pricing.retailPriceVoucherPerUnit?.flour, undefined, "基准价未被改写");
  assert.ok(Math.abs(pricing.priceFactor.flour - 0.92) < 1e-9, "系数按无库存信号回归");
});

test("综合商店手动现售价：输入的价格就是实际成交价（基准价自动除以系数）", () => {
  const { state, shopId, shop } = town(7605);
  assert.equal(simulation.configureWholesalePrice(state, "bread", 2).ok, true);
  ensureShopPricing(shop, CONTENT).priceFactor.bread = 0.9;
  const set = simulation.configureShopRetailPrice(state, shopId, "bread", 3);
  assert.equal(set.ok, true, set.reason);
  assert.ok(Math.abs(set.value - 3) < 1e-9);
  assert.ok(Math.abs(retail(state, shop, "bread") - 3) < 1e-9, "成交价 = 输入价");
  valid(state);
});

test("综合商店面板视图：现售价与系数一致，且只读", () => {
  const { state, shop } = town(7606);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 2).ok, true);
  shop.inventory.flour = 30 * I;
  shop.history = historyRows(7, 1);
  review(state, shop);
  const before = JSON.stringify(state.shops);
  const view = selectShopPricingView(state, shop, CONTENT);
  assert.equal(JSON.stringify(state.shops), before, "选择器不写 state");
  const row = view.rows.find(r => r.itemId === "flour");
  assert.equal(row.priceFactor, ensureShopPricing(shop, CONTENT).priceFactor.flour);
  assert.equal(row.priceFactorReason, "积压降价");
  assert.ok(Math.abs(row.retailVoucherPerUnit - retail(state, shop)) < 1e-9, "视图现售价 = 交易价");
});

// ---------------------------------------------------------------- 批发市场自动调价

test("批发市场自动调价默认关闭：60 天售价不变", () => {
  const state = marketTown(7607);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 1.8).ok, true);
  state.wholesaleMarket.inventory.flour = 5000 * I; // 严重积压，若开启会降价
  simulation.advanceDays(state, 60);
  assert.equal(currentUnitPrice(state, "flour", CONTENT), 1.8);
  assert.equal(state.wholesaleMarket.autoPricing.flour, undefined, "未开启则没有条目");
  valid(state);
});

test("批发市场自动调价开启：积压时逐步降价，始终在锚定价 ±30% 之内", () => {
  const state = marketTown(7608);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 1.8).ok, true);
  state.wholesaleMarket.inventory.flour = 5000 * I; // 库存远超销量：积压
  const on = simulation.configureWholesaleAutoPricing(state, "flour", true);
  assert.equal(on.ok, true, on.reason);
  assert.equal(on.anchorVoucherPerUnit, 1.8, "开启时以当前售价为锚定价");
  simulation.advanceDays(state, 15); // 第 7、14 天各复核一次：0.95 × 0.95
  const after14 = currentUnitPrice(state, "flour", CONTENT);
  assert.ok(Math.abs(after14 - 1.8 * 0.9025) < 0.002, `两个周期应降 5%+5%，实际 ${after14}`);
  assert.equal(state.wholesaleMarket.autoPricing.flour.reason, "积压降价");
  simulation.advanceDays(state, 60);
  const later = currentUnitPrice(state, "flour", CONTENT);
  assert.ok(later >= 1.8 * 0.7 - 1e-9 && later <= 1.8 * 1.3 + 1e-9, `不超出锚定价 ±30%，实际 ${later}`);
  assert.ok(Math.abs(later - 1.8 * 0.7) < 0.002, "持续积压压到 ±30% 下限");
  assert.equal(state.wholesaleMarket.autoPricing.flour.anchorVoucherPerUnit, 1.8, "自动调价不改锚定价");
  valid(state);
});

test("批发市场缺货记账（买方要的比有的多）→ 自动调价涨价", () => {
  const state = marketTown(7611);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 1.8).ok, true);
  state.wholesaleMarket.inventory.flour = 0;
  assert.equal(simulation.configureWholesaleAutoPricing(state, "flour", true).ok, true);
  // 买方想要 100 斤面粉，市场没货：记为当日未满足量，日归档后成为紧缺信号
  const bought = buyWholesaleForOwner(state, "shop:test", "flour", 100 * I, CONTENT, "测试");
  assert.equal(bought.ok, false, "市场没货");
  assert.equal(state.wholesaleMarket.day.unmetUnits.flour, 100 * I, "缺货差额记账");
  snapshotWholesaleHistory(state, CONTENT);
  assert.equal(state.wholesaleMarket.history.at(-1).unmet.flour, 100 * I, "日归档保留缺货量");
  // 到期复核（不等 7 天，直接把锚定的复核节拍拨回去）
  state.wholesaleMarket.autoPricing.flour.lastReviewSerial = -1000;
  const result = reviewWholesaleAutoPricing(state, CONTENT);
  assert.equal(result.changes.length, 1);
  assert.equal(state.wholesaleMarket.autoPricing.flour.reason, "紧缺涨价");
  assert.ok(Math.abs(currentUnitPrice(state, "flour", CONTENT) - 1.8 * 1.1) < 0.002, "卖空：涨 10%");
  valid(state);
});

test("批发自动调价：玩家手动改售价即成为新锚定价；关闭后价格保持不动", () => {
  const state = marketTown(7609);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 1.8).ok, true);
  state.wholesaleMarket.inventory.flour = 5000 * I;
  assert.equal(simulation.configureWholesaleAutoPricing(state, "flour", true).ok, true);
  simulation.advanceDays(state, 14);
  assert.ok(currentUnitPrice(state, "flour", CONTENT) < 1.8);
  const manual = simulation.configureWholesalePrice(state, "flour", 2.2);
  assert.equal(manual.ok, true, manual.reason);
  assert.equal(state.wholesaleMarket.autoPricing.flour.anchorVoucherPerUnit, 2.2, "手动改价重置锚定价");
  assert.equal(simulation.configureWholesaleAutoPricing(state, "flour", false).ok, true);
  simulation.advanceDays(state, 30);
  assert.equal(currentUnitPrice(state, "flour", CONTENT), 2.2, "关闭后保持当前售价");
  valid(state);
});

test("批发自动调价：只接受经营中的商品与布尔开关", () => {
  const state = marketTown(7610);
  assert.equal(simulation.configureWholesaleAutoPricing(state, "wheat", true).ok, false, "小麦归镇库直管");
  assert.equal(simulation.configureWholesaleAutoPricing(state, "no-such-item", true).ok, false);
  assert.equal(simulation.configureWholesaleAutoPricing(state, "flour", "yes").ok, false);
  assert.equal(state.wholesaleMarket.autoPricing.flour, undefined);
});
