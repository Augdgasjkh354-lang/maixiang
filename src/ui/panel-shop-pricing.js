import { escapeHtml, number } from "./format.js";
import { renderNumericInput } from "./numeric-drafts.js";

// 综合商店动态加价面板（0.2.3 流通改革，v1 只做综合商店）。
// 每商品一行：进价 / 现售价 / 实际利润率 / 目标利润率（可调）/ 7天销量；
// 商店总览：总收入、总成本、整体利润率。其他小店保持固定加价，不在本面板出现。
function marginText(value) {
  return value === null || value === undefined ? "—" : `${number(value, 1)}%`;
}

function itemRow(view, shop, row) {
  const unit = view.itemNames ? (view.itemUnits?.[row.itemId] || "斤") : "斤";
  const priceLabel = `${row.name}现售价`;
  return `<div class="cardlet">
    <div class="row"><span class="label">${escapeHtml(row.name)}进价</span><strong class="value">${number(row.wholesaleVoucherPerUnit, 3)} 斤/单位</strong></div>
    <div class="row"><span class="label">现售价</span><div class="setting-input">${renderNumericInput(view, { key: `shop-retail:${shop.shopId}:${row.itemId}`, kind: "shop-retail-price", target: `${shop.shopId}:${row.itemId}`, value: number(row.retailVoucherPerUnit, 3), label: priceLabel, minimum: 0.001, maximum: 1000000, positive: true, className: "setting-editor" })}<b>斤/${escapeHtml(unit)}</b></div></div>
    <div class="row"><span class="label">价格系数</span><strong class="value">×${number(row.priceFactor ?? 1, 2)}${row.priceFactorReason ? ` <span class="subtle">${escapeHtml(row.priceFactorReason)}</span>` : ""}${row.clearance ? ` <span class="badge red">清仓</span>` : ""}</strong></div>
    <div class="row"><span class="label">实际利润率</span><strong class="value">${escapeHtml(marginText(row.actualMarginPercent))}</strong></div>
    <div class="row"><span class="label">目标利润率</span><strong class="value">${number(row.targetMarginPercent, 1)}%</strong></div>
    <div class="row"><span class="label">近30天均价 / 弹性系数</span><strong class="value">${number(row.averagePriceVoucherPerUnit || 0, 3)} / ${number(row.demandMultiplier, 2)}</strong></div>
    <div class="row"><span class="label">近7天销量</span><strong class="value">${number(row.soldJin7d, 1)}${escapeHtml(unit)}</strong></div>
    <div class="row"><span class="label">近7天收入 / 进货 / 店员工资</span><strong class="value">${number(row.revenueJin7d, 1)} / ${number(row.cogsJin7d, 1)} / ${number(row.wageJin7d, 1)}</strong></div>
  </div>`;
}

export function renderShopPricing(view, shop) {
  const pricing = shop.pricing;
  if (!pricing || !pricing.dynamic) return `<div class="subtle">该店铺按固定加价经营，不支持目标利润率定价。</div>`;
  const totals = pricing.totals || { revenue: 0, cogs: 0, wage: 0, overallMarginPercent: null };
  const promotion = pricing.promotion
    ? `<div class="shortage-banner visible">促销模式：已连续${number(pricing.lossStreakDays)}天亏损，目标利润率临时降至 5% 清库存。</div>`
    : "";
  const overallKey = `shop-margin:${shop.shopId}`;
  const sourceText = pricing.followsPolicy
    ? `跟随全局默认 ${number(pricing.policyMarginPercent, 1)}%`
    : "本店单独设置";
  const followButton = pricing.followsPolicy ? "" : `<button class="secondary" data-shop-margin-follow="${escapeHtml(shop.shopId)}">改为跟随全局</button>`;
  return `<h2>${escapeHtml(shop.shopName)} · 动态加价</h2>
    <div class="cardlet">
      <div class="row"><span class="label">本店目标利润率</span><div class="setting-input">${renderNumericInput(view, { key: overallKey, kind: "shop-target-margin", target: shop.shopId, value: pricing.configuredTargetMarginPercent, label: "本店目标利润率", minimum: 0, maximum: 200, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">目标来源</span><strong class="value">${escapeHtml(sourceText)}</strong><div class="setting-input">${followButton}<button class="secondary" data-shop-margin-all="${escapeHtml(shop.shopId)}">应用到所有综合商店</button></div></div>
      <div class="subtle">全局默认在政策页「商店与贸易利润率」调整；未单独设置的店铺跟随它。</div>
      <div class="row"><span class="label">复核节拍</span><strong class="value">每${number(pricing.reviewIntervalDays)}天一次，偏离超 ±3% 才调价，单次幅度 ≤ ±10%</strong></div>
      <div class="row"><span class="label">当前生效目标</span><strong class="value">${number(pricing.targetMarginPercent, 1)}%${pricing.promotion ? "（促销中）" : pricing.gliding ? `（向${number(pricing.configuredTargetMarginPercent, 1)}%过渡中）` : ""}</strong></div>
      <div class="row"><span class="label">近7天总收入 / 总进货 / 总店员工资</span><strong class="value">${number(totals.revenue, 1)} / ${number(totals.cogs, 1)} / ${number(totals.wage, 1)}</strong></div>
      <div class="row"><span class="label">整体利润率</span><strong class="value">${escapeHtml(marginText(totals.overallMarginPercent))}</strong></div>
      <div class="subtle">售价 = 进货价 ×（1 + 目标利润率）；比30天均价每贵10%，销量降5%。</div>
    </div>
    ${promotion}
    ${(pricing.rows || []).map(row => itemRow(view, shop, row)).join("")}`;
}
