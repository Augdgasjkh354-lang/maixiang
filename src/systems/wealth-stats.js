// 经济统计（移植自用户 0.1.11 优化）：贫富分布、经济历史曲线。
//
// - computeWealthStats：按人口排的家底/收入分布。家底 = 全口径（与界面基尼、富人税同一口径，见 redistribution.js 的 wealthDistributionRows）：
//   粮券 + 存款 + 超额小麦 + 股票 + 民营楼 + 国债本金；收入 = 粮券收入 + 秋收分粮等实物收入。
//   输出穷10%/中位/富10%人均家底、穷10%/中位/富10%人均年收入、最富10%占全镇家底比、基尼。
// - recordEconomyHistory：每日记录失业率、店员均薪、小麦批发价、镇库小麦、
//   居民口粮天数，供地图上的"经济"迷你面板画走势。

import { householdList, householdPopulation, isActiveHousehold } from "./households.js";
import { wholesaleUnitPrice } from "./wholesale-market.js";
import { shopWage } from "./labor-market.js";
import { computeLaborMarket } from "./labor-market.js";
import { totalQeqUnits } from "../economy/inventory.js";
import { giniCoefficient, topWealthSharePercent, wealthDistributionRows } from "./redistribution.js";

// 批发价（用户原 W0）：批发市场价 → 遗留市场价 → 食盐规则价 → 规则默认值。
export function wholesalePrice(state, itemId, content) {
  const market = state.wholesaleMarket?.pricesVoucherPerUnit || {};
  if (Number.isFinite(market[itemId]) && market[itemId] > 0) return Number(market[itemId]);
  const legacy = state.market?.pricesVoucherPerUnit || {};
  if (Number.isFinite(legacy[itemId]) && legacy[itemId] > 0) return Number(legacy[itemId]);
  if (itemId === "salt" && Number.isFinite(content.rules.saltPriceWheatPerJin)) {
    return Number(content.rules.saltPriceWheatPerJin);
  }
  return Number(content.rules.marketPricesVoucherPerUnit?.[itemId] ?? 0);
}

function priceMap(state, content) {
  const map = {};
  for (const itemId of Object.keys(content.items || {})) map[itemId] = wholesalePrice(state, itemId, content);
  return map;
}

// 家庭家底（粮券，含存粮存货按批发价折算）。用户原 JQ。
export function householdWealth(state, household, content, prices = null) {
  const scale = content.precision.currencyUnitsPerVoucher || content.precision.inventoryUnitsPerJin;
  const map = prices || priceMap(state, content);
  let wealth = (household.voucherUnits || 0) / scale;
  for (const [itemId, units] of Object.entries(household.inventory || {})) {
    if (!(units > 0) || !content.items?.[itemId]) continue;
    wealth += units / content.precision.inventoryUnitsPerJin * (map[itemId] ?? 0);
  }
  return wealth;
}

// 分位区间人均值（用户原 J5）：sorted 按人均 field 升序，取人口占比 [fromFrac,toFrac] 区间的人均。
function decileAverage(sorted, fromFrac, toFrac, field, totalPeople) {
  const lo = totalPeople * fromFrac;
  const hi = totalPeople * toFrac;
  let cursor = 0;
  let weighted = 0;
  let people = 0;
  for (const row of sorted) {
    const start = Math.max(cursor, lo);
    const end = Math.min(cursor + row.people, hi);
    if (end > start) {
      weighted += row[field] / row.people * (end - start);
      people += end - start;
    }
    cursor += row.people;
    if (cursor >= hi) break;
  }
  return people > 0 ? weighted / people : 0;
}

const round1 = value => Math.round(value * 10) / 10;

