import {
  maximumResidentAutoExchangeWheatUnits,
  voucherBalance,
  currencyScale
} from "../economy/currency.js";
import {
  createPaymentCapabilityContext, currentPaymentComposition, quotePaymentValueUnitsWithContext, settleMonetaryPayment
} from "../economy/payment.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { sellCompanyProduct, companySalePrice } from "./companies.js";
import { sellShopProduct, shopDefinition, shopSalesCapacityUnits, shopRetailItemIds, registerRejectedCustomers } from "./shops.js";
import { shopTradePrices } from "../economy/operating-plan.js";
import {
  householdList, householdPopulation, isActiveHousehold, householdConvertibleWheatUnits, householdExchangeAllowanceUnits,
  householdFoodQeqUnits, householdReserveQeqUnits,
  creditHouseholdInventory, residentInventoryUnits, syncResidentAggregates
} from "./households.js";
import { qeqUnitsForInventoryUnits } from "../economy/inventory.js";
import { removeTownInventoryWithCost } from "../economy/business.js";
import { populationStats } from "../selectors/labor.js";
import { allocateIntegerByWeight } from "../core/allocation.js";
import { priceElasticityDemandMultiplier } from "./shop-pricing.js";

function rotated(list, offset) {
  if (!list.length) return list;
  const start = ((offset || 0) % list.length + list.length) % list.length;
  return list.slice(start).concat(list.slice(0, start));
}

function allocateByPopulation(totalUnits, households) {
  const allocation = allocateIntegerByWeight(totalUnits, households, household => householdPopulation(household));
  if (!allocation.ok) return [];
  return allocation.rows.map(({ recipient: household, units }) => ({ household, units }));
}

function sellerRowsForItem(state, itemId, directPrice, content, options = {}) {
  const sellers = [];
  // 用户 0.1.11（-5）：库存超过当日剩余接待能力的店铺，溢出部分记 capped，
  // 未满足的需求按比例折算成各店的拒客数（registerCappedRejection）。
  const capped = options.capped && Array.isArray(options.capped) ? options.capped : null;
  const generalStoreOnly = new Set(["flour", "bread", "salt", "wine", "cloth"]).has(itemId);
  const townStock = state.accounts.town[itemId] || 0;
  // 镇库木材属于建设储备，居民修缮需求不向镇库购买，避免挤占施工用材。
  const townSellable = !generalStoreOnly && options.excludeTownSellers !== true;
  if (townSellable && townStock > 0) sellers.push({ id: "town", type: "town", stockUnits: townStock, price: directPrice });
  if (!generalStoreOnly) for (const company of Object.values(state.companies || {})) {
    const stock = company.inventory?.[itemId] || 0;
    if (stock > 0) sellers.push({ id: `company:${company.id}`, type: "company", companyId: company.id, stockUnits: stock, price: companySalePrice(state, company, itemId, content) });
  }
  for (const shop of Object.values(state.shops || {})) {
    if (shop.status !== "open") continue;
    const def = shopDefinition(content, shop.typeId);
    // 用户 0.1.11：有库存的零售店可出售非经营品类（兜底）。
    const sellsItem = shopRetailItemIds(shop, content).includes(itemId)
      || (def?.kind === "retail" && (shop.inventory?.[itemId] || 0) > 0);
    if (!sellsItem) continue;
    if (generalStoreOnly && def?.id !== "general") continue;
    const prices = shopTradePrices(state, shop.typeId, content, itemId, shop);
    const stock = shop.inventory?.[itemId] || 0;
    const soldToday = Object.values(shop.accounts?.day?.soldUnits || {}).reduce((sum, units) => sum + Math.max(0, units || 0), 0);
    const remainingCapacity = Math.max(0, shopSalesCapacityUnits(state, shop, content) - soldToday);
    const available = Math.min(stock, remainingCapacity);
    if (stock > available && capped && def && prices) {
      capped.push({ shopId: shop.id, cappedUnits: stock - available, price: prices.retailVoucherPerUnit });
    }
    if (available > 0 && def && prices) sellers.push({ id: `shop:${shop.id}`, type: "shop", shopId: shop.id, shopTypeId: def.id, stockUnits: available, price: prices.retailVoucherPerUnit });
  }
  // Snapshot direct household suppliers once, before resident demand is processed.
  // This lets private producers sell without a shop while preventing goods bought
  // earlier in the same demand pass from being re-sold as fresh supply.
  if (!generalStoreOnly) for (const household of householdList(state).filter(isActiveHousehold)) {
    const stock = household.inventory?.[itemId] || 0;
    if (stock <= 0) continue;
    let available = stock;
    const item = content.items[itemId];
    if (item?.edible) {
      const reserve = householdReserveQeqUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
      const food = householdFoodQeqUnits(state, household, content);
      const perUnit = qeqUnitsForInventoryUnits(item, 1, content);
      available = Math.min(stock, Math.max(0, Math.floor((food - reserve) / Math.max(1, perUnit))));
    }
    if (available > 0) sellers.push({
      id: `household:${household.id}`,
      type: "household",
      householdId: household.id,
      stockUnits: available,
      price: directPrice
    });
  }
  return sellers;
}

