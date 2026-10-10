import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { createSimulation, simulation } from "../src/engine.js";
import { harvest } from "../src/systems/agriculture.js";
import { householdList, householdPopulation, isActiveHousehold } from "../src/systems/households.js";
import { householdIncomePerCapitaJin, invalidateHouseholdBudgets } from "../src/systems/household-budget.js";
import { fillMissingHouseholdLastHarvestIncome, perFarmerShareJin, updateHouseholdIncomeExpectations } from "../src/systems/income-expectation.js";
import { splitOversizedHouseholds } from "../src/systems/household-split.js";
import { householdLastHarvestIncomeUnits } from "../src/systems/household-life.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;
const I = CONTENT.precision.inventoryUnitsPerJin;
const BIG_CONTENT = { ...CONTENT, rules: { ...CONTENT.rules, initialHouseholdCount: 250 } };

// 一户一年的收入（斤）：近期日收入 × 360 + 秋收所得，与预算口径一致。
function annualJin(state, household) {
  invalidateHouseholdBudgets(state);
  return householdIncomePerCapitaJin(household, CONTENT) * householdPopulation(household);
}

// 与 agriculture.test 的收获场景相同：1 个农民、产量 100 斤，一次收完。
const HARVEST_CONTENT = {
  ...CONTENT,
  agriculture: { ...CONTENT.agriculture, acres: 10, acresPerFarmer: 10, yieldPerAcre: 10 },
  rules: { ...CONTENT.rules, growingDays: 1, agricultureTaxDefaultPercent: 0 }
};

function harvestWith(state, workerIndex) {
  const households = householdList(state);
  households.forEach((household, index) => { household.agricultureWorkUnits = index === workerIndex ? 1 : 0; });
  state.agriculture.workUnits = 1;
  state.agriculture.taxDays = [{ year: state.year, day: 1, rateBps: 0 }];
  return harvest(state, HARVEST_CONTENT);
}

test("秋收：分到粮的户记下本次所得斤数，没分到的户记 0，不进近期日收入", () => {
  const state = simulation.createInitialState();
  const households = householdList(state);
  households[1].lastHarvestIncomeJin = 999; // 上一年的旧值
  const result = harvestWith(state, 0);
  assert.equal(result.residentShare, 100);
  assert.equal(households[0].lastHarvestIncomeJin, 100, "分到 100 斤");
  assert.equal(households[1].lastHarvestIncomeJin, 0, "没分到的户被覆盖为 0");
  assert.equal(households[0].recentIncomeUnits, undefined, "秋收不写近期日收入");
  assert.ok(Math.abs(annualJin(state, households[0]) - 100) < 1e-6, `年收入 = 100 斤，实际 ${annualJin(state, households[0])}`);
  simulation.validateState(state);
});

test("换年新收获覆盖旧值，年收入按新值计", () => {
  const state = simulation.createInitialState();
  const households = householdList(state);
  harvestWith(state, 0);
  assert.equal(households[0].lastHarvestIncomeJin, 100);
  state.year += 1; // 下一年秋收
  const second = harvestWith(state, 1);
  assert.equal(second.skipped, undefined, "新一年可以再收");
  assert.equal(households[0].lastHarvestIncomeJin, 0, "上一年分到的户，本年没分到，覆盖为 0");
  assert.equal(households[1].lastHarvestIncomeJin, 100, "本年分到的户记本年斤数");
  assert.ok(Math.abs(annualJin(state, households[1]) - 100) < 1e-6);
});

test("秋收所得分量整年不变：收获后推进 20 天，秋收所得折券不变（不随日期衰减）", () => {
  const state = simulation.createInitialState();
  const households = householdList(state);
  harvestWith(state, 0);
  const onHarvest = householdLastHarvestIncomeUnits(households[0], CONTENT);
  assert.equal(onHarvest, 100 * V);
  for (let day = 0; day < 20; day += 1) simulation.advanceDays(state, 1);
  assert.equal(householdLastHarvestIncomeUnits(households[0], CONTENT), onHarvest, "20 天后秋收所得不变");
});

test("开局初值：开日补上 lastHarvestIncomeJin = 在岗农民 × 每人年分粮，与收入预期的务农部分一致", () => {
  const state = simulation.createInitialState({ seed: 9301 });
  const households = householdList(state);
  for (const household of households) delete household.lastHarvestIncomeJin;
  fillMissingHouseholdLastHarvestIncome(state, CONTENT);
  const share = perFarmerShareJin(state, CONTENT);
  assert.ok(share > 0, "开局有耕地和农民，每人年分粮为正");
  let total = 0;
  for (const household of households) {
    const farmers = isActiveHousehold(household) ? (household.jobs?.farmers || 0) : 0;
    assert.ok(Math.abs(household.lastHarvestIncomeJin - farmers * share) < 1e-9);
    total += household.lastHarvestIncomeJin;
  }
  const pool = state.agriculture.reclaimedAcres * CONTENT.agriculture.yieldPerAcre * (1 - (state.policy?.agricultureTaxPercent ?? CONTENT.rules.agricultureTaxDefaultPercent) / 100);
  assert.ok(Math.abs(total - pool) / pool < 0.01, `农户务农分粮合计 ≈ 农田产出扣税 ${pool}，实际 ${total}`);
  // 开局全年一致：收入预期（含务农部分）= 近期日收入 × 360 + 秋收所得（近期无记录，用收入预期扣掉务农部分作初值）。
  updateHouseholdIncomeExpectations(state, CONTENT);
  for (const household of households.slice(0, 20)) {
    delete household.recentIncomeUnits;
    const expected = household.incomeExpectationJin;
    assert.ok(Math.abs(annualJin(state, household) - expected) <= 0.5 + 1e-6, `年收入 ${annualJin(state, household)} 应等于收入预期 ${expected}`);
  }
});

test("老档：秋收字段缺失时，开日补上务农初值；缺失期间年收入不含秋收", () => {
  const state = simulation.createInitialState({ seed: 9302 });
  const household = householdList(state).find(h => isActiveHousehold(h) && (h.jobs?.farmers || 0) > 0);
  delete household.lastHarvestIncomeJin;
  household.recentIncomeUnits = 0;
  assert.equal(annualJin(state, household), 0, "字段缺失时秋收按 0");
  simulation.advanceDays(state, 1);
  const farmers = household.jobs.farmers;
  assert.ok(Math.abs(household.lastHarvestIncomeJin - farmers * perFarmerShareJin(state, CONTENT)) < 1e-6, "开日补上务农初值");
  assert.ok(annualJin(state, household) > 0);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));
});

test("分户：秋收所得按人口比例分给新户，全镇合计不变", () => {
  const bigSimulation = createSimulation(BIG_CONTENT);
  const state = bigSimulation.createInitialState({ seed: 9303 });
  const before = householdList(state);
  for (const household of before) household.lastHarvestIncomeJin = 10;
  const total = before.length * 10;
  const result = splitOversizedHouseholds(state, BIG_CONTENT, { recordEvents: false });
  assert.ok(result.splits > 0, "250 户大户局面需要分户");
  const after = householdList(state);
  const sum = after.reduce((s, h) => s + (h.lastHarvestIncomeJin || 0), 0);
  assert.ok(Math.abs(sum - total) < 1e-6, `分户后合计 ${sum} 应等于 ${total}`);
  assert.ok(after.every(h => Number.isFinite(h.lastHarvestIncomeJin) && h.lastHarvestIncomeJin >= 0));
  assert.equal(bigSimulation.validateState(state).valid, true);
});
