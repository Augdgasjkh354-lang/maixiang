// 综合商店动态加价（0.2.3 流通改革，v1 只做综合商店）。
//
// 用户拍板：
// - 目标利润率默认 20%（政策 shopMarginPercent 可调 0~200%），未单独设置的店跟随全局；单店可覆盖（margin-policy.js）。
// - 改目标不跳价：按 7 天复核、价格每次最多 ±10% 平滑追上（shop.pricing.glidePercent 记过渡中的目标）。
// - 定价公式：售价 = 进货价 × (1 + 目标利润率)。
// - 7 天复核一次：实际利润率连续偏离目标超过 ±3% 才调价；单次涨跌幅 ≤ ±10%；售价下限不低于进货价。
// - 利润率口径：(销售收入 − 进货成本 − 店员工资) / 销售收入，按商品核算。
// - 需求弹性：相对过去 30 天均价每贵 10%，购买量降 5%（系数可调）。
// - 亏损保护：连续 30 天亏损 → 促销模式（目标利润率临时降至 5% 清库存）+ 向玩家发预警事件。
//
// 设计取舍：
// - 目标利润率是"店铺级"设置（单店覆盖 shop.pricing.targetMarginPercent，或跟随全局政策），
//   但实际利润率与调价决策是"按商品"的（每个商品有独立的进货价与售价）。
// - 其他小店（legacy 别名店）沿用 content.rules.generalStoreMarkupPercent 固定加价，不受本模块影响。
// - 所有新字段一律 ||= 初始化。

import { recordEvent } from "../economy/ledger.js";
import { currentUnitPrice } from "../economy/prices.js";
import { nextPriceFactor, priceFactorOf, retailFloorOf, stockDaysOf } from "../economy/price-adjust.js";
import { glideStepMarginPercent, pinGlideBeforeChange, policyShopMarginPercent, promotionMarginPercent,
  shopConfiguredMarginPercent, shopEffectiveMarginPercent, shopInForceMarginPercent, shopOverrideMarginPercent, MARGIN_POLICY_MAX_PERCENT } from "../economy/margin-policy.js";

export const PRICING_REVIEW_INTERVAL_DAYS = 7;
export const PRICING_DEVIATION_TOLERANCE_PERCENT = 3;
export const PRICING_MAX_STEP_PERCENT = 10;
export const LOSS_PROMOTION_DAYS = 30;
export const LOSS_PROMOTION_TARGET_PERCENT = 5;
export function promotionTargetMarginPercent(content) {
  return promotionMarginPercent(content);
}
export const PRICE_HISTORY_WINDOW_DAYS = 30;

export function isDynamicPricingShop(shop, content) {
  const raw = content.rules.shopTypes?.[shop?.typeId];
  const def = raw?.aliasOf ? content.rules.shopTypes?.[raw.aliasOf] : raw;
  return def?.id === "general";
}

// 定价使用的目标利润率（%）：促销模式优先；否则生效中的目标（玩家设定的单店覆盖或全局默认，平滑过渡中可能尚未追平）。
export function shopTargetMarginPercent(state, shop, content) {
  return shopEffectiveMarginPercent(state, shop, content);
}

// 玩家命令：设置某综合商店的单店目标利润率（0~200%）；percent 为 null 时取消单店设置，改为跟随全局默认。
// 改目标不立即改价：先记下生效中的目标（pinGlideBeforeChange），之后每次复核按价格 ±10% 平滑追上。
export function setShopTargetMarginPercent(state, shopId, percent, content) {
  const shop = state.shops?.[shopId];
  if (!shop) return { ok: false, reason: "店铺不存在" };
  if (!isDynamicPricingShop(shop, content)) return { ok: false, reason: "只有综合商店支持目标利润率定价" };
  shop.pricing ||= {};
  if (percent === null) {
    pinGlideBeforeChange(state, shop, content);
    shop.pricing.targetMarginOwn = false;
    shop.pricing.lastReviewSerial = -1;
    return { ok: true, shopId, followsPolicy: true, targetMarginPercent: policyShopMarginPercent(state, content) };
  }
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > MARGIN_POLICY_MAX_PERCENT) return { ok: false, reason: "目标利润率须在0—200%之间" };
  pinGlideBeforeChange(state, shop, content);
  shop.pricing.targetMarginOwn = true;
  shop.pricing.targetMarginPercent = Math.round(value * 100) / 100;
  // 目标变了允许下一次复核立即开始追价（仍按步幅限制）。
  shop.pricing.lastReviewSerial = -1;
  return { ok: true, shopId, targetMarginPercent: shop.pricing.targetMarginPercent };
}

