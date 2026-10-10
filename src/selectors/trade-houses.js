// 贸易行只读视图（docs/TRADE.md「贸易中心与贸易行」）：每家贸易行今日与近 7 日的买卖、利润、运费、小麦与运力份额，
// 以及批发市场各商品的存货天数（紧缺标记）。只读，不写 state。
import { currencyScale } from "../economy/currency.js";
import { policyTradeMarginPercent } from "../economy/margin-policy.js";
import { maximumPayableValueUnits } from "../economy/payment.js";
import { shopClerkCount, shopClerkLimit, shopDefinition, shopMaxMerchants, shopMerchantCount } from "../systems/shops.js";
import { dailyCapacityJin, freightPoolJin, freightVoucherPerJin } from "../systems/logistics.js";
import { hasWholesaleMarket, wholesaleMonopolyItemIds } from "../systems/wholesale-market.js";
import { localAvgSoldJin } from "../systems/trading-houses.js";

const WEEK_DAYS = 7;
const round1 = value => Math.round(value * 10) / 10;
const round2 = value => Math.round(value * 100) / 100;

function addMap(target, source) {
  for (const [itemId, jin] of Object.entries(source || {})) target[itemId] = (target[itemId] || 0) + (jin || 0);
  return target;
}

// 把若干日志行汇总成一段（今日 / 近 7 日）。金额换算成粮券，数量为斤。
function summarize(rows, content) {
  const scale = currencyScale(content);
  const exportMap = {};
  const importMap = {};
  const totals = { revenueVoucherUnits: 0, cogsVoucherUnits: 0, freightVoucherUnits: 0, tariffVoucherUnits: 0, profitVoucherUnits: 0, trades: 0, usedJin: 0, shareJin: 0, budgetJin: 0 };
  for (const row of rows) {
    addMap(exportMap, row.exportJin);
    addMap(importMap, row.importJin);
    for (const key of Object.keys(totals)) totals[key] += row[key] || 0;
  }
  const names = itemId => content.items[itemId]?.name || itemId;
  const list = map => Object.entries(map).filter(([, jin]) => jin > 0)
    .map(([itemId, jin]) => ({ itemId, name: names(itemId), jin: round2(jin) }))
    .sort((a, b) => b.jin - a.jin || a.itemId.localeCompare(b.itemId));
  const exportJin = list(exportMap);
  const importJin = list(importMap);
  const costVoucher = totals.cogsVoucherUnits + totals.freightVoucherUnits;
  return {
    days: rows.length,
    exportJin, importJin,
    exportTotalJin: round2(exportJin.reduce((sum, row) => sum + row.jin, 0)),
    importTotalJin: round2(importJin.reduce((sum, row) => sum + row.jin, 0)),
    usedJin: round2(totals.usedJin),
    avgDailyJin: rows.length ? round2(totals.usedJin / rows.length) : 0,
    trades: totals.trades,
    revenueVoucher: round2(totals.revenueVoucherUnits / scale),
    cogsVoucher: round2(totals.cogsVoucherUnits / scale),
    freightVoucher: round2(totals.freightVoucherUnits / scale),
    // 进出口关税（交镇库，只对贸易行征收）。
    tariffVoucher: round2(totals.tariffVoucherUnits / scale),
    profitVoucher: round2(totals.profitVoucherUnits / scale),
    // 实际单斤利润率（利润 ÷ 成本 = 买价 + 运费）；没有成交时为 null。
    marginPercent: costVoucher > 0 ? round1(totals.profitVoucherUnits / costVoucher * 100) : null,
    budgetJin: round2(totals.budgetJin),
    shareJin: round2(totals.shareJin),
    capacityUsedPercent: totals.shareJin > 0 ? Math.round(totals.usedJin / totals.shareJin * 100) : null
  };
}

// 批发市场各可买卖商品的存货天数（只读）：紧缺 = 存货不到 tradeHouseImportShortageDays 天销量，封出口 = 不到 tradeHouseExportMinStockDays 天。
function marketRows(state, content) {
  if (!hasWholesaleMarket(state)) return [];
  const scale = content.precision.inventoryUnitsPerJin;
  const exportDays = content.rules.tradeHouseExportMinStockDays ?? 10;
  const shortageDays = content.rules.tradeHouseImportShortageDays ?? 3;
  return wholesaleMonopolyItemIds(content).map(itemId => {
    const stockJin = (state.wholesaleMarket?.inventory?.[itemId] || 0) / scale;
    const avgSoldJin = localAvgSoldJin(state, content, itemId);
    const stockDays = avgSoldJin > 0 ? round1(stockJin / avgSoldJin) : null;
    return {
      itemId, name: content.items[itemId]?.name || itemId,
      stockJin: round2(stockJin), avgSoldJin: round2(avgSoldJin), stockDays,
      exportBlocked: avgSoldJin > 0 && stockJin < exportDays * avgSoldJin,
      shortage: avgSoldJin > 0 && stockJin < shortageDays * avgSoldJin
    };
  });
}

