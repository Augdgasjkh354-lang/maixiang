// 批发市场（0.2.3 流通改革）：从"镇库的转运站"升级为独立的做市商。
import { CONTENT } from "../content/index.js";
import { wholesaleItemIds } from "../content/assemble.js";
import { householdIdOf } from "../economy/accounts.js";
//
// 三条主线：
// 1. 做市商双价：对每个商品设「收购价」（向公司/民营收购）与「售价」（卖给综合商店/生产者）。
//    收购价随库存自动反馈——库存越多收购价越低（参考外镇贸易的 1/(1+e·memory/10000)），
//    防止大公司把批发市场粮券一次性抽干。库存低时收购价回升，鼓励生产者供货。
// 2. 镇营统购统销：镇营建筑产品「无偿调拨」入市（内部价 0，成本基础随货转移），
//    销售利润留在批发市场；批发市场统一发放镇营建筑工资（双系数照乘，只是发放主体变化）；
//    磨坊小麦、面包店面fen等原料由批发市场内部无偿调拨保障。小麦仍归镇库直管。
// 3. 钱归镇库：批发市场是镇营机构，没有独立现金账户。收购付款、销售回款都直接走镇库
//    （支付账户 "town"）；小麦一直在镇库，市场只管面粉/面包/木材/盐的库存与挂价。
//
// 兼容性：`pricesVoucherPerUnit` 继续表示「售价」，沿用 0.1.x 的字段名与语义，
// 旧档与旧测试不受影响；收购价放在新字段 `purchasePricesVoucherPerUnit`（||= 初始化）。

import { currencyScale, ensureCurrencyState } from "../economy/currency.js";
import { bookAdd, bookAddMap } from "../economy/books.js";
import { buyDirect, directSellers, putStock, takeStock } from "../economy/trade.js";
import { currentPaymentComposition, maximumPayableValueUnits, settleMonetaryPayment } from "../economy/payment.js";
import { addTownCostBasis, removeTownInventoryWithCost } from "../economy/business.js";
import { makeTransactionId, recordLedger } from "../economy/ledger.js";
import { setCurrentUnitPrice, currentUnitPrice } from "../economy/prices.js";
import { householdConvertibleWheatUnits, syncResidentAggregates } from "./households.js";


// 镇营统购统销的商品（不含小麦——小麦继续归镇库直管）。
// 同时也是做市商可挂牌买卖的商品清单：小麦不在批发市场买卖，
// 只走镇库调拨（磨坊免费领用）与单次调运。
export const WHOLESALE_MONOPOLY_ITEM_IDS = Object.freeze(wholesaleItemIds(CONTENT));
// 批发市场账上出现的全部商品：做市品 + 小麦（小麦只走镇库调拨，不挂牌）。
export const WHOLESALE_ITEM_IDS = Object.freeze(["wheat", ...WHOLESALE_MONOPOLY_ITEM_IDS]);

// 默认做市价（小麦斤等价/单位）：收购 1.4 / 售出 1.8 等，用户拍板。
export const DEFAULT_PURCHASE_PRICES = CONTENT.rules.wholesaleDefaultPurchasePrices;
export const DEFAULT_SALE_PRICES = CONTENT.rules.wholesaleDefaultSalePrices;

// 库存价格反馈：以「参考库存（斤）」为基准，库存达到参考库存的 feedbackScale 倍时
// 收购价按 1/(1+elasticity*ratio) 衰减，ratio = max(0, 库存/参考库存 − 1)。
export const INVENTORY_PRICE_FEEDBACK_ELASTICITY = 1.0;
export const INVENTORY_PRICE_FEEDBACK_SCALE = 1.0;
export const PURCHASE_PRICE_FLOOR_RATIO = 0.25; // 收购价最多跌到基准价的 25%，避免 0 价