// 全镇统一设置目标利润率（"应用到所有综合商店"）：把每家综合商店都设为单店覆盖值。
export function setAllShopsTargetMarginPercent(state, percent, content) {
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > MARGIN_POLICY_MAX_PERCENT) return { ok: false, reason: "目标利润率须在0—200%之间" };
  let updated = 0;
  for (const shop of Object.values(state.shops || {})) {
    if (shop.status === "closed") continue;
    if (!isDynamicPricingShop(shop, content)) continue;
    pinGlideBeforeChange(state, shop, content);
    shop.pricing.targetMarginOwn = true;
    shop.pricing.targetMarginPercent = Math.round(value * 100) / 100;
    shop.pricing.lastReviewSerial = -1;
    updated += 1;
  }
  return { ok: true, targetMarginPercent: Math.round(value * 100) / 100, shops: updated };
}

function emptyItemMap(content) {
  return Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
}

// 店铺定价状态初始化（||= 幂等，新档/旧档都安全）。
export function ensureShopPricing(shop, content) {
  shop.pricing ||= {};
  // 目标利润率不再在这里烘焙默认值：未单独设置的店跟随全局政策（见 economy/margin-policy.js）。
  shop.pricing.lastReviewSerial ??= -1;
  shop.pricing.promotion ??= false;
  shop.pricing.lossStreakDays ??= 0;
  // 按商品的 7 天经营窗口：收入 / 进货成本 / 店员工资 / 销量 / 售价历史。
  shop.pricing.itemWindows ||= {};
  shop.pricing.itemPrices ||= {};
  shop.pricing.itemWageCost ||= emptyItemMap(content);
  shop.pricing.itemRevenue ||= emptyItemMap(content);
  shop.pricing.itemCogs ||= emptyItemMap(content);
  shop.pricing.itemSoldUnits ||= emptyItemMap(content);
  shop.pricing.windowDays ??= 0;
  // 物价会动：按商品的库存系数（缺省 1）、系数原因、是否处于清库存（允许降到进货价 × minFactor）。
  shop.pricing.priceFactor ||= {};
  shop.pricing.priceFactorReason ||= {};
  shop.pricing.priceClearance ||= {};
  return shop.pricing;
}

// 记录一次零售成交到定价窗口（按商品）。由 sellShopProduct 调用。
// 口径：收入 = 实收粮券；进货成本 = 该笔出库的移动平均成本；店员工资按销量比例分摊。
export function recordShopItemSale(shop, itemId, quantityUnits, revenueVoucherUnits, cogsVoucherUnits, content) {
  const pricing = ensureShopPricing(shop, content);
  pricing.itemRevenue[itemId] = (pricing.itemRevenue[itemId] || 0) + Math.max(0, revenueVoucherUnits || 0);
  pricing.itemCogs[itemId] = (pricing.itemCogs[itemId] || 0) + Math.max(0, cogsVoucherUnits || 0);
  pricing.itemSoldUnits[itemId] = (pricing.itemSoldUnits[itemId] || 0) + Math.max(0, quantityUnits || 0);
}

// 把当日店员工资按各商品销量占比分摊进定价窗口（工资是利润率口径的一部分）。
export function recordShopDailyWageCost(shop, wageVoucherUnits, content) {
  const pricing = ensureShopPricing(shop, content);
  const totalSold = Object.values(pricing.itemSoldUnits || {}).reduce((sum, units) => sum + Math.max(0, units || 0), 0);
  const wage = Math.max(0, salaryPortionForMargin(wageVoucherUnits));
  if (totalSold <= 0 || wage <= 0) return;
  for (const [itemId, units] of Object.entries(pricing.itemSoldUnits || {})) {
    const share = Math.max(0, units || 0) / totalSold;
    pricing.itemWageCost[itemId] = (pricing.itemWageCost[itemId] || 0) + Math.round(wage * share);
  }
}

