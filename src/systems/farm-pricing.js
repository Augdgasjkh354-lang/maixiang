// 养殖场自主定价与排产（养殖基地，kind "farm" 的店铺）。
//
// 定价：卖给综合商店的价 = 批发基准价 × 本场系数。每 priceAdjust.reviewDays 天按本场存货天数、
//   日均卖出量（卖给商店 + 卖给批发市场）和商店缺货复核一次（与综合商店同一个 nextPriceFactor）：
//   存货超过 2 × farmStockDays 天算积压降价，紧缺涨价，平常回归 1。售价不低于养殖成本（饲料 + 人工，按当前小麦价与本场工资折算）。
// 排产：存货够卖 farmStockDays 天就停养，没有销量记录时最多囤 farmStockDays 天产量。
import { currentUnitPrice } from "../economy/prices.js";
import { nextPriceFactor, priceFactorOf } from "../economy/price-adjust.js";
import { shopWage } from "./labor-market.js";

// 与 shops.js 的 shopDefinition 同口径；这里自己读，免得 shops.js ↔ farm-pricing.js 循环依赖。
function shopDefinition(content, typeId) {
  const raw = content.rules.shopTypes?.[typeId] || null;
  if (!raw) return null;
  return raw.aliasOf ? content.rules.shopTypes?.[raw.aliasOf] || null : raw;
}

const round2 = value => Math.round(value * 100) / 100;

function serialOf(state, content) {
  return (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
}

function recentRows(farm, content) {
  return (farm.history || []).slice(-Math.max(1, content.rules.priceAdjust?.reviewDays || 7));
}

// 近期日均卖出（库存单位）：卖给商店与批发市场都算。
export function farmAvgSoldUnits(farm, content) {
  const def = shopDefinition(content, farm?.typeId);
  const rows = recentRows(farm, content);
  if (!def || !rows.length) return 0;
  return rows.reduce((sum, row) => sum + Math.max(0, row.soldUnitsByItem?.[def.productItemId] || 0), 0) / rows.length;
}

// 每斤养殖成本（券）：饲料按当前小麦价 + 人工按本场日薪 ÷ 人均日产。
export function farmUnitCostVoucher(state, farm, content) {
  const def = shopDefinition(content, farm?.typeId);
  if (!def) return 0;
  const feed = def.feedPerUnit * (currentUnitPrice(state, def.feedItemId, content) || 0);
  const labor = shopWage(state, farm, content) / Math.max(1e-9, def.outputPerWorkerDay);
  return feed + labor;
}

// 卖给综合商店的每斤价（券）。
export function farmSalePriceVoucher(state, farm, content) {
  const def = shopDefinition(content, farm?.typeId);
  if (!def) return 0;
  const base = currentUnitPrice(state, def.productItemId, content) || 0;
  if (!(base > 0)) return 0;
  const priced = base * priceFactorOf(farm.pricing, def.productItemId);
  return round2(Math.max(priced, farmUnitCostVoucher(state, farm, content)));
}

// 每 reviewDays 天复核一次本场系数。
export function reviewFarmPricing(state, farm, content) {
  const def = shopDefinition(content, farm?.typeId);
  if (!def) return null;
  const rules = content.rules.priceAdjust || {};
  const interval = Math.max(1, rules.reviewDays || 7);
  const serial = serialOf(state, content);
  farm.pricing ||= { priceFactor: {} };
  farm.pricing.priceFactor ||= {};
  if (Number.isFinite(farm.pricing.lastReviewSerial) && serial - farm.pricing.lastReviewSerial < interval) return null;
  farm.pricing.lastReviewSerial = serial;
  const itemId = def.productItemId;
  const rows = recentRows(farm, content);
  const shortage = rows.some(row => (row.unmetUnitsByItem?.[itemId] || 0) > 0);
  const result = nextPriceFactor(priceFactorOf(farm.pricing, itemId), {
    stockUnits: farm.inventory?.[itemId] || 0, avgSoldUnits: farmAvgSoldUnits(farm, content), shortage
  }, { ...rules, highStockDays: 2 * (content.rules.farmStockDays ?? 7) });
  farm.pricing.priceFactor[itemId] = result.factor;
  farm.pricing.reason = result.reason;
  return result;
}

// 今天最多养多少（库存单位）：把存货补到 farmStockDays 天销量（没有销量时按产能算）为止。
export function farmOutputRoomUnits(farm, capacityUnits, content) {
  const def = shopDefinition(content, farm?.typeId);
  if (!def) return 0;
  const days = content.rules.farmStockDays ?? 7;
  const avgSold = farmAvgSoldUnits(farm, content);
  const target = Math.max(avgSold * days, (farm.history || []).length < 3 ? capacityUnits * days : 0);
  const stock = farm.inventory?.[def.productItemId] || 0;
  return Math.max(0, Math.round(target + avgSold - stock));
}
