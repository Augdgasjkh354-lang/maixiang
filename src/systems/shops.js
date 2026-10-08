import { currencyScale, voucherBalance } from "../economy/currency.js";
import { householdIdOf } from "../economy/accounts.js";
import { PERIODS, bookAdd, bookAddMap, ensureBook } from "../economy/books.js";
import { addPaymentObligation, currentPaymentComposition, maximumFullyPayableValueUnits, maximumPayableValueUnits, normalizePaymentObligation, quoteMonetaryPayment, settleMonetaryPayment } from "../economy/payment.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { recordEvent } from "../economy/ledger.js";
import {
  householdConvertibleWheatUnits, householdList, householdPopulation, householdIdleWorkers, isActiveHousehold,
  syncResidentAggregates,
  setHouseholdJobCount, setJobCount, jobCount, jobAssignments
} from "./households.js";
import { shopTradePrices, recentAverage } from "../economy/operating-plan.js";
import { currentUnitPrice } from "../economy/prices.js";
import { accrueWages, payWages, wageArrears, wageBook } from "./employer.js";
import { buyWholesaleForOwner, hasWholesaleMarket } from "./wholesale-market.js";
import { computeLaborMarket, poachWorkers, adjustShopWage, shopWage } from "./labor-market.js";
import {
  ensureShopPricing, recordShopItemSale, recordShopDailyWageCost, recordPriceHistory,
  updateShopLossProtection, reviewShopPricing, selectShopPricingView, isDynamicPricingShop
} from "./shop-pricing.js";

function emptyShopInventory(content) {
  return Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
}

function blankShopPeriod() {
  return {
    revenueVoucherUnits: 0,
    cogsVoucherUnits: 0,
    wageExpenseVoucherUnits: 0,
    rentExpenseVoucherUnits: 0,
    taxExpenseVoucherUnits: 0,
    purchaseVoucherUnits: 0,
    soldUnits: {},
    // 断货时居民想买而店里没货的未满足需求（进货口径用，见 procureShopInventory）。
    stockoutUnits: {},
    purchasedUnits: {},
    serviceUses: {},
    customerCount: 0,
    rejectedCustomerCount: 0,
    profitVoucherUnits: 0,
    distributedVoucherUnits: 0
  };
}

function ensureShopBooks(shop, content = null) {
  ensureBook(shop.accounts ||= {}, blankShopPeriod);
  for (const period of PERIODS) {
    shop.accounts[period].soldUnits ||= {};
    shop.accounts[period].stockoutUnits ||= {};
    shop.accounts[period].purchasedUnits ||= {};
    shop.accounts[period].serviceUses ||= {};
    shop.accounts[period].customerCount ||= 0;
    shop.accounts[period].rejectedCustomerCount ||= 0;
  }
  shop.liabilities ||= { wageVoucherUnits: 0, rentVoucherUnits: 0, taxVoucherUnits: 0, claimsVoucherUnits: {} };
  shop.liabilities.claimsVoucherUnits ||= {};
  shop.inventoryCostVoucherUnits ||= {};
  shop.settlement ||= { days: 0, profitVoucherUnits: 0, lossCarryVoucherUnits: 0, lastTaxVoucherUnits: 0, lastSettlementYear: 0, lastSettlementDay: 0 };
  shop.retainedEarningsVoucherUnits ??= 0;
  shop.cashVoucherUnits ??= 0;
  shop.cashWheatUnits ??= 0;
  shop.history ||= [];
  shop.plan ||= { lastAdjustedSerial: -1 };
  shop.staffing ||= { clerkHiredSerials: [] };
  shop.staffing.clerkHiredSerials ||= [];
  // 0.2.3 动态加价：定价状态一律 ||= 补齐，旧档无需升版本。
  if (content) ensureShopPricing(shop, content);
  return shop;
}

export function ensureShops(state, content) {
  state.shops ||= {};
  state.nextShopNumber ||= 1;
  for (const shop of Object.values(state.shops)) {
    shop.inventory ||= emptyShopInventory(content);
    for (const itemId of Object.keys(content.items)) shop.inventory[itemId] ||= 0;
    const rawDef = content.rules.shopTypes?.[shop.typeId];
    const legacyItem = rawDef?.aliasOf ? rawDef.itemId : null;
    if (rawDef?.aliasOf) shop.typeId = rawDef.aliasOf;
    const def = content.rules.shopTypes?.[shop.typeId];
    shop.primaryItemId ||= shop.itemId || legacyItem || def?.itemIds?.[0] || null;
    shop.itemId = shop.primaryItemId; // 保留旧测试/旧界面的主商品兼容字段。
    shop.itemIds = def?.kind === "retail" ? [...(def.itemIds || [])] : [];
    shop.serviceId = def?.kind === "service" ? def.serviceId : null;
    ensureShopBooks(shop, content);
  }
  return state.shops;
}

export function addBookValue(shop, key, units) {
  bookAdd(shop.accounts, key, units);
}

export function addBookMap(shop, key, itemId, units) {
  bookAddMap(shop.accounts, key, itemId, units);
}

export function applyProfit(shop, delta) {
  bookAdd(shop.accounts, "profitVoucherUnits", delta);
  shop.settlement.profitVoucherUnits = (shop.settlement.profitVoucherUnits || 0) + delta;
  shop.retainedEarningsVoucherUnits = (shop.retainedEarningsVoucherUnits || 0) + delta;
}

export function shopDefinition(content, typeId) {
  const raw = content.rules.shopTypes?.[typeId] || null;
  if (!raw) return null;
  return raw.aliasOf ? content.rules.shopTypes?.[raw.aliasOf] || null : raw;
}

// 店里当前实际经营的商品：后加的商品（optionalRetail，如酒、布）镇上有货或店里有存货才算。
function activeRetailItemIds(state, shop, content) {
  return shopRetailItemIds(shop, content).filter(itemId => !content.items[itemId]?.optionalRetail
    || (state.wholesaleMarket?.inventory?.[itemId] || 0) > 0 || (state.accounts?.town?.[itemId] || 0) > 0 || (shop.inventory?.[itemId] || 0) > 0
    || (shopDefinition(content, shop.typeId)?.id === "general" && farmsHaveStock(state, itemId, content)));
}

function farmsHaveStock(state, itemId, content) {
  return Object.values(state.shops || {}).some(other => other.status === "open"
    && shopDefinition(content, other.typeId)?.kind === "farm" && (other.inventory?.[itemId] || 0) > 0);
}

export function shopRetailItemIds(shop, content) {
  const def = shopDefinition(content, shop?.typeId);
  if (def?.kind === "retail") return [...(def.itemIds || [])];
  // 摊位只卖日用品（rules.householdGoods），不卖主食。
  if (def?.kind === "stall") return Object.keys(content.rules.householdGoods || {}).filter(itemId => content.items[itemId]);
  return [];
}

export function shopKind(shop, content) {
  return shopDefinition(content, shop?.typeId)?.kind || null;
}

// 店铺所在的宿主建筑（商业街、养殖基地、时代广场）：建筑定义带 shopHost。
export function shopHostTypeId(def) {
  return def?.hostBuildingTypeId || "commercial_street";
}

export function shopHostSlots(building, content) {
  const perLevel = content?.buildings?.[building?.typeId]?.shopHost?.slotsPerLevel ?? 2;
  return Math.max(0, (building?.level || 1) * perLevel);
}

export function shopMaxMerchants(shop, content) {
  return shopDefinition(content, shop?.typeId)?.maxMerchants ?? content.rules.shopMaxMerchants ?? 4;
}

export function shopIsService(shop, content) {
  return shopDefinition(content, shop?.typeId)?.kind === "service";
}

function shopOccupiesStreet(shop) {
  return shop.status !== "closed" && shop.status !== "liquidating";
}

function merchantJobKey(shop) { return `shop:${shop.id}:merchant`; }
function clerkJobKey(shop) { return `shop:${shop.id}:clerk`; }

function shopMerchantCount(state, shop) { return jobCount(state, merchantJobKey(shop)); }

function shopMerchantOnDuty(state, shop) {
  const owner = state.households?.byId?.[shop.ownerHouseholdId];
  return Boolean(owner && isActiveHousehold(owner) && (owner.jobs?.[merchantJobKey(shop)] || 0) >= 1 && shopMerchantCount(state, shop) > 0);
}

function shopClerkCount(state, shop) { return jobCount(state, clerkJobKey(shop)); }

