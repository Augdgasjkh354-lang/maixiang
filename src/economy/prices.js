export function currentUnitPrice(state, itemId, content) {  const defaults = content.rules.marketPricesVoucherPerUnit || {};
  const wholesale = state.wholesaleMarket?.pricesVoucherPerUnit || {};
  if (Number.isFinite(wholesale[itemId]) && wholesale[itemId] > 0) return Number(wholesale[itemId]);
  const unified = state.market?.pricesVoucherPerUnit || {};
  if (Number.isFinite(unified[itemId]) && unified[itemId] > 0) return Number(unified[itemId]);
  if (itemId === "bread") {
    const legacy = state.market?.breadPriceVoucherPerJin ?? state.market?.breadPriceWheatPerJin;
    if (Number.isFinite(legacy) && legacy > 0) return Number(legacy);
  }
  if (itemId === "flour" || itemId === "wood") {
    const legacy = state.market?.intermediatePricesVoucherPerUnit?.[itemId];
    if (Number.isFinite(legacy) && legacy > 0) return Number(legacy);
  }
  if (itemId === "salt" && Number.isFinite(content.rules.saltPriceWheatPerJin)) {
    return Number(content.rules.saltPriceWheatPerJin);
  }
  return Number(defaults[itemId] ?? 0);
}

export function currentPriceMap(state, content) {
  return Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, currentUnitPrice(state, itemId, content)]));
}

export function setCurrentUnitPrice(state, itemId, price, content) {
  const value = Math.round(Number(price) * 1000) / 1000;
  if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: "价格须为正的有限数值" };
  // 钳制到官价锚定区间，防止输错数量级或恶意压价（如木材 0.001）扭曲结算；
  // 正常调价落在区间内不受影响。content 可选，不传时保持旧行为。
  const band = content ? priceBandForItem(itemId, content) : null;
  let finalValue = value;
  let clamped = false;
  if (band) {
    if (finalValue < band.min) { finalValue = band.min; clamped = true; }
    else if (finalValue > band.max) { finalValue = band.max; clamped = true; }
  }
  state.market ||= {};
  state.market.pricesVoucherPerUnit ||= {};
  state.market.pricesVoucherPerUnit[itemId] = finalValue;
  state.wholesaleMarket ||= {};
  state.wholesaleMarket.pricesVoucherPerUnit ||= {};
  state.wholesaleMarket.pricesVoucherPerUnit[itemId] = finalValue;
  if (state.market.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  if (itemId === "bread") {
    state.market.breadPriceWheatPerJin = finalValue;
    state.market.breadPriceVoucherPerJin = finalValue;
  }
  if (itemId === "flour" || itemId === "wood") {
    state.market.intermediatePricesVoucherPerUnit ||= {};
    state.market.intermediatePricesVoucherPerUnit[itemId] = finalValue;
  }
  return { ok: true, value: finalValue, clamped };
}

// 价格锚定区间：以官价（content.rules.marketPricesVoucherPerUnit）为基准的 [0.5x, 3x]。
// 官价是游戏的经济价值尺度（推荐价/回退价/初始价都以它为准），且玩家不可写，
// 不会被漏洞污染（不像当前价、成本价那样可被操纵或为零）。
// 0.5x 允许倾销式压价刺激，3x 允许稀缺式提价；超出即为输错数量级或恶意。
export const PRICE_BAND_LOWER_RATIO = 0.5;
export const PRICE_BAND_UPPER_RATIO = 3;

export function priceBandForItem(itemId, content) {
  const reference = content?.rules?.marketPricesVoucherPerUnit?.[itemId];
  if (!Number.isFinite(reference) || reference <= 0) return null;
  const round3 = function (n) { return Math.round(n * 1000) / 1000; };
  return {
    reference,
    min: round3(reference * PRICE_BAND_LOWER_RATIO),
    max: round3(reference * PRICE_BAND_UPPER_RATIO)
  };
}

export function applyRecommendedIndustryPrices(state, content) {
  const defaults = content.rules.marketPricesVoucherPerUnit || {};
  state.market ||= {};
  const recommendation = state.market.priceRecommendation || {};
  const itemIds = Array.isArray(recommendation.items) && recommendation.items.length
    ? recommendation.items.map(row => row.itemId).filter(itemId => itemId === "flour" || itemId === "wood")
    : ["flour", "wood"];
  for (const itemId of itemIds) {
    if (Number.isFinite(defaults[itemId]) && defaults[itemId] > 0) setCurrentUnitPrice(state, itemId, defaults[itemId], content);
  }
  state.market.priceRecommendation ||= {};
  state.market.priceRecommendation.pending = false;
  state.market.priceRecommendation.choice = "adopted";
  return { ok: true, prices: currentPriceMap(state, content) };
}

export function keepExistingIndustryPrices(state, content) {
  state.market ||= {};
  state.market.priceRecommendation ||= {};
  state.market.priceRecommendation.pending = false;
  state.market.priceRecommendation.choice = "kept";
  return { ok: true, prices: currentPriceMap(state, content) };
}

export function theoreticalFullSaleProfitPerWorker(state, typeId, content) {
  const definition = content.buildings[typeId];
  const recipe = definition?.recipeId ? content.recipes[definition.recipeId] : null;
  const job = definition?.jobs?.[0];
  if (!recipe || !job) return null;
  const batches = recipe.batchesPerWorkerDay || 0;
  const taxPercent = state.policy?.privateProductionTaxPercent?.[typeId] ?? content.rules.privateProductionTaxDefaultPercent ?? 10;
  const grossRevenue = (recipe.outputs || []).reduce((sum, row) =>
    sum + row.quantity * batches * currentUnitPrice(state, row.itemId, content) * (1 - taxPercent / 100), 0);
  const inputCost = (recipe.inputs || []).reduce((sum, row) =>
    sum + row.quantity * batches * currentUnitPrice(state, row.itemId, content), 0);
  const wage = state.employment?.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 5;
  return {
    typeId,
    batchesPerWorkerDay: batches,
    taxPercent,
    grossRevenueVoucher: grossRevenue,
    inputCostVoucher: inputCost,
    wageVoucher: wage,
    profitVoucher: grossRevenue - inputCost - wage
  };
}
