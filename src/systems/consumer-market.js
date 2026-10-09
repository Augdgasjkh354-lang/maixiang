import {
  maximumResidentAutoExchangeWheatUnits,
  currencyScale
} from "../economy/currency.js";
import {
  createPaymentCapabilityContext, currentPaymentComposition, quotePaymentValueUnitsWithContext, settleMonetaryPayment, spendableVoucherUnits
} from "../economy/payment.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { sellCompanyProduct, companySalePrice } from "./companies.js";
import { sellShopProduct, shopDefinition, shopSalesCapacityUnits, shopRetailItemIds, registerRejectedHouseholds, registerShopStockoutDemand } from "./shops.js";
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
  // 断货店（库存为 0）：居民想买时记为断货需求，供次日进货口径使用。
  const stockouts = options.stockouts && Array.isArray(options.stockouts) ? options.stockouts : null;
  const generalStoreOnly = Boolean(content.items[itemId]?.storeOnly);
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
    // 只经商店卖的商品：综合商店都能卖；摊位只能卖它经营的日用品。
    if (generalStoreOnly && def?.id !== "general" && def?.kind !== "stall") continue;
    const prices = shopTradePrices(state, shop.typeId, content, itemId, shop);
    const stock = shop.inventory?.[itemId] || 0;
    const soldToday = Object.values(shop.accounts?.day?.soldUnits || {}).reduce((sum, units) => sum + Math.max(0, units || 0), 0);
    const remainingCapacity = Math.max(0, shopSalesCapacityUnits(state, shop, content) - soldToday);
    const available = Math.min(stock, remainingCapacity);
    if (stock > available && capped && def && prices) {
      capped.push({ shopId: shop.id, cappedUnits: stock - available, price: prices.retailVoucherPerUnit });
    }
    // 断货需求只记在本店经营的品类上（兜底售卖的非经营品不参与进货口径）。
    const businessItem = shopRetailItemIds(shop, content).includes(itemId);
    if (stock <= 0 && stockouts && businessItem && def && prices) stockouts.push({ shopId: shop.id, price: prices.retailVoucherPerUnit });
    // stockLimited：可售量受库存（而非接待能力）限制，售罄即断货。
    if (available > 0 && def && prices) sellers.push({ id: `shop:${shop.id}`, type: "shop", shopId: shop.id, shopTypeId: def.id, stockUnits: available, price: prices.retailVoucherPerUnit, stockLimited: available === stock && businessItem });
  }
  // Snapshot direct household suppliers once, before resident demand is processed.
  // This lets private producers sell without a shop while preventing goods bought
  // earlier in the same demand pass from being re-sold as fresh supply.
  if (!generalStoreOnly && options.excludeHouseholdSellers !== true) for (const household of householdList(state).filter(isActiveHousehold)) {
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

// 粗估一户按某价能买多少（粮券 + 今日还能换券的小麦）：不走支付层报价，用于需求统计和二分查找的初值。
function quickAffordableUnits(state, household, price, content, reserveDays) {
  if (!(price > 0)) return 0;
  const wheatUnits = Math.min(householdConvertibleWheatUnits(state, household, content, reserveDays),
    householdExchangeAllowanceUnits(state, household.id, content));
  // 以粮换券还受镇库券池限制（与支付层同口径），券池见底时不能把富余小麦算作买得起。
  const wheatValue = voucherUnitsForWheatUnits(Math.max(0, wheatUnits), content, "floor");
  const exchangeValue = state.monetaryReform?.stage === "voucher" ? Math.min(wheatValue, Math.max(0, state.currency?.balances?.town || 0)) : wheatValue;
  const value = spendableVoucherUnits(state, `household:${household.id}`) + exchangeValue;
  return Math.max(0, Math.floor(value * content.precision.inventoryUnitsPerJin / (price * currencyScale(content))));
}

function maximumAffordableUnits(state, household, price, content, reserveDays, cap = Number.POSITIVE_INFINITY) {
  const scale = currencyScale(content);
  const inventoryScale = content.precision.inventoryUnitsPerJin;
  if (price <= 0) return 0;
  const owner = `household:${household.id}`;
  const voucherAvailable = spendableVoucherUnits(state, owner);
  const wheatUnitsAvailable = householdConvertibleWheatUnits(state, household, content, reserveDays);
  const wheatValueAvailable = voucherUnitsForWheatUnits(wheatUnitsAvailable, content, "floor");
  // 仅作为二分上界；真正可支付性统一交给支付层判断，避免全粮券阶段误回退小麦。
  let high = Math.min(cap, Math.max(0, Math.floor((voucherAvailable + wheatValueAvailable) * inventoryScale / (price * scale))));
  // 上界为 0 时不必建支付上下文（买不起的户占大多数）。
  if (high <= 0) return 0;
  const paymentContext = createPaymentCapabilityContext(state, owner, content, { maxWheatUnits: wheatUnitsAvailable });
  const canPay = valueUnits => quotePaymentValueUnitsWithContext(paymentContext, valueUnits).full;
  let low = 0;
  // 常见情况：想买的量本来就付得起，一次报价就够，不用二分。
  if (high > 0 && canPay(Math.round(high / inventoryScale * price * scale))) return high;
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
  const current = spendableVoucherUnits(state, "residents");
  const people = populationStats(state).total;
  const convertibleWheatUnits = maximumResidentAutoExchangeWheatUnits(
    state, people, reserveDays ?? content.rules.basicCommerceFoodReserveDays ?? 30, content
  );
  const availableValue = current + voucherUnitsForWheatUnits(convertibleWheatUnits, content, "floor");
  const price = Number(priceVoucherPerPhysicalUnit);
  if (!Number.isFinite(price) || price <= 0) return 0;
  return Math.max(0, Math.floor(availableValue / price));
}

// 未满足需求里居民买得起（按最低售价）的部分：返回单位数与对应的家庭 id 列表。
// 单位数封顶于 unmetUnits（用于断货口径）；家庭列表不封顶，每户只记一次。
function affordableUnmetHouseholds(state, unmetUnits, minPrice, householdNeed, content) {
  const reserveDays = content.rules.basicCommerceFoodReserveDays ?? 30;
  const totalPeople = Math.max(1, populationStats(state).total);
  let affordable = 0;
  const households = [];
  for (const household of householdList(state).filter(isActiveHousehold)) {
    const need = householdNeed
      ? householdNeed.get(household.id) || 0
      : Math.ceil(unmetUnits * householdPopulation(household) / totalPeople);
    if (need <= 0) continue;
    const canBuy = Math.min(need, quickAffordableUnits(state, household, minPrice, content, reserveDays));
    if (canBuy <= 0) continue;
    affordable += canBuy;
    households.push(household.id);
  }
  return { units: Math.min(unmetUnits, affordable), households };
}

// 每户未满足的家庭只归一家店（轮流分配，按售价从低到高排序），避免同一家庭在多店重复计拒客。
function assignHouseholdsToShops(householdIds, rows) {
  const shopIds = [...new Set(rows.slice().sort((a, b) => a.price - b.price || String(a.shopId).localeCompare(String(b.shopId))).map(row => row.shopId))];
  const assigned = new Map(shopIds.map(shopId => [shopId, []]));
  if (!shopIds.length) return assigned;
  householdIds.forEach((householdId, index) => assigned.get(shopIds[index % shopIds.length]).push(householdId));
  return assigned;
}

// 用户 0.1.11（-5）原 f9：未满足的需求里居民买得起的家庭，按户记拒客（每户每店每日最多 1 人），
// 分配到被接待能力限流的店铺（店铺增员判断的依据之一）。
function registerCappedRejection(state, itemId, unmetUnits, capped, householdNeed, content) {
  if (!(unmetUnits > 0) || !capped.length) return;
  const minPrice = Math.min(...capped.map(row => row.price));
  const { households } = affordableUnmetHouseholds(state, unmetUnits, minPrice, householdNeed, content);
  for (const [shopId, householdIds] of assignHouseholdsToShops(households, capped)) {
    registerRejectedHouseholds(state, shopId, householdIds, content);
  }
}

// 断货需求：居民买得起的未满足量，按断货店均分记入各店当日断货需求（单位数）；
// 拒客按户分配到断货店，每户每店每日最多 1 人。
function registerStockoutDemand(state, itemId, unmetUnits, stockouts, householdNeed, content) {
  if (!(unmetUnits > 0) || !stockouts.length) return;
  const minPrice = Math.min(...stockouts.map(row => row.price));
  const { units, households } = affordableUnmetHouseholds(state, unmetUnits, minPrice, householdNeed, content);
  const allocation = allocateIntegerByWeight(Math.floor(units), stockouts, () => 1);
  for (const row of allocation.rows || []) {
    if (row.units > 0) registerShopStockoutDemand(state, row.recipient.shopId, itemId, row.units, content);
  }
  for (const [shopId, householdIds] of assignHouseholdsToShops(households, stockouts)) {
    registerRejectedHouseholds(state, shopId, householdIds, content);
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
  const stockoutSellers = [];
  const sellers = sellerRowsForItem(state, itemId, directPrice, content, { ...options, capped: cappedSellers, stockouts: stockoutSellers });
  // 弹性只在综合商店是卖家时才应用，避免误伤其他卖家。
  desiredUnits = applyRetailElasticity(state, itemId, desiredUnits, content, sellers);
  if (!sellers.length) {
    // 用户 0.1.11（-5）：无可用卖家但有店铺被接待能力限流，记拒客并返回对应原因。
    // 有指定各户需求时按户口径记拒客，否则按人口估算各户需求。
    const noSellerRequested = options.householdNeedsUnits || null;
    const noSellerNeed = noSellerRequested
      ? new Map(householdList(state).filter(isActiveHousehold).map(household => [household.id, Math.max(0, Math.floor(noSellerRequested[household.id] || 0))]))
      : null;
    registerCappedRejection(state, itemId, Math.max(0, Math.floor(desiredUnits)), cappedSellers, noSellerNeed, content);
    registerStockoutDemand(state, itemId, Math.max(0, Math.floor(desiredUnits)), stockoutSellers, noSellerNeed, content);
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
      const wanted = Math.min(need, sellerLeft, desiredUnits - purchased);
      const units = Math.min(wanted, maximumAffordableUnits(state, household, seller.price, content, reserveDays, wanted));
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
    if (seller.type === "shop" && seller.stockLimited && sellerLeft <= 0) stockoutSellers.push({ shopId: seller.shopId, price: seller.price });
  }
  state._deferHouseholdSync = previousDefer;
  if (!previousDefer) syncResidentAggregates(state, content);
  if (sellerRows.length) state.market.sellerRotation[itemId] = (rotation + 1) % Math.max(1, sellers.length);
  // 用户 0.1.11（-5）：部分成交时，未满足且居民买得起的需求按店铺限流比例记拒客。
  if (purchased < desiredUnits && cappedSellers.length) {
    registerCappedRejection(state, itemId, desiredUnits - purchased, cappedSellers, householdNeed, content);
  }
  // 部分成交且有店铺售罄（库存限制）：未满足的买得起需求记为断货需求，次日补货。
  if (purchased < desiredUnits && stockoutSellers.length) {
    registerStockoutDemand(state, itemId, desiredUnits - purchased, stockoutSellers, householdNeed, content);
  }
  const stockUnits = sellers.reduce((sum, row) => sum + row.stockUnits, 0);
  return {
    purchasedUnits: purchased,
    paidVoucherUnits: paid,
    sellerRows,
    reason: purchased < desiredUnits
      ? (purchased >= stockUnits ? "市场库存不足，按现有库存部分成交"
        : state.monetaryReform?.stage === "voucher" && (state.currency?.balances?.town || 0) <= 0 ? "镇库券池已空，居民的小麦换不到粮券" : "居民粮券或今日换券额度限制了成交量")
      : "按需求成交"
  };
}
