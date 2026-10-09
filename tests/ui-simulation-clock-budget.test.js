import test from "node:test";
import assert from "node:assert/strict";
import { SimulationClock } from "../src/ui/simulation-clock.js";

const CONTENT = { rules: { dailyDaysPerSecond: 10, speedChoices: [1, 2, 4, 8, 16] } };

test("不给预算时单帧跑完全部到期日，与原行为一致", () => {
  const clock = new SimulationClock(CONTENT);
  clock.setSpeed(16);
  let days = 0;
  const advanced = clock.advanceFrame(0.5, () => { days += 1; });
  assert.equal(advanced, 80);
  assert.equal(days, 80);
  assert.ok(Math.abs(clock.fractionalDays) < 1e-9);
});

test("超过帧预算后停止追加，积压最多保留 1 天", () => {
  const clock = new SimulationClock(CONTENT);
  clock.setSpeed(16);
  let t = 0;
  let days = 0;
  // 每跑一天假装耗时 10ms；预算 40ms
  const advanced = clock.advanceFrame(2, () => { days += 1; t += 10; }, { budgetMs: 40, now: () => t });
  assert.equal(advanced, 5);
  assert.equal(days, 5);
  assert.equal(clock.fractionalDays, 1);
});

test("即使单日就超时也至少推进 1 天，不会卡住", () => {
  const clock = new SimulationClock(CONTENT);
  clock.setSpeed(16);
  let t = 0;
  const advanced = clock.advanceFrame(1, () => { t += 1000; }, { budgetMs: 40, now: () => t });
  assert.equal(advanced, 1);
  assert.equal(clock.fractionalDays, 1);
});

test("未跑完的积压在后续帧继续推进（积压上限 1 天）", () => {
  const clock = new SimulationClock(CONTENT);
  clock.setSpeed(16);
  let t = 0;
  let days = 0;
  const step = () => { days += 1; t += 10; };
  clock.advanceFrame(2, step, { budgetMs: 40, now: () => t });
  assert.equal(days, 5);
  t = 0;
  const next = clock.advanceFrame(0.01, step, { budgetMs: 40, now: () => t });
  // 积压 1 天 + 本帧新增 1.6 天 = 2.6 天，取整推进 2 天
  assert.equal(next, 2);
  assert.ok(clock.fractionalDays > 0.5 && clock.fractionalDays < 0.7);
});

test("暂停时不推进，预算参数不影响", () => {
  const clock = new SimulationClock(CONTENT);
  let days = 0;
  assert.equal(clock.advanceFrame(10, () => { days += 1; }, { budgetMs: 40 }), 0);
  assert.equal(days, 0);
});
