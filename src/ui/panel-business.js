import { escapeHtml, number, moneyUnit, moneyMixHint } from "./format.js";

// 地块标签人性化（0.1.11 _2() 补回）："空地 3" → "3号地"
function humanizePlotLabel(view, building) {
  const label = view.plots?.find(p => p.id === building.plotId)?.label;
  if (!label) return building.id;
  return label.replace(/^空地\s*(\d+)$/, "$1号地").replace(/空地$/, "") || label;
}

function jin(units, scale) { return (units || 0) / scale; }
function outputSummary(map, names, scale) {
  const rows = Object.entries(map || {}).filter(([, units]) => units > 0);
  return rows.map(([id, units]) => `${escapeHtml(names[id] || id)} ${number(jin(units, scale))}斤`).join(" · ") || "暂无产出";
}
function accounts(group, view) {
  const scale = view.inventoryUnitsPerJin;
  const revenue = jin(group.revenueWheatUnits, scale);
  const cogs = jin(group.breadCogsWheatUnits, scale);
  const waste = jin(group.processingLossWheatUnits, scale);
  const wages = jin(group.operatingWagesWheatUnits, scale);
  const rawInputCost = jin(group.rawInputCostWheatUnits, scale);
  return { revenue, cogs, waste, wages, rawInputCost, profit: revenue - cogs - waste - wages };
}

export function renderBusiness(view) {
  const unit = moneyUnit(view);
  const business = view.market.business;
  const day = accounts(business.day, view);
  const year = accounts(business.year, view);
  const cumulative = accounts(business.cumulative, view);
  const scale = view.inventoryUnitsPerJin;
  const investment = jin(business.cumulative.constructionWagesWheatUnits, scale);
  const recovery = cumulative.profit - investment;
  const townStock = Object.entries(view.accounts.town.items)
    .filter(([, row]) => ["wheat", "flour", "bread"].includes(row.itemId))
    .map(([, row]) => `${escapeHtml(row.name)} ${number(row.quantity)}斤`).join(" · ");
  const buildings = view.buildings.filter(building => building.typeId === "mill" || building.typeId === "bakery").map(building => {
    const workers = building.jobs.reduce((sum, job) => sum + job.workers, 0);
    const slots = building.jobs.reduce((sum, job) => sum + job.capacity, 0);
    const payroll = view.payroll?.lastDay?.workers?.find(row => row.buildingId === building.id);
    const wageUnpaid = payroll?.unpaidCurrentWheatJin || 0;
    return `<div class="cardlet"><div class="row"><strong>${escapeHtml(building.name)} · ${escapeHtml(humanizePlotLabel(view, building))}</strong><span class="badge">${escapeHtml(building.status.label)}</span></div>
      <div class="row"><span class="label">人数</span><strong class="value">${number(workers)} / ${number(slots)}人</strong></div>
      <div class="row"><span class="label">今日产量</span><strong class="value">${outputSummary(building.jobs[0]?.outputToday, view.itemNames, scale)}</strong></div>
      ${wageUnpaid > 0 ? `<div class="shortage-banner visible">新增欠薪 ${number(wageUnpaid)}${unit}</div>` : ""}</div>`;
  }).join("");
  return `<h2>镇营作坊</h2>
    <div class="cardlet"><div class="row"><span class="label">今日产量</span><strong class="value">${outputSummary(business.day.producedUnits, view.itemNames, scale)}</strong></div>
      <div class="row"><span class="label">面包销量 / 已收入</span><strong class="value">${number(jin(business.day.soldBreadUnits, scale))}斤 / ${number(day.revenue)}${unit}</strong></div>
      <div class="row"><span class="label">今日利润</span><strong class="value">${number(day.profit, 1)}${unit}</strong></div>
      <div class="row"><span class="label">镇库库存</span><strong class="value">${townStock}</strong></div></div>
    <h3>各座作坊</h3>${buildings || `<div class="cardlet subtle">暂无完工作坊。</div>`}
    <details class="detail-block" data-detail-key="workshop-costs"><summary>成本与累计数据</summary><div class="detail-body">
      <div class="row"><span class="label">今日成本</span><strong class="value">已售${number(day.cogs)} · 损耗${number(day.waste)} · 工资${number(day.wages)}${unit}</strong></div>
      <div class="row"><span class="label">原料投入折算</span><strong class="value">${number(day.rawInputCost)}${unit}</strong></div>
      <div class="row"><span class="label">本年收入 / 利润</span><strong class="value">${number(year.revenue)} / ${number(year.profit, 1)}${unit}</strong></div>
      <div class="row"><span class="label">累计利润 - 建设工资</span><strong class="value">${number(recovery, 1)}${unit}</strong></div>
      <div class="row"><span class="label">面粉 / 面包库存成本</span><strong class="value">${number(jin(business.inventoryCostWheatUnits.town.flour, scale))} / ${number(jin(business.inventoryCostWheatUnits.town.bread, scale))}${unit}</strong></div>
      <div class="subtle">经营收入、成本与利润一律按小麦等值核算，支付媒介不产生利润。${moneyMixHint(view)}。</div>
    </div></details>`;
}
