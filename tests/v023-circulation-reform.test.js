import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { householdList, householdIdleWorkers, setJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { processBuilding } from "../src/systems/production.js";
import { runWholesaleIntake, setWholesaleTownAllocation, transferTownToWholesale, buyWholesaleForOwner,
  wholesalePurchasePrice, wholesaleUnitPrice, ensureWholesaleMarket, hasWholesaleMarket } from "../src/systems/wholesale-market.js";
import { payDailyWages } from "../src/systems/payroll.js";
import { employmentSnapshot } from "../src/systems/employment.js";
import { shopTradePrices } from "../src/economy/operating-plan.js";
import { openShop, prepareShopsForDay, finishShopsDay, resetShopDaily, sellShopProduct } from "../src/systems/shops.js";
import { ensureShopPricing, reviewShopPricing, clampPriceStep, updateShopLossProtection,
  selectShopPricingView, priceElasticityDemandMultiplier, setShopTargetMarginPercent } from "../src/systems/shop-pricing.js";
import { voucherBalance, totalVoucherBalances } from "../src/economy/currency.js";
import { SAVE_VERSION } from "../src/content/rules.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const def = CONTENT.buildings[typeId];
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = { id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: state.day + 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

// ---------------------------------------------------------------- 需求 1：做市商

test("0.2.3 批发市场做市商：收购价与售价分离且可分别调整，默认价符合用户口径", () => {
  // 新档默认挂价：面粉 1.4/1.8、木材 12/16、面包 2/2.6、盐 8/12
  const fresh = simulation.createInitialState({ seed: 2300 });
  const freshMarket = ensureWholesaleMarket(fresh, CONTENT);
  const expected = {
    flour: { buy: 1.6, sell: 1.8 },
    wood: { buy: 12, sell: 16 },
    bread: { buy: 2, sell: 2.6 },
    salt: { buy: 8, sell: 12 }
  };
  for (const [itemId, price] of Object.entries(expected)) {
    assert.equal(freshMarket.purchasePricesVoucherPerUnit[itemId], price.buy, `${itemId} 默认收购价`);
    assert.equal(freshMarket.pricesVoucherPerUnit[itemId], price.sell, `${itemId} 默认售价`);
  }
  // 旧档沿用既有市价，但收购价仍补齐为用户口径的默认值
  const state = legacyVoucherState({ seed: 2301 });
  addBuilding(state, "wholesale_market", "wm-1");
  const market = ensureWholesaleMarket(state, CONTENT);
  assert.equal(market.purchasePricesVoucherPerUnit.flour, 1.6);
  assert.equal(market.purchasePricesVoucherPerUnit.wood, 12);
  assert.equal(market.purchasePricesVoucherPerUnit.bread, 2);
  assert.equal(market.purchasePricesVoucherPerUnit.salt, 8);
  // 分别调整互不影响
  assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 1.5).ok, true);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 2.2).ok, true);
  assert.equal(wholesalePurchasePrice(state, "flour", CONTENT), 1.5);
  assert.equal(wholesaleUnitPrice(state, "flour", CONTENT), 2.2);
});

test("0.2.3 收购价随库存自动下调（价格反馈），防止大公司抽干批发市场粮券", () => {
  const state = legacyVoucherState({ seed: 2302 });
  addBuilding(state, "wholesale_market", "wm-2");
  const market = ensureWholesaleMarket(state, CONTENT);
  assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 1.4).ok, true);
  const emptyPrice = wholesalePurchasePrice(state, "flour", CONTENT);
  assert.equal(emptyPrice, 1.4, "库存为空时收购价应为基准价");
  // 堆入远超参考库存（默认 2000 斤）的面粉
  market.inventory.flour = 20000 * I;
  const highStockPrice = wholesalePurchasePrice(state, "flour", CONTENT);
  assert.ok(highStockPrice < emptyPrice, `库存高时收购价应下调：${highStockPrice} vs ${emptyPrice}`);
  assert.ok(highStockPrice >= 1.4 * 0.25 - 1e-9, "收购价不应跌破基准的 25% 下限");
  // 库存越多人越便宜：单调性
  market.inventory.flour = 60000 * I;
  const higherStockPrice = wholesalePurchasePrice(state, "flour", CONTENT);
  assert.ok(higherStockPrice <= highStockPrice, "库存继续增加时收购价应继续下降或持平");
});

