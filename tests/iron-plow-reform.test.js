// 铁犁牛耕改革（金银消费第三期）：命令校验（非负整数、开荒上限、牛与农具的上限与缺口提示）、
// 1000 亩替代使农民 100 → 20（全镇 3000 → 2920，80 人转待业）、人口守恒、改小后待业者补岗、
// 改革地块亩产 1000、收成、失业者计入待业、旧档默认 0、validateState。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { householdList, isActiveHousehold, jobCount, syncResidentAggregates } from "../src/systems/households.js";
import { harvest } from "../src/systems/agriculture.js";
import { refillAgricultureToTarget, agricultureEmploymentTarget } from "../src/systems/employment.js";
import { previewIronPlowReform, setIronPlowReform } from "../src/systems/iron-plow.js";
import { durableTargetContext, durableTargetPieces } from "../src/selectors/durable-goods.js";
import { farmerCapacityOf, selectFarmland, farmTotalOutputJin } from "../src/selectors/farmland.js";
import { populationStats, selectJobRows } from "../src/selectors/labor.js";
import { mergeOntoBase } from "../src/persistence/save-compat.js";
import { educationBonus } from "../src/economy/productivity.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const OX = "ox";
const TOOL = "iron_farm_tool";
const FARMER = CONTENT.agriculture.farmerRoleId;

function valid(state, label = "") {
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, `${label} ${v.errors.join("；")}`);
}

function farmers(state) {
  return householdList(state).filter(isActiveHousehold).filter(h => (h.jobs?.farmers || 0) > 0);
}

// 每户耕牛 / 农具库存设为目标的 fraction 比例（头数或件数 = 目标 × fraction）。
function holdFraction(state, itemId, fraction) {
  const cfg = CONTENT.rules.durableGoods[itemId];
  const ctx = durableTargetContext(state, CONTENT, cfg);
  for (const household of farmers(state)) {
    household.inventory[itemId] = Math.round(durableTargetPieces(household, cfg, ctx) * fraction * I);
  }
  syncResidentAggregates(state, CONTENT);
}

// 3 万亩满员（3000 人）、耕牛与农具全覆盖的标准状态。
function fullyEquipped(seed) {
  const state = simulation.createInitialState({ seed });
  holdFraction(state, TOOL, 1);
  holdFraction(state, OX, 1);
  return state;
}

function idleWorkers(state) {
  const people = populationStats(state);
  return people.workers - selectJobRows(state, CONTENT).employed;
}

// ---------------------------------------------------------------- 命令校验

test("改革命令校验：非负整数、不超过已开荒耕地，负数与小数直接拒绝", () => {
  const state = simulation.createInitialState({ seed: 9201 });
  for (const bad of [-1, 1.5, NaN]) {
    const result = simulation.setIronPlowReform(state, bad);
    assert.equal(result.ok, false, `替代 ${bad} 应被拒绝`);
    assert.match(result.reason, /非负整数/);
  }
  const over = simulation.setIronPlowReform(state, CONTENT.agriculture.acres + 1);
  assert.equal(over.ok, false);
  assert.match(over.reason, /超过已开垦耕地/);
  assert.equal(state.agriculture.ironPlowAcres, 0, "失败不改状态");
});

test("改革上限 = min(在役耕牛 × 50, 农具件数 × 50)：没有牛时拒绝并提示缺多少头牛", () => {
  const state = simulation.createInitialState({ seed: 9202 });
  holdFraction(state, TOOL, 1);
  const result = simulation.setIronPlowReform(state, 1000);
  assert.equal(result.ok, false);
  assert.match(result.reason, /耕牛不足：替代 1000 亩需在役耕牛 20 头，现有 0 头，还差 20 头/);
  assert.equal(simulation.previewIronPlowReform(state, 1000).cap, 0);
});

test("改革上限：没有农具时拒绝并提示还差多少件", () => {
  const state = simulation.createInitialState({ seed: 9203 });
  holdFraction(state, OX, 1);
  holdFraction(state, TOOL, 0);
  const result = simulation.setIronPlowReform(state, 500);
  assert.equal(result.ok, false);
  assert.match(result.reason, /铁制农具不足：替代 500 亩需 10 件，现有 0 件，还差 10 件/);
});

test("改革上限 = min(在役耕牛 × 50, 农具件数 × 50)：农具只有 30 件时上限 1500 亩，多一亩就拒绝", () => {
  const state = simulation.createInitialState({ seed: 9204 });
  holdFraction(state, OX, 1);     // 牛够（600 头 = 3 万亩）
  for (const household of householdList(state)) household.inventory[TOOL] = 0;
  farmers(state)[0].inventory[TOOL] = 30 * I;   // 全镇只有 30 件农具
  syncResidentAggregates(state, CONTENT);
  assert.equal(simulation.previewIronPlowReform(state, 0).cap, 1500, "30 件 × 50 亩");
  assert.equal(simulation.setIronPlowReform(state, 1500).ok, true, "上限内可以替代");
  simulation.setIronPlowReform(state, 0);
  const over = simulation.setIronPlowReform(state, 1501);
  assert.equal(over.ok, false);
  assert.match(over.reason, /铁制农具不足：替代 1501 亩需 31 件，现有 30 件，还差 1 件/);
});

// ---------------------------------------------------------------- 1000 亩替代