// 店员工资口径：商人工资是业主劳动报酬，不计入"店员工资"；这里只取店员部分。
// 调用方传入的是店员日薪合计（见 shops.js accrueDailyLiabilities）。
function salaryPortionForMargin(clerkWageVoucherUnits) {
  return Math.max(0, Number(clerkWageVoucherUnits) || 0);
}

// 某商品的实际利润率（%）：(收入 − 进货成本 − 店员工资) / 收入。
// 无销量时返回 null（无法核算，不参与调价判断）。
// priceFactor 缺省 1（面板展示的已实现利润率）；复核时传入窗口内的系数，把收入还原到基准价口径，
// 使利润率只反映成本结构，不被库存系数（降价去库存）干扰。
export function shopItemActualMarginPercent(pricing, itemId, priceFactor = 1) {
  const realized = Math.max(0, pricing?.itemRevenue?.[itemId] || 0);
  const revenue = realized / (Number.isFinite(priceFactor) && priceFactor > 0 ? priceFactor : 1);
  if (revenue <= 0) return null;
  const cogs = Math.max(0, pricing?.itemCogs?.[itemId] || 0);
  const wage = Math.max(0, pricing?.itemWageCost?.[itemId] || 0);
  return (revenue - cogs - wage) / revenue * 100;
}

// 采集当日售出的商品均价，维护 30 天价格历史（需求弹性的基准）。
// 均价口径：粮券单位/库存单位（= 小麦斤等值 / 斤），与 currentUnitPrice 同尺度。
export function recordPriceHistory(shop, content) {
  const pricing = ensureShopPricing(shop, content);
  for (const [itemId, units] of Object.entries(pricing.itemSoldUnits || {})) {
    if (!(units > 0)) continue;
    const revenue = pricing.itemRevenue?.[itemId] || 0;
    if (!(revenue > 0)) continue;
    const average = revenue / units; // 粮券单位/库存单位 == 小麦斤/斤
    pricing.itemPrices[itemId] ||= [];
    pricing.itemPrices[itemId].push({ serial: Number(pricing.lastWindowSerial || 0), price: average });
    if (pricing.itemPrices[itemId].length > PRICE_HISTORY_WINDOW_DAYS) {
      pricing.itemPrices[itemId].splice(0, pricing.itemPrices[itemId].length - PRICE_HISTORY_WINDOW_DAYS);
    }
  }
  void content;
}

// 过去 30 天均价（粮券单位/库存单位）。无历史时返回 null。
export function shopItemAveragePrice(pricing, itemId) {
  const rows = pricing?.itemPrices?.[itemId] || [];
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.price || 0), 0);
  const average = total / rows.length;
  return average > 0 ? average : null;
}

// 需求弹性：售价相对 30 天均价每贵 10%，购买量降 5%（coefficient=0.5 时）。
// 返回需求乘数，限制在 [弹性下限, 2] 区间内，避免极端价格把需求打到 0 或翻倍。
export function priceElasticityDemandMultiplier(state, shop, itemId, currentRetailVoucherUnits, content) {
  const coefficient = Math.max(0, Number(content.rules.generalStorePriceElasticity ?? 0.5));
  if (coefficient <= 0) return 1;
  // 只读：优先用调用方传入的 pricing 快照；缺失时从 state 读，不写回。
  const pricing = shop?.pricing || state.shops?.[shop?.id]?.pricing || {};
  const average = shopItemAveragePrice(pricing, itemId);
  if (!(average > 0) || !(currentRetailVoucherUnits > 0)) return 1;
  const relative = (currentRetailVoucherUnits - average) / average; // +10% => 0.1
  // 每贵 10% 降 coefficient*10% 的购买量；等价 1 − relative/0.10 × (coefficient×0.10)。
  const multiplier = 1 - (relative / 0.10) * (coefficient * 0.10);
  const floor = Math.max(0, Number(content.rules.generalStoreElasticityFloor ?? 0.1));
  return Math.max(floor, Math.min(2, multiplier));
}

