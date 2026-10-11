import { MODS } from "../mods/registry.js";
import { modComfortPoints } from "../mods/api.js";
import { householdList, householdPopulation, isActiveHousehold } from "./households.js";
import { ensureHouseholdLife, householdFoodDays } from "./household-life.js";
import { goodsComfortPoints } from "./goods-demand.js";

// 满意度分项是派生数据，不进存档：日结算出的"每户最近一次分项"和"全镇分项行"挂在 WeakMap 里，JSON 存档里看不到。
// 读档后没有缓存，界面用 currentSatisfactionFactorRows 按当前数据现算一份同口径的行（下一次日结即被真值替换）。
const householdFactorCache = new WeakMap();
const factorRowCache = new WeakMap();

function clamp01(value) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function round2(value) { return Math.round(value * 100) / 100; }

// 单户满意度分项（纯函数：只读，不改 state，日结与界面共用同一算式）。
// extras.housingRow：该户住房行（含 unhousedPeople）；extras.saltGrace：盐宽限期内时盐覆盖按满足计。
export function householdSatisfactionFactors(state, household, content, extras = {}) {
  const cfg = content.rules.householdSatisfaction || {};
  const scale = content.precision.currencyUnitsPerVoucher;
  const saltPerPersonDayUnits = content.rules.saltAnnualDemandJinPerPerson * content.precision.inventoryUnitsPerJin / content.rules.daysPerYear;
  const life = household.life || {};
  const day = life.day || {};
  const people = Math.max(1, householdPopulation(household));
  const dailyFoodNeed = people * content.rules.foodPerPersonDay * content.precision.qeqUnitsPerJin;
  const foodCoverage = clamp01((day.foodConsumedQeqUnits || 0) / Math.max(1, dailyFoodNeed));
  const saltNeed = people * saltPerPersonDayUnits;
  const saltCoverage = extras.saltGrace ? 1 : clamp01((day.saltConsumedUnits || 0) / Math.max(1, saltNeed));
  const housingRow = extras.housingRow;
  const housingCoverage = housingRow ? clamp01((people - (housingRow.unhousedPeople || 0)) / people) : 1;
  const wageDue = day.wageDueVoucherUnits || 0;
  const wageCoverage = wageDue > 0 ? clamp01((day.wagePaidVoucherUnits || 0) / wageDue) : 1;
  const foodDays = householdFoodDays(state, household, content);
  const reserveCoverage = clamp01(foodDays / (cfg.reserveTargetDays || 30));
  const obs = life.observation || { rows: [], totals: {} };
  const recent = obs.totals || {};
  const days = Math.max(1, (obs.rows?.length || 0) + 1);
  const disposablePerCapitaDay = (((recent.incomeVoucherUnits || 0) + (day.incomeVoucherUnits || 0)) - ((recent.lifeExpenseVoucherUnits || 0) + (day.lifeExpenseVoucherUnits || 0))) / scale / people / days;
  const disposableCoverage = clamp01((disposablePerCapitaDay + (cfg.disposableTargetVoucherPerCapitaDay || 1.5)) / (2 * (cfg.disposableTargetVoucherPerCapitaDay || 1.5)));
  const breadComfort = (cfg.breadComfortMaximum || 5) * clamp01((day.breadConsumedQeqUnits || 0) / Math.max(1, dailyFoodNeed * 0.25));
  const meatComfort = (content.rules.meatStaple?.comfortMaximum ?? 0) * clamp01((day.meatConsumedQeqUnits || 0) / Math.max(1, dailyFoodNeed * 0.25));
  const serviceComfort = Math.max(0, Math.min(content.rules.serviceComfortDailyMaximum || 3, day.serviceComfortPoints || 0));
  const goodsComfort = goodsComfortPoints(state, household, people, day, content) + modComfortPoints(state, household, people, day, content, MODS);
  const target = Math.max(0, Math.min(100,
    (cfg.foodWeight || 35) * foodCoverage + (cfg.saltWeight || 12) * saltCoverage +
    (cfg.housingWeight || 15) * housingCoverage + (cfg.wageWeight || 15) * wageCoverage +
    (cfg.reserveWeight || 13) * reserveCoverage + (cfg.disposableWeight || 5) * disposableCoverage + breadComfort + meatComfort + serviceComfort + goodsComfort));
  return { foodCoverage, saltCoverage, housingCoverage, wageCoverage, reserveCoverage, disposableCoverage, breadComfort, meatComfort, serviceComfort, goodsComfort, target, foodDays, disposablePerCapitaDay };
}

