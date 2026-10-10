import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { householdList, householdPopulation } from "../src/systems/households.js";
import {
  BUDGET_INCOME_TYPES, finalizeHouseholdIncomeDay, householdRecentIncomeUnitsPerDay, recordHouseholdBudgetIncome,
  recordHouseholdInKind, recordHouseholdVoucherTransfer, resetHouseholdLifeDay, setHouseholdLastHarvestIncome
} from "../src/systems/household-life.js";
import { householdIncomePerCapitaJin } from "../src/systems/household-budget.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;
const I = CONTENT.precision.inventoryUnitsPerJin;
const ALPHA = 1 - Math.pow(0.5, 1 / CONTENT.rules.householdBudget.incomeHalfLifeDays);

function fresh(seed) {
  const state = simulation.createInitialState({ seed });
  const household = householdList(state)[0];
  household.incomeExpectationJin = 0;
  delete household.recentIncomeUnits;
  return { state, household };
}

function credit(state, household, type, units) {
  recordHouseholdVoucherTransfer(state, {
    from: "town", to: `household:${household.id}`, type, voucherUnits: units,
    householdCredits: [{ householdId: household.id, units }]
  }, CONTENT);
}

test("开局没有近期收入记录时，用收入预期 ÷ 360 作初值", () => {
  const { household } = fresh(9201);
  household.incomeExpectationJin = 3600;
  assert.ok(Math.abs(householdRecentIncomeUnitsPerDay(household, CONTENT) - 10 * V) < 1e-9);
  assert.ok(Math.abs(householdIncomePerCapitaJin(household, CONTENT) - 3600 / householdPopulation(household)) < 1e-9);
});

test("收入类付款计入当天，每日结束并入指数滑动平均（半衰期 30 天）", () => {
  const { state, household } = fresh(9202);
  credit(state, household, "wage_payment", 300 * V);
  finalizeHouseholdIncomeDay(state, CONTENT);
  assert.ok(Math.abs(household.recentIncomeUnits - ALPHA * 300 * V) < 1e-3, `首日 = α × 当日收入，实际 ${household.recentIncomeUnits}`);
  // 半衰期：之后 30 天没有收入，近期日收入应减半。
  const start = household.recentIncomeUnits;
  for (let day = 0; day < 30; day += 1) {
    resetHouseholdLifeDay(state, CONTENT);
    finalizeHouseholdIncomeDay(state, CONTENT);
  }
  assert.ok(Math.abs(household.recentIncomeUnits - start / 2) / start < 0.01, `30 天后应约为一半：${start} → ${household.recentIncomeUnits}`);
});

test("收入白名单：工资、利润分配、养老金计入；救济、资产买卖、以粮换券、补偿、镇库还债不计入", () => {
  for (const type of ["wage_payment", "shop_profit_distribution", "collective_profit_share", "enterprise_dividend",
    "pension_payment", "unemployment_benefit", "farmer_subsidy", "land_reclamation_wage", "wholesale_private_purchase"]) {
    assert.ok(BUDGET_INCOME_TYPES.has(type), `${type} 应计入`);
  }
  for (const type of ["scenario_income", "severance_payment", "town_debt_repayment", "shop_close_distribution", "shop_capital_refund",
    "operating_right_sale", "share_subscription", "wheat_direct_trade", "shop_wholesale_purchase", "wheat_trade", "bank_withdrawal"]) {
    assert.equal(BUDGET_INCOME_TYPES.has(type), false, `${type} 不应计入`);
  }
  const { state, household } = fresh(9203);
  credit(state, household, "scenario_income", 1000 * V);
  credit(state, household, "severance_payment", 1000 * V);
  finalizeHouseholdIncomeDay(state, CONTENT);
  assert.equal(household.recentIncomeUnits, 0, "不计入的付款不改变近期收入");
});

test("利息经专门入口计入近期收入；救济（实物口粮）不计入", () => {
  const { state, household } = fresh(9204);
  recordHouseholdBudgetIncome(state, household.id, 50 * V, CONTENT); // 存款利息 / 国债利息
  finalizeHouseholdIncomeDay(state, CONTENT);
  assert.ok(Math.abs(household.recentIncomeUnits - ALPHA * 50 * V) < 1e-3, `利息 50 券，实际 ${household.recentIncomeUnits}`);

  // 救济走实物入口（reliefQeqUnits / inKindIncomeQeqUnits），但不计入近期收入。
  const relief = fresh(9205);
  recordHouseholdInKind(relief.state, relief.household.id, "reliefQeqUnits", 100 * I, CONTENT);
  recordHouseholdInKind(relief.state, relief.household.id, "inKindIncomeQeqUnits", 100 * I, CONTENT);
  finalizeHouseholdIncomeDay(relief.state, CONTENT);
  assert.equal(relief.household.recentIncomeUnits, 0);
});