function shopSerial(state, content) {
  return (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
}

export function shopClerkLimit(shop, content) {
  const def = shopDefinition(content, shop?.typeId);
  if (Number.isFinite(def?.maxClerks)) return def.maxClerks;
  return def?.id === "general"
    ? (content.rules.generalStoreMaxClerks || 50)
    : (content.rules.shopMaxClerks || 20);
}

function syncClerkTenure(state, shop, content) {
  ensureShopBooks(shop, content);
  const current = shopClerkCount(state, shop);
  const serial = shopSerial(state, content);
  const matureFallback = serial - Math.max(0, content.rules.shopMinimumEmploymentDays || 30);
  while (shop.staffing.clerkHiredSerials.length < current) shop.staffing.clerkHiredSerials.push(matureFallback);
  if (shop.staffing.clerkHiredSerials.length > current) shop.staffing.clerkHiredSerials.length = current;
  return shop.staffing.clerkHiredSerials;
}

function protectedClerkCount(state, shop, content) {
  const serial = shopSerial(state, content);
  const minimum = Math.max(0, content.rules.shopMinimumEmploymentDays || 30);
  return syncClerkTenure(state, shop, content).filter(hired => serial - hired < minimum).length;
}

export function shopDailyCustomerCapacity(state, shop, content) {
  if (!shop || shop.status !== "open" || !shopMerchantOnDuty(state, shop)) return 0;
  const def = shopDefinition(content, shop.typeId);
  if (def?.kind === "farm") return 0;
  // 摊位按卖货量封顶，客流不另设限制。
  if (def?.kind === "stall") return shopMerchantCount(state, shop) * 1000;
  if (def?.id !== "general") {
    if (shopIsService(shop, content)) return serviceShopCapacityUses(state, shop, content);
    // 非综合商店零售店：按销售能力折算客流（商人60斤/店员120斤，每客2斤），避免恒0导致永远拒售。
    if (def?.kind === "retail") {
      const perCustomerJin = content.rules.foodPerPersonDay || 2;
      const merchants = shopMerchantCount(state, shop);
      const clerks = shopClerkCount(state, shop);
      const jin = merchants * (content.rules.shopMerchantSalesCapacityJin || 60) + clerks * (content.rules.shopClerkSalesCapacityJin || 120);
      return Math.max(0, Math.floor(jin / Math.max(1, perCustomerJin)));
    }
    return 0;
  }
  // 基线清理：商人也是员工，计入接待能力（之前只算店员，0 店员时客流为 0）。
  const clerks = shopClerkCount(state, shop);
  const merchants = shopMerchantCount(state, shop);
  const staff = clerks + merchants;
  return Math.min(content.rules.generalStoreMaxDailyCustomers || 1000, staff * (content.rules.generalStoreCustomersPerStaff || 20));
}

function releaseAllShopClerks(state, shop) {
  setJobCount(state, clerkJobKey(shop), 0, null);
}

export function shopsForStreet(state, buildingId) {
  return Object.values(state.shops || {}).filter(shop => shop.buildingId === buildingId && shopOccupiesStreet(shop));
}

export function streetShopCapacity(building, content = null) {
  return shopHostSlots(building, content);
}

export function syncShopEmployment(state, content) {
  ensureShops(state, content);
  for (const shop of Object.values(state.shops || {})) {
    if (shop.status === "closed" || shop.status === "liquidating") {
      setJobCount(state, merchantJobKey(shop), 0, null);
      releaseAllShopClerks(state, shop);
      continue;
    }
    const owner = state.households?.byId?.[shop.ownerHouseholdId];
    const ownerMerchantCount = owner?.jobs?.[merchantJobKey(shop)] || 0;
    if (!owner || !isActiveHousehold(owner) || ownerMerchantCount < 1) {
      if (owner && ownerMerchantCount > 0) setHouseholdJobCount(state, owner.id, merchantJobKey(shop), 0, null);
      releaseAllShopClerks(state, shop);
      shop.status = "paused";
      shop.statusReason = "商人缺位，店员已遣散";
    } else if (shop.status === "paused") {
      shop.status = "open";
      shop.statusReason = "准备营业";
    }
  }
  return state.shops;
}

function householdStartupReserveUnits(household, content) {
  const perPerson = content.rules.householdLiving?.difficultPerCapitaVoucher ?? 30;
  return Math.round(householdPopulation(household) * perPerson * currencyScale(content));
}

function shopStartupUnits(def, content) {
  return Math.round((def?.startupVoucher ?? content.rules.shopMerchantStartupVoucher ?? 120) * currencyScale(content));
}

function chooseMerchantHousehold(state, content, preferredId = null, startup = shopStartupUnits(null, content)) {
  const candidates = householdList(state).filter(household => {
    if (!isActiveHousehold(household) || householdIdleWorkers(household) <= 0) return false;
    const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
    const totalValue = voucherBalance(state, `household:${household.id}`) + voucherUnitsForWheatUnits(maxWheatUnits, content, "floor");
    if (totalValue < startup + householdStartupReserveUnits(household, content)) return false;
    return quoteMonetaryPayment(state, `household:${household.id}`, currentPaymentComposition(state, startup), content, { maxWheatUnits }).full;
  }).sort((a, b) => maximumPayableValueUnits(state, `household:${b.id}`, content) - maximumPayableValueUnits(state, `household:${a.id}`, content) || a.id.localeCompare(b.id));
  if (preferredId) return candidates.find(h => h.id === preferredId) || null;
  return candidates[0] || null;
}

export function openShop(state, buildingId, typeId, content, preferredHouseholdId = null) {
  ensureShops(state, content);
  const building = state.buildings.find(row => row.id === buildingId);
  const requestedDefinition = content.rules.shopTypes?.[typeId];
  const normalizedTypeId = requestedDefinition?.aliasOf || typeId;
  const definition = shopDefinition(content, normalizedTypeId);
  const hostTypeId = shopHostTypeId(definition);
  const hostName = content.buildings[hostTypeId]?.name || "商业街";
  if (!building || building.typeId !== hostTypeId) return { ok: false, reason: definition ? `请选择已建成的${hostName}` : "不支持这种店铺" };
  if (!definition) return { ok: false, reason: "不支持这种店铺" };
  const active = shopsForStreet(state, buildingId);
  if (active.length >= shopHostSlots(building, content)) return { ok: false, reason: `${hostName}没有空位` };
  const startupUnits = shopStartupUnits(definition, content);
  const household = chooseMerchantHousehold(state, content, preferredHouseholdId, startupUnits);
  if (!household) return { ok: false, reason: "没有同时满足生活储备、启动资金和空闲劳动力的家庭" };
  if (householdIdleWorkers(household) <= 0) return { ok: false, reason: "该家庭没有可开店的劳动力" };
  const shopId = `shop-${state.nextShopNumber++}`;
  const shop = {
    id: shopId,
    name: `${household.name}${definition.name}`,
    buildingId,
    typeId: normalizedTypeId,
    primaryItemId: requestedDefinition?.itemId || definition.itemIds?.[0] || null,
    itemId: requestedDefinition?.itemId || definition.itemIds?.[0] || null,
    itemIds: definition.kind === "retail" ? [...(definition.itemIds || [])] : [],
    serviceId: definition.kind === "service" ? definition.serviceId : null,
    ownerHouseholdId: household.id,
    cashVoucherUnits: 0,
    cashWheatUnits: 0,
    inventory: emptyShopInventory(content),
    inventoryCostVoucherUnits: {},
    status: "open",
    statusReason: "准备营业",
    openedYear: state.year,
    openedDay: state.day + 1,
    badDays: 0,
    accounts: { day: blankShopPeriod(), year: blankShopPeriod(), cumulative: blankShopPeriod() },
    liabilities: { wageVoucherUnits: 0, rentVoucherUnits: 0, taxVoucherUnits: 0 },
    settlement: { days: 0, profitVoucherUnits: 0, lossCarryVoucherUnits: 0, lastTaxVoucherUnits: 0, lastSettlementYear: 0, lastSettlementDay: 0 },
    retainedEarningsVoucherUnits: 0,
    initialCapital: { valueUnits: startupUnits, voucherValueUnits: 0, wheatValueUnits: 0 }
  };
  state.shops[shopId] = shop;
  const payment = settleMonetaryPayment(state, `household:${household.id}`, `shop:${shopId}`, currentPaymentComposition(state, startupUnits), content,
    "shop_capital", `${household.name}投入开店资金`,
    { requireFull: true, maxWheatUnits: householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30) });
  if (!payment.ok) { delete state.shops[shopId]; return payment; }
  shop.initialCapital.voucherValueUnits = payment.voucherPaidValueUnits || 0;
  shop.initialCapital.wheatValueUnits = payment.wheatPaidValueUnits || 0;
  const assignment = setHouseholdJobCount(state, household.id, `shop:${shopId}:merchant`, 1, content);
  if (!assignment.ok) {
    const refund = settleMonetaryPayment(state, `shop:${shopId}`, `household:${household.id}`, {
      valueUnits: startupUnits, voucherValueUnits: payment.voucherPaidValueUnits || 0, wheatValueUnits: payment.wheatPaidValueUnits || 0
    }, content, "shop_capital_refund", "开店失败退回资金", { requireFull: true });
    // 退款失败：镇库先行垫付给家庭。店铺即将删除，其负债记录会一并消失，
    // 故不在店上记账，直接由镇库承担并记为家庭对镇库的应收（持久化，不随店删除）。
    if (!refund.ok) {
      const due = {
        valueUnits: startupUnits,
        voucherValueUnits: payment.voucherPaidValueUnits || 0,
        wheatValueUnits: payment.wheatPaidValueUnits || 0
      };
      const advance = settleMonetaryPayment(state, "town", `household:${household.id}`, due, content,
        "shop_capital_refund_advance", `${shop.name}开店失败镇库垫付启动资金`,
        { requireFull: false });
      const paidAdvance = advance.paidValueUnits || 0;
      const remainingAdvance = Math.max(0, startupUnits - paidAdvance);
      if (remainingAdvance > 0) {
        // 镇库也付不出全额：记为家庭对镇库的持久应收，下次镇库有钱时优先偿付。
        household.townOwesVoucherUnits = (household.townOwesVoucherUnits || 0) + remainingAdvance;
        recordEvent(state, `${shop.name}开店失败，镇库垫付${Math.round(paidAdvance / content.precision.currencyUnitsPerVoucher)}券，剩余${Math.round(remainingAdvance / content.precision.currencyUnitsPerVoucher)}券记为家庭对镇库应收。`, content);
      } else {
        recordEvent(state, `${shop.name}开店失败，镇库垫付${Math.round(startupUnits / content.precision.currencyUnitsPerVoucher)}券启动资金给家庭。`, content);
      }
    }
    delete state.shops[shopId];
    // 回退店铺编号，避免出现空洞（之前只删店不回退编号）。
    state.nextShopNumber = Math.max(1, (state.nextShopNumber || 2) - 1);
    return assignment;
  }
  household.shopIds ||= [];
  household.shopIds.push(shopId);
  syncShopEmployment(state, content);
  if (definition.kind !== "stall") recordEvent(state, `${household.name}在${hostName}开出${definition.name}。`, content, { day: state.day + 1 });
  return { ok: true, shopId, householdId: household.id, startupVoucher: startupUnits / currencyScale(content) };
}

export function setShopMerchants(state, shopId, requested, content) {
  const shop = ensureShops(state, content)[shopId];
  if (!shop) return { ok: false, reason: "店铺不存在" };
  syncShopEmployment(state, content);
  if (shop.status !== "open") return { ok: false, reason: "店铺未营业" };
  const max = shopMaxMerchants(shop, content);
  const target = Math.max(1, Math.min(max, Math.floor(Number(requested) || 1)));
  const before = shopMerchantCount(state, shop);
  const result = setJobCount(state, merchantJobKey(shop), target, content, { type: "shop", id: shopId });
  if (!result.ok) {
    setJobCount(state, merchantJobKey(shop), before, content, { type: "shop", id: shopId });
    return { ok: false, reason: `还缺${Math.max(0, target - result.assigned)}名可用劳动力` };
  }
  const owner = state.households?.byId?.[shop.ownerHouseholdId];
  if (owner && (owner.jobs?.[merchantJobKey(shop)] || 0) < 1) {
    const holder = jobAssignments(state, merchantJobKey(shop)).find(row => row.householdId !== owner.id && row.count > 0);
    if (holder) setHouseholdJobCount(state, holder.householdId, merchantJobKey(shop), holder.count - 1, null);
    const restored = setHouseholdJobCount(state, owner.id, merchantJobKey(shop), 1, content);
    if (!restored.ok) {
      setJobCount(state, merchantJobKey(shop), before, content, { type: "shop", id: shopId });
      return { ok: false, reason: "业主必须保留至少1名商人岗位" };
    }
  }
  syncShopEmployment(state, content);
  return { ok: true, assigned: shopMerchantCount(state, shop) };
}

