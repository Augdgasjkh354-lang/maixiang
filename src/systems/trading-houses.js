// 贸易行（docs/TRADE.md「贸易中心与贸易行」）：贸易中心里的店铺（kind "trade"），店主与店员每天自己做外镇买卖。
//
//   出口：从批发市场按售价进货 → 卖给外镇（外镇付小麦，小麦存进店里的支付小麦）。
//         批发市场存量不到保留量（tradeHouseExportMinStockDays 天销量与保本线取大，再加同品长协本月应交）时不出口；只出超出这部分的余量。
//   进口：向外镇买（付店里的小麦）→ 按批发收购价卖给批发市场（市场付粮券）。
//         进口量封顶：市场存量不超过 30 天销量（至少 20 斤）。
//   运费：每运一斤付 freightVoucherPerJin 给镇库（同一条运费规则）。
//   关税：出口按外镇付的货款收 policy.tradeTariff.exportPercent%，进口按付给外镇的货款收 importPercent%，交镇库。
//   利润率 = (卖价 − 买价 − 运费 − 关税) / (买价 + 运费 [+ 进口关税]) 须达到门槛才做：
//   出口利润门槛 policy.tradeMarginPercent（缺省 rules.tradeHouseTargetMarginPercent，20%），
//   进口 policy.tradeImportMarginPercent（缺省 rules.tradeHouseImportMarginPercent，25%，更高，偏向出口）。
//   排序时出口的利润率乘 tradeHouseExportPriority，同等条件先做出口。
//   成交量：min(店员 × tradeHouseJinPerClerk, 当日运力 × tradeHouseCapacityShare 按店员数分的份额)，实际运力从运力池扣。
//   只在外贸房在岗时做买卖（与镇长手动外贸同一条规则）。
//
// 全部按"对同一外镇同一商品的同一方向"逐笔算价：每笔用当时的价格（大单逐段计价，越做越薄），按利润率取能做的最大量。
// 每天的候选按入口利润率排序，贪心执行，直到运力、店员额度、资金、外镇库存或小麦用完。
// 复杂度：O(贸易行 × 外镇 × 商品)（一天一次，没有逐户循环）。
import { currencyScale } from "../economy/currency.js";
import { policyTradeMarginPercent } from "../economy/margin-policy.js";
import { currentPaymentComposition, maximumPayableValueUnits, quoteMonetaryPayment, settleMonetaryPayment } from "../economy/payment.js";
import { putStock, takeStock, valueOf } from "../economy/trade.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { townBuysOutsideWheat, townSellableWheatUnits, townSellsWheatToOutside } from "../economy/foreign-wheat.js";
import {
  addBookMap, addBookValue, applyProfit, ensureShops, releaseShopStaffing, reopenTradeHouse, shopClerkCount, shopDefinition,
  shopMerchantCount, shopMinimumCapitalUnits, topUpShopCapital
} from "./shops.js";
import { agreementMonthlyDueJin } from "./trade-agreements.js";
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
    serial, staff, shareJin: round2(shareJin), budgetJin: round2(budgetJin), usedJin: 0, capJin: 0, trades: 0,
    exportJin: {}, importJin: {}, revenueVoucherUnits: 0, cogsVoucherUnits: 0, freightVoucherUnits: 0, tariffVoucherUnits: 0, profitVoucherUnits: 0
  };
}

// 当日可做上限（斤，只读）：收市后仍能做的买卖，按"人手不限"计，只受货源、资金、运力池限制。
// 同一种货的出口不超过批发超保本线的余量，同一种货的进口不超过市场容量（多镇同货不重复计）。
// capJin = 成交量 + 这里的剩余可做量。人手是否卡住成交，用它与人手预算比较（见 tradeHouseTargetClerks）。
function tradeHouseOpportunityJin(state, content, shop, ranked) {
  if (freightPoolJin(state) < MIN_JIN) return 0;
  const run = { shop, remainingJin: dailyCapacityJin(state, content), row: null };
  const scale = content.precision.inventoryUnitsPerJin;
  const groups = {};
  for (const { cand } of ranked) {
    const plan = cand.direction === "export" ? planExport(state, content, run, cand) : planImport(state, content, run, cand);
    if (!plan) continue;
    const key = `${cand.direction}|${cand.itemId}`;
    groups[key] = (groups[key] || 0) + plan.qJin;
  }
  let total = 0;
  for (const [key, jin] of Object.entries(groups)) {
    const [direction, itemId] = key.split("|");
    const market = ensureWholesaleMarket(state, content);
    const stockJin = nonNegative(market.inventory?.[itemId]) / scale;
    const pool = direction === "export"
      ? exportSurplusJin(state, content, itemId)
      : Math.max(0, Math.max(IMPORT_STOCK_FLOOR_JIN, IMPORT_STOCK_CAP_DAYS * localAvgSoldJin(state, content, itemId)) - stockJin);
    total += Math.min(jin, pool);
  }
  return round2(total);
}

