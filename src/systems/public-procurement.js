import { currencyScale } from "../economy/currency.js";
import { parseOwner } from "../economy/accounts.js";
import { currentPaymentComposition, maximumPayableValueUnits, settleMonetaryPayment } from "../economy/payment.js";
import { addTownCostBasis } from "../economy/business.js";
import { currentUnitPrice } from "../economy/prices.js";
import { makeTransactionId, recordLedger } from "../economy/ledger.js";
import { sellCompanyProduct } from "./companies.js";
import { householdList, syncResidentAggregates } from "./households.js";
import { hasWholesaleMarket, procureTownInputFromWholesale } from "./wholesale-market.js";


function paymentValueForQuantity(quantityUnits, price, content) {
  return Math.max(0, Math.round(quantityUnits / content.precision.inventoryUnitsPerJin * price * currencyScale(content)));
}

function affordableQuantityUnits(state, owner, limitUnits, price, content) {
  let low = 0;
  let high = Math.max(0, Math.floor(limitUnits));
  const availableValue = maximumPayableValueUnits(state, owner, content);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (paymentValueForQuantity(mid, price, content) <= availableValue) low = mid;
    else high = mid - 1;
  }
  return low;
}

function rotated(list, offset) {
  if (!list.length) return list;
  const start = ((offset || 0) % list.length + list.length) % list.length;
  return list.slice(start).concat(list.slice(0, start));
}

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

function sellersForTownMaterial(state, itemId) {
  const sellers = [];
  for (const household of householdList(state)) {
    const stock = household.inventory?.[itemId] || 0;
    if (stock > 0) sellers.push({ id: `household:${household.id}`, householdId: household.id, stockUnits: stock });
  }
  for (const company of Object.values(state.companies || {})) {
    if ((company.inventory?.[itemId] || 0) > 0) sellers.push({ id: "company:" + company.id, stockUnits: company.inventory[itemId] || 0 });
  }
  return sellers;
}