export function setShopClerks(state, shopId, requested, content) {
  const shop = ensureShops(state, content)[shopId];
  if (!shop) return { ok: false, reason: "店铺不存在" };
  syncShopEmployment(state, content);
  const max = shopClerkLimit(shop, content);
  let target = Math.max(0, Math.min(max, Math.floor(Number(requested) || 0)));
  if (shop.status !== "open") {
    if (shop.status === "paused" && target === 0) return { ok: true, assigned: 0, paused: true };
    return { ok: false, reason: shop.status === "paused" ? "商人缺位，店员已遣散" : "店铺未营业" };
  }
  const before = shopClerkCount(state, shop);
  const hired = syncClerkTenure(state, shop, content).slice();
  if (target < before) {
    const protectedCount = protectedClerkCount(state, shop, content);
    const minimumTarget = protectedCount;
    if (target < minimumTarget) return { ok: false, assigned: before, reason: `有${protectedCount}名店员工作未满${content.rules.shopMinimumEmploymentDays || 30}天，暂不能解雇` };
  }
  const result = setJobCount(state, clerkJobKey(shop), target, content, { type: "shop", id: shopId });
  if (!result.ok) {
    setJobCount(state, clerkJobKey(shop), before, content, { type: "shop", id: shopId });
    return { ok: false, reason: `还缺${Math.max(0, target - result.assigned)}名可用劳动力` };
  }
  const assigned = shopClerkCount(state, shop);
  if (assigned > before) {
    for (let i = 0; i < assigned - before; i += 1) hired.push(shopSerial(state, content));
  } else if (assigned < before) {
    const serial = shopSerial(state, content);
    const minimum = Math.max(0, content.rules.shopMinimumEmploymentDays || 30);
    const protectedHires = hired.filter(value => serial - value < minimum);
    const eligible = hired.filter(value => serial - value >= minimum);
    eligible.splice(0, Math.min(eligible.length, before - assigned));
    hired.length = 0; hired.push(...protectedHires, ...eligible);
  }
  shop.staffing.clerkHiredSerials = hired.slice(0, assigned);
  syncShopEmployment(state, content);
  return { ok: true, assigned: shopClerkCount(state, shop) };
}

export function shopSalesCapacityUnits(state, shop, content) {
  if (!shop || shop.status !== "open" || !shopMerchantOnDuty(state, shop) || shopIsService(shop, content)) return 0;
  const kind = shopKind(shop, content);
  if (kind === "farm") return 0;
  if (kind === "stall") {
    const def = shopDefinition(content, shop.typeId);
    const jin = Math.min(def.dailySalesCapJin ?? 50, shopMerchantCount(state, shop) * (def.perKeeperSalesJin ?? 30));
    return Math.round(jin * content.precision.inventoryUnitsPerJin);
  }
  if (shopDefinition(content, shop.typeId)?.id === "general") {
    const customers = shopDailyCustomerCapacity(state, shop, content);
    return Math.round(customers * (content.rules.foodPerPersonDay || 2) * content.precision.inventoryUnitsPerJin);
  }
  const clerkCount = shopClerkCount(state, shop);
  const merchantCount = shopMerchantCount(state, shop);
  const jin = merchantCount * (content.rules.shopMerchantSalesCapacityJin || 60) + clerkCount * (content.rules.shopClerkSalesCapacityJin || 120);
  return Math.round(jin * content.precision.inventoryUnitsPerJin);
}

export function serviceShopCapacityUses(state, shop, content) {
  if (!shop || shop.status !== "open" || !shopMerchantOnDuty(state, shop)) return 0;
  const def = shopDefinition(content, shop.typeId);
  if (def?.kind !== "service") return 0;
  const service = content.rules.serviceTypes?.[def.serviceId];
  if (!service) return 0;
  const merchantCapacity = service.employeeOnlyCapacity ? 0 : shopMerchantCount(state, shop) * (service.merchantCapacity || 0);
  const capacity = Math.max(0, Math.floor(merchantCapacity + shopClerkCount(state, shop) * (service.clerkCapacity || 0)));
  return Number.isFinite(service.maxCapacity) ? Math.min(Math.max(0, service.maxCapacity), capacity) : capacity;
}

function shopWorkingCapitalReserve(state, shop, content) {
  const days = content.rules.shopWorkingCapitalReserveDays || 7;
  const def = shopDefinition(content, shop.typeId);
  if (def?.kind === "service") {
    const service = content.rules.serviceTypes?.[def.serviceId];
    // 与零售店口径一致：全额日销能力×单价×天数（之前无故打25折）。
    return Math.round(serviceShopCapacityUses(state, shop, content) * (service?.priceVoucher || 0) * days * currencyScale(content));
  }
  if (def?.kind === "farm") {
    // 养殖场留足 7 天饲料钱和饲养员工资。
    const feedUnits = farmDailyFeedUnits(state, shop, content);
    const feedVoucher = feedUnits / content.precision.inventoryUnitsPerJin * currentUnitPrice(state, def.feedItemId, content);
    const wageVoucher = shopClerkCount(state, shop) * shopWage(state, shop, content);
    return Math.round((feedVoucher + wageVoucher) * days * currencyScale(content));
  }
  const itemIds = activeRetailItemIds(state, shop, content);
  if (!itemIds.length) return 0;
  const wholesalePrices = itemIds.map(itemId => shopTradePrices(state, shop.typeId, content, itemId)?.wholesaleVoucherPerUnit || 0).filter(p => p > 0);
  // 排除0价，避免无批发价商品拉低均值（之前简单平均含0）。
  const averageWholesale = wholesalePrices.length > 0 ? wholesalePrices.reduce((sum, p) => sum + p, 0) / wholesalePrices.length : 0;
  return Math.round(shopSalesCapacityUnits(state, shop, content) / content.precision.inventoryUnitsPerJin * averageWholesale * days * currencyScale(content));
}

function removeShopInventoryCost(shop, itemId, units) {
  const available = shop.inventory[itemId] || 0;
  const basis = shop.inventoryCostVoucherUnits[itemId] || 0;
  const cost = units === available ? basis : (available > 0 ? Math.floor(basis * units / available) : 0);
  shop.inventoryCostVoucherUnits[itemId] = Math.max(0, basis - cost);
  return cost;
}

export function sellShopProduct(state, shopId, buyerOwner, units, content, reason = "店铺零售", itemIdOverride = null) {
  const shop = ensureShops(state, content)[shopId];
  if (!shop || shop.status !== "open") return { ok: false, reason: shop?.status === "paused" ? "商人缺位，店铺已暂停" : "店铺未营业" };
  const itemIds = shopRetailItemIds(shop, content);
  const itemId = itemIdOverride || shop.primaryItemId || itemIds[0];
  if (!itemIds.includes(itemId)) return { ok: false, reason: "该店不经营这种商品" };
  const prices = shopTradePrices(state, shop.typeId, content, itemId, shop);
  const quantity = Math.min(Math.max(0, Math.floor(units)), shop.inventory[itemId] || 0);
  if (quantity <= 0) return { ok: false, reason: "店铺缺货" };
  const customerCapacity = shopDailyCustomerCapacity(state, shop, content);
  if ((shop.accounts.day.customerCount || 0) >= customerCapacity) {
    registerRejectedCustomers(state, shopId, 1, content);
    return { ok: false, reason: "今日客流接待能力已满" };
  }
  const soldToday = Object.values(shop.accounts.day.soldUnits || {}).reduce((sum, value) => sum + Math.max(0, value || 0), 0);
  const remainingGoodsCapacity = Math.max(0, shopSalesCapacityUnits(state, shop, content) - soldToday);
  const actual = Math.min(quantity, remainingGoodsCapacity);
  if (actual <= 0) return { ok: false, reason: "今日接待能力已满" };  const paymentUnits = Math.round(actual / content.precision.inventoryUnitsPerJin * prices.retailVoucherPerUnit * currencyScale(content));
  const buyerHouseholdId = householdIdOf(buyerOwner);
  const buyerHousehold = buyerHouseholdId ? state.households?.byId?.[buyerHouseholdId] : null;
  const maxWheatUnits = buyerHousehold ? householdConvertibleWheatUnits(state, buyerHousehold, content, content.rules.basicCommerceFoodReserveDays ?? 30) : undefined;
  const payment = settleMonetaryPayment(state, buyerOwner, `shop:${shopId}`, currentPaymentComposition(state, paymentUnits), content,
    "shop_retail_sale", reason, { requireFull: true, ...(maxWheatUnits === undefined ? {} : { maxWheatUnits }) });
  if (!payment.ok) return payment;
  const cogs = removeShopInventoryCost(shop, itemId, actual);
  shop.inventory[itemId] -= actual;
  addBookValue(shop, "revenueVoucherUnits", paymentUnits);
  addBookValue(shop, "cogsVoucherUnits", cogs);
  addBookMap(shop, "soldUnits", itemId, actual);
  bookAdd(shop.accounts, "customerCount", 1);
  applyProfit(shop, paymentUnits - cogs);
  // 0.2.3 动态加价：把这一笔成交记入按商品的利润率窗口（收入/进货成本/销量）。
  recordShopItemSale(shop, itemId, actual, paymentUnits, cogs, content);
  return { ok: true, itemId, quantityUnits: actual, paidVoucherUnits: paymentUnits, paidValueUnits: paymentUnits, cogsVoucherUnits: cogs, transactionId: payment.transactionId };
}

// 批量拒客计数（用户 0.1.11 原 i7）：把未满足的需求量（库存单位）折算成人次，
// 累加到日/年/累计三期 rejectedCustomerCount。
export function registerRejectedCustomers(state, shopId, units, content) {
  const shop = state.shops?.[shopId];
  if (!shop || shop.status !== "open" || !(units > 0)) return 0;
  const perCustomer = Math.max(1, (content.rules.foodPerPersonDay || 2) * content.precision.inventoryUnitsPerJin);
  const count = Math.ceil(units / perCustomer);
  bookAdd(shop.accounts, "rejectedCustomerCount", count);
  return count;
}

// 断货的未满足需求：居民想买、该店却已无货时记入当日口径，次日进货据此放量（不影响当日销量与收入）。
// 同时计为拒客（店铺增员的需求依据）；单店当日记入量不超过其日接待能力，超出部分不是可实现的需求。
export function registerShopStockoutDemand(state, shopId, itemId, units, content) {
  const shop = state.shops?.[shopId];
  if (!shop || shop.status !== "open" || !(units > 0)) return 0;
  ensureShopBooks(shop, content);
  const count = Math.min(Math.floor(units), shopSalesCapacityUnits(state, shop, content));
  if (count <= 0) return 0;
  bookAddMap(shop.accounts, "stockoutUnits", itemId, count);
  registerRejectedCustomers(state, shopId, count, content);
  return count;
}

