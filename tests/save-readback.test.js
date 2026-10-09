import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { createIndexedSaveManager } from "../src/persistence/indexed-save-manager.js";
import { checksumSaveText } from "../src/persistence/save-container.js";

// 极简 IndexedDB：put/get 同步复制行（与浏览器的结构化克隆一致），可注入写失败与回读损坏。
function createFakeIndexedDb() {
  const stores = new Map();
  const keyPaths = new Map();
  let initialized = false;
  const controller = { failSlotWrites: false, corruptNextSlotRead: null, lastSlotPut: null };

  function request(value, error = null) {
    const req = { result: undefined, error, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (error) req.onerror?.();
      else { req.result = value; req.onsuccess?.(); }
    });
    return req;
  }

  function corrupt(row, mode) {
    const copy = { ...row };
    if (mode === "truncate") copy.primary = copy.primary.slice(0, -1);
    else if (mode === "middle") {
      const at = Math.floor(copy.primary.length / 2);
      copy.primary = copy.primary.slice(0, at) + (copy.primary[at] === "0" ? "1" : "0") + copy.primary.slice(at + 1);
    } else if (mode === "backup") copy.backup = (copy.backup || "") + " ";
    return copy;
  }

  class Tx {
    constructor(names, mode) {
      this.names = Array.isArray(names) ? names : [names];
      this.mode = mode;
      this.error = null;
      this.failed = false;
      this.oncomplete = null;
      this.onabort = null;
      this.onerror = null;
      setImmediate(() => { if (!this.failed) this.oncomplete?.(); });
    }
    objectStore(name) {
      const map = stores.get(name);
      const keyPath = keyPaths.get(name);
      const failWrite = () => this.mode === "readwrite" && name === "slots" && controller.failSlotWrites;
      const fail = () => {
        const error = new Error("forced slot write failure");
        error.name = "QuotaExceededError";
        this.error = error;
        this.failed = true;
        queueMicrotask(() => { this.onerror?.(); this.onabort?.(); });
        return request(undefined, error);
      };
      return {
        getAll: () => request([...map.values()].map(row => structuredClone(row))),
        get: key => {
          if (!map.has(key)) return request(undefined);
          let row = structuredClone(map.get(key));
          if (name === "slots" && controller.corruptNextSlotRead) {
            row = corrupt(row, controller.corruptNextSlotRead);
            controller.corruptNextSlotRead = null;
          }
          return request(row);
        },
        put: row => {
          if (name === "slots") controller.lastSlotPut = structuredClone(row);
          if (failWrite()) return fail();
          map.set(row[keyPath], structuredClone(row));
          return request(row[keyPath]);
        },
        delete: key => {
          map.delete(key);
          return request(undefined);
        }
      };
    }
    abort() {
      if (this.failed) return;
      this.failed = true;
      this.error = new Error("aborted");
      queueMicrotask(() => this.onabort?.());
    }
  }

  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, options = {}) {
      if (!stores.has(name)) stores.set(name, new Map());
      keyPaths.set(name, options.keyPath || "id");
      return {};
    },
    transaction(names, mode) { return new Tx(names, mode); },
    close() {}
  };

  const indexedDB = {
    open() {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (!initialized) { initialized = true; req.onupgradeneeded?.(); }
        queueMicrotask(() => req.onsuccess?.());
      });
      return req;
    }
  };
  const storedSlot = id => stores.get("slots")?.get(id) || null;
  return { indexedDB, controller, storedSlot };
}

async function openManager() {
  const fake = createFakeIndexedDb();
  const manager = await createIndexedSaveManager({ indexedDB: fake.indexedDB, content: CONTENT });
  return { manager, fake };
}

test("回读损坏（截断、中间单字符改动、备份被改）都会被检测到，且不更新内存记录", async () => {
  for (const mode of ["truncate", "middle", "backup"]) {
    const { manager, fake } = await openManager();
    const state = simulation.createInitialState({ seed: 31001 });
    const created = await manager.saveAs(state, "回读校验");
    await manager.saveCurrent(state, created.id); // 第二次保存，确保 backup 非空
    fake.controller.corruptNextSlotRead = mode;
    await assert.rejects(
      manager.saveCurrent(state, created.id),
      error => error.step === "save_current_write_verify",
      `mode ${mode} should be detected`
    );
    fake.controller.corruptNextSlotRead = null;
    // 检测失败后内存中的存档仍可读，并且保存恢复正常。
    assert.equal(manager.read(created.id).state.year, state.year);
    await manager.saveCurrent(state, created.id);
  }
});

test("正常写入时回读校验通过", async () => {
  const { manager } = await openManager();
  const state = simulation.createInitialState({ seed: 31002 });
  const created = await manager.saveAs(state, "正常");
  const saved = await manager.saveCurrent(state, created.id);
  assert.equal(saved.id, created.id);
  assert.equal(manager.read(created.id).state.year, state.year);
});

test("写入失败时 pendingBytes 等于 primary 与 backup 的 UTF-8 字节数之和", async () => {
  const { manager, fake } = await openManager();
  const state = simulation.createInitialState({ seed: 31003 });
  const created = await manager.saveAs(state, "字节计数");
  await manager.saveCurrent(state, created.id);
  fake.controller.failSlotWrites = true;
  await assert.rejects(manager.saveCurrent(state, created.id), error => {
    const attempted = fake.controller.lastSlotPut;
    const expected = Buffer.byteLength(attempted.primary, "utf8") + Buffer.byteLength(attempted.backup || "", "utf8");
    assert.equal(error.pendingBytes, expected);
    return true;
  });
  fake.controller.failSlotWrites = false;
});

test("存储统计的字节数与 IndexedDB 中实际存放的文本一致（含保存、改名之后）", async () => {
  const { manager, fake } = await openManager();
  const state = simulation.createInitialState({ seed: 31004 });
  const first = await manager.saveAs(state, "甲");
  await manager.saveCurrent(state, first.id);
  await manager.saveCurrent(state, first.id);
  const second = await manager.saveAs(state, "乙");
  await manager.saveCurrent(state, second.id);
  await manager.rename(first.id, "甲改名");
  const expected = { primaryBytes: 0, backupBytes: 0 };
  for (const slot of manager.list().slots) {
    const row = fake.storedSlot(slot.id);
    expected.primaryBytes += Buffer.byteLength(row.primary, "utf8");
    expected.backupBytes += Buffer.byteLength(row.backup || "", "utf8");
  }
  const stats = manager.storageStats().indexedDB;
  assert.equal(stats.primaryBytes, expected.primaryBytes);
  assert.equal(stats.backupBytes, expected.backupBytes);
  assert.equal(stats.totalBytes, expected.primaryBytes + expected.backupBytes);
});

test("存档校验和算法固定：已知输入的结果不变（旧存档依赖它）", () => {
  assert.equal(checksumSaveText(""), "811c9dc5");
  assert.equal(checksumSaveText("麦乡"), "e5850fa8");
  assert.equal(checksumSaveText("a😀中文\u0001"), "b96aa5a0");
  assert.equal(checksumSaveText(JSON.stringify({ year: 3, day: 12, name: "测试存档", list: [1, 2.5, null, true] })), "642be153");
});
