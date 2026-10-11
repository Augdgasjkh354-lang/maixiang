import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { createIndexedSaveManager } from "../src/persistence/indexed-save-manager.js";
import { checksumSaveText } from "../src/persistence/save-container.js";
import { gunzipToText } from "../src/persistence/compression.js";
import { validateState } from "../src/core/validation.js";

const sim = simulation;

// 推进 400 天的状态只构造一次（昂贵），各用例取深拷贝。
let playedFixture = null;
function playedRaw() {
  if (!playedFixture) {
    playedFixture = sim.createInitialState();
    sim.advanceDays(playedFixture, 400);
  }
  return structuredClone(playedFixture);
}

function asSaved(state) {
  return JSON.parse(JSON.stringify(state));
}

// ---------- 1) 数值字段：null / 数字字符串 不得取底板默认值 ----------

test("存档里库存数值被存成 null（原 NaN）时读回 0，并写进读档报告，不取新开局默认值", () => {
  const live = playedRaw();
  live.accounts.town.wheat = NaN; // JSON 中变成 null
  const loaded = migrateSave(asSaved(live), sim.content);
  assert.equal(loaded.accounts.town.wheat, 0);
  assert.ok(loaded._loadReport.repaired.includes("accounts.town.wheat"));
  assert.equal(validateState(loaded, sim.content).valid, true);
});

test("健康的大额库存原样读回，不记修复", () => {
  const live = playedRaw();
  live.accounts.town.wheat = 19800000000;
  const loaded = migrateSave(asSaved(live), sim.content);
  assert.equal(loaded.accounts.town.wheat, 19800000000);
  assert.equal(loaded._loadReport.repaired.includes("accounts.town.wheat"), false);
});

test("数字字符串 \"5000000000\" 转成数字并写进读档报告", () => {
  const live = playedRaw();
  const raw = asSaved(live);
  raw.accounts.town.wheat = "5000000000";
  const loaded = migrateSave(raw, sim.content);
  assert.equal(typeof loaded.accounts.town.wheat, "number");
  assert.equal(loaded.accounts.town.wheat, 5000000000);
  assert.ok(loaded._loadReport.repaired.includes("accounts.town.wheat"));
});

test("无法转成数字的字符串归零并写进读档报告", () => {
  const live = playedRaw();
  const raw = asSaved(live);
  raw.accounts.town.wheat = "abc";
  const loaded = migrateSave(raw, sim.content);
  assert.equal(loaded.accounts.town.wheat, 0);
  assert.ok(loaded._loadReport.repaired.includes("accounts.town.wheat"));
});

// ---------- 2) 备份轮转：只有旧主档能完整解码才能覆盖备份 ----------

function makeFakeFactory() {
  const stores = new Map([["slots", new Map()], ["meta", new Map()]]);
  const keyPaths = { slots: "id", meta: "key" };
  const factory = {
    open() {
      const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      const db = {
        objectStoreNames: { contains: name => stores.has(name) },
        createObjectStore: () => {},
        close() {},
        transaction(names) {
          const list = Array.isArray(names) ? names : [names];
          const tx = {
            oncomplete: null, onabort: null, onerror: null,
            objectStore(name) {
              const map = stores.get(name);
              const request = () => ({ result: undefined, onsuccess: null, onerror: null });
              return {
                getAll: () => { const r = request(); r.result = [...map.values()].map(v => structuredClone(v)); queueMicrotask(() => r.onsuccess?.()); return r; },
                get: key => { const r = request(); r.result = map.has(key) ? structuredClone(map.get(key)) : undefined; queueMicrotask(() => r.onsuccess?.()); return r; },
                put: row => { const r = request(); map.set(row[keyPaths[name]], structuredClone(row)); r.result = row[keyPaths[name]]; queueMicrotask(() => r.onsuccess?.()); return r; },
                delete: key => { const r = request(); map.delete(key); queueMicrotask(() => r.onsuccess?.()); return r; }
              };
            },
            abort() {}
          };
          setImmediate(() => tx.oncomplete?.());
          return tx;
        }
      };
      req.result = db;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }
  };
  return { factory, stores };
}

// 篡改一份 primary：改成校验和正确、但数据不合法（库存为负）的文本。
function checksumValidButInvalid(text) {
  const entry = JSON.parse(text);
  const hh = Object.keys(entry.state.households.byId)[0];
  entry.state.households.byId[hh].inventory.wheat = -5;
  const stateText = JSON.stringify(entry.state);
  const header = JSON.stringify({ containerVersion: entry.containerVersion, id: entry.id, name: entry.name, savedAt: entry.savedAt, checksum: checksumSaveText(stateText) });
  return header.slice(0, -1) + ',"state":' + stateText + "}";
}