export function recordShopServiceSale(state, shopId, householdId, serviceId, content) {
  const shop = ensureShops(state, content)[shopId];
  const def = shopDefinition(content, shop?.typeId);
  if (!shop || shop.status !== "open" || def?.kind !== "service" || def.serviceId !== serviceId) return { ok: false, reason: "服务店当前不可用" };
  const service = content.rules.serviceTypes?.[serviceId];
  if (!service) return { ok: false, reason: "服务配置不存在" };
  const used = shop.accounts.day.serviceUses?.[serviceId] || 0;
  if (used >= serviceShopCapacityUses(state, shop, content)) return { ok: false, reason: "今日接待能力已满" };
  const household = state.households?.byId?.[householdId];
  if (!household || !isActiveHousehold(household)) return { ok: false, reason: "家庭不存在" };
  const configuredPrice = state.services?.pricesVoucherPerUse?.[serviceId];
  const priceUnits = Math.round(Math.max(0, Number.isFinite(configuredPrice) ? configuredPrice : (service.priceVoucher || 0)) * currencyScale(content));
  const consumables = service.consumables || [];
  for (const row of consumables) {
    const need = Math.round(Math.max(0, row.quantity || 0) * content.precision.inventoryUnitsPerJin);
    if ((shop.inventory?.[row.itemId] || 0) < need) return { ok: false, reason: `缺${content.items[row.itemId]?.name || row.itemId}` };
  }
  const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
  const payment = settleMonetaryPayment(state, `household:${householdId}`, `shop:${shopId}`, currentPaymentComposition(state, priceUnits), content,
    "shop_service_sale", `${household.name}购买${service.name}`, { requireFull: true, maxWheatUnits });
  if (!payment.ok) return payment;
  let cogs = 0;
  for (const row of consumables) {
    const need = Math.round(Math.max(0, row.quantity || 0) * content.precision.inventoryUnitsPerJin);
    cogs += removeShopInventoryCost(shop, row.itemId, need);
    shop.inventory[row.itemId] -= need;
    addBookMap(shop, "soldUnits", row.itemId, need);
  }
  addBookValue(shop, "revenueVoucherUnits", priceUnits);
  addBookValue(shop, "cogsVoucherUnits", cogs);
  addBookMap(shop, "serviceUses", serviceId, 1);
  bookAdd(shop.accounts, "customerCount", 1);
  applyProfit(shop, priceUnits - cogs);
  return { ok: true, paidValueUnits: priceUnits, cogsVoucherUnits: cogs, transactionId: payment.transactionId };
}

export function procureShopInventory(state, shop, content) {
  if (shop.status !== "open") return { purchasedUnits: 0, purchasedByItem: {}, reason: shop.status === "paused" ? "暂停经营" : "已停业" };
  const invScale = content.precision.inventoryUnitsPerJin;
  const def = shopDefinition(content, shop.typeId);
  let itemTargets = [];
  if (def?.kind === "farm") {
    // 养殖场：备 2 天饲料。
    itemTargets.push({ itemId: def.feedItemId, targetUnits: farmDailyFeedUnits(state, shop, content) * 2 });
  } else if (def?.kind === "retail" || def?.kind === "stall") {
    const itemIds = activeRetailItemIds(state, shop, content);
    const capacity = shopSalesCapacityUnits(state, shop, content);
    const history = shop.history || [];
    const observation = Math.max(1, content.rules.operatingObservationDays || 7);
    const window = history.slice(-observation);
    const targetDays = Math.max(1, content.rules.shopInventoryTargetDays || 2);
    for (const itemId of itemIds) {
      // 进货口径 = 实际售出 + 断货时居民想买而没买到的未满足需求（否则断货会把目标压低，形成爬坡）。
      const demandOf = row => Math.max(0, row.soldUnitsByItem?.[itemId] || 0) + Math.max(0, row.stockoutUnitsByItem?.[itemId] || 0);
      const avgItemSales = window.length ? window.reduce((sum, row) => sum + demandOf(row), 0) / window.length : 0;
      const hasItemSalesHistory = history.some(row => Math.max(0, row.soldUnitsByItem?.[itemId] || 0) > 0);
      // 试进货按商品独立判断：某商品开店首日缺货时，不能因为别的商品已有营业历史就永久放弃补货。
      // 基线清理：客容量为 0（如无店员）时给保底试进货（20 斤），否则商店空转永不进货。
      const capacityTrial = Math.floor(capacity / Math.max(1, itemIds.length) * 0.5);
      const trial = hasItemSalesHistory ? 0 : (capacityTrial > 0 ? capacityTrial : 20 * invScale);
      const expected = Math.max(avgItemSales, trial);
      itemTargets.push({ itemId, targetUnits: Math.max(trial, Math.round(expected * targetDays)) });
    }
    // 摊位只进少量货：所有商品合计不超过 2 天的卖货上限。
    if (def?.kind === "stall") {
      const cap = capacity * targetDays;
      const total = itemTargets.reduce((sum, row) => sum + row.targetUnits, 0);
      if (total > cap) for (const row of itemTargets) row.targetUnits = Math.floor(row.targetUnits * cap / total);
    }
  } else if (def?.kind === "service") {
    const service = content.rules.serviceTypes?.[def.serviceId];
    for (const row of service?.consumables || []) {
      itemTargets.push({ itemId: row.itemId, targetUnits: Math.round(serviceShopCapacityUses(state, shop, content) * Math.max(0, row.quantity || 0) * invScale) });
    }
  }
  if (!itemTargets.length) return { purchasedUnits: 0, purchasedByItem: {}, reason: def?.kind === "service" ? "服务无需原料" : "无经营商品" };
  const purchasedByItem = {};
  let purchasedTotal = 0;
  let hadNeed = false;
  for (const row of itemTargets) {
    const need = Math.max(0, row.targetUnits - (shop.inventory[row.itemId] || 0));
    if (need <= 0) { purchasedByItem[row.itemId] = 0; continue; }
    hadNeed = true;
    // 综合商店先从养殖场进肉，不够再找批发市场。
    const fromFarms = def?.id === "general" && content.items[row.itemId]?.livestock ? buyFromFarms(state, shop, row.itemId, need, content) : 0;
    const purchase = need - fromFarms > 0
      ? buyWholesaleForOwner(state, `shop:${shop.id}`, row.itemId, need - fromFarms, content, `${shop.name}从批发市场进货`)
      : { boughtUnits: 0, paidVoucherUnits: 0 };
    const bought = (purchase.boughtUnits || 0) + fromFarms;
    const wholesaleBought = purchase.boughtUnits || 0;
    if (wholesaleBought > 0) {
      shop.inventory[row.itemId] = (shop.inventory[row.itemId] || 0) + wholesaleBought;
      shop.inventoryCostVoucherUnits[row.itemId] = (shop.inventoryCostVoucherUnits[row.itemId] || 0) + (purchase.paidVoucherUnits || 0);
      addBookValue(shop, "purchaseVoucherUnits", purchase.paidVoucherUnits || 0);
      addBookMap(shop, "purchasedUnits", row.itemId, wholesaleBought);
    }
    purchasedByItem[row.itemId] = bought;
    purchasedTotal += bought;
  }
  if (hadNeed && purchasedTotal <= 0) {
    // 基线清理：无批发市场时走镇库直购，缺货提示要准确。
    shop.statusReason = maximumPayableValueUnits(state, `shop:${shop.id}`, content) <= 0 ? "缺资金" : (hasWholesaleMarket(state) ? "批发市场缺货" : "镇库缺货");
  }
  return { purchasedUnits: purchasedTotal, purchasedByItem, reason: !hadNeed ? "库存充足" : (purchasedTotal > 0 ? "已补货" : shop.statusReason) };
}

function accrueDailyLiabilities(state, shop, content) {
  wageBook(shop.liabilities);
  const scale = currencyScale(content);
  const merchantRate = state.employment.wageRates?.merchants ?? content.rules.shopMerchantDefaultWageVoucher ?? 10;
  // 店员日薪走动态劳动力市场：商店按行情自行调薪（shop.clerkWageVoucher），缺省回落到统一定薪。
  const clerkRate = shopWage(state, shop, content);
  const merchantAssignments = jobAssignments(state, merchantJobKey(shop));
  const clerkAssignments = jobAssignments(state, clerkJobKey(shop));
  // 基线清理：店主本人兼任商人不领固定工资，拿利润而非工资；只有外聘商人才领工资。
  const ownerId = shop.ownerHouseholdId;
  const merchantWage = Math.round(merchantAssignments
    .filter(row => row.householdId !== ownerId)
    .reduce((sum, row) => sum + row.count, 0) * merchantRate * scale);
  const clerkWage = Math.round(clerkAssignments.reduce((sum, row) => sum + row.count, 0) * clerkRate * scale);
  const wage = merchantWage + clerkWage;
  // 负值保护：租金/工资取max(0)，避免负负债（之前无保护）。
  const rentVoucher = shopKind(shop, content) === "stall"
    ? (state.policy?.stallRentVoucher ?? content.rules.stallRentDefaultVoucher ?? 2)
    : (state.policy?.shopRentVoucher ?? content.rules.shopRentDefaultVoucher ?? 1);
  const rent = Math.max(0, Math.round(rentVoucher * scale));
  // 基线清理：店主本人的商人岗位不产生工资债权（拿利润）。
  accrueWages(state, shop.liabilities, merchantAssignments.filter(row => row.householdId !== shop.ownerHouseholdId), merchantWage, content);
  accrueWages(state, shop.liabilities, clerkAssignments, clerkWage, content);
  shop.liabilities.wageVoucherUnits = wageArrears(shop.liabilities);
  shop.liabilities.rentVoucherUnits += rent;
  shop.liabilities.rentPaymentClaim = addPaymentObligation(shop.liabilities.rentPaymentClaim, currentPaymentComposition(state, rent));
  addBookValue(shop, "wageExpenseVoucherUnits", wage);
  addBookValue(shop, "rentExpenseVoucherUnits", rent);
  applyProfit(shop, -(wage + rent));
  // 0.2.3 动态加价：店员工资计入按商品的利润率口径（商人工资是业主劳动报酬，不计入）。
  recordShopDailyWageCost(shop, clerkWage, content);
  return { wage, rent };
}

function payLiability(state, shop, key, destination, content, type, reason) {
  const due = shop.liabilities[key] || 0;
  if (due <= 0) return 0;
  const paymentKey = key === "rentVoucherUnits" ? "rentPaymentClaim" : "taxPaymentClaim";
  const obligation = normalizePaymentObligation(shop.liabilities[paymentKey] || due, state);
  const result = settleMonetaryPayment(state, `shop:${shop.id}`, destination, obligation, content, type, reason,
    { requireFull: false });
  const paid = result.paidValueUnits || 0;
  shop.liabilities[key] = Math.max(0, due - paid);
  shop.liabilities[paymentKey] = result.remainingComposition;
  return paid;
}

function payDailyLiabilities(state, shop, content) {
  payWages(state, shop.liabilities, `shop:${shop.id}`, content, "shop_wage_payment", `${shop.name}偿付具体债权家庭员工工资`);
  shop.liabilities.wageVoucherUnits = wageArrears(shop.liabilities);
  payLiability(state, shop, "rentVoucherUnits", "town", content, "shop_rent_payment", `${shop.name}支付店租`);
  payLiability(state, shop, "taxVoucherUnits", "town", content, "shop_profit_tax_payment", `${shop.name}缴纳商业利润税`);
}