export function ensureWholesaleMarket(state, content) {
  state.wholesaleMarket ||= {};
  const market = state.wholesaleMarket;
  market.inventory ||= emptyItemMap(0);
  market.inventoryCostVoucherUnits ||= emptyItemMap(0);
  market.pricesVoucherPerUnit ||= {};
  market.purchasePricesVoucherPerUnit ||= {};
  market.purchasePriceReferenceVoucherPerUnit ||= {};
  market.dailyTownAllocationUnits ||= emptyItemMap(0);
  market.day ||= { intakeUnits: emptyItemMap(0), soldUnits: emptyItemMap(0), townAllocatedUnits: emptyItemMap(0), purchaseVoucherUnits: 0, salesVoucherUnits: 0 };
  market.year ||= { intakeUnits: emptyItemMap(0), soldUnits: emptyItemMap(0), townAllocatedUnits: emptyItemMap(0), purchaseVoucherUnits: 0, salesVoucherUnits: 0 };
  market.cumulative ||= { intakeUnits: emptyItemMap(0), soldUnits: emptyItemMap(0), townAllocatedUnits: emptyItemMap(0), purchaseVoucherUnits: 0, salesVoucherUnits: 0 };
  // 统购统销累计账：无偿调拨入库与领用的成本价值。
  market.monopoly ||= { allocatedInValueUnits: 0, allocatedInputValueUnits: 0 };
  market.purchaseSpend ||= { day: 0, year: 0, cumulative: 0 };
  market.purchasePriceIndex ||= emptyItemMap(1);
  // 价值口径流水（小麦斤等价）：无论以粮券还是实物小麦结算，都折算成小麦等值记录。
  market.valueFlow ||= { day: { sales: 0, purchases: 0 }, year: { sales: 0, purchases: 0 }, cumulative: { sales: 0, purchases: 0 } };
  for (const itemId of WHOLESALE_ITEM_IDS) {
    market.inventory[itemId] = Math.max(0, Math.floor(market.inventory[itemId] || 0));
    market.inventoryCostVoucherUnits[itemId] = Math.max(0, Math.floor(market.inventoryCostVoucherUnits[itemId] || 0));
    market.dailyTownAllocationUnits[itemId] = Math.max(0, Math.floor(market.dailyTownAllocationUnits[itemId] || 0));
    // 做市挂价只针对可买卖的 4 种商品；小麦归镇库直管：只保留镇库价出售（公司/民营买原料），
    // 不设做市收购价（市场不向任何人收购小麦，小麦只走镇库调拨入市）。
    if (!(Number.isFinite(market.pricesVoucherPerUnit[itemId]) && market.pricesVoucherPerUnit[itemId] > 0)) {
      // 0.2.3：批发市场做成市商后有自己的挂价，取做市商默认售价而非全局官价。
      const fallback = itemId === "wheat"
        ? (content.rules.marketPricesVoucherPerUnit?.[itemId] ?? DEFAULT_SALE_PRICES[itemId] ?? 1)
        : (content.rules.wholesaleDefaultSalePrices?.[itemId]
          ?? content.rules.marketPricesVoucherPerUnit?.[itemId] ?? DEFAULT_SALE_PRICES[itemId] ?? 1);
      market.pricesVoucherPerUnit[itemId] = fallback;
    }
    if (itemId === "wheat") continue;
    if (!(Number.isFinite(market.purchasePricesVoucherPerUnit[itemId]) && market.purchasePricesVoucherPerUnit[itemId] > 0)) {
      market.purchasePricesVoucherPerUnit[itemId] = content.rules.wholesaleDefaultPurchasePrices?.[itemId]
        ?? DEFAULT_PURCHASE_PRICES[itemId] ?? market.pricesVoucherPerUnit[itemId];
    }
    // 收购价基准 = 玩家设定的收购价（价格反馈围绕它波动），旧档补当前值。
    if (!(Number.isFinite(market.purchasePriceReferenceVoucherPerUnit[itemId]) && market.purchasePriceReferenceVoucherPerUnit[itemId] > 0)) {
      market.purchasePriceReferenceVoucherPerUnit[itemId] = market.purchasePricesVoucherPerUnit[itemId];
    }
    if (!Number.isFinite(market.purchasePriceIndex[itemId]) || market.purchasePriceIndex[itemId] <= 0) {
      market.purchasePriceIndex[itemId] = 1;
    }
  }
  return market;
}


function emptyItemMap(value = 0) {
  return Object.fromEntries(WHOLESALE_ITEM_IDS.map(itemId => [itemId, value]));
}

export function hasWholesaleMarket(state) {
  return (state.buildings || []).some(building => building.typeId === "wholesale_market" && (building.level || 1) > 0);
}

const addPeriodMap = bookAddMap;
const addPeriodValue = bookAdd;

export function resetWholesaleDay(state, content) {
  const market = ensureWholesaleMarket(state, content);
  market.day = { intakeUnits: emptyItemMap(0), soldUnits: emptyItemMap(0), townAllocatedUnits: emptyItemMap(0), purchaseVoucherUnits: 0, salesVoucherUnits: 0 };
  market.purchaseSpend.day = 0;
  market.valueFlow.day = { sales: 0, purchases: 0 };
}

export function resetWholesaleYear(state, content) {
  const market = ensureWholesaleMarket(state, content);
  market.year = { intakeUnits: emptyItemMap(0), soldUnits: emptyItemMap(0), townAllocatedUnits: emptyItemMap(0), purchaseVoucherUnits: 0, salesVoucherUnits: 0 };
  market.purchaseSpend.year = 0;
  market.valueFlow.year = { sales: 0, purchases: 0 };
}

// 把一次发生额（粮券单位或小麦单位，二者同为"小麦等值单位"尺度）记入价值流水。
function addValueFlow(market, key, amountUnits) {
  const amount = Math.max(0, Math.round(Number(amountUnits) || 0));
  if (!amount) return;
  bookAdd(market.valueFlow, key, amount);
}

// ---------------------------------------------------------------- 做市商定价

export function wholesaleUnitPrice(state, itemId, content) {
  const market = ensureWholesaleMarket(state, content);
  return Number(market.pricesVoucherPerUnit[itemId] || 0);
}

// 收购价：基准价 × 库存反馈系数。库存为空时最高（=基准价），库存越多越低。
export function wholesalePurchasePrice(state, itemId, content) {
  const market = ensureWholesaleMarket(state, content);
  const reference = Number(market.purchasePriceReferenceVoucherPerUnit?.[itemId]
    || market.purchasePricesVoucherPerUnit?.[itemId] || 0);
  if (!(reference > 0)) return 0;
  const feedback = purchasePriceFeedback(market, itemId, content);
  const floor = reference * PURCHASE_PRICE_FLOOR_RATIO;
  return Math.max(floor, reference * feedback);
}

// 反馈系数 ∈ [PURCHASE_PRICE_FLOOR_RATIO..1]：库存 ≤ 参考库存时不打折；超出后按
// 1/(1+e·ratio) 递减，ratio = 库存/参考库存 − 1。
export function purchasePriceFeedback(market, itemId, content) {
  const target = Math.max(1, Number(content.rules.wholesalePurchasePriceReferenceUnits?.[itemId]
    ?? (content.rules.wholesalePurchasePriceReferenceJin ?? 2000) * content.precision.inventoryUnitsPerJin));
  const stock = Math.max(0, market.inventory?.[itemId] || 0);
  const elasticity = Math.max(0, Number(content.rules.wholesalePurchasePriceElasticity ?? INVENTORY_PRICE_FEEDBACK_ELASTICITY));
  const scale = Math.max(0.01, Number(content.rules.wholesalePurchasePriceScale ?? INVENTORY_PRICE_FEEDBACK_SCALE));
  const ratio = Math.max(0, stock / (target * scale) - 1);
  return 1 / (1 + elasticity * ratio);
}

