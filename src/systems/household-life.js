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

// 观察窗（最近 satisfactionObservationDays 天，默认 14）是家庭近期汇总的唯一来源（已不再另存一份 recent 副本）。
// 每天一行压成紧凑数组 [year, day, 键序号, 数值, 键序号, 数值, ...]，只存非零项；键名表 observation.keys 逐户记一份，只增不减。
// 旧存档里的对象行由读档修复（repairHouseholdLife）转成这种格式。
export function packObservationRow(observation, row) {
  const keys = observation.keys ||= [];
  const packed = [row.year, row.day];
  for (const key in row) {
    if (key === "year" || key === "day") continue;
    const value = row[key];
    if (!value) continue;
    let index = keys.indexOf(key);
    if (index < 0) { keys.push(key); index = keys.length - 1; }
    packed.push(index, value);
  }
  return packed;
}

function unpackObservationRow(observation, packed) {
  if (!Array.isArray(packed)) return packed;
  const keys = observation.keys || [];
  const row = { year: packed[0], day: packed[1] };
  for (let i = 2; i < packed.length; i += 2) row[keys[packed[i]]] = packed[i + 1];
  return row;
}

function normalizeObservation(observation) {
  observation.keys = Array.isArray(observation.keys) ? observation.keys : [];
  const rows = Array.isArray(observation.rows) ? observation.rows : [];
  observation.rows = rows.filter(row => row && typeof row === "object").map(row => (Array.isArray(row) ? row : packObservationRow(observation, row)));
  observation.totals ||= blankPeriod();
  return observation;
}

// 读档修复（save-compat 逐户调用）：删掉旧版的 life.recent（与观察窗逐字重复）、life.satisfactionHistory（无读取方）、
// life.lastFactors（派生，界面现算）；观察行转紧凑格式。
export function repairHouseholdLife(life) {
  if (!life || typeof life !== "object") return;
  delete life.recent;
  delete life.satisfactionHistory;
  delete life.lastFactors;
  if (!life.observation || typeof life.observation !== "object") life.observation = {};
  normalizeObservation(life.observation);
}