export function settleShopTaxAndDistribution(state, shop, content, force = false, options = {}) {
  const interval = content.rules.shopSettlementDays || 30;
  if (!force && shop.settlement.days < interval) return { settled: false };
  const periodProfit = shop.settlement.profitVoucherUnits || 0;
  const net = periodProfit + (shop.settlement.lossCarryVoucherUnits || 0);
  let tax = 0;
  if (net > 0) {
    tax = Math.floor(net * Math.max(0, Math.min(content.rules.shopProfitTaxMaximumPercent || 80,
      state.policy?.shopProfitTaxPercent ?? content.rules.shopProfitTaxDefaultPercent ?? 10)) / 100);
    shop.settlement.lossCarryVoucherUnits = 0;
  } else {
    shop.settlement.lossCarryVoucherUnits = net;
  }
  if (tax > 0) {
    shop.liabilities.taxVoucherUnits += tax;
    shop.liabilities.taxPaymentClaim = addPaymentObligation(shop.liabilities.taxPaymentClaim, currentPaymentComposition(state, tax));
    addBookValue(shop, "taxExpenseVoucherUnits", tax);
    applyProfit(shop, -tax);
  }
  shop.settlement.lastTaxVoucherUnits = tax;
  shop.settlement.lastSettlementYear = state.year;
  shop.settlement.lastSettlementDay = state.day + 1;
  shop.settlement.days = 0;
  shop.settlement.profitVoucherUnits = 0;
  payDailyLiabilities(state, shop, content);
  const reserve = options.allowDistribution === false ? 0 : shopWorkingCapitalReserve(state, shop, content);
  const liabilities = (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0) + (shop.liabilities.taxVoucherUnits || 0);
  const availableCash = options.allowDistribution === false ? 0 : Math.max(0, maximumPayableValueUnits(state, `shop:${shop.id}`, content) - reserve - liabilities);
  const distributable = options.allowDistribution === false ? 0 : maximumFullyPayableValueUnits(state, `shop:${shop.id}`,
    Math.min(Math.max(0, shop.retainedEarningsVoucherUnits || 0), availableCash), content);
  let distributed = 0;
  if (distributable > 0) {
    const result = settleMonetaryPayment(state, `shop:${shop.id}`, `household:${shop.ownerHouseholdId}`, currentPaymentComposition(state, distributable), content,
      "shop_profit_distribution", `${shop.name}向商人家庭分配利润`, { requireFull: true });
    if (result.ok) {
      distributed = distributable;
      shop.retainedEarningsVoucherUnits -= distributed;
      addBookValue(shop, "distributedVoucherUnits", distributed);
    }
  }
  return { settled: true, periodProfitVoucherUnits: periodProfit, taxVoucherUnits: tax,
    lossCarryVoucherUnits: shop.settlement.lossCarryVoucherUnits, distributedVoucherUnits: distributed,
    retainedEarningsVoucherUnits: shop.retainedEarningsVoucherUnits, reserveVoucherUnits: reserve };
}

function archiveShopDay(state, shop, content) {
  const serial = (state.year - 1) * (content.rules.daysPerYear || 365) + state.day;
  if (serial <= 0 || shop.plan?.lastArchivedSerial === serial) return;
  const soldUnitsByItem = { ...(shop.accounts?.day?.soldUnits || {}) };
  const soldUnits = Object.values(soldUnitsByItem).reduce((sum, units) => sum + Math.max(0, units || 0), 0);
  const serviceUses = { ...(shop.accounts?.day?.serviceUses || {}) };
  const stockoutUnitsByItem = { ...(shop.accounts?.day?.stockoutUnits || {}) };
  const unmetUnitsByItem = { ...(shop.accounts?.day?.unmetUnits || {}) };
  const storeSoldUnitsByItem = { ...(shop.accounts?.day?.storeSoldUnits || {}) };
  const row = { serial, soldUnits, soldUnitsByItem, stockoutUnitsByItem, unmetUnitsByItem, storeSoldUnitsByItem, serviceUses,
    customerCount: shop.accounts?.day?.customerCount || 0,
    rejectedCustomerCount: shop.accounts?.day?.rejectedCustomerCount || 0,
    revenueVoucherUnits: shop.accounts?.day?.revenueVoucherUnits || 0,
    profitVoucherUnits: shop.accounts?.day?.profitVoucherUnits || 0 };
  shop.history ||= [];
  shop.history.push(row);
  const limit = Math.max(14, (content.rules.operatingObservationDays || 7) * 4);
  if (shop.history.length > limit) shop.history.splice(0, shop.history.length - limit);
  shop.plan ||= {};
  shop.plan.lastArchivedSerial = serial;
  // 0.2.3 动态加价：日终把当日定价窗口归档进 30 天价格历史，再跑亏损保护与 7 天复核。
  if (isDynamicPricingShop(shop, content)) {
    ensureShopPricing(shop, content);
    shop.pricing.lastWindowSerial = serial;
    recordPriceHistory(shop, content);
    updateShopLossProtection(state, shop, content, row.profitVoucherUnits);
    reviewShopPricing(state, shop, content);
  }
}

export function resetShopDaily(state, content) {
  ensureShops(state, content);
  for (const shop of Object.values(state.shops)) if (shop.status === "open" || shop.status === "paused") {
    archiveShopDay(state, shop, content);
    shop.accounts.day = blankShopPeriod();
  }
}

// 按销量加权的批发价均值（粮券/斤），无销量时取经营品类简单均值（用户 0.1.11 原 T2）。
function averageWholesalePriceJin(state, shop, content, history) {
  let value = 0;
  let units = 0;
  for (const row of history || []) {
    for (const [itemId, sold] of Object.entries(row.soldUnitsByItem || {})) {
      if (!(sold > 0)) continue;
      const price = currentUnitPrice(state, itemId, content);
      if (!(price > 0)) continue;
      value += sold * price;
      units += sold;
    }
  }
  if (units > 0) return value / units;
  const prices = activeRetailItemIds(state, shop, content)
    .map(itemId => currentUnitPrice(state, itemId, content))
    .filter(price => price > 0);
  return prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : 0;
}

function autoAdjustShopClerks(state, shop, content) {
  const serial = (state.year - 1) * (content.rules.daysPerYear || 365) + state.day;
  const interval = Math.max(1, content.rules.operatingPlanIntervalDays || 3);
  shop.plan ||= { lastAdjustedSerial: -1 };
  if (shop.plan.lastAdjustedSerial >= 0 && serial - shop.plan.lastAdjustedSerial < interval) return;
  shop.plan.lastAdjustedSerial = serial;
  const kind = shopKind(shop, content);
  if (kind === "stall") return;
  const observation = Math.max(1, content.rules.operatingObservationDays || 7);
  const history = (shop.history || []).slice(-observation);
  const current = shopClerkCount(state, shop);
  const wage = state.employment.wageRates?.shop_clerks ?? content.rules.shopClerkDefaultWageVoucher ?? 10;
  let target = current;
  let expected = 0;
  if (kind === "farm") {
    target = farmTargetHands(state, shop, content, history);
  } else if (shopIsService(shop, content)) {
    const def = shopDefinition(content, shop.typeId);
    const service = content.rules.serviceTypes?.[def?.serviceId];
    if (!service) return;
    const recent = history.length ? history.reduce((sum, row) => sum + Math.max(0, row.serviceUses?.[def.serviceId] || 0), 0) / history.length : 0;
    const serviceRows = [...(state.services?.history || []).slice(-observation), state.services?.day || {}];
    const capacityUnmet = serviceRows.reduce((sum, row) => sum + Math.max(0, row.capacityUnmetUses?.[def.serviceId] || 0), 0) / Math.max(1, serviceRows.length);
    const unaffordable = serviceRows.reduce((sum, row) => sum + Math.max(0, row.unaffordableUses?.[def.serviceId] || 0), 0) / Math.max(1, serviceRows.length);
    const sameTypeShops = Math.max(1, Object.values(state.shops || {}).filter(other => other.status === "open" && shopDefinition(content, other.typeId)?.serviceId === def.serviceId).length);
    expected = recent + capacityUnmet / sameTypeShops;
    const merchantCapacity = service.employeeOnlyCapacity ? 0 : Math.max(0, service.merchantCapacity || 0) * shopMerchantCount(state, shop);
    const clerkCapacity = Math.max(1, service.clerkCapacity || 1);
    const currentCapacity = merchantCapacity + current * clerkCapacity;
    const configuredServicePrice = state.services?.pricesVoucherPerUse?.[def.serviceId];
    const extraRevenue = clerkCapacity * Math.max(0, Number.isFinite(configuredServicePrice) ? configuredServicePrice : (service.priceVoucher || 0));
    shop.plan.staffingDiagnosis = capacityUnmet > 0
      ? (extraRevenue > wage ? "容量不足，可增员" : "增员后不盈利")
      : (unaffordable > 0 ? "居民支付不起" : "需求不足");
    // 只把真实成交与“有支付能力但容量不足”的需求用于扩招，不把支付不起形成的积压当作需求。
    if (history.length >= observation) {
      if (extraRevenue > wage && capacityUnmet > 0 && expected > currentCapacity * (content.rules.shopClerkUtilizationHireThreshold || 0.85)) target = current + 1;
      const withoutLast = Math.max(merchantCapacity, currentCapacity - clerkCapacity);
      if (current > 0 && capacityUnmet <= 0 && expected < withoutLast * (content.rules.shopClerkUtilizationReleaseThreshold || 0.45)) target = current - 1;
    }
    shop.plan.expectedDailyServiceUses = expected;
  } else {
    const itemIds = shopRetailItemIds(shop, content);
    if (!itemIds.length) return;
    const avgSalesUnits = history.length ? history.reduce((sum, row) => sum + Math.max(0, row.soldUnits || 0), 0) / history.length : 0;
    const avgCustomers = history.length ? history.reduce((sum, row) => sum + Math.max(0, row.customerCount || 0), 0) / history.length : 0;
    const avgRejected = history.length ? history.reduce((sum, row) => sum + Math.max(0, row.rejectedCustomerCount || 0), 0) / history.length : 0;
    expected = avgCustomers + avgRejected;
    if (shopDefinition(content, shop.typeId)?.id === "general") {
      const perStaff = Math.max(1, content.rules.generalStoreCustomersPerStaff || 20);
      const maxCustomers = content.rules.generalStoreMaxDailyCustomers || 1000;
      const merchants = shopMerchantCount(state, shop);
      // 期望店员数：商人也算接待力（用户 0.1.11）。
      const desiredClerks = Math.max(0, Math.ceil(Math.min(maxCustomers, expected) / perStaff) - merchants);
      // 增员经济性（用户 0.1.11）：增1店员的日增量毛利 b vs 店员日薪；资金 u 是否够备货+3天工资。
      const wage = shopWage(state, shop, content);
      const avgWholesale = averageWholesalePriceJin(state, shop, content, history);
      const markup = (content.rules.generalStoreMarkupPercent ?? 20) / 100;
      const marginalJin = perStaff * (content.rules.foodPerPersonDay || 2);
      const marginalProfit = marginalJin * avgWholesale * markup;
      const profitable = marginalProfit > wage;
      const scale = currencyScale(content);
      const fundsVoucher = maximumPayableValueUnits(state, `shop:${shop.id}`, content) / scale;
      const merchantWage = state.employment?.wageRates?.merchants ?? content.rules.shopMerchantDefaultWageVoucher ?? 10;
      const headsAfter = current + 1 + merchants;
      // 店主商人不领工资，只算非店主商人（之前含店主，高估3天工资需求）。
      const nonOwnerMerchants = Math.max(0, merchants - (shop.ownerHouseholdId ? 1 : 0));
      const wageAfter = (current + 1) * wage + nonOwnerMerchants * merchantWage;
      const funded = fundsVoucher >= headsAfter * marginalJin * avgWholesale + wageAfter * 3;
      if (history.length >= observation && avgRejected > 0 && desiredClerks > current && profitable && funded) {
        target = Math.min(current + 1, desiredClerks);
      }
      if (history.length >= observation && current > 0 && avgRejected <= 0 && desiredClerks < current) target = current - 1;
      shop.plan.expectedDailyCustomers = expected;
      shop.plan.staffingDiagnosis = avgRejected > 0
        ? (!profitable ? "客流超载，但增员不盈利" : !funded ? "客流超载，资金不足暂不增员" : "客流超载，可增员")
        : (desiredClerks < current ? "客流下降，满30日后可减员" : "客流与用工匹配");
    } else {
      shop.plan.expectedDailySalesUnits = avgSalesUnits;
    }
  }
  target = Math.max(protectedClerkCount(state, shop, content), Math.min(shopClerkLimit(shop, content), target));
  if (target !== current) setShopClerks(state, shop.id, target, content);
  shop.plan.targetClerks = target;
  // 动态劳动力市场（用户 0.1.11）：人手紧时从低薪岗位挖人，随后按行情调工资。
  const market = computeLaborMarket(state, content);
  const hired = shopClerkCount(state, shop);
  if (target > hired && market.mood === "tight") {
    const poached = poachWorkers(state, shopWage(state, shop, content), target - hired, content, {
      toKey: clerkJobKey(shop),
      toLabel: shop.name,
      excludeKeys: [merchantJobKey(shop)]
    });
    if (poached > 0) setShopClerks(state, shop.id, target, content);
  }
  adjustShopWage(state, shop, content, market);
}

