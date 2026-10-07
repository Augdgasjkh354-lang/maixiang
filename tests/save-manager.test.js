import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { createInitialState } from "../src/core/state.js";
import { simulation } from "../src/engine.js";
import { SAVE_KEY, exportState } from "../src/persistence/storage.js";
import { createSaveManager, SAVE_CATALOG_KEY, SAVE_SLOT_PREFIX } from "../src/persistence/save-manager.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  let failKey = null;
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) {
      if (key === failKey) { const error = new Error("full"); error.name = "QuotaExceededError"; throw error; }
      data.set(key, String(value));
    },
    removeItem(key) { data.delete(key); },
    failOn(key) { failKey = key; },
    raw(key) { return data.get(key); }
  };
}

test("旧单存档安全接入，新游戏与刷新切回原局", () => {
  const old = createInitialState({ content: CONTENT });
  simulation.setAgricultureTax(old, 30);
  simulation.advanceDay(old);
  const raw = exportState(old);
  const storage = memoryStorage({ [SAVE_KEY]: raw });
  const saves = createSaveManager(storage, CONTENT);
  const opened = saves.initialize();
  assert.equal(opened.migrated, true);
  assert.equal(storage.raw(SAVE_KEY), raw);
  const originalId = opened.activeId;
  const fresh = saves.createNew("第二局");
  assert.notEqual(fresh.id, originalId);
  assert.equal(fresh.state.day, 0);
  assert.notEqual(fresh.state.policy.agricultureTaxPercent, 30);
  assert.equal(saves.initialize().activeId, fresh.id);
  const restored = saves.activate(originalId);
  assert.equal(restored.state.day, 1);
  assert.equal(restored.state.policy.agricultureTaxPercent, 30);
  assert.equal(createSaveManager(storage, CONTENT).initialize().activeId, originalId);
});

test("另存、导出导入、删除当前局后保持选择界面", () => {
  const storage = memoryStorage();
  const saves = createSaveManager(storage, CONTENT);
  assert.equal(saves.initialize().state, null);
  const first = saves.createNew("新游戏 1");
  const originalId = first.id;
  const duplicate = saves.saveAs(first.state, "分支");
  assert.equal(saves.list().slots.length, 2);
  assert.equal(saves.list().activeId, duplicate.id);
  const imported = saves.importFile(exportState(saves.read(originalId).state));
  assert.equal(saves.list().activeId, duplicate.id);
  assert.equal(saves.read(imported.id).state.year, 1);
  assert.equal(saves.list().slots.length, 3);
  saves.rename(imported.id, "导回的存档");
  assert.equal(saves.read(imported.id).name, "导回的存档");
  assert.equal(saves.remove(duplicate.id).current, true);
  assert.equal(saves.list().activeId, null);
  assert.equal(createSaveManager(storage, CONTENT).initialize().state, null);
  assert.equal(saves.list().slots.length, 2);
});

test("异常写入保留上一版本；损坏主槽回退自动备份", () => {
  const storage = memoryStorage();
  const saves = createSaveManager(storage, CONTENT);
  assert.equal(saves.initialize().state, null);
  const opened = saves.createNew("新游戏 1");
  const id = opened.id;
  const changed = structuredClone(opened.state);
  simulation.advanceDay(changed);
  saves.saveCurrent(changed, id);
  const primary = storage.raw(SAVE_SLOT_PREFIX + id);
  storage.failOn(SAVE_SLOT_PREFIX + id);
  assert.throws(() => saves.saveCurrent(changed, id), /空间不足/);
  assert.equal(storage.raw(SAVE_SLOT_PREFIX + id), primary);
  storage.failOn(null);
  storage.setItem(SAVE_SLOT_PREFIX + id, "{bad");
  assert.equal(saves.read(id).recovered, true);
  assert.equal(saves.read(id).state.day, 1);
  assert.equal(saves.list().slots.find(slot => slot.current).recovered, true);
});

