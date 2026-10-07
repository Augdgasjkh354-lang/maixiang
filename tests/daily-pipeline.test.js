import test from "node:test";
import assert from "node:assert/strict";
import { DAILY_STEPS } from "../src/systems/daily.js";

test("日结流水线：步骤名唯一，且先发钱、再生产、再居民购买、最后金融与翻日", () => {
  const ids = DAILY_STEPS.map(step => step.id);
  assert.equal(new Set(ids).size, ids.length);
  const order = ["staffing", "wages", "production", "shopPreparation", "trade", "meal", "finance", "harvest", "annualReport"];
  const positions = order.map(id => ids.indexOf(id));
  assert.ok(positions.every(index => index >= 0));
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b));
});