export function selectTradeHouseView(state, content) {
  const scale = content.precision.inventoryUnitsPerJin;
  const voucherScale = currencyScale(content);
  const houses = Object.values(state.shops || {})
    .filter(shop => shop.status !== "closed" && shopDefinition(content, shop.typeId)?.kind === "trade")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(shop => {
      const log = Array.isArray(shop.tradeLog) ? shop.tradeLog : [];
      const today = log.at(-1) || null;
      const week = log.slice(-WEEK_DAYS);
      const clerks = shopClerkCount(state, shop);
      const merchants = shopMerchantCount(state, shop);
      return {
        id: shop.id,
        name: shop.name,
        buildingId: shop.buildingId,
        status: shop.status,
        statusReason: shop.statusReason || "",
        ownerName: state.households?.byId?.[shop.ownerHouseholdId]?.name || shop.ownerHouseholdId,
        merchants, maxMerchants: shopMaxMerchants(shop, content),
        clerks, maxClerks: shopClerkLimit(shop, content),
        staff: clerks + merchants,
        // 店员由系统按销量自动增减；诊断与近 7 日日均成交（只读，来自 shop.plan）。
        staffingDiagnosis: shop.plan?.staffingDiagnosis || null,
        expectedDailyTradeJin: Number.isFinite(shop.plan?.expectedDailyTradeJin) ? round2(shop.plan.expectedDailyTradeJin) : null,
        // 今日（最近一个日结日）的预算与运力份额；没有日志时为 null。
        budgetJin: today ? round2(today.budgetJin) : null,
        shareJin: today ? round2(today.shareJin) : null,
        wheatJin: round2((shop.cashWheatUnits || 0) / scale),
        cashVoucher: round2(maximumPayableValueUnits(state, `shop:${shop.id}`, content) / voucherScale),
        today: summarize(today ? [today] : [], content),
        week: summarize(week, content)
      };
    });
  const allToday = houses.map(house => house.today);
  const allWeek = houses.map(house => house.week);
  const totalsOf = views => ({
    exportTotalJin: round2(views.reduce((sum, view) => sum + view.exportTotalJin, 0)),
    importTotalJin: round2(views.reduce((sum, view) => sum + view.importTotalJin, 0)),
    revenueVoucher: round2(views.reduce((sum, view) => sum + view.revenueVoucher, 0)),
    freightVoucher: round2(views.reduce((sum, view) => sum + view.freightVoucher, 0)),
    tariffVoucher: round2(views.reduce((sum, view) => sum + view.tariffVoucher, 0)),
    profitVoucher: round2(views.reduce((sum, view) => sum + view.profitVoucher, 0)),
    trades: views.reduce((sum, view) => sum + view.trades, 0)
  });
  return {
    houseCount: houses.length,
    staff: houses.reduce((sum, house) => sum + house.staff, 0),
    dailyCapacityJin: dailyCapacityJin(state, content),
    poolJin: freightPoolJin(state),
    freightVoucherPerJin: freightVoucherPerJin(state, content),
    targetMarginPercent: policyTradeMarginPercent(state, content, "export"),
    importMarginPercent: policyTradeMarginPercent(state, content, "import"),
    jinPerClerk: content.rules.tradeHouseJinPerClerk ?? 100,
    capacitySharePercent: round1((content.rules.tradeHouseCapacityShare ?? 0.5) * 100),
    exportMinStockDays: content.rules.tradeHouseExportMinStockDays ?? 10,
    importShortageDays: content.rules.tradeHouseImportShortageDays ?? 3,
    markets: marketRows(state, content),
    houses,
    todayTotals: totalsOf(allToday),
    weekTotals: totalsOf(allWeek),
    // 进出口关税设置与收入（粮券）：只读 state.policy.tradeTariff 与 state.tradeTariffs。
    tariff: {
      importPercent: state.policy?.tradeTariff?.importPercent ?? 0,
      exportPercent: state.policy?.tradeTariff?.exportPercent ?? 0,
      maximumPercent: content.rules.tradeTariffMaximumPercent ?? 50,
      thisYearVoucher: round2((state.tradeTariffs?.byYear?.[state.year] || 0) / voucherScale),
      cumulativeVoucher: round2((state.tradeTariffs?.cumulativeVoucherUnits || 0) / voucherScale)
    }
  };
}
