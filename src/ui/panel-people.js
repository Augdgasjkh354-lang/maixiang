import { escapeHtml, number } from "./format.js";

// 基尼系数逐年曲线（内联 SVG）。少于 2 个年份时不画。
function giniSparkline(history) {
  const rows = (history || []).filter(row => Number.isFinite(row.gini));
  if (rows.length < 2) return "";
  const width = 240, height = 56, pad = 4;
  const values = rows.map(row => row.gini);
  const low = Math.min(...values), high = Math.max(...values);
  const span = high - low || 1;
  const x = index => pad + (width - pad * 2) * index / (rows.length - 1);
  const y = value => height - pad - (height - pad * 2) * (value - low) / span;
  const points = rows.map((row, index) => `${x(index).toFixed(1)},${y(row.gini).toFixed(1)}`).join(" ");
  const first = rows[0], last = rows.at(-1);
  return `<svg class="gini-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="基尼系数逐年曲线">`
    + `<polyline fill="none" stroke="#73975b" stroke-width="1.6" stroke-linejoin="round" points="${points}"/></svg>`
    + `<div class="row"><span class="label">第${number(first.year)}年 ${number(first.gini, 2)}</span><strong class="value">第${number(last.year)}年 ${number(last.gini, 2)}</strong></div>`;
}

function bracketRows(ineq) {
  return (ineq.brackets || []).map(row => {
    const label = row.index === 0
      ? `免征档 · 人均家底低于${number(ineq.brackets[1]?.minPerCapitaVoucher ?? 0)}券`
      : `${row.index}档 · 人均家底≥${number(row.minPerCapitaVoucher)}券 · 税率${number(row.ratePercent, 1)}%`;
    return `<div class="row"><span class="label">${escapeHtml(label)}</span><strong class="value">${number(row.households)}户 / ${number(row.people)}人</strong></div>`;
  }).join("");
}

// 贫富面板（docs/REDISTRIBUTION.md 第 5 条）：基尼、最富占比、各税档人家数、本年再分配收入与逐年基尼。只读。
function inequalityCardlet(ineq) {
  if (!ineq) return "";
  const gini = ineq.gini === null || ineq.gini === undefined ? "—" : number(ineq.gini, 2);
  const assessed = ineq.assessed
    ? `<div class="subtle">税档按第${number(ineq.assessed.year)}年${number(ineq.assessed.day)}日评估（${number(ineq.assessed.households)}户）</div>`
    : `<div class="subtle">尚未做过富人税评估。</div>`;
  const year = ineq.thisYear || {};
  return `<div class="cardlet" style="margin-top:10px"><div class="setting-title">贫富与再分配</div>
    <div class="row"><span class="label">基尼系数</span><strong class="value">${gini}</strong></div>
    <div class="row"><span class="label">最富1% / 10% 占全镇家底</span><strong class="value">${number(ineq.top1SharePercent, 1)}% / ${number(ineq.top10SharePercent, 1)}%</strong></div>
    <p class="subtle">基尼与占比口径：含存款、股票、房产、国债（全口径家底，与富人税同口径）。</p>
    ${assessed}
    ${bracketRows(ineq)}
    <div class="row"><span class="label">本年富人税 / 免征</span><strong class="value">${number(year.wealthTaxVoucher, 2)} / ${number(year.wealthTaxWaivedVoucher, 2)}券</strong></div>
    <div class="row"><span class="label">本年遗产税</span><strong class="value">${number(year.inheritanceTaxVoucher, 2)}券</strong></div>
    <div class="row"><span class="label">本年无主家产归公</span><strong class="value">${number(year.escheatVoucher, 2)}券（${number(year.escheatHouseholds)}户）</strong></div>
    ${giniSparkline(ineq.giniHistory)}
  </div>`;
}

function laborMoodText(mood) {
  if (mood === "slack") return "失业多，商店压工资";
  if (mood === "tight") return "人手紧，商店加工资";
  return "行情平稳";
}

