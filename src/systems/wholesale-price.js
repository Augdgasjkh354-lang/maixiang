// 批发价（用户原 W0）：批发市场价 → 遗留市场价 → 食盐规则价 → 规则默认值。
// 单独成文件：wealth-stats.js 与 redistribution.js 互相需要它，放在任一边都会成环。
export function wholesalePrice(state, itemId, content) {
  const market = state.wholesaleMarket?.pricesVoucherPerUnit || {};
  if (Number.isFinite(market[itemId]) && market[itemId] > 0) return Number(market[itemId]);
  const legacy = state.market?.pricesVoucherPerUnit || {};
  if (Number.isFinite(legacy[itemId]) && legacy[itemId] > 0) return Number(legacy[itemId]);
  if (itemId === "salt" && Number.isFinite(content.rules.saltPriceWheatPerJin)) {
    return Number(content.rules.saltPriceWheatPerJin);
  }
  return Number(content.rules.marketPricesVoucherPerUnit?.[itemId] ?? 0);
}
