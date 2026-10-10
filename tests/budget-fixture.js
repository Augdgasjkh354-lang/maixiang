// 测试用：把一户的宽裕度设成指定值（household-budget.js 的新口径）。
import { householdPriceIndex } from "../src/systems/household-budget.js";
import { currencyScale } from "../src/economy/currency.js";
import { householdList, householdPopulation, isActiveHousehold } from "../src/systems/households.js";
import { invalidateHouseholdBudgets } from "../src/systems/household-budget.js";

// 宽裕度 m 对应的可动用预算比值 ratio（与 affluenceFromRatio 互逆）：m = Mmax × tanh(a√ratio) ⇒ ratio = (atanh(m/Mmax)/atanh(1/Mmax))²。
export function budgetRatioForAffluence(m, content) {
  const cap = content.rules.householdBudget.maxAffluence;
  return Math.pow(Math.atanh(m / cap) / Math.atanh(1 / cap), 2);
}

// 返回让这户宽裕度恰为 m 的粮券家底（券单位）。收入预期清零，宽裕度只靠家底：
// 可动用预算 B = usableWealthShare × 家底 = ratio × 参照预算 × 人口。调用方负责把家底写进粮券并 invalidateHouseholdBudgets。
export function voucherWealthForAffluence(state, household, m, content) {
  const rules = content.rules.householdBudget;
  const people = householdPopulation(household);
  const referenceJin = rules.referenceBudgetPerCapitaJin * householdPriceIndex(state, content);
  const budgetPerCapitaJin = budgetRatioForAffluence(m, content) * referenceJin;
  household.incomeExpectationJin = 0;
  household.recentIncomeUnits = 0; // 近期收入有记录时优先于收入预期，两者都清零才是收入为零
  return Math.round(budgetPerCapitaJin / rules.usableWealthShare * people * currencyScale(content));
}

// 把所有在营家户的收入预期设成让宽裕度不低于 m（只写流量字段，不动粮券账）。给"很富"的测试夹具用。
export function setAllHouseholdsAffluenceAtLeast(state, m, content) {
  const rules = content.rules.householdBudget;
  const index = householdPriceIndex(state, content);
  for (const household of householdList(state).filter(isActiveHousehold)) {
    const people = householdPopulation(household);
    household.incomeExpectationJin = Math.ceil(budgetRatioForAffluence(m, content) * rules.referenceBudgetPerCapitaJin * index * people);
  }
  invalidateHouseholdBudgets(state);
}
