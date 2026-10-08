// 物价会动：综合商店零售价系数与批发市场自动调价共用的纯函数（不碰 state、不碰 DOM）。
//
// 规则（阈值与步长见 content/rules.js 的 priceAdjust）：
// - 库存天数 = 库存 / 日均销量（无销量有库存时为无穷大）。
// - 积压（库存天数 > highStockDays）：系数 × (1 − stepDown)，降价去库存。
// - 紧缺（有拒客/断货需求，且库存天数 < lowStockDays）：系数 × (1 + stepUp)；库存已空时用 shortageStepUp，涨得更快。
// - 其余：系数向 1 回归，每次 driftStep，不越过 1。
// - 结果限制在 [minFactor, maxFactor] 内，保留 4 位小数。

export function stockDaysOf(stockUnits, avgSoldUnits) {
  const stock = Math.max(0, Number(stockUnits) || 0);
  const sold = Math.max(0, Number(avgSoldUnits) || 0);
  if (sold > 0) return stock / sold;
  return stock > 0 ? Number.POSITIVE_INFINITY : 0;
}

export function nextPriceFactor(factor, { stockUnits = 0, avgSoldUnits = 0, shortage = false } = {}, rules = {}) {
  const cfg = {
    highStockDays: 21, lowStockDays: 3, stepDown: 0.05, stepUp: 0.05, shortageStepUp: 0.10,
    driftStep: 0.02, minFactor: 0.7, maxFactor: 1.5, ...rules
  };
  const current = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const stockDays = stockDaysOf(stockUnits, avgSoldUnits);
  let next = current;
  let reason = "";
  if (stockDays > cfg.highStockDays) {
    next = current * (1 - cfg.stepDown);
    reason = "积压降价";
  } else if (shortage && stockDays < cfg.lowStockDays) {
    next = current * (1 + (stockDays === 0 ? cfg.shortageStepUp : cfg.stepUp));
    reason = "紧缺涨价";
  } else if (current > 1) {
    next = Math.max(1, current - cfg.driftStep);
    reason = "回归正常";
  } else if (current < 1) {
    next = Math.min(1, current + cfg.driftStep);
    reason = "回归正常";
  }
  const clamped = Math.min(cfg.maxFactor, Math.max(cfg.minFactor, next));
  return { factor: Math.round(clamped * 10000) / 10000, reason };
}

// 读取某商品的当前系数（缺省 1）。只读，供售价计算与面板使用。
export function priceFactorOf(pricing, itemId) {
  const value = Number(pricing?.priceFactor?.[itemId]);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

// 综合商店售价下限：不低于进货价；只有清库存（priceClearance）时可降到进货价 × minFactor。
export function retailFloorOf(pricing, itemId, wholesale, rules = {}) {
  return pricing?.priceClearance?.[itemId] ? wholesale * (rules.minFactor ?? 0.7) : wholesale;
}