// ---------------------------------------------------------------- 养殖场（kind: "farm"）

// 在场劳力：养殖户（商人）和饲养员都干活。
export function farmWorkers(state, shop) {
  return shopMerchantCount(state, shop) + shopClerkCount(state, shop);
}

export function farmDailyOutputUnits(state, shop, content) {
  const def = shopDefinition(content, shop?.typeId);
  if (def?.kind !== "farm" || shop.status !== "open" || !shopMerchantOnDuty(state, shop)) return 0;
  return Math.floor(farmWorkers(state, shop) * def.outputPerWorkerDay * content.precision.inventoryUnitsPerJin);
}

export function farmDailyFeedUnits(state, shop, content) {
  const def = shopDefinition(content, shop?.typeId);
  return def?.kind === "farm" ? Math.ceil(farmDailyOutputUnits(state, shop, content) * def.feedPerUnit) : 0;
}

// 饲养员目标：按近期卖出量排产；存货不足 1 天就加人，超过 4 天就减人（每周期最多 ±2 / −1）。
function farmTargetHands(state, shop, content, history) {
  const def = shopDefinition(content, shop.typeId);
  const current = shopClerkCount(state, shop);
  const merchants = shopMerchantCount(state, shop);
  const perWorker = def.outputPerWorkerDay * content.precision.inventoryUnitsPerJin;
  // 只看卖给商店的量：卖给批发市场的是处理积压，不算需求。
  const avgSold = history.length ? history.reduce((sum, row) => sum + Math.max(0, row.storeSoldUnitsByItem?.[def.productItemId] || 0), 0) / history.length : 0;
  const avgUnmet = history.length ? history.reduce((sum, row) => sum + Math.max(0, row.unmetUnitsByItem?.[def.productItemId] || 0), 0) / history.length : 0;
  const stock = shop.inventory?.[def.productItemId] || 0;
  // 按比例排产：目标日产 = 商店日均进货 + 一半缺口 + 存货差（目标 2 天销量）分 5 天补；差 10% 以内不动，每周期最多 +2 / −1。
  const stockGap = avgSold * 2 - stock;
  const desiredOutput = Math.max(0, avgSold + avgUnmet * 0.5 + stockGap / Math.max(1, content.rules.operatingStockCorrectionDays || 5));
  const desiredHands = Math.max(0, Math.ceil(desiredOutput / perWorker) - merchants);
  let target = current;
  const output = (merchants + current) * perWorker;
  if (history.length < 3) target = Math.max(current, 1);
  else if (desiredOutput > output * 1.1) target = Math.min(desiredHands, current + Math.min(2, content.rules.operatingWorkerAdjustMaxPerCycle || 2));
  else if (desiredOutput < output * 0.9 && current > 0) target = Math.max(desiredHands, current - 1);
  // 只在多雇一人划算（每人产值减饲料高于日薪）且资金够付 3 天工资时加人。
  const wage = shopWage(state, shop, content);
  const marginJin = def.outputPerWorkerDay * (currentUnitPrice(state, def.productItemId, content) - def.feedPerUnit * currentUnitPrice(state, def.feedItemId, content));
  const fundsVoucher = maximumPayableValueUnits(state, `shop:${shop.id}`, content) / currencyScale(content);
  if (target > current && (marginJin <= wage || fundsVoucher < (target - current) * wage * 3)) target = current;
  shop.plan.expectedDailySalesUnits = avgSold;
  shop.plan.staffingDiagnosis = target > current ? "供不应求，加人" : target < current ? "存货积压，减人" : "产销平衡";
  return target;
}

// 综合商店向养殖场进货：按养殖场存货多少依次买，价格取市场价（批发价）。返回买到的库存单位。
function buyFromFarms(state, store, itemId, wantedUnits, content) {
  const farms = Object.values(state.shops || {}).filter(shop => shop.status === "open"
    && shopDefinition(content, shop.typeId)?.kind === "farm" && (shop.inventory?.[itemId] || 0) > 0)
    .sort((a, b) => (b.inventory[itemId] || 0) - (a.inventory[itemId] || 0) || a.id.localeCompare(b.id));
  const price = currentUnitPrice(state, itemId, content);
  if (!(price > 0)) return 0;
  let bought = 0;
  for (const farm of farms) {
    const left = wantedUnits - bought;
    if (left <= 0) break;
    const affordable = Math.floor(maximumPayableValueUnits(state, `shop:${store.id}`, content) * content.precision.inventoryUnitsPerJin / (price * currencyScale(content)));
    const units = Math.min(left, farm.inventory[itemId] || 0, affordable);
    if (units <= 0) break;
    const value = Math.round(units / content.precision.inventoryUnitsPerJin * price * currencyScale(content));
    const payment = settleMonetaryPayment(state, `shop:${store.id}`, `shop:${farm.id}`, currentPaymentComposition(state, value), content,
      "farm_sale", `${store.name}向${farm.name}进${content.items[itemId]?.name || itemId}`, { requireFull: true });
    if (!payment.ok) break;
    const cogs = removeShopInventoryCost(farm, itemId, units);
    farm.inventory[itemId] -= units;
    addBookValue(farm, "revenueVoucherUnits", value);
    addBookValue(farm, "cogsVoucherUnits", cogs);
    addBookMap(farm, "soldUnits", itemId, units);
    addBookMap(farm, "storeSoldUnits", itemId, units);
    applyProfit(farm, value - cogs);
    store.inventory[itemId] = (store.inventory[itemId] || 0) + units;
    store.inventoryCostVoucherUnits[itemId] = (store.inventoryCostVoucherUnits[itemId] || 0) + value;
    addBookValue(store, "purchaseVoucherUnits", value);
    addBookMap(store, "purchasedUnits", itemId, units);
    bought += units;
  }
  // 商店没买够：把缺口记到经营这种肉的养殖场上，养殖场据此加人。
  const unmet = wantedUnits - bought;
  const producers = Object.values(state.shops || {}).filter(shop => shop.status === "open" && shopDefinition(content, shop.typeId)?.productItemId === itemId);
  if (unmet > 0 && producers.length) for (const farm of producers) addBookMap(farm, "unmetUnits", itemId, Math.floor(unmet / producers.length));
  return bought;
}

export function prepareShopsForDay(state, content) {
  ensureShops(state, content);
  syncShopEmployment(state, content);
  const operating = Object.values(state.shops).filter(shop => shop.status === "open");
  const paused = Object.values(state.shops).filter(shop => shop.status === "paused");
  for (const shop of operating) autoAdjustShopClerks(state, shop, content);
  syncShopEmployment(state, content);
  const rows = [];
  for (const shop of operating) {
    ensureShopBooks(shop, content);
    shop.settlement.days += 1;
    accrueDailyLiabilities(state, shop, content);
    payDailyLiabilities(state, shop, content);
    const procurement = procureShopInventory(state, shop, content);
    rows.push({ shopId: shop.id, procurement });
  }
  for (const shop of paused) {
    payDailyLiabilities(state, shop, content);
    rows.push({ shopId: shop.id, procurement: { purchasedUnits: 0, reason: "暂停经营" } });
  }
  return rows;
}

// 镇库偿付欠家庭的款项（如开店失败垫付不足的剩余）。每日尝试，有钱就还。
function settleTownOwesHouseholds(state, content) {
  const households = householdList(state).filter(h => (h.townOwesVoucherUnits || 0) > 0);
  if (households.length === 0) return;
  for (const household of households) {
    const owed = household.townOwesVoucherUnits || 0;
    if (owed <= 0) continue;
    const result = settleMonetaryPayment(state, "town", `household:${household.id}`,
      currentPaymentComposition(state, owed), content,
      "town_debt_repayment", "镇库偿付欠款",
      { requireFull: false });
    const paid = result.paidValueUnits || 0;
    household.townOwesVoucherUnits = Math.max(0, owed - paid);
    if (paid > 0) {
      recordEvent(state, `镇库偿付欠${household.name || household.id} ${Math.round(paid / content.precision.currencyUnitsPerVoucher)}券。`, content);
    }
  }
}

