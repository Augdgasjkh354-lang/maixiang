import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { renderPeople } from "../src/ui/panel-people.js";
import { renderLedger } from "../src/ui/panel-ledger.js";
import {
  SAVE_CONTAINER_VERSION,
  checksumSaveText,
  createSaveManager,
  decodeSaveContainer,
  encodeSaveContainer
} from "../src/persistence/save-manager.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    raw(key) { return data.get(key); }
  };
}

function legacyV1Container(id, name, state, savedAt) {
  const stateText = JSON.stringify(state);
  return JSON.stringify({ containerVersion: 1, id, name, savedAt, checksum: checksumSaveText(stateText), state });
}

test("0.1.10 新v2容器只持久化一个规范state文本，并兼容读取v1容器", () => {
  const state = simulation.createInitialState({ seed: 11001 });
  simulation.advanceDays(state, 3);
  const id = "slot-a";
  const savedAt = "2026-09-27T12:00:00.000Z";
  const raw = encodeSaveContainer(id, "测试", state, savedAt, CONTENT);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.containerVersion, SAVE_CONTAINER_VERSION);
  assert.equal(SAVE_CONTAINER_VERSION, 2);
  assert.equal(parsed.checksum, checksumSaveText(JSON.stringify(state)));
  const normalized = migrateSave(state, CONTENT);
  assert.deepEqual(decodeSaveContainer(raw, id, CONTENT).state, normalized);

  const legacy = legacyV1Container(id, "旧容器", state, savedAt);
  const loadedLegacy = decodeSaveContainer(legacy, id, CONTENT);
  assert.equal(loadedLegacy.name, "旧容器");
  assert.deepEqual(loadedLegacy.state, normalized);
});

test("0.1.10 校验失败仍回退上一份可读备份，坏主档不覆盖备份", () => {
  const storage = memoryStorage();
  const saves = createSaveManager(storage, CONTENT);
  const opened = saves.createNew("主档");
  const changed = structuredClone(opened.state);
  simulation.advanceDay(changed);
  saves.saveCurrent(changed, opened.id);
  const primaryKey = `maixiang-save-slot-v1:${opened.id}`;
  const backupKey = `${primaryKey}:backup`;
  const backup = storage.raw(backupKey);
  assert.ok(backup);
  const corrupt = storage.raw(primaryKey).replace(/"checksum":"[0-9a-f]+"/, '"checksum":"deadbeef"');
  storage.setItem(primaryKey, corrupt);
  const recovered = saves.read(opened.id);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.state.day, 0);
  assert.equal(storage.raw(backupKey), backup);
});

