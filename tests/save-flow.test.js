import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { createAutosaveCoordinator, autosaveRetryDelayMs } from "../src/persistence/autosave-coordinator.js";
import { createIndexedSaveManager } from "../src/persistence/indexed-save-manager.js";
import { encodeSaveContainer, storedDigest } from "../src/persistence/save-container.js";
import { exportState, exportStateGzipBlob, parseSaveFile, readSaveFileText } from "../src/persistence/storage.js";
import { gunzipToBytes, gzipSupported } from "../src/persistence/compression.js";

const SAVED_AT = "2026-09-27T12:00:00.000Z";

// ---------- 1) 自动存档失败退避 ----------

test("退避时间：第 n 次连续失败等待 2 秒 × 2^(n-1)，封顶 30 秒", () => {
  assert.equal(autosaveRetryDelayMs(0), 0);
  assert.equal(autosaveRetryDelayMs(1), 2000);
  assert.equal(autosaveRetryDelayMs(2), 4000);
  assert.equal(autosaveRetryDelayMs(4), 16000);
  assert.equal(autosaveRetryDelayMs(5), 30000);
  assert.equal(autosaveRetryDelayMs(40), 30000);
});

test("自动存档失败后到点才允许重试；成功后清零；手动保存的失败标为 manual", async () => {
  let clock = 1000;
  let failing = true;
  const infos = [];
  let dirty = true;
  const coordinator = createAutosaveCoordinator({
    capture: () => ({ slotId: "A", session: 1, revision: 1, dirty, state: { v: 1 } }),
    save: async () => { if (failing) throw new Error("磁盘满"); dirty = false; return { savedAt: SAVED_AT }; },
    onFailure: (snapshot, error, info) => infos.push({ message: error.message, ...info }),
    now: () => clock
  });

  assert.equal(await coordinator.request(), false);
  assert.equal(coordinator.failures, 1);
  assert.equal(infos[0].manual, false, "自动存档");
  assert.equal(infos[0].retryAt, 3000);
  assert.equal(coordinator.retryDue(), false, "退避未到，不重试");
  clock = 2999;
  assert.equal(coordinator.retryDue(), false);
  clock = 3000;
  assert.equal(coordinator.retryDue(), true, "到点可重试");
  // 同一修订的普通请求不会重复写（失败修订被记住），只有强制重试才会再写。
  assert.equal(await coordinator.request(), false);
  assert.equal(infos.length, 1);

  assert.equal(await coordinator.request({ force: true, manual: true }), false);
  assert.equal(infos[1].manual, true, "玩家主动保存");
  assert.equal(infos[1].failures, 2);
  assert.equal(infos[1].retryAt, 3000 + 4000);

  failing = false;
  clock = infos[1].retryAt;
  assert.equal(await coordinator.request({ force: true }), true);
  assert.equal(coordinator.failures, 0);
  assert.equal(coordinator.retryDue(), false);
  assert.equal(dirty, false);
});

test("退避期内的自动请求不写入（即使游戏日推进产生新修订）；手动保存照常写", async () => {
  let clock = 0;
  let revision = 1;
  let writes = 0;
  let failing = true;
  const coordinator = createAutosaveCoordinator({
    capture: () => ({ slotId: "A", session: 1, revision, dirty: true }),
    save: async () => { writes += 1; if (failing) throw new Error("满"); return { savedAt: SAVED_AT }; },
    now: () => clock
  });
  assert.equal(await coordinator.request(), false);
  assert.equal(writes, 1);
  for (let day = 0; day < 20; day += 1) {
    revision += 1; // 每个游戏日都是新修订
    assert.equal(await coordinator.request(), false);
  }
  assert.equal(writes, 1, "退避期内自动存档不再写");
  assert.equal(await coordinator.request({ manual: true }), false);
  assert.equal(writes, 2, "玩家主动保存不受退避限制");
  clock = 3999;
  failing = false;
  assert.equal(await coordinator.request(), false, "退避未到，自动存档仍不写");
  clock = 4000;
  // 同一修订失败过的，退避到点后由调用方用 force 重试（app 的 retryDue 路径即如此）。
  assert.equal(await coordinator.request({ force: true }), true, "退避到点后重试成功");
  assert.equal(writes, 3);
});

test("退避期间挂起的保存不会抢跑：suspend 中 retryDue 为假", async () => {
  let clock = 0;
  const coordinator = createAutosaveCoordinator({
    capture: () => ({ slotId: "A", session: 1, revision: 1, dirty: true }),
    save: async () => { throw new Error("x"); },
    now: () => clock
  });
  await coordinator.request();
  clock = 10000;
  coordinator.suspend();
  assert.equal(coordinator.retryDue(), false);
  coordinator.resume();
  assert.equal(coordinator.retryDue(), true);
});

// ---------- 2) 导出去缩进 / 压缩导出 / 导入自动识别 ----------