// 刷新所有商品的「当前收购价」，并把反馈系数记录到 purchasePriceIndex 供面板展示。
export function refreshWholesalePurchasePrices(state, content) {
  const market = ensureWholesaleMarket(state, content);
  // 只刷新可买卖商品的收购价：小麦不挂牌，不参与价格反馈。
  for (const itemId of WHOLESALE_MONOPOLY_ITEM_IDS) {
    market.purchasePriceIndex[itemId] = purchasePriceFeedback(market, itemId, content);
    market.purchasePricesVoucherPerUnit[itemId] = wholesalePurchasePrice(state, itemId, content);
  }
  return { ...market.purchasePricesVoucherPerUnit };
}

// 玩家命令：设做市售价（沿用旧字段/旧命令语义）。小麦归镇库直管，不在批发市场挂价。
export function setWholesalePrice(state, itemId, value, content) {
  if (itemId === "wheat") return { ok: false, reason: "小麦归镇库直管，不在批发市场挂价买卖" };
  if (!WHOLESALE_MONOPOLY_ITEM_IDS.includes(itemId)) return { ok: false, reason: "批发市场不经营这种商品" };
  const price = Math.round(Number(value) * 1000) / 1000;
  if (!Number.isFinite(price) || price <= 0 || price > 1e6) return { ok: false, reason: "批发价须为正的有限数值" };
  const result = setCurrentUnitPrice(state, itemId, price, content);
  if (!result.ok) return result;
  const market = ensureWholesaleMarket(state, content);
  market.pricesVoucherPerUnit[itemId] = result.value;
  return { ok: true, itemId, value: result.value, clamped: result.clamped };
}

// 玩家命令：设做市收购价（0.2.3 新增）。收购价同时成为价格反馈的基准。小麦归镇库直管，不挂收购价。
export function setWholesalePurchasePrice(state, itemId, value, content) {
  if (itemId === "wheat") return { ok: false, reason: "小麦归镇库直管，不在批发市场挂价买卖" };
  if (!WHOLESALE_MONOPOLY_ITEM_IDS.includes(itemId)) return { ok: false, reason: "批发市场不经营这种商品" };
  const price = Math.round(Number(value) * 1000) / 1000;
  if (!Number.isFinite(price) || price <= 0 || price > 1e6) return { ok: false, reason: "收购价须为正的有限数值" };
  const market = ensureWholesaleMarket(state, content);
  market.purchasePriceReferenceVoucherPerUnit[itemId] = price;
  // 立即按当前库存刷新实际收购价，玩家在面板上马上能看到反馈结果。
  market.purchasePriceIndex[itemId] = purchasePriceFeedback(market, itemId, content);
  market.purchasePricesVoucherPerUnit[itemId] = wholesalePurchasePrice(state, itemId, content);
  return { ok: true, itemId, value: market.purchasePricesVoucherPerUnit[itemId], reference: price, index: market.purchasePriceIndex[itemId] };
}

// 供 UI 读取：某商品当前收购价与反馈系数。
export function wholesalePurchaseQuote(state, itemId, content) {
  const market = ensureWholesaleMarket(state, content);
  return {
    itemId,
    reference: Number(market.purchasePriceReferenceVoucherPerUnit?.[itemId] || 0),
    price: wholesalePurchasePrice(state, itemId, content),
    index: Number(market.purchasePriceIndex?.[itemId] ?? 1)
  };
}

export function setWholesaleTownAllocation(state, itemId, quantity, content) {
  if (!WHOLESALE_ITEM_IDS.includes(itemId)) return { ok: false, reason: "批发市场不经营这种商品" };
  const physical = Number(quantity);
  if (!Number.isFinite(physical) || physical < 0 || physical > 1e9) return { ok: false, reason: "每日调拨量须为非负有限数值" };
  const market = ensureWholesaleMarket(state, content);
  market.dailyTownAllocationUnits[itemId] = Math.round(physical * content.precision.inventoryUnitsPerJin);
  return { ok: true, itemId, quantity: market.dailyTownAllocationUnits[itemId] / content.precision.inventoryUnitsPerJin };
}

// ---------------------------------------------------------------- 库存与资金

const addInventory = putStock;

function removeInventory(market, itemId, units) {
  const taken = takeStock(market, itemId, units);
  return { units: taken.units, costVoucherUnits: taken.costUnits };
}

// 对外出口从批发市场取货（外镇贸易用）：返回实际取出单位数
export function takeWholesaleInventoryForExport(state, itemId, units, content) {
  if (!hasWholesaleMarket(state)) return { units: 0 };
  const market = ensureWholesaleMarket(state, content);
  return removeInventory(market, itemId, units);
}

function priceValueUnits(itemId, units, state, content) {
  return Math.round(units / content.precision.inventoryUnitsPerJin * wholesaleUnitPrice(state, itemId, content) * currencyScale(content));
}

function purchaseValueUnits(itemId, units, state, content) {
  return Math.round(units / content.precision.inventoryUnitsPerJin * wholesalePurchasePrice(state, itemId, content) * currencyScale(content));
}

// ---------------------------------------------------------------- 镇库 <-> 市场

