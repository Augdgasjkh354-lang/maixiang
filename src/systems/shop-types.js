// 店型判断：综合商店与酒馆共用的规则，以及酒类专售令（policy.liquorMonopoly）、限定店型的商品（retailShopTypeIds）。纯函数，不写 state。
//
// usesGeneralRules：与综合商店同规则的店型（接待能力、店员上限、动态加价与调价、目标利润率、居民买卖的价格弹性）。
//   综合商店自身 id 为 general；酒馆在 rules.shopTypes 里标 generalRules: true。
// shopMayStockItem：这种店能不能经营这种商品。专售令开启后，酒类只许酒馆经营（综合商店、时代广场停售、不进货）。

export function usesGeneralRules(def) {
  return Boolean(def) && (def.id === "general" || def.generalRules === true);
}

export function isLiquorItem(content, itemId) {
  return content.items?.[itemId]?.liquor === true;
}

export function liquorMonopolyOn(state) {
  return state?.policy?.liquorMonopoly === true;
}

// 限定店型的商品（items 的 retailShopTypeIds，如珠宝只进金银店）：其他店型不经营、不进货。
export function shopMayStockItem(state, def, itemId, content) {
  const allowed = content.items?.[itemId]?.retailShopTypeIds;
  if (allowed && !allowed.includes(def?.id)) return false;
  if (!liquorMonopolyOn(state) || !isLiquorItem(content, itemId)) return true;
  return def?.id === "tavern";
}
