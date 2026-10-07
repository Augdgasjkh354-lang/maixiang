// 统一交易：带成本的库存进出、"一个卖家卖给一个买家"、按卖家顺序直接采购。
// 只依赖经济底层模块，公司、批发市场、镇库采购都调用这里，彼此不再互相引用。
//
// 有库存的经营主体（公司、店铺、批发市场）都用同一结构：
//   entity.inventory[itemId]                 库存单位
//   entity.inventoryCostVoucherUnits[itemId] 这批库存的总成本（小麦等值单位）
// 镇库的库存成本另记在 business 账里，由 removeTownInventoryWithCost / addTownCostBasis 处理。

import { currencyScale } from "./currency.js";
import { currentPaymentComposition, maximumPayableValueUnits, settleMonetaryPayment } from "./payment.js";
import { addTownCostBasis, removeTownInventoryWithCost } from "./business.js";
import { makeTransactionId, recordLedger } from "./ledger.js";
import { bookAdd, bookAddMap } from "./books.js";
import { householdIdOf, parseOwner } from "./accounts.js";
import { syncResidentAggregates } from "../systems/households.js";

// ---------------------------------------------------------------- 带成本的库存

export function putStock(entity, itemId, units, costUnits = 0) {
  entity.inventory ||= {};
  entity.inventoryCostVoucherUnits ||= {};
  entity.inventory[itemId] = (entity.inventory[itemId] || 0) + units;
  entity.inventoryCostVoucherUnits[itemId] = (entity.inventoryCostVoucherUnits[itemId] || 0) + Math.max(0, Math.floor(costUnits || 0));
}

// 按比例带走成本；strict 时超出库存直接报错，否则有多少取多少。返回 { units, costUnits }。
export function takeStock(entity, itemId, units, { strict = false } = {}) {
  const available = entity.inventory?.[itemId] || 0;
  if (strict && (!Number.isSafeInteger(units) || units < 0 || units > available)) throw new RangeError("库存扣除超限：" + itemId);
  const quantity = Math.min(Math.max(0, Math.floor(units)), available);
  if (quantity <= 0) return { units: 0, costUnits: 0 };
  const basis = entity.inventoryCostVoucherUnits?.[itemId] || 0;
  const cost = quantity === available ? basis : Math.floor(basis * quantity / available);
  entity.inventory[itemId] = available - quantity;
  entity.inventoryCostVoucherUnits[itemId] = Math.max(0, basis - cost);
  return { units: quantity, costUnits: cost };
}

// ---------------------------------------------------------------- 计价

export function valueOf(units, price, content) {
  return Math.max(0, Math.round(units / content.precision.inventoryUnitsPerJin * price * currencyScale(content)));
}

// 买方付得起的最大数量（按单价线性折算）。
export function affordableUnits(state, buyer, price, content, options = {}) {
  if (!(price > 0)) return 0;
  const maxPayable = maximumPayableValueUnits(state, buyer, content, options);
  return Math.max(0, Math.floor(maxPayable * content.precision.inventoryUnitsPerJin / (price * currencyScale(content))));
}

// ---------------------------------------------------------------- 卖家

// 公司卖货：收款、出库、记收入/成本/利润。
export function sellCompanyGoods(state, company, buyer, itemId, units, price, content, reason, paymentOptions = {}) {
  const quantity = Math.min(company.inventory?.[itemId] || 0, units);
  if (quantity <= 0) return { ok: false, reason: "企业库存不足" };
  const revenue = valueOf(quantity, Number(price), content);
  const payment = settleMonetaryPayment(state, buyer, "company:" + company.id, currentPaymentComposition(state, revenue), content,
    "enterprise_sale", reason || `${company.name}销售${content.items[itemId]?.name || itemId}`, { requireFull: true, ...paymentOptions });
  if (!payment.ok) return payment;
  const { costUnits } = takeStock(company, itemId, quantity, { strict: true });
  bookAdd(company.accounts, "revenueVoucherUnits", revenue);
  bookAdd(company.accounts, "cogsVoucherUnits", costUnits);
  bookAddMap(company.accounts, "soldUnits", itemId, quantity);
  bookAdd(company.accounts, "profitVoucherUnits", revenue - costUnits);
  company.retainedEarningsVoucherUnits = (company.retainedEarningsVoucherUnits || 0) + revenue - costUnits;
  return { ok: true, quantityUnits: quantity, revenueVoucherUnits: revenue, cogsVoucherUnits: costUnits, transactionId: payment.transactionId };
}

// 一个卖家卖给一个买家。seller: { id: "town" | "household:<id>" | "company:<id>" }。
// 返回 { ok, units, paidVoucherUnits }；买方收货由调用方按自己的口径入库。
function sellOnce(state, seller, buyer, itemId, units, price, content, reason, paymentType) {
  const { kind, id } = parseOwner(seller.id);
  const itemName = content.items[itemId]?.name || itemId;
  if (kind === "company") {
    const company = state.companies?.[id];
    const sale = company ? sellCompanyGoods(state, company, buyer, itemId, units, price, content, reason) : { ok: false };
    return sale.ok ? { ok: true, units: sale.quantityUnits, paidVoucherUnits: sale.revenueVoucherUnits } : { ok: false };
  }
  const value = valueOf(units, price, content);
  const payment = settleMonetaryPayment(state, buyer, seller.id, currentPaymentComposition(state, value), content,
    paymentType || (kind === "town" ? "town_direct_sale" : "household_direct_sale"), reason || `直购${itemName}`, { requireFull: true });
  if (!payment.ok) return { ok: false };
  if (kind === "town") {
    const quote = removeTownInventoryWithCost(state, itemId, units, content);
    recordLedger(state, { type: "town_direct_sale", buyer, itemId, quantityUnits: quote.quantityUnits,
      qeqUnits: quote.quantityUnits * content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin,
      paidVoucherUnits: value, reason: "镇库直售" }, content);
    return { ok: true, units: quote.quantityUnits, paidVoucherUnits: value };
  }
  const household = state.households.byId[id];
  if ((household.inventory?.[itemId] || 0) < units) throw new Error("家庭库存预检后不足");
  household.inventory[itemId] -= units;
  syncResidentAggregates(state, content);
  return { ok: true, units, paidVoucherUnits: value };
}

