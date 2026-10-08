// 家庭购买力：所有"想买多少、花多少"的决定都从这里取数。
//
// 家底（可动用财富）= 手头粮券 + 银行存款 + 留够"到下次秋收 + 缓冲天数"口粮之后多出来的小麦（按券值）。
//   存款随时可取回付款（支付层自动取回），算家底；秋收前的存粮是一家人下一年的口粮，不算可花的钱。
// 宽裕度 m = √(人均家底 / 参照值)，封顶 maxAffluence：
//   m = 1 是"正常人家"，日用品按标准量买、主食按标准比例换成面粉面包；
//   穷户 m 接近 0，几乎只吃自家小麦；富户最多买到 maxAffluence 倍。
// 服务预算 = 家底 / 花销天数 × 服务占比。
//
// 结果按"当天"缓存（不进存档），同一天里各个购买步骤看到同一个宽裕度。
import { currencyScale } from "../economy/currency.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { householdConvertibleWheatUnits, householdList, householdPopulation, isActiveHousehold } from "./households.js";

const cache = new WeakMap();

function budgetRules(content) {
  return {
    referenceWealthPerCapita: 60, maxAffluence: 3, wealthSpendDays: 60, harvestBufferDays: 30, serviceShare: 0.35,
    ...(content.rules.householdBudget || {})
  };
}

function daySerial(state, content) {
  return (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
}

// 距下次秋收还有几天（秋收在 growingDays 那天）。
export function daysUntilHarvest(state, content) {
  const year = content.rules.daysPerYear || 365;
  const harvestDay = content.rules.growingDays || 274;
  const left = (harvestDay - (state.day || 0) + year) % year;
  return left === 0 ? year : left;
}

export function householdWealthUnits(state, household, content) {
  const rules = budgetRules(content);
  const keepDays = daysUntilHarvest(state, content) + rules.harvestBufferDays;
  const surplusWheat = householdConvertibleWheatUnits(state, household, content, keepDays);
  const deposit = Math.max(0, state.bank?.deposits?.[household.id] || 0);
  return Math.max(0, household.voucherUnits || 0) + deposit + voucherUnitsForWheatUnits(surplusWheat, content, "floor");
}

function computeRow(state, household, content) {
  const rules = budgetRules(content);
  const people = Math.max(1, householdPopulation(household));
  const wealthUnits = householdWealthUnits(state, household, content);
  const perCapita = wealthUnits / currencyScale(content) / people;
  const affluence = Math.min(rules.maxAffluence, Math.sqrt(Math.max(0, perCapita) / Math.max(1e-9, rules.referenceWealthPerCapita)));
  const dailySpendUnits = Math.floor(wealthUnits / Math.max(1, rules.wealthSpendDays));
  return { householdId: household.id, people, wealthUnits, wealthPerCapita: perCapita, affluence, dailySpendUnits,
    serviceBudgetUnits: Math.floor(dailySpendUnits * rules.serviceShare) };
}

// 当天每户的购买力（首次调用时算，当天复用）。
export function householdBudgets(state, content) {
  const serial = daySerial(state, content);
  const hit = cache.get(state);
  if (hit && hit.serial === serial) return hit.rows;
  const rows = new Map(householdList(state).filter(isActiveHousehold).map(h => [h.id, computeRow(state, h, content)]));
  cache.set(state, { serial, rows });
  return rows;
}

// 同一天里家底被外部改动（测试、读档）后，丢掉当天缓存重新算。
export function invalidateHouseholdBudgets(state) {
  cache.delete(state);
}

export function householdAffluence(state, household, content) {
  return householdBudgets(state, content).get(household.id)?.affluence ?? computeRow(state, household, content).affluence;
}

// 只读汇总，给界面和探针用。
export function selectHouseholdBudgetSummary(state, content) {
  const rows = [...householdBudgets(state, content).values()];
  if (!rows.length) return null;
  const people = rows.reduce((sum, row) => sum + row.people, 0);
  const sorted = rows.map(row => row.affluence).sort((a, b) => a - b);
  const scale = currencyScale(content);
  return {
    households: rows.length,
    averageAffluence: rows.reduce((sum, row) => sum + row.affluence * row.people, 0) / Math.max(1, people),
    medianAffluence: sorted[Math.floor((sorted.length - 1) / 2)],
    wealthPerCapita: rows.reduce((sum, row) => sum + row.wealthUnits, 0) / scale / Math.max(1, people),
    dailySpendPerCapita: rows.reduce((sum, row) => sum + row.dailySpendUnits, 0) / scale / Math.max(1, people),
    poorShare: rows.filter(row => row.affluence < 0.5).reduce((sum, row) => sum + row.people, 0) / Math.max(1, people),
    richShare: rows.filter(row => row.affluence >= 1.5).reduce((sum, row) => sum + row.people, 0) / Math.max(1, people)
  };
}