export function transferTownToWholesale(state, itemId, requestedUnits, content, reason = "镇库调拨至批发市场") {  const market = ensureWholesaleMarket(state, content);
  if (!hasWholesaleMarket(state)) return { ok: false, movedUnits: 0, reason: "尚未建成批发市场" };
  // 小麦一直留在镇库，市场直接按镇库存量对外出售，无需搬运。
  if (itemId === "wheat") return { ok: false, movedUnits: 0, reason: "小麦由镇库直管，无需投放" };
  const available = Math.max(0, state.accounts?.town?.[itemId] || 0);
  const units = Math.min(Math.max(0, Math.floor(requestedUnits)), available);
  if (units <= 0) return { ok: false, movedUnits: 0, reason: "镇库无可调拨库存" };
  const removed = removeTownInventoryWithCost(state, itemId, units, content);
  addInventory(market, itemId, units, removed.costWheatUnits);
  addPeriodMap(market, "intakeUnits", itemId, units);
  recordLedger(state, { type: "wholesale_town_transfer", transactionId: makeTransactionId(state), source: "town", destination: "wholesale_market", itemId, quantityUnits: units, qeqUnits: 0, reason }, content);
  return { ok: true, movedUnits: units };
}

// 用户 0.1.11：单次调运之收储——把批发市场库存一次性收回调入镇库（部分可收，按实际有的收），用来平抑库存。
export function stockpileWholesale(state, itemId, quantityJin, content) {
  if (!WHOLESALE_ITEM_IDS.includes(itemId)) return { ok: false, reason: "批发市场不经营这种商品" };
  if (!hasWholesaleMarket(state)) return { ok: false, reason: "尚未建成批发市场" };
  const requestedUnits = Math.round(Number(quantityJin) * content.precision.inventoryUnitsPerJin);
  if (!Number.isFinite(requestedUnits) || requestedUnits <= 0) return { ok: false, reason: "收储数量须大于0" };
  const market = ensureWholesaleMarket(state, content);
  const taken = removeInventory(market, itemId, requestedUnits);
  if (taken.units <= 0) return { ok: false, reason: "批发市场没有这种库存" };
  state.accounts ||= {};
  state.accounts.town ||= {};
  state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + taken.units;
  addTownCostBasis(state, itemId, taken.costVoucherUnits);
  recordLedger(state, { type: "wholesale_stockpile", transactionId: makeTransactionId(state), source: "wholesale_market", destination: "town", itemId, quantityUnits: taken.units, qeqUnits: 0, reason: "镇库收储批发市场库存" }, content);
  return { ok: true, itemId, movedJin: taken.units / content.precision.inventoryUnitsPerJin };
}

// 用户 0.1.11：单次调运之投放——把镇库库存一次性投放至批发市场，用来平抑库存。
export function releaseWholesale(state, itemId, quantityJin, content) {
  if (!WHOLESALE_ITEM_IDS.includes(itemId)) return { ok: false, reason: "批发市场不经营这种商品" };
  const requestedUnits = Math.round(Number(quantityJin) * content.precision.inventoryUnitsPerJin);
  if (!Number.isFinite(requestedUnits) || requestedUnits <= 0) return { ok: false, reason: "投放数量须大于0" };
  const moved = transferTownToWholesale(state, itemId, requestedUnits, content, "镇库一次性投放至批发市场");
  if (!moved.ok) return moved;
  return { ok: true, itemId, movedJin: moved.movedUnits / content.precision.inventoryUnitsPerJin };
}

// ---------------------------------------------------------------- 镇营统购统销

// 镇营产品无偿调拨入市：不走现金，成本基础随货从建筑转移到批发市场（内部价 0 表示
// 不再向镇库结算，市场把历史投入成本作为自己的存货成本）。
// 与 transferTownToWholesale 的区别：本函数直接搬运「已生产好、尚未定价」的产成品，
// 且不会因镇库余额不足而失败——这是统购统销的"无偿"语义。
export function allocateTownOutputToWholesale(state, itemId, units, content, reason = "镇营产出无偿调拨入批发市场") {
  if (!WHOLESALE_ITEM_IDS.includes(itemId) || units <= 0) return { ok: false, movedUnits: 0 };
  if (!hasWholesaleMarket(state)) return { ok: false, movedUnits: 0, reason: "尚未建成批发市场" };
  const market = ensureWholesaleMarket(state, content);
  const available = Math.max(0, state.accounts?.town?.[itemId] || 0);
  const quantity = Math.min(Math.max(0, Math.floor(units)), available);
  if (quantity <= 0) return { ok: false, movedUnits: 0, reason: "镇库无可调拨库存" };
  const removed = removeTownInventoryWithCost(state, itemId, quantity, content);
  addInventory(market, itemId, quantity, removed.costWheatUnits);
  addPeriodMap(market, "intakeUnits", itemId, quantity);
  market.monopoly.allocatedInValueUnits = (market.monopoly.allocatedInValueUnits || 0) + removed.costWheatUnits;
  recordLedger(state, {
    type: "wholesale_monopoly_allocation", transactionId: makeTransactionId(state),
    source: "town_enterprise", destination: "wholesale_market", itemId,
    quantityUnits: quantity, qeqUnits: 0,
    reason: `${reason}（内部价 0，成本基础 ${removed.costWheatUnits} 随货转移）`
  }, content);
  return { ok: true, itemId, movedUnits: quantity, costVoucherUnits: removed.costWheatUnits };
}