function sampleState(seed = 4101) {
  const state = simulation.createInitialState({ seed });
  simulation.advanceDays(state, 4);
  return state;
}

function fakeFile(bytes) {
  return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

test("明文导出是紧凑 JSON；导入同时接受紧凑与缩进两种明文", async () => {
  const state = sampleState();
  const compact = exportState(state);
  assert.equal(compact, JSON.stringify(state));
  assert.equal(compact.includes("\n"), false);
  const pretty = JSON.stringify(state, null, 2);
  assert.ok(compact.length < pretty.length * 0.7, "紧凑体积明显小于缩进版");
  assert.deepEqual(parseSaveFile(compact, CONTENT), parseSaveFile(pretty, CONTENT));
  const text = await readSaveFileText(fakeFile(new TextEncoder().encode(compact)));
  assert.equal(text, compact);
});

test("压缩导出：文件以 gzip 魔数开头，导入时自动解压并得到同一份存档", { skip: !gzipSupported() }, async () => {
  const state = sampleState(4102);
  const blob = await exportStateGzipBlob(state);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x1f);
  assert.equal(bytes[1], 0x8b);
  assert.ok(bytes.length * 5 < exportState(state).length, "压缩后明显更小");
  const text = await readSaveFileText(blob);
  assert.equal(text, exportState(state));
  assert.deepEqual(parseSaveFile(text, CONTENT), parseSaveFile(exportState(state), CONTENT));
});

test("压缩导入遇到损坏的 gzip 给出中文提示，不当成明文", { skip: !gzipSupported() }, async () => {
  const broken = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0xff, 0xff]);
  await assert.rejects(readSaveFileText(fakeFile(broken)), /压缩存档无法解压/);
  await assert.rejects(readSaveFileText(fakeFile(new Uint8Array([0xff, 0xfe, 0x00]))), /不是有效 JSON/);
});

test("压缩导出的字节可被 DecompressionStream 直接解开（与 gzip 标准一致）", { skip: !gzipSupported() }, async () => {
  const blob = await exportStateGzipBlob(sampleState(4103));
  const plain = await gunzipToBytes(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(new TextDecoder().decode(plain), exportState(sampleState(4103)));
});

// ---------- 3) IndexedDB 管理器：元数据、备份、版本变更、配额、持久存储 ----------

// 极简 IndexedDB（与浏览器的结构化克隆一致）：可注入写失败；暴露 db 与各存储，方便断言。
function makeFakeIdb() {
  const stores = new Map([["slots", new Map()], ["meta", new Map()]]);
  const keyPaths = { slots: "id", meta: "key" };
  const control = { failWrites: false, created: false };
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore() { return {}; },
    close() { control.closed = true; },
    onversionchange: null,
    transaction(names, mode) {
      const tx = {
        error: null, failed: false, oncomplete: null, onabort: null, onerror: null,
        objectStore(name) {
          const map = stores.get(name);
          return {
            get: key => request(() => (map.has(key) ? structuredClone(map.get(key)) : undefined)),
            getAll: () => request(() => [...map.values()].map(row => structuredClone(row))),
            put: row => {
              if (mode === "readwrite" && name === "slots" && control.failWrites) {
                const error = new Error("forced quota");
                error.name = "QuotaExceededError";
                tx.error = error;
                tx.failed = true;
                queueMicrotask(() => { tx.onerror?.(); tx.onabort?.(); });
                return request(() => { throw error; });
              }
              return request(() => { map.set(row[keyPaths[name]], structuredClone(row)); return row[keyPaths[name]]; });
            },
            delete: key => request(() => { map.delete(key); })
          };
        },
        abort() { this.failed = true; queueMicrotask(() => this.onabort?.()); }
      };
      setImmediate(() => { if (!tx.failed) tx.oncomplete?.(); });
      return tx;
    }
  };
  function request(fn) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try { req.result = fn(); req.onsuccess?.(); }
      catch (error) { req.error = error; req.onerror?.(); }
    });
    return req;
  }
  const factory = {
    open() {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (!control.created) { control.created = true; req.onupgradeneeded?.(); }
        req.onsuccess?.();
      });
      return req;
    }
  };
  return { factory, stores, db, control };
}

async function openManager(fake) {
  return createIndexedSaveManager({ indexedDB: fake.factory, content: CONTENT });
}

