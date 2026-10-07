import test from "node:test";
import assert from "node:assert/strict";
import { SAVE_KEY } from "../src/persistence/storage.js";
import { SAVE_CATALOG_KEY, SAVE_SLOT_PREFIX } from "../src/persistence/save-manager.js";
import { probeLocalStorageWrite, scanLegacyLocalStorage } from "../src/persistence/indexed-save-manager.js";

function memoryStorage(initial = {}, { failWrites = false } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) {
      if (failWrites) { const error = new Error("forced full"); error.name = "QuotaExceededError"; throw error; }
      data.set(key, String(value));
    },
    removeItem(key) { data.delete(key); },
    keys() { return [...data.keys()]; }
  };
}

test("r02 遗留扫描区分 r01 主档、旧单档、历史备份和目录，不读取无关键", () => {
  const storage = memoryStorage({
    [SAVE_KEY]: "old-single",
    [SAVE_KEY + ".backup-before-v12-x"]: "old-history",
    [SAVE_CATALOG_KEY]: "catalog",
    [SAVE_SLOT_PREFIX + "abc"]: "slot-primary",
    [SAVE_SLOT_PREFIX + "abc:backup"]: "slot-backup",
    "unrelated-setting": "keep"
  });
  const scan = scanLegacyLocalStorage(storage);
  assert.equal(scan.artifacts.length, 5);
  assert.equal(scan.stats.count, 5);
  assert.ok(scan.stats.slotPrimaryBytes > 0);
  assert.ok(scan.stats.oldSingleBytes > 0);
  assert.ok(scan.stats.backupBytes > 0);
  assert.ok(scan.stats.catalogBytes > 0);
  assert.equal(scan.artifacts.some(row => row.key === "unrelated-setting"), false);
});

test("r02 localStorage 写入探测必须完成写入、读回、删除，不留下探测键", async () => {
  const storage = memoryStorage({ existing: "value" });
  const result = await probeLocalStorageWrite(storage);
  assert.equal(result.ok, true);
  assert.deepEqual(storage.keys(), ["existing"]);
  assert.equal(storage.getItem("existing"), "value");
});

test("r02 localStorage 写入被配额拒绝时探测失败，不能仅因读取成功判定恢复", async () => {
  const storage = memoryStorage({ existing: "readable" }, { failWrites: true });
  assert.equal(storage.getItem("existing"), "readable");
  const result = await probeLocalStorageWrite(storage);
  assert.equal(result.ok, false);
  assert.equal(result.code, "quota");
  assert.equal(result.originalName, "QuotaExceededError");
  assert.deepEqual(storage.keys(), ["existing"]);
});