// 镇营原料无偿调拨保障：磨坊要小麦、面包房要面粉。二者都从批发市场库存无偿调拨，
// 内部价 0、成本基础随货转移——这样"镇库库存不得绕过批发市场"的既有契约仍成立：
// 小麦必须先由玩家/固定调拨投放进市场，磨坊再从市场领回。小麦的产权仍归镇库直管
// （镇库→市场→磨坊都只是一次内部搬运，没有对私人主体发生买卖）。
export function allocateInputToTown(state, itemId, requestedUnits, content, reason = "批发市场无偿调拨原料给镇营生产") {
  const market = ensureWholesaleMarket(state, content);
  if (!hasWholesaleMarket(state)) return { ok: false, movedUnits: 0, reason: "尚未建成批发市场" };
  // 小麦本就在镇库，镇营磨坊直接用；这里只报告可用量。
  if (itemId === "wheat") {
    const units = Math.min(Math.max(0, state.accounts?.town?.wheat || 0), Math.max(0, Math.floor(requestedUnits)));
    if (units <= 0) return { ok: false, movedUnits: 0, reason: "镇库小麦不足" };
    return { ok: true, movedUnits: units, costVoucherUnits: 0 };
  }
  const taken = removeInventory(market, itemId, requestedUnits);
  if (taken.units <= 0) {
    return { ok: false, movedUnits: 0, reason: "批发市场缺原料" };
  }
  state.accounts ||= {};
  state.accounts.town ||= {};
  state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + taken.units;
  addTownCostBasis(state, itemId, taken.costVoucherUnits);
  market.monopoly.allocatedInputValueUnits = (market.monopoly.allocatedInputValueUnits || 0) + taken.costVoucherUnits;
  recordLedger(state, {
    type: "wholesale_monopoly_input", transactionId: makeTransactionId(state),
    source: "wholesale_market", destination: "town_enterprise", itemId,
    quantityUnits: taken.units, qeqUnits: 0,
    reason: `${reason}（内部无偿，成本基础 ${taken.costVoucherUnits} 转移）`
  }, content);
  return { ok: true, itemId, movedUnits: taken.units, costVoucherUnits: taken.costVoucherUnits };
}

// ---------------------------------------------------------------- 收购（做市商买入）

function buyPrivateOutput(state, householdId, itemId, requestedUnits, content) {
  // 小麦归镇库直管：批发市场不向民营收购小麦。
  if (itemId === "wheat" || !WHOLESALE_MONOPOLY_ITEM_IDS.includes(itemId)) return 0;
  const household = state.households?.byId?.[householdId];
  const market = ensureWholesaleMarket(state, content);
  if (!household) return 0;
  const available = Math.max(0, household.inventory?.[itemId] || 0);
  const units = Math.min(available, Math.max(0, Math.floor(requestedUnits)));
  if (units <= 0) return 0;
  // 统购统销品（面粉/面包/木材/盐）改用收购价；非统购品沿用售价口径兼容旧行为。
  const value = purchaseValueUnits(itemId, units, state, content);
  // 收购由镇库付款；镇库付不起时收购停止。
  if (value > maximumPayableValueUnits(state, "town", content)) return 0;
  const payment = settleMonetaryPayment(state, "town", `household:${householdId}`, currentPaymentComposition(state, value), content,
    "wholesale_private_purchase", `批发市场收购${household.name}的${content.items[itemId]?.name || itemId}`, { requireFull: true });
  if (!payment.ok) return 0;
  household.inventory[itemId] -= units;
  addInventory(market, itemId, units, value);
  addPeriodMap(market, "intakeUnits", itemId, units);
  addPeriodValue(market, "purchaseVoucherUnits", value);
  addPeriodValue(market, "purchaseSpend", value);
  addValueFlow(market, "purchases", value);
  return units;
}

export function depositWholesalePurchasedInventory(state, itemId, units, costVoucherUnits, content) {
  if (!WHOLESALE_ITEM_IDS.includes(itemId) || units <= 0) return { ok: false, units: 0 };
  const market = ensureWholesaleMarket(state, content);
  addInventory(market, itemId, Math.floor(units), Math.max(0, Math.floor(costVoucherUnits || 0)));
  addPeriodMap(market, "intakeUnits", itemId, Math.floor(units));
  addPeriodValue(market, "purchaseVoucherUnits", Math.max(0, Math.floor(costVoucherUnits || 0)));
  addPeriodValue(market, "purchaseSpend", Math.max(0, Math.floor(costVoucherUnits || 0)));
  addValueFlow(market, "purchases", costVoucherUnits);
  return { ok: true, units: Math.floor(units) };
}

// 民营/公司实物生产税入市：统购品的税货不进镇库账，直接成为批发市场库存，成本基础随货带入市场。
// 只搬货、不付钱（镇里内部，AGENTS.md 钱与货规则）。fromTown=true 表示税货已由原子交易记入镇库，这里从镇库扣回。
// 无批发市场或非统购品时返回 ok:false，调用方保留原来的镇库入账。
export function depositProductionTaxToWholesale(state, itemId, units, costVoucherUnits, content, { fromTown = false, source = "town", reason = "实物生产税入批发市场" } = {}) {
  if (!hasWholesaleMarket(state) || !WHOLESALE_MONOPOLY_ITEM_IDS.includes(itemId)) return { ok: false, movedUnits: 0 };
  const quantity = Math.floor(Number(units) || 0);
  if (quantity <= 0) return { ok: false, movedUnits: 0 };
  const market = ensureWholesaleMarket(state, content);
  const cost = Math.max(0, Math.floor(Number(costVoucherUnits) || 0));
  if (fromTown) state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) - quantity;
  addInventory(market, itemId, quantity, cost);
  addPeriodMap(market, "intakeUnits", itemId, quantity);
  recordLedger(state, {
    type: "wholesale_production_tax_intake", transactionId: makeTransactionId(state),
    source, destination: "wholesale_market", itemId, quantityUnits: quantity, qeqUnits: 0,
    reason: `${reason}（内部无偿，成本基础 ${cost} 随货转移）`
  }, content);
  return { ok: true, movedUnits: quantity, costVoucherUnits: cost };
}