function wealthRows(w, label) {
  if (!w) return "";
  return `<div class="row"><span class="label">${label}人均家底 穷10% / 中位 / 富10%</span><strong class="value">${number(w.poorWealthPerCapita, 0)} / ${number(w.medianWealthPerCapita, 0)} / ${number(w.richWealthPerCapita, 0)}</strong></div><div class="row"><span class="label">${label}人均年收入 穷10% / 中位 / 富10%</span><strong class="value">${number(w.poorIncomePerCapita, 0)} / ${number(w.medianIncomePerCapita, 0)} / ${number(w.richIncomePerCapita, 0)}</strong></div>`;
}

function wealthCardlet(view) {
  const now = view.wealthNow || null;
  const history = (view.annualReports || []).filter(r => r.wealth).slice(-5);
  if (!now && !history.length) return "";
  const past = history.map(r => `<div class="row"><span class="label">第${number(r.year)}年 穷10% / 中位 / 富10% 人均家底</span><strong class="value">${number(r.wealth.poorWealthPerCapita, 0)} / ${number(r.wealth.medianWealthPerCapita, 0)} / ${number(r.wealth.richWealthPerCapita, 0)}</strong></div>`).join("");
  return `<div class="cardlet" style="margin-top:10px"><div class="setting-title">贫富分布</div><p class="subtle">人均家底仅计粮券与存粮，不含存款、股票、房产、国债；全口径见上方贫富与再分配。</p>${wealthRows(now, "今年")}${past ? `<details class="detail-block" data-detail-key="wealth-history"><summary>历年对比</summary><div class="detail-body">${past}</div></details>` : ""}</div>`;
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
    ${market ? `<div class="cardlet" style="margin-top:10px"><div class="row"><span class="label">失业率</span><strong class="value">${number(market.unemploymentRate * 100, 1)}% · ${laborMoodText(market.mood)}</strong></div><div class="row"><span class="label">待业 / 劳动年龄</span><strong class="value">${number(market.idle)} / ${number(market.workers)}人</strong></div><div class="row"><span class="label">公职平均月薪 / 商店目标月薪</span><strong class="value">${number(market.referenceWage * (view.monthDays || 30), 1)} / ${number(market.targetShopWage * (view.monthDays || 30), 1)}</strong></div><p class="subtle">失业率高于${highPct}%商店压薪，低于${lowPct}%加薪。</p></div>` : ""}
    <div class="cardlet" style="margin-top:10px"><div class="row"><span class="label">人口 / 住房</span><strong class="value">${number(p.total)} / ${number(view.housingCapacity)}人</strong></div><div class="meter"><span style="width:${housing}%"></span></div><div class="row"><span class="label">住房缺口</span><strong class="value">${number(view.housing.shortage)}人</strong></div><div class="row"><span class="label">食盐保障</span><strong class="value">${number(view.salt.historyCoverage * 100, 1)}%</strong></div><div class="row"><span class="label">舒心值</span><strong class="value">${number(view.satisfaction)} / 100</strong></div></div>
    <details class="detail-block" data-detail-key="population-history"><summary>上年人口变化</summary><div class="detail-body"><div class="row"><span class="label">出生 / 死亡</span><strong class="value">${number(last.births)} / ${number(last.deaths)}人</strong></div><div class="row"><span class="label">新结夫妇</span><strong class="value">${number(last.marriages)}对</strong></div>${labor ? `<div class="row"><span class="label">年初 / 年末劳动力</span><strong class="value">${number(labor.openingWorkers)} / ${number(labor.closingWorkers)}人</strong></div><div class="row"><span class="label">成年 / 退休</span><strong class="value">${number(labor.adults)} / ${number(labor.retirees)}人</strong></div>` : `<div class="subtle">完成本年度后显示劳动力变化。</div>`}</div></details>
    ${wealthCardlet(view)}
    ${inequalityCardlet(view.inequality)}`;
}
