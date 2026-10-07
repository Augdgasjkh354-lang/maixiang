import { bookAdd, ensureBook } from "../economy/books.js";
import { householdIdOf } from "../economy/accounts.js";
import { householdFoodQeqUnits, householdList, householdPopulation } from "./households.js";

const PERIOD_FIELDS = [
  "incomeVoucherUnits", "expenseVoucherUnits", "lifeExpenseVoucherUnits", "investmentVoucherUnits",
  "assetExchangeVoucherUnits", "capitalReturnVoucherUnits", "inKindIncomeQeqUnits", "reliefQeqUnits",
  "foodConsumedQeqUnits", "breadConsumedQeqUnits", "saltConsumedUnits", "wageDueVoucherUnits",
  "wagePaidVoucherUnits", "rentDueVoucherUnits", "rentPaidVoucherUnits", "serviceExpenseVoucherUnits", "serviceComfortPoints"
];

function blankPeriod() { return {}; }
function zeroPeriod() { return Object.fromEntries(PERIOD_FIELDS.map(key => [key, 0])); }

export function ensureHouseholdLife(household, content) {
  if (household.life?._v012Ready) return household.life;
  household.life ||= { day: blankPeriod(), year: blankPeriod(), cumulative: blankPeriod(), recent: [], observation: { rows: [], totals: blankPeriod() }, satisfaction: null, satisfactionHistory: [] };
  ensureBook(household.life, blankPeriod);
  household.life.recent = Array.isArray(household.life.recent) ? household.life.recent : [];
  household.life.satisfactionHistory = Array.isArray(household.life.satisfactionHistory) ? household.life.satisfactionHistory : [];
  household.life.observation ||= { rows: [], totals: blankPeriod() };
  household.life.observation.rows = Array.isArray(household.life.observation.rows) ? household.life.observation.rows : [];
  household.life.observation.totals ||= blankPeriod();
  household.life._v012Ready = true;
  return household.life;
}

export function resetHouseholdLifeDay(state, content) {
  for (const household of householdList(state)) ensureHouseholdLife(household, content).day = blankPeriod();
}

export function resetHouseholdLifeYear(state, content) {
  for (const household of householdList(state)) ensureHouseholdLife(household, content).year = blankPeriod();
}

function add(household, key, units, content) {
  if (!Number.isFinite(units) || units <= 0) return;
  const life = ensureHouseholdLife(household, content);
  bookAdd(life, key, units);
}

const householdIdFromOwner = householdIdOf;

const INCOME_TYPES = new Set([
  "wage_payment", "construction_wage_payment", "wage_arrears_payment", "construction_wage_arrears_payment",
  "enterprise_wage_payment", "private_wage_payment", "shop_wage_payment", "unemployment_benefit",
  "enterprise_dividend", "enterprise_annual_distribution", "shop_profit_distribution", "shop_wholesale_purchase", "wheat_direct_trade",
  "bread_direct_trade", "salt_direct_trade", "flour_direct_trade", "wood_direct_trade", "private_input_purchase"
]);
const LIFE_EXPENSE_TYPES = new Set(["rent_payment", "wheat_trade", "bread_trade", "salt_trade", "shop_retail_sale", "shop_service_sale", "wheat_direct_trade", "bread_direct_trade", "salt_direct_trade"]);
const INVESTMENT_TYPES = new Set(["share_subscription", "operating_right_sale", "shop_capital", "shop_startup_capital", "shop_capital_injection"]);
const CAPITAL_RETURN_TYPES = new Set(["shop_capital_refund", "shop_close_distribution"]);
const WAGE_TYPES = new Set(["wage_payment", "construction_wage_payment", "wage_arrears_payment", "construction_wage_arrears_payment", "enterprise_wage_payment", "private_wage_payment", "shop_wage_payment"]);

export function recordHouseholdVoucherTransfer(state, { from, to, type, voucherUnits, householdDebits = [], householdCredits = [] }, content) {
  const debitRows = householdDebits.length ? householdDebits : (householdIdFromOwner(from) ? [{ householdId: householdIdFromOwner(from), units: voucherUnits }] : []);
  const creditRows = householdCredits.length ? householdCredits : (householdIdFromOwner(to) ? [{ householdId: householdIdFromOwner(to), units: voucherUnits }] : []);
  for (const row of debitRows) {
    const household = state.households?.byId?.[row.householdId];
    if (!household) continue;
    if (INVESTMENT_TYPES.has(type)) add(household, "investmentVoucherUnits", row.units, content);
    else if (LIFE_EXPENSE_TYPES.has(type)) { add(household, "expenseVoucherUnits", row.units, content); add(household, "lifeExpenseVoucherUnits", row.units, content); if (type === "shop_service_sale") add(household, "serviceExpenseVoucherUnits", row.units, content); }
    else add(household, "expenseVoucherUnits", row.units, content);
  }
  for (const row of creditRows) {
    const household = state.households?.byId?.[row.householdId];
    if (!household) continue;
    if (CAPITAL_RETURN_TYPES.has(type)) add(household, "capitalReturnVoucherUnits", row.units, content);
    else if (INCOME_TYPES.has(type)) add(household, "incomeVoucherUnits", row.units, content);
    if (WAGE_TYPES.has(type)) add(household, "wagePaidVoucherUnits", row.units, content);
  }
}