// 贫富分布（用户原 a$）。返回 null 表示无有效人口。
// 家底口径与界面基尼、富人税一致：复用 redistribution.js 的 wealthDistributionRows（全口径：粮券 + 存款 + 超额小麦 + 股票 + 民营楼 + 国债本金），
// 基尼与最富占比也复用 giniCoefficient / topWealthSharePercent，不另写公式。换算成粮券（人均家底单位）。
export function computeWealthStats(state, content) {
  const scale = content.precision.currencyUnitsPerVoucher || content.precision.inventoryUnitsPerJin;
  const wheatPrice = wholesalePrice(state, "wheat", content) ?? 1;
  const incomeById = new Map();
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const life = household.life || {};
    incomeById.set(household.id, (life.year?.incomeVoucherUnits || 0) / scale
      + (life.year?.inKindIncomeQeqUnits || 0) / content.precision.qeqUnitsPerJin * wheatPrice);
  }
  const rows = wealthDistributionRows(state, content).map(row => ({
    people: row.people,
    wealth: row.wealth / scale,
    income: incomeById.get(row.householdId) || 0
  }));
  const totalPeople = rows.reduce((sum, row) => sum + row.people, 0);
  if (totalPeople <= 0) return null;
  const totalWealth = rows.reduce((sum, row) => sum + row.wealth, 0);
  const byWealth = rows.slice().sort((a, b) => a.wealth / a.people - b.wealth / b.people);
  const byIncome = rows.slice().sort((a, b) => a.income / a.people - b.income / b.people);
  const gini = giniCoefficient(rows);
  return {
    households: rows.length,
    people: totalPeople,
    wealthPerCapita: round1(totalWealth / totalPeople),
    poorWealthPerCapita: round1(decileAverage(byWealth, 0, 0.1, "wealth", totalPeople)),
    medianWealthPerCapita: round1(decileAverage(byWealth, 0.45, 0.55, "wealth", totalPeople)),
    richWealthPerCapita: round1(decileAverage(byWealth, 0.9, 1, "wealth", totalPeople)),
    richWealthSharePercent: round1(topWealthSharePercent(rows, 0.1)),
    gini: gini === null ? null : Math.round(gini * 10000) / 10000,
    poorIncomePerCapita: round1(decileAverage(byIncome, 0, 0.1, "income", totalPeople)),
    medianIncomePerCapita: round1(decileAverage(byIncome, 0.45, 0.55, "income", totalPeople)),
    richIncomePerCapita: round1(decileAverage(byIncome, 0.9, 1, "income", totalPeople))
  };
}

// 全镇在营店铺平均店员日薪（用户原 uM）。
export function averageShopWage(state, content) {
  let sum = 0;
  let count = 0;
  for (const shop of Object.values(state.shops || {})) {
    if (shop.status !== "open") continue;
    const clerks = jobCountFor(state, `shop:${shop.id}:clerk`);
    if (clerks <= 0) continue;
    sum += shopWage(state, shop, content) * clerks;
    count += clerks;
  }
  return count > 0 ? sum / count : null;
}

function jobCountFor(state, jobKey) {
  let total = 0;
  for (const household of householdList(state)) total += Math.max(0, household.jobs?.[jobKey] || 0);
  return total;
}

function residentFoodDays(state, content) {
  const perPerson = content.rules.foodPerPersonDay * content.precision.qeqUnitsPerJin;
  if (!(perPerson > 0)) return null;
  const qeq = totalQeqUnits(state, content);
  const people = householdList(state).reduce((sum, h) => sum + householdPopulation(h), 0);
  if (!(people > 0)) return null;
  return qeq / (perPerson * people);
}

// 每日经济快照（用户原 lM/z9）：保留最近 economyHistoryDays 天。
export function recordEconomyHistory(state, content) {
  state.economyHistory = Array.isArray(state.economyHistory) ? state.economyHistory : [];
  const market = computeLaborMarket(state, content);
  const avgWage = averageShopWage(state, content);
  const foodDays = residentFoodDays(state, content);
  state.economyHistory.push({
    year: state.year,
    day: state.day,
    unemploymentPercent: Math.round(market.unemploymentRate * 1000) / 10,
    idle: market.idle,
    publicWage: Math.round(market.referenceWage * 10) / 10,
    shopWage: avgWage === null ? null : Math.round(avgWage * 10) / 10,
    wheatPrice: wholesalePrice(state, "wheat", content),
    townWheatJin: Math.round((state.accounts?.town?.wheat || 0) / content.precision.inventoryUnitsPerJin),
    residentFoodDays: Number.isFinite(foodDays) ? Math.round(foodDays * 10) / 10 : null
  });
  const keep = content.rules.economyHistoryDays ?? 60;
  if (state.economyHistory.length > keep) state.economyHistory.splice(0, state.economyHistory.length - keep);
}
