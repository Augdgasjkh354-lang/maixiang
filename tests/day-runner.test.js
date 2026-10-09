import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { SimulationClock } from "../src/ui/simulation-clock.js";

const DAYS = 30;

// 分段跑一天：每次 step 都只给 0 预算（即每次一步），直到当天完成。
function runSteppedDay(runner) {
  let calls = 0;
  while (!runner.step(0)) calls += 1;
  return calls;
}

test("分段日结（每次一步）与 advanceDay 推进 30 天结果逐位一致", () => {
  const base = simulation.createInitialState();
  const plain = structuredClone(base);
  const stepped = structuredClone(base);
  const plainResults = [];
  const steppedResults = [];
  for (let i = 0; i < DAYS; i += 1) plainResults.push(simulation.advanceDay(plain));
  for (let i = 0; i < DAYS; i += 1) {
    const runner = simulation.createDayRunner(stepped);
    assert.ok(runSteppedDay(runner) > 1, "一天应拆成多步执行");
    assert.equal(runner.done, true);
    steppedResults.push(runner.result);
  }
  assert.equal(JSON.stringify(stepped), JSON.stringify(plain));
  assert.equal(JSON.stringify(steppedResults), JSON.stringify(plainResults));
  assert.equal(simulation.validateState(stepped).valid, true);
  assert.equal(simulation.validateState(plain).valid, true);
});

test("中途调用 finish() 与逐日推进一致，混用分段与一次跑完也一致", () => {
  const base = simulation.createInitialState();
  const plain = structuredClone(base);
  const mixed = structuredClone(base);
  for (let i = 0; i < DAYS; i += 1) simulation.advanceDay(plain);
  for (let i = 0; i < DAYS; i += 1) {
    const runner = simulation.createDayRunner(mixed);
    if (i % 3 === 0) {
      // 只跑前几步就 finish：剩余步骤同步补齐。
      runner.step(0);
      runner.step(0);
      runner.step(0);
      assert.equal(runner.done, false);
      runner.finish();
    } else {
      runSteppedDay(runner);
    }
    assert.equal(runner.done, true);
    assert.equal(runner.step(0), true, "当天完成后再 step 直接返回 true");
    assert.equal(runner.finish(), runner.result);
  }
  assert.equal(JSON.stringify(mixed), JSON.stringify(plain));
  assert.equal(simulation.validateState(mixed).valid, true);
});

test("分段时钟：先累计再逐天开始，积压最多 1 天，暂停清零", () => {
  const clock = new SimulationClock({ rules: { dailyDaysPerSecond: 10, speedChoices: [1, 2, 4, 8, 16] } });
  clock.setSpeed(16);
  clock.accrue(0.5);
  let started = 0;
  while (clock.canStartDay()) { clock.startDay(); started += 1; }
  assert.equal(started, 80);
  assert.ok(Math.abs(clock.fractionalDays) < 1e-9);

  clock.accrue(2);
  clock.capBacklog();
  assert.equal(clock.fractionalDays, 1);

  clock.pause();
  assert.equal(clock.fractionalDays, 0);
  clock.accrue(5);
  assert.equal(clock.canStartDay(), false);
});