export function updateSatisfaction(state, population, comfortQeqUnits, content, extras = {}) {
  const housingByHousehold = new Map((extras.housing?.householdHousing || []).map(row => [row.householdId, row]));
  let weighted = 0;
  let peopleTotal = 0;
  const issueCounts = { food: 0, salt: 0, housing: 0, wage: 0 };
  const rows = [];
  for (const household of householdList(state).filter(isActiveHousehold)) {
    const people = Math.max(1, householdPopulation(household));
    const life = ensureHouseholdLife(household, content);
    const factors = householdSatisfactionFactors(state, household, content, { housingRow: housingByHousehold.get(household.id), saltGrace: extras.saltGrace });
    const wageDue = life.day.wageDueVoucherUnits || 0;
    const prior = Number.isFinite(life.satisfaction) ? life.satisfaction : (state.satisfaction || 75);
    const alpha = factors.foodCoverage < 0.75 ? (content.rules.satisfactionUrgentFoodSmoothing || 0.55) : (content.rules.satisfactionSmoothing || 0.18);
    life.satisfaction = round2(prior * (1 - alpha) + factors.target * alpha);
    householdFactorCache.set(household, factors);
    if (factors.foodCoverage < 0.999) issueCounts.food += 1;
    if (!extras.saltGrace && factors.saltCoverage < 0.999) issueCounts.salt += 1;
    if (factors.housingCoverage < 0.999) issueCounts.housing += 1;
    if (wageDue > 0 && factors.wageCoverage < 0.999) issueCounts.wage += 1;
    weighted += life.satisfaction * people;
    peopleTotal += people;
    rows.push({ householdId: household.id, people, satisfaction: life.satisfaction, ...factors });
  }
  state.satisfaction = round2(weighted / Math.max(1, peopleTotal));
  state.satisfactionHistory ||= [];
  state.satisfactionHistory.push({ year: state.year, day: state.day + 1, value: state.satisfaction });
  const historyLimit = content.rules.householdLifeHistoryDays || 90;
  if (state.satisfactionHistory.length > historyLimit) state.satisfactionHistory.splice(0, state.satisfactionHistory.length - historyLimit);
  state.satisfactionFactors = { target: state.satisfaction, householdWeighted: true, issueCounts };
  factorRowCache.set(state, rows);
  return state.satisfactionFactors;
}

// 某户最近一次日结算出的分项（没有则 null）。
export function lastHouseholdFactors(household) {
  return householdFactorCache.get(household) || null;
}

// 全镇满意度分项行：日结算过则返回缓存；否则（刚读档）按当前数据现算，只读。
export function currentSatisfactionFactorRows(state, content, housingByHousehold = new Map()) {
  const cached = factorRowCache.get(state);
  if (cached) return cached;
  const saltGrace = Boolean(state.salt) && state.salt.graceDaysElapsed < content.rules.saltGraceDays;
  return householdList(state).filter(isActiveHousehold).map(household => {
    const people = Math.max(1, householdPopulation(household));
    const factors = householdSatisfactionFactors(state, household, content, { housingRow: housingByHousehold.get(household.id), saltGrace });
    return { householdId: household.id, people, satisfaction: household.life?.satisfaction ?? state.satisfaction, ...factors };
  });
}
