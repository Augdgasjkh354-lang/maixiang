import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { validateState } from "../src/core/validation.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { householdList, isActiveHousehold } from "../src/systems/households.js";
import { householdRecentTotalsReadonly, packObservationRow } from "../src/systems/household-life.js";
import { currentSatisfactionFactorRows } from "../src/systems/satisfaction.js";
import { createMaxedState } from "../scripts/maxed-state.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const PERIOD_KEYS = ["recent", "satisfactionHistory", "lastFactors"];

function assertValid(state) {
  const { errors } = validateState(state, simulation.content);
  assert.deepEqual(errors, []);
}

// 观察行解包（与 household-life 的紧凑格式独立实现，供测试核对内容）。
function decodeRows(observation) {
  return observation.rows.map(row => {
    if (!Array.isArray(row)) return row;
    const out = { year: row[0], day: row[1] };
    for (let i = 2; i < row.length; i += 2) out[observation.keys[row[i]]] = row[i + 1];
    return out;
  });
}

// 把新格式存档改写成旧版形状：观察行变回对象、另存一份 recent、带 satisfactionHistory / lastFactors / 全镇 rows。
function toLegacyShape(json) {
  const legacy = clone(json);
  for (const household of Object.values(legacy.households.byId)) {
    const life = household.life;
    if (!life?.observation) continue;
    const rows = decodeRows(life.observation);
    delete life.observation.keys;
    life.observation.rows = rows;
    life.recent = rows.map(row => ({ ...row }));
    life.satisfactionHistory = [{ year: 1, day: 1, value: 75 }];
    life.lastFactors = { foodCoverage: 1, target: 80 };
  }
  legacy.satisfactionFactors = { ...(legacy.satisfactionFactors || {}), target: 75, householdWeighted: true, issueCounts: {}, rows: [{ householdId: "x", people: 1, satisfaction: 75 }] };
  return legacy;
}

let cachedPlayed = null;
// 一局玩过 40 天的存档状态（JSON 形式），整个文件共用一份。
function played() {
  if (cachedPlayed === null) {
    const state = simulation.createInitialState();
    simulation.advanceDays(state, 40);
    cachedPlayed = JSON.stringify(state);
  }
  return JSON.parse(cachedPlayed);
}

test("旧档读入：recent / satisfactionHistory / lastFactors / 满意度 rows 被清掉，观察行转紧凑格式且内容不变", () => {
  const legacy = toLegacyShape(played());
  const loaded = migrateSave(legacy, CONTENT);
  for (const household of householdList(loaded)) {
    for (const key of PERIOD_KEYS) assert.equal(key in household.life, false, `${household.id} 不应保留 life.${key}`);
    assert.ok(Array.isArray(household.life.observation.keys));
    assert.ok(household.life.observation.rows.every(row => Array.isArray(row)), "观察行应为紧凑数组");
  }
  assert.equal(loaded.satisfactionFactors.rows, undefined, "满意度 rows 不再由存档带入");
  assert.equal(loaded.satisfactionFactors.householdWeighted, true);
  // 旧对象行解包后与原内容逐项一致（这里 legacy 的对象行就是原观察行）。
  const first = householdList(loaded)[0];
  const legacyFirst = legacy.households.byId[first.id].life.observation.rows;
  assert.deepEqual(decodeRows(first.life.observation), legacyFirst);
  assertValid(loaded);
  simulation.advanceDays(loaded, 30);
  assertValid(loaded);
});

test("存档 JSON 不再含逐户重复副本、满意度历史与派生缓存", () => {
  const state = simulation.createInitialState();
  simulation.advanceDays(state, 40);
  const json = JSON.parse(JSON.stringify(state));
  for (const household of Object.values(json.households.byId)) {
    for (const key of PERIOD_KEYS) assert.equal(key in household.life, false, `life.${key} 不应存档`);
    assert.ok(household.life.observation.rows.length <= (CONTENT.rules.satisfactionObservationDays || 14));
  }
  assert.equal(json.satisfactionFactors.rows, undefined);
  // 劳动力竞争的 laborCompetition.recent 是另一个系统的字段，不在此列。
  assert.equal(JSON.stringify(json.households).includes('"recent"'), false);
  assert.equal(JSON.stringify(json).includes('"lastFactors"'), false);
  // 满意度历史（全镇）仍保留，界面在用。
  assert.ok(Array.isArray(json.satisfactionHistory));
});