export function runWholesaleIntake(state, productionRows, privateRows, content, options = {}) {
  const market = ensureWholesaleMarket(state, content);
  if (!hasWholesaleMarket(state)) return { active: false, intakeUnits: emptyItemMap(0) };
  const moved = emptyItemMap(0);

  // 镇营统购统销（0.2.3）：镇营生产当日产出「无偿调拨」入市，成本基础随货转移，
  // 不再经过镇库账户、也不再向镇库收取内部价。小麦不在统购之列。
  for (const row of productionRows || []) {
    for (const [itemId, units] of Object.entries(row?.outputUnits || {})) {
      if (!WHOLESALE_ITEM_IDS.includes(itemId) || units <= 0) continue;
      if (itemId === "wheat") {
        // 小麦仍归镇库直管：产出先落镇库，再由玩家/固定调拨投放市场。
        const result = transferTownToWholesale(state, itemId, units, content, "镇营小麦产出暂存镇库后投放批发市场");
        moved[itemId] += result.movedUnits || 0;
        continue;
      }
      const result = allocateTownOutputToWholesale(state, itemId, units, content, "镇营统购统销：产出无偿调拨入市");
      moved[itemId] += result.movedUnits || 0;
      if ((result.movedUnits || 0) > 0) addPeriodMap(market, "townAllocatedUnits", itemId, result.movedUnits);
    }
  }

  // 政府额外固定调拨，可把镇库小麦或历史库存持续送入批发市场。
  if (options.includeTownAllocation !== false) {
    for (const itemId of WHOLESALE_ITEM_IDS) {
      const requested = Math.max(0, market.dailyTownAllocationUnits[itemId] || 0);
      if (requested <= 0) continue;
      const result = transferTownToWholesale(state, itemId, requested, content, "政府每日固定调拨至批发市场");
      const units = result.movedUnits || 0;
      if (units > 0) {
        moved[itemId] += units;
        addPeriodMap(market, "townAllocatedUnits", itemId, units);
      }
    }
  }

  // 民营作坊只出售本日新产出的经营份额，避免把家庭既有口粮误当作商品扫空。
  for (const row of privateRows || []) {
    for (const taxRow of row?.taxRows || []) {
      const itemId = taxRow.itemId;
      if (!WHOLESALE_ITEM_IDS.includes(itemId)) continue;
      const units = buyPrivateOutput(state, taxRow.ownerHouseholdId, itemId, taxRow.residentUnits || 0, content);
      moved[itemId] += units;
    }
  }
  syncResidentAggregates(state, content);

  // 收购完成后按新库存刷新收购价（价格反馈）。
  refreshWholesalePurchasePrices(state, content);
  return { active: true, intakeUnits: moved };
}

// 镇营生产与施工领用原料：市场与镇库同属镇里，一律内部无偿调拨，成本基础随货转移。
export function procureTownInputFromWholesale(state, itemId, requestedUnits, content, reason = "镇营生产从批发市场领用原料") {
  if (!hasWholesaleMarket(state)) return { ok: false, boughtUnits: 0, reason: "尚未建成批发市场" };
  const result = allocateInputToTown(state, itemId, requestedUnits, content, reason);
  return { ok: result.ok, boughtUnits: result.movedUnits || 0, paidVoucherUnits: 0, internalValueVoucherUnits: result.costVoucherUnits || 0, reason: result.reason };
}

// ---------------------------------------------------------------- 镇库直购回退
// 无批发市场时，公司/民营/住户可直接从镇库按镇库价采购（0.1.10 契约）。
// 库存与成本同步移除（removeTownInventoryWithCost），货款进入镇库。
function buyTownDirectForOwner(state, buyerOwner, itemId, requestedUnits, content, reason) {
  // 镇库优先，不足时依次向其他家庭买；小麦给卖方家庭留够口粮。
  const price = currentUnitPrice(state, itemId, content);
  if (!(price > 0)) return { ok: false, boughtUnits: 0, paidVoucherUnits: 0, reason: "镇库价未定", sellerRows: [] };
  const sellers = directSellers(state, itemId, content, { town: true, households: true, excludeBuyer: buyerOwner, keepFoodReserve: true });
  const result = buyDirect(state, buyerOwner, itemId, Math.max(0, Math.floor(requestedUnits)), content, { price, sellers, reason });
  if (!result.ok) return { ...result, reason: "镇库与民营业主均缺货（建成批发市场后可从市场采购）" };
  return { ...result, fromTown: result.sellerRows[0]?.seller === "town" };
}

// ---------------------------------------------------------------- 销售（做市商卖出）

