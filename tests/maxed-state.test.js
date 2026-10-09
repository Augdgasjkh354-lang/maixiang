import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createMaxedState } from "../scripts/maxed-state.mjs";
import { createSimulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { exportState, parseSaveFile } from "../src/persistence/storage.js";

const FIXTURE = new URL("./fixtures/maxed-save.json", import.meta.url);
const simulation = createSimulation();
let cached = null;
// 生成一次即可（约 2 秒）；需要改动的测试用 JSON 克隆，不污染缓存。
function maxed() {
  cached ||= createMaxedState();
  return JSON.parse(JSON.stringify(cached));
}

function nonFinitePaths(value, path = "state", out = []) {
  if (typeof value === "number" && !Number.isFinite(value)) out.push(path);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) nonFinitePaths(child, `${path}.${key}`, out);
  }
  return out;
}

test("createMaxedState returns a state that passes validateState", () => {
  const state = maxed();
  const result = simulation.validateState(state);
  assert.equal(result.valid, true, result.errors.slice(0, 5).join("；"));
});

test("every building type in content is built at least once, upgradeable ones at max level", () => {
  const state = maxed();
  for (const [typeId, definition] of Object.entries(CONTENT.buildings)) {
    const rows = state.buildings.filter(row => row.typeId === typeId);
    assert.ok(rows.length >= 1, `${typeId} should be built at least once`);
    const expected = definition.upgrade ? definition.upgrade.maxLevel : 1;
    assert.equal(rows[0].level, expected, `${typeId} level`);
  }
});

test("the maxed state is in voucher stage with bank and social security office built", () => {
  const state = maxed();
  assert.equal(state.monetaryReform.stage, "voucher");
  assert.ok(state.buildings.some(row => row.typeId === "bank"));
  assert.ok(state.buildings.some(row => row.typeId === "social_security_office"));
});

test("three more simulated days keep the state valid and free of NaN or Infinity", () => {
  const state = maxed();
  simulation.advanceDays(state, 3);
  const result = simulation.validateState(state);
  assert.equal(result.valid, true, result.errors.slice(0, 5).join("；"));
  assert.deepEqual(nonFinitePaths(state), []);
});

test("the maxed state reads back through the save import path", () => {
  const state = maxed();
  const text = exportState(state);
  const migrated = migrateSave(JSON.parse(text), CONTENT);
  assert.equal(simulation.validateState(migrated).valid, true);
  const parsed = parseSaveFile(text, CONTENT);
  assert.equal(simulation.validateState(parsed).valid, true);
});

test("the generated fixture file (if present) reads back through the save import path", { skip: !existsSync(FIXTURE) && "run node scripts/make-maxed-save.mjs first" }, () => {
  const state = parseSaveFile(readFileSync(FIXTURE, "utf8"), CONTENT);
  assert.equal(simulation.validateState(state).valid, true);
});
