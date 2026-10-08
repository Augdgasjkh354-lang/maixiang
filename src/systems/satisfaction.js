import { MODS } from "../mods/registry.js";
import { modComfortPoints } from "../mods/api.js";
import { householdList, householdPopulation, isActiveHousehold } from "./households.js";
import { ensureHouseholdLife, householdFoodDays } from "./household-life.js";
import { goodsComfortPoints } from "./goods-demand.js";

function clamp01(value) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function round2(value) { return Math.round(value * 100) / 100; }

export function updateSatisfaction(state, population, comfortQeqUnits, content, extras = {}) {
  const cfg = content.rules.householdSatisfaction || {};
  const scale = content.precision.currencyUnitsPerVoucher;
  const saltPerPersonDayUnits = content.rules.saltAnnualDemandJinPerPerson * content.precision.inventoryUnitsPerJin / content.rules.daysPerYear;
  const housingByHousehold = new Map((extras.housing?.householdHousing || []).map(row => [row.householdId, row]));
  let weighted = 0;
  let peopleTotal = 0;
  const issueCounts = { food: 0, salt: 0, housing: 0, wage: 0 };
  const rows = [];
  for (const household of householdList(state).filter(isActiveHousehold)) {
    const people = Math.max(1, householdPopulation(household));
    const life = ensureHouseholdLife(household, content);
    const dailyFoodNeed = people * content.rules.foodPerPersonDay * content.precision.qeqUnitsPerJin;
    const foodCoverage = clamp01((life.day.foodConsumedQeqUnits || 0) / Math.max(1, dailyFoodNeed));
    const saltNeed = people * saltPerPersonDayUnits;
    const saltCoverage = extras.saltGrace ? 1 : clamp01((life.day.saltConsumedUnits || 0) / Math.max(1, saltNeed));
    const housingRow = housingByHousehold.get(household.id);
    const housingCoverage = housingRow ? clamp01((people - (housingRow.unhousedPeople || 0)) / people) : 1;
    const wageDue = life.day.wageDueVoucherUnits || 0;
    const wageCoverage = wageDue > 0 ? clamp01((life.day.wagePaidVoucherUnits || 0) / wageDue) : 1;
    const foodDays = householdFoodDays(state, household, content);
    const reserveCoverage = clamp01(foodDays / (cfg.reserveTargetDays || 30));
    const obs = life.observation || { rows: [], totals: {} };
    const recent = obs.totals || {};
    const days = Math.max(1, (obs.rows?.length || 0) + 1);
    const disposablePerCapitaDay = (((recent.incomeVoucherUnits || 0) + (life.day.incomeVoucherUnits || 0)) - ((recent.lifeExpenseVoucherUnits || 0) + (life.day.lifeExpenseVoucherUnits || 0))) / scale / people / days;
    const disposableCoverage = clamp01((disposablePerCapitaDay + (cfg.disposableTargetVoucherPerCapitaDay || 1.5)) / (2 * (cfg.disposableTargetVoucherPerCapitaDay || 1.5)));
    const breadComfort = (cfg.breadComfortMaximum || 5) * clamp01((life.day.breadConsumedQeqUnits || 0) / Math.max(1, dailyFoodNeed * 0.25));
    const serviceComfort = Math.max(0, Math.min(content.rules.serviceComfortDailyMaximum || 3, life.day.serviceComfortPoints || 0));
    const goodsComfort = goodsComfortPoints(state, household, people, life.day, content) + modComfortPoints(state, household, people, life.day, content, MODS);
    const target = Math.max(0, Math.min(100,
      (cfg.foodWeight || 35) * foodCoverage + (cfg.saltWeight || 12) * saltCoverage +
      (cfg.housingWeight || 15) * housingCoverage + (cfg.wageWeight || 15) * wageCoverage +
      (cfg.reserveWeight || 13) * reserveCoverage + (cfg.disposableWeight || 5) * disposableCoverage + breadComfort + serviceComfort + goodsComfort));
    const prior = Number.isFinite(life.satisfaction) ? life.satisfaction : (state.satisfaction || 75);
    const alpha = foodCoverage < 0.75 ? (content.rules.satisfactionUrgentFoodSmoothing || 0.55) : (content.rules.satisfactionSmoothing || 0.18);
    life.satisfaction = round2(prior * (1 - alpha) + target * alpha);
    life.lastFactors = { foodCoverage, saltCoverage, housingCoverage, wageCoverage, reserveCoverage, disposableCoverage, breadComfort, serviceComfort, goodsComfort, target, foodDays, disposablePerCapitaDay };
    life.satisfactionHistory.push({ year: state.year, day: state.day + 1, value: life.satisfaction });
    const historyLimit = content.rules.householdLifeHistoryDays || 90;
    if (life.satisfactionHistory.length > historyLimit) life.satisfactionHistory.splice(0, life.satisfactionHistory.length - historyLimit);
    if (foodCoverage < 0.999) issueCounts.food += 1;
    if (!extras.saltGrace && saltCoverage < 0.999) issueCounts.salt += 1;
    if (housingCoverage < 0.999) issueCounts.housing += 1;
    if (wageDue > 0 && wageCoverage < 0.999) issueCounts.wage += 1;
    weighted += life.satisfaction * people;
    peopleTotal += people;
    rows.push({ householdId: household.id, people, satisfaction: life.satisfaction, ...life.lastFactors });
  }
  state.satisfaction = round2(weighted / Math.max(1, peopleTotal));
  state.satisfactionHistory ||= [];
  state.satisfactionHistory.push({ year: state.year, day: state.day + 1, value: state.satisfaction });
  const historyLimit = content.rules.householdLifeHistoryDays || 90;
  if (state.satisfactionHistory.length > historyLimit) state.satisfactionHistory.splice(0, state.satisfactionHistory.length - historyLimit);
  state.satisfactionFactors = { target: state.satisfaction, householdWeighted: true, issueCounts, rows };
  return state.satisfactionFactors;
}
