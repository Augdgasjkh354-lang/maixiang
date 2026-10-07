import { number } from "./format.js";

function laborMoodText(mood) {
  if (mood === "slack") return "失业多，商店压工资";
  if (mood === "tight") return "人手紧，商店加工资";
  return "行情平稳";
}

function wealthRows(w, label) {
  if (!w) return "";
  return `<div class="row"><span class="label">${label}人均家底 穷10% / 中位 / 富10%</span><strong class="value">${number(w.poorWealthPerCapita, 0)} / ${number(w.medianWealthPerCapita, 0)} / ${number(w.richWealthPerCapita, 0)}</strong></div><div class="row"><span class="label">最富10%占全镇家底</span><strong class="value">${number(w.richWealthSharePercent, 1)}%</strong></div><div class="row"><span class="label">${label}人均年收入 穷10% / 中位 / 富10%</span><strong class="value">${number(w.poorIncomePerCapita, 0)} / ${number(w.medianIncomePerCapita, 0)} / ${number(w.richIncomePerCapita, 0)}</strong></div>`;
}

function wealthCardlet(view) {
  const now = view.wealthNow || null;
  const history = (view.annualReports || []).filter(r => r.wealth).slice(-5);
  if (!now && !history.length) return "";
  const past = history.map(r => `<div class="row"><span class="label">第${number(r.year)}年 穷10% / 中位 / 富10% 人均家底</span><strong class="value">${number(r.wealth.poorWealthPerCapita, 0)} / ${number(r.wealth.medianWealthPerCapita, 0)} / ${number(r.wealth.richWealthPerCapita, 0)}</strong></div>`).join("");
  return `<div class="cardlet" style="margin-top:10px"><div class="setting-title">贫富分布</div>${wealthRows(now, "今年")}<p class="subtle">家底 = 粮券 + 存粮存货按批发价折粮券；收入含秋收分粮。按人口排，"穷10%"是最穷的一成人。</p>${past ? `<details class="detail-block" data-detail-key="wealth-history"><summary>历年对比</summary><div class="detail-body">${past}</div></details>` : ""}</div>`;
}

export function renderPeople(view) {
  const p = view.people;
  const sum = Math.max(1, p.total);
  const housing = Math.min(100, p.total / view.housingCapacity * 100);
  const last = view.lastDemography || { births: 0, deaths: 0, marriages: 0 };
  const reports = view.annualReports || [];
  const labor = last.laborChange || reports.at(-1)?.laborChange || null;
  const market = view.laborMarket || null;
  const highPct = view.laborUnemploymentHighPercent ?? 8;
  const lowPct = view.laborUnemploymentLowPercent ?? 5;
  return `<h2>人口</h2>
    <div class="age-bars">
      <div class="age-line"><span>未成年人</span><div class="meter"><span style="width:${p.children / sum * 100}%"></span></div><strong>${number(p.children)}人</strong></div>
      <div class="age-line"><span>劳动年龄</span><div class="meter"><span style="width:${p.workers / sum * 100}%;background:linear-gradient(90deg,#557d50,#73975b)"></span></div><strong>${number(p.workers)}人</strong></div>
      <div class="age-line"><span>老人</span><div class="meter"><span style="width:${p.elders / sum * 100}%;background:linear-gradient(90deg,#ad8d51,#d0b66b)"></span></div><strong>${number(p.elders)}人</strong></div>
    </div>
    ${market ? `<div class="cardlet" style="margin-top:10px"><div class="row"><span class="label">失业率</span><strong class="value">${number(market.unemploymentRate * 100, 1)}% · ${laborMoodText(market.mood)}</strong></div><div class="row"><span class="label">待业 / 劳动年龄</span><strong class="value">${number(market.idle)} / ${number(market.workers)}人</strong></div><div class="row"><span class="label">公职平均日薪 / 商店目标日薪</span><strong class="value">${number(market.referenceWage, 1)} / ${number(market.targetShopWage, 1)}</strong></div><p class="subtle">失业率高于${highPct}%时商店老板压低工资，低于${lowPct}%时愿意多给；参照你定的公职岗位工资。</p></div>` : ""}
    <div class="cardlet" style="margin-top:10px"><div class="row"><span class="label">人口 / 住房</span><strong class="value">${number(p.total)} / ${number(view.housingCapacity)}人</strong></div><div class="meter"><span style="width:${housing}%"></span></div><div class="row"><span class="label">住房缺口</span><strong class="value">${number(view.housing.shortage)}人</strong></div><div class="row"><span class="label">食盐保障</span><strong class="value">${number(view.salt.historyCoverage * 100, 1)}%</strong></div><div class="row"><span class="label">舒心值</span><strong class="value">${number(view.satisfaction)} / 100</strong></div></div>
    <details class="detail-block" data-detail-key="population-history"><summary>上年人口变化</summary><div class="detail-body"><div class="row"><span class="label">出生 / 死亡</span><strong class="value">${number(last.births)} / ${number(last.deaths)}人</strong></div><div class="row"><span class="label">新结夫妇</span><strong class="value">${number(last.marriages)}对</strong></div>${labor ? `<div class="row"><span class="label">年初 / 年末劳动力</span><strong class="value">${number(labor.openingWorkers)} / ${number(labor.closingWorkers)}人</strong></div><div class="row"><span class="label">成年 / 退休</span><strong class="value">${number(labor.adults)} / ${number(labor.retirees)}人</strong></div>` : `<div class="subtle">完成本年度后显示劳动力变化。</div>`}</div></details>
    ${wealthCardlet(view)}`;
}
