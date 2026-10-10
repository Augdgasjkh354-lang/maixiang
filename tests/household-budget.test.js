import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { householdList, householdPopulation, syncResidentAggregates } from "../src/systems/households.js";
import {
  affluenceFromRatio, householdAffluence, householdBudgets, householdPriceIndex, householdWealthUnits,
  invalidateHouseholdBudgets, selectHouseholdBudgetSummary
} from "../src/systems/household-budget.js";
import { voucherWealthForAffluence } from "./budget-fixture.js";

const RULES = CONTENT.rules.householdBudget;
const MAX = RULES.maxAffluence;
const V = CONTENT.precision.currencyUnitsPerVoucher;

// 只靠家底的一户：收入预期清零，小麦清零，粮券设到宽裕度 m。
function householdWithAffluence(state, household, m) {
  household.inventory.wheat = 0;
  for (const itemId of ["flour", "bread"]) household.inventory[itemId] = 0;
  household.voucherUnits = voucherWealthForAffluence(state, household, m, CONTENT);
  syncResidentAggregates(state, CONTENT);
  invalidateHouseholdBudgets(state);
  return household;
}

test("宽裕度函数：ratio=1 时 m=1，ratio=0 时 m=0，单调上升，趋近 Mmax 但永不到达", () => {
  assert.ok(Math.abs(affluenceFromRatio(1, MAX) - 1) < 1e-9, "正常人家 ratio=1 → m=1");
  assert.equal(affluenceFromRatio(0, MAX), 0);
  let prev = -1;
  for (const ratio of [0, 0.01, 0.1, 0.5, 1, 2, 4, 16, 100, 1000]) {
    const m = affluenceFromRatio(ratio, MAX);
    assert.ok(m > prev, `m 随 ratio 单调上升：ratio=${ratio} m=${m}`);
    assert.ok(m < MAX, `m 永远小于 Mmax：ratio=${ratio} m=${m}`);
    prev = m;
  }
  assert.ok(Math.abs(affluenceFromRatio(4, MAX) - 1.9) < 0.05, `ratio=4 约 1.9，实际 ${affluenceFromRatio(4, MAX)}`);
  assert.ok(Math.abs(affluenceFromRatio(16, MAX) - 3.1) < 0.05, `ratio=16 约 3.1，实际 ${affluenceFromRatio(16, MAX)}`);
  assert.ok(Math.abs(affluenceFromRatio(100, MAX) - 3.95) < 0.02, `ratio=100 约 3.95，实际 ${affluenceFromRatio(100, MAX)}`);
  assert.ok(affluenceFromRatio(1e6, MAX) > MAX - 1e-3, "极大 ratio 趋近 Mmax");
  assert.ok(affluenceFromRatio(1e6, MAX) <= MAX, "极大 ratio 不超过 Mmax");
});

test("开局物价指数为 1（篮子价格等于开局售价）", () => {
  const state = simulation.createInitialState({ seed: 9101 });
  assert.ok(Math.abs(householdPriceIndex(state, CONTENT) - 1) < 1e-9, `开局物价指数 ${householdPriceIndex(state, CONTENT)}`);
});

test("收入为 0 时只靠家底：宽裕度由家底唯一决定，与公式一致", () => {
  const state = simulation.createInitialState({ seed: 9102 });
  const h = householdWithAffluence(state, householdList(state)[0], 2);
  assert.equal(h.incomeExpectationJin, 0);
  assert.ok(Math.abs(householdAffluence(state, h, CONTENT) - 2) < 1e-3, `宽裕度应为 2，实际 ${householdAffluence(state, h, CONTENT)}`);
  const row = householdBudgets(state, CONTENT).get(h.id);
  assert.equal(row.incomePerCapitaJin, 0);
  assert.ok(Math.abs(row.budgetPerCapitaJin - RULES.usableWealthShare * householdWealthUnits(state, h, CONTENT) / V / householdPopulation(h)) < 1e-6, "可动用预算只有家底的 usableWealthShare");
});

test("收入预期等于参照预算（家底为 0）时宽裕度为 1；收入翻倍后宽裕度升高", () => {
  const state = simulation.createInitialState({ seed: 9103 });
  const h = householdList(state)[0];
  for (const itemId of ["flour", "bread"]) h.inventory[itemId] = 0;
  h.inventory.wheat = 0;
  h.voucherUnits = 0;
  const people = householdPopulation(h);
  const referenceJin = RULES.referenceBudgetPerCapitaJin * householdPriceIndex(state, CONTENT);
  h.incomeExpectationJin = referenceJin * people;
  syncResidentAggregates(state, CONTENT);
  invalidateHouseholdBudgets(state);
  assert.ok(Math.abs(householdAffluence(state, h, CONTENT) - 1) < 1e-6, "B = R 时 m = 1");
  h.incomeExpectationJin *= 2;
  invalidateHouseholdBudgets(state);
  assert.ok(Math.abs(householdAffluence(state, h, CONTENT) - affluenceFromRatio(2, MAX)) < 1e-6, "收入翻倍即可分比值 2，宽裕度 ≈ 1.385");
});