test("读档后界面不报错：家庭明细可读，满意度分项行与家户数一致", () => {
  const state = simulation.createInitialState();
  simulation.advanceDays(state, 40);
  const loaded = migrateSave(JSON.parse(JSON.stringify(state)), CONTENT);
  const view = simulation.selectDashboard(loaded);
  const details = view.households.details;
  assert.equal(details.length, householdList(loaded).length);
  for (const detail of details) {
    assert.ok(Array.isArray(detail.issues), `${detail.id} 应有 issues 列表`);
    assert.ok(Number.isFinite(detail.satisfaction), `${detail.id} 满意度应为有限数`);
  }
  const rows = currentSatisfactionFactorRows(loaded, CONTENT);
  assert.equal(rows.length, householdList(loaded).filter(isActiveHousehold).length);
  assert.ok(rows.every(row => Number.isFinite(row.target) && Number.isFinite(row.foodCoverage)));
  // 只读：界面现算不写状态。
  assert.equal(JSON.stringify(loaded).includes('"lastFactors"'), false);
});

test("观察窗数值等价：紧凑行逐键求和等于 totals，窗口合计与逐行求和一致", () => {
  const state = simulation.createInitialState();
  simulation.advanceDays(state, 40);
  for (const household of householdList(state).slice(0, 60)) {
    const obs = household.life.observation;
    assert.ok(obs.rows.length <= 14);
    const sums = {};
    for (const row of decodeRows(obs)) {
      for (const [key, value] of Object.entries(row)) if (key !== "year" && key !== "day" && value) sums[key] = (sums[key] || 0) + value;
    }
    for (const [key, value] of Object.entries(obs.totals)) {
      assert.ok(Math.abs((sums[key] || 0) - value) < 1e-6, `${household.id}.${key} 合计应等于逐行求和`);
    }
    const readonly = householdRecentTotalsReadonly(household, 14, CONTENT);
    assert.equal(readonly.days, obs.rows.length);
    assert.equal(readonly.incomeVoucherUnits || 0, obs.totals.incomeVoucherUnits || 0);
  }
});

test("读档往返后再推进 30 天，经济状态、界面汇总与原状态一致", () => {
  const state = simulation.createInitialState();
  simulation.advanceDays(state, 40);
  const loaded = migrateSave(JSON.parse(JSON.stringify(state)), CONTENT);
  simulation.advanceDays(state, 30);
  simulation.advanceDays(loaded, 30);
  // monetaryReform 的旧兼容字段读档时按设计丢弃（与本改动无关），比较时去掉。
  const economic = s => JSON.stringify({ ...s, monetaryReform: null });
  assert.equal(economic(loaded), economic(state));
  assert.deepEqual(simulation.selectDashboard(loaded).households.details, simulation.selectDashboard(state).households.details);
  assertValid(loaded);
});

test("[slow] 体积：maxed 档紧凑 JSON 不超过 9MB，并比带旧字段的同一状态明显小（读档再存不超过旧形状的 60%）", () => {
  const state = createMaxedState();
  const compact = JSON.stringify(state).length;
  assert.ok(compact <= 9e6, `紧凑 JSON ${(compact / 1e6).toFixed(2)}MB，应 ≤ 9MB`);
  const legacy = toLegacyShape(JSON.parse(JSON.stringify(state)));
  const legacySize = JSON.stringify(legacy).length;
  const reloaded = JSON.stringify(migrateSave(legacy, CONTENT)).length;
  assert.ok(reloaded < legacySize * 0.6, `旧形状 ${(legacySize / 1e6).toFixed(2)}MB → 读档再存 ${(reloaded / 1e6).toFixed(2)}MB`);
});