// 可直接出售某物品的卖家（镇库、各户、公司），附可售量。
// options: town / households / companies 选择卖家类型；excludeBuyer 排除买方自己；
//          keepFoodReserve 时小麦给卖方家庭留够口粮储备。
export function directSellers(state, itemId, content, options = {}) {
  const sellers = [];
  if (options.town) {
    const stock = Math.max(0, state.accounts?.town?.[itemId] || 0);
    if (stock > 0) sellers.push({ id: "town", stockUnits: stock });
  }
  if (options.households) {
    const excluded = householdIdOf(options.excludeBuyer);
    for (const household of Object.values(state.households?.byId || {})) {
      if (!household || household.id === excluded) continue;
      let stock = Math.max(0, household.inventory?.[itemId] || 0);
      if (options.keepFoodReserve && itemId === "wheat") {
        const reserveDays = content.rules.householdFoodReserveDays ?? 30;
        const dailyNeed = (household.population || 1) * (content.rules.foodPerPersonDay || 2) * content.precision.inventoryUnitsPerJin;
        stock = Math.max(0, stock - dailyNeed * reserveDays);
      }
      if (stock > 0) sellers.push({ id: `household:${household.id}`, stockUnits: stock });
    }
  }
  if (options.companies) {
    for (const company of Object.values(state.companies || {})) {
      const stock = company.inventory?.[itemId] || 0;
      if (stock > 0) sellers.push({ id: "company:" + company.id, stockUnits: stock });
    }
  }
  return sellers;
}

function rotated(list, offset) {
  if (!list.length) return list;
  const start = ((offset || 0) % list.length + list.length) % list.length;
  return list.slice(start).concat(list.slice(0, start));
}

// 把总量尽量平均地分给各卖家（每轮按剩余卖家数均分），从 start 位置开始轮换。
function fairAllocations(totalUnits, sellers, start) {
  let remaining = totalUnits;
  const allocations = new Map(sellers.map(row => [row.id, 0]));
  let active = rotated(sellers.slice(), start);
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.ceil(remaining / active.length));
    const next = [];
    let moved = 0;
    for (const seller of active) {
      if (remaining <= 0) break;
      const already = allocations.get(seller.id) || 0;
      const available = Math.max(0, seller.stockUnits - already);
      if (available <= 0) continue;
      const units = Math.min(available, share, remaining);
      allocations.set(seller.id, already + units);
      remaining -= units;
      moved += units;
      if (available > units) next.push(seller);
    }
    if (moved <= 0) break;
    active = next;
  }
  return allocations;
}

// 统一的直接采购入口：按卖家顺序（或公平轮换）买够 wanted，返回成交明细。
// options: price 单价；sellers 卖家列表（directSellers）；fair 是否轮换均摊（带 rotationKey 记住轮到谁）；
//          reason 账目说明；paymentType 付款记账类型；stopOnFailure 某卖家付款失败即停止。
// 买到的货不会自动入买方库存：镇库采购由本函数入库（buyer === "town"），其他买方由调用方入库。
export function buyDirect(state, buyer, itemId, wanted, content, options = {}) {
  const price = options.price;
  const sellerRows = [];
  let bought = 0;
  let paid = 0;
  if (!(price > 0) || wanted <= 0) return { ok: false, boughtUnits: 0, paidVoucherUnits: 0, sellerRows };
  const sellers = options.sellers || [];
  let order = sellers;
  let allocations = null;
  let rotation = 0;
  if (options.fair) {
    state.market ||= {};
    state.market.sellerRotation ||= {};
    rotation = state.market.sellerRotation[options.rotationKey] || 0;
    allocations = fairAllocations(wanted, sellers, rotation);
    order = rotated(sellers, rotation);
  }
  let deals = 0;
  for (const seller of order) {
    if (bought >= wanted) break;
    const planned = allocations ? (allocations.get(seller.id) || 0) : Math.min(seller.stockUnits, wanted - bought);
    const units = Math.min(planned, affordableUnits(state, buyer, price, content));
    if (units <= 0) continue;
    const sale = sellOnce(state, seller, buyer, itemId, units, price, content, options.reason, options.paymentType);
    if (!sale.ok) { if (options.stopOnFailure) break; continue; }
    if (buyer === "town") {
      state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + sale.units;
      addTownCostBasis(state, itemId, sale.paidVoucherUnits);
      recordLedger(state, { type: "public_material_purchase", transactionId: makeTransactionId(state),
        source: seller.id, destination: "town", itemId, quantityUnits: sale.units, qeqUnits: 0,
        reason: options.reason || "镇库采购" }, content);
    }
    sellerRows.push({ seller: seller.id, units: sale.units, quantityUnits: sale.units, paidVoucherUnits: sale.paidVoucherUnits });
    bought += sale.units;
    paid += sale.paidVoucherUnits;
    deals += 1;
  }
  if (options.fair && deals > 0 && sellers.length) state.market.sellerRotation[options.rotationKey] = (rotation + 1) % sellers.length;
  return { ok: bought > 0, boughtUnits: bought, paidVoucherUnits: paid, unitPrice: price, sellerRows };
}
