import { escapeHtml, number, moneyUnit } from "./format.js";
import { stagedInput, renderExchangeEntry } from "./panel-exchange.js";

function renderPrices(view) {
  const unit = moneyUnit(view);
  const prices = view.market.intermediatePricesVoucherPerUnit || {};
  return `<section class="enterprise-section"><h2>价格</h2><div class="cardlet">
    <div class="row"><span class="label">小麦 / 食盐</span><strong class="value">${number(view.market.pricesVoucherPerUnit?.wheat ?? 1, 3)} / ${number(view.market.pricesVoucherPerUnit?.salt ?? 10, 3)}${escapeHtml(unit)}/斤</strong></div>
    <div class="row"><span class="label">面粉</span><div class="business-inline-input">${stagedInput(view, { key: "intermediate:flour", label: "面粉价格", value: prices.flour ?? 1.8, positive: true })}<b>${escapeHtml(unit)}/斤</b><button class="secondary" data-intermediate-price="flour">设置</button></div></div>
    <div class="row"><span class="label">面包</span><div class="business-inline-input">${stagedInput(view, { key: "intermediate:bread", label: "面包价格", value: view.market.pricesVoucherPerUnit?.bread ?? 2, positive: true })}<b>${escapeHtml(unit)}/斤</b><button class="secondary" data-intermediate-price="bread">设置</button></div></div>
    <div class="row"><span class="label">木材</span><div class="business-inline-input">${stagedInput(view, { key: "intermediate:wood", label: "木材价格", value: prices.wood ?? 15, positive: true })}<b>${escapeHtml(unit)}/单位</b><button class="secondary" data-intermediate-price="wood">设置</button></div></div>
    <div class="subtle">均为批发价，商店零售另加价。</div>
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
