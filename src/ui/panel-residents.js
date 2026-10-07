import { renderJobs } from "./panel-jobs.js";
import { renderPeople } from "./panel-people.js";
import { number, escapeHtml } from "./format.js";

export function renderResidents(view) {
  const living = view.households?.living?.counts || { 困难: 0, 温饱: 0, 富裕: 0 };
  const issues = view.households?.issueCounts || {};
  const categories = (view.households?.categories || []).map(row => `<span class="mini-stat">${escapeHtml(row.name.replace(/家庭$/, ""))} <b>${number(row.households)}户</b>${row.satisfaction == null ? "" : `<i>舒心${number(row.satisfaction,1)}</i>`}</span>`).join("");
  const urgent = (view.households?.details || []).filter(row => row.issues?.length).sort((a,b)=>a.satisfaction-b.satisfaction).slice(0,8);
  const householdCards = urgent.map(row => `<div class="cardlet"><div class="row"><span class="label">${escapeHtml(row.name)} · ${number(row.people)}人</span><strong class="value">舒心 ${number(row.satisfaction,1)}</strong></div><div class="subtle">${row.issues.map(escapeHtml).join(" · ")}</div><div class="row"><span class="label">口粮 / 粮券</span><strong class="value">${number(row.foodDays,1)}日 / ${number(row.voucher,1)}券</strong></div><details class="detail-block" data-detail-key="family-${escapeHtml(row.id)}"><summary>近期收支</summary><div class="detail-body"><div class="row"><span class="label">实际到账 / 生活支出</span><strong class="value">${number(row.recent.incomeVoucher,1)} / ${number(row.recent.lifeExpenseVoucher,1)}小麦等值</strong></div><div class="row"><span class="label">实物收入 / 吃掉口粮</span><strong class="value">${number(row.recent.inKindIncomeJin,1)} / ${number(row.recent.foodConsumedJin,1)}斤</strong></div><div class="row"><span class="label">应付工资 / 实发</span><strong class="value">${number(row.recent.wageDueVoucher,1)} / ${number(row.recent.wagePaidVoucher,1)}小麦等值</strong></div><div class="row"><span class="label">投资</span><strong class="value">${number(row.recent.investmentVoucher,1)}小麦等值</strong></div><div class="row"><span class="label">年收入预期</span><strong class="value">${number(row.incomeExpectationJin)}斤/年</strong></div>${row.depositPropensity == null ? "" : `<div class="row"><span class="label">存款 / 股票倾向</span><strong class="value">${number(row.depositPropensity * 100, 0)}% / ${number(row.stockPropensity * 100, 0)}%</strong></div>`}</div></details></div>`).join("");
  return `<section class="panel-section"><h2>家庭生活</h2>
    <div class="cardlet"><div class="row"><span class="label">全镇舒心值</span><strong class="value">${number(view.satisfaction,1)} / 100 · ${view.households?.satisfactionChange >= 0 ? "+" : ""}${number(view.households?.satisfactionChange || 0,1)}</strong></div>
      <div class="row"><span class="label">缺粮 / 缺盐 / 住房不足 / 欠薪</span><strong class="value">${number(issues.food||0)} / ${number(issues.salt||0)} / ${number(issues.housing||0)} / ${number(issues.wage||0)}户</strong></div>
      <div class="row"><span class="label">生活状况</span><strong class="value">困难${number(living.困难)} · 温饱${number(living.温饱)} · 富裕${number(living.富裕)}</strong></div>
      <div class="row"><span class="label">今日剩余换券额度</span><strong class="value">${number(view.households?.exchangeRemainingJin || 0, 2)}斤</strong></div>
      <div class="mini-stats">${categories}</div>
    </div>${householdCards ? `<details class="detail-block" data-detail-key="urgent-households"><summary>需关注家庭 · ${number(urgent.length)}户</summary><div class="detail-body">${householdCards}</div></details>` : ""}</section>
    <section class="panel-section">${renderJobs(view)}</section>
    <section class="panel-section">${renderPeople(view)}</section>`;
}
