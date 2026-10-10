import { escapeHtml, number, moneyUnit, moneyMixHint } from "./format.js";

// 居民主粮购买（用户 0.1.11 原 Uz）：三项主食（小麦/面粉/面包）的目标/买到/支付，
// 购买规则文案为用户 0.1.11 定稿。
export function renderTrade(view) {
  const unit = moneyUnit(view);
  const trade = view.market.trade || {};
  const staples = trade.staples || {};
  const shares = staples.shares || { wheat: 0.6, flour: 0.2, bread: 0.2 };
  const rows = (staples.rows || []).filter(row => row.itemId !== "wheat");
  const price = view.market.breadPriceWheatPerJin;
  const wholesale = (view.buildings || []).find(building => building.typeId === "wholesale_market") || null;
  const itemName = itemId => (view.itemNames && view.itemNames[itemId]) || itemId;
  return `<h2>居民主粮购买</h2>
    <div class="cardlet"><div class="row"><span class="label">面包售价</span><strong class="value">${number(price, 3)}${unit}/斤 <span class="subtle">批发价，在批发市场面板设置</span></strong></div>
      <div class="site-actions">${wholesale ? `<button class="secondary" data-open-building="${escapeHtml(wholesale.id)}">前往批发市场</button>` : `<button class="secondary" disabled>尚未建批发市场</button>`}</div>
      <div class="row"><span class="label">居民 / 镇库面包库存</span><strong class="value">${number(view.market.residentBreadJin)} / ${number(view.market.townBreadJin)}斤</strong></div>
      ${rows.length ? rows.map(row => `<div class="row"><span class="label">${escapeHtml(itemName(row.itemId))} 目标 / 买到</span><strong class="value">${number(row.targetQeqJin, 1)} / ${number(row.purchasedJin, 1)}斤 · 付${number(row.paidVoucher, 1)}${unit}</strong></div>${row.purchasedJin <= 0 && row.limitReason ? `<div class="subtle">${escapeHtml(row.limitReason)}</div>` : ""}`).join("") : `<div class="subtle">时光流动后显示当日购买情况。</div>`}
    </div>
    <details class="detail-block" data-detail-key="bread-rules"><summary>购买规则</summary><div class="detail-body"><div class="subtle">居民每天按口粮占比补足主粮：小麦${number((shares.wheat || 0) * 100, 0)}%、面粉${number((shares.flour || 0) * 100, 0)}%、面包${number((shares.bread || 0) * 100, 0)}%。家里已有的先算进去；小麦直接向镇库和有余粮的人家买；面粉、面包、食盐、木材在商业街综合商店买，零售价为批发价×1.2。</div></div></details>`;
}
