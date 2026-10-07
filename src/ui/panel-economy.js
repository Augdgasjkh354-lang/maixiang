import { numberMax, shortageJin } from "./format.js";
import { renderTrade } from "./panel-trade.js";
import { renderOutsideTown } from "./panel-outside-town.js";
import { renderBusiness } from "./panel-business.js";
import { renderLedger } from "./panel-ledger.js";
import { renderIndustryAccounts } from "./panel-industries.js";
import { renderAnnualFlows } from "./panel-flows.js";
import { renderEnterpriseFinance } from "./panel-enterprises.js";

function detail(key, title, body) {
  return `<details class="detail-block panel-detail" data-detail-key="${key}"><summary>${title}</summary><div class="detail-body">${body}</div></details>`;
}

export function renderEconomy(view) {
  return `${renderEnterpriseFinance(view)}
    <section class="panel-section" id="foodSection"><h2>口粮</h2>
      ${view.shortageQeq > 0 ? `<div class="shortage-banner visible">口粮短缺 ${shortageJin(view.shortageQeq, view.qeqUnitsPerJin)}，时光已暂停。</div>` : ""}
      <div class="cardlet"><div class="row"><span class="label">居民可吃</span><strong class="value">${numberMax(view.residentFoodDays, 1)}天</strong></div><div class="row"><span class="label">每日需要</span><strong class="value">${view.dailyNeed.toLocaleString("zh-CN")}斤</strong></div>
      <label class="toggle"><input id="autoRelief" type="checkbox" ${view.autoRelief ? "checked" : ""}><span>自动救济</span></label>
      <div class="settings-actions"><button class="secondary" id="manualAid" ${view.accounts.town.qeq <= 0 ? "disabled" : ""}>拨粮 ${view.manualReliefAmountJin.toLocaleString("zh-CN")}斤</button></div></div></section>
    ${detail("bread-trade", "居民主粮购买", renderTrade(view))}
    ${detail("outside-town", "外贸 · 民镇", renderOutsideTown(view))}
    ${detail("industry-accounts", "林业、盐业与住房", renderIndustryAccounts(view))}
    ${detail("workshop-accounts", "镇营作坊账", renderBusiness(view))}
    ${detail("ledger", "账目与历史交易", renderLedger(view))}
    ${detail("annual-flows", "本年收支明细", renderAnnualFlows(view))}`;
}