test("旧主档校验和正确但解不开时，保存不会用它覆盖仍可读的备份", async () => {
  const { factory, stores } = makeFakeFactory();
  const mgr = await createIndexedSaveManager({ indexedDB: factory, content: sim.content });
  const state = sim.createInitialState();
  sim.advanceDays(state, 30);
  const created = await mgr.createNew("测试");
  const id = created.id;
  await mgr.saveCurrent(state, id);
  sim.advanceDays(state, 5);
  await mgr.saveCurrent(state, id);
  const rec = stores.get("slots").get(id);
  const goodBackup = rec.backup;
  assert.ok(goodBackup, "第二次存档后应有备份");

  // 篡改的主档换成明文容器（校验和对、数据不合法）；元数据指纹仍是写入时那份，所以不再被信任。
  rec.primary = checksumValidButInvalid(await gunzipToText(rec.primary));
  stores.get("slots").set(id, rec);
  const mgr2 = await createIndexedSaveManager({ indexedDB: factory, content: sim.content });
  assert.equal((await mgr2.read(id)).recovered, true);

  await mgr2.saveCurrent((await mgr2.read(id)).state, id);
  const after = stores.get("slots").get(id);
  assert.deepEqual(Buffer.from(after.backup), Buffer.from(goodBackup), "备份必须保持为最后一份可读的存档");
  assert.equal((await gunzipToText(after.backup)).includes("\"wheat\":-5"), false);
});

test("旧主档完整可读时，保存照常把它轮转为备份", async () => {
  const { factory, stores } = makeFakeFactory();
  const mgr = await createIndexedSaveManager({ indexedDB: factory, content: sim.content });
  const state = sim.createInitialState();
  const created = await mgr.createNew("轮转");
  await mgr.saveCurrent(state, created.id);
  const firstPrimary = stores.get("slots").get(created.id).primary;
  sim.advanceDays(state, 3);
  await mgr.saveCurrent(state, created.id);
  assert.deepEqual(Buffer.from(stores.get("slots").get(created.id).backup), Buffer.from(firstPrimary));
});

// ---------- 3) 畸形家庭条目：补齐、丢弃危险键、中文错误而非 TypeError ----------

test("缺字段的多余家庭条目读档时以新开局户补齐，不抛 TypeError", () => {
  const live = playedRaw();
  const raw = asSaved(live);
  raw.households.byId["ghost-1"] = { id: "ghost-1" };
  const loaded = migrateSave(raw, sim.content);
  const ghost = loaded.households.byId["ghost-1"];
  assert.ok(ghost, "ghost-1 应被保留并补齐");
  assert.equal(typeof ghost.inventory, "object");
  assert.ok(loaded._loadReport.repaired.some(path => path.startsWith("households.byId.ghost-1")));
});

test("危险键（__proto__）的家庭条目被丢弃，且不污染原型", () => {
  const live = playedRaw();
  const raw = asSaved(live);
  Object.defineProperty(raw.households.byId, "__proto__", {
    value: { id: "__proto__" }, enumerable: true, configurable: true, writable: true
  });
  const loaded = migrateSave(raw, sim.content);
  assert.equal(Object.keys(loaded.households.byId).includes("__proto__"), false);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(loaded.households.byId), Object.prototype);
});

test("家庭库存为 null 时按 0 读回，并记入读档报告", () => {
  const live = playedRaw();
  const raw = asSaved(live);
  const hhId = Object.keys(raw.households.byId)[0];
  raw.households.byId[hhId].inventory.wheat = null;
  const loaded = migrateSave(raw, sim.content);
  assert.equal(loaded.households.byId[hhId].inventory.wheat, 0);
  assert.ok(loaded._loadReport.repaired.includes(`households.byId.${hhId}.inventory.wheat`));
});

test("家庭 id 与键不一致时以键为准并记入读档报告", () => {
  const live = playedRaw();
  const raw = asSaved(live);
  const hhId = Object.keys(raw.households.byId)[0];
  raw.households.byId[hhId].id = "zzz";
  const loaded = migrateSave(raw, sim.content);
  assert.equal(loaded.households.byId[hhId].id, hhId);
  assert.ok(loaded._loadReport.repaired.includes(`households.byId.${hhId}.id`));
});

test("家庭表不是对象时抛中文错误，而不是 TypeError", () => {
  const live = playedRaw();
  const raw = asSaved(live);
  raw.households.byId = [];
  assert.throws(() => migrateSave(raw, sim.content), error => {
    assert.ok(!(error instanceof TypeError), "不应是 TypeError");
    assert.match(error.message, /家庭/);
    return true;
  });
});

// ---------- 4) 利润率政策范围校验 ----------

test("利润率政策超出 0—200 时校验失败，合法范围内通过", () => {
  const state = sim.createInitialState();
  assert.equal(validateState(state, sim.content).valid, true);
  for (const key of ["shopMarginPercent", "tradeMarginPercent", "tradeImportMarginPercent"]) {
    const bad = structuredClone(state);
    bad.policy[key] = 201;
    assert.equal(validateState(bad, sim.content).valid, false, `${key}=201 应不合法`);
    const negative = structuredClone(state);
    negative.policy[key] = -1;
    assert.equal(validateState(negative, sim.content).valid, false, `${key}=-1 应不合法`);
    const edge = structuredClone(state);
    edge.policy[key] = 200;
    assert.equal(validateState(edge, sim.content).valid, true, `${key}=200 应合法`);
  }
});
