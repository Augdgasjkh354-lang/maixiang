import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { accrueRepairWoodNeed } from "../src/systems/housing.js";
import { activeHouseholds } from "../src/systems/households.js";

const SCALE = CONTENT.precision.inventoryUnitsPerJin;
const DAYS = CONTENT.rules.daysPerYear;
const RATE = CONTENT.rules.houseRepairWoodJinPerHouseholdYear;

// 按日累计一整年的修缮木材目标（库存精度单位），并返回最终结转。
function yearOfTargets(households, startCarry = 0) {
  const state = { housing: { repairWoodCarry: startCarry } };
  let total = 0;
  for (let day = 0; day < DAYS; day += 1) total += accrueRepairWoodNeed(state, households, CONTENT);
  return { total, carry: state.housing.repairWoodCarry };
}

test("规则：每户每年斤数存在，开局户数随人口（每户约 5 人）；250 户日需求约 5 斤", () => {
  assert.equal(typeof RATE, "number");
  assert.equal(CONTENT.rules.houseRepairWoodUnitsPerDay, undefined, "旧的全镇固定常数已删除");
  const state = simulation.createInitialState();
  assert.equal(state.housing.repairWoodCarry, 0);
  const households = activeHouseholds(state).length;
  const population = state.cohorts.reduce((sum, row) => sum + row.m + row.f, 0);
  assert.equal(households, Math.round(population / CONTENT.rules.initialHouseholdSize), "开局户数 = 人口 ÷ initialHouseholdSize");
  // 每户年斤数是规则常数：250 户的日需求仍约为 5 斤（参照值），实际开局户数按其线性换算。
  const referenceDaily = 250 * RATE / DAYS;
  assert.ok(Math.abs(referenceDaily - 5) < 0.01, `250 户日需求应约为 5 斤，实际 ${referenceDaily}`);
  const daily = households * RATE / DAYS;
  assert.ok(Math.abs(daily - households * referenceDaily / 250) < 1e-9);
});

test("N 户一年累计需求 ≈ N × 每户年斤数 × 单位精度（允许取整误差）", () => {
  for (const households of [1, 37, 100, 250, 500]) {
    const { total, carry } = yearOfTargets(households);
    const expected = households * RATE * SCALE;
    // 每日取整下余数结转，整年合计与理论值相差不超过一个单位。
    assert.ok(Math.abs(total - expected) <= 1, `${households} 户：累计 ${total}，理论 ${expected}`);
    assert.ok(carry >= 0 && carry < DAYS, "结转余数落在 [0, daysPerYear)");
  }
});

test("户数翻倍，需求大致翻倍", () => {
  const base = yearOfTargets(125).total;
  const doubled = yearOfTargets(250).total;
  assert.ok(Math.abs(doubled / base - 2) < 0.001, `翻倍比例 ${doubled / base}`);
});

test("小数需求通过结转累积，不会因每日取整而丢失", () => {
  // 1 户每年 7.3 斤，365 日整除不了：单日取整为 0 的日子也要在年内兑现。
  const { total } = yearOfTargets(1);
  assert.equal(Math.round(total), Math.round(RATE * SCALE));
  // 结转跨年延续：从已有结转开始，年末合计仍按理论值计。
  // 年内所有日目标之和 = 起始结转 + 全年新增 - 年末结转。
  const carried = yearOfTargets(1, 200);
  assert.equal(carried.total, 200 + RATE * SCALE - carried.carry);
});

test("真实日结：buyRepairWoodForResidents 写入当日目标并推进结转", () => {
  const state = simulation.createInitialState();
  const households = activeHouseholds(state).length;
  // 首日目标 = floor(户数 × 每户年斤数 × 单位精度 ÷ 365)，余数进结转（户数随人口，不再固定 250 户）。
  const numerator = households * RATE * SCALE;
  simulation.advanceDay(state);
  const last = state.housing.lastRepairWoodDay;
  assert.equal(last.targetUnits, Math.floor(numerator / DAYS), "首日目标 = 户数 × 每户年斤数 ÷ 365");
  assert.ok(Math.abs(state.housing.repairWoodCarry - numerator % DAYS) < 1e-6, "余数进结转");
  assert.equal(typeof state.housing.repairWoodCarry, "number");
  assert.ok(Number.isFinite(last.purchasedUnits) && last.purchasedUnits >= 0);
});

test("旧存档缺少结转字段时按 0 处理", () => {
  const state = { housing: { villageCapacity: 1 } };
  const target = accrueRepairWoodNeed(state, 250, CONTENT);
  assert.equal(target, Math.floor(250 * RATE * SCALE / DAYS));
  assert.equal(typeof state.housing.repairWoodCarry, "number");
});