export function ensureHouseholdLife(household, content) {
  if (household.life?._v012Ready) return household.life;
  household.life ||= { day: blankPeriod(), year: blankPeriod(), cumulative: blankPeriod(), observation: { keys: [], rows: [], totals: blankPeriod() }, satisfaction: null };
  ensureBook(household.life, blankPeriod);
  household.life.observation ||= { keys: [], rows: [], totals: blankPeriod() };
  normalizeObservation(household.life.observation);
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
// 家庭之间的商品买卖（消费与店铺零售）。利息（存款、国债）由 recordHouseholdBudgetIncome 计入；务农分粮见 setHouseholdLastHarvestIncome。
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

function recordVoucherDebit(state, householdId, units, type, content) {
  const household = state.households?.byId?.[householdId];
  if (!household) return;
  if (BUDGET_COST_TYPES.has(type)) add(household, "budgetCostVoucherUnits", units, content);
  if (INVESTMENT_TYPES.has(type)) add(household, "investmentVoucherUnits", units, content);
  else if (LIFE_EXPENSE_TYPES.has(type)) { add(household, "expenseVoucherUnits", units, content); add(household, "lifeExpenseVoucherUnits", units, content); if (type === "shop_service_sale") add(household, "serviceExpenseVoucherUnits", units, content); }
  else add(household, "expenseVoucherUnits", units, content);
}

function recordVoucherCredit(state, householdId, units, type, content) {
  const household = state.households?.byId?.[householdId];
  if (!household) return;
  if (CAPITAL_RETURN_TYPES.has(type)) add(household, "capitalReturnVoucherUnits", units, content);
  else if (INCOME_TYPES.has(type)) add(household, "incomeVoucherUnits", units, content);
  if (WAGE_TYPES.has(type)) add(household, "wagePaidVoucherUnits", units, content);
  if (BUDGET_INCOME_TYPES.has(type)) add(household, "budgetIncomeVoucherUnits", units, content);
}

// 没有逐户明细时（单户对单户的付款，最常见）直接按账户名定位那一户，不再临时拼行数组。
// fromHouseholdId / toHouseholdId：调用方已解析过账户名时直接给（household id 或 null），省掉再解析。
export function recordHouseholdVoucherTransfer(state, { from, to, type, voucherUnits, householdDebits = [], householdCredits = [], fromHouseholdId, toHouseholdId }, content) {
  if (householdDebits.length) {
    for (const row of householdDebits) recordVoucherDebit(state, row.householdId, row.units, type, content);
  } else {
    const fromId = fromHouseholdId !== undefined ? fromHouseholdId : householdIdFromOwner(from);
    if (fromId) recordVoucherDebit(state, fromId, voucherUnits, type, content);
  }
  if (householdCredits.length) {
    for (const row of householdCredits) recordVoucherCredit(state, row.householdId, row.units, type, content);
  } else {
    const toId = toHouseholdId !== undefined ? toHouseholdId : householdIdFromOwner(to);
    if (toId) recordVoucherCredit(state, toId, voucherUnits, type, content);
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

// 利息（存款利息、国债利息）计入家庭近期收入。
export function recordHouseholdBudgetIncome(state, householdId, units, content) {
  const household = state.households?.byId?.[householdId];
  if (household && Number.isFinite(units) && units > 0) add(household, "budgetIncomeVoucherUnits", units, content);
}

// 务农分粮不进近期日收入：秋收是一次性入账，进指数平均会让秋收后几周宽裕度虚高、随后快速衰减。
// 改为每户保存最近一次秋收所得（斤；1 斤折 1 券），整年连续计入年收入；每次秋收整体覆盖（没有分到的户记 0）。
export function setHouseholdLastHarvestIncome(state, jinByHousehold) {
  for (const household of householdList(state)) {
    household.lastHarvestIncomeJin = Math.max(0, Number(jinByHousehold.get(household.id)) || 0);
  }
}
// 最近一次秋收所得折券单位（1 斤 = 1 券，与 currencyScale 同口径）。字段缺失时按 0（开日会用收入预期的务农部分补上，见 income-expectation.js）。
export function householdLastHarvestIncomeUnits(household, content) {
  const jin = Number.isFinite(household.lastHarvestIncomeJin) ? Math.max(0, household.lastHarvestIncomeJin) : 0;
  return jin * (content.precision.currencyUnitsPerVoucher || content.precision.inventoryUnitsPerJin);
}

// 近期日收入（券/日，指数滑动平均，不含务农分粮）。没有记录（开局、旧档）时用收入预期 ÷ daysPerYear 作初值；
// 收入预期里的务农部分已由 lastHarvestIncomeJin 按年计入，所以初值要先扣掉它，免得重复。
export function householdRecentIncomeUnitsPerDay(household, content) {
  const stored = household.recentIncomeUnits;
  if (Number.isFinite(stored)) return Math.max(0, stored);
  const scale = content.precision.currencyUnitsPerVoucher || content.precision.inventoryUnitsPerJin;
  const harvestJin = Number.isFinite(household.lastHarvestIncomeJin) ? household.lastHarvestIncomeJin : 0;
  return Math.max(0, (Number(household.incomeExpectationJin) || 0) - harvestJin) * scale / (content.rules.daysPerYear || 360);
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
  const obsLimit = content.rules.satisfactionObservationDays || 14;
  for (const household of householdList(state)) {
    const life = ensureHouseholdLife(household, content);
    const row = { year: state.year, day: state.day + 1, ...life.day };
    const obs = life.observation;
    obs.rows.push(packObservationRow(obs, row));
    const day = life.day;
    for (const key in day) { const value = day[key]; if (value) obs.totals[key] = (obs.totals[key] || 0) + value; }
    while (obs.rows.length > obsLimit) { const removed = unpackObservationRow(obs, obs.rows.shift()); for (const key in removed) { const value = removed[key]; if (key !== "year" && key !== "day" && value) obs.totals[key] = (obs.totals[key] || 0) - value; } }
  }
}

// 观察窗内最后 days 天的分项合计（days 超过观察窗时以窗口为上限）。
function sumObservationRows(observation, days) {
  const packedRows = Array.isArray(observation?.rows) ? observation.rows.slice(-Math.max(1, days || 1)) : [];
  const totals = zeroPeriod();
  for (const packed of packedRows) { const row = unpackObservationRow(observation, packed); for (const key of PERIOD_FIELDS) totals[key] += row[key] || 0; }
  return { days: packedRows.length, ...totals };
}

export function householdRecentTotals(household, days, content) {
  const life = ensureHouseholdLife(household, content);
  return sumObservationRows(life.observation, days);
}

export function householdRecentTotalsReadonly(household, days, content) {
  const life = household?.life || {};
  const requestedDays = Math.max(1, days || 1);
  const observationDays = content.rules.satisfactionObservationDays || 14;
  const observation = life.observation;
  if (requestedDays === observationDays && Array.isArray(observation?.rows) && observation?.totals) {
    return { days: observation.rows.length, ...zeroPeriod(), ...observation.totals };
  }
  return sumObservationRows(observation, requestedDays);
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
