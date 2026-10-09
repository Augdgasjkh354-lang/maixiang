import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdList, householdExchangeAllowanceUnits, ensureEmploymentExchangeDay, maximumResidentExchangeWheatUnits } from "../src/systems/households.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;

test("就业换券额度：新局默认 20 斤，规则常量为 默认 20、上限 50", () => {
  assert.equal(CONTENT.rules.employmentExchangeDefaultJin, 20);
  assert.equal(CONTENT.rules.employmentExchangeMaximumJin, 50);
  const state = legacyVoucherState({ seed: 990001 });
  assert.equal(state.policy.employmentExchangeJin, 20);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("就业换券额度：50 斤被接受，51 斤与负数被拒绝，原值保持不变", () => {
  const state = legacyVoucherState({ seed: 990002 });
  assert.equal(simulation.setEmploymentExchangeQuota(state, 50).ok, true);
  assert.equal(state.policy.employmentExchangeJin, 50);
  const rejected = simulation.setEmploymentExchangeQuota(state, 51);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "每日换券额度须为0—50斤", "错误信息取自规则上下限");
  assert.equal(simulation.setEmploymentExchangeQuota(state, -1).ok, false);
  assert.equal(state.policy.employmentExchangeJin, 50, "被拒绝的设置不得改动额度");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("家庭换券额度按配置值计算：在岗人数 × 额度", () => {
  const state = legacyVoucherState({ seed: 990003 });
  const household = householdList(state)[0];
  for (const quota of [5, 12, 50]) {
    assert.equal(simulation.setEmploymentExchangeQuota(state, quota).ok, true);
    const exchange = ensureEmploymentExchangeDay(state, CONTENT);
    const employed = exchange.eligibleByHousehold[household.id] || 0;
    assert.equal(
      householdExchangeAllowanceUnits(state, household.id, CONTENT),
      employed * quota * I,
      `额度 ${quota} 斤时，家庭可换券量应为在岗人数乘以 ${quota} 斤`
    );
  }
  // 全镇合计同样跟随配置值
  const total = maximumResidentExchangeWheatUnits(state, CONTENT);
  assert.equal(total, Object.values(ensureEmploymentExchangeDay(state, CONTENT).eligibleByHousehold)
    .reduce((sum, count) => sum + count, 0) * 50 * I);
});
