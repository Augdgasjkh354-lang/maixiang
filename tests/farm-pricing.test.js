import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { farmSalePriceVoucher, farmUnitCostVoucher, reviewFarmPricing } from "../src/systems/farm-pricing.js";
import { produceLivestock, sellFarmSurplusToWholesale } from "../src/systems/livestock.js";
import { priceFactorOf } from "../src/economy/price-adjust.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const PORK = CONTENT.rules.shopTypes.pig_farm.productItemId;

function valid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

// 镇：银行（粮券阶段）、批发市场（有工人）、商业街（综合商店）、养殖基地。
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
  const base = add("livestock_base");
  simulation.setEmployment(state, `${market}::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  assert.equal(state.monetaryReform.stage, "voucher"); // 开局即粮券阶段
  grantResidentVouchers(state, 300000);
  const store = simulation.openResidentShop(state, street, "general");
  assert.equal(store.ok, true, store.reason);
  issueTownVouchers(state, 5000 * V, CONTENT, "测试");
  transferVouchers(state, "town", `shop:${store.shopId}`, 5000 * V, CONTENT, "test", "测试商店资金");
  simulation.configureShopClerks(state, store.shopId, 10);
  return { state, base, storeId: store.shopId };
}

// 开一家猪场并雇 n 名饲养员（产能 > 0）。
function openPigFarm(state, base, clerks = 2) {
  const opened = simulation.openResidentShop(state, base, "pig_farm");
  assert.equal(opened.ok, true, opened.reason);
  const farm = state.shops[opened.shopId];
  assert.equal(simulation.configureShopClerks(state, farm.id, clerks).ok, true);
  farm.inventory[CONTENT.rules.shopTypes.pig_farm.feedItemId] = 500 * I; // 饲料（小麦）够用
  simulation.advanceDays(state, 1); // 次日店主商人到岗，场子才有产能
  return farm;
}

// 把复核时点挪到当前（避免 advanceDay 之外的复核干扰测试）。
function freezeReview(state, farm) {
  farm.pricing ||= { priceFactor: {} };
  farm.pricing.lastReviewSerial = (Math.max(1, state.year || 1) - 1) * (CONTENT.rules.daysPerYear || 365) + (state.day || 0);
}

// 近 7 天每天卖出 jinPerDay 斤猪肉（卖给商店与批发市场都算）。
function setRecentSales(farm, jinPerDay, { unmet = 0 } = {}) {
  farm.history = Array.from({ length: 7 }, (_, i) => ({
    year: 1, day: i, soldUnitsByItem: { [PORK]: jinPerDay * I }, unmetUnitsByItem: { [PORK]: unmet * I }
  }));
}

test("存货积压后系数下降；售价不低于养殖成本", () => {
  const { state, base } = town(6301);
  const farm = openPigFarm(state, base);
  setRecentSales(farm, 10);
  farm.inventory[PORK] = 5000 * I; // 500 天销量，远超 2 × farmStockDays 的积压线
  farm.pricing ||= { priceFactor: {} };
  farm.pricing.lastReviewSerial = -1000; // 开场时已记过复核日，这里强制复核一次
  const before = priceFactorOf(farm.pricing, PORK);
  const result = reviewFarmPricing(state, farm, CONTENT);
  assert.ok(result, "复核应当执行");
  const after = priceFactorOf(farm.pricing, PORK);
  assert.ok(after < before, `积压应降价：${before} → ${after}`);
  assert.equal(farm.pricing.reason, result.reason);

  // 连续积压复核，系数继续下降（每次复核一步）。
  for (let k = 0; k < 3; k++) {
    farm.pricing.lastReviewSerial = -1000;
    reviewFarmPricing(state, farm, CONTENT);
  }
  assert.ok(priceFactorOf(farm.pricing, PORK) < after, "持续积压继续降价");

  // 系数压到地板：售价仍不低于成本。
  farm.pricing.priceFactor[PORK] = 0.01;
  const cost = farmUnitCostVoucher(state, farm, CONTENT);
  assert.ok(cost > 0, "养殖成本为正");
  assert.ok(farmSalePriceVoucher(state, farm, CONTENT) >= cost - 1e-9, "售价不低于养殖成本");
  valid(state, "降价后");
});

test("存货够卖 7 天就暂停出栏，出栏原因“存货充足，暂停出栏”", () => {
  const { state, base } = town(6302);
  const farm = openPigFarm(state, base);
  setRecentSales(farm, 10);
  freezeReview(state, farm);
  farm.inventory[PORK] = 100 * I; // 10 斤/日 × 7 天 = 70 斤，已够
  const rows = produceLivestock(state, CONTENT);
  const row = rows.find(r => r.shopId === farm.id);
  assert.equal(row.producedUnits, 0, "存货够 7 天不出栏");
  assert.equal(farm.outputReason, "存货充足，暂停出栏");
  valid(state, "暂停出栏");

  // 存货不够 7 天：照常出栏。
  farm.inventory[PORK] = 20 * I;
  const again = produceLivestock(state, CONTENT).find(r => r.shopId === farm.id);
  assert.ok(again.producedUnits > 0, "存货不足时照常养");
  assert.notEqual(farm.outputReason, "存货充足，暂停出栏");
});

test("两家同品养殖场：商店先买便宜的那家", () => {
  const { state, base, storeId } = town(6303);
  const cheap = openPigFarm(state, base);
  const dear = openPigFarm(state, base);
  freezeReview(state, cheap);
  freezeReview(state, dear);
  cheap.pricing.priceFactor[PORK] = 1;
  dear.pricing.priceFactor[PORK] = 1.5;
  const cheapPrice = farmSalePriceVoucher(state, cheap, CONTENT);
  const dearPrice = farmSalePriceVoucher(state, dear, CONTENT);
  assert.ok(cheapPrice < dearPrice, `便宜场 ${cheapPrice} 应低于贵场 ${dearPrice}`);
  // 便宜场存货充足（商店一天的进货远小于此），贵场不该被动用。
  cheap.inventory[PORK] = 5000 * I;
  dear.inventory[PORK] = 500 * I;
  const store = state.shops[storeId];
  store.inventory[PORK] = 0;
  store.history = [];
  // 只看这一天的进货：开场时两家都已营业过，累计数里有历史成交。
  const soldBefore = farm => farm.accounts.cumulative.storeSoldUnits?.[PORK] || 0;
  const cheapBefore = soldBefore(cheap);
  const dearBefore = soldBefore(dear);
  simulation.advanceDays(state, 1);
  const soldCheap = soldBefore(cheap) - cheapBefore;
  const soldDear = soldBefore(dear) - dearBefore;
  assert.ok(soldCheap > 0, "便宜场卖给了商店");
  assert.equal(soldDear, 0, "便宜场够用，贵场当天不卖给商店");
  valid(state, "两场比价");
});

test("批发市场收肉：余量收到至少 200 斤（townOutputMinStockJin）", () => {
  const { state, base } = town(6304);
  const farm = openPigFarm(state, base);
  freezeReview(state, farm);
  farm.inventory[PORK] = 1000 * I;
  assert.equal(state.wholesaleMarket.inventory[PORK] || 0, 0, "市场一开始没有肉");
  const sold = sellFarmSurplusToWholesale(state, CONTENT);
  assert.ok(sold > 0, "应当收购肉");
  const minimum = (CONTENT.rules.townOutputMinStockJin ?? 200) * I;
  const inMarket = state.wholesaleMarket.inventory[PORK] || 0;
  assert.ok(inMarket >= minimum - 1, `市场肉 ${inMarket / I} 斤，应至少 ${minimum / I} 斤`);
  assert.ok(inMarket <= minimum + I, `市场只收到 200 斤左右，不无限囤货：${inMarket / I} 斤`);
  valid(state, "收肉后");
});