test("0.2.3 公司/民营从批发市场采购原料并支付粮券（统一入口）", () => {
  const state = legacyVoucherState({ seed: 2304 });
  addBuilding(state, "wholesale_market", "wm-4");
  const market = ensureWholesaleMarket(state, CONTENT);
  market.inventory.flour = 500 * I;
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const cashBefore = voucherBalance(state, `household:${owner.id}`);
  const townBefore = voucherBalance(state, "town");
  const stockBefore = market.inventory.flour;
  // 公司/民营采购原料走统一入口 buyWholesaleForOwner（companies/private-industry 都调它）
  const result = buyWholesaleForOwner(state, `household:${owner.id}`, "flour", 100 * I, CONTENT, "测试采购");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.boughtUnits, 100 * I);
  assert.equal(market.inventory.flour, stockBefore - 100 * I);
  // 批发市场没有独立现金，货款直接进入镇库
  assert.equal(voucherBalance(state, "town"), townBefore + result.paidVoucherUnits);
  assert.equal(voucherBalance(state, `household:${owner.id}`), cashBefore - result.paidVoucherUnits);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

// ---------------------------------------------------------------- 需求 2：统购统销

test("0.2.3 统购统销：镇营产成品无偿调拨入市", () => {
  const state = legacyVoucherState({ seed: 2305 });
  const market = addBuilding(state, "wholesale_market", "wm-5");
  void market;
  const lumberyard = addBuilding(state, "lumberyard", "ly-5");
  const role = CONTENT.buildings.lumberyard.jobs[0];
  assert.equal(setJobCount(state, `${lumberyard.id}::${role.id}`, 4, CONTENT, { type: "town", id: lumberyard.id }).assigned, 4);
  const produced = processBuilding(state, lumberyard, CONTENT);
  assert.ok(produced.batches > 0, "伐木场应能生产");
  const before = state.wholesaleMarket.inventory.wood;
  const townCashBefore = voucherBalance(state, "town");
  const intake = runWholesaleIntake(state, [produced], [], CONTENT, { includeTownAllocation: false });
  assert.ok(intake.intakeUnits.wood > 0, "镇营木材应无偿调拨入市");
  assert.equal(state.wholesaleMarket.inventory.wood, before + intake.intakeUnits.wood);
  // 无偿：镇库现金不因调拨变化
  assert.equal(voucherBalance(state, "town"), townCashBefore, "无偿调拨不应产生现金往来");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("0.2.3 镇营建筑工资由镇库发放（批发市场没有独立现金）", () => {
  const state = legacyVoucherState({ seed: 2306 });
  addBuilding(state, "wholesale_market", "wm-6");
  const mill = addBuilding(state, "mill", "mill-6");
  const role = CONTENT.buildings.mill.jobs[0];
  assert.equal(setJobCount(state, `${mill.id}::${role.id}`, 2, CONTENT, { type: "town", id: mill.id }).assigned, 2);
  assert.equal(simulation.issueGrainVouchers(state, "town", 1000).ok, true);
  const townCashBefore = voucherBalance(state, "town");
  payDailyWages(state, employmentSnapshot(state, CONTENT), CONTENT);
  assert.ok(voucherBalance(state, "town") < townCashBefore, "镇库应为镇营建筑发工资");
  assert.equal(state.wholesaleMarket.cashVoucherUnits, undefined);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true);
});

test("0.2.3 统购统销：镇营原料（磨坊小麦、面包房面粉）内部无偿调拨", () => {
  const state = legacyVoucherState({ seed: 2307 });
  addBuilding(state, "wholesale_market", "wm-7");
  const mill = addBuilding(state, "mill", "mill-7");
  const role = CONTENT.buildings.mill.jobs[0];
  assert.equal(setJobCount(state, `${mill.id}::${role.id}`, 1, CONTENT, { type: "town", id: mill.id }).assigned, 1);
  // 小麦由镇库直管，磨坊直接用镇库小麦，无需先投放市场
  assert.ok((state.accounts.town.wheat || 0) > 0);
  const wheatBefore = state.accounts.town.wheat;
  const produced = processBuilding(state, mill, CONTENT);
  assert.ok(produced.batches > 0, "磨坊应能直接用镇库小麦生产");
  assert.ok(state.accounts.town.wheat < wheatBefore);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

// ---------------------------------------------------------------- 需求 3：动态加价

test("0.2.3 综合商店动态加价：目标利润率默认20%，售价=进货价×(1+目标)", () => {
  const state = legacyVoucherState({ seed: 2308 });
  const street = addBuilding(state, "commercial_street", "cs-8");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  assert.equal(ensureShopPricing(shop, CONTENT).targetMarginPercent, 20);
  assert.equal(simulation.configureWholesalePrice(state, "flour", 2).ok, true);
  const prices = shopTradePrices(state, "general", CONTENT, "flour", shop);
  assert.equal(prices.wholesaleVoucherPerUnit, 2);
  assert.ok(Math.abs(prices.retailVoucherPerUnit - 2.4) < 1e-9, "默认 20% 加价：2 × 1.2 = 2.4");
});

test("0.2.3 动态加价：目标利润率可调，且售价下限不低于进货价", () => {
  const state = legacyVoucherState({ seed: 2309 });
  const street = addBuilding(state, "commercial_street", "cs-9");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  const shop = state.shops[opened.shopId];
  assert.equal(simulation.configureWholesalePrice(state, "bread", 2).ok, true);
  assert.equal(simulation.configureShopTargetMargin(state, shop.id, 50).ok, true);
  assert.ok(Math.abs(shopTradePrices(state, "general", CONTENT, "bread", shop).retailVoucherPerUnit - 3) < 1e-9, "2 × 1.5 = 3");
  // 直接设一个低于进货价的售价，应被夹到进货价
  const clamped = simulation.configureShopRetailPrice(state, shop.id, "bread", 1);
  assert.equal(clamped.ok, true);
  assert.equal(clamped.value, 2, "售价不得低于进货价");
});

test("0.2.3 动态加价：单次涨跌幅限制 ±10%，且不低于进货价", () => {
  assert.equal(clampPriceStep(2, 2.5, 10, 1.8), 2.2, "单次最多涨 10%");
  assert.equal(clampPriceStep(2, 1.5, 10, 1.8), 1.8, "单次最多跌 10% 且不低于进货价");
  assert.equal(clampPriceStep(2, 1.5, 10, 1), 1.8, "跌幅上限为 10%");
});

test("0.2.3 动态加价：7天复核，偏离目标超过±3%才调价", () => {
  const state = legacyVoucherState({ seed: 2310 });
  const street = addBuilding(state, "commercial_street", "cs-10");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 8000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  const shop = state.shops[opened.shopId];
  assert.equal(simulation.configureWholesalePrice(state, "bread", 2).ok, true);
  assert.equal(simulation.configureShopTargetMargin(state, shop.id, 20).ok, true);
  const pricing = ensureShopPricing(shop, CONTENT);
  // 实际利润率 60%，远高于目标 20% → 应降价
  const I0 = CONTENT.precision.inventoryUnitsPerJin;
  pricing.itemRevenue.bread = 100 * I0;
  pricing.itemCogs.bread = 40 * I0;
  pricing.itemWageCost.bread = 0;
  pricing.itemSoldUnits.bread = 10 * I0;
  const first = reviewShopPricing(state, shop, CONTENT, { force: true });
  assert.equal(first.reviewed, true);
  assert.equal(first.changes.length, 1);
  assert.ok(first.changes[0].to < first.changes[0].from, "利润率过高应降价");
  // 偏差在 ±3% 内 → 不调价
  pricing.itemRevenue.flour = 100 * I0;
  pricing.itemCogs.flour = 80 * I0;
  pricing.itemWageCost.flour = 0;
  pricing.itemSoldUnits.flour = 10 * I0;
  const second = reviewShopPricing(state, shop, CONTENT, { force: true });
  assert.equal(second.changes.filter(c => c.itemId === "flour").length, 0, "偏离在容忍带内不应调价");
});

test("0.2.3 动态加价：需求弹性——售价每贵10%购买量降5%", () => {
  const state = legacyVoucherState({ seed: 2311 });
  const street = addBuilding(state, "commercial_street", "cs-11");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  const shop = state.shops[opened.shopId];
  const pricing = ensureShopPricing(shop, CONTENT);
  pricing.itemPrices.flour = [{ serial: 1, price: 2 }]; // 30天均价 2
  const same = priceElasticityDemandMultiplier(state, shop, "flour", 2, CONTENT);
  assert.ok(Math.abs(same - 1) < 1e-9, "与均价相同则不缩放");
  const tenPercentMore = priceElasticityDemandMultiplier(state, shop, "flour", 2.2, CONTENT);
  assert.ok(Math.abs(tenPercentMore - 0.95) < 1e-9, "贵10%应降5%");
  const tenPercentLess = priceElasticityDemandMultiplier(state, shop, "flour", 1.8, CONTENT);
  assert.ok(Math.abs(tenPercentLess - 1.05) < 1e-9, "便宜10%应增5%");
});

test("0.2.3 动态加价：连续30天亏损进入促销模式并向玩家预警", () => {
  const state = legacyVoucherState({ seed: 2312 });
  const street = addBuilding(state, "commercial_street", "cs-12");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  const shop = state.shops[opened.shopId];
  ensureShopPricing(shop, CONTENT);
  const eventsBefore = state.events.length;
  for (let day = 0; day < 30; day += 1) {
    state.day = day;
    updateShopLossProtection(state, shop, CONTENT, -100);
  }
  assert.equal(shop.pricing.promotion, true, "连续30天亏损应进入促销模式");
  assert.equal(simulation.configureWholesalePrice(state, "bread", 2).ok, true);
  assert.equal(shopTradePrices(state, "general", CONTENT, "bread", shop).retailVoucherPerUnit, 2 * 1.05, "促销模式下目标利润率临时降至5%");
  assert.ok(state.events.length > eventsBefore, "应向玩家发出预警事件");
  assert.match(state.events[0].text, /促销/);
});

test("0.2.3 动态加价面板：每商品一行 + 商店总览", () => {
  const state = legacyVoucherState({ seed: 2313 });
  const street = addBuilding(state, "commercial_street", "cs-13");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  const shop = state.shops[opened.shopId];
  const view = selectShopPricingView(state, shop, CONTENT);
  assert.equal(view.dynamic, true);
  assert.equal(view.targetMarginPercent, 20);
  assert.equal(view.rows.length, CONTENT.rules.shopTypes.general.itemIds.length, "综合商店每种商品一行");
  // 0.2.3-hotfix：小麦归镇库直管，综合商店不再经营小麦，改经营木材。
  assert.deepEqual(view.rows.map(r => r.itemId).sort(), [...CONTENT.rules.shopTypes.general.itemIds].sort());
  for (const row of view.rows) {
    assert.ok("wholesaleVoucherPerUnit" in row && "retailVoucherPerUnit" in row && "actualMarginPercent" in row && "soldJin7d" in row);
  }
  assert.ok("revenue" in view.totals && "cogs" in view.totals && "overallMarginPercent" in view.totals);
});

test("0.2.3 动态加价不影响其他小店（保持固定加价）", () => {
  const state = legacyVoucherState({ seed: 2314 });
  const street = addBuilding(state, "commercial_street", "cs-14");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "haircut", owner.id);
  const shop = state.shops[opened.shopId];
  const view = selectShopPricingView(state, shop, CONTENT);
  assert.equal(view.dynamic, false, "服务店不属于动态加价范围");
  assert.equal(simulation.configureShopTargetMargin(state, shop.id, 30).ok, false, "非综合商店不能设目标利润率");
});

// ---------------------------------------------------------------- 守恒与存档

// ---------------------------------------------------------------- 端到端

test("0.2.3 流通改革端到端：建市场+商店跑30天，状态与粮券守恒", () => {
  const state = legacyVoucherState({ seed: 2317 });
  addBuilding(state, "wholesale_market", "wm-17");
  const street = addBuilding(state, "commercial_street", "cs-17");
  const mill = addBuilding(state, "mill", "mill-17");
  addBuilding(state, "lumberyard", "ly-17");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 20000, CONTENT, owner.id).ok, true);
  assert.equal(simulation.openResidentShop(state, street.id, "general", owner.id).ok, true);
  assert.equal(setJobCount(state, `${mill.id}::${CONTENT.buildings.mill.jobs[0].id}`, 2, CONTENT, { type: "town", id: mill.id }).assigned, 2);
  assert.equal(simulation.issueGrainVouchers(state, "town", 3000).ok, true);
  simulation.advanceDays(state, 30);
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true);
});