export function setPublicProcurementIntent(state, intent, content) {
  state.market ||= {};
  state.market.publicProcurementDemand ||= {};
  if (!intent) {
    delete state.market.publicProcurementDemand.wood;
    if (state.market.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
    return { ok: true, cleared: true };
  }
  let rows = [];
  let label = "公共建设";
  if (intent.kind === "build") {
    const definition = content.buildings[intent.typeId];
    if (!definition) return { ok: false, reason: "未知建设项目" };
    rows = definition.materialRequirements || [];
    label = definition.name + "建设";
  } else if (intent.kind === "upgrade") {
    const building = state.buildings.find(row => row.id === intent.buildingId);
    const definition = building ? content.buildings[building.typeId] : null;
    if (!definition?.upgrade) return { ok: false, reason: "未知升级项目" };
    rows = definition.upgrade.materialRequirements || [];
    label = definition.name + "升级";
  } else return { ok: false, reason: "未知采购意向" };
  const wood = rows.find(row => row.itemId === "wood");
  if (!wood) {
    delete state.market.publicProcurementDemand.wood;
    if (state.market.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
    return { ok: true, cleared: true };
  }
  const requiredUnits = Math.round(wood.quantity * content.precision.inventoryUnitsPerJin);
  const wantedUnits = Math.max(0, requiredUnits - (state.accounts.town.wood || 0));
  if (wantedUnits <= 0) {
    delete state.market.publicProcurementDemand.wood;
    if (state.market.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
    return { ok: true, cleared: true };
  }
  state.market.publicProcurementDemand.wood = {
    itemId: "wood",
    requiredUnits,
    wantedUnits,
    label,
    kind: intent.kind,
    typeId: intent.typeId || null,
    buildingId: intent.buildingId || null,
    createdYear: state.year,
    createdDay: Math.max(1, state.day + 1)
  };
  if (state.market.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  return { ok: true, demand: state.market.publicProcurementDemand.wood };
}

export function clearPublicProcurementIntent(state, itemId = "wood") {
  if (state.market?.publicProcurementDemand) delete state.market.publicProcurementDemand[itemId];
  if (state.market?.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  return { ok: true };
}

export function selectPublicProcurementDemand(state, itemId, content) {
  const demand = state.market?.publicProcurementDemand?.[itemId] || null;
  const price = currentUnitPrice(state, itemId, content);
  const wantedUnits = Math.max(0, Math.floor(demand?.wantedUnits || 0));
  if (!demand || wantedUnits <= 0) {
    return { active: false, wantedUnits: 0, fundedUnits: 0, priceVoucherPerUnit: price, reason: "暂无采购需求", label: null };
  }
  if (!Number.isFinite(price) || price <= 0) {
    return { active: true, wantedUnits, fundedUnits: 0, priceVoucherPerUnit: price, reason: "采购价格无效", label: demand.label };
  }
  const affordableUnits = affordableQuantityUnits(state, "town", wantedUnits, price, content);
  const fundedUnits = Math.min(wantedUnits, affordableUnits);
  return {
    active: true,
    wantedUnits,
    fundedUnits,
    affordableUnits,
    priceVoucherPerUnit: price,
    label: demand.label,
    reason: fundedUnits <= 0 ? "镇库可支付资产不足" : fundedUnits < wantedUnits ? "采购预算仅能覆盖部分需求" : "存在明确公共建设采购需求"
  };
}

// 批发市场库存只读（不改变 state）：镇营产出每日被扫入市场，建造时可免费领回
function wholesaleStockUnits(state, itemId) {
  if (!hasWholesaleMarket(state)) return 0;
  const market = state.wholesaleMarket;
  if (!market) return 0;
  return Math.max(0, Math.floor(market.inventory?.[itemId] || 0));
}

export function previewTownMaterialProcurement(state, itemId, wantedUnits, content) {
  const wanted = Math.max(0, Math.floor(Number(wantedUnits) || 0));
  const price = currentUnitPrice(state, itemId, content);
  const sellers = sellersForTownMaterial(state, itemId);
  const residentAvailableUnits = sellers.filter(row => parseOwner(row.id).kind === "household").reduce((sum, row) => sum + row.stockUnits, 0);
  const companyAvailableUnits = sellers.filter(row => parseOwner(row.id).kind === "company").reduce((sum, row) => sum + row.stockUnits, 0);
  const paidAvailableUnits = residentAvailableUnits + companyAvailableUnits;
  // 批发市场与镇库同属镇里，市场库存内部无偿领用。
  const wholesaleAvailableUnits = wholesaleStockUnits(state, itemId);
  const totalAvailableUnits = paidAvailableUnits + wholesaleAvailableUnits;
  if (wanted <= 0) return { wantedUnits: 0, residentAvailableUnits, companyAvailableUnits, wholesaleAvailableUnits, wholesaleUsableUnits: 0, totalAvailableUnits, purchasableUnits: 0, costVoucherUnits: 0, priceVoucherPerUnit: price, reason: "暂无采购需求" };
  if (!Number.isFinite(price) || price <= 0) return { wantedUnits: wanted, residentAvailableUnits, companyAvailableUnits, wholesaleAvailableUnits, wholesaleUsableUnits: 0, totalAvailableUnits, purchasableUnits: 0, costVoucherUnits: 0, priceVoucherPerUnit: price, reason: "采购价格无效" };
  const wholesaleUsableUnits = Math.min(wanted, wholesaleAvailableUnits);
  const paidWantedUnits = wanted - wholesaleUsableUnits;
  const affordableUnits = affordableQuantityUnits(state, "town", Math.min(paidWantedUnits, paidAvailableUnits), price, content);
  const paidPurchasableUnits = Math.min(paidWantedUnits, paidAvailableUnits, affordableUnits);
  const purchasableUnits = wholesaleUsableUnits + paidPurchasableUnits;
  return {
    wantedUnits: wanted,
    residentAvailableUnits,
    companyAvailableUnits,
    wholesaleAvailableUnits,
    wholesaleUsableUnits,
    totalAvailableUnits,
    affordableUnits,
    purchasableUnits,
    costVoucherUnits: paymentValueForQuantity(paidPurchasableUnits, price, content),
    priceVoucherPerUnit: price,
    reason: purchasableUnits >= wanted ? "可完整采购" : totalAvailableUnits < wanted ? "市场库存不足" : "镇库可支付资产不足"
  };
}

export function procureTownMaterial(state, itemId, wantedUnits, content) {
  const preview = previewTownMaterialProcurement(state, itemId, wantedUnits, content);
  if (preview.purchasableUnits <= 0) return { boughtUnits: 0, paidVoucherUnits: 0, missingUnits: preview.wantedUnits, reason: preview.reason, sellerRows: [] };
  const sellerRows = [];
  let bought = 0;
  let paid = 0;
  // 先从批发市场内部无偿领用
  const wholesaleWanted = Math.min(preview.wholesaleUsableUnits || 0, preview.purchasableUnits);
  if (wholesaleWanted > 0) {
    const issued = procureTownInputFromWholesale(state, itemId, wholesaleWanted, content,
      `镇营建造从批发市场领用${content.items[itemId]?.name || itemId}`);
    if (issued.ok && issued.boughtUnits > 0) {
      sellerRows.push({ seller: "wholesale_market", quantityUnits: issued.boughtUnits, paidVoucherUnits: issued.paidVoucherUnits || 0 });
      bought += issued.boughtUnits;
      paid += issued.paidVoucherUnits || 0;
    }
  }
  // 剩余部分走原有付费采购（家庭→公司轮换）
  const paidWanted = preview.purchasableUnits - bought;
  if (paidWanted > 0) {
    const sellers = sellersForTownMaterial(state, itemId);
    state.market.sellerRotation ||= {};
    const rotationKey = "town:" + itemId;
    const rotation = state.market.sellerRotation[rotationKey] || 0;
    const allocations = fairAllocations(paidWanted, sellers, rotation);
    let paidDeals = 0;
    for (const seller of rotated(sellers, rotation)) {
      const units = allocations.get(seller.id) || 0;
      if (units <= 0) continue;
      const cost = paymentValueForQuantity(units, preview.priceVoucherPerUnit, content);
      if (parseOwner(seller.id).kind === "household") {
        const household = state.households.byId[seller.householdId];
        const payment = settleMonetaryPayment(state, "town", seller.id, currentPaymentComposition(state, cost), content,
          "public_material_purchase", `镇库向${household.name}采购${content.items[itemId]?.name || itemId}`, { requireFull: true });
        if (!payment.ok) break;
        if ((household.inventory?.[itemId] || 0) < units) throw new Error("家庭材料库存预检后不足");
        household.inventory[itemId] -= units;
        state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + units;
        addTownCostBasis(state, itemId, cost);
        syncResidentAggregates(state, content);
        recordLedger(state, {
          type: "public_material_purchase", transactionId: payment.transactionId || makeTransactionId(state),
          source: seller.id, destination: "town", itemId, quantityUnits: units, qeqUnits: 0,
          reason: `${household.name}向镇库出售${content.items[itemId]?.name || itemId}`
        }, content);
      } else {
        const companyId = seller.id.slice(8);
        const sale = sellCompanyProduct(state, companyId, "town", itemId, units, preview.priceVoucherPerUnit, content,
          `镇库采购${content.items[itemId]?.name || itemId}用于公共建设`);
        if (!sale.ok) break;
        state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + sale.quantityUnits;
        addTownCostBasis(state, itemId, sale.revenueVoucherUnits);
      }
      sellerRows.push({ seller: seller.id, quantityUnits: units, paidVoucherUnits: cost });
      bought += units;
      paid += cost;
      paidDeals += 1;
    }
    if (paidDeals > 0 && sellers.length) state.market.sellerRotation[rotationKey] = (rotation + 1) % sellers.length;
  }
  return { boughtUnits: bought, paidVoucherUnits: paid, missingUnits: Math.max(0, preview.wantedUnits - bought), sellerRows };
}

// 开工前 fail-fast：聚合非木材材料行的镇库需求，缺口直接返回失败。
// 避免先采购木材、后因其他材料不足导致扣除失败时已采购无法回滚。
// 木材缺口走采购流程补足，此处跳过；同 itemId 多行按累计需求判断。
export function checkTownMaterialShortfall(state, materialLines, content) {
  const required = new Map();
  for (const line of materialLines || []) {
    if (line.itemId === "wood") continue;
    required.set(line.itemId, (required.get(line.itemId) || 0) + Math.max(0, line.quantityUnits || 0));
  }
  for (const [itemId, units] of required) {
    const available = state.accounts?.town?.[itemId] || 0;
    if (available < units) {
      const item = content.items[itemId];
      const missingJin = (units - available) / content.precision.inventoryUnitsPerJin;
      return {
        ok: false, itemId,
        reason: `镇库${item?.name || itemId}不足，还缺${missingJin.toLocaleString("zh-CN", { maximumFractionDigits: 3 })}${item?.name || itemId}`
      };
    }
  }
  return { ok: true };
}
