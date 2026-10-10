// 利润率政策：综合商店目标利润率与贸易行利润门槛的全局默认、单店覆盖与平滑过渡。
//
// 数据位置：
// - state.policy.shopMarginPercent：综合商店全局目标利润率（0—200，一位小数；缺省 rules.generalStoreMarkupPercent）。
// - shop.pricing.targetMarginOwn + shop.pricing.targetMarginPercent：单店覆盖。没有 targetMarginOwn 标记的旧档，
//   targetMarginPercent 若是开局烘焙的默认 20 视为"跟随全局"，其他有限值视为单店设定。
// - shop.pricing.glidePercent：生效中的目标（平滑过渡）。玩家改目标时先把旧的生效值记下（pinGlideBeforeChange），
//   之后每次 7 天复核按价格 ±rules.generalStorePricingMaxStepPercent 的步幅追上新目标，追平后删除。
// - state.policy.tradeMarginPercent / tradeImportMarginPercent：贸易行出口 / 进口利润门槛（0—200；
//   缺省 rules.tradeHouseTargetMarginPercent / tradeHouseImportMarginPercent）。
//
// 只读函数不写 state；写入只在 pinGlideBeforeChange（由命令在改目标前调用）与复核（shop-pricing.js）里发生。

export const MARGIN_POLICY_MAX_PERCENT = 200;
export const LEGACY_BAKED_SHOP_MARGIN_PERCENT = 20;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clampPercent(value) {
  return Math.max(0, Math.min(MARGIN_POLICY_MAX_PERCENT, value));
}

// 缺省或非法时回落到 fallback，结果限制在 0—200。
function policyPercent(raw, fallback) {
  return clampPercent(isFiniteNumber(raw) ? raw : fallback);
}

// 综合商店全局默认目标利润率（%）。
export function policyShopMarginPercent(state, content) {
  return policyPercent(state?.policy?.shopMarginPercent, content.rules.generalStoreMarkupPercent ?? 20);
}

// 贸易行利润门槛（%）：export 或 import。
export function policyTradeMarginPercent(state, content, direction = "export") {
  if (direction === "import") {
    return policyPercent(state?.policy?.tradeImportMarginPercent,
      content.rules.tradeHouseImportMarginPercent ?? content.rules.tradeHouseTargetMarginPercent ?? 25);
  }
  return policyPercent(state?.policy?.tradeMarginPercent, content.rules.tradeHouseTargetMarginPercent ?? 20);
}

// 单店覆盖值（%）；未单独设置时返回 null（跟随全局）。
export function shopOverrideMarginPercent(shop) {
  const pricing = shop?.pricing;
  if (!pricing) return null;
  const own = pricing.targetMarginOwn ?? (isFiniteNumber(pricing.targetMarginPercent)
    && pricing.targetMarginPercent !== LEGACY_BAKED_SHOP_MARGIN_PERCENT);
  if (!own || !isFiniteNumber(pricing.targetMarginPercent)) return null;
  return clampPercent(pricing.targetMarginPercent);
}

// 玩家设定的目标（%）：单店覆盖优先，否则全局默认。
export function shopConfiguredMarginPercent(state, shop, content) {
  return shopOverrideMarginPercent(shop) ?? policyShopMarginPercent(state, content);
}

// 生效中的目标（%）：平滑过渡中的值；没有过渡记录时等于玩家设定的目标。促销模式不影响它。
export function shopInForceMarginPercent(state, shop, content) {
  const glide = shop?.pricing?.glidePercent;
  return isFiniteNumber(glide) ? clampPercent(glide) : shopConfiguredMarginPercent(state, shop, content);
}

// 促销模式目标（%）。
export function promotionMarginPercent(content) {
  const v = Number(content.rules.generalStorePromotionTargetPercent);
  return Number.isFinite(v) ? clampPercent(v) : 5;
}

// 定价实际使用的目标（%）：促销模式优先，否则生效中的目标。
export function shopEffectiveMarginPercent(state, shop, content) {
  if (shop?.pricing?.promotion) return promotionMarginPercent(content);
  return shopInForceMarginPercent(state, shop, content);
}

// 改目标之前调用：把当前生效中的目标记下，之后按复核平滑追上新目标（而不是一次跳价）。
export function pinGlideBeforeChange(state, shop, content) {
  shop.pricing ||= {};
  if (!isFiniteNumber(shop.pricing.glidePercent)) {
    shop.pricing.glidePercent = shopInForceMarginPercent(state, shop, content);
  }
}

// 一次复核的目标步进：生效目标沿着"价格比例 ±maxStepPercent"的界限追向 target。
// 价格 ∝ (1 + 目标)，所以单次目标变化使基准价最多变化 maxStepPercent%。
export function glideStepMarginPercent(current, target, maxStepPercent) {
  const step = Math.max(0, Number(maxStepPercent) || 0) / 100;
  const from = 1 + current / 100;
  const lower = (from * (1 - step) - 1) * 100;
  const upper = (from * (1 + step) - 1) * 100;
  return clampPercent(Math.min(Math.max(target, lower), upper));
}