export function buyWholesaleForOwner(state, buyerOwner, itemId, requestedUnits, content, reason = "从批发市场采购") {
  const market = ensureWholesaleMarket(state, content);
  if (!hasWholesaleMarket(state)) {
    // 基线清理：无批发市场时回退到镇库直购（0.1.10 契约：生产原料可优先从镇库供应）。
    // 镇营自己买自己没有意义，仍返回缺市场。
    if (buyerOwner === "town") return { ok: false, boughtUnits: 0, paidVoucherUnits: 0, reason: "尚未建成批发市场" };
    return buyTownDirectForOwner(state, buyerOwner, itemId, requestedUnits, content, reason);
  }
  // 小麦归镇库直管：批发市场不做小麦的做市买卖，但公司/民营仍可按镇库价采购小麦当生产原料
  //（0.1.1 面包链既有契约）；镇营磨坊走免费内部调拨，不走这里。
  if (itemId !== "wheat" && !WHOLESALE_MONOPOLY_ITEM_IDS.includes(itemId)) {
    return { ok: false, boughtUnits: 0, paidVoucherUnits: 0, reason: "批发市场不经营这种商品" };
  }
  // 镇库自己领货走内部调拨，不付钱。
  if (buyerOwner === "town") {
    const internal = allocateInputToTown(state, itemId, requestedUnits, content, reason);
    if (!internal.ok) return { ok: false, boughtUnits: 0, paidVoucherUnits: 0, reason: internal.reason || "批发市场缺货" };
    return { ok: true, boughtUnits: internal.movedUnits, paidVoucherUnits: 0, unitPrice: 0 };
  }
  // 小麦直接从镇库存量出售；其余商品从市场库存出售。
  const available = itemId === "wheat"
    ? Math.max(0, state.accounts?.town?.wheat || 0)
    : Math.max(0, market.inventory[itemId] || 0);
  let units = Math.min(available, Math.max(0, Math.floor(requestedUnits)));
  if (units <= 0) return { ok: false, boughtUnits: 0, paidVoucherUnits: 0, reason: "批发市场缺货" };
  const price = wholesaleUnitPrice(state, itemId, content);
  const maxPayable = maximumPayableValueUnits(state, buyerOwner, content);
  const maxUnitsByCash = price > 0 ? Math.floor(maxPayable * content.precision.inventoryUnitsPerJin / (price * currencyScale(content))) : 0;
  units = Math.min(units, Math.max(0, maxUnitsByCash));
  if (units <= 0) return { ok: false, boughtUnits: 0, paidVoucherUnits: 0, reason: "采购方资金不足" };
  const value = priceValueUnits(itemId, units, state, content);
  const householdId = householdIdOf(buyerOwner);
  const household = householdId ? state.households?.byId?.[householdId] : null;
  const maxWheatUnits = household ? householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30) : undefined;
  // 货款进入镇库。
  const payment = settleMonetaryPayment(state, buyerOwner, "town", currentPaymentComposition(state, value), content,
    "wholesale_sale", reason, { requireFull: true, ...(maxWheatUnits === undefined ? {} : { maxWheatUnits }) });
  if (!payment.ok) return { ok: false, boughtUnits: 0, paidVoucherUnits: 0, reason: payment.reason || "支付失败" };
  let removed;
  if (itemId === "wheat") {
    const takeUnits = Math.min(Math.max(0, state.accounts?.town?.wheat || 0), units);
    const cost = removeTownInventoryWithCost(state, "wheat", takeUnits, content);
    removed = { units: takeUnits, costVoucherUnits: cost.costWheatUnits || 0 };
  } else {
    removed = removeInventory(market, itemId, units);
  }
  addPeriodMap(market, "soldUnits", itemId, removed.units);
  addPeriodValue(market, "salesVoucherUnits", value);
  addValueFlow(market, "sales", value);
  // 售价也随库存回落：卖得越多收购价回升（反馈在 intake 末尾刷新，这里同步一次）。
  refreshWholesalePurchasePrices(state, content);
  return { ok: true, boughtUnits: removed.units, paidVoucherUnits: value, unitPrice: price };
}

// 只读视图：把默认值作用在一份浅拷贝上，绝不回写 state（0.1.8 selector 纯度要求）。
// 与 readOutsideTown 同一模式——selector 读面板不得修改游戏状态。
export function readWholesaleMarket(state, content) {
  const source = state.wholesaleMarket || {};
  const market = {
    ...source,
    inventory: { ...(source.inventory || {}) },
    inventoryCostVoucherUnits: { ...(source.inventoryCostVoucherUnits || {}) },
    pricesVoucherPerUnit: { ...(source.pricesVoucherPerUnit || {}) },
    purchasePricesVoucherPerUnit: { ...(source.purchasePricesVoucherPerUnit || {}) },
    purchasePriceReferenceVoucherPerUnit: { ...(source.purchasePriceReferenceVoucherPerUnit || {}) },
    purchasePriceIndex: { ...(source.purchasePriceIndex || {}) },
    dailyTownAllocationUnits: { ...(source.dailyTownAllocationUnits || {}) },
    monopoly: { ...(source.monopoly || {}) },
    valueFlow: {
      day: { ...((source.valueFlow || {}).day || {}) },
      year: { ...((source.valueFlow || {}).year || {}) },
      cumulative: { ...((source.valueFlow || {}).cumulative || {}) }
    }
  };
  for (const itemId of WHOLESALE_ITEM_IDS) {
    market.inventory[itemId] = Math.max(0, Math.floor(market.inventory[itemId] || 0));
    if (!(Number.isFinite(market.pricesVoucherPerUnit[itemId]) && market.pricesVoucherPerUnit[itemId] > 0)) {
      market.pricesVoucherPerUnit[itemId] = content.rules.wholesaleDefaultSalePrices?.[itemId]
        ?? content.rules.marketPricesVoucherPerUnit?.[itemId] ?? DEFAULT_SALE_PRICES[itemId] ?? 1;
    }
    if (!(Number.isFinite(market.purchasePricesVoucherPerUnit[itemId]) && market.purchasePricesVoucherPerUnit[itemId] > 0)) {
      market.purchasePricesVoucherPerUnit[itemId] = DEFAULT_PURCHASE_PRICES[itemId] ?? market.pricesVoucherPerUnit[itemId];
    }
    if (!(Number.isFinite(market.purchasePriceReferenceVoucherPerUnit[itemId]) && market.purchasePriceReferenceVoucherPerUnit[itemId] > 0)) {
      market.purchasePriceReferenceVoucherPerUnit[itemId] = market.purchasePricesVoucherPerUnit[itemId];
    }
    if (!Number.isFinite(market.purchasePriceIndex[itemId]) || market.purchasePriceIndex[itemId] <= 0) market.purchasePriceIndex[itemId] = 1;
  }
  return market;
}

