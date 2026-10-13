import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";

// 证据：simulation.setUnemploymentPolicy(state, null) 抛 TypeError（patch.enabled 读 null）。
// 其他政策命令（setVillaPolicy / setBankPolicy / setWageControl）都把缺省 patch 当 {}，这里保持一致：null 视为不改。
test("setUnemploymentPolicy treats a null or missing patch as no change instead of throwing", () => {
  const state = simulation.createInitialState();
  const before = { ...state.policy.unemploymentBenefit };
  const nullResult = simulation.setUnemploymentPolicy(state, null);
  assert.equal(nullResult.ok, true);
  assert.deepEqual(state.policy.unemploymentBenefit, before);
  const missingResult = simulation.setUnemploymentPolicy(state);
  assert.equal(missingResult.ok, true);
  assert.deepEqual(state.policy.unemploymentBenefit, before);
  assert.equal(simulation.validateState(state).valid, true);
});