function serialOf(state, content) {
  return (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
}

function owner(shop) {
  return `shop:${shop.id}`;
}

// 关税交镇库；付不起的部分记为店铺欠税（与利润税同一笔欠款，之后照常追缴），钱不凭空消失。
function payTariff(state, shop, tariffUnits, label, content) {
  if (!(tariffUnits > 0)) return 0;
  const result = settleMonetaryPayment(state, owner(shop), "town", currentPaymentComposition(state, tariffUnits), content,
    "trade_tariff", `${shop.name}${label}关税`, { requireFull: false });
  const paid = result.ok ? result.paidValueUnits || 0 : 0;
  if (paid < tariffUnits) {
    shop.liabilities ||= {};
    shop.liabilities.taxVoucherUnits = (shop.liabilities.taxVoucherUnits || 0) + (tariffUnits - paid);
  }
  addBookValue(shop, "tariffVoucherUnits", tariffUnits);
  state.tradeTariffs ||= { cumulativeVoucherUnits: 0, byYear: {} };
  state.tradeTariffs.byYear ||= {};
  state.tradeTariffs.cumulativeVoucherUnits = (state.tradeTariffs.cumulativeVoucherUnits || 0) + tariffUnits;
  state.tradeTariffs.byYear[state.year] = (state.tradeTariffs.byYear[state.year] || 0) + tariffUnits;
  return tariffUnits;
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

// 利润门槛乘数：1 + 政策利润率（policy.tradeMarginPercent / tradeImportMarginPercent，缺省取 rules）。
export function tradeMarginTarget(state, content, direction = "export") {
  return 1 + policyTradeMarginPercent(state, content, direction) / 100;
}

// 关税税率（0—1）。只对贸易行生效；镇长手动外贸与长期协定是镇里自己的货，不对自己收税。
export function tradeTariffRate(state, direction) {
  const tariff = state.policy?.tradeTariff || {};
  const percent = Number(direction === "import" ? tariff.importPercent : tariff.exportPercent);
  return Number.isFinite(percent) && percent > 0 ? Math.min(100, percent) / 100 : 0;
}

// 关税（粮券单位）：按货款价值（斤小麦 = 券）向上取整。
function tariffUnitsOf(valueJin, rate, content) {
  return rate > 0 ? Math.ceil(valueJin * rate * currencyScale(content) - 1e-9) : 0;
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
    return unitPrice(cand.town, cand.good, "sell") * (1 - tradeTariffRate(state, "export")) / (price + freight) - 1;
  }
  const price = wholesalePurchasePrice(state, cand.itemId, content);
  if (!(price > 0)) return null;
  return price / (unitPrice(cand.town, cand.good, "buy") * (1 + tradeTariffRate(state, "import")) + freight) - 1;
}

// 批发市场某商品的出口保留量（斤）：本镇保本线（底线 200 斤与 10 天销量取大）+ 同品长协的本月应交（含顺延）。
// 长协每月 1 日从批发市场交货，贸易行不能先把这部分出口掉（否则长协每月违约）。只读。
export function exportReserveJin(state, content, itemId) {
  const baseJin = Math.max(content.rules.townOutputMinStockJin ?? 200, (content.rules.tradeHouseExportMinStockDays ?? 10) * localAvgSoldJin(state, content, itemId));
  return baseJin + agreementMonthlyDueJin(state, itemId);
}

// 批发市场某商品超出保留量（与 planExport 同一口径）的可出口余量（斤）。只读。
function exportSurplusJin(state, content, itemId) {
  const scale = content.precision.inventoryUnitsPerJin;
  const stockJin = nonNegative(state.wholesaleMarket?.inventory?.[itemId]) / scale;
  return Math.max(0, stockJin - exportReserveJin(state, content, itemId));
}

// 出口计划：返回 { units, qJin } 或 null。只读，不改 state。
function planExport(state, content, run, cand) {
  const { town, profile, itemId, good } = cand;
  const scale = content.precision.inventoryUnitsPerJin;
  const price = wholesaleUnitPrice(state, itemId, content);
  if (!(price > 0)) return null;
  const freight = freightVoucherPerJin(state, content);
  const cost = price + freight;
  const keep = 1 - tradeTariffRate(state, "export");
  const minSell = cost * tradeMarginTarget(state, content, "export");
  if (unitPrice(town, good, "sell") * keep < minSell) return null;
  const market = ensureWholesaleMarket(state, content);
  const stockJin = nonNegative(market.inventory?.[itemId]) / scale;
  // 保留量 = 保本线（至少 townOutputMinStockJin 斤）+ 同品长协本月应交；存量不够留就不出口，只出超出的余量。
  const reserveJin = exportReserveJin(state, content, itemId);
  if (stockJin - reserveJin < MIN_JIN) return null;
  // 恢复检查时按补资后的营运资金（run.assumeCashUnits）规划，真正成交时用店里的实际资金。
  const cashUnits = run.assumeCashUnits ?? maximumPayableValueUnits(state, owner(run.shop), content);
  const cashJin = cashUnits / (currencyScale(content) * cost);
  const avgSell = x => quoteValue(town, good, "sell", x) * keep / x;
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
  const maxCost = price / tradeMarginTarget(state, content, "import");
  const duty = 1 + tradeTariffRate(state, "import");
  if (unitPrice(town, good, "buy") * duty + freight > maxCost) return null;
  const market = ensureWholesaleMarket(state, content);
  const stockJin = nonNegative(market.inventory?.[itemId]) / scale;
  const avgSoldJin = localAvgSoldJin(state, content, itemId);
  const roomJin = Math.max(IMPORT_STOCK_FLOOR_JIN, IMPORT_STOCK_CAP_DAYS * avgSoldJin) - stockJin;
  if (roomJin < MIN_JIN) return null;
  // 镇库要付得起货款（粮券）。
  const townCashJin = maximumPayableValueUnits(state, "town", content) / (currency * price);
  const buyAvg = x => quoteValue(town, good, "buy", x) / x;
  const payUnitsOf = x => Math.round(quoteValue(town, good, "buy", x) * scale);
  // 付给外镇的小麦由贸易行用粮券向镇库买（1 斤 = 1 券，镇库小麦要留够口粮储备线）；运费、关税也是粮券。
  // 所以粮券要够付：买小麦的钱 + 运费 + 关税；小麦要在镇库可卖额度内。
  const tariffRate = tradeTariffRate(state, "import");
  const townWheatRoom = townSellableWheatUnits(state, content);
  const shopCashUnits = maximumPayableValueUnits(state, owner(run.shop), content);
  const wheatOk = x => payUnitsOf(x) <= townWheatRoom
    && voucherUnitsForWheatUnits(payUnitsOf(x), content, "floor") + freightUnitsOf(x, freight, content)
      + tariffUnitsOf(quoteValue(town, good, "buy", x), tariffRate, content) <= shopCashUnits;
  let q = Math.min(roomJin, sellableStock(town, good), run.remainingJin, freightPoolJin(state), townCashJin);
  q = largestWhere(q, x => buyAvg(x) * duty + freight <= maxCost);
  q = largestWhere(q, wheatOk);
  const units = Math.floor(q * scale + 1e-6);
  if (units < 1) return null;
  const qJin = units / scale;
  return { units, qJin, wheatPayUnits: payUnitsOf(qJin), freightUnits: freightUnitsOf(qJin, freight, content),
    tariffUnits: tariffUnitsOf(quoteValue(town, good, "buy", qJin), tariffRate, content), sellValueUnits: valueOf(units, price, content) };
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
  // 外镇付的小麦进镇库，镇库按 1 斤 = 1 券付粮券给贸易行（economy/foreign-wheat.js）。
  const sold = townBuysOutsideWheat(state, content, owner(shop), valueWheatUnits, `${shop.name}向${profile.name}出口${label}`);
  if (!sold.ok) throw new Error("出口收款失败：" + (sold.reason || "未知原因"));
  const revenue = sold.voucherUnits;
  const paidFreight = freight.paidValueUnits || 0;
  const tariff = payTariff(state, shop, tariffUnitsOf(valueJin, tradeTariffRate(state, "export"), content), `向${profile.name}出口${label}`, content);
  addBookValue(shop, "revenueVoucherUnits", revenue);
  addBookValue(shop, "cogsVoucherUnits", taken.costUnits);
  addBookValue(shop, "freightVoucherUnits", paidFreight);
  addBookMap(shop, "soldUnits", itemId, taken.units);
  applyProfit(shop, revenue - taken.costUnits - paidFreight - tariff);
  recordTradeStats(town, "sell", valueJin, itemId, taken.units / scale);
  recordLedger(state, {
    type: "trade_house_export", transactionId: makeTransactionId(state), source: owner(shop), destination: "outside_town",
    itemId, quantityUnits: taken.units, qeqUnits: 0,
    reason: `${shop.name}向${profile.name}出口${label}${round2(qJin)}斤，收小麦${valueJin}斤`
  }, content);
  return { ok: true, qJin: taken.units / scale, profitVoucherUnits: revenue - taken.costUnits - paidFreight - tariff, revenue, cogs: taken.costUnits, freight: paidFreight, tariff, direction: "export" };
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
  // 预检（不动钱）：镇库付得起收购款；贸易行的粮券付得起买小麦的钱 + 运费 + 关税，镇库有可卖的小麦。
  if (!quoteMonetaryPayment(state, "town", currentPaymentComposition(state, sellValue), content).full) return null;
  const tariffUnits = tariffUnitsOf(valueJin, tradeTariffRate(state, "import"), content);
  const wheatCostUnits = voucherUnitsForWheatUnits(payUnits, content, "floor");
  if (payUnits > townSellableWheatUnits(state, content)) return null;
  if (!quoteMonetaryPayment(state, owner(shop), currentPaymentComposition(state, wheatCostUnits + freightUnits + tariffUnits), content).full) return null;
  // ① 贸易行用粮券向镇库买小麦，小麦付给外镇（实物，外镇没有账户）。
  const bought = townSellsWheatToOutside(state, content, owner(shop), payUnits, `${shop.name}自${profile.name}进口${label}`);
  if (!bought.ok) return null;
  // ② 运费付镇库；失败则整笔作废（小麦已出镇库，原样买回，没有任何东西丢失）。
  const freight = settleMonetaryPayment(state, owner(shop), "town", currentPaymentComposition(state, freightUnits), content,
    "freight", `${shop.name}运${label}自${profile.name}的运费`, { requireFull: true });
  if (!freight.ok) {
    townBuysOutsideWheat(state, content, owner(shop), payUnits, `${shop.name}进口${label}的运费付不起，退回已买的小麦`);
    return null;
  }
  // ②' 进口关税交镇库（付不起的记欠税）。
  const tariff = payTariff(state, shop, tariffUnits, `自${profile.name}进口${label}`, content);
  // ③ 外镇发货：库存减少、小麦增加；运力从池子扣。
  takeFreightCapacity(state, qJin, content);
  town.stocks[itemId] = round2(town.stocks[itemId] - qJin);
  town.wheatStockJin = round2(town.wheatStockJin + valueJin);
  recordTradeStats(town, "buy", valueJin, itemId, qJin);
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
  applyProfit(shop, sellValue - taken.costUnits - paidFreight - tariff);
  recordLedger(state, {
    type: "trade_house_import", transactionId: makeTransactionId(state), source: "outside_town", destination: owner(shop),
    itemId, quantityUnits: plan.units, qeqUnits: 0,
    reason: `${shop.name}自${profile.name}进口${label}${round2(qJin)}斤，付小麦${valueJin}斤，按批发收购价卖给批发市场`
  }, content);
  return { ok: true, qJin, profitVoucherUnits: sellValue - taken.costUnits - paidFreight - tariff, revenue: sellValue, cogs: taken.costUnits, freight: paidFreight, tariff, direction: "import" };
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
  row.tariffVoucherUnits = (row.tariffVoucherUnits || 0) + (result.tariff || 0);
  row.profitVoucherUnits += result.profitVoucherUnits;
}

// 排好序的候选：只留当下走得通、利润率够门槛的路（出口的利润率乘 tradeHouseExportPriority）。
function rankCandidates(state, content) {
  const exportPriority = content.rules.tradeHouseExportPriority ?? 1;
  return candidatesFor(state, content)
    .map(cand => ({ cand, ratio: quickMarginRatio(state, content, cand) }))
    .filter(row => row.ratio !== null && row.ratio + 1 >= tradeMarginTarget(state, content, row.cand.direction) - 1e-9)
    .map(row => ({ ...row, rank: row.cand.direction === "export" ? row.ratio * exportPriority : row.ratio }))
    .sort((a, b) => b.rank - a.rank);
}

// ---------------------------------------------------------------- 无生意时暂停（外贸稳定性）
// 连续 outsideTrade.tradeHousePauseDays 天没有成交、且这段时间经营亏损（工资与店租都计入）→ 暂停营业：
//   店员遣散（不再发工资、不计店租），业主权益保留，不进入清算；暂停由 shop.tradePause 标记，店铺状态为 paused。
// 每 outsideTrade.tradeHouseResumeCheckDays 天检查一次：店主在岗、外贸房在岗，且有任一可做的买卖（利润门槛、货源、运力、外镇可付小麦、本店资金都满足）→ 恢复营业并补足店员。

function outsideTradeDays(content, key, fallback) {
  return Math.max(1, Math.floor(Number(content.rules.outsideTrade?.[key] ?? fallback) || fallback));
}

// 今天的账已含当日工资与租金（日结准备步骤里计提），历史行是已归档的前几天。
export function tradeHousePauseDue(shop, content) {
  const days = outsideTradeDays(content, "tradeHousePauseDays", 30);
  const history = days > 1 ? (shop.history || []).slice(-(days - 1)) : [];
  if (history.length + 1 < days) return false;
  const today = shop.accounts?.day || {};
  const soldJin = history.reduce((sum, row) => sum + Math.max(0, Number(row.soldUnits) || 0), 0)
    + Object.values(today.soldUnits || {}).reduce((sum, units) => sum + Math.max(0, Number(units) || 0), 0);
  if (soldJin > 0) return false;
  const profit = history.reduce((sum, row) => sum + (Number(row.profitVoucherUnits) || 0), 0) + (Number(today.profitVoucherUnits) || 0);
  return profit < 0;
}

function enterTradePause(state, shop, content) {
  const days = outsideTradeDays(content, "tradeHousePauseDays", 30);
  shop.tradePause = { sinceSerial: serialOf(state, content), clerksBefore: shopClerkCount(state, shop), merchantsBefore: shopMerchantCount(state, shop) };
  releaseShopStaffing(state, shop);
  shop.status = "paused";
  shop.statusReason = "暂无可做的买卖，暂停营业";
  recordEvent(state, `${shop.name}连续${days}天无买卖且亏损，暂停营业（店员遣散，业主保留）。`, content, { day: state.day + 1 });
}

// 有没有任一可做的买卖：只读。budgetJin 用暂停前的人手估算；assumeCashUnits 为补资后的营运资金（不要求店里现在有钱）。
function tradeHouseCanTrade(state, content, shop, budgetJin, assumeCashUnits = null) {
  if (!(budgetJin >= MIN_JIN) || freightPoolJin(state) < MIN_JIN) return false;
  const run = { shop, remainingJin: budgetJin, row: null, assumeCashUnits };
  return rankCandidates(state, content).some(({ cand }) => {
    const plan = cand.direction === "export" ? planExport(state, content, run, cand) : planImport(state, content, run, cand);
    return Boolean(plan);
  });
}

function resumeTradeHouses(state, content) {
  if (!buildingOperational(state, "foreign_trade_house")) return;
  const serial = serialOf(state, content);
  const every = outsideTradeDays(content, "tradeHouseResumeCheckDays", 10);
  const dailyJin = dailyCapacityJin(state, content);
  const share = content.rules.tradeHouseCapacityShare ?? 0.5;
  const perClerk = content.rules.tradeHouseJinPerClerk ?? 300;
  for (const shop of Object.values(ensureShops(state, content))) {
    if (shop.status !== "paused" || !shop.tradePause || !isTradeHouse(shop, content)) continue;
    const elapsed = serial - (shop.tradePause.sinceSerial || 0);
    if (elapsed <= 0 || elapsed % every !== 0) continue;
    const clerksBefore = shop.tradePause.clerksBefore || 0;
    const merchantsBefore = Math.max(1, shop.tradePause.merchantsBefore || 1);
    const staff = clerksBefore + merchantsBefore;
    const budgetJin = Math.min(staff * perClerk, dailyJin * share);
    // 不要求店里现在有钱：按最低营运资金规划；有可做的买卖才由业主补足营运资金（付不起则继续暂停）。
    const minUnits = shopMinimumCapitalUnits(state, shop, content);
    if (!tradeHouseCanTrade(state, content, shop, budgetJin, minUnits)) continue;
    const topped = topUpShopCapital(state, shop, minUnits, content);
    if (!topped.ok) continue;
    const reopened = reopenTradeHouse(state, shop, { merchants: merchantsBefore, clerks: clerksBefore }, content);
    if (!reopened.ok) continue;
    recordEvent(state, `${shop.name}恢复营业，业主补资${Math.round(topped.toppedUnits / currencyScale(content))}券，补足店员${reopened.clerks}人。`, content, { day: state.day + 1 });
  }
}

// 日结步骤 "tradeHouses"：每家营业中的贸易行做一天买卖。
export function settleTradingHouses(state, content) {
  resumeTradeHouses(state, content);
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
  let ranked = [];
  if (runs.some(run => run.remainingJin >= MIN_JIN) && freightPoolJin(state) >= MIN_JIN) {
    ranked = rankCandidates(state, content);
    // 两遍分配（防止利润率最高的镇独占预算与批发存货，另一镇整月为 0）：
    // 第一遍：每家贸易行把当日预算平分给当日有可做买卖的各镇，各镇只在自己的配额内成交；
    // 第二遍：配额没用完的预算再按利润排序分给所有能做的买卖。单笔的利润门槛、定价与逐段计价不变。
    const townIds = [...new Set(ranked.map(({ cand }) => cand.town.id))];
    for (const run of runs) run.townQuotaJin = Object.fromEntries(townIds.map(id => [id, run.remainingJin / Math.max(1, townIds.length)]));
    // 同一种货的超保本线余量（批发市场）也按镇平分：各镇在第一遍只能取自己那一份。
    const exportTownsByItem = {};
    for (const { cand } of ranked) {
      if (cand.direction === "export") (exportTownsByItem[cand.itemId] ||= new Set()).add(cand.town.id);
    }
    const itemTownQuotaJin = {};
    for (const [itemId, towns] of Object.entries(exportTownsByItem)) {
      const surplusJin = exportSurplusJin(state, content, itemId);
      for (const id of towns) itemTownQuotaJin[`${itemId}|${id}`] = surplusJin / towns.size;
    }
    for (const pass of [1, 2]) {
      for (const { cand } of ranked) {
        const itemKey = `${cand.itemId}|${cand.town.id}`;
        for (const run of runs) {
          if (run.remainingJin < MIN_JIN || freightPoolJin(state) < MIN_JIN) continue;
          let capJin = run.remainingJin;
          if (pass === 1) {
            const quota = run.townQuotaJin[cand.town.id] || 0;
            if (quota < MIN_JIN) continue;
            capJin = Math.min(capJin, quota);
            if (cand.direction === "export") {
              const itemQuota = itemTownQuotaJin[itemKey] || 0;
              if (itemQuota < MIN_JIN) continue;
              capJin = Math.min(capJin, itemQuota);
            }
          }
          const planRun = { ...run, remainingJin: capJin };
          const plan = cand.direction === "export" ? planExport(state, content, planRun, cand) : planImport(state, content, planRun, cand);
          if (!plan) continue;
          const result = cand.direction === "export" ? executeExport(state, content, run, cand, plan) : executeImport(state, content, run, cand, plan);
          if (!result?.ok) continue;
          run.remainingJin = Math.max(0, run.remainingJin - result.qJin);
          if (pass === 1) {
            run.townQuotaJin[cand.town.id] = Math.max(0, (run.townQuotaJin[cand.town.id] || 0) - result.qJin);
            if (cand.direction === "export") itemTownQuotaJin[itemKey] = Math.max(0, (itemTownQuotaJin[itemKey] || 0) - result.qJin);
          }
          pushRow(run.row, cand, result);
        }
      }
    }
  }
  // 收市后算当日可做上限（人手不限）：没有候选买卖时上限就是成交量。
  for (const run of runs) {
    run.row.capJin = round2(run.row.usedJin + (ranked.length ? tradeHouseOpportunityJin(state, content, run.shop, ranked) : 0));
  }
  return runs.map(run => {
    run.shop.tradeLog = [...(Array.isArray(run.shop.tradeLog) ? run.shop.tradeLog : []), run.row].slice(-HISTORY_LIMIT);
    if (tradeHousePauseDue(run.shop, content)) enterTradePause(state, run.shop, content);
    return { shopId: run.shop.id, budgetJin: run.row.budgetJin, usedJin: run.row.usedJin, trades: run.row.trades,
      profitVoucherUnits: run.row.profitVoucherUnits, freightVoucherUnits: run.row.freightVoucherUnits, tariffVoucherUnits: run.row.tariffVoucherUnits };
  });
}
