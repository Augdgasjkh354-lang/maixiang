// 家庭购买力：所有"想买多少、花多少"的决定都从这里取数。
//
// 家底（存量）= 手头粮券 + 银行存款 + 留够 wealthFoodReserveDays（30）天口粮之后多出来的小麦（按券值）。
//   存款随时可取回付款（支付层自动取回），算家底。
// 可动用预算 B（斤/人/年）= 人均年收入 + usableWealthShare（默认 10%）× 人均家底。
//   年收入 = 近期日收入 × 360 + 最近一次秋收所得（household.lastHarvestIncomeJin，斤，1 斤 = 1 券）。
//   近期日收入 = household.recentIncomeUnits，指数滑动平均，半衰期 incomeHalfLifeDays，只含收入类付款与利息、分红、养老金、补贴等（见 household-life.js 的 BUDGET_INCOME_TYPES）；
//   务农分粮不进指数平均（秋收一次性入账，进了会让秋收后几周虚高、随后快速衰减），而是整年连续按上一次秋收所得计入。
//   没有近期记录时（开局、旧档）用收入预期 incomeExpectationJin ÷ 360 作初值（扣掉务农部分）。它是"流量"，家底是"存量"，两者相加才是这户一年能动用的钱。
// 参照预算 R（斤/人/年）= referenceBudgetPerCapitaJin × 物价指数。物价指数 = 篮子（面粉、面包、盐，权重见 rules）
//   当前价相对开局价（rules.wholesaleDefaultSalePrices，开局时批发市场的售价）的加权平均；缺价格按 1。小麦钉在 1 券/斤，不进篮子。
// 宽裕度 m = Mmax × tanh(a × √(B / R))，a = atanh(1 / Mmax)，Mmax = maxAffluence（渐近上限，不是硬封顶）：
//   B = R 时 m = 1 是"正常人家"（日用品按标准量买、主食按标准比例换成面粉面包）；
//   B 趋近 0 时 m 趋近 0，几乎只吃自家小麦；B 很大时 m 平缓趋近 Mmax。
// 每日可花 = 这户的可动用预算 ÷ daysPerYear；服务预算 = 每日可花 × serviceShare。
//
// 结果按"当天"缓存（不进存档），同一天里各个购买步骤看到同一个宽裕度。
import { currencyScale } from "../economy/currency.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { currentUnitPrice } from "../economy/prices.js";
import { householdConvertibleWheatUnits, householdList, householdPopulation, isActiveHousehold } from "./households.js";
import { householdLastHarvestIncomeUnits, householdRecentIncomeUnitsPerDay } from "./household-life.js";
import { householdLoanBalanceMap, householdLoanBalanceUnits } from "./household-loans.js";

const cache = new WeakMap();

function budgetRules(content) {
  return {
    referenceBudgetPerCapitaJin: 1890, maxAffluence: 4, usableWealthShare: 0.1, basket: { flour: 0.5, bread: 0.3, salt: 0.2 },
    harvestBufferDays: 30, serviceShare: 0.35,
    ...(content.rules.householdBudget || {})
  };
}

// 宽裕度函数：m = Mmax × tanh(a × √ratio)，a = atanh(1/Mmax)。ratio = 可动用预算 / 参照预算。
// ratio = 1 时 m = 1；ratio → 0 时 m → 0；ratio 很大时 m 平缓趋近 Mmax（永不达到）。
export function affluenceFromRatio(ratio, maxAffluence = 4) {
  const cap = maxAffluence > 1 ? maxAffluence : 4;
  if (!(ratio > 0)) return 0;
  return cap * Math.tanh(Math.atanh(1 / cap) * Math.sqrt(ratio));
}

// 开局价：批发市场开局的售价表（开局时 currentUnitPrice 就取这里）；没有则回落到官价 marketPricesVoucherPerUnit。
function openingPrice(content, itemId) {
  const opening = Number(content.rules.wholesaleDefaultSalePrices?.[itemId]);
  if (opening > 0) return opening;
  return Number(content.rules.marketPricesVoucherPerUnit?.[itemId]);
}

