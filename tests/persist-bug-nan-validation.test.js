import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { createInitialState } from "../src/core/state.js";
import { validateState } from "../src/core/validation.js";
import { encodeSaveContainer } from "../src/persistence/save-container.js";
import { loadState } from "../src/persistence/storage.js";

// 回归：validateState 用 `x || 0` 判断整数字段时，NaN 是假值会被当成 0 放行，
// 存档写入时 NaN 被 JSON 序列化成 null，读档又静默变成 0。校验必须拦下 NaN。

test("validateState 拒绝行业经营账里的 NaN", () => {
  const state = createInitialState({ opening: "standard", content: CONTENT });
  state.industries.forestry.day.soldUnits = NaN;
  const result = validateState(state, CONTENT);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("行业经营账字段无效")), result.errors.join("；"));
});

test("validateState 拒绝印花税账里的 NaN", () => {
  const state = createInitialState({ opening: "standard", content: CONTENT });
  state.stampDuty.year.stampDutyUnits = NaN;
  const result = validateState(state, CONTENT);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes("印花税账无效")), result.errors.join("；"));
});

test("含 NaN 的状态不能写入存档", async () => {
  const state = createInitialState({ opening: "standard", content: CONTENT });
  state.industries.salt.year.revenueWheatUnits = NaN;
  await assert.rejects(
    () => encodeSaveContainer("nan-test", "NaN 测试", state, new Date().toISOString(), CONTENT),
    error => error.code === "validation"
  );
});

test("旧版 loadState 遇到存的 null 给中文错误而不是 TypeError", () => {
  const storage = { getItem: () => "null" };
  assert.throws(() => loadState(storage, CONTENT), error => {
    assert.ok(!(error instanceof TypeError));
    assert.match(error.message, /无法读取/);
    return true;
  });
});