function maximumAffordableUnits(state, household, price, content, reserveDays) {
  const scale = currencyScale(content);
  const inventoryScale = content.precision.inventoryUnitsPerJin;
  if (price <= 0) return 0;
  const owner = `household:${household.id}`;
  const voucherAvailable = voucherBalance(state, owner);
  const wheatUnitsAvailable = householdConvertibleWheatUnits(state, household, content, reserveDays);
  const wheatValueAvailable = voucherUnitsForWheatUnits(wheatUnitsAvailable, content, "floor");
  const paymentContext = createPaymentCapabilityContext(state, owner, content, { maxWheatUnits: wheatUnitsAvailable });
  const canPay = valueUnits => quotePaymentValueUnitsWithContext(paymentContext, valueUnits).full;
  let low = 0;
  // 仅作为二分上界；真正可支付性统一交给支付层判断，避免全粮券阶段误回退小麦。
  let high = Math.max(0, Math.floor((voucherAvailable + wheatValueAvailable) * inventoryScale / (price * scale)));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const cost = Math.round(mid / inventoryScale * price * scale); // 用于canPay，非死变量
    if (canPay(cost)) low = mid; else high = mid - 1;
  }
  return low;
}

function transactSeller(state, seller, household, itemId, units, content, reason, options = {}) {
  if (units <= 0) return { ok: false, reason: "成交量为0" };
  const scale = currencyScale(content);
  const inventoryScale = content.precision.inventoryUnitsPerJin;
  const cost = Math.round(units / inventoryScale * seller.price * scale);
  const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.basicCommerceFoodReserveDays ?? 30);
  if (seller.type === "town") {
    if ((state.accounts.town?.[itemId] || 0) < units) return { ok: false, reason: "镇库库存不足" };
    const payment = settleMonetaryPayment(state, `household:${household.id}`, "town", currentPaymentComposition(state, cost), content,
      options.paymentType || `${itemId}_trade`, reason || `家庭购买${content.items[itemId]?.name || itemId}`, { requireFull: true, maxWheatUnits });
    if (!payment.ok) return payment;
    const removal = removeTownInventoryWithCost(state, itemId, units, content);
    return { ok: true, quantityUnits: units, paidVoucherUnits: cost, paidValueUnits: cost, payment, sellerCostVoucherUnits: removal.costWheatUnits };
  }
  if (seller.type === "company") {
    const sale = sellCompanyProduct(state, seller.companyId, `household:${household.id}`, itemId, units, seller.price, content,
      reason || `家庭购买${content.items[itemId]?.name || itemId}`);
    return sale.ok
      ? { ok: true, quantityUnits: sale.quantityUnits, paidVoucherUnits: sale.revenueVoucherUnits }
      : sale;
  }
  if (seller.type === "household") {
    if (seller.householdId === household.id) return { ok: false, reason: "不能购买自己挂牌的商品" };
    const source = state.households?.byId?.[seller.householdId];
    if (!source || (source.inventory?.[itemId] || 0) < units) return { ok: false, reason: "卖方库存不足" };
    const payment = settleMonetaryPayment(state, `household:${household.id}`, `household:${seller.householdId}`, currentPaymentComposition(state, cost), content,
      options.paymentType || `${itemId}_direct_trade`, reason || `家庭购买${content.items[itemId]?.name || itemId}`, { requireFull: true, maxWheatUnits });
    if (!payment.ok) return payment;
    source.inventory[itemId] -= units;
    return { ok: true, quantityUnits: units, paidVoucherUnits: cost };
  }
  const sale = sellShopProduct(state, seller.shopId, `household:${household.id}`, units, content,
    reason || `家庭在店铺购买${content.items[itemId]?.name || itemId}`, itemId);
  return sale.ok
    ? { ok: true, quantityUnits: sale.quantityUnits, paidVoucherUnits: sale.paidVoucherUnits }
    : sale;
}

