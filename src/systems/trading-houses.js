// 贸易行（docs/TRADE.md「贸易中心与贸易行」）：贸易中心里的店铺（kind "trade"），店主与店员每天自己做外镇买卖。
//
//   出口：从批发市场按售价进货 → 卖给外镇（外镇付小麦，小麦存进店里的支付小麦）。
//         批发市场存量不到 tradeHouseExportMinStockDays 天销量时不出口；只出存量超出这部分的余量。
//   进口：向外镇买（付店里的小麦）→ 按批发收购价卖给批发市场（市场付粮券）。
//         进口量封顶：市场存量不超过 30 天销量（至少 20 斤）。
//   运费：每运一斤付 freightVoucherPerJin 给镇库（同一条运费规则）。
//   利润率 = (卖价 − 买价 − 运费) / (买价 + 运费) 须达到 tradeHouseTargetMarginPercent 才做。
//   成交量：min(店员 × tradeHouseJinPerClerk, 当日运力 × tradeHouseCapacityShare 按店员数分的份额)，实际运力从运力池扣。
//   只在外贸房在岗时做买卖（与镇长手动外贸同一条规则）。
//
// 全部按"对同一外镇同一商品的同一方向"逐笔算价：每笔用当时的价格（大单逐段计价，越做越薄），按利润率取能做的最大量。
// 每天的候选按入口利润率排序，贪心执行，直到运力、店员额度、资金、外镇库存或小麦用完。
// 复杂度：O(贸易行 × 外镇 × 商品)（一天一次，没有逐户循环）。
import { currencyScale } from "../economy/currency.js";
import { currentPaymentComposition, maximumPayableValueUnits, quoteMonetaryPayment, settleMonetaryPayment } from "../economy/payment.js";
import { putStock, takeStock, valueOf } from "../economy/trade.js";
import { makeTransactionId, recordLedger } from "../economy/ledger.js";
import { voucherUnitsForWheatUnits, wheatUnitsForVoucherUnits } from "../economy/money-units.js";
import { addBookMap, addBookValue, applyProfit, ensureShops, shopClerkCount, shopDefinition, shopMerchantCount } from "./shops.js";
import {
  buyWholesaleForOwner, depositWholesalePurchasedInventory, ensureWholesaleMarket, hasWholesaleMarket,
  wholesaleAvgSoldUnits, wholesaleMonopolyItemIds, wholesalePurchasePrice, wholesaleUnitPrice
} from "./wholesale-market.js";
import {
  buildingOperational, deliverToOutsideTown, ensureOutsideTowns, goodOf, outsideTownProfile,
  quoteValue, recordTradeStats, sellableStock, unitPrice, affordableSellQuantity
} from "./outside-town.js";
import { dailyCapacityJin, freightPoolJin, freightVoucherPerJin, takeFreightCapacity } from "./logistics.js";

const AVG_DAYS = 7;
const IMPORT_STOCK_CAP_DAYS = 30;
const IMPORT_STOCK_FLOOR_JIN = 20;
const HISTORY_LIMIT = 30;
const MIN_JIN = 0.01;

const round2 = value => Math.round(value * 100) / 100;
const nonNegative = value => Math.max(0, Number(value) || 0);

export function isTradeHouse(shop, content) {
  return shopDefinition(content, shop?.typeId)?.kind === "trade";
}

// 贸易行的人手 = 店员 + 商人（店主兼商人的也算）。
export function tradeHouseStaff(state, shop) {
  return shopClerkCount(state, shop) + shopMerchantCount(state, shop);
}

// 每天的日志行（只读展示与 7 日汇总用）。
function blankTradeRow(serial, staff, shareJin, budgetJin) {
  return {
    serial, staff, shareJin: round2(shareJin), budgetJin: round2(budgetJin), usedJin: 0, trades: 0,
    exportJin: {}, importJin: {}, revenueVoucherUnits: 0, cogsVoucherUnits: 0, freightVoucherUnits: 0, profitVoucherUnits: 0
  };
}