test("宽裕度随家底单调上升", () => {
  const state = simulation.createInitialState({ seed: 9104 });
  const h = householdList(state)[0];
  let prev = -1;
  for (const m of [0, 0.3, 0.8, 1.5, 2.5, 3.5]) {
    householdWithAffluence(state, h, m);
    const value = householdAffluence(state, h, CONTENT);
    assert.ok(value > prev, `家底提高宽裕度应上升：目标 ${m}，得到 ${value}`);
    prev = value;
  }
});

test("物价上涨：同样收入和家底，宽裕度下降；物价指数随篮子涨跌", () => {
  const state = simulation.createInitialState({ seed: 9105 });
  const h = householdList(state)[0];
  h.inventory.wheat = 0;
  h.voucherUnits = 0;
  h.incomeExpectationJin = 1500 * householdPopulation(h);
  syncResidentAggregates(state, CONTENT);
  invalidateHouseholdBudgets(state);
  const before = householdAffluence(state, h, CONTENT);
  for (const itemId of ["flour", "bread", "salt"]) state.wholesaleMarket.pricesVoucherPerUnit[itemId] *= 2;
  invalidateHouseholdBudgets(state);
  assert.ok(Math.abs(householdPriceIndex(state, CONTENT) - 2) < 1e-9, "篮子价格翻倍，物价指数为 2");
  const after = householdAffluence(state, h, CONTENT);
  assert.ok(after < before, `物价上涨宽裕度应下降：${before} → ${after}`);
});

test("每日可花 = 可动用预算 ÷ daysPerYear（券单位，向下取整）；服务预算 = 每日可花 × serviceShare", () => {
  const state = simulation.createInitialState({ seed: 9106 });
  const h = householdList(state)[0];
  h.incomeExpectationJin = 777;
  h.voucherUnits = 4321 * V;
  invalidateHouseholdBudgets(state);
  const row = householdBudgets(state, CONTENT).get(h.id);
  const budgetUnits = 777 * V + RULES.usableWealthShare * householdWealthUnits(state, h, CONTENT);
  assert.equal(row.dailySpendUnits, Math.floor(budgetUnits / CONTENT.rules.daysPerYear));
  assert.equal(row.serviceBudgetUnits, Math.floor(row.dailySpendUnits * RULES.serviceShare));
});

test("当天缓存：同一天复用，家底改动后不失效，invalidate 后重算，换天重算", () => {
  const state = simulation.createInitialState({ seed: 9107 });
  const h = householdList(state)[0];
  const first = householdBudgets(state, CONTENT);
  assert.equal(householdBudgets(state, CONTENT), first, "同一天返回同一份缓存");
  const wealthBefore = first.get(h.id).wealthUnits;
  h.voucherUnits += 500 * V;
  assert.equal(householdBudgets(state, CONTENT).get(h.id).wealthUnits, wealthBefore, "当天不随家底改动而变");
  invalidateHouseholdBudgets(state);
  const second = householdBudgets(state, CONTENT);
  assert.notEqual(second, first);
  assert.equal(second.get(h.id).wealthUnits, wealthBefore + 500 * V, "invalidate 后按新家底重算");
  state.day += 1;
  assert.notEqual(householdBudgets(state, CONTENT), second, "换天后重算");
});

test("汇总只读：有家户时给出人均收入、可动用预算、参照预算与物价指数，缺收入字段按 0 处理", () => {
  const state = simulation.createInitialState({ seed: 9108 });
  const h = householdList(state)[0];
  delete h.incomeExpectationJin;
  invalidateHouseholdBudgets(state);
  const summary = selectHouseholdBudgetSummary(state, CONTENT);
  assert.ok(summary && summary.households > 0);
  for (const key of ["averageAffluence", "medianAffluence", "incomePerCapitaJin", "budgetPerCapitaJin", "priceIndex", "poorShare", "richShare"]) {
    assert.ok(Number.isFinite(summary[key]), `${key} 应为有限数值`);
  }
  assert.ok(Math.abs(summary.priceIndex - 1) < 1e-9);
  assert.ok(Number.isFinite(householdAffluence(state, h, CONTENT)));
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});