export function recordHouseholdAssetExchange(state, householdRows, voucherUnits, content) {
  for (const row of householdRows || []) {
    const household = state.households?.byId?.[row.householdId];
    if (household) add(household, "assetExchangeVoucherUnits", row.units ?? voucherUnits, content);
  }
}

export function recordHouseholdInKind(state, householdId, key, units, content) {
  const household = state.households?.byId?.[householdId];
  if (household) add(household, key, units, content);
}

export function recordHouseholdWageDue(state, householdId, units, content) { recordHouseholdInKind(state, householdId, "wageDueVoucherUnits", units, content); }
export function recordHouseholdRentDue(state, householdId, units, content) { recordHouseholdInKind(state, householdId, "rentDueVoucherUnits", units, content); }
export function recordHouseholdRentPaid(state, householdId, units, content) { recordHouseholdInKind(state, householdId, "rentPaidVoucherUnits", units, content); }

export function finalizeHouseholdLifeDay(state, content) {
  const limit = content.rules.householdLifeHistoryDays || 90;
  for (const household of householdList(state)) {
    const life = ensureHouseholdLife(household, content);
    const row = { year: state.year, day: state.day + 1, ...life.day };
    life.recent.push(row);
    if (life.recent.length > limit) life.recent.splice(0, life.recent.length - limit);
    const obs = life.observation; obs.rows.push(row);
    for (const [key, value] of Object.entries(life.day)) if (value) obs.totals[key] = (obs.totals[key] || 0) + value;
    const obsLimit = content.rules.satisfactionObservationDays || 14;
    while (obs.rows.length > obsLimit) { const removed = obs.rows.shift(); for (const [key, value] of Object.entries(removed)) if (key !== "year" && key !== "day" && value) obs.totals[key] = (obs.totals[key] || 0) - value; }
  }
}

export function householdRecentTotals(household, days, content) {
  const life = ensureHouseholdLife(household, content);
  const rows = life.recent.slice(-Math.max(1, days || 1));
  const totals = zeroPeriod();
  for (const row of rows) for (const key of PERIOD_FIELDS) totals[key] += row[key] || 0;
  return { days: rows.length, ...totals };
}


export function householdRecentTotalsReadonly(household, days, content) {
  const life = household?.life || {};
  const requestedDays = Math.max(1, days || 1);
  const observationDays = content.rules.satisfactionObservationDays || 14;
  const observation = life.observation;
  if (requestedDays === observationDays && Array.isArray(observation?.rows) && observation?.totals) {
    return { days: observation.rows.length, ...zeroPeriod(), ...observation.totals };
  }
  const rows = Array.isArray(life.recent) ? life.recent.slice(-requestedDays) : [];
  const totals = zeroPeriod();
  for (const row of rows) for (const key of PERIOD_FIELDS) totals[key] += row[key] || 0;
  return { days: rows.length, ...totals };
}
export function householdFoodDays(state, household, content) {
  const people = Math.max(1, householdPopulation(household));
  return householdFoodQeqUnits(state, household, content) / content.precision.qeqUnitsPerJin / (people * content.rules.foodPerPersonDay);
}

export function archiveHouseholdLifeYear(state, content) {
  const totals = {}; let weightedSatisfaction = 0, people = 0;
  for (const household of householdList(state)) {
    const life = ensureHouseholdLife(household, content);
    for (const [key, value] of Object.entries(life.year || {})) totals[key] = (totals[key] || 0) + (value || 0);
    const count = householdPopulation(household); weightedSatisfaction += (life.satisfaction ?? state.satisfaction ?? 75) * count; people += count;
  }
  const row = { year: state.year, households: householdList(state).length, people, satisfaction: people ? weightedSatisfaction / people : state.satisfaction, totals };
  state.householdLifeAnnual ||= []; state.householdLifeAnnual.push(row);
  if (state.householdLifeAnnual.length > 20) state.householdLifeAnnual.splice(0, state.householdLifeAnnual.length - 20);
  return row;
}
