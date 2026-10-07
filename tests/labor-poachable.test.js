import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { selectJobRows } from "../src/selectors/labor.js";
import { computePoachable } from "../src/systems/labor-market.js";
import { validateState } from "../src/core/validation.js";

function stateWithMills(seed = 6101, millCount = 16) {
  const state = legacyVoucherState({ seed });
  const freePlots = state.plots.filter(p => !p.feature && !state.buildings.some(b => b.plotId === p.id));
  // 开局数值调整（8cf03ae）：劳动力 600→1750、农民 400→1500，待业从 200 涨到 250。
  // 单层磨坊（12 岗）已不足以吃掉全部待业，故用 5 级建筑（上限）把岗位容量放大到能填满 idle；
  // setEmployment 只会领取实际待业人数，容量更大不影响"恰好清零"的构造。
  const level = 5;
  const mk = (id, typeId, i) => {
    const p = freePlots[i];
    state.buildings.push({ id, typeId, level,
      ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
      plotId: p.id, x: p.x, y: p.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  };
  mk("bakery-0", "bakery", 0);
  for (let i = 1; i <= millCount; i++) mk(`mill-${i}`, "mill", i);
  return state;
}

test("可挖人数：待业>0 时 poachable 为 0；待业=0 时按出价统计低薪在岗者", () => {
  const state = stateWithMills();
  simulation.setWageRate(state, "bakers", 15);
  simulation.advanceDays(state, 5);
  let snap = selectJobRows(state, CONTENT);
  assert.ok(snap.idle > 0);
  const bk = snap.rows.find(r => r.key === "bakery-0::bakers");
  assert.equal(bk.poachable, 0, "idle>0 时不计算 poachable");
  // 填满磨坊清零 idle
  for (const r of snap.rows.filter(r => r.scope === "building" && r.roleId === "millers")) {
    simulation.setEmployment(state, r.key, r.capacity);
  }
  simulation.setEmployment(state, "bakery-0::bakers", 8);
  snap = selectJobRows(state, CONTENT);
  assert.equal(snap.idle, 0);
  const bk2 = snap.rows.find(r => r.key === "bakery-0::bakers");
  assert.ok(bk2.poachable > 0, "idle=0 且存在低薪在岗者时 poachable>0");
  assert.equal(bk2.maxAssignable, bk2.count + Math.min(bk2.capacity - bk2.count, bk2.poachable));
  // computePoachable 与行上一致
  const fn = computePoachable(state, CONTENT);
  assert.equal(fn(15), bk2.poachable);
  assert.equal(fn(1), 0, "出价过低挖不到人");
});

test("手动增员：待业=0 且缺口>0 时从低薪岗位挖人（用户 0.1.11 O8 行为）", () => {
  const state = stateWithMills();
  simulation.setWageRate(state, "bakers", 15);
  simulation.advanceDays(state, 5);
  let snap = selectJobRows(state, CONTENT);
  for (const r of snap.rows.filter(r => r.scope === "building" && r.roleId === "millers")) {
    simulation.setEmployment(state, r.key, r.capacity);
  }
  simulation.setEmployment(state, "bakery-0::bakers", 8);
  snap = selectJobRows(state, CONTENT);
  assert.equal(snap.idle, 0);
  const millersBefore = snap.rows.filter(r => r.roleId === "millers").reduce((s, r) => s + r.count, 0);
  const moves0 = state.laborCompetition?.year?.moves || 0;
  const res = simulation.setEmployment(state, "bakery-0::bakers", 10);
  const moves1 = state.laborCompetition?.year?.moves || 0;
  assert.ok(res.ok);
  assert.equal(res.assigned, 10, "挖人后足额到岗");
  assert.equal(moves1 - moves0, 2, "缺口 2 人恰好挖走 2 人");
  snap = selectJobRows(state, CONTENT);
  const millersAfter = snap.rows.filter(r => r.roleId === "millers").reduce((s, r) => s + r.count, 0);
  assert.equal(millersBefore - millersAfter, 2, "被挖的是磨坊低薪工");
  const issues = validateState(state, CONTENT);
  assert.equal(issues.valid, true, JSON.stringify(issues.errors).slice(0, 300));
});

test("挖人不碰农人：农人不计入 poachable", () => {
  const state = stateWithMills();
  simulation.advanceDays(state, 5);
  let snap = selectJobRows(state, CONTENT);
  for (const r of snap.rows.filter(r => r.scope === "building")) {
    simulation.setEmployment(state, r.key, r.capacity);
  }
  snap = selectJobRows(state, CONTENT);
  assert.equal(snap.idle, 0);
  const fn = computePoachable(state, CONTENT);
  // 400 农人日薪为 0（按分粮），若计入则 1e9 出价能挖到 400+；实际应只含非农在岗者
  const farmers = snap.rows.find(r => r.key === "farmers").count;
  assert.ok(farmers > 0);
  const total = fn(1e9);
  const nonFarmers = snap.employed - farmers;
  assert.equal(total, nonFarmers, "poachable 上限等于非农在岗人数");
});