export function finishShopsDay(state, content, forceSettlement = false) {
  settleTownOwesHouseholds(state, content);
  const rows = [];
  for (const shop of Object.values(ensureShops(state, content)).filter(shop => shop.status === "open")) {
    payDailyLiabilities(state, shop, content);
    const sold = Object.values(shop.accounts.day.soldUnits || {}).reduce((sum, units) => sum + units, 0);
    const serviceUses = Object.values(shop.accounts.day.serviceUses || {}).reduce((sum, uses) => sum + uses, 0);
    const activity = sold + serviceUses;
    const arrears = (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0) + (shop.liabilities.taxVoucherUnits || 0);
    const farmDef = shopKind(shop, content) === "farm" ? shopDefinition(content, shop.typeId) : null;
    const retailStock = farmDef
      ? (shop.inventory[farmDef.productItemId] || 0) + (shop.inventory[farmDef.feedItemId] || 0)
      : shopRetailItemIds(shop, content).reduce((sum, itemId) => sum + (shop.inventory[itemId] || 0), 0);
    const noOperatingAssets = shopIsService(shop, content) ? false : retailStock <= 0;
    if (activity <= 0 && (noOperatingAssets || maximumPayableValueUnits(state, `shop:${shop.id}`, content) <= 0 || arrears > 0)) shop.badDays = (shop.badDays || 0) + 1;
    else if (activity > 0 || arrears <= 0) shop.badDays = 0;
    const settlement = settleShopTaxAndDistribution(state, shop, content, forceSettlement);
    if ((shop.liabilities.wageVoucherUnits || 0) > 0) shop.statusReason = "欠薪";
    else if (maximumPayableValueUnits(state, `shop:${shop.id}`, content) <= 0 && arrears > 0) shop.statusReason = "资金不足";
    else if (!shopIsService(shop, content) && retailStock <= 0) shop.statusReason = "缺货";
    else if (activity <= 0) shop.statusReason = shopIsService(shop, content) ? "需求不足" : "销量不足";
    else shop.statusReason = "营业中";
    if (shop.badDays >= (content.rules.shopClosureBadDays || 30) && activity <= 0) {
      const closing = closeShop(state, shop.id, content, true);
      rows.push({ shopId: shop.id, closed: true, liquidationPending: closing.liquidationPending, settlement });
    } else rows.push({ shopId: shop.id, closed: false, settlement });
  }
  for (const shop of Object.values(state.shops).filter(shop => shop.status === "paused")) {
    payDailyLiabilities(state, shop, content);
    rows.push({ shopId: shop.id, closed: false, paused: true, settlement: { settled: false } });
  }
  syncShopEmployment(state, content);
  return rows;
}

export function resetShopYear(state, content) {
  for (const shop of Object.values(ensureShops(state, content))) shop.accounts.year = blankShopPeriod();
}

function shopLiabilityTotal(shop) {
  return (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0) + (shop.liabilities.taxVoucherUnits || 0);
}

function finalizeShopLiquidation(state, shop, content) {
  if (shop.status !== "liquidating" || shopLiabilityTotal(shop) > 0) return false;
  const owner = state.households?.byId?.[shop.ownerHouseholdId];
  if (!owner) return false;
  for (const [itemId, units] of Object.entries(shop.inventory || {})) {
    if (units <= 0) continue;
    owner.inventory[itemId] = (owner.inventory[itemId] || 0) + units;
    shop.inventory[itemId] = 0;
    shop.inventoryCostVoucherUnits[itemId] = 0;
  }
  const wheatValue = voucherUnitsForWheatUnits(shop.cashWheatUnits || 0, content, "floor");
  const voucherValue = shop.cashVoucherUnits || 0;
  if (wheatValue + voucherValue > 0) {
    const returned = settleMonetaryPayment(state, `shop:${shop.id}`, `household:${owner.id}`,
      { valueUnits: wheatValue + voucherValue, wheatValueUnits: wheatValue, voucherValueUnits: voucherValue }, content,
      "shop_close_distribution", `${shop.name}清算完成后返还剩余资金`,
      { requireFull: true });
    if (!returned.ok) return false;
  }
  shop.status = "closed";
  shop.statusReason = "清算完成，已停业";
  syncResidentAggregates(state, content);
  return true;
}

export function closeShop(state, shopId, content, automatic = false) {
  const shop = ensureShops(state, content)[shopId];
  if (!shop) return { ok: false, reason: "店铺不存在" };
  if (shop.status === "closed") return { ok: true, shopId, alreadyClosed: true, liquidationPending: false };
  if (shop.status !== "liquidating") {
    settleShopTaxAndDistribution(state, shop, content, true, { allowDistribution: false });
    setJobCount(state, merchantJobKey(shop), 0, null);
    setJobCount(state, clerkJobKey(shop), 0, null);
    shop.status = "liquidating";
    shop.liquidatingSinceSerial = shopSerial(state, content);
    shop.statusReason = automatic ? "自动停业，待清算" : "已停业，待清算";
    recordEvent(state, `${shop.name}${automatic ? "长期无法经营，进入清算" : "停业并进入清算"}。`, content, { day: state.day + 1 });
  }
  payDailyLiabilities(state, shop, content);
  // 清算超过30天仍有负债，核销坏账强制关闭（之前无破产路径，会永久僵死）。
  const liquidatingDays = shopSerial(state, content) - (shop.liquidatingSinceSerial || 0);
  if (shop.status === "liquidating" && shopLiabilityTotal(shop) > 0 && liquidatingDays >= 30) {
    const writtenOff = shopLiabilityTotal(shop);
    shop.liabilities.wageVoucherUnits = 0;
    shop.liabilities.rentVoucherUnits = 0;
    shop.liabilities.taxVoucherUnits = 0;
    shop.liabilities.claimsVoucherUnits = {};
    recordEvent(state, `${shop.name}清算${liquidatingDays}天仍资不抵债，${Math.round(writtenOff / content.precision.currencyUnitsPerVoucher)}券坏账核销，强制关闭。`, content);
  }
  const finalized = finalizeShopLiquidation(state, shop, content);
  syncShopEmployment(state, content);
  return { ok: true, shopId, liquidationPending: !finalized, status: shop.status, liabilitiesVoucherUnits: shopLiabilityTotal(shop) };
}

export function fundShopLiquidation(state, shopId, content) {
  const shop = ensureShops(state, content)[shopId];
  if (!shop || shop.status !== "liquidating") return { ok: false, reason: "店铺当前不在清算中" };
  const owner = state.households?.byId?.[shop.ownerHouseholdId];
  if (!owner) return { ok: false, reason: "店铺缺少业主家庭" };
  payDailyLiabilities(state, shop, content);
  const due = shopLiabilityTotal(shop);
  if (due <= 0) {
    const finalized = finalizeShopLiquidation(state, shop, content);
    syncShopEmployment(state, content);
    return { ok: true, contributedVoucherUnits: 0, liquidationPending: !finalized, status: shop.status };
  }
  const maxWheatUnits = householdConvertibleWheatUnits(state, owner, content, content.rules.householdFoodReserveDays ?? 30);
  const contribution = maximumFullyPayableValueUnits(state, `household:${owner.id}`, due, content, { maxWheatUnits });
  if (contribution <= 0) return { ok: false, reason: "业主家庭没有可用于清偿的支付资产" };
  const transfer = settleMonetaryPayment(state, `household:${owner.id}`, `shop:${shop.id}`, currentPaymentComposition(state, contribution), content,
    "shop_liquidation_capital", `${owner.name}为${shop.name}补资清偿`, { requireFull: true, maxWheatUnits });
  if (!transfer.ok) return transfer;
  payDailyLiabilities(state, shop, content);
  const finalized = finalizeShopLiquidation(state, shop, content);
  syncShopEmployment(state, content);
  return { ok: true, contributedVoucherUnits: contribution, liquidationPending: !finalized, status: shop.status,
    liabilitiesVoucherUnits: shopLiabilityTotal(shop) };
}

function normalizeShopForSummary(shop, content) {
  const rawDef = content.rules.shopTypes?.[shop.typeId];
  const typeId = rawDef?.aliasOf || shop.typeId;
  const def = content.rules.shopTypes?.[typeId];
  const primaryItemId = shop.primaryItemId || shop.itemId || (rawDef?.aliasOf ? rawDef.itemId : null) || def?.itemIds?.[0] || null;
  const normalizePeriod = period => ({
    ...blankShopPeriod(),
    ...(period || {}),
    soldUnits: { ...(period?.soldUnits || {}) },
    purchasedUnits: { ...(period?.purchasedUnits || {}) },
    serviceUses: { ...(period?.serviceUses || {}) },
    customerCount: period?.customerCount || 0,
    rejectedCustomerCount: period?.rejectedCustomerCount || 0
  });
  return {
    ...shop,
    typeId,
    primaryItemId,
    itemId: primaryItemId,
    itemIds: def?.kind === "retail" ? [...(def.itemIds || [])] : [],
    serviceId: def?.kind === "service" ? def.serviceId : null,
    inventory: { ...emptyShopInventory(content), ...(shop.inventory || {}) },
    accounts: {
      day: normalizePeriod(shop.accounts?.day),
      year: normalizePeriod(shop.accounts?.year),
      cumulative: normalizePeriod(shop.accounts?.cumulative)
    },
    liabilities: { wageVoucherUnits: 0, rentVoucherUnits: 0, taxVoucherUnits: 0, ...(shop.liabilities || {}), claimsVoucherUnits: { ...(shop.liabilities?.claimsVoucherUnits || {}) } },
    inventoryCostVoucherUnits: { ...(shop.inventoryCostVoucherUnits || {}) },
    settlement: { days: 0, profitVoucherUnits: 0, lossCarryVoucherUnits: 0, lastTaxVoucherUnits: 0, lastSettlementYear: 0, lastSettlementDay: 0, ...(shop.settlement || {}) },
    retainedEarningsVoucherUnits: shop.retainedEarningsVoucherUnits || 0,
    cashVoucherUnits: shop.cashVoucherUnits || 0,
    cashWheatUnits: shop.cashWheatUnits || 0,
    history: shop.history || [],
    plan: shop.plan || { lastAdjustedSerial: -1 }
  };
}

