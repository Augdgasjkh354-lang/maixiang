import { bookAdd, ensureBook } from "../economy/books.js";
import { householdIdOf } from "../economy/accounts.js";
import { householdFoodQeqUnits, householdList, householdPopulation } from "./households.js";

const PERIOD_FIELDS = [
  "incomeVoucherUnits", "expenseVoucherUnits", "lifeExpenseVoucherUnits", "investmentVoucherUnits",
  "assetExchangeVoucherUnits", "capitalReturnVoucherUnits", "inKindIncomeQeqUnits", "reliefQeqUnits",
  "foodConsumedQeqUnits", "breadConsumedQeqUnits", "meatConsumedQeqUnits", "saltConsumedUnits", "wageDueVoucherUnits",
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
// 家庭"近期日收入"（household-budget 的可动用预算）的收入白名单：钱真正到达家庭账户的收入类付款才计入。
// 不计入：以粮换券、存款取回、镇库与银行之间的内部转移、买卖资产（股票、国债本金、别墅、经营权、店铺资本）、
// 清算返还、开店垫付、一次性辞退补偿（severance_payment）、镇库还欠款（town_debt_repayment）、救济（实物口粮 relief）、
// 家庭之间的商品买卖（消费与店铺零售）。利息（存款、国债）与务农分粮（实物）由专门入口计入，见 recordHouseholdBudgetIncome / recordHouseholdBudgetInKind。
export const BUDGET_INCOME_TYPES = new Set([
  // 工资：月薪发薪、欠薪补付、建筑与开荒工资、民营/公司/店铺雇员工资
  "wage_payment", "construction_wage_payment", "wage_arrears_payment", "construction_wage_arrears_payment",
  "land_reclamation_wage", "enterprise_wage_payment", "private_wage_payment", "shop_wage_payment",
  // 店铺、民营、公司的利润分配：店主家庭分利润、摆摊家庭分利润、民营业主收购收入（与 BUDGET_COST_TYPES 相抵）、公司股东分红
  "shop_profit_distribution", "collective_profit_share", "wholesale_private_purchase", "enterprise_dividend", "enterprise_annual_distribution",
  // 社保：养老金、失业金、农民补贴（社保基金付出）
  "pension_payment", "unemployment_benefit", "farmer_subsidy"
]);
// 家庭作为经营者付出的成本（从家庭账户付出，与 BUDGET_INCOME_TYPES 相抵，得到经营净收入）：民营业主的投入采购、民营工资。
export const BUDGET_COST_TYPES = new Set(["wholesale_sale", "private_wage_payment"]);

const WAGE_TYPES = new Set(["wage_payment", "construction_wage_payment", "wage_arrears_payment", "construction_wage_arrears_payment", "enterprise_wage_payment", "private_wage_payment", "shop_wage_payment"]);

export function recordHouseholdVoucherTransfer(state, { from, to, type, voucherUnits, householdDebits = [], householdCredits = [] }, content) {
  const debitRows = householdDebits.length ? householdDebits : (householdIdFromOwner(from) ? [{ householdId: householdIdFromOwner(from), units: voucherUnits }] : []);
  const creditRows = householdCredits.length ? householdCredits : (householdIdFromOwner(to) ? [{ householdId: householdIdFromOwner(to), units: voucherUnits }] : []);
  for (const row of debitRows) {
    const household = state.households?.byId?.[row.householdId];
    if (!household) continue;
    if (BUDGET_COST_TYPES.has(type)) add(household, "budgetCostVoucherUnits", row.units, content);
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
    if (BUDGET_INCOME_TYPES.has(type)) add(household, "budgetIncomeVoucherUnits", row.units, content);
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

// 利息（存款利息、国债利息）与务农分粮（实物，按券值 = 斤 × 1 券）计入家庭近期收入。
export function recordHouseholdBudgetIncome(state, householdId, units, content) {
  const household = state.households?.byId?.[householdId];
  if (household && Number.isFinite(units) && units > 0) add(household, "budgetIncomeVoucherUnits", units, content);
}
export function recordHouseholdBudgetInKind(state, householdId, wheatInventoryUnits, content) {
  const scale = content.precision.currencyUnitsPerVoucher || content.precision.inventoryUnitsPerJin;
  const units = Math.floor((Number(wheatInventoryUnits) || 0) / content.precision.inventoryUnitsPerJin * scale);
  recordHouseholdBudgetIncome(state, householdId, units, content);
}

// 近期日收入（券/日，指数滑动平均）。没有记录（开局、旧档）时用收入预期 ÷ daysPerYear 作初值。
export function householdRecentIncomeUnitsPerDay(household, content) {
  const stored = household.recentIncomeUnits;
  if (Number.isFinite(stored)) return Math.max(0, stored);
  const scale = content.precision.currencyUnitsPerVoucher || content.precision.inventoryUnitsPerJin;
  return Math.max(0, Number(household.incomeExpectationJin) || 0) * scale / (content.rules.daysPerYear || 360);
}

// 每日结束时把当天的净收入（收入 − 经营成本）并入指数滑动平均，半衰期 incomeHalfLifeDays（默认 30 天）。
export function finalizeHouseholdIncomeDay(state, content) {
  const halfLife = Math.max(1, content.rules.householdBudget?.incomeHalfLifeDays ?? 30);
  const alpha = 1 - Math.pow(0.5, 1 / halfLife);
  for (const household of householdList(state)) {
    const life = ensureHouseholdLife(household, content);
    const today = (life.day.budgetIncomeVoucherUnits || 0) - (life.day.budgetCostVoucherUnits || 0);
    const prior = householdRecentIncomeUnitsPerDay(household, content);
    household.recentIncomeUnits = Math.round((prior + alpha * (today - prior)) * 10000) / 10000;
  }
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