// 物价指数：篮子里商品当前价相对开局价的加权平均（开局时为 1）。缺价格的商品按 1（不动）。
export function householdPriceIndex(state, content) {
  const rules = budgetRules(content);
  let weighted = 0;
  let total = 0;
  for (const [itemId, weight] of Object.entries(rules.basket || {})) {
    if (!(weight > 0)) continue;
    total += weight;
    const price = currentUnitPrice(state, itemId, content);
    const base = openingPrice(content, itemId);
    const ratio = Number.isFinite(price) && price > 0 && base > 0 ? price / base : 1;
    weighted += weight * ratio;
  }
  return total > 0 ? weighted / total : 1;
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

// 家底（毛）：粮券 + 存款 + 超出 30 天口粮的小麦，不扣贷款。
export function householdGrossWealthUnits(state, household, content) {
  const rules = budgetRules(content);
  // 只留 30 天口粮：留到秋收会让秋收前余粮被截成 0，宽裕度在 0.3 和 2.7 之间来回跳。
  const keepDays = rules.wealthFoodReserveDays ?? 30;
  const surplusWheat = householdConvertibleWheatUnits(state, household, content, keepDays);
  const deposit = Math.max(0, state.bank?.deposits?.[household.id] || 0);
  return Math.max(0, household.voucherUnits || 0) + deposit + voucherUnitsForWheatUnits(surplusWheat, content, "floor");
}

// 净家底 = 家底 − 该户民间贷款余额，下限 0（docs/LENDING.md）。loanMap 可传入全镇一次汇总的余额表（住户 id → 余额）。
export function householdWealthUnits(state, household, content, loanMap = null) {
  const gross = householdGrossWealthUnits(state, household, content);
  const debt = loanMap ? (loanMap.get(household.id) || 0) : householdLoanBalanceUnits(state, household.id);
  return Math.max(0, gross - debt);
}

// 一户一年的收入（券单位）= 近期日收入 × 一年天数 + 最近一次秋收所得。
function householdAnnualIncomeUnits(household, content) {
  return householdRecentIncomeUnitsPerDay(household, content) * (content.rules.daysPerYear || 360) + householdLastHarvestIncomeUnits(household, content);
}

export function householdIncomePerCapitaJin(household, content) {
  const people = Math.max(1, householdPopulation(household));
  return householdAnnualIncomeUnits(household, content) / currencyScale(content) / people;
}

// 一户的可动用预算（券单位）：一年收入 + usableWealthShare × 家底。
function householdBudgetUnits(household, wealthUnits, content, rules) {
  return householdAnnualIncomeUnits(household, content) + rules.usableWealthShare * wealthUnits;
}

function computeRow(state, household, content, priceIndex = null, loanMap = null) {
  const rules = budgetRules(content);
  const people = Math.max(1, householdPopulation(household));
  const wealthUnits = householdWealthUnits(state, household, content, loanMap);
  const index = priceIndex ?? householdPriceIndex(state, content);
  const scale = currencyScale(content);
  const budgetUnits = householdBudgetUnits(household, wealthUnits, content, rules);
  const incomePerCapitaJin = householdIncomePerCapitaJin(household, content);
  const budgetPerCapitaJin = budgetUnits / scale / people;
  const referenceJin = Math.max(1e-9, rules.referenceBudgetPerCapitaJin * index);
  const ratio = budgetPerCapitaJin / referenceJin;
  const affluence = affluenceFromRatio(ratio, rules.maxAffluence);
  const dailySpendUnits = Math.floor(budgetUnits / Math.max(1, content.rules.daysPerYear || 360));
  return { householdId: household.id, people, wealthUnits, wealthPerCapita: wealthUnits / scale / people,
    incomePerCapitaJin, budgetPerCapitaJin, referenceBudgetPerCapitaJin: referenceJin, ratio, affluence, dailySpendUnits,
    serviceBudgetUnits: Math.floor(dailySpendUnits * rules.serviceShare) };
}

// 当天每户的购买力（首次调用时算，当天复用）。
export function householdBudgets(state, content) {
  const serial = daySerial(state, content);
  const hit = cache.get(state);
  if (hit && hit.serial === serial) return hit.rows;
  const priceIndex = householdPriceIndex(state, content);
  const loanMap = householdLoanBalanceMap(state);
  const rows = new Map(householdList(state).filter(isActiveHousehold).map(h => [h.id, computeRow(state, h, content, priceIndex, loanMap)]));
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
    incomePerCapitaJin: rows.reduce((sum, row) => sum + row.incomePerCapitaJin * row.people, 0) / Math.max(1, people),
    budgetPerCapitaJin: rows.reduce((sum, row) => sum + row.budgetPerCapitaJin * row.people, 0) / Math.max(1, people),
    referenceBudgetPerCapitaJin: rows[0].referenceBudgetPerCapitaJin,
    priceIndex: householdPriceIndex(state, content),
    dailySpendPerCapita: rows.reduce((sum, row) => sum + row.dailySpendUnits, 0) / scale / Math.max(1, people),
    poorShare: rows.filter(row => row.affluence < 0.5).reduce((sum, row) => sum + row.people, 0) / Math.max(1, people),
    richShare: rows.filter(row => row.affluence >= 1.5).reduce((sum, row) => sum + row.people, 0) / Math.max(1, people)
  };
}