test("列表只读元数据：正文坏了也能列出（不解码），读取时回退到备份", async () => {
  const fake = makeFakeIdb();
  const manager = await openManager(fake);
  const state = sampleState(4201);
  const created = await manager.createNew("列表");
  await manager.saveCurrent(state, created.id);
  await manager.saveCurrent(state, created.id);
  const row = fake.stores.get("slots").get(created.id);
  assert.ok(row.primary instanceof Uint8Array, "压缩存档存字节");
  assert.ok(row.backup instanceof Uint8Array, "备份已轮转");
  // 把主档改成非 gzip 的垃圾：若列表要解码就会失败；列表只读元数据，仍应显示。
  row.primary = Uint8Array.from([9, 9, 9, 9]);
  fake.stores.get("slots").set(created.id, row);
  const listed = (await openManager(fake)).list().slots.find(slot => slot.id === created.id);
  assert.equal(listed.name, "列表");
  assert.equal(listed.year, state.year);
  assert.equal(listed.day, state.day + 1);
  assert.equal(listed.damaged, false);
  const entry = await (await openManager(fake)).read(created.id);
  assert.equal(entry.recovered, true, "读取时主档坏了，回退到备份");
  assert.equal(entry.state.year, state.year);
});

test("旧存档位（无元数据的明文容器）打开时解码一次，元数据写回，之后列表不再解码", async () => {
  const fake = makeFakeIdb();
  const state = sampleState(4202);
  const legacy = await encodeSaveContainer("legacy-1", "旧存档", state, SAVED_AT, CONTENT, { compress: false });
  fake.stores.get("slots").set("legacy-1", { id: "legacy-1", primary: legacy.stored, backup: null, createdAt: SAVED_AT });
  fake.stores.get("meta").set("catalog", { key: "catalog", value: { containerVersion: 1, activeId: "legacy-1", deletedIds: [] } });
  const manager = await openManager(fake);
  const listed = manager.list().slots[0];
  assert.equal(listed.name, "旧存档");
  assert.equal(listed.year, state.year);
  const written = fake.stores.get("slots").get("legacy-1");
  assert.equal(written.meta.name, "旧存档");
  assert.equal(written.meta.verified, true);
  assert.equal(written.primary, legacy.stored, "正文不被改写");
  assert.equal(written.meta.digest, storedDigest(legacy.stored));
});

test("旧存档位正文坏了（解不开）：打开时标为损坏，列表显示损坏、可删除", async () => {
  const fake = makeFakeIdb();
  fake.stores.get("slots").set("bad-1", { id: "bad-1", primary: "{\"not\":\"a container\"}", backup: null, createdAt: SAVED_AT });
  fake.stores.get("meta").set("catalog", { key: "catalog", value: { containerVersion: 1, activeId: null, deletedIds: [] } });
  const manager = await openManager(fake);
  const listed = manager.list().slots[0];
  assert.equal(listed.damaged, true);
  assert.equal(listed.name, "损坏的存档");
});

test("数据库被其他标签页升级：连接关闭，之后的存档给出明确提示（denied）", async () => {
  const fake = makeFakeIdb();
  const manager = await openManager(fake);
  const created = await manager.createNew("升级");
  assert.equal(typeof fake.db.onversionchange, "function");
  fake.db.onversionchange();
  assert.equal(fake.control.closed, true, "连接已关闭，不阻塞升级");
  await assert.rejects(
    manager.saveCurrent(sampleState(4203), created.id),
    error => error.code === "denied" && /其他标签页升级/.test(error.message)
  );
});

test("写入失败的提示附带浏览器配额信息（navigator.storage.estimate）", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { estimate: async () => ({ usage: 5 * 1048576, quota: 100 * 1048576 }), persist: async () => false } }
  });
  try {
    const fake = makeFakeIdb();
    const manager = await openManager(fake);
    const created = await manager.createNew("配额");
    fake.control.failWrites = true;
    await assert.rejects(manager.saveCurrent(sampleState(4204), created.id), error => {
      assert.match(error.message, /配额 100\.0 MB/);
      assert.match(error.message, /已用 5\.0 MB/);
      assert.equal(error.storageUsage.indexedDB.slotCount, 1);
      return true;
    });
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});

test("持久存储：存档前后各请求一次；浏览器拒绝后不再反复询问", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let asks = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { persist: async () => { asks += 1; return false; } } }
  });
  try {
    const fake = makeFakeIdb();
    const manager = await openManager(fake);
    const created = await manager.createNew("持久");
    for (let i = 0; i < 4; i += 1) await manager.saveCurrent(sampleState(4205 + i), created.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(asks, 2, "前后各一次，之后不再问");
    assert.equal(manager.storageStats().persist, "denied");
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});

test("管理器存取往返：压缩存档读回与原状态一致，字节统计与实际存放一致", async () => {
  const fake = makeFakeIdb();
  const manager = await openManager(fake);
  const state = sampleState(4210);
  const created = await manager.createNew("往返");
  await manager.saveCurrent(state, created.id);
  const entry = await manager.read(created.id);
  assert.deepEqual(entry.state, parseSaveFile(exportState(state), CONTENT));
  const row = fake.stores.get("slots").get(created.id);
  const stats = manager.storageStats().indexedDB;
  assert.equal(stats.primaryBytes, row.primary.byteLength);
  assert.equal(stats.backupBytes, row.backup ? row.backup.byteLength : 0);
});
