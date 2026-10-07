import { escapeHtml, number, numberMax, shortageJin } from "./format.js";
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

// 产业熟练度：只列出累计过工日的产业；上限 50%，进度条按上限折算。
function renderIndustryProductivity(view) {
  const rows = (view.productivity || []).filter(row => row.workerDays > 0);
  const note = `<div class="subtle">生产工人每干一天累计一个工日；越熟练人均产出越高，越往后涨得越慢。建筑每升一级人均产出 +10%。</div>`;
  if (!rows.length) return `<div class="subtle">尚无在岗生产工人。</div>${note}`;
  const lines = rows.map(row => `<div class="row"><span class="label">${escapeHtml(row.name)}</span><strong class="value">熟练 +${numberMax(row.experiencePercent, 1)}% / 上限 ${number(row.maxPercent, 0)}%</strong></div>`
    + `<div class="meter"><span style="width:${Math.min(100, (row.experiencePercent / row.maxPercent) * 100).toFixed(1)}%"></span></div>`
    + `<div class="row"><span class="label">累计工日</span><strong class="value">${number(row.workerDays)}</strong></div>`).join("");
  return `${lines}${note}`;
}

export function renderEconomy(view) {
  return `${renderEnterpriseFinance(view)}
    <section class="panel-section" id="foodSection"><h2>口粮</h2>
      ${view.shortageQeq > 0 ? `<div class="shortage-banner visible">口粮短缺 ${shortageJin(view.shortageQeq, view.qeqUnitsPerJin)}，时光已暂停。</div>` : ""}
      <div class="cardlet"><div class="row"><span class="label">居民可吃</span><strong class="value">${numberMax(view.residentFoodDays, 1)}天</strong></div><div class="row"><span class="label">每日需要</span><strong class="value">${view.dailyNeed.toLocaleString("zh-CN")}斤</strong></div></div></section>
    ${detail("bread-trade", "居民主粮购买", renderTrade(view))}
    ${detail("outside-town", `外贸 · ${view.outsideTown?.name || "外镇"}`, renderOutsideTown(view))}
    ${detail("industry-accounts", "林业、盐业与住房", renderIndustryAccounts(view))}
    ${detail("workshop-accounts", "镇营作坊账", renderBusiness(view))}
    ${detail("industry-productivity", "产业熟练度", renderIndustryProductivity(view))}
    ${detail("ledger", "账目与历史交易", renderLedger(view))}
    ${detail("annual-flows", "本年收支明细", renderAnnualFlows(view))}`;
}
