import { escapeHtml, number, numberMax, shortageJin } from "./format.js";

export function renderOverview(view) {
  const p = view.people;
  const shortage = view.shortageQeq > 0;
  const currentForecast = number(view.forecast);
  return `<h2>今日镇务</h2>
    <div class="shortage-banner${shortage ? " visible" : ""}">口粮短缺 ${shortageJin(view.shortageQeq, view.qeqUnitsPerJin)}，时光已暂停。可从镇库拨粮或开启自动救济。</div>
    <div class="cardlet">
      <div class="row"><span class="label">居民口粮</span><strong class="value large">${numberMax(view.residentFoodDays, 1)}天</strong></div>
      <div class="row"><span class="label">居民 / 镇库口粮</span><strong class="value">${number(view.accounts.residents.qeq)} / ${number(view.accounts.town.qeq)}斤</strong></div>
      <div class="row"><span class="label">舒心值</span><strong class="value">${number(view.satisfaction)} / 100</strong></div>
      <label class="toggle" style="margin-top:9px"><input id="autoRelief" type="checkbox" ${view.autoRelief ? "checked" : ""}><span>自动救济</span></label>
      <div><button class="secondary" id="manualAid" ${view.accounts.town.qeq <= 0 ? "disabled" : ""}>拨粮 ${number(view.manualReliefAmountJin)}斤</button></div>
    </div>
    <div class="cardlet" style="margin-top:9px">
      <div class="row"><span class="label">${escapeHtml(view.season.name)} · ${escapeHtml(view.season.field)}</span><strong class="value">${number(view.labor.rows.find(row => row.roleId === "farmers")?.count || 0)} / ${number(view.farmCapacity)}名农人</strong></div>
      <div class="meter" aria-label="全年耕作投入 ${number(view.farmWorkPercent)}%"><span style="width:${view.farmWorkPercent}%"></span></div>
      <div class="row" style="margin-top:7px"><span class="label">预计净收成</span><strong class="value">${currentForecast}斤</strong></div>
      <details class="detail-block" data-detail-key="overview-harvest"><summary>收成详情</summary><div class="detail-body"><div class="row"><span class="label">满额农事日</span><strong class="value">${number(view.growingDays)}日</strong></div><div class="row"><span class="label">满额净收</span><strong class="value">${number(view.farmMaximumHarvest)}斤</strong></div><div class="subtle">秋收结算，居民与镇库各分一半。</div></div></details>
    </div>
    <div class="cardlet" style="margin-top:9px">
      <div class="row"><span class="label">劳动力</span><strong class="value">${number(p.workers)}人</strong></div>
      <div class="row"><span class="label">已就业 / 待业</span><strong class="value">${number(view.labor.employed)} / ${number(view.labor.idle)}人</strong></div>
      <button class="secondary wide" data-go="residents" style="margin-top:8px">安排岗位</button>
    </div>`;
}
