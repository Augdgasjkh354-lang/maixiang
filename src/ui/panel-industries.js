import { escapeHtml, number, moneyUnit } from "./format.js";

function quantity(units, scale, unit) {
  return number((units || 0) / scale, 2) + unit;
}

export function renderIndustryAccounts(view) {
  const unit = moneyUnit(view);
  const scale = view.inventoryUnitsPerJin;
  const forestry = view.industries.forestry;
  const salt = view.industries.salt;
  const rent = view.housing.rentFiscal;
  const annualRent = rent.year.collectedWheatUnits || 0;
  const saltRevenue = salt.year.revenueWheatUnits || 0;
  const saltWages = salt.year.operatingWagesWheatUnits || 0;
  const saltProfit = saltRevenue - saltWages;
  const rentalRows = view.housing.rentals.map(row =>
    `<div class="row"><span class="label">${escapeHtml(row.name)}入住 / 空位</span><strong class="value">${number(row.occupied)} / ${number(row.vacancies)}人</strong></div>`
  ).join("");
  return `<h2>林业、盐业与住房</h2>
    <div class="cardlet">
      <div class="setting-title">资源</div>
      <div class="row"><span class="label">木材 · 居民 / 镇库</span><strong class="value">${number(view.accounts.residents.items.wood.quantity)} / ${number(view.accounts.town.items.wood.quantity)}单位</strong></div>
      <div class="row"><span class="label">食盐 · 居民 / 镇库</span><strong class="value">${number(view.salt.residentStockJin, 2)} / ${number(view.salt.townStockJin, 2)}斤</strong></div>
      <div class="row"><span class="label">今日伐木 / 采盐</span><strong class="value">${quantity(forestry.day.producedUnits.wood, scale, "单位")} / ${quantity(salt.day.producedUnits.salt, scale, "斤")}</strong></div>
    </div>
    <div class="cardlet">
      <div class="setting-title">食盐</div>
      <div class="row"><span class="label">今日需求 / 满足</span><strong class="value">${number(view.salt.todayDemandJin, 2)} / ${number(view.salt.todaySatisfiedJin, 2)}斤</strong></div>
      <div class="row"><span class="label">近30日保障率</span><strong class="value">${number(view.salt.historyCoverage * 100, 1)}%</strong></div>
      <div class="row"><span class="label">今日销量 / 已收入</span><strong class="value">${quantity(salt.day.soldUnits, scale, "斤")} / ${quantity(salt.day.revenueWheatUnits, scale, unit)}</strong></div>
      <div class="row"><span class="label">本年利润</span><strong class="value">${quantity(saltProfit, scale, unit)}</strong></div>
    </div>
    <div class="cardlet">
      <div class="setting-title">住房</div>
      <div class="row"><span class="label">容量 / 缺口</span><strong class="value">${number(view.housing.capacity)} / ${number(view.housing.shortage)}人</strong></div>
      ${rentalRows || '<div class="subtle">暂无公租房。</div>'}
      <div class="row"><span class="label">今日实收 / 减免</span><strong class="value">${number(view.housing.lastRentDay?.collectedWheatJin || rent.day.collectedWheatUnits / scale)} / ${number(view.housing.lastRentDay?.waivedWheatJin || rent.day.waivedWheatUnits / scale)}${unit}</strong></div>
      <div class="row"><span class="label">本年租金</span><strong class="value">${quantity(annualRent, scale, unit)}</strong></div>
    </div>`;
}
