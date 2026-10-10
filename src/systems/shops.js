import { inOpeningPeriod } from "./employment-contracts.js";
import { cancelHouseholdLoan, householdLiquidValueUnits, issueHouseholdLoan, quoteHouseholdLoan } from "./household-loans.js";
import { payDayFor } from "./paydays.js";
import { currencyScale, voucherBalance } from "../economy/currency.js";
import { householdIdOf } from "../economy/accounts.js";
import { PERIODS, bookAdd, bookAddMap, ensureBook } from "../economy/books.js";
import { addPaymentObligation, currentPaymentComposition, maximumFullyPayableValueUnits, maximumPayableValueUnits, normalizePaymentObligation, quoteMonetaryPayment, settleMonetaryPayment, spendableVoucherUnits } from "../economy/payment.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { addTownCostBasis, removeTownInventoryWithCost } from "../economy/business.js";
import { putStock, takeStock } from "../economy/trade.js";
import { nextRandom } from "../core/random.js";
import {
  householdConvertibleWheatUnits, householdList, householdPopulation, householdIdleWorkers, isActiveHousehold,
  householdWorkingAge, jobReleaseRank, releaseJobFromHousehold,
  syncResidentAggregates,
  setHouseholdJobCount, setJobCount, jobCount, jobAssignments
  , reserveWheatPaymentOptions
} from "./households.js";
import { shopTradePrices, recentAverage } from "../economy/operating-plan.js";
import { shopEffectiveMarginPercent } from "../economy/margin-policy.js";
import { currentUnitPrice } from "../economy/prices.js";
import { accrueWages, payWages, pendingWages, wageArrears, wageBook } from "./employer.js";
import { allocateInputToTown, buyWholesaleForOwner, hasWholesaleMarket, recordTownInputConsumption, wholesaleMonopolyItemIds, wholesaleUnitPrice } from "./wholesale-market.js";
import { computeLaborMarket, poachWorkers, adjustShopWage, shopWage } from "./labor-market.js";
import { farmSalePriceVoucher } from "./farm-pricing.js";
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
    distributedVoucherUnits: 0,
    // 贸易行运费（粮券）：运费付给镇库，计入利润（见 systems/trading-houses.js）。
    freightVoucherUnits: 0
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
  delete shop.cashWheatUnits;
  shop.history ||= [];
  shop.plan ||= { lastAdjustedSerial: -1 };
  shop.staffing ||= { clerkHiredSerials: [] };
  shop.staffing.clerkHiredSerials ||= [];
  // 0.2.3 动态加价：定价状态一律 ||= 补齐，旧档无需升版本。
  if (content) ensureShopPricing(shop, content);
  return shop;
}

// 补齐店铺字段（读旧档、新开店后）。每天、每次店铺数变化各做一次即可，不在每笔买卖里重复遍历全部店铺和商品。
const ensuredShops = new WeakMap();

export function ensureShops(state, content) {
  state.shops ||= {};
  state.nextShopNumber ||= 1;
  const stamp = `${state.year}:${state.day}:${Object.keys(state.shops).length}:${state.nextShopNumber}`;
  if (ensuredShops.get(state.shops) === stamp) return state.shops;
  ensuredShops.set(state.shops, stamp);
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
    || ((shopDefinition(content, shop.typeId)?.id === "general" || shopDefinition(content, shop.typeId)?.kind === "stall") && farmsHaveStock(state, itemId, content)));
}

export function farmsHaveStock(state, itemId, content) {
  return Object.values(state.shops || {}).some(other => other.status === "open"
    && shopDefinition(content, other.typeId)?.kind === "farm" && (other.inventory?.[itemId] || 0) > 0);
}

export function shopRetailItemIds(shop, content) {
  const def = shopDefinition(content, shop?.typeId);
  if (def?.kind === "retail") return [...(def.itemIds || [])];
  if (def?.kind === "stall") return stallItemIds(content);
  return [];
}