// 7 天复核，做两件事（顺序很重要）：
// 1. 利润率复核（既有逻辑）：对每个有销量的商品判断实际利润率是否连续偏离目标超过 ±3%，若是则调基准价，
//    单次幅度 ≤ ±10%，且售价不低于进货价。利润率按基准价口径核算（收入除以窗口内的库存系数），
//    这样降价去库存不会被利润率复核"拉回去"。
// 2. 库存系数（物价会动）：每个经营商品按近 7 天日均销量、库存与断货需求，用 nextPriceFactor 更新系数。
//    系数只在复核时变化，所以窗口内系数恒定，第 1 步读到的就是窗口内的系数。
export function reviewShopPricing(state, shop, content, options = {}) {
  const pricing = ensureShopPricing(shop, content);
  if (!isDynamicPricingShop(shop, content) || shop.status !== "open") return { reviewed: false, changes: [], factorChanges: [] };
  const serial = (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
  const interval = Math.max(1, content.rules.generalStorePricingReviewDays ?? PRICING_REVIEW_INTERVAL_DAYS);
  if (!options.force && Number.isFinite(pricing.lastReviewSerial) && pricing.lastReviewSerial >= 0
      && serial - pricing.lastReviewSerial < interval) return { reviewed: false, changes: [], factorChanges: [] };
  pricing.lastReviewSerial = serial;
  const tolerance = Math.max(0, content.rules.generalStorePricingTolerancePercent ?? PRICING_DEVIATION_TOLERANCE_PERCENT);
  const maxStep = Math.max(0, content.rules.generalStorePricingMaxStepPercent ?? PRICING_MAX_STEP_PERCENT);
  const rules = content.rules.priceAdjust || {};
  const itemIds = shopRetailItemIdsSafe(shop, content);
  // 目标平滑：生效目标每次复核最多按价格 ±maxStep 追向玩家设定的目标。
  // targetOld 是本次复核前的价格口径（窗口内的基准价按它算），target 是复核后的目标。
  const promotion = Boolean(pricing.promotion);
  const configured = shopConfiguredMarginPercent(state, shop, content);
  const inForceOld = shopInForceMarginPercent(state, shop, content);
  const inForceNew = glideStepMarginPercent(inForceOld, configured, maxStep);
  if (inForceNew === configured) delete pricing.glidePercent;
  else pricing.glidePercent = inForceNew;
  const targetOld = promotion ? promotionMarginPercent(content) : inForceOld;
  const target = promotion ? promotionMarginPercent(content) : inForceNew;
  const gliding = Math.abs(target - targetOld) > 1e-9;
  const changes = [];
  for (const itemId of itemIds) {
    const wholesale = currentUnitPrice(state, itemId, content) || 0;
    if (!(wholesale > 0)) continue;
    const factorInWindow = priceFactorOf(pricing, itemId);
    const actual = shopItemActualMarginPercent(pricing, itemId, factorInWindow);
    const currentPrice = shopBaseRetailPrice(itemId, wholesale, targetOld, pricing);
    let desiredPrice;
    if (actual !== null) {
      const deviation = actual - target;
      if (!gliding && Math.abs(deviation) <= tolerance) continue;
      // 由本窗口的实际利润率反推目标售价：利润率 m = 1 − 成本/收入，故 成本/收入 = 1 − m。
      // 达到目标利润率 t 需要 成本/收入 = 1 − t，即 收入 需放大 (1−m)/(1−t) 倍；
      // 成本结构不变时，价格同比例放大即可。这就是"实际偏离多少就补多少"（目标变化也走这一步）。
      const targetFraction = Math.min(0.95, Math.max(0, target / 100));
      const actualFraction = Math.min(0.95, Math.max(-10, actual / 100));
      desiredPrice = currentPrice * (1 - actualFraction) / (1 - targetFraction);
    } else if (gliding) {
      // 本窗口没有销量：按进货价 × (1 + 新目标) 追价。
      desiredPrice = wholesale * (1 + target / 100);
    } else {
      continue;
    }
    const bounded = clampPriceStep(currentPrice, desiredPrice, maxStep, wholesale);
    if (Math.abs(bounded - currentPrice) < 1e-9) continue;
    pricing.retailPriceVoucherPerUnit ||= {};
    pricing.retailPriceVoucherPerUnit[itemId] = bounded;
    changes.push({ itemId, from: currentPrice, to: bounded, actualMarginPercent: actual, targetMarginPercent: target,
      deviationPercent: actual === null ? null : actual - target });
  }
  const factorChanges = updateShopPriceFactors(shop, pricing, itemIds, content, rules);
  // 窗口滚动：本轮判断用过的数据清零，下一轮重新累计 7 天，
  // 避免"连续偏离"被同一批陈旧样本反复触发。
  resetPricingWindow(pricing, content);
  const totalChanges = changes.length;
  return { reviewed: true, changes, factorChanges, targetMarginPercent: target, changedItems: totalChanges };
}

// 库存系数复核：窗口 = 最近 reviewDays 天的日归档（含当天）。
// 积压 → 降价；紧缺（窗口内有断货需求）→ 涨价；清库存判定（库存天数 > clearanceStockDays）决定售价下限。
function updateShopPriceFactors(shop, pricing, itemIds, content, rules) {
  const windowDays = Math.max(1, rules.reviewDays ?? PRICING_REVIEW_INTERVAL_DAYS);
  const clearanceDays = Math.max(0, rules.clearanceStockDays ?? 42);
  const rows = (shop.history || []).slice(-windowDays);
  const factorChanges = [];
  for (const itemId of itemIds) {
    const avgSoldUnits = rows.length ? rows.reduce((sum, row) => sum + Math.max(0, row.soldUnitsByItem?.[itemId] || 0), 0) / rows.length : 0;
    const shortage = rows.some(row => (row.stockoutUnitsByItem?.[itemId] || 0) > 0);
    const stockUnits = Math.max(0, shop.inventory?.[itemId] || 0);
    const before = priceFactorOf(pricing, itemId);
    const next = nextPriceFactor(before, { stockUnits, avgSoldUnits, shortage }, rules);
    const stockDays = stockDaysOf(stockUnits, avgSoldUnits);
    const clearance = stockDays > clearanceDays;
    pricing.priceFactor[itemId] = next.factor;
    pricing.priceFactorReason[itemId] = next.reason;
    pricing.priceClearance[itemId] = clearance;
    if (Math.abs(next.factor - before) > 1e-9) {
      factorChanges.push({ itemId, from: before, to: next.factor, reason: next.reason, stockDays, shortage, clearance });
    }
  }
  return factorChanges;
}

// 基准价（不含库存系数）：显式现售价优先，否则 进货价 × (1 + 目标利润率)。与 economy/operating-plan.js 的 shopTradePrices 同口径。
function shopBaseRetailPrice(itemId, wholesale, target, pricing) {
  const explicit = Number(pricing.retailPriceVoucherPerUnit?.[itemId]);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return wholesale * (1 + target / 100);
}

// 把定价窗口（收入/成本/工资/销量）清零，价格历史保留（弹性需要 30 天）。
export function resetPricingWindow(pricing, content) {
  for (const key of ["itemRevenue", "itemCogs", "itemWageCost", "itemSoldUnits"]) {
    pricing[key] = emptyItemMap(content);
  }
}

function shopRetailItemIdsSafe(shop, content) {
  const raw = content.rules.shopTypes?.[shop?.typeId];
  const def = raw?.aliasOf ? content.rules.shopTypes?.[raw.aliasOf] : raw;
  return def?.kind === "retail" ? [...(def.itemIds || [])] : [];
}

// 单次涨跌幅限制 + 售价下限不低于进货价。
export function clampPriceStep(current, desired, maxStepPercent, wholesaleFloor) {
  const step = Math.max(0, Number(maxStepPercent) || 0) / 100;
  let value = desired;
  if (current > 0) {
    const upper = current * (1 + step);
    const lower = current * (1 - step);
    value = Math.min(Math.max(desired, lower), upper);
  }
  return Math.max(wholesaleFloor, value);
}

// 亏损保护：连续 30 天亏损 → 促销模式 + 预警事件。由日结调用。
export function updateShopLossProtection(state, shop, content, dailyProfitVoucherUnits) {
  const pricing = ensureShopPricing(shop, content);
  if (!isDynamicPricingShop(shop, content)) return { promotion: false };
  if ((dailyProfitVoucherUnits || 0) < 0) pricing.lossStreakDays = (pricing.lossStreakDays || 0) + 1;
  else pricing.lossStreakDays = 0;
  const threshold = Math.max(1, content.rules.generalStoreLossPromotionDays ?? LOSS_PROMOTION_DAYS);
  if (!pricing.promotion && pricing.lossStreakDays >= threshold) {
    pricing.promotion = true;
    pricing.promotionStartedSerial = (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
    pricing.lastReviewSerial = -1;
    recordEvent(state,
      `${shop.name}已连续${threshold}天亏损，转入促销模式：目标利润率临时降至${promotionTargetMarginPercent(content)}%清库存。`,
      content, { day: state.day + 1, mergeKey: `shop-promotion:${shop.id}`, mergeWindowDays: 30,
        amount: 1, mergedText: (times, total) => `${shop.name}等店铺近${times}次转入促销（共${total}次）。` });
    return { promotion: true, entered: true };
  }
  // 恢复：连续 7 天不亏即可退出促销，回到玩家设定的目标利润率。
  if (pricing.promotion && (dailyProfitVoucherUnits || 0) > 0) {
    pricing.profitStreakDays = (pricing.profitStreakDays || 0) + 1;
    const recover = Math.max(1, content.rules.generalStorePromotionRecoverDays ?? 7);
    if (pricing.profitStreakDays >= recover) {
      pricing.promotion = false;
      pricing.profitStreakDays = 0;
      pricing.lastReviewSerial = -1;
      recordEvent(state, `${shop.name}已连续${recover}天盈利，退出促销模式。`, content, { day: state.day + 1 });
      return { promotion: false, exited: true };
    }
  } else if (!pricing.promotion) {
    pricing.profitStreakDays = 0;
  } else {
    // 促销中亏损则清零连盈天数（之前既不累加也不清零，盈亏交替也能攒满退出）。
    pricing.profitStreakDays = 0;
  }
  return { promotion: Boolean(pricing.promotion) };
}

// 玩家命令：直接指定某商品的零售价（面板"现售价"可编辑）。售价下限不低于进货价。
export function setShopRetailPrice(state, shopId, itemId, value, content) {
  const shop = state.shops?.[shopId];
  if (!shop) return { ok: false, reason: "店铺不存在" };
  if (!isDynamicPricingShop(shop, content)) return { ok: false, reason: "只有综合商店支持自定义售价" };
  if (!shopRetailItemIdsSafe(shop, content).includes(itemId)) return { ok: false, reason: "该店不经营这种商品" };
  const price = Math.round(Number(value) * 1000) / 1000;
  if (!Number.isFinite(price) || price <= 0 || price > 1e6) return { ok: false, reason: "售价须为正的有限数值" };
  const wholesale = currentUnitPrice(state, itemId, content) || 0;
  const pricing = ensureShopPricing(shop, content);
  // 物价会动：基准价 = 现售价 ÷ 当前库存系数，使面板上输入的价格就是实际成交价（下一次复核再随库存变化）。
  const factor = priceFactorOf(pricing, itemId);
  const base = Math.max(wholesale, price / factor);
  pricing.retailPriceVoucherPerUnit ||= {};
  pricing.retailPriceVoucherPerUnit[itemId] = base;
  const finalPrice = Math.max(retailFloorOf(pricing, itemId, wholesale, content.rules.priceAdjust), base * factor);
  // 手动调价后重置复核节拍为当前，避免次日立刻被自动复核覆盖（之前置-1反而导致立即复核）。
  const serial = (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
  pricing.lastReviewSerial = serial;
  return { ok: true, shopId, itemId, value: finalPrice, clampedToCost: finalPrice > price + 1e-9 };
}

// 面板视图：每商品一行（进价/现售价/实际利润率/目标利润率/7天销量）+ 商店总览。
// 只读：把默认值作用在一份浅拷贝上，绝不回写 state（0.1.8 selector 纯度要求）。
export function selectShopPricingView(state, shop, content) {
  const source = shop?.pricing || {};
  const pricing = {
    ...source,
    itemPrices: { ...(source.itemPrices || {}) },
    retailPriceVoucherPerUnit: { ...(source.retailPriceVoucherPerUnit || {}) },
    itemWageCost: { ...(source.itemWageCost || {}) },
    itemRevenue: { ...(source.itemRevenue || {}) },
    itemCogs: { ...(source.itemCogs || {}) },
    itemSoldUnits: { ...(source.itemSoldUnits || {}) }
  };
  const scale = content.precision.inventoryUnitsPerJin;
  const currency = content.precision.currencyUnitsPerVoucher;
  const target = shopTargetMarginPercent(state, shop, content);
  const configuredTarget = shopConfiguredMarginPercent(state, shop, content);
  const rows = shopRetailItemIdsSafe(shop, content).map(itemId => {
    const wholesale = currentUnitPrice(state, itemId, content) || 0;
    const base = shopBaseRetailPrice(itemId, wholesale, target, pricing);
    const factor = priceFactorOf(pricing, itemId);
    const retail = Math.max(retailFloorOf(pricing, itemId, wholesale, content.rules.priceAdjust), base * factor);
    const revenue = Math.max(0, pricing.itemRevenue?.[itemId] || 0);
    const cogs = Math.max(0, pricing.itemCogs?.[itemId] || 0);
    const wage = Math.max(0, pricing.itemWageCost?.[itemId] || 0);
    const soldUnits = Math.max(0, pricing.itemSoldUnits?.[itemId] || 0);
    const actual = shopItemActualMarginPercent(pricing, itemId);
    const elasticity = priceElasticityDemandMultiplier(state, { ...shop, pricing }, itemId, retail, content);
    const average = shopItemAveragePrice(pricing, itemId);
    return {
      itemId,
      name: content.items[itemId]?.name || itemId,
      unit: content.items[itemId]?.unit || "斤",
      wholesaleVoucherPerUnit: wholesale,
      retailVoucherPerUnit: retail,
      basePriceVoucherPerUnit: base,
      priceFactor: factor,
      priceFactorReason: pricing.priceFactorReason?.[itemId] || "",
      clearance: Boolean(pricing.priceClearance?.[itemId]),
      actualMarginPercent: actual,
      targetMarginPercent: target,
      soldJin7d: soldUnits / scale,
      revenueJin7d: revenue / currency,
      cogsJin7d: cogs / currency,
      wageJin7d: wage / currency,
      demandMultiplier: elasticity,
      averagePriceVoucherPerUnit: average === null ? 0 : average / currency * scale
    };
  });
  const totals = rows.reduce((acc, row) => ({
    revenue: acc.revenue + row.revenueJin7d,
    cogs: acc.cogs + row.cogsJin7d,
    wage: acc.wage + row.wageJin7d
  }), { revenue: 0, cogs: 0, wage: 0 });
  const overallMargin = totals.revenue > 0 ? (totals.revenue - totals.cogs - totals.wage) / totals.revenue * 100 : null;
  return {
    shopId: shop.id,
    shopName: shop.name,
    dynamic: isDynamicPricingShop(shop, content),
    targetMarginPercent: target,
    // 玩家设定的目标（单店覆盖或跟随全局）；平滑过渡中 gliding 为 true，生效目标正向它追赶。
    configuredTargetMarginPercent: configuredTarget,
    followsPolicy: shopOverrideMarginPercent(shop) === null,
    policyMarginPercent: policyShopMarginPercent(state, content),
    gliding: Number.isFinite(pricing.glidePercent),
    promotion: Boolean(pricing.promotion),
    lossStreakDays: pricing.lossStreakDays || 0,
    lastReviewSerial: Number.isFinite(pricing.lastReviewSerial) ? pricing.lastReviewSerial : -1,
    reviewIntervalDays: Math.max(1, content.rules.generalStorePricingReviewDays ?? PRICING_REVIEW_INTERVAL_DAYS),
    lossPromotionDays: Math.max(1, content.rules.generalStoreLossPromotionDays ?? LOSS_PROMOTION_DAYS),
    rows,
    totals: { ...totals, overallMarginPercent: overallMargin }
  };
}