test("替代 1000 亩：农田岗位 3000 → 2920（100 → 20 人，多出 80 人转待业），人口守恒，validateState 通过", () => {
  const state = fullyEquipped(9205);
  const peopleBefore = populationStats(state);
  const idleBefore = idleWorkers(state);
  const result = simulation.setIronPlowReform(state, 1000);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.capacityBefore, 3000);
  assert.equal(result.capacityAfter, 2920, "2900 + 20");
  assert.equal(result.released, 80);
  assert.equal(jobCount(state, FARMER), 2920, "农民岗位数");
  assert.equal(idleWorkers(state) - idleBefore, 80, "多出的 80 人成为待业");
  const peopleAfter = populationStats(state);
  assert.equal(peopleAfter.total, peopleBefore.total, "人口总数不变");
  assert.equal(peopleAfter.workers, peopleBefore.workers, "劳动年龄人口不变");
  valid(state, "替代 1000 亩");
});

test("改革地块：每 50 亩 1 人，全覆盖时每亩 1000 斤（600 + 200 农具 + 200 牛）", () => {
  const state = fullyEquipped(9206);
  simulation.setIronPlowReform(state, 1000);
  // 改革后农民减少，农具与牛按新的目标重新备齐（被裁的 80 人家里的牛与农具不再计入目标）。
  holdFraction(state, TOOL, 1);
  holdFraction(state, OX, 1);
  const f = selectFarmland(state, CONTENT);
  assert.equal(f.plowEffectiveAcres, 1000);
  assert.equal(f.farmerCapacityExact, 2920);
  assert.equal(f.plowYield, 1000);
  // 库存按整数单位取整（每户至多少 1/3000 头），允许 0.1% 的误差。
  assert.ok(Math.abs(f.totalJin / (30000 * 1000) - 1) < 1e-3, `全覆盖时每亩约 1000 斤，实际 ${f.totalJin}`);
  assert.equal(farmTotalOutputJin(state, CONTENT), f.totalJin);
});

test("收成：满员出工时秋收按全镇最高产量计（改革后岗位少，产量仍全额）", () => {
  const state = fullyEquipped(9207);
  simulation.setIronPlowReform(state, 1000);
  holdFraction(state, TOOL, 1);
  holdFraction(state, OX, 1);
  state.agriculture.workUnits = farmerCapacityOf(state, CONTENT) * CONTENT.rules.growingDays;
  const result = harvest(state, CONTENT);
  const expected = farmTotalOutputJin(state, CONTENT) * educationBonus(state);
  assert.ok(Math.abs(result.total - expected) < 1e-3, `秋收 ${result.total}，应为 ${expected}`);
  valid(state, "收成");
});

test("待业者补岗：改小后目标用工随容量回升，待业者补回岗位", () => {
  const state = fullyEquipped(9208);
  simulation.setIronPlowReform(state, 1000);
  assert.equal(jobCount(state, FARMER), 2920);
  const down = simulation.setIronPlowReform(state, 0);
  assert.equal(down.ok, true, down.reason);
  assert.equal(down.capacityAfter, 3000);
  assert.equal(agricultureEmploymentTarget(state, CONTENT), 3000, "目标用工回到满员");
  refillAgricultureToTarget(state, CONTENT);
  assert.equal(jobCount(state, FARMER), 3000, "待业者补岗");
  valid(state, "改小");
});

test("改革只能在有牛有农具时增加；改小不受限", () => {
  const state = fullyEquipped(9209);
  simulation.setIronPlowReform(state, 1000);
  holdFraction(state, OX, 0);      // 牛全部没了
  const result = simulation.setIronPlowReform(state, 2000);
  assert.equal(result.ok, false);
  assert.match(result.reason, /耕牛不足/);
  const smaller = simulation.setIronPlowReform(state, 500);
  assert.equal(smaller.ok, true, "改小照常");
});

test("预览只读：不改状态，给出岗位变化与待业人数", () => {
  const state = fullyEquipped(9210);
  const before = JSON.stringify(state.agriculture) + jobCount(state, FARMER);
  const preview = previewIronPlowReform(state, CONTENT, 1000);
  assert.equal(preview.ok, true);
  assert.equal(preview.capacityAfter, 2920);
  assert.equal(preview.released, 80);
  assert.equal(JSON.stringify(state.agriculture) + jobCount(state, FARMER), before, "预览不改状态");
});

// ---------------------------------------------------------------- 旧档与校验

test("旧档：没有 ironPlowAcres 字段时读档补 0，与改前一致", () => {
  const saved = JSON.parse(JSON.stringify(simulation.createInitialState({ seed: 9211 })));
  delete saved.agriculture.ironPlowAcres;
  const merged = mergeOntoBase(simulation.createInitialState({ seed: 9211 }), saved);
  assert.equal(merged.agriculture.ironPlowAcres, 0);
  assert.equal(farmerCapacityOf(merged, CONTENT), 3000);
  valid(merged, "旧档");
});

test("validateState：改革亩数超过已开荒耕地或为负数时报错", () => {
  const state = simulation.createInitialState({ seed: 9212 });
  state.agriculture.ironPlowAcres = state.agriculture.reclaimedAcres + 1;
  assert.equal(simulation.validateState(state).valid, false);
  state.agriculture.ironPlowAcres = -5;
  assert.equal(simulation.validateState(state).valid, false);
});