function serialOf(state, content) {
  return (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
}

function owner(shop) {
  return `shop:${shop.id}`;
}

// 单调谓词的最大解：pred(0+) 为真，返回 [0, hi] 中最大的 x 使 pred(x) 为真（二分，36 次足够精确到百万分之一斤）。
function largestWhere(hi, pred) {
  if (!(hi > 0)) return 0;
  if (pred(hi)) return hi;
  let lo = 0;
  let top = hi;
  for (let i = 0; i < 36; i++) {
    const mid = (lo + top) / 2;
    if (pred(mid)) lo = mid; else top = mid;
  }
  return lo;
}

// 本镇自己的日均销量（斤，近 7 日）：批发市场的售出量里要扣掉贸易行自己的出口进货，
// 否则出口会把自己算成"需求"，抬高保本线、形成自我抑制。
export function localAvgSoldJin(state, content, itemId) {
  const scale = content.precision.inventoryUnitsPerJin;
  const history = (state.wholesaleMarket?.history || []).slice(-AVG_DAYS);
  if (history.length === 0) return 0;
  const total = wholesaleAvgSoldUnits(state, itemId, content, AVG_DAYS) / scale;
  let tradeJin = 0;
  for (const shop of Object.values(state.shops || {})) {
    if (!isTradeHouse(shop, content)) continue;
    for (const row of (shop.tradeLog || []).slice(-history.length)) tradeJin += row.exportJin?.[itemId] || 0;
  }
  return Math.max(0, total - tradeJin / history.length);
}

// 运费（粮券单位）：按运走的斤数向上取整，运费与小麦之间 1 券 = 1 斤（见 money-units）。
function freightUnitsOf(qJin, freight, content) {
  return Math.ceil(qJin * freight * currencyScale(content) - 1e-9);
}

function marginTarget(content) {
  return 1 + (content.rules.tradeHouseTargetMarginPercent ?? 10) / 100;
}

// 外镇候选：每个未封关的外镇、每样它做的商品；出口（我们卖）一律有，进口（我们买）只看它愿意卖的。
function candidatesFor(state, content) {
  const out = [];
  for (const town of Object.values(ensureOutsideTowns(state, content))) {
    if (town.tradeClosed) continue;
    const profile = outsideTownProfile(content, town.id);
    if (!profile) continue;
    for (const itemId of Object.keys(profile.goods)) {
      const good = goodOf(profile, itemId);
      if (!good) continue;
      out.push({ town, profile, itemId, good, direction: "export" });
      if (good.sellsToUs) out.push({ town, profile, itemId, good, direction: "import" });
    }
  }
  return out;
}

// 排序用的当前利润率（不考虑成交量）：返回 null 表示这条路现在走不通。
function quickMarginRatio(state, content, cand) {
  if (!hasWholesaleMarket(state) || !wholesaleMonopolyItemIds(content).includes(cand.itemId)) return null;
  const freight = freightVoucherPerJin(state, content);
  if (cand.direction === "export") {
    const price = wholesaleUnitPrice(state, cand.itemId, content);
    if (!(price > 0)) return null;
    return unitPrice(cand.town, cand.good, "sell") / (price + freight) - 1;
  }
  const price = wholesalePurchasePrice(state, cand.itemId, content);
  if (!(price > 0)) return null;
  return price / (unitPrice(cand.town, cand.good, "buy") + freight) - 1;
}

// 出口计划：返回 { units, qJin } 或 null。只读，不改 state。
function planExport(state, content, run, cand) {
  const { town, profile, itemId, good } = cand;
  const scale = content.precision.inventoryUnitsPerJin;
  const price = wholesaleUnitPrice(state, itemId, content);
  if (!(price > 0)) return null;
  const freight = freightVoucherPerJin(state, content);
  const cost = price + freight;
  const minSell = cost * marginTarget(content);
  if (unitPrice(town, good, "sell") < minSell) return null;
  const market = ensureWholesaleMarket(state, content);
  const stockJin = nonNegative(market.inventory?.[itemId]) / scale;
  // 至少留 townOutputMinStockJin（200 斤）：还没有销量记录时也不把批发市场卖空。
  const reserveJin = Math.max(content.rules.townOutputMinStockJin ?? 200, (content.rules.tradeHouseExportMinStockDays ?? 10) * localAvgSoldJin(state, content, itemId));
  // 保本地供应：存量不到 reserve 天销量时不出口，只出超出的余量。
  if (stockJin - reserveJin < MIN_JIN) return null;
  const cashJin = maximumPayableValueUnits(state, owner(run.shop), content) / (currencyScale(content) * cost);
  const avgSell = x => quoteValue(town, good, "sell", x) / x;
  let q = Math.min(stockJin - reserveJin, run.remainingJin, freightPoolJin(state), cashJin);
  q = largestWhere(q, x => avgSell(x) >= minSell);
  q = affordableSellQuantity(town, profile, good, q);
  const units = Math.floor(q * scale + 1e-6);
  return units >= 1 ? { units, qJin: units / scale } : null;
}

// 进口计划：返回 { units, qJin, wheatPayUnits, freightUnits, sellValueUnits } 或 null。只读。
function planImport(state, content, run, cand) {
  const { town, itemId, good } = cand;
  const scale = content.precision.inventoryUnitsPerJin;
  const currency = currencyScale(content);
  const price = wholesalePurchasePrice(state, itemId, content);
  if (!(price > 0)) return null;
  const freight = freightVoucherPerJin(state, content);
  const maxCost = price / marginTarget(content);
  if (unitPrice(town, good, "buy") + freight > maxCost) return null;
  const market = ensureWholesaleMarket(state, content);
  const stockJin = nonNegative(market.inventory?.[itemId]) / scale;
  const avgSoldJin = localAvgSoldJin(state, content, itemId);
  const roomJin = Math.max(IMPORT_STOCK_FLOOR_JIN, IMPORT_STOCK_CAP_DAYS * avgSoldJin) - stockJin;
  if (roomJin < MIN_JIN) return null;
  // 镇库要付得起货款（粮券）。
  const townCashJin = maximumPayableValueUnits(state, "town", content) / (currency * price);
  const wheatHeld = nonNegative(run.shop.cashWheatUnits);
  const buyAvg = x => quoteValue(town, good, "buy", x) / x;
  const payUnitsOf = x => Math.round(quoteValue(town, good, "buy", x) * scale);
  // 小麦：货款小麦 + 运费折算的小麦都要在店里（支付的运费可能只用小麦）。
  const wheatOk = x => payUnitsOf(x) + wheatUnitsForVoucherUnits(freightUnitsOf(x, freight, content), content, "ceil") <= wheatHeld;
  let q = Math.min(roomJin, sellableStock(town, good), run.remainingJin, freightPoolJin(state), townCashJin);
  q = largestWhere(q, x => buyAvg(x) + freight <= maxCost);
  q = largestWhere(q, wheatOk);
  const units = Math.floor(q * scale + 1e-6);
  if (units < 1) return null;
  const qJin = units / scale;
  return { units, qJin, wheatPayUnits: payUnitsOf(qJin), freightUnits: freightUnitsOf(qJin, freight, content), sellValueUnits: valueOf(units, price, content) };
}

// 出口成交：先买货进店，再付运费，再把货交给外镇、收小麦。运费付不起时货留在店里（不凭空消失）。
function executeExport(state, content, run, cand, plan) {
  const { shop } = run;
  const { town, profile, itemId, good } = cand;
  const scale = content.precision.inventoryUnitsPerJin;
  const label = content.items[itemId]?.name || itemId;
  const bought = buyWholesaleForOwner(state, owner(shop), itemId, plan.units, content, `${shop.name}从批发市场进货${label}`);
  if (!bought.ok || !(bought.boughtUnits > 0)) return null;
  const units = bought.boughtUnits;
  const paidUnits = bought.paidVoucherUnits || 0;
  putStock(shop, itemId, units, paidUnits);
  addBookValue(shop, "purchaseVoucherUnits", paidUnits);
  addBookMap(shop, "purchasedUnits", itemId, units);
  const qJin = units / scale;
  const valueJin = round2(quoteValue(town, good, "sell", qJin));
  const valueWheatUnits = Math.round(valueJin * scale);
  const freightUnits = freightUnitsOf(qJin, freightVoucherPerJin(state, content), content);
  const freight = settleMonetaryPayment(state, owner(shop), "town", currentPaymentComposition(state, freightUnits), content,
    "freight", `${shop.name}运${label}至${profile.name}的运费`, { requireFull: true });
  if (!freight.ok) return { ok: false, qJin: 0, stuckUnits: units };
  takeFreightCapacity(state, qJin, content);
  const taken = takeStock(shop, itemId, units);
  deliverToOutsideTown(town, itemId, qJin);
  town.wheatStockJin = round2(Math.max(0, town.wheatStockJin - valueJin));
  shop.cashWheatUnits = nonNegative(shop.cashWheatUnits) + valueWheatUnits;
  const revenue = voucherUnitsForWheatUnits(valueWheatUnits, content, "floor");
  const paidFreight = freight.paidValueUnits || 0;
  addBookValue(shop, "revenueVoucherUnits", revenue);
  addBookValue(shop, "cogsVoucherUnits", taken.costUnits);
  addBookValue(shop, "freightVoucherUnits", paidFreight);
  addBookMap(shop, "soldUnits", itemId, taken.units);
  applyProfit(shop, revenue - taken.costUnits - paidFreight);
  recordTradeStats(town, "sell", valueJin);
  recordLedger(state, {
    type: "trade_house_export", transactionId: makeTransactionId(state), source: owner(shop), destination: "outside_town",
    itemId, quantityUnits: taken.units, qeqUnits: 0,
    reason: `${shop.name}向${profile.name}出口${label}${round2(qJin)}斤，收小麦${valueJin}斤`
  }, content);
  return { ok: true, qJin: taken.units / scale, profitVoucherUnits: revenue - taken.costUnits - paidFreight, revenue, cogs: taken.costUnits, freight: paidFreight, direction: "export" };
}

// 进口成交：付小麦给外镇，再付运费，货入店，再按批发收购价卖给批发市场。
function executeImport(state, content, run, cand, plan) {
  const { shop } = run;
  const { town, profile, itemId, good } = cand;
  const scale = content.precision.inventoryUnitsPerJin;
  const label = content.items[itemId]?.name || itemId;
  const price = wholesalePurchasePrice(state, itemId, content);
  const qJin = plan.qJin;
  const valueJin = round2(quoteValue(town, good, "buy", qJin));
  const payUnits = Math.round(valueJin * scale);
  const freightUnits = plan.freightUnits;
  const sellValue = valueOf(plan.units, price, content);
  // 预检（不动钱）：镇库付得起收购款；店里的小麦付得起货款加运费。
  if (!quoteMonetaryPayment(state, "town", currentPaymentComposition(state, sellValue), content).full) return null;
  if (payUnits + wheatUnitsForVoucherUnits(freightUnits, content, "ceil") > nonNegative(shop.cashWheatUnits)) return null;
  // ① 小麦付给外镇（实物，外镇没有账户）。
  shop.cashWheatUnits = nonNegative(shop.cashWheatUnits) - payUnits;
  // ② 运费付镇库；失败则把小麦退回（没有任何东西丢失）。
  const freight = settleMonetaryPayment(state, owner(shop), "town", currentPaymentComposition(state, freightUnits), content,
    "freight", `${shop.name}运${label}自${profile.name}的运费`, { requireFull: true });
  if (!freight.ok) {
    shop.cashWheatUnits += payUnits;
    return null;
  }
  // ③ 外镇发货：库存减少、小麦增加；运力从池子扣。
  takeFreightCapacity(state, qJin, content);
  town.stocks[itemId] = round2(town.stocks[itemId] - qJin);
  town.wheatStockJin = round2(town.wheatStockJin + valueJin);
  recordTradeStats(town, "buy", valueJin);
  // ④ 货入店（成本 = 付出的小麦折粮券）。
  const costUnits = voucherUnitsForWheatUnits(payUnits, content, "floor");
  putStock(shop, itemId, plan.units, costUnits);
  addBookValue(shop, "purchaseVoucherUnits", costUnits);
  addBookMap(shop, "purchasedUnits", itemId, plan.units);
  // ⑤ 卖给批发市场（镇库付粮券）。预检已过，这里应当成功。
  const sale = settleMonetaryPayment(state, "town", owner(shop), currentPaymentComposition(state, sellValue), content,
    "wholesale_trade_purchase", `批发市场收购${shop.name}进口的${label}`, { requireFull: true });
  if (!sale.ok) return { ok: false, qJin: 0, stuckUnits: plan.units };
  const taken = takeStock(shop, itemId, plan.units);
  depositWholesalePurchasedInventory(state, itemId, taken.units, sellValue, content);
  const paidFreight = freight.paidValueUnits || 0;
  addBookValue(shop, "revenueVoucherUnits", sellValue);
  addBookValue(shop, "cogsVoucherUnits", taken.costUnits);
  addBookValue(shop, "freightVoucherUnits", paidFreight);
  addBookMap(shop, "soldUnits", itemId, taken.units);
  applyProfit(shop, sellValue - taken.costUnits - paidFreight);
  recordLedger(state, {
    type: "trade_house_import", transactionId: makeTransactionId(state), source: "outside_town", destination: owner(shop),
    itemId, quantityUnits: plan.units, qeqUnits: 0,
    reason: `${shop.name}自${profile.name}进口${label}${round2(qJin)}斤，付小麦${valueJin}斤，按批发收购价卖给批发市场`
  }, content);
  return { ok: true, qJin, profitVoucherUnits: sellValue - taken.costUnits - paidFreight, revenue: sellValue, cogs: taken.costUnits, freight: paidFreight, direction: "import" };
}

function pushRow(row, cand, result) {
  const key = cand.itemId;
  const jin = round2(result.qJin);
  if (cand.direction === "export") row.exportJin[key] = round2((row.exportJin[key] || 0) + jin);
  else row.importJin[key] = round2((row.importJin[key] || 0) + jin);
  row.usedJin = round2(row.usedJin + jin);
  row.trades += 1;
  row.revenueVoucherUnits += result.revenue;
  row.cogsVoucherUnits += result.cogs;
  row.freightVoucherUnits += result.freight;
  row.profitVoucherUnits += result.profitVoucherUnits;
}

// 日结步骤 "tradeHouses"：每家营业中的贸易行做一天买卖。
export function settleTradingHouses(state, content) {
  const serial = serialOf(state, content);
  const houses = Object.values(ensureShops(state, content))
    .filter(shop => shop.status === "open" && isTradeHouse(shop, content))
    .sort((a, b) => a.id.localeCompare(b.id));
  const operational = buildingOperational(state, "foreign_trade_house");
  const dailyJin = dailyCapacityJin(state, content);
  const totalStaff = houses.reduce((sum, shop) => sum + tradeHouseStaff(state, shop), 0);
  const runs = houses.map(shop => {
    const staff = tradeHouseStaff(state, shop);
    const shareJin = totalStaff > 0 ? dailyJin * (content.rules.tradeHouseCapacityShare ?? 0.5) * staff / totalStaff : 0;
    const budgetJin = operational ? Math.min(staff * (content.rules.tradeHouseJinPerClerk ?? 100), shareJin) : 0;
    return { shop, remainingJin: budgetJin, row: blankTradeRow(serial, staff, shareJin, budgetJin) };
  });
  const margin = marginTarget(content);
  if (runs.some(run => run.remainingJin >= MIN_JIN) && freightPoolJin(state) >= MIN_JIN) {
    const ranked = candidatesFor(state, content)
      .map(cand => ({ cand, ratio: quickMarginRatio(state, content, cand) }))
      .filter(row => row.ratio !== null && row.ratio + 1 >= margin - 1e-9)
      .sort((a, b) => b.ratio - a.ratio);
    for (const { cand } of ranked) {
      for (const run of runs) {
        if (run.remainingJin < MIN_JIN || freightPoolJin(state) < MIN_JIN) continue;
        const plan = cand.direction === "export" ? planExport(state, content, run, cand) : planImport(state, content, run, cand);
        if (!plan) continue;
        const result = cand.direction === "export" ? executeExport(state, content, run, cand, plan) : executeImport(state, content, run, cand, plan);
        if (!result?.ok) continue;
        run.remainingJin = Math.max(0, run.remainingJin - result.qJin);
        pushRow(run.row, cand, result);
      }
    }
  }
  return runs.map(run => {
    run.shop.tradeLog = [...(Array.isArray(run.shop.tradeLog) ? run.shop.tradeLog : []), run.row].slice(-HISTORY_LIMIT);
    return { shopId: run.shop.id, budgetJin: run.row.budgetJin, usedJin: run.row.usedJin, trades: run.row.trades,
      profitVoucherUnits: run.row.profitVoucherUnits, freightVoucherUnits: run.row.freightVoucherUnits };
  });
}
