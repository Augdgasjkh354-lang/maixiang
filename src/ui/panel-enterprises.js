import { escapeHtml, number, moneyUnit } from "./format.js";
import { stagedInput, renderExchangeEntry } from "./panel-exchange.js";

// 价格区只读：面粉/面包/木材的售价在批发市场面板统一设置（同一价格键，写入路径不变），这里只显示并跳转。
function renderPrices(view) {
  const unit = moneyUnit(view);
  const prices = view.market.pricesVoucherPerUnit || {};
  const wholesale = (view.buildings || []).find(building => building.typeId === "wholesale_market") || null;
  const jump = wholesale
    ? `<button class="secondary" data-open-building="${escapeHtml(wholesale.id)}">前往批发市场</button>`
    : `<button class="secondary" disabled>尚未建批发市场</button>`;
  const priceRow = (label, itemId, unitText) => `<div class="row"><span class="label">${label}</span><strong class="value">${number(prices[itemId] ?? 0, 3)}${escapeHtml(unit)}/${escapeHtml(unitText)}</strong></div>`;
  return `<section class="enterprise-section"><h2>价格</h2><div class="cardlet">
    <div class="row"><span class="label">小麦 / 食盐</span><strong class="value">${number(view.market.pricesVoucherPerUnit?.wheat ?? 1, 3)} / ${number(view.market.pricesVoucherPerUnit?.salt ?? 10, 3)}${escapeHtml(unit)}/斤</strong></div>
    ${priceRow("面粉", "flour", "斤")}
    ${priceRow("面包", "bread", "斤")}
    ${priceRow("木材", "wood", "单位")}
    <div class="site-actions">${jump}</div>
    <div class="subtle">均为批发价，商店零售另加价。面粉、面包、木材的售价在批发市场面板里设置。</div>
  </div></section>`;
}

// 独立公司的列表摘要：点击跳到公司所在建筑（公司的经营控件与账目在那栋建筑的面板里）。
// 公司只绑定一栋建筑（company.buildingId）；找不到建筑时只显示名称，按钮禁用。
function renderCompanyDirectory(view) {
  const companies = view.companies || [];
  if (!companies.length) return `<div class="cardlet subtle">暂无独立公司。</div>`;
  const buildings = view.buildings || [];
  return companies.map(company => {
    const building = buildings.find(row => row.id === company.buildingId) || null;
    const listed = Boolean(company.listing?.listed);
    return `<div class="cardlet">
      <div class="row"><strong>${escapeHtml(company.name)}</strong><span class="badge">${listed ? `${escapeHtml(company.listing.ticker || "---")} · 已上市` : "未上市"}</span></div>
      <div class="row"><span class="label">所在建筑 · 公司等级 / 在岗</span><strong class="value">${building ? escapeHtml(building.name) : "建筑缺失"} · ${number(company.listedLevels)}级 · ${number(company.workers)}人</strong></div>
      <div class="settings-actions">${building
        ? `<button class="secondary" data-open-building="${escapeHtml(building.id)}">前往公司所在建筑</button>`
        : `<button class="secondary" disabled>建筑缺失</button>`}</div>
    </div>`;
  }).join("");
}

export function renderEnterpriseFinance(view) {
  return `${renderPrices(view)}
    <section class="enterprise-section"><h2>整栋上市与交易所</h2>${renderExchangeEntry(view)}</section>
    <section class="enterprise-section"><h2>独立公司</h2>${renderCompanyDirectory(view)}</section>`;
}