// 只读版本的收购价/反馈系数，供 selector 使用。
function readPurchasePrice(market, itemId, content) {
  const reference = Number(market.purchasePriceReferenceVoucherPerUnit?.[itemId] || market.purchasePricesVoucherPerUnit?.[itemId] || 0);
  if (!(reference > 0)) return 0;
  const feedback = purchasePriceFeedback(market, itemId, content);
  return Math.max(reference * PURCHASE_PRICE_FLOOR_RATIO, reference * feedback);
}

export function wholesaleSummary(state, content) {
  const market = readWholesaleMarket(state, content);
  const scale = content.precision.inventoryUnitsPerJin;
  const purchasePrices = {};
  const purchaseIndex = {};
  const purchaseReference = {};
  for (const itemId of WHOLESALE_ITEM_IDS) {
    purchasePrices[itemId] = readPurchasePrice(market, itemId, content);
    purchaseIndex[itemId] = Number(market.purchasePriceIndex?.[itemId] ?? 1);
    purchaseReference[itemId] = Number(market.purchasePriceReferenceVoucherPerUnit?.[itemId] || 0);
  }
  const dayPeriod = market.day || { intakeUnits: {}, soldUnits: {}, townAllocatedUnits: {}, purchaseVoucherUnits: 0, salesVoucherUnits: 0 };
  const yearPeriod = market.year || dayPeriod;
  const cumulativePeriod = market.cumulative || dayPeriod;
  const flow = period => ({ salesVoucherUnits: period.salesVoucherUnits || 0, purchaseVoucherUnits: period.purchaseVoucherUnits || 0, netVoucherUnits: (period.salesVoucherUnits || 0) - (period.purchaseVoucherUnits || 0) });
  const cashflow = { day: flow(dayPeriod), year: flow(yearPeriod), cumulative: { ...flow(cumulativePeriod), allocatedInValueUnits: market.monopoly?.allocatedInValueUnits || 0 } };
  return {
    active: hasWholesaleMarket(state),
    pricesVoucherPerUnit: { ...market.pricesVoucherPerUnit },
    purchasePricesVoucherPerUnit: purchasePrices,
    purchasePriceReferenceVoucherPerUnit: purchaseReference,
    purchasePriceIndex: purchaseIndex,
    inventory: Object.fromEntries(WHOLESALE_ITEM_IDS.map(itemId => [itemId, (market.inventory[itemId] || 0) / scale])),
    dailyTownAllocation: Object.fromEntries(WHOLESALE_ITEM_IDS.map(itemId => [itemId, (market.dailyTownAllocationUnits[itemId] || 0) / scale])),
    cashflow,
    monopoly: { ...market.monopoly },
    valueFlow: { ...market.valueFlow, day: { ...market.valueFlow.day }, year: { ...market.valueFlow.year }, cumulative: { ...market.valueFlow.cumulative } },
    day: dayPeriod,
    year: yearPeriod,
    cumulative: cumulativePeriod
  };
}

// 批发市场历史快照（0.1.11 机制补回）：每日记录库存/销量/价格，保留30天。
export function snapshotWholesaleHistory(state, content) {
  if (!hasWholesaleMarket(state)) return;
  // 注意必须用 ensureWholesaleMarket 拿活对象——readWholesaleMarket 返回拷贝，快照写进去会被丢弃。
  const market = ensureWholesaleMarket(state, content);
  market.history ||= [];
  const snapshot = {
    year: state.year,
    day: state.day,
    inventory: Object.fromEntries(WHOLESALE_MONOPOLY_ITEM_IDS.map(itemId => [itemId, market.inventory?.[itemId] || 0])),
    sold: Object.fromEntries(WHOLESALE_MONOPOLY_ITEM_IDS.map(itemId => [itemId, market.day?.soldUnits?.[itemId] || 0])),
    price: Object.fromEntries(WHOLESALE_MONOPOLY_ITEM_IDS.map(itemId => [itemId, market.pricesVoucherPerUnit?.[itemId] || 0]))
  };
  market.history.push(snapshot);
  if (market.history.length > 30) market.history.splice(0, market.history.length - 30);
}

// 近N日均售（0.1.11 ZM）
export function wholesaleAvgSoldUnits(state, itemId, content, days = 7) {
  const market = readWholesaleMarket(state, content);
  const history = (market.history || []).slice(-days);
  if (history.length === 0) return 0;
  return history.reduce((sum, h) => sum + (h.sold?.[itemId] || 0), 0) / history.length;
}

// 批发市场趋势视图（0.1.11 zM）：供面板使用
export function wholesaleTrends(state, content) {
  const market = readWholesaleMarket(state, content);
  const scale = content.precision.inventoryUnitsPerJin;
  const history = market.history || [];
  const result = {};
  for (const itemId of WHOLESALE_MONOPOLY_ITEM_IDS) {
    const avgSoldJin = wholesaleAvgSoldUnits(state, itemId, content, 7) / scale;
    const stockJin = (market.inventory?.[itemId] || 0) / scale;
    result[itemId] = {
      avgSoldJin,
      stockDays: avgSoldJin > 0 ? stockJin / avgSoldJin : null,
      townStockJin: (state.accounts?.town?.[itemId] || 0) / scale,
      inventory: history.map(h => (h.inventory?.[itemId] || 0) / scale),
      price: history.map(h => h.price?.[itemId] || 0)
    };
  }
  return result;
}
