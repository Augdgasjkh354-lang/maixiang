// 养殖基地：养殖场（kind: "farm" 的店铺）每天喂料出肉。
// 养殖户（商人）和饲养员都干活，每人每日出 outputPerWorkerDay 斤，每斤吃 feedPerUnit 斤饲料（小麦）。
// 肉先卖给综合商店（见 shops.js 的 buyFromFarms），存货超过 3 天产量的部分卖给批发市场。
import { currencyScale } from "../economy/currency.js";
import { currentPaymentComposition, maximumPayableValueUnits, settleMonetaryPayment } from "../economy/payment.js";
import { putStock, takeStock } from "../economy/trade.js";
import { addBookMap, addBookValue, applyProfit, ensureShops, farmDailyOutputUnits, shopDefinition } from "./shops.js";
import { depositWholesalePurchasedInventory, hasWholesaleMarket, wholesaleAvgSoldUnits, wholesaleMarketItemIds, wholesalePurchasePrice } from "./wholesale-market.js";

const SURPLUS_DAYS = 3;

function openFarms(state, content) {
  return Object.values(ensureShops(state, content)).filter(shop => shop.status === "open" && shopDefinition(content, shop.typeId)?.kind === "farm");
}

export function produceLivestock(state, content) {
  const rows = [];
  for (const farm of openFarms(state, content)) {
    const def = shopDefinition(content, farm.typeId);
    const capacity = farmDailyOutputUnits(state, farm, content);
    const feedStock = farm.inventory?.[def.feedItemId] || 0;
    const output = Math.min(capacity, Math.floor(feedStock / def.feedPerUnit));
    if (output <= 0) {
      if (capacity > 0) farm.statusReason = "缺饲料";
      rows.push({ shopId: farm.id, producedUnits: 0 });
      continue;
    }
    const feed = takeStock(farm, def.feedItemId, Math.ceil(output * def.feedPerUnit));
    putStock(farm, def.productItemId, output, feed.costUnits);
    addBookMap(farm, "producedUnits", def.productItemId, output);
    addBookMap(farm, "consumedUnits", def.feedItemId, feed.units);
    rows.push({ shopId: farm.id, producedUnits: output, feedUnits: feed.units });
  }
  sellFarmSurplusToWholesale(state, content);
  return rows;
}

// 存货超过 3 天产量的部分按收购价卖给批发市场（镇库付款），让摊位和外贸也能拿到肉。
export function sellFarmSurplusToWholesale(state, content) {
  if (!hasWholesaleMarket(state)) return 0;
  let sold = 0;
  for (const farm of openFarms(state, content)) {
    const def = shopDefinition(content, farm.typeId);
    const itemId = def.productItemId;
    if (!wholesaleMarketItemIds(content).includes(itemId)) continue;
    const keep = Math.max(farmDailyOutputUnits(state, farm, content), content.precision.inventoryUnitsPerJin) * SURPLUS_DAYS;
    // 批发市场只收到自己 10 天销量（至少 20 斤）为止，不无限囤货。
    const marketRoom = Math.max(20 * content.precision.inventoryUnitsPerJin, wholesaleAvgSoldUnits(state, itemId, content, 7) * 10) - (state.wholesaleMarket?.inventory?.[itemId] || 0);
    const surplus = Math.min(Math.max(0, marketRoom), Math.max(0, (farm.inventory?.[itemId] || 0) - keep));
    if (surplus <= 0) continue;
    const price = wholesalePurchasePrice(state, itemId, content);
    if (!(price > 0)) continue;
    const scale = content.precision.inventoryUnitsPerJin;
    const affordable = Math.floor(maximumPayableValueUnits(state, "town", content) * scale / (price * currencyScale(content)));
    const units = Math.min(surplus, affordable);
    if (units <= 0) continue;
    const value = Math.round(units / scale * price * currencyScale(content));
    const payment = settleMonetaryPayment(state, "town", `shop:${farm.id}`, currentPaymentComposition(state, value), content,
      "wholesale_farm_purchase", `批发市场收购${farm.name}的${content.items[itemId]?.name || itemId}`, { requireFull: true });
    if (!payment.ok) continue;
    const taken = takeStock(farm, itemId, units);
    addBookValue(farm, "revenueVoucherUnits", value);
    addBookValue(farm, "cogsVoucherUnits", taken.costUnits);
    addBookMap(farm, "soldUnits", itemId, taken.units);
    applyProfit(farm, value - taken.costUnits);
    depositWholesalePurchasedInventory(state, itemId, taken.units, value, content);
    sold += taken.units;
  }
  return sold;
}