// 集市卖日用品（rules.householdGoods）和肉（像菜市场，肉直接从养殖场进），不卖面粉面包盐。
export function stallItemIds(content) {
  const goods = Object.keys(content.rules.householdGoods || {}).filter(itemId => content.items[itemId]);
  const meats = Object.keys(content.items).filter(itemId => content.items[itemId]?.livestock && !goods.includes(itemId));
  return [...goods, ...meats];
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

export function shopMerchantCount(state, shop) { return jobCount(state, merchantJobKey(shop)); }

// 店铺的付款账户名：镇营综合商店没有自己的钱包，收付款一律走镇库（"town"）；其余店铺走 shop:<id>。
export function shopAccountName(shop) {
  return shop?.town ? "town" : `shop:${shop.id}`;
}

function shopMerchantOnDuty(state, shop) {
  // 镇营综合商店：没有商人，有店员即营业（店员由镇里设定）。
  if (shop.town) return shopClerkCount(state, shop) > 0;
  // 集体经营（时代广场）：有人在摊上就算营业，不认某一户店主。
  if (shop.collective) return shopMerchantCount(state, shop) > 0;
  const owner = state.households?.byId?.[shop.ownerHouseholdId];
  return Boolean(owner && isActiveHousehold(owner) && (owner.jobs?.[merchantJobKey(shop)] || 0) >= 1 && shopMerchantCount(state, shop) > 0);
}

export function shopClerkCount(state, shop) { return jobCount(state, clerkJobKey(shop)); }

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

// 客流按户计（一户一天在一家店算一位客人），一位客人一次买的量按一户人家的日用量估。
export function shopJinPerCustomer(content) {
  return content.rules.shopJinPerCustomer ?? 20;
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
      const perCustomerJin = shopJinPerCustomer(content);
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

export function releaseAllShopClerks(state, shop) {
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
    if (shop.collective) {
      if (shop.status === "paused") { shop.status = "open"; shop.statusReason = "准备营业"; }
      continue;
    }
    // 镇营综合商店：没有业主与商人，店员由镇里设定，不因"商人缺位"暂停。
    if (shop.town) {
      if (shop.status === "paused") { shop.status = "open"; shop.statusReason = "准备营业"; }
      continue;
    }
    // 贸易行因无买卖暂停（tradePause）：保持暂停，复业由 trading-houses.js 的定期检查决定。
    if (shop.tradePause) {
      shop.status = "paused";
      continue;
    }
    const owner = state.households?.byId?.[shop.ownerHouseholdId];
    const ownerMerchantCount = owner?.jobs?.[merchantJobKey(shop)] || 0;
    if (!owner || !isActiveHousehold(owner) || ownerMerchantCount < 1) {
      if (owner && ownerMerchantCount > 0) setHouseholdJobCount(state, owner.id, merchantJobKey(shop), 0, null);
      releaseAllShopClerks(state, shop);
      shop.status = "paused";
      shop.statusReason = "商人缺位，店员已遣散";
    } else if (shop.status === "paused" && !shop.tradePause) {
      // 贸易行因无买卖暂停（tradePause）时不在这里复业，由 trading-houses.js 的定期检查恢复。
      shop.status = "open";
      shop.statusReason = "准备营业";
    }
  }
  return state.shops;
}

// 贸易行暂停（无买卖）：商人与店员岗位一并释放（非营业店铺不能保留岗位），业主身份保留。
export function releaseShopStaffing(state, shop) {
  setJobCount(state, merchantJobKey(shop), 0, null);
  releaseAllShopClerks(state, shop);
}

// 店铺的最低营运资金：开店时的启动资金与一段周转（workingCapitalReserve）取大者。
export function shopMinimumCapitalUnits(state, shop, content) {
  return Math.max(shop.initialCapital?.valueUnits || 0, Math.ceil(shopWorkingCapitalReserve(state, shop, content) || 0));
}

// 业主家庭为店铺补足营运资金到 minUnits：只补业主付得起的全额（付不起则一分不动，店铺继续保持原状）。
export function topUpShopCapital(state, shop, minUnits, content) {
  const owner = state.households?.byId?.[shop.ownerHouseholdId];
  if (!owner || !isActiveHousehold(owner)) return { ok: false, reason: "业主不在", toppedUnits: 0 };
  const need = Math.max(0, Math.ceil(Number(minUnits) || 0) - maximumPayableValueUnits(state, `shop:${shop.id}`, content));
  if (need <= 0) return { ok: true, toppedUnits: 0 };
  const maxWheatUnits = householdConvertibleWheatUnits(state, owner, content, content.rules.householdFoodReserveDays ?? 30);
  const affordable = maximumFullyPayableValueUnits(state, `household:${owner.id}`, need, content, { maxWheatUnits });
  if (affordable < need) return { ok: false, reason: "业主付不起周转金", toppedUnits: 0 };
  const transfer = settleMonetaryPayment(state, `household:${owner.id}`, `shop:${shop.id}`, currentPaymentComposition(state, need), content,
    "shop_capital_topup", `${owner.name}为${shop.name}补足营运资金`, { requireFull: true, maxWheatUnits });
  if (!transfer.ok) return { ok: false, reason: "补资未能全额支付", toppedUnits: 0 };
  return { ok: true, toppedUnits: need };
}

// 贸易行复业：业主先回到商人岗位（店主兼商人），再补足商人与店员。业主不在或无人手可上岗则不动任何东西。
export function reopenTradeHouse(state, shop, { merchants = 1, clerks = 0 } = {}, content) {
  const owner = state.households?.byId?.[shop.ownerHouseholdId];
  if (!owner || !isActiveHousehold(owner)) return { ok: false, reason: "业主不在" };
  const merchantKey = merchantJobKey(shop);
  if (!setHouseholdJobCount(state, owner.id, merchantKey, 1, content).ok) return { ok: false, reason: "业主无法上岗" };
  delete shop.tradePause;
  shop.status = "open";
  shop.statusReason = "准备营业";
  const wantMerchants = Math.max(1, Math.min(shopMaxMerchants(shop, content), Math.floor(Number(merchants) || 1)));
  setJobCount(state, merchantKey, wantMerchants, content, { type: "shop", id: shop.id });
  setShopClerks(state, shop.id, Math.min(Math.max(0, Math.floor(Number(clerks) || 0)), shopClerkLimit(shop, content)), content);
  return { ok: true, merchants: shopMerchantCount(state, shop), clerks: shopClerkCount(state, shop) };
}

// ---------------------------------------------------------------- 业主更替（docs/REDISTRIBUTION.md 第 2 条）
// 业主家庭失效（人口归零）时店铺不关门、不清算：按 商人 → 店员 → 家底最厚的一户 的顺序由新业主接手，
// 现金、库存、负债、员工与经营设置原样保留；利润自然改付给新业主（settleShopTaxAndDistribution 按 ownerHouseholdId 分配）。

function livingWorkerHousehold(state, householdId) {
  const household = state.households?.byId?.[householdId];
  return household && isActiveHousehold(household) && householdWorkingAge(household) > 0 ? household : null;
}

// 店铺在等待业主更替：非集体、未关闭、未清算，且业主家庭不存在或已失效。
export function shopsAwaitingSuccession(state, householdId) {
  return Object.values(state.shops || {}).filter(shop => !shop.collective && shop.ownerHouseholdId === householdId
    && shop.status !== "closed" && shop.status !== "liquidating");
}

// 候选人：商人（岗位多者优先）→ 店员（岗位多者优先）→ 家底最厚（粮券 + 存款 + 超出口粮储备的小麦）且不已在同类宿主建筑开店的一户。
// 平局统一取可动用粮券多者。返回 { household, source } 或 null。
export function chooseShopSuccessor(state, shop, content) {
  const merchantKey = merchantJobKey(shop);
  const clerkKey = clerkJobKey(shop);
  const byMoneyThenId = (a, b) => b.money - a.money || a.household.id.localeCompare(b.household.id);
  const staffRows = key => householdList(state)
    .filter(household => household.id !== shop.ownerHouseholdId && (household.jobs?.[key] || 0) > 0 && livingWorkerHousehold(state, household.id))
    .map(household => ({ household, slots: household.jobs[key], money: spendableVoucherUnits(state, `household:${household.id}`) }));
  const merchants = staffRows(merchantKey).sort((a, b) => b.slots - a.slots || byMoneyThenId(a, b));
  if (merchants.length) return { household: merchants[0].household, source: "merchant" };
  const clerks = staffRows(clerkKey).sort((a, b) => b.slots - a.slots || byMoneyThenId(a, b));
  if (clerks.length) return { household: clerks[0].household, source: "clerk" };
  const hostTypeId = shopHostTypeId(shopDefinition(content, shop.typeId));
  const ownsSameHost = new Set(Object.values(state.shops || {})
    .filter(other => other.id !== shop.id && !other.collective && other.status !== "closed" && other.ownerHouseholdId
      && shopHostTypeId(shopDefinition(content, other.typeId)) === hostTypeId)
    .map(other => other.ownerHouseholdId));
  const wealthy = householdList(state)
    .filter(household => household.id !== shop.ownerHouseholdId && !ownsSameHost.has(household.id) && livingWorkerHousehold(state, household.id))
    .map(household => {
      const wheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
      const money = spendableVoucherUnits(state, `household:${household.id}`) + voucherUnitsForWheatUnits(wheatUnits, content, "floor");
      return { household, money };
    })
    .sort(byMoneyThenId);
  if (wealthy.length) return { household: wealthy[0].household, source: "wealth" };
  return null;
}

// 把店铺交给新业主。新业主必须是有劳动力的在世家庭；若他不是本店商人，先离开本店店员岗位（或释放一个其他岗位），再任商人。
// 商人岗位已满（且新业主不在岗）时不替换他人，直接失败。旧业主的商人岗位一并清掉。
export function transferShopOwnership(state, shopId, newHouseholdId, content) {
  const shop = ensureShops(state, content)[shopId];
  if (!shop) return { ok: false, reason: "店铺不存在" };
  if (shop.collective) return { ok: false, reason: "集体摊位没有业主" };
  if (shop.town) return { ok: false, reason: "镇营店没有业主" };
  const next = livingWorkerHousehold(state, newHouseholdId);
  if (!next) return { ok: false, reason: "新业主必须是有劳动力的在世家庭" };
  const merchantKey = merchantJobKey(shop);
  const clerkKey = clerkJobKey(shop);
  const previousId = shop.ownerHouseholdId;
  const previous = previousId && previousId !== next.id ? state.households?.byId?.[previousId] : null;
  const previousMerchants = previous ? (previous.jobs?.[merchantKey] || 0) : 0;
  const nextIsMerchant = (next.jobs?.[merchantKey] || 0) >= 1;
  if (!nextIsMerchant && shopMerchantCount(state, shop) - previousMerchants >= shopMaxMerchants(shop, content)) {
    return { ok: false, reason: "商人岗位已满，新业主无法上岗" };
  }
  if (previous && previousMerchants > 0) setHouseholdJobCount(state, previous.id, merchantKey, 0, null);
  // 暂停中的贸易行没有岗位：新业主只换身份，复业时再上岗。
  if (!nextIsMerchant && !shop.tradePause) {
    if ((next.jobs?.[clerkKey] || 0) > 0) setHouseholdJobCount(state, next.id, clerkKey, next.jobs[clerkKey] - 1, null);
    if (householdIdleWorkers(next) <= 0) {
      const key = Object.keys(next.jobs || {}).filter(jobKey => next.jobs[jobKey] > 0)
        .sort((a, b) => jobReleaseRank(b) - jobReleaseRank(a) || b.localeCompare(a))[0];
      if (key) releaseJobFromHousehold(state, next.id, key, 1);
    }
    const assigned = setHouseholdJobCount(state, next.id, merchantKey, 1, content);
    if (!assigned.ok) return { ok: false, reason: assigned.reason };
  }
  syncClerkTenure(state, shop, content);
  shop.ownerHouseholdId = next.id;
  if (previous) previous.shopIds = (previous.shopIds || []).filter(id => id !== shopId);
  next.shopIds ||= [];
  if (!next.shopIds.includes(shopId)) next.shopIds.push(shopId);
  delete shop.successionNoticed;
  syncShopEmployment(state, content);
  return { ok: true, shopId, householdId: next.id, previousHouseholdId: previousId };
}

// 单店的业主更替：找到新业主并交接，记事件；找不到则店铺保持暂停（只记一次事件）。
function succeedOrphanShop(state, shop, content) {
  const previous = state.households?.byId?.[shop.ownerHouseholdId];
  const previousName = previous?.name || shop.ownerHouseholdId;
  const typeName = shopDefinition(content, shop.typeId)?.name || "店铺";
  const choice = chooseShopSuccessor(state, shop, content);
  if (!choice) {
    if (!shop.successionNoticed) {
      shop.successionNoticed = true;
      recordEvent(state, `${previousName}无人继承，其开的${typeName}无人接手，店铺暂停。`, content, { day: state.day + 1 });
    }
    syncShopEmployment(state, content);
    return { ok: false, reason: "无人可接手" };
  }
  const result = transferShopOwnership(state, shop.id, choice.household.id, content);
  if (!result.ok) return { ok: false, reason: result.reason };
  const label = { merchant: "原商人", clerk: "原店员", wealth: "家底最厚的一户" }[choice.source];
  recordEvent(state, `${previousName}无人继承，其开的${typeName}由${choice.household.name}（${label}）接手。`, content, { day: state.day + 1 });
  return { ok: true, householdId: choice.household.id, source: choice.source };
}

// 家产归公时调用：这一户名下待交接的店铺逐个交接。
export function succeedShopsOfHousehold(state, householdId, content) {
  return shopsAwaitingSuccession(state, householdId).map(shop => ({ shopId: shop.id, ...succeedOrphanShop(state, shop, content) }));
}

// 日结店铺准备：业主已失效的店铺（含旧档里已被暂停的孤儿店）每日尝试交接。
export function succeedOrphanShops(state, content) {
  const rows = [];
  for (const shop of Object.values(ensureShops(state, content))) {
    if (shop.collective || shop.town || shop.status === "closed" || shop.status === "liquidating") continue;
    const owner = state.households?.byId?.[shop.ownerHouseholdId];
    if (owner && isActiveHousehold(owner)) continue;
    rows.push({ shopId: shop.id, ...succeedOrphanShop(state, shop, content) });
  }
  return rows;
}

function householdStartupReserveUnits(household, content) {
  const perPerson = content.rules.householdLiving?.difficultPerCapitaVoucher ?? 30;
  return Math.round(householdPopulation(household) * perPerson * currencyScale(content));
}

function shopStartupUnits(def, content) {
  return Math.round((def?.startupVoucher ?? content.rules.shopMerchantStartupVoucher ?? 120) * currencyScale(content));
}

// 没有家庭凑得齐启动资金时，按"总值 ≥ 启动资金 + 生活储备"补缺口放贷（docs/LENDING.md）。
// 依次试候选（可动用资金多的在前）：放了贷、又能开店才算成功；否则当天冲销，换下一户。返回 { household, loanId } 或 null。
function borrowForShopStartup(state, content, preferredId, startup) {
  const candidates = householdList(state)
    .filter(household => isActiveHousehold(household) && householdIdleWorkers(household) > 0
      && (!preferredId || household.id === preferredId))
    .map(household => ({ household, liquid: householdLiquidValueUnits(state, household, content) }))
    .sort((a, b) => b.liquid - a.liquid || String(a.household.id).localeCompare(String(b.household.id)));
  for (const { household } of candidates) {
    const need = startup + householdStartupReserveUnits(household, content);
    const quote = quoteHouseholdLoan(state, household.id, "shop", need, content);
    if (!quote.ok || !quote.covers) continue;
    const issued = issueHouseholdLoan(state, household.id, "shop", need, content);
    if (!issued.ok) continue;
    if (chooseMerchantHousehold(state, content, household.id, startup)) return { household, loanId: issued.loan.id };
    cancelHouseholdLoan(state, issued.loan.id, content);
  }
  return null;
}

function chooseMerchantHousehold(state, content, preferredId = null, startup = shopStartupUnits(null, content)) {
  const candidates = householdList(state).filter(household => {
    if (!isActiveHousehold(household) || householdIdleWorkers(household) <= 0) return false;
    const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
    const totalValue = spendableVoucherUnits(state, `household:${household.id}`) + voucherUnitsForWheatUnits(maxWheatUnits, content, "floor");
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
  if (requestedDefinition?.town) return openTownShopRecord(state, building, normalizedTypeId, definition, content);
  const startupUnits = shopStartupUnits(definition, content);
  let household = chooseMerchantHousehold(state, content, preferredHouseholdId, startupUnits);
  // 开店失败时同日冲销这笔贷款（见下方各失败分支）。
  let loanId = null;
  if (!household) {
    const borrowed = borrowForShopStartup(state, content, preferredHouseholdId, startupUnits);
    if (borrowed) ({ household, loanId } = borrowed);
  }
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
    initialCapital: { valueUnits: startupUnits, voucherValueUnits: 0 }
  };
  state.shops[shopId] = shop;
  const payment = settleMonetaryPayment(state, `household:${household.id}`, `shop:${shopId}`, currentPaymentComposition(state, startupUnits), content,
    "shop_capital", `${household.name}投入开店资金`,
    { requireFull: true, maxWheatUnits: householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30) });
  if (!payment.ok) {
    delete state.shops[shopId];
    if (loanId) cancelHouseholdLoan(state, loanId, content);
    return payment;
  }
  shop.initialCapital.voucherValueUnits = payment.voucherPaidValueUnits || 0;
  const assignment = setHouseholdJobCount(state, household.id, `shop:${shopId}:merchant`, 1, content);
  if (!assignment.ok) {
    const refund = settleMonetaryPayment(state, `shop:${shopId}`, `household:${household.id}`, {
      valueUnits: startupUnits, voucherValueUnits: payment.voucherPaidValueUnits || 0
    }, content, "shop_capital_refund", "开店失败退回资金", { requireFull: true });
    // 退款失败：镇库先行垫付给家庭。店铺即将删除，其负债记录会一并消失，
    // 故不在店上记账，直接由镇库承担并记为家庭对镇库的应收（持久化，不随店删除）。
    if (!refund.ok) {
      const due = {
        valueUnits: startupUnits,
        voucherValueUnits: payment.voucherPaidValueUnits || 0
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
    if (loanId) cancelHouseholdLoan(state, loanId, content);
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

// 镇营综合商店（content 里的 town_general 别名 → 综合商店，带 town 标记）：镇里持有，不要业主与商人，
// 没有自己的钱（收入直接进镇库、工资与进货由镇库付），店员由镇里设定（configureShopClerks）。占用商业街店位。
function openTownShopRecord(state, building, typeId, definition, content) {
  if (!hasWholesaleMarket(state)) return { ok: false, reason: "请先建成批发市场（镇营综合商店从批发市场进货）" };
  // 每条商业街的镇营店数量上限（rules.townShop.maxPerStreet，默认 1）；停业中的不占名额。
  const maxPerStreet = Math.max(1, Math.floor(Number(content.rules.townShop?.maxPerStreet ?? 1)));
  const open = Object.values(state.shops || {}).filter(row => row.town && row.buildingId === building.id
    && row.status !== "closed" && row.status !== "liquidating").length;
  if (open >= maxPerStreet) return { ok: false, reason: `每条商业街最多${maxPerStreet}家镇营综合商店` };
  const shopId = `shop-${state.nextShopNumber++}`;
  const shop = {
    id: shopId,
    name: `镇营${definition.name}`,
    buildingId: building.id,
    typeId,
    town: true,
    primaryItemId: definition.itemIds?.[0] || null,
    itemId: definition.itemIds?.[0] || null,
    itemIds: definition.kind === "retail" ? [...(definition.itemIds || [])] : [],
    serviceId: null,
    ownerHouseholdId: null,
    cashVoucherUnits: 0,
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
    initialCapital: { valueUnits: 0, voucherValueUnits: 0 }
  };
  state.shops[shopId] = shop;
  ensureShopBooks(shop, content);
  syncShopEmployment(state, content);
  recordEvent(state, `镇里在商业街开出${shop.name}，店员由镇里设定。`, content, { day: state.day + 1 });
  return { ok: true, shopId, householdId: null, town: true, startupVoucher: 0 };
}

// 镇里开一家镇营综合商店（命令 openTownShop 调用）。
export function openTownShop(state, buildingId, content) {
  return openShop(state, buildingId, "town_general", content);
}

export function setShopMerchants(state, shopId, requested, content) {
  const shop = ensureShops(state, content)[shopId];
  if (!shop) return { ok: false, reason: "店铺不存在" };
  if (shop.town) return { ok: false, reason: "镇营店没有商人，店员由镇里设定" };
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
    return { ok: false, reason: shop.status === "paused" ? (shop.tradePause ? "贸易行暂停营业中" : "商人缺位，店员已遣散") : "店铺未营业" };
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
  // 正式员工：店铺减店员是辞退，按店员日薪付 severanceWageDays 天补偿；付不起记欠薪（systems/employment-contracts.js 同一口径）。
  let severanceVoucherUnits = 0;
  if (assigned < before && !shop.collective) {
    const perWorker = Math.round(shopWage(state, shop, content) * Math.max(0, content.rules.severanceWageDays ?? 30) * currencyScale(content));
    wageBook(shop.liabilities ||= {});
    for (const row of result.releasedRows || []) {
      const due = perWorker * row.count;
      if (due <= 0) continue;
      const paid = settleMonetaryPayment(state, shopAccountName(shop), `household:${row.householdId}`, currentPaymentComposition(state, due), content,
        "severance_payment", `${shop.name}辞退店员补偿`, { requireFull: false }).paidValueUnits || 0;
      if (due > paid) {
        shop.liabilities.claimsVoucherUnits[row.householdId] = (shop.liabilities.claimsVoucherUnits[row.householdId] || 0) + (due - paid);
        shop.liabilities.claimsPayment[row.householdId] = addPaymentObligation(shop.liabilities.claimsPayment[row.householdId], currentPaymentComposition(state, due - paid));
      }
      addBookValue(shop, "severanceVoucherUnits", due);
      applyProfit(shop, -due);
      severanceVoucherUnits += due;
    }
    shop.liabilities.wageVoucherUnits = wageArrears(shop.liabilities);
  }
  syncShopEmployment(state, content);
  return { ok: true, assigned: shopClerkCount(state, shop), severanceVoucherUnits };
}

export function shopSalesCapacityUnits(state, shop, content) {
  if (!shop || shop.status !== "open" || !shopMerchantOnDuty(state, shop) || shopIsService(shop, content)) return 0;
  const kind = shopKind(shop, content);
  if (kind === "farm") return 0;
  // 贸易行的接待能力 = 店员与商人人数 × 每人可成交斤数（docs/TRADE.md）。
  if (kind === "trade") return Math.round((shopClerkCount(state, shop) + shopMerchantCount(state, shop)) * (content.rules.tradeHouseJinPerClerk || 100) * content.precision.inventoryUnitsPerJin);
  if (kind === "stall") {
    const def = shopDefinition(content, shop.typeId);
    return Math.round(shopMerchantCount(state, shop) * (def.perKeeperSalesJin ?? 25) * content.precision.inventoryUnitsPerJin);
  }
  if (shopDefinition(content, shop.typeId)?.id === "general") {
    const customers = shopDailyCustomerCapacity(state, shop, content);
    return Math.round(customers * shopJinPerCustomer(content) * content.precision.inventoryUnitsPerJin);
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
  const def = shopDefinition(content, shop.typeId);
  const days = def?.workingCapitalReserveDays ?? content.rules.shopWorkingCapitalReserveDays ?? 7;
  if (def?.kind === "trade") {
    // 贸易行留几天买卖周转金：按全部可买卖商品的平均批发售价估值。
    if (!hasWholesaleMarket(state)) return 0;
    const prices = wholesaleMonopolyItemIds(content).map(itemId => wholesaleUnitPrice(state, itemId, content)).filter(p => p > 0);
    const averagePrice = prices.length ? prices.reduce((sum, p) => sum + p, 0) / prices.length : 0;
    return Math.round(shopSalesCapacityUnits(state, shop, content) / content.precision.inventoryUnitsPerJin * averagePrice * days * currencyScale(content));
  }
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
  // 集市只进少量货，但不能因为当下批发市场缺货就把周转金全分掉：按全部经营品类估价。
  // 集市按它真正在卖的货估价（有存货或批发市场有货的品类），不让丝绸这类贵货把周转金抬到分不出利润。
  const itemIds = def?.kind === "stall"
    ? shopRetailItemIds(shop, content).filter(itemId => (shop.inventory?.[itemId] || 0) > 0 || (state.wholesaleMarket?.inventory?.[itemId] || 0) > 0)
    : activeRetailItemIds(state, shop, content);
  if (!itemIds.length) return 0;
  const wholesalePrices = itemIds.map(itemId => shopTradePrices(state, shop.typeId, content, itemId)?.wholesaleVoucherPerUnit || 0).filter(p => p > 0);
  // 排除0价，避免无批发价商品拉低均值（之前简单平均含0）。
  const averageWholesale = wholesalePrices.length > 0 ? wholesalePrices.reduce((sum, p) => sum + p, 0) / wholesalePrices.length : 0;
  return Math.round(shopSalesCapacityUnits(state, shop, content) / content.precision.inventoryUnitsPerJin * averageWholesale * days * currencyScale(content));
}

// 镇营店的定价成本基础：与库存成本账并行，按私营店进货的同一价（市场段为进货时的批发售价，养殖场段为养殖场售价）逐笔入账、
// 按比例转出，只供动态定价复核算利润率；镇库的库存成本账不受影响。私营店不用，这些函数对非镇营店直接返回。
function addPricingBasis(shop, itemId, valueUnits) {
  if (!shop.town || !(valueUnits > 0)) return;
  shop.pricingBasisVoucherUnits ||= {};
  shop.pricingBasisVoucherUnits[itemId] = (shop.pricingBasisVoucherUnits[itemId] || 0) + Math.floor(valueUnits);
}
function takePricingBasis(shop, itemId, available, units) {
  if (!shop.town) return 0;
  shop.pricingBasisVoucherUnits ||= {};
  const basis = shop.pricingBasisVoucherUnits[itemId] || 0;
  const cost = units >= available ? basis : (available > 0 ? Math.floor(basis * units / available) : 0);
  shop.pricingBasisVoucherUnits[itemId] = Math.max(0, basis - cost);
  return cost;
}
function wholesaleValueUnits(state, itemId, units, content) {
  return Math.round(units / content.precision.inventoryUnitsPerJin * wholesaleUnitPrice(state, itemId, content) * currencyScale(content));
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
  // 客流按家庭计：同一家庭当日在本店无论买几样，只算一个客人。已计入的家庭不受客流上限拦截。
  const buyerHouseholdId = householdIdOf(buyerOwner);
  const day = shop.accounts.day;
  const alreadyServed = !!(buyerHouseholdId && day.customerHouseholds?.[buyerHouseholdId]);
  if (!alreadyServed && (day.customerCount || 0) >= shopDailyCustomerCapacity(state, shop, content)) {
    // 同一家庭当日被拒只记一次拒客。
    day.rejectedHouseholds ||= {};
    if (!buyerHouseholdId || !day.rejectedHouseholds[buyerHouseholdId]) {
      if (buyerHouseholdId) day.rejectedHouseholds[buyerHouseholdId] = true;
      registerRejectedCustomers(state, shopId, 1, content);
    }
    return { ok: false, reason: "今日客流接待能力已满" };
  }
  const soldToday = Object.values(shop.accounts.day.soldUnits || {}).reduce((sum, value) => sum + Math.max(0, value || 0), 0);
  const remainingGoodsCapacity = Math.max(0, shopSalesCapacityUnits(state, shop, content) - soldToday);
  const actual = Math.min(quantity, remainingGoodsCapacity);
  if (actual <= 0) return { ok: false, reason: "今日接待能力已满" };  const paymentUnits = Math.round(actual / content.precision.inventoryUnitsPerJin * prices.retailVoucherPerUnit * currencyScale(content));
  const buyerHousehold = buyerHouseholdId ? state.households?.byId?.[buyerHouseholdId] : null;
  const wheatOptions = reserveWheatPaymentOptions(state, buyerHousehold, content, content.rules.basicCommerceFoodReserveDays ?? 30);
  // 镇营店的零售收入直接进镇库（付给 "town"），店里没有自己的钱。
  const payment = settleMonetaryPayment(state, buyerOwner, shopAccountName(shop), currentPaymentComposition(state, paymentUnits), content,
    "shop_retail_sale", reason, { requireFull: true, ...wheatOptions });
  if (!payment.ok) return payment;
  const cogs = removeShopInventoryCost(shop, itemId, actual);
  const pricingCogs = shop.town ? takePricingBasis(shop, itemId, shop.inventory[itemId] || 0, actual) : cogs;
  shop.inventory[itemId] -= actual;
  addBookValue(shop, "revenueVoucherUnits", paymentUnits);
  addBookValue(shop, "cogsVoucherUnits", cogs);
  addBookMap(shop, "soldUnits", itemId, actual);
  // 首次成交的家庭才记一个客人；非家庭买家（如公司、店铺）每笔照旧记一次。
  if (buyerHouseholdId) {
    const today = shop.accounts.day;
    if (!today.customerHouseholds?.[buyerHouseholdId]) {
      today.customerHouseholds ||= {};
      today.customerHouseholds[buyerHouseholdId] = true;
      bookAdd(shop.accounts, "customerCount", 1);
      // 同日较早因断货/限流被记为拒客、之后又在本店成交的家庭：撤销那一次拒客，避免同一家庭同时算成客人和拒客。
      if (today.rejectedHouseholds?.[buyerHouseholdId]) {
        delete today.rejectedHouseholds[buyerHouseholdId];
        bookAdd(shop.accounts, "rejectedCustomerCount", -1);
      }
    }
  } else {
    bookAdd(shop.accounts, "customerCount", 1);
  }
  applyProfit(shop, paymentUnits - cogs);
  // 0.2.3 动态加价：把这一笔成交记入按商品的利润率窗口（收入/进货成本/销量）。
  // 动态定价的成本口径用定价成本基础（镇营店按私营店同口径的进货价入账，见 addPricingBasis）；账上 COGS 仍是内部成本基础。
  recordShopItemSale(shop, itemId, actual, paymentUnits, pricingCogs, content);
  return { ok: true, itemId, quantityUnits: actual, paidVoucherUnits: paymentUnits, paidValueUnits: paymentUnits, cogsVoucherUnits: cogs, transactionId: payment.transactionId };
}

// 批量拒客计数（用户 0.1.11 原 i7）：把未满足的需求量（库存单位）折算成人次，
// 累加到日/年/累计三期 rejectedCustomerCount。
export function registerRejectedCustomers(state, shopId, units, content) {
  const shop = state.shops?.[shopId];
  if (!shop || shop.status !== "open" || !(units > 0)) return 0;
  const perCustomer = Math.max(1, shopJinPerCustomer(content) * content.precision.inventoryUnitsPerJin);
  const count = Math.ceil(units / perCustomer);
  bookAdd(shop.accounts, "rejectedCustomerCount", count);
  return count;
}

// 按家庭计的拒客（用户口径：一户一店一天最多算一个拒客，不论缺几样、缺多少）。
// 已在本店成交的家庭不算拒客；同一家庭当日在本店已记过的拒客不重复记。
export function registerRejectedHouseholds(state, shopId, householdIds, content) {
  const shop = state.shops?.[shopId];
  if (!shop || shop.status !== "open") return 0;
  ensureShopBooks(shop, content);
  const day = shop.accounts.day;
  let count = 0;
  for (const householdId of new Set(householdIds || [])) {
    if (!householdId || day.customerHouseholds?.[householdId] || day.rejectedHouseholds?.[householdId]) continue;
    day.rejectedHouseholds ||= {};
    day.rejectedHouseholds[householdId] = true;
    count += 1;
  }
  if (count > 0) bookAdd(shop.accounts, "rejectedCustomerCount", count);
  return count;
}

// 断货的未满足需求：居民想买、该店却已无货时记入当日口径，次日进货据此放量（不影响当日销量与收入）。
// 只记单位数；拒客人数由 registerRejectedHouseholds 按家庭计。单店当日记入量不超过其日接待能力，超出部分不是可实现的需求。
export function registerShopStockoutDemand(state, shopId, itemId, units, content) {
  const shop = state.shops?.[shopId];
  if (!shop || shop.status !== "open" || !(units > 0)) return 0;
  ensureShopBooks(shop, content);
  const count = Math.min(Math.floor(units), shopSalesCapacityUnits(state, shop, content));
  if (count <= 0) return 0;
  bookAddMap(shop.accounts, "stockoutUnits", itemId, count);
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
  const payment = settleMonetaryPayment(state, `household:${householdId}`, `shop:${shopId}`, currentPaymentComposition(state, priceUnits), content,
    "shop_service_sale", `${household.name}购买${service.name}`, { requireFull: true });
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

// 镇营综合商店从批发市场进货：市场 → 镇库 → 店，全部是镇里内部调拨（只搬货、不付钱），成本基础随货转移。
// 返回的 paidVoucherUnits 是这批货的内部成本（不是现金）；库存与成本由调用方用 putStock 入账。
// 同时记入批发市场的镇营需求（townConsumed），让做市商看见镇营店的进货量。
function procureTownStoreFromMarket(state, shop, itemId, wantedUnits, content) {
  const none = { boughtUnits: 0, paidVoucherUnits: 0, subsidyVoucherUnits: 0 };
  if (!hasWholesaleMarket(state) || !wholesaleMonopolyItemIds(content).includes(itemId) || !(wantedUnits > 0)) return none;
  // 供货份额上限：镇营店当日每种商品最多拿批发市场可售量（进货前的库存，镇营店先进货，即私营店尚未进货时的库存）的 supplyShareMax，余下留给私营店。
  const stock = Math.max(0, state.wholesaleMarket.inventory?.[itemId] || 0);
  const share = Math.min(1, Math.max(0, Number(content.rules.townShop?.supplyShareMax ?? 0.5)));
  const capUnits = Math.floor(stock * share);
  const askUnits = Math.min(Math.floor(wantedUnits), capUnits);
  if (askUnits <= 0) return none;
  const moved = allocateInputToTown(state, itemId, askUnits, content, `${shop.name}从批发市场进货（镇库内部调拨，不付钱）`);
  if (!moved.ok || !(moved.movedUnits > 0)) return none;
  const units = moved.movedUnits;
  const out = removeTownInventoryWithCost(state, itemId, units, content);
  recordLedger(state, { type: "town_store_restock", transactionId: makeTransactionId(state), source: "town", destination: `shop:${shop.id}`,
    itemId, quantityUnits: units, qeqUnits: 0, reason: `${shop.name}从镇库领货（内部调拨，不付钱）` }, content);
  recordTownInputConsumption(state, itemId, units, content);
  return { boughtUnits: units, paidVoucherUnits: out.costWheatUnits, subsidyVoucherUnits: 0 };
}

export function procureShopInventory(state, shop, content) {
  if (shop.status !== "open") return { purchasedUnits: 0, purchasedByItem: {}, reason: shop.status === "paused" ? "暂停经营" : "已停业" };
  if (shop.town && !shopMerchantOnDuty(state, shop)) return { purchasedUnits: 0, purchasedByItem: {}, reason: "无店员，暂不进货" };
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
      itemTargets.push({ itemId, targetUnits: Math.max(trial, Math.round(expected * targetDays)), dailyUnits: Math.round(expected) });
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
    // 综合商店和集市先从养殖场进肉，不够再找批发市场。
    const fromFarms = (def?.id === "general" || def?.kind === "stall") && content.items[row.itemId]?.livestock ? buyFromFarms(state, shop, row.itemId, need, content, row.dailyUnits) : 0;
    const purchase = need - fromFarms > 0
      ? (shop.town
        ? procureTownStoreFromMarket(state, shop, row.itemId, need - fromFarms, content)
        : buyWholesaleForOwner(state, `shop:${shop.id}`, row.itemId, need - fromFarms, content, `${shop.name}从批发市场进货`,
          { discountPerUnit: shop.collective ? stallDiscountPerUnit(state, content) : 0 }))
      : { boughtUnits: 0, paidVoucherUnits: 0 };
    if (purchase.subsidyVoucherUnits > 0) addBookValue(shop, "subsidyVoucherUnits", purchase.subsidyVoucherUnits);
    const bought = (purchase.boughtUnits || 0) + fromFarms;
    const wholesaleBought = purchase.boughtUnits || 0;
    if (wholesaleBought > 0) {
      putStock(shop, row.itemId, wholesaleBought, purchase.paidVoucherUnits || 0);
      addPricingBasis(shop, row.itemId, wholesaleValueUnits(state, row.itemId, wholesaleBought, content));
      // 镇营店的进货成本是镇库内部价，不是现金支出，不记入采购账。
      if (!shop.town) addBookValue(shop, "purchaseVoucherUnits", purchase.paidVoucherUnits || 0);
      addBookMap(shop, "purchasedUnits", row.itemId, wholesaleBought);
    }
    purchasedByItem[row.itemId] = bought;
    purchasedTotal += bought;
  }
  if (hadNeed && purchasedTotal <= 0) {
    // 基线清理：无批发市场时走镇库直购，缺货提示要准确。
    if (shop.town) shop.statusReason = hasWholesaleMarket(state) ? "批发市场缺货" : "尚未建成批发市场";
    else shop.statusReason = maximumPayableValueUnits(state, `shop:${shop.id}`, content) <= 0 ? "缺资金" : (hasWholesaleMarket(state) ? "批发市场缺货" : "镇库缺货");
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
  // 集体摊位的摊贩不领工资，分利润。
  const merchantWage = shop.collective ? 0 : Math.round(merchantAssignments
    .filter(row => row.householdId !== ownerId)
    .reduce((sum, row) => sum + row.count, 0) * merchantRate * scale);
  const clerkWage = Math.round(clerkAssignments.reduce((sum, row) => sum + row.count, 0) * clerkRate * scale);
  const wage = merchantWage + clerkWage;
  // 负值保护：租金/工资取max(0)，避免负负债（之前无保护）。
  const rentFree = shop.collective && stallRentFreeDaysLeft(state, content) > 0;
  const rentVoucher = rentFree ? 0 : shopKind(shop, content) === "stall"
    ? (state.policy?.stallRentVoucher ?? content.rules.stallRentDefaultVoucher ?? 2)
    : (state.policy?.shopRentVoucher ?? content.rules.shopRentDefaultVoucher ?? 1);
  // 集体摊位按占用的摊位数交租（每摊最多 2 人）。
  const rentUnits = shop.collective ? Math.ceil(shopMerchantCount(state, shop) / 2) : 1;
  // 镇营综合商店不交店租（镇库自己的店）。
  const rent = shop.town ? 0 : Math.max(0, Math.round(rentVoucher * rentUnits * scale));
  if (rentFree) addBookValue(shop, "rentWaivedVoucherUnits", Math.round((state.policy?.stallRentVoucher ?? content.rules.stallRentDefaultVoucher ?? 2) * rentUnits * scale));
  // 基线清理：店主本人的商人岗位不产生工资债权（拿利润）。
  if (!shop.collective) accrueWages(state, shop.liabilities, merchantAssignments.filter(row => row.householdId !== shop.ownerHouseholdId), merchantWage, content);
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
  // 营业中按发薪日结；暂停、清算、收摊（非营业）时所有待发工资立即到期，进入欠薪清偿顺序。
  // 镇营店的工资由镇库付（发薪日按镇库的 5 号）。
  const payer = shopAccountName(shop);
  const options = shop.status === "open" ? { payDay: payDayFor(state, payer) } : {};
  payWages(state, shop.liabilities, payer, content, "shop_wage_payment", `${shop.name}偿付具体债权家庭员工工资`, options);
  shop.liabilities.wageVoucherUnits = wageArrears(shop.liabilities);
  // 镇营店不交店租与利润税（镇库自己的店，钱本来就在镇库）。
  if (shop.town) return;
  payLiability(state, shop, "rentVoucherUnits", "town", content, "shop_rent_payment", `${shop.name}支付店租`);
  payLiability(state, shop, "taxVoucherUnits", "town", content, "shop_profit_tax_payment", `${shop.name}缴纳商业利润税`);
}

// 镇营综合商店的"结账"：收入已直接进镇库，店里没有留存现金，不交利润税、不分红。
// 留存利润（收入减进货成本与工资）按账记为已上缴镇库，留存额清零。
function settleTownShop(state, shop) {
  const remitted = shop.retainedEarningsVoucherUnits || 0;
  if (remitted) addBookValue(shop, "remittedVoucherUnits", remitted);
  shop.retainedEarningsVoucherUnits = 0;
  shop.settlement.days = 0;
  shop.settlement.profitVoucherUnits = 0;
  shop.settlement.lossCarryVoucherUnits = 0;
  shop.settlement.lastSettlementYear = state.year;
  shop.settlement.lastSettlementDay = state.day + 1;
  return { settled: true, periodProfitVoucherUnits: 0, taxVoucherUnits: 0, lossCarryVoucherUnits: 0, distributedVoucherUnits: 0,
    retainedEarningsVoucherUnits: 0, remittedVoucherUnits: remitted, reserveVoucherUnits: 0 };
}

export function settleShopTaxAndDistribution(state, shop, content, force = false, options = {}) {
  if (shop.town) return settleTownShop(state, shop);
  const interval = shopDefinition(content, shop.typeId)?.settlementDays || content.rules.shopSettlementDays || 30;
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
  // 月薪：已干活还没到发薪日的工资也要先留出来，不能当利润分走（否则发薪日付不起、欠薪关门）。
  const liabilities = (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0) + (shop.liabilities.taxVoucherUnits || 0)
    + pendingWages(shop.liabilities);
  const availableCash = options.allowDistribution === false ? 0 : Math.max(0, maximumPayableValueUnits(state, `shop:${shop.id}`, content) - reserve - liabilities);
  const distributable = options.allowDistribution === false ? 0 : maximumFullyPayableValueUnits(state, `shop:${shop.id}`,
    Math.min(Math.max(0, shop.retainedEarningsVoucherUnits || 0), availableCash), content);
  let distributed = 0;
  if (distributable > 0 && shop.collective) {
    distributed = distributeCollectiveProfit(state, shop, distributable, content);
  } else if (distributable > 0) {
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
  const limit = Math.max(14, (content.rules.operatingObservationDays || 7) * 4, content.rules.hiringDemandWindowDays || 60);
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
  // 镇营综合商店的店员由镇里设定（configureShopClerks），自动审核不覆盖。
  if (shop.town) return;
  const serial = (state.year - 1) * (content.rules.daysPerYear || 365) + state.day;
  // 正式员工：每月 1 号审核一次（新店第一次立即审核），一次最多增减一人。
  shop.plan ||= { lastAdjustedSerial: -1 };
  // 开张期（开店后 openingPeriodDays 天内）每天审核，尽快招够人。
  const opening = inOpeningPeriod(state, content, { year: shop.openedYear, day: (shop.openedDay ?? 1) - 1 });
  if (shop.plan.lastAdjustedSerial >= 0 && !opening && (state.day % (content.rules.monthDays || 30)) !== 0) return;
  shop.plan.lastAdjustedSerial = serial;
  const kind = shopKind(shop, content);
  if (kind === "stall") return;
  // 需求看过去 hiringDemandWindowDays（60）天；新店有 7 天记录就可以判断。
  const observation = Math.max(1, content.rules.hiringDemandWindowDays || 60);
  const history = (shop.history || []).slice(-observation);
  const minHistory = Math.min(observation, Math.max(1, content.rules.operatingObservationDays || 7));
  const current = shopClerkCount(state, shop);
  const wage = state.employment.wageRates?.shop_clerks ?? content.rules.shopClerkDefaultWageVoucher ?? 10;
  let target = current;
  let expected = 0;
  if (kind === "farm") {
    target = farmTargetHands(state, shop, content, history);
  } else if (kind === "trade") {
    target = tradeHouseTargetClerks(state, shop, content);
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
    if (history.length >= minHistory) {
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
      const markup = shopEffectiveMarginPercent(state, shop, content) / 100;
      const marginalJin = perStaff * shopJinPerCustomer(content);
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
      if (history.length >= minHistory && avgRejected > 0 && desiredClerks > current && profitable && funded) {
        target = Math.min(current + 1, desiredClerks);
      }
      if (history.length >= minHistory && current > 0 && avgRejected <= 0 && desiredClerks < current) target = current - 1;
      shop.plan.expectedDailyCustomers = expected;
      shop.plan.staffingDiagnosis = avgRejected > 0
        ? (!profitable ? "客流超载，但增员不盈利" : !funded ? "客流超载，资金不足暂不增员" : "客流超载，可增员")
        : (desiredClerks < current ? "客流下降，满30日后可减员" : "客流与用工匹配");
    } else {
      shop.plan.expectedDailySalesUnits = avgSalesUnits;
    }
  }
  // 平时一次最多增减一人；近 30 天亏损时可以一次辞退到需要的人数（仍须满 30 天、付得起补偿）。
  target = Math.max(recentlyLosing(shop) ? target : current - 1, Math.min(current + 1, target));
  // 付得起补偿才辞退（与 employment-contracts.js 的 reviewStaffing 同一规则）：一次辞几个人就要付得起几份补偿。
  if (target < current && !shop.collective) {
    const severance = Math.round(shopWage(state, shop, content) * Math.max(0, content.rules.severanceWageDays ?? 30) * currencyScale(content));
    if (severance > 0) target = Math.max(target, current - Math.floor(maximumPayableValueUnits(state, `shop:${shop.id}`, content) / severance));
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

// ---------------------------------------------------------------- 集体经营（时代广场）

// 建一个集体经营的店（不属于某一户）。镇库垫付启动资金，从利润里先还。
export function openCollectiveShop(state, building, typeId, content) {
  ensureShops(state, content);
  const def = shopDefinition(content, typeId);
  const shopId = `shop-${state.nextShopNumber++}`;
  const shop = {
    id: shopId, name: `${building.name || content.buildings[building.typeId]?.name || ""}集市`, buildingId: building.id, typeId,
    collective: true, primaryItemId: null, itemId: null, itemIds: [], serviceId: null, ownerHouseholdId: null,
    cashVoucherUnits: 0, inventory: emptyShopInventory(content), inventoryCostVoucherUnits: {},
    status: "open", statusReason: "准备营业", openedYear: state.year, openedDay: state.day + 1, badDays: 0,
    accounts: { day: blankShopPeriod(), year: blankShopPeriod(), cumulative: blankShopPeriod() },
    liabilities: { wageVoucherUnits: 0, rentVoucherUnits: 0, taxVoucherUnits: 0 },
    settlement: { days: 0, profitVoucherUnits: 0, lossCarryVoucherUnits: 0, lastTaxVoucherUnits: 0, lastSettlementYear: 0, lastSettlementDay: 0 },
    retainedEarningsVoucherUnits: 0, townAdvanceVoucherUnits: 0,
    initialCapital: { valueUnits: 0, voucherValueUnits: 0 }
  };
  state.shops[shopId] = shop;
  ensureShopBooks(shop, content);
  const advance = Math.round((def?.startupVoucher ?? 200) * currencyScale(content));
  const paid = settleMonetaryPayment(state, "town", `shop:${shopId}`, currentPaymentComposition(state, advance), content,
    "collective_shop_advance", `镇库垫付${shop.name}启动资金`, { requireFull: false });
  shop.townAdvanceVoucherUnits = paid.paidValueUnits || 0;
  return shop;
}

// 集市补贴：免租剩余天数、批发特价（每单位少收多少斤）。
export function stallRentFreeDaysLeft(state, content) {
  const serial = (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
  return Math.max(0, (state.policy?.stallRentFreeUntilSerial || 0) - serial);
}

export function stallDiscountPerUnit(state, content) {
  const tiers = content.rules.stallWholesaleDiscountTiers || [0];
  const tier = Math.max(0, Math.min(tiers.length - 1, Math.floor(state.policy?.stallDiscountTier || 0)));
  return tiers[tier] || 0;
}

// 集市没钱也没货、垫款已还清时，镇库再垫一次启动资金，避免永久停摆。
export function refundCollectiveIfStranded(state, shop, content) {
  if (!shop?.collective || (shop.townAdvanceVoucherUnits || 0) > 0) return false;
  const stock = shopRetailItemIds(shop, content).reduce((sum, itemId) => sum + (shop.inventory?.[itemId] || 0), 0);
  const cash = maximumPayableValueUnits(state, `shop:${shop.id}`, content);
  const advance = Math.round((shopDefinition(content, shop.typeId)?.startupVoucher ?? 200) * currencyScale(content));
  if (stock > 0 || cash >= advance / 4) return false;
  const paid = settleMonetaryPayment(state, "town", `shop:${shop.id}`, currentPaymentComposition(state, advance), content,
    "collective_shop_advance", `镇库再次垫付${shop.name}周转金`, { requireFull: false });
  shop.townAdvanceVoucherUnits = paid.paidValueUnits || 0;
  return shop.townAdvanceVoucherUnits > 0;
}

// 广场拆除时结束集市：结清欠款、先还镇库垫款、余钱按人头分给摆摊家庭、剩货归镇库，然后删档。
export function windUpCollectiveShop(state, shop, content) {
  if (!shop?.collective) return false;
  payDailyLiabilities(state, shop, content);
  const cash = maximumFullyPayableValueUnits(state, `shop:${shop.id}`, maximumPayableValueUnits(state, `shop:${shop.id}`, content), content);
  if (cash > 0) distributeCollectiveProfit(state, shop, cash, content);
  setJobCount(state, merchantJobKey(shop), 0, null);
  for (const [itemId, units] of Object.entries(shop.inventory || {})) {
    if (units <= 0) continue;
    state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + units;
    shop.inventory[itemId] = 0;
  }
  const leftover = maximumPayableValueUnits(state, `shop:${shop.id}`, content);
  if (leftover > 0) settleMonetaryPayment(state, `shop:${shop.id}`, "town", currentPaymentComposition(state, leftover), content,
    "collective_shop_close", `${shop.name}结束，余款归镇库`, { requireFull: false });
  delete state.shops[shop.id];
  return true;
}

// 集体利润分配：先还镇库垫款，余下按各户在摊人数 ×（0.8—1.2 随机）分给摆摊家庭。返回分出去的总额（含还款）。
function distributeCollectiveProfit(state, shop, amount, content) {
  let left = amount;
  let paidOut = 0;
  const owed = shop.townAdvanceVoucherUnits || 0;
  if (owed > 0) {
    const repay = Math.min(owed, left);
    const result = settleMonetaryPayment(state, `shop:${shop.id}`, "town", currentPaymentComposition(state, repay), content,
      "collective_shop_repay", `${shop.name}归还镇库垫款`, { requireFull: true });
    // 还垫款是还债，不是分利润，不动未分配利润。
    if (result.ok) { shop.townAdvanceVoucherUnits = owed - repay; left -= repay; paidOut += repay; }
  }
  const rows = jobAssignments(state, merchantJobKey(shop)).filter(row => row.count > 0)
    .map(row => ({ householdId: row.householdId, count: row.count, weight: row.count * (0.8 + 0.4 * nextRandom(state)) }));
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (left <= 0 || !rows.length || totalWeight <= 0) return paidOut;
  let assigned = 0;
  const payouts = [];
  rows.forEach((row, index) => {
    const share = index === rows.length - 1 ? left - assigned : Math.floor(left * row.weight / totalWeight);
    assigned += share;
    if (share <= 0) return;
    const result = settleMonetaryPayment(state, `shop:${shop.id}`, `household:${row.householdId}`, currentPaymentComposition(state, share), content,
      "collective_profit_share", `${shop.name}给摆摊家庭分利润`, { requireFull: true });
    if (!result.ok) return;
    paidOut += share;
    shop.retainedEarningsVoucherUnits -= share;
    addBookValue(shop, "distributedVoucherUnits", share);
    payouts.push(share / row.count);
  });
  if (payouts.length) shop.plan.lastPayout = {
    households: payouts.length,
    minPerKeeperUnits: Math.min(...payouts), maxPerKeeperUnits: Math.max(...payouts),
    averagePerKeeperUnits: payouts.reduce((a, b) => a + b, 0) / payouts.length
  };
  return paidOut;
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
  // 卖给商店和批发市场（摊位、外贸从那里拿货）都算需求。
  const avgSold = history.length ? history.reduce((sum, row) => sum + Math.max(0, row.soldUnitsByItem?.[def.productItemId] || 0), 0) / history.length : 0;
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
  // 正式员工辞退要付一个月补偿：需求明显不足（低于产能 70%）才减人，免得随存货波动反复招辞。
  else if (desiredOutput < output * 0.7 && current > 0) target = recentlyLosing(shop) ? desiredHands : Math.max(desiredHands, current - 1);
  // 只在多雇一人划算（每人产值减饲料高于日薪）且资金够付 3 天工资时加人。
  const wage = shopWage(state, shop, content);
  const marginJin = def.outputPerWorkerDay * (farmSalePriceVoucher(state, shop, content) - def.feedPerUnit * currentUnitPrice(state, def.feedItemId, content));
  const fundsVoucher = maximumPayableValueUnits(state, `shop:${shop.id}`, content) / currencyScale(content);
  // 资金闸门：钱够付新增人手 3 天工资才加人；商店有缺货时钱不够也可以加一人（工资月结，先干活卖了肉再发），免得没人干活→没收入→招不了人的死锁。
  if (target > current && marginJin <= wage) target = current;
  else if (target > current && fundsVoucher < (target - current) * wage * 3) target = avgUnmet > 0 ? current + 1 : current;
  shop.plan.expectedDailySalesUnits = avgSold;
  shop.plan.staffingDiagnosis = target > current ? "供不应求，加人" : target < current ? "存货积压，减人" : "产销平衡";
  return target;
}

// 近 30 天是否亏损（正式员工：亏损的雇主可以一次辞退多余的人）。
function recentlyLosing(shop) {
  const rows = (shop.history || []).slice(-30);
  if (rows.length < 7) return false;
  return rows.reduce((sum, row) => sum + (Number(row.profitVoucherUnits) || 0), 0) < 0;
}

// 贸易行店员目标（与商业街店铺一样自己增减人）：看近 7 天成交额度用了多少。
// 额度用满（≥85%）、额度卡在人手上（没到运力份额）、多一人的成交利润高于日薪且付得起 3 天工资 → 加人（每周期最多 +2）；
// 用不到 40% 或亏损 → 减一人；7 天一笔买卖都没有则不减员（由暂停机制处理）。
// 贸易行店员规则（docs/TRADE.md）：
//   人手是否卡住成交，看"当日可做上限 capJin"（成交 + 收市后仍能做的买卖，人手不限）与人手预算 budgetJin 的关系：
//   - 上限 > 预算 且 预算已用满（≥85%）→ 人手卡住：增员（每次最多 2 人，月初审核一次只加一人）。
//     若预算已到运力份额（预算 ≥ 份额）→ 运力份额满，加人无用；若预算没用满 → 配额或运力卡住，不加人。
//   - 上限 ≤ 预算 → 货源/配额/运力已用完，不因成交利用率低而减员（货源不足不是人手的错）。
//   - 亏损且高于店员下限 → 减一人。
//   - 店员下限 = min(2, 开店时的初始配置)：只防止减员过度，不因此强制加人。
// 旧日志没有 capJin 的，上限回落为成交量（即只看不卡人手，不会加人）。
function tradeHouseTargetClerks(state, shop, content) {
  const observation = Math.max(1, content.rules.operatingObservationDays || 7);
  const rows = (shop.tradeLog || []).slice(-observation);
  const current = shopClerkCount(state, shop);
  shop.plan ||= {};
  // 开店时的店员配置记为初始配置（只记一次）。
  shop.plan.initialClerks ??= current;
  const floor = Math.min(current, 2, shop.plan.initialClerks);
  if (rows.length < observation) {
    shop.plan.staffingDiagnosis = "观察中";
    return current;
  }
  const avg = key => rows.reduce((sum, row) => sum + Math.max(0, Number(row[key]) || 0), 0) / rows.length;
  const used = avg("usedJin");
  const budget = avg("budgetJin");
  const share = avg("shareJin");
  const cap = rows.reduce((sum, row) => {
    const usedRow = Math.max(0, Number(row.usedJin) || 0);
    return sum + Math.max(usedRow, Number(row.capJin ?? usedRow) || 0);
  }, 0) / rows.length;
  const profitVoucher = rows.reduce((sum, row) => sum + (Number(row.profitVoucherUnits) || 0), 0) / rows.length / currencyScale(content);
  const perClerk = content.rules.tradeHouseJinPerClerk ?? 300;
  const wage = shopWage(state, shop, content);
  const budgetUse = budget > 0 ? used / budget : 0;
  const marginalProfit = used > 0 ? profitVoucher / used * perClerk : 0;
  // 可动用资金含店里的支付小麦（贸易行出口收的是小麦）。
  const fundsVoucher = maximumPayableValueUnits(state, `shop:${shop.id}`, content) / currencyScale(content);
  const add = Math.min(2, content.rules.operatingWorkerAdjustMaxPerCycle || 2);
  let target = current;
  let diagnosis = "生意与人手匹配";
  if (used <= 0) {
    // 没有买卖时不减员：连续 tradeHousePauseDays 天无买卖且亏损由 trading-houses.js 暂停营业（暂停即遣散店员，不再逐月减到清算）。
    diagnosis = "暂无可做的买卖，待满暂停期限";
  } else if (profitVoucher < 0 && current > floor) {
    target = current - 1;
    diagnosis = "亏损，减人";
  } else if (cap > budget + 1e-6) {
    // 可做的买卖比人手预算多：看是不是人手卡住。
    if (budget + 1e-6 >= share) diagnosis = "运力份额已满，加人无用";
    else if (budgetUse < 0.85) diagnosis = "配额或运力卡住，人手不是瓶颈";
    else if (marginalProfit <= wage) diagnosis = "生意做不完，但增员不盈利";
    else if (fundsVoucher < (current + add) * wage * 3) diagnosis = "生意做不完，资金不足暂不加人";
    else {
      target = current + add;
      diagnosis = "生意做不完，加人";
    }
  } else {
    diagnosis = "货源或配额已用完，人手不减";
  }
  target = Math.max(floor, target);
  shop.plan.staffingDiagnosis = diagnosis;
  shop.plan.expectedDailyTradeJin = used;
  return target;
}

// 综合商店向养殖场进货：先买最便宜的场（同价先买存货多的），每场按自己的定价（farm-pricing.js）。返回买到的库存单位。
function buyFromFarms(state, store, itemId, wantedUnits, content, dailyUnits = wantedUnits) {
  const farms = Object.values(state.shops || {}).filter(shop => shop.status === "open"
    && shopDefinition(content, shop.typeId)?.kind === "farm" && (shop.inventory?.[itemId] || 0) > 0)
    .map(farm => ({ farm, price: farmSalePriceVoucher(state, farm, content) }))
    .sort((a, b) => a.price - b.price || (b.farm.inventory[itemId] || 0) - (a.farm.inventory[itemId] || 0) || a.farm.id.localeCompare(b.farm.id));
  let bought = 0;
  for (const { farm, price } of farms) {
    const left = wantedUnits - bought;
    if (left <= 0) break;
    if (!(price > 0)) continue;
    const affordable = Math.floor(maximumPayableValueUnits(state, shopAccountName(store), content) * content.precision.inventoryUnitsPerJin / (price * currencyScale(content)));
    const units = Math.min(left, farm.inventory[itemId] || 0, affordable);
    if (units <= 0) break;
    const value = Math.round(units / content.precision.inventoryUnitsPerJin * price * currencyScale(content));
    const payment = settleMonetaryPayment(state, shopAccountName(store), `shop:${farm.id}`, currentPaymentComposition(state, value), content,
      "farm_sale", `${store.name}向${farm.name}进${content.items[itemId]?.name || itemId}`, { requireFull: true });
    if (!payment.ok) break;
    const cogs = removeShopInventoryCost(farm, itemId, units);
    farm.inventory[itemId] -= units;
    addBookValue(farm, "revenueVoucherUnits", value);
    addBookValue(farm, "cogsVoucherUnits", cogs);
    addBookMap(farm, "soldUnits", itemId, units);
    addBookMap(farm, "storeSoldUnits", itemId, units);
    applyProfit(farm, value - cogs);
    putStock(store, itemId, units, value);
    addPricingBasis(store, itemId, value);
    addBookValue(store, "purchaseVoucherUnits", value);
    addBookMap(store, "purchasedUnits", itemId, units);
    bought += units;
  }
  // 商店没买够：把缺口记到经营这种肉的养殖场上，养殖场据此加人。
  // 只记一天的量：进货目标含几天备货，开张头几天全记成缺口会让养殖场按几倍需求招人。
  const unmet = Math.min(wantedUnits - bought, Math.max(0, dailyUnits));
  const producers = Object.values(state.shops || {}).filter(shop => shop.status === "open" && shopDefinition(content, shop.typeId)?.productItemId === itemId);
  if (unmet > 0 && producers.length) for (const farm of producers) addBookMap(farm, "unmetUnits", itemId, Math.floor(unmet / producers.length));
  return bought;
}

export function prepareShopsForDay(state, content) {
  ensureShops(state, content);
  // 业主已失效的店铺先交接（旧档里已被暂停的孤儿店也在这里恢复），再做日常同步。
  succeedOrphanShops(state, content);
  syncShopEmployment(state, content);
  const operating = Object.values(state.shops).filter(shop => shop.status === "open");
  const paused = Object.values(state.shops).filter(shop => shop.status === "paused");
  for (const shop of operating) autoAdjustShopClerks(state, shop, content);
  syncShopEmployment(state, content);
  const rows = [];
  // 集市先进货：它卖得少（摊位人手封顶），先拿一点养殖场的肉；综合商店需求大，排在后面会把肉全包走、集市进不到货。
  // 镇营综合商店最先进货（镇里的店，进货优先于私营店）；其次集市。
  const procureRank = shop => (shop.town ? 0 : shopKind(shop, content) === "stall" ? 1 : 2);
  const procureOrder = [...operating].sort((a, b) => procureRank(a) - procureRank(b));
  for (const shop of procureOrder) {
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
  // 清算中的店铺每天都要推进（closeShop 的清算逻辑：能付的先付，满 30 天仍欠账则核销关门）。
  // 名单在营业店结账前取，今天才转入清算的店已在营业循环里处理过，不重复推进。
  const liquidating = Object.values(ensureShops(state, content)).filter(shop => shop.status === "liquidating");
  const rows = [];
  for (const shop of Object.values(ensureShops(state, content)).filter(shop => shop.status === "open")) {
    payDailyLiabilities(state, shop, content);
    const sold = Object.values(shop.accounts.day.soldUnits || {}).reduce((sum, units) => sum + units, 0);
    const serviceUses = Object.values(shop.accounts.day.serviceUses || {}).reduce((sum, uses) => sum + uses, 0);
    const activity = sold + serviceUses;
    const arrears = (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0) + (shop.liabilities.taxVoucherUnits || 0);
    const farmDef = shopKind(shop, content) === "farm" ? shopDefinition(content, shop.typeId) : null;
    // 贸易行没有零售货架，不计存货。
    const tradeHouse = shopKind(shop, content) === "trade";
    const retailStock = farmDef
      ? (shop.inventory[farmDef.productItemId] || 0) + (shop.inventory[farmDef.feedItemId] || 0)
      : shopRetailItemIds(shop, content).reduce((sum, itemId) => sum + (shop.inventory[itemId] || 0), 0);
    const noOperatingAssets = shopIsService(shop, content) ? false : retailStock <= 0;
    // 贸易行不因无生意而累计坏日子：连续 tradeHousePauseDays 天无买卖且亏损由 trading-houses.js 暂停营业，暂停中不进清算。
    // 镇营综合商店不因连续无生意累计坏日子（不自动关店，由玩家关）。
    if (tradeHouse || shop.town) shop.badDays = 0;
    else if (activity <= 0 && (noOperatingAssets || maximumPayableValueUnits(state, `shop:${shop.id}`, content) <= 0 || arrears > 0)) shop.badDays = (shop.badDays || 0) + 1;
    else if (activity > 0 || arrears <= 0) shop.badDays = 0;
    const settlement = settleShopTaxAndDistribution(state, shop, content, forceSettlement);
    if ((shop.liabilities.wageVoucherUnits || 0) > 0) shop.statusReason = "欠薪";
    else if (maximumPayableValueUnits(state, shopAccountName(shop), content) <= 0 && arrears > 0) shop.statusReason = "资金不足";
    else if (shopKind(shop, content) === "trade") shop.statusReason = activity > 0 ? "营业中" : "暂无可做的买卖";
    else if (!shopIsService(shop, content) && retailStock <= 0) shop.statusReason = "缺货";
    else if (activity <= 0) shop.statusReason = shopIsService(shop, content) ? "需求不足" : "销量不足";
    else shop.statusReason = "营业中";
    if (!shop.collective && !shop.town && shop.badDays >= (content.rules.shopClosureBadDays || 30) && activity <= 0) {
      const closing = closeShop(state, shop.id, content, true);
      rows.push({ shopId: shop.id, closed: true, liquidationPending: closing.liquidationPending, settlement });
    } else rows.push({ shopId: shop.id, closed: false, settlement });
  }
  for (const shop of Object.values(state.shops).filter(shop => shop.status === "paused")) {
    payDailyLiabilities(state, shop, content);
    rows.push({ shopId: shop.id, closed: false, paused: true, settlement: { settled: false } });
  }
  for (const shop of liquidating) {
    const closing = closeShop(state, shop.id, content, true);
    rows.push({ shopId: shop.id, closed: closing.liquidationPending === false, liquidating: true,
      liquidationPending: closing.liquidationPending, settlement: { settled: false } });
  }
  syncShopEmployment(state, content);
  return rows;
}

export function resetShopYear(state, content) {
  for (const shop of Object.values(ensureShops(state, content))) shop.accounts.year = blankShopPeriod();
}

function shopLiabilityTotal(shop) {
  // 待发工资也是负债（清算时会到期），不能让店带着未发工资关门。
  return (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0) + (shop.liabilities.taxVoucherUnits || 0)
    + pendingWages(shop.liabilities);
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
  const voucherValue = shop.cashVoucherUnits || 0;
  if (voucherValue > 0) {
    const returned = settleMonetaryPayment(state, `shop:${shop.id}`, `household:${owner.id}`,
      currentPaymentComposition(state, voucherValue), content,
      "shop_close_distribution", `${shop.name}清算完成后返还剩余资金`,
      { requireFull: true });
    if (!returned.ok) return false;
  }
  shop.status = "closed";
  shop.statusReason = "清算完成，已停业";
  syncResidentAggregates(state, content);
  return true;
}

// 镇营综合商店停业（玩家关店）：店员释放（不付辞退补偿，同其他店铺停业）；欠薪立即由镇库偿付，
// 付不起的记为镇库欠家庭（household.townOwesVoucherUnits，之后镇库有钱就还）；库存归镇库，成本随货转移。
// 镇营店没有自己的钱，所以不进清算。
function windUpTownShop(state, shop, content) {
  setJobCount(state, merchantJobKey(shop), 0, null);
  setJobCount(state, clerkJobKey(shop), 0, null);
  shop.status = "closed";
  shop.statusReason = "已停业，库存归镇库";
  payDailyLiabilities(state, shop, content);
  for (const [householdId, due] of Object.entries(shop.liabilities.claimsVoucherUnits || {})) {
    const household = state.households?.byId?.[householdId];
    if (!(due > 0) || !household) continue;
    household.townOwesVoucherUnits = (household.townOwesVoucherUnits || 0) + due;
    delete shop.liabilities.claimsVoucherUnits[householdId];
    if (shop.liabilities.claimsPayment) delete shop.liabilities.claimsPayment[householdId];
  }
  shop.liabilities.wageVoucherUnits = wageArrears(shop.liabilities);
  for (const [itemId, units] of Object.entries(shop.inventory || {})) {
    if (!(units > 0)) continue;
    const taken = takeStock(shop, itemId, units, { strict: true });
    state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + taken.units;
    addTownCostBasis(state, itemId, Math.max(0, Math.floor(taken.costUnits)));
    recordLedger(state, { type: "town_store_stock_return", transactionId: makeTransactionId(state), source: `shop:${shop.id}`, destination: "town",
      itemId, quantityUnits: taken.units, qeqUnits: 0, reason: `${shop.name}停业，库存归镇库` }, content);
  }
  shop.pricingBasisVoucherUnits = {};
  syncShopEmployment(state, content);
  recordEvent(state, `${shop.name}停业，库存归镇库。`, content, { day: state.day + 1 });
  return { ok: true, shopId: shop.id, liquidationPending: false, status: shop.status, liabilitiesVoucherUnits: shopLiabilityTotal(shop) };
}

export function closeShop(state, shopId, content, automatic = false) {
  const shop = ensureShops(state, content)[shopId];
  if (!shop) return { ok: false, reason: "店铺不存在" };
  if (shop.status === "closed") return { ok: true, shopId, alreadyClosed: true, liquidationPending: false };
  if (shop.town) return windUpTownShop(state, shop, content);
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
  // 旧档的清算店铺可能没有起算日：从读到的这一天起重新计 30 天，不能因缺字段立即核销。
  if (shop.status === "liquidating" && !Number.isFinite(shop.liquidatingSinceSerial)) shop.liquidatingSinceSerial = shopSerial(state, content);
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
    const prices = primary ? shopTradePrices(state, shop.typeId, content, primary, shop) : null;
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
      const itemPrices = shopTradePrices(state, shop.typeId, content, itemId, shop);
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
    else if (shop.status === "paused") operatingStatus = shop.tradePause ? "暂无可做的买卖，已暂停" : "商人缺位，店员已遣散";
    else if ((shop.liabilities.wageVoucherUnits || 0) > 0) operatingStatus = "欠薪";
    else if ((shop.liabilities.rentVoucherUnits || 0) > 0 || (shop.liabilities.taxVoucherUnits || 0) > 0) operatingStatus = "资金不足";
    else if (Number.isFinite(shop.plan?.targetClerks) && shop.plan.targetClerks > shopClerkCount(state, shop)) operatingStatus = "缺员工";
    else if (kind === "service" && avgServiceUses <= 0) operatingStatus = "需求不足";
    else if (kind === "retail" && avgSalesUnits <= 0) operatingStatus = "暂无销量";
    else if (Number.isFinite(shop.plan?.targetClerks) && shop.plan.targetClerks < shopClerkCount(state, shop)) operatingStatus = "用工偏多";
    return {
      id: shop.id, name: shop.name, buildingId: shop.buildingId, typeId: shop.typeId, typeName: def?.name || shop.typeId, kind, collective: Boolean(shop.collective), town: Boolean(shop.town),
      itemId: primary, itemName: primary ? (content.items[primary]?.name || primary) : "", itemIds, inventoryRows, serviceId,
      serviceName: serviceId ? (content.rules.serviceTypes?.[serviceId]?.name || serviceId) : null,
      ownerHouseholdId: shop.ownerHouseholdId, ownerName: shop.town ? "镇库" : (state.households?.byId?.[shop.ownerHouseholdId]?.name || shop.ownerHouseholdId), merchantHouseholdId: shop.ownerHouseholdId, merchantOnDuty: shopMerchantOnDuty(state, shop),
      merchants: shopMerchantCount(state, shop), maxMerchants: shopMaxMerchants(shop, content),
      clerks: shopClerkCount(state, shop), maxClerks: shopClerkLimit(shop, content), occupiesStreet: shopOccupiesStreet(shop),
      cashVoucher: shop.cashVoucherUnits / scale,
      // 镇营店没有自己的钱（收入在镇库），可支付资金记 0。
      cashValue: shop.town ? 0 : maximumPayableValueUnits(state, `shop:${shop.id}`, content) / scale, inventory: stockUnits / invScale,
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

// 时代广场总览（只读）：每座广场的集体摊位一张卡片。
export function stallSquareSummaries(state, content, summaries = shopSummaries(state, content)) {
  const limit = Math.max(0, Math.floor(state.policy?.stallKeeperLimit ?? content.rules.stallKeeperDefaultLimit ?? 50));
  const scale = currencyScale(content);
  const invScale = content.precision.inventoryUnitsPerJin;
  const def = content.rules.shopTypes?.stall;
  return (state.buildings || []).filter(building => building.typeId === "times_square").map(building => {
    const row = summaries.find(item => item.kind === "stall" && item.buildingId === building.id && item.collective && item.status !== "closed") || null;
    const source = row ? state.shops?.[row.id] : null;
    const keepers = row?.merchants || 0;
    const payout = source?.plan?.lastPayout || null;
    return {
      buildingId: building.id, shopId: row?.id || null, slots: shopHostSlots(building, content),
      stallsUsed: Math.ceil(keepers / 2), keepers, keeperLimit: limit, keeperCap: Math.min(limit, shopHostSlots(building, content) * 2),
      rentVoucher: state.policy?.stallRentVoucher ?? content.rules.stallRentDefaultVoucher ?? 2,
      perKeeperSalesJin: def?.perKeeperSalesJin ?? 25, capacityJin: row?.capacityJin || 0,
      soldDayJin: row?.soldDayJin || 0, averageDailySalesJin: row?.averageDailySales || 0,
      revenueDayVoucher: row?.revenueDayVoucher || 0, rentDayVoucher: row?.rentDayVoucher || 0,
      profitDayVoucher: row?.profitDayVoucher || 0, averageDailyProfitVoucher: row?.averageDailyProfitVoucher || 0,
      distributedDayVoucher: (source?.accounts?.day?.distributedVoucherUnits || 0) / scale,
      distributedTotalVoucher: (source?.accounts?.cumulative?.distributedVoucherUnits || 0) / scale,
      payout: payout ? { households: payout.households, min: payout.minPerKeeperUnits / scale, max: payout.maxPerKeeperUnits / scale, average: payout.averagePerKeeperUnits / scale } : null,
      townAdvanceVoucher: (source?.townAdvanceVoucherUnits || 0) / scale,
      rentFreeDaysLeft: stallRentFreeDaysLeft(state, content),
      rentFreeOptionsDays: [...(content.rules.stallRentFreeOptionsDays || [])],
      discountTier: Math.max(0, Math.floor(state.policy?.stallDiscountTier || 0)),
      discountTiers: [...(content.rules.stallWholesaleDiscountTiers || [0])],
      rentWaivedTotalVoucher: (source?.accounts?.cumulative?.rentWaivedVoucherUnits || 0) / scale,
      subsidyTotalVoucher: (source?.accounts?.cumulative?.subsidyVoucherUnits || 0) / scale,
      subsidyDayVoucher: (source?.accounts?.day?.subsidyVoucherUnits || 0) / scale,
      inventoryRows: (row?.inventoryRows || []).filter(item => item.stock > 0 || item.averageDailySales > 0),
      statusReason: row?.statusReason || "未开放摆摊",
      stockJin: (row?.inventoryRows || []).reduce((sum, item) => sum + item.stock, 0),
      cashVoucher: row?.cashValue || 0
    };
  });
}

