import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";
import {
  SAVE_CONTAINER_VERSION,
  checksumSaveText,
  classifyPersistenceError,
  decodeSaveContainer,
  encodeSaveContainer
} from "../src/persistence/save-container.js";

test("存档容器只持久化一个规范 state 文本，读回与原状态一致", () => {
  const state = simulation.createInitialState({ seed: 11001 });
  simulation.advanceDays(state, 3);
  const raw = encodeSaveContainer("slot-a", "测试", state, "2026-09-27T12:00:00.000Z", CONTENT);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.containerVersion, SAVE_CONTAINER_VERSION);
  assert.equal(parsed.checksum, checksumSaveText(JSON.stringify(state)));
  assert.deepEqual(decodeSaveContainer(raw, "slot-a", CONTENT).state, migrateSave(state, CONTENT));
  const corrupt = raw.replace(/"checksum":"[0-9a-f]+"/, '"checksum":"deadbeef"');
  assert.throws(() => decodeSaveContainer(corrupt, "slot-a", CONTENT), error => error.code === "corrupt");
});

test("旧版本存档读档时直接拒绝，提示开新游戏", () => {
  const state = simulation.createInitialState({ seed: 11002 });
  state.version = 15;
  state.schemaVersion = 15;
  assert.throws(() => migrateSave(state, CONTENT), /旧版存档不兼容/);
  const raw = encodeSaveContainer("slot-b", "旧档", simulation.createInitialState({ seed: 11002 }), "2026-09-27T12:00:00.000Z", CONTENT)
    .replace(`"version":${CONTENT.rules.saveVersion}`, '"version":15').replace(`"schemaVersion":${CONTENT.rules.saveVersion}`, '"schemaVersion":15');
  assert.throws(() => decodeSaveContainer(raw, "slot-b", CONTENT), error => ["corrupt", "validation"].includes(error.code));
});

test("存储异常区分配额、访问拒绝与程序错误", () => {
  for (const [name, code] of [["QuotaExceededError", "quota"], ["SecurityError", "denied"], ["NotAllowedError", "denied"], ["NotSupportedError", "denied"]]) {
    const original = new DOMException("raw-message", name);
    const classified = classifyPersistenceError(original, "写入");
    assert.equal(classified.code, code);
    assert.equal(classified.originalName, name);
  }
  assert.equal(classifyPersistenceError(new Error("boom"), "读取").code, "program");
});