export function residentPurchasePowerUnits(state, priceVoucherPerPhysicalUnit, content, reserveDays = null) {
  const current = voucherBalance(state, "residents");
  const people = populationStats(state).total;
  const convertibleWheatUnits = maximumResidentAutoExchangeWheatUnits(
    state, people, reserveDays ?? content.rules.basicCommerceFoodReserveDays ?? 30, content
  );
  const availableValue = current + voucherUnitsForWheatUnits(convertibleWheatUnits, content, "floor");
  const price = Number(priceVoucherPerPhysicalUnit);
  if (!Number.isFinite(price) || price <= 0) return 0;
  return Math.max(0, Math.floor(availableValue / price));
}

// 用户 0.1.11（-5）原 f9：未满足的需求里居民买得起的部分，按各店铺被限流的
// 库存比例折算成拒客数，记到对应店铺（店铺增员判断的依据之一）。
function registerCappedRejection(state, itemId, unmetUnits, capped, householdNeed, content) {
  if (!(unmetUnits > 0) || !capped.length) return;
  const minPrice = Math.min(...capped.map(row => row.price));
  const reserveDays = content.rules.basicCommerceFoodReserveDays ?? 30;
  const totalPeople = Math.max(1, populationStats(state).total);
  let affordable = 0;
  for (const household of householdList(state).filter(isActiveHousehold)) {
    if (affordable >= unmetUnits) break;
    const need = householdNeed
      ? householdNeed.get(household.id) || 0
      : Math.ceil(unmetUnits * householdPopulation(household) / totalPeople);
    if (need <= 0) continue;
    affordable += Math.min(need, maximumAffordableUnits(state, household, minPrice, content, reserveDays));
  }
  affordable = Math.min(unmetUnits, affordable);
  const totalCapped = capped.reduce((sum, row) => sum + row.cappedUnits, 0);
  for (const row of capped) {
    const units = Math.min(row.cappedUnits, Math.round(affordable * row.cappedUnits / Math.max(1, totalCapped)));
    if (units > 0) registerRejectedCustomers(state, row.shopId, units, content);
  }
}

// 0.2.3 需求弹性：居民面对综合商店的实际售价，若相对该店过去 30 天均价更贵，
// 则按"每贵 10% 少买 5%"缩减当日目标购买量。只对综合商店（动态加价店）生效，
// 其他卖家/小店保持原行为。返回缩放后的目标单位数。
// 注意：调用方需确保综合商店是实际卖家之一，否则弹性会误伤其他卖家的销量。
function applyRetailElasticity(state, itemId, desiredUnits, content, sellers) {
  if (!(desiredUnits > 0)) return desiredUnits;
  // 若卖家列表里没有综合商店，不应用弹性（避免压低镇库/公司/住户的销量）。
  const hasGeneral = (sellers || []).some(row => row.type === "shop" && row.shopTypeId === "general");
  if (!hasGeneral) return desiredUnits;
  let multiplier = 1;
  for (const shop of Object.values(state.shops || {})) {
    if (shop.status !== "open") continue;
    if (shopDefinition(content, shop.typeId)?.id !== "general") continue;
    if (!shopRetailItemIds(shop, content).includes(itemId)) continue;
    const prices = shopTradePrices(state, shop.typeId, content, itemId, shop);
    if (!prices) continue;
    const shopMultiplier = priceElasticityDemandMultiplier(state, shop, itemId, prices.retailVoucherPerUnit, content);
    multiplier = Math.min(multiplier, shopMultiplier);
  }
  if (multiplier >= 1) return desiredUnits;
  return Math.max(0, Math.round(desiredUnits * multiplier));
}