test("损坏文件和目录不覆盖可读存档", () => {
  const storage = memoryStorage();
  const saves = createSaveManager(storage, CONTENT);
  assert.equal(saves.initialize().state, null);
  const opened = saves.createNew("新游戏 1");
  const id = opened.id;
  assert.throws(() => saves.importFile("{bad"), /有效 JSON/);
  assert.throws(() => saves.importFile(JSON.stringify({ version: 99 })), /更新版本/);
  assert.equal(saves.list().slots.length, 1);
  storage.setItem(SAVE_CATALOG_KEY, "{bad");
  const recovered = createSaveManager(storage, CONTENT).initialize();
  assert.equal(recovered.state, null);
  assert.equal(recovered.slots[0].id, id);
  assert.match(recovered.warning, /目录损坏/);
});

test("旧单存档损坏时原字节保留，仍能开启新局", () => {
  const storage = memoryStorage({ [SAVE_KEY]: "{damaged" });
  const saves = createSaveManager(storage, CONTENT);
  const opened = saves.initialize();
  assert.equal(opened.state, null);
  assert.match(opened.warning, /原有存档无法接入/);
  saves.createNew("新局");
  assert.equal(storage.raw(SAVE_KEY), "{damaged");
});

test("空存储启动不落盘；确认新局后只写主槽，不提前复制同内容自动备份", () => {
  const storage = memoryStorage();
  const saves = createSaveManager(storage, CONTENT);
  const initial = saves.initialize();
  assert.equal(initial.state, null);
  assert.equal(storage.length, 0, "未点击新游戏前不得创建存档");
  const opened = saves.createNew("新游戏 1");
  assert.ok(opened.id);
  assert.ok(storage.raw(SAVE_SLOT_PREFIX + opened.id));
  assert.equal(storage.raw(SAVE_SLOT_PREFIX + opened.id + ":backup"), undefined);
  const stats = saves.storageStats();
  assert.equal(stats.slotCount, 1);
  assert.equal(stats.backupCount, 0);
  assert.ok(stats.primaryBytes > 0);
});

test("首次主槽写入失败不留下目录索引或半成品槽", () => {
  const storage = memoryStorage();
  const prototype = createSaveManager(storage, CONTENT);
  // 预先推导第一次 create 的 key 不稳定，因此让所有新槽主键写入模拟配额不足。
  const originalSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key.startsWith(SAVE_SLOT_PREFIX) && !key.endsWith(":backup")) {
      const error = new Error("quota full"); error.name = "QuotaExceededError"; throw error;
    }
    originalSet(key, value);
  };
  assert.throws(() => prototype.createNew("新游戏 1"), error => error?.code === "quota" && /空间不足/.test(error.message));
  assert.equal(storage.raw(SAVE_CATALOG_KEY), undefined);
  assert.equal(storage.length, 0);
});

test("目录写入失败会回滚刚写的新槽，且不会生成首次备份", () => {
  const storage = memoryStorage();
  const originalSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === SAVE_CATALOG_KEY) {
      const error = new Error("catalog quota"); error.name = "QuotaExceededError"; throw error;
    }
    originalSet(key, value);
  };
  const saves = createSaveManager(storage, CONTENT);
  assert.throws(() => saves.createNew("新游戏 1"), error => error?.code === "quota");
  assert.equal(storage.length, 0, "目录失败后不得残留孤立主槽或备份");
});

test("存储异常区分配额、访问拒绝、序列化、校验与程序错误", async () => {
  const { classifyPersistenceError } = await import("../src/persistence/save-manager.js");
  for (const [name, code] of [["QuotaExceededError", "quota"], ["SecurityError", "denied"], ["NotAllowedError", "denied"], ["NotSupportedError", "denied"]]) {
    const original = new DOMException("raw-message", name);
    const classified = classifyPersistenceError(original, "写入");
    assert.equal(classified.code, code);
    assert.equal(classified.cause, original);
    assert.equal(classified.originalName, name);
    assert.equal(classified.originalMessage, "raw-message");
  }
  const program = classifyPersistenceError(new Error("boom"), "读取");
  assert.equal(program.code, "program");
  assert.equal(program.originalMessage, "boom");

  const storage = memoryStorage();
  const saves = createSaveManager(storage, CONTENT);
  const state = createInitialState({ content: CONTENT });
  const circular = structuredClone(state);
  circular.circular = circular;
  assert.throws(() => saves.saveAs(circular, "循环"), error => error?.code === "validation" || error?.code === "serialization");
  const invalid = structuredClone(state);
  invalid.year = 0;
  assert.throws(() => saves.saveAs(invalid, "坏状态"), error => error?.code === "validation");
});