test("务农分粮不进近期日收入：秋收只改 lastHarvestIncomeJin，近期日收入不变", () => {
  const { state, household } = fresh(9208);
  setHouseholdLastHarvestIncome(state, new Map([[household.id, 100]]));
  finalizeHouseholdIncomeDay(state, CONTENT);
  assert.equal(household.recentIncomeUnits, 0, "秋收所得不进指数平均");
  assert.equal(household.lastHarvestIncomeJin, 100);
});

test("秋收所得整年连续计入：秋收后 300 天没有其他收入，年收入不随日期衰减", () => {
  const { state, household } = fresh(9210);
  setHouseholdLastHarvestIncome(state, new Map([[household.id, 1000]]));
  const people = householdPopulation(household);
  const annualJin = () => householdIncomePerCapitaJin(household, CONTENT) * people;
  assert.ok(Math.abs(annualJin() - 1000) < 1e-6, `秋收当天年收入 = 1000 斤，实际 ${annualJin()}`);
  for (let day = 0; day < 300; day += 1) {
    resetHouseholdLifeDay(state, CONTENT);
    finalizeHouseholdIncomeDay(state, CONTENT);
  }
  assert.equal(household.recentIncomeUnits, 0);
  assert.ok(Math.abs(annualJin() - 1000) < 1e-6, `300 天后年收入仍为 1000 斤，实际 ${annualJin()}`);
});

test("换年新收获整体覆盖旧值；没有分到的户记 0", () => {
  const { state, household } = fresh(9211);
  const other = householdList(state)[1];
  setHouseholdLastHarvestIncome(state, new Map([[household.id, 1000], [other.id, 500]]));
  assert.equal(householdLastHarvestIncomeOf(household), 1000);
  setHouseholdLastHarvestIncome(state, new Map([[household.id, 400]]));
  assert.equal(householdLastHarvestIncomeOf(household), 400, "新收获覆盖旧值");
  assert.equal(householdLastHarvestIncomeOf(other), 0, "本年没分到的户记 0");
  assert.equal(householdIncomePerCapitaJin(household, CONTENT) * householdPopulation(household), 400);
});

test("老档没有秋收字段时，秋收所得按 0 计，不影响近期收入读数", () => {
  const { household } = fresh(9212);
  delete household.lastHarvestIncomeJin;
  household.recentIncomeUnits = V; // 每日 1 券，一年 360 券 = 360 斤
  assert.equal(householdIncomePerCapitaJin(household, CONTENT) * householdPopulation(household), 360, "只有近期收入：360 券 = 360 斤");
});

test("开局初值扣掉务农部分：收入预期 3600，其中秋收 1800，近期日收入按 1800 ÷ 360 作初值", () => {
  const { household } = fresh(9213);
  household.incomeExpectationJin = 3600;
  household.lastHarvestIncomeJin = 1800;
  assert.ok(Math.abs(householdRecentIncomeUnitsPerDay(household, CONTENT) - 5 * V) < 1e-9);
  assert.ok(Math.abs(householdIncomePerCapitaJin(household, CONTENT) * householdPopulation(household) - 3600) < 1e-6, "年收入合计仍等于收入预期");
});

function householdLastHarvestIncomeOf(household) {
  return household.lastHarvestIncomeJin;
}

test("民营业主：收购收入减去投入采购与民营工资，得到经营净收入；净值为负时近期收入按 0 计", () => {
  const { state, household } = fresh(9206);
  credit(state, household, "wholesale_private_purchase", 500 * V);
  recordHouseholdVoucherTransfer(state, {
    from: `household:${household.id}`, to: "town", type: "wholesale_sale", voucherUnits: 800 * V,
    householdDebits: [{ householdId: household.id, units: 800 * V }], householdCredits: []
  }, CONTENT);
  finalizeHouseholdIncomeDay(state, CONTENT);
  assert.ok(household.recentIncomeUnits < 0, "净亏损时存储值为负");
  assert.equal(householdRecentIncomeUnitsPerDay(household, CONTENT), 0, "读数夹到 0");
});

test("存在近期收入记录后，年收入只看近期收入，不再看收入预期", () => {
  const { household } = fresh(9207);
  household.incomeExpectationJin = 100000;
  household.recentIncomeUnits = 0;
  assert.equal(householdIncomePerCapitaJin(household, CONTENT), 0, "近期收入为 0 时年收入为 0");
});