export function purchaseItemForResidents(state, itemId, desiredUnits, priceVoucherPerPhysicalUnit, content, reason, options = {}) {
  const directPrice = Number(priceVoucherPerPhysicalUnit);
  if (!Number.isFinite(directPrice) || directPrice <= 0 || desiredUnits <= 0) {
    return { purchasedUnits: 0, paidVoucherUnits: 0, sellerRows: [], reason: desiredUnits <= 0 ? "需求已满足" : "售价无效" };
  }
  const cappedSellers = [];
  const sellers = sellerRowsForItem(state, itemId, directPrice, content, { ...options, capped: cappedSellers });
  // 弹性只在综合商店是卖家时才应用，避免误伤其他卖家。
  desiredUnits = applyRetailElasticity(state, itemId, desiredUnits, content, sellers);
  if (!sellers.length) {
    // 用户 0.1.11（-5）：无可用卖家但有店铺被接待能力限流，记拒客并返回对应原因。
    registerCappedRejection(state, itemId, Math.max(0, Math.floor(desiredUnits)), cappedSellers, null, content);
    return { purchasedUnits: 0, paidVoucherUnits: 0, sellerRows: [], reason: cappedSellers.length ? "店铺接待能力已满" : "市场没有可售库存" };
  }

  state.market.sellerRotation ||= {};
  const rotation = state.market.sellerRotation[itemId] || 0;
  // 先按价格选择；同价卖家用轮换游标，避免长期只成交第一家。
  const prices = [...new Set(sellers.map(row => row.price))].sort((a, b) => a - b);
  const ordered = prices.flatMap(price => rotated(sellers.filter(row => row.price === price), rotation));
  const households = householdList(state).filter(isActiveHousehold).slice().sort((a, b) => {
    const aPer = (a.inventory?.[itemId] || 0) / Math.max(1, householdPopulation(a));
    const bPer = (b.inventory?.[itemId] || 0) / Math.max(1, householdPopulation(b));
    return aPer - bPer || a.id.localeCompare(b.id);
  });
  if (!households.length) return { purchasedUnits: 0, paidVoucherUnits: 0, sellerRows: [], reason: "没有居民家庭" };
  const requestedNeeds = options.householdNeedsUnits || null;
  const allocations = requestedNeeds
    ? households.map(household => ({ household, units: Math.max(0, Math.floor(requestedNeeds[household.id] || 0)) }))
    : allocateByPopulation(Math.max(0, Math.floor(desiredUnits)), households);
  const householdNeed = new Map(allocations.map(row => [row.household.id, row.units]));
  const reserveDays = content.rules.basicCommerceFoodReserveDays ?? 30;
  const sellerRows = [];
  let purchased = 0;
  let paid = 0;
  const previousDefer = Boolean(state._deferHouseholdSync);
  state._deferHouseholdSync = true;

  for (const seller of ordered) {
    if (purchased >= desiredUnits) break;
    let sellerLeft = seller.stockUnits;
    if (sellerLeft <= 0) continue;
    let sellerSold = 0;
    let sellerPaid = 0;
    let sellerCost = 0;
    for (const household of households) {
      if (sellerLeft <= 0 || purchased >= desiredUnits) break;
      const need = householdNeed.get(household.id) || 0;
      if (need <= 0) continue;
      if (seller.type === "household" && seller.householdId === household.id) continue;
      const affordable = maximumAffordableUnits(state, household, seller.price, content, reserveDays);
      const units = Math.min(need, sellerLeft, desiredUnits - purchased, affordable);
      if (units <= 0) continue;
      const sale = transactSeller(state, seller, household, itemId, units, content, reason);
      if (!sale.ok || sale.quantityUnits <= 0) continue;
      creditHouseholdInventory(state, household.id, itemId, sale.quantityUnits, content);
      householdNeed.set(household.id, need - sale.quantityUnits);
      sellerLeft -= sale.quantityUnits;
      sellerSold += sale.quantityUnits;
      sellerPaid += sale.paidVoucherUnits;
      sellerCost += sale.sellerCostVoucherUnits || sale.cogsVoucherUnits || 0;
      purchased += sale.quantityUnits;
      paid += sale.paidVoucherUnits;
    }
    if (sellerSold > 0) sellerRows.push({ seller: seller.id, quantityUnits: sellerSold, paidVoucherUnits: sellerPaid, sellerCostVoucherUnits: sellerCost });
  }
  state._deferHouseholdSync = previousDefer;
  if (!previousDefer) syncResidentAggregates(state, content);
  if (sellerRows.length) state.market.sellerRotation[itemId] = (rotation + 1) % Math.max(1, sellers.length);
  // 用户 0.1.11（-5）：部分成交时，未满足且居民买得起的需求按店铺限流比例记拒客。
  if (purchased < desiredUnits && cappedSellers.length) {
    registerCappedRejection(state, itemId, desiredUnits - purchased, cappedSellers, householdNeed, content);
  }
  const stockUnits = sellers.reduce((sum, row) => sum + row.stockUnits, 0);
  return {
    purchasedUnits: purchased,
    paidVoucherUnits: paid,
    sellerRows,
    reason: purchased < desiredUnits
      ? (purchased >= stockUnits ? "市场库存不足，按现有库存部分成交" : "居民粮券或今日换券额度限制了成交量")
      : "按需求成交"
  };
}