export function shopSummaries(state, content) {
  const scale = currencyScale(content);
  const invScale = content.precision.inventoryUnitsPerJin;
  return Object.values(state.shops || {}).map(source => {
    const shop = normalizeShopForSummary(source, content);
    const def = shopDefinition(content, shop.typeId);
    const kind = def?.kind || "retail";
    const itemIds = shopRetailItemIds(shop, content);
    const primary = shop.primaryItemId || itemIds[0] || null;
    const prices = primary ? shopTradePrices(state, shop.typeId, content, primary) : null;
    const historyWithToday = [...(shop.history || []), {
      soldUnits: Object.values(shop.accounts?.day?.soldUnits || {}).reduce((sum, units) => sum + units, 0),
      serviceUses: { ...(shop.accounts?.day?.serviceUses || {}) },
      customerCount: shop.accounts?.day?.customerCount || 0,
      rejectedCustomerCount: shop.accounts?.day?.rejectedCustomerCount || 0,
      profitVoucherUnits: shop.accounts?.day?.profitVoucherUnits || 0
    }];
    const avgSalesUnits = recentAverage(historyWithToday, "soldUnits", content);
    const avgProfitUnits = recentAverage(historyWithToday, "profitVoucherUnits", content);
    const observation = Math.max(1, content.rules.operatingObservationDays || 7);
    const recentRows = historyWithToday.slice(-observation);
    const avgCustomers = recentRows.reduce((sum, row) => sum + Math.max(0, row.customerCount || 0), 0) / recentRows.length;
    const serviceId = def?.serviceId || null;
    const avgServiceUses = serviceId ? recentRows.reduce((sum, row) => sum + Math.max(0, row.serviceUses?.[serviceId] || 0), 0) / recentRows.length : 0;
    const outstandingServiceUses = serviceId ? Object.values(state.services?.demandByHousehold || {}).reduce((sum, row) => sum + Math.max(0, row?.[serviceId] || 0), 0) / 1000 : 0;
    const serviceHistory = serviceId ? [...(state.services?.history || []).slice(-observation), state.services?.day || {}] : [];
    const recentDemandUses = serviceId ? serviceHistory.reduce((sum, row) => sum + Math.max(0, row.attemptedUses?.[serviceId] ?? row.demandedUses?.[serviceId] ?? 0), 0) / Math.max(1, serviceHistory.length) : 0;
    const recentServedUses = serviceId ? serviceHistory.reduce((sum, row) => sum + Math.max(0, row.servedUses?.[serviceId] || 0), 0) / Math.max(1, serviceHistory.length) : 0;
    const recentUnaffordableUses = serviceId ? serviceHistory.reduce((sum, row) => sum + Math.max(0, row.unaffordableUses?.[serviceId] || 0), 0) / Math.max(1, serviceHistory.length) : 0;
    const recentCapacityUnmetUses = serviceId ? serviceHistory.reduce((sum, row) => sum + Math.max(0, row.capacityUnmetUses?.[serviceId] || 0), 0) / Math.max(1, serviceHistory.length) : 0;
    const inventoryRows = itemIds.map(itemId => {
      const itemPrices = shopTradePrices(state, shop.typeId, content, itemId);
      const stock = shop.inventory[itemId] || 0;
      const avg = recentRows.reduce((sum, row) => sum + Math.max(0, row.soldUnitsByItem?.[itemId] || 0), 0) / recentRows.length;
      return { itemId, itemName: content.items[itemId]?.name || itemId, stock: stock / invScale,
        averageDailySales: avg / invScale, inventoryDays: avg > 0 ? stock / avg : null,
        wholesaleVoucher: itemPrices?.wholesaleVoucherPerUnit || 0, retailVoucher: itemPrices?.retailVoucherPerUnit || 0 };
    });
    const stockUnits = primary ? (shop.inventory[primary] || 0) : 0;
    const inventoryDays = avgSalesUnits > 0 ? itemIds.reduce((sum, itemId) => sum + (shop.inventory[itemId] || 0), 0) / avgSalesUnits : null;
    let operatingStatus = shop.statusReason || "营业中";
    if (shop.status === "liquidating") operatingStatus = shopLiabilityTotal(shop) > 0 ? "待清算" : "待返还剩余资产";
    else if (shop.status === "paused") operatingStatus = "商人缺位，店员已遣散";
    else if ((shop.liabilities.wageVoucherUnits || 0) > 0) operatingStatus = "欠薪";
    else if ((shop.liabilities.rentVoucherUnits || 0) > 0 || (shop.liabilities.taxVoucherUnits || 0) > 0) operatingStatus = "资金不足";
    else if (Number.isFinite(shop.plan?.targetClerks) && shop.plan.targetClerks > shopClerkCount(state, shop)) operatingStatus = "缺员工";
    else if (kind === "service" && avgServiceUses <= 0) operatingStatus = "需求不足";
    else if (kind === "retail" && avgSalesUnits <= 0) operatingStatus = "暂无销量";
    else if (Number.isFinite(shop.plan?.targetClerks) && shop.plan.targetClerks < shopClerkCount(state, shop)) operatingStatus = "用工偏多";
    return {
      id: shop.id, name: shop.name, buildingId: shop.buildingId, typeId: shop.typeId, typeName: def?.name || shop.typeId, kind,
      itemId: primary, itemName: primary ? (content.items[primary]?.name || primary) : "", itemIds, inventoryRows, serviceId,
      serviceName: serviceId ? (content.rules.serviceTypes?.[serviceId]?.name || serviceId) : null,
      ownerHouseholdId: shop.ownerHouseholdId, ownerName: state.households?.byId?.[shop.ownerHouseholdId]?.name || shop.ownerHouseholdId, merchantHouseholdId: shop.ownerHouseholdId, merchantOnDuty: shopMerchantOnDuty(state, shop),
      merchants: shopMerchantCount(state, shop), maxMerchants: shopMaxMerchants(shop, content),
      clerks: shopClerkCount(state, shop), maxClerks: shopClerkLimit(shop, content), occupiesStreet: shopOccupiesStreet(shop),
      cashVoucher: shop.cashVoucherUnits / scale, cashWheatJin: (shop.cashWheatUnits || 0) / invScale,
      cashValue: maximumPayableValueUnits(state, `shop:${shop.id}`, content) / scale, inventory: stockUnits / invScale,
      capacityJin: shopSalesCapacityUnits(state, shop, content) / invScale,
      customerCapacity: shopDailyCustomerCapacity(state, shop, content),
      serviceCapacity: serviceId ? serviceShopCapacityUses(state, shop, content) : 0,
      wholesaleVoucher: prices?.wholesaleVoucherPerUnit || 0, retailVoucher: prices?.retailVoucherPerUnit || 0,
      status: shop.status, statusReason: operatingStatus,
      averageDailySales: avgSalesUnits / invScale, averageDailyServiceUses: avgServiceUses, recentCustomers: avgCustomers,
      outstandingServiceUses, recentDemandUses, recentServedUses, recentUnaffordableUses, recentCapacityUnmetUses,
      serviceFulfillmentRate: recentDemandUses > 0 ? recentServedUses / recentDemandUses : null,
      nextClerkServiceCapacity: serviceId ? Math.max(0, content.rules.serviceTypes?.[serviceId]?.clerkCapacity || 0) : 0,
      staffingDiagnosis: shop.plan?.staffingDiagnosis || null, averageDailyProfitVoucher: avgProfitUnits / scale, inventoryDays,
      clerkWageVoucher: shopWage(state, shop, content),
      // 0.2.3 综合商店动态加价：面板视图（只读，不回写 state）。
      pricing: selectShopPricingView(state, source, content),
      wageTarget: shop.plan?.wageTarget ?? null,
      wageDiagnosis: shop.plan?.wageDiagnosis || null,
      revenueDayVoucher: (shop.accounts.day.revenueVoucherUnits || 0) / scale,
      cogsDayVoucher: (shop.accounts.day.cogsVoucherUnits || 0) / scale,
      wageDayVoucher: (shop.accounts.day.wageExpenseVoucherUnits || 0) / scale,
      rentDayVoucher: (shop.accounts.day.rentExpenseVoucherUnits || 0) / scale,
      profitDayVoucher: (shop.accounts.day.profitVoucherUnits || 0) / scale,
      soldDayJin: Object.values(shop.accounts.day.soldUnits || {}).reduce((sum, units) => sum + units, 0) / invScale,
      wageArrearsVoucher: (shop.liabilities.wageVoucherUnits || 0) / scale,
      rentArrearsVoucher: (shop.liabilities.rentVoucherUnits || 0) / scale,
      taxArrearsVoucher: (shop.liabilities.taxVoucherUnits || 0) / scale,
      lastTaxVoucher: (shop.settlement.lastTaxVoucherUnits || 0) / scale,
      lossCarryVoucher: (shop.settlement.lossCarryVoucherUnits || 0) / scale,
      retainedEarningsVoucher: (shop.retainedEarningsVoucherUnits || 0) / scale,
      // 养殖场：产品、日产能、今日产量、存货、饲料、今日卖给商店的量。
      farm: kind === "farm" ? {
        productItemId: def.productItemId, productName: content.items[def.productItemId]?.name || def.productItemId,
        feedItemId: def.feedItemId, feedName: content.items[def.feedItemId]?.name || def.feedItemId, feedPerUnit: def.feedPerUnit,
        outputPerWorkerDay: def.outputPerWorkerDay,
        capacityJin: farmDailyOutputUnits(state, source, content) / invScale,
        producedDayJin: (shop.accounts.day.producedUnits?.[def.productItemId] || 0) / invScale,
        storeSoldDayJin: (shop.accounts.day.storeSoldUnits?.[def.productItemId] || 0) / invScale,
        soldDayJin: (shop.accounts.day.soldUnits?.[def.productItemId] || 0) / invScale,
        productStockJin: (shop.inventory[def.productItemId] || 0) / invScale,
        feedStockJin: (shop.inventory[def.feedItemId] || 0) / invScale,
        priceVoucher: currentUnitPrice(state, def.productItemId, content)
      } : null
    };
  });
}

// 时代广场总览（只读）：每座广场的摊位数、摊贩人数、今日卖货与利润。
export function stallSquareSummaries(state, content, summaries = shopSummaries(state, content)) {
  const limit = Math.max(0, Math.floor(state.policy?.stallKeeperLimit ?? content.rules.stallKeeperDefaultLimit ?? 50));
  return (state.buildings || []).filter(building => building.typeId === "times_square").map(building => {
    const stalls = summaries.filter(row => row.kind === "stall" && row.buildingId === building.id && (row.status === "open" || row.status === "paused"));
    return {
      buildingId: building.id, slots: shopHostSlots(building, content), stalls: stalls.length,
      keepers: stalls.reduce((sum, row) => sum + row.merchants, 0), keeperLimit: limit,
      rentVoucher: state.policy?.stallRentVoucher ?? content.rules.stallRentDefaultVoucher ?? 2,
      soldDayJin: stalls.reduce((sum, row) => sum + Object.values(state.shops?.[row.id]?.accounts?.day?.soldUnits || {}).reduce((a, b) => a + b, 0), 0) / content.precision.inventoryUnitsPerJin,
      profitDayVoucher: stalls.reduce((sum, row) => sum + row.profitDayVoucher, 0),
      averageDailyProfitVoucher: stalls.length ? stalls.reduce((sum, row) => sum + row.averageDailyProfitVoucher, 0) / stalls.length : 0,
      cooldownDays: Math.max(0, (state.stallMarket?.cooldownUntilSerial || 0) - ((state.year - 1) * content.rules.daysPerYear + state.day)),
      dailySalesCapJin: content.rules.shopTypes?.stall?.dailySalesCapJin ?? 50
    };
  });
}

