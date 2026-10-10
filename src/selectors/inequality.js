// 贫富面板数据（docs/REDISTRIBUTION.md 第 5 条）。只读：不写 state。
// 基尼与最富占比用全口径家底（wealthDistributionRows：粮券 + 存款 + 超额小麦 + 股票 + 民营建筑 + 国债本金，与富人税征税口径一致）；
// 税档人家数取最近一次富人税评估（lastRun）。逐年基尼由日结年末写入 state.redistribution.giniHistory（同口径，旧档的旧口径曲线不迁移）。
import { currencyScale } from "../economy/currency.js";
import { giniCoefficient, inheritanceTaxPercent, topWealthSharePercent, wealthDistributionRows, wealthTaxPolicy } from "../systems/redistribution.js";

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

export function selectInequality(state, content) {
  const scale = currencyScale(content);
  const rows = wealthDistributionRows(state, content);
  const people = rows.reduce((sum, row) => sum + row.people, 0);
  const wealth = rows.reduce((sum, row) => sum + row.wealth, 0);
  const gini = giniCoefficient(rows);
  const redistribution = state.redistribution || {};
  const lastRun = redistribution.lastRun || null;
  const policy = wealthTaxPolicy(state);
  const bookYear = redistribution.year || {};
  const lastThresholds = lastRun?.thresholds || [];
  const lastRates = lastRun?.ratesPercent || [];
  return {
    households: rows.length,
    people,
    // wealth 为内部单位，除以 scale 得粮券。
    wealthPerCapita: people > 0 ? round(wealth / scale / people) : 0,
    gini: gini === null ? null : Math.round(gini * 10000) / 10000,
    top1SharePercent: round(topWealthSharePercent(rows, 0.01)),
    top10SharePercent: round(topWealthSharePercent(rows, 0.1)),
    policy: {
      thresholdsVoucher: policy.thresholds.slice(),
      ratesPercent: policy.ratesPercent.slice(),
      inheritanceTaxPercent: inheritanceTaxPercent(state)
    },
    // 税档人家数：最近一次富人税评估（每 30 天），brackets[0] 为免征档。
    assessed: lastRun ? { year: lastRun.year, day: lastRun.day, households: lastRun.households } : null,
    brackets: (lastRun?.brackets || []).map((row, index) => ({
      index,
      minPerCapitaVoucher: index === 0 ? 0 : (lastThresholds[index - 1] ?? null),
      ratePercent: index === 0 ? 0 : (lastRates[index - 1] ?? 0),
      households: row.households,
      people: row.people
    })),
    thisYear: {
      wealthTaxVoucher: round((bookYear.wealthTaxUnits || 0) / scale, 2),
      wealthTaxWaivedVoucher: round((bookYear.wealthTaxWaivedUnits || 0) / scale, 2),
      wealthTaxPayers: bookYear.wealthTaxPayers || 0,
      inheritanceTaxVoucher: round((bookYear.inheritanceTaxUnits || 0) / scale, 2),
      inheritancePayers: bookYear.inheritancePayers || 0,
      escheatVoucher: round((bookYear.escheatUnits || 0) / scale, 2),
      escheatHouseholds: bookYear.escheatHouseholds || 0,
      escheatBuildings: bookYear.escheatBuildings || 0
    },
    giniHistory: (redistribution.giniHistory || []).slice(-50)
  };
}
