import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";
import {
  SAVE_CONTAINER_TEXT_VERSION,
  SAVE_CONTAINER_VERSION,
  checksumSaveText,
  classifyPersistenceError,
  decodeSaveContainer,
  encodeSaveContainer
} from "../src/persistence/save-container.js";
import { gunzipToText, gzipText } from "../src/persistence/compression.js";

const SAVED_AT = "2026-09-27T12:00:00.000Z";

test("明文容器（v2）只持久化一个规范 state 文本，读回与原状态一致", async () => {
  const state = simulation.createInitialState({ seed: 11001 });
  simulation.advanceDays(state, 3);
  const { stored: raw, format } = await encodeSaveContainer("slot-a", "测试", state, SAVED_AT, CONTENT, { compress: false });
  assert.equal(format, SAVE_CONTAINER_TEXT_VERSION);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.containerVersion, SAVE_CONTAINER_TEXT_VERSION);
  assert.equal(parsed.checksum, checksumSaveText(JSON.stringify(state)));
  assert.deepEqual((await decodeSaveContainer(raw, "slot-a", CONTENT)).state, migrateSave(state, CONTENT));
  const corrupt = raw.replace(/"checksum":"[0-9a-f]+"/, '"checksum":"deadbeef"');
  await assert.rejects(decodeSaveContainer(corrupt, "slot-a", CONTENT), error => error.code === "corrupt");
});

test("压缩容器（v3）字节往返一致；校验和覆盖未压缩的原文，改动后被检出", async () => {
  assert.equal(SAVE_CONTAINER_VERSION, 3);
  const state = simulation.createInitialState({ seed: 11003 });
  simulation.advanceDays(state, 3);
  const { stored, format, summary } = await encodeSaveContainer("slot-c", "压缩", state, SAVED_AT, CONTENT);
  assert.equal(format, SAVE_CONTAINER_VERSION);
  assert.ok(stored instanceof Uint8Array, "压缩容器存的是字节");
  assert.equal(summary.year, state.year);
  assert.equal(summary.day, state.day + 1);
  const decoded = await decodeSaveContainer(stored, "slot-c", CONTENT);
  assert.equal(decoded.name, "压缩");
  assert.deepEqual(decoded.state, migrateSave(state, CONTENT));

  // 解压 → 改正文一个数字 → 重新压缩：校验和应当报损坏，而不是读出一份悄悄改过的存档。
  const text = await gunzipToText(stored);
  const rngAt = text.indexOf('"rng":');
  const digitAt = text.slice(rngAt).search(/[1-9]/) + rngAt;
  const flipped = text.slice(0, digitAt) + (text[digitAt] === "9" ? "1" : String(Number(text[digitAt]) + 1)) + text.slice(digitAt + 1);
  const tampered = await gzipText(flipped);
  await assert.rejects(decodeSaveContainer(tampered, "slot-c", CONTENT), error => error.code === "corrupt");
  // 不是 gzip 的字节也按损坏处理。
  await assert.rejects(decodeSaveContainer(new Uint8Array([1, 2, 3, 4]), "slot-c", CONTENT), error => error.code === "corrupt");
});

test("压缩容器体积至少缩小 10 倍（最满级存档）", { timeout: 120000 }, async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL("./fixtures/maxed-save.json", import.meta.url));
  if (!existsSync(path)) return; // 夹具不存在时（不入库）跳过；node scripts/make-maxed-save.mjs 可生成
  const { parseSaveFile } = await import("../src/persistence/storage.js");
  const state = parseSaveFile(readFileSync(path, "utf8"), CONTENT);
  const plain = await encodeSaveContainer("slot-m", "满级", state, SAVED_AT, CONTENT, { compress: false });
  const packed = await encodeSaveContainer("slot-m", "满级", state, SAVED_AT, CONTENT);
  const plainBytes = new TextEncoder().encode(plain.stored).length;
  assert.ok(packed.stored.byteLength * 10 <= plainBytes, `压缩后 ${packed.stored.byteLength} 字节，明文 ${plainBytes} 字节`);
  assert.equal(validateSaved(await decodeSaveContainer(packed.stored, "slot-m", CONTENT)), true);
});

function validateSaved(entry) {
  return simulation.validateState(entry.state).valid;
}

test("旧版本存档读档时直接拒绝，提示开新游戏", async () => {
  const state = simulation.createInitialState({ seed: 11002 });
  state.version = 15;
  state.schemaVersion = 15;
  assert.throws(() => migrateSave(state, CONTENT), /旧版存档不兼容/);
  const raw = (await encodeSaveContainer("slot-b", "旧档", simulation.createInitialState({ seed: 11002 }), SAVED_AT, CONTENT, { compress: false }))
    .stored
    .replace(`"version":${CONTENT.rules.saveVersion}`, '"version":15').replace(`"schemaVersion":${CONTENT.rules.saveVersion}`, '"schemaVersion":15');
  await assert.rejects(decodeSaveContainer(raw, "slot-b", CONTENT), error => ["corrupt", "validation"].includes(error.code));
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
