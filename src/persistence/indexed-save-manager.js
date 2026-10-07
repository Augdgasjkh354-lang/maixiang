import { CONTENT } from "../content/index.js";
import { createInitialState } from "../core/state.js";
import { parseSaveFile } from "./storage.js";
import {
  SAVE_CATALOG_VERSION,
  SavePersistenceError,
  classifyPersistenceError,
  decodeSaveContainer as decode,
  encodeSaveContainer as encode,
  inspectSaveContainer as inspect,
  stringifySaveJson as stringify
} from "./save-container.js";

export const SAVE_DB_NAME = "maixiang-save-db-v2";
export const SAVE_DB_VERSION = 1;
const SLOT_STORE = "slots";
const META_STORE = "meta";
const CATALOG_META_KEY = "catalog";
const MAX_NAME_LENGTH = 36;

function byteLength(text) {
  const value = String(text ?? "");
  try { return new TextEncoder().encode(value).length; }
  catch { return value.length * 2; }
}

function nameOf(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new SavePersistenceError("validation", "请输入存档名称。");
  if (name.length > MAX_NAME_LENGTH) throw new SavePersistenceError("validation", `名称最多${MAX_NAME_LENGTH}字。`);
  return name;
}

function defaultCatalog() {
  return { containerVersion: SAVE_CATALOG_VERSION, activeId: null, deletedIds: [] };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

function openDatabase(factory) {
  if (!factory?.open) throw new SavePersistenceError("denied", "浏览器未提供可用的 IndexedDB 持久存储。");
  return new Promise((resolve, reject) => {
    let request;
    try { request = factory.open(SAVE_DB_NAME, SAVE_DB_VERSION); }
    catch (error) { reject(classifyPersistenceError(error, "打开 IndexedDB")); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SLOT_STORE)) db.createObjectStore(SLOT_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(classifyPersistenceError(request.error, "打开 IndexedDB"));
    request.onblocked = () => reject(new SavePersistenceError("denied", "IndexedDB 升级被其他页面阻塞，请关闭同一游戏的其他标签页后重试。"));
  });
}

async function readAll(db, storeName) {
  const tx = db.transaction(storeName, "readonly");
  const done = transactionDone(tx);
  const store = tx.objectStore(storeName);
  const rows = await requestResult(store.getAll());
  await done;
  return rows;
}

async function readOne(db, storeName, key) {
  const tx = db.transaction(storeName, "readonly");
  const done = transactionDone(tx);
  const store = tx.objectStore(storeName);
  const row = await requestResult(store.get(key));
  await done;
  return row;
}

async function putOne(db, storeName, row) {
  const tx = db.transaction(storeName, "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(storeName).put(row);
  await done;
}

function describeSlot(record, catalog, content) {
  let entry = null;
  let recovered = false;
  let oldVersion = false;
  if (record?.primary) {
    try { entry = decode(record.primary, record.id, content); }
    catch (error) { if (!["corrupt", "validation"].includes(error.code)) throw error; oldVersion ||= /旧版存档/.test(error.message); }
  }
  if (!entry && record?.backup) {
    try { entry = decode(record.backup, record.id, content); recovered = true; }
    catch (error) { if (!["corrupt", "validation"].includes(error.code)) throw error; oldVersion ||= /旧版存档/.test(error.message); }
  }
  if (!entry) return { id: record.id, name: oldVersion ? "旧版存档（不兼容，可删除）" : "损坏的存档", savedAt: null, current: catalog.activeId === record.id, damaged: true };
  return {
    id: record.id,
    name: entry.name,
    savedAt: entry.savedAt,
    year: entry.state.year,
    day: entry.state.day + 1,
    population: (entry.state.cohorts || []).reduce((sum, group) => sum + group.m + group.f, 0),
    recovered,
    current: catalog.activeId === record.id,
    damaged: false
  };
}

function readSlotFromRecord(record, content) {
  if (record?.primary) {
    try { return { ...decode(record.primary, record.id, content), recovered: false }; }
    catch (error) { if (!["corrupt", "validation"].includes(error.code)) throw error; }
  }
  if (record?.backup) {
    try { return { ...decode(record.backup, record.id, content), recovered: true }; }
    catch (error) { if (!["corrupt", "validation"].includes(error.code)) throw error; }
  }
  throw new SavePersistenceError("corrupt", "存档损坏，且自动备份无法读取。原数据仍保留。");
}

function randomId(existingIds) {
  let id;
  do {
    id = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  } while (existingIds.has(id));
  return id;
}

function safeError(error, action) {
  return error instanceof SavePersistenceError ? error : classifyPersistenceError(error, action);
}

export async function createIndexedSaveManager({ indexedDB: factory = globalThis.indexedDB, content = CONTENT } = {}) {
  let db;
  try { db = await openDatabase(factory); }
  catch (error) {
    const classified = safeError(error, "打开 IndexedDB");
    classified.step = "indexeddb_open";
    classified.pendingBytes = 0;
    throw classified;
  }
  let catalog = defaultCatalog();
  let slotRecords = new Map();

  function indexedStats() {
    let primaryBytes = 0;
    let backupBytes = 0;
    for (const record of slotRecords.values()) {
      primaryBytes += byteLength(record.primary || "");
      backupBytes += byteLength(record.backup || "");
    }
    return { primaryBytes, backupBytes, totalBytes: primaryBytes + backupBytes, slotCount: slotRecords.size };
  }

  function decorate(error, step, pendingBytes = 0) {
    const classified = safeError(error, "写入 IndexedDB");
    classified.step = classified.step || step;
    classified.pendingBytes = Number.isFinite(classified.pendingBytes) ? classified.pendingBytes : pendingBytes;
    classified.storageUsage = { indexedDB: indexedStats() };
    return classified;
  }

  async function refreshCaches() {
    try {
      const [slots, metaRows] = await Promise.all([readAll(db, SLOT_STORE), readAll(db, META_STORE)]);
      slotRecords = new Map(slots.map(row => [row.id, row]));
      const catalogRow = metaRows.find(row => row.key === CATALOG_META_KEY);
      catalog = catalogRow?.value && typeof catalogRow.value === "object" ? { ...defaultCatalog(), ...catalogRow.value } : defaultCatalog();
      catalog.deletedIds = Array.isArray(catalog.deletedIds) ? catalog.deletedIds : [];
    } catch (error) {
      throw decorate(error, "indexeddb_refresh", 0);
    }
  }

  async function writeCatalog(nextCatalog, tx = null) {
    const row = { key: CATALOG_META_KEY, value: nextCatalog };
    if (tx) tx.objectStore(META_STORE).put(row);
    else await putOne(db, META_STORE, row);
  }

  await refreshCaches();

  function list() {
    const deleted = new Set(catalog.deletedIds || []);
    const slots = [...slotRecords.values()].filter(row => !deleted.has(row.id)).map(record => describeSlot(record, catalog, content));
    slots.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
    return { slots, activeId: catalog.activeId, warning: null };
  }

  function read(id) {
    const record = slotRecords.get(id);
    if (!record) throw new SavePersistenceError("validation", "存档不存在。");
    return readSlotFromRecord(record, content);
  }

  function initialize() {
    const listed = list();
    if (!catalog.activeId) return { state: null, ...listed, created: false };
    try {
      const entry = read(catalog.activeId);
      return { state: entry.state, ...listed, warning: entry.recovered ? "当前存档损坏，已从自动备份恢复；请保存当前进度。" : listed.warning };
    } catch (error) {
      if (["quota", "denied", "program"].includes(error.code)) throw error;
      return { state: null, ...listed, warning: "当前存档无法读取，请从列表选择可用存档或备份。" };
    }
  }

  async function createSlot(state, name, activate = true) {
    const id = randomId(new Set(slotRecords.keys()));
    const savedAt = new Date().toISOString();
    const primary = encode(id, nameOf(name), state, savedAt, content);
    const nextCatalog = activate ? { ...catalog, activeId: id } : catalog;
    const pendingBytes = byteLength(primary) + (activate ? byteLength(stringify(nextCatalog)) : 0);
    let tx;
    try {
      tx = db.transaction([SLOT_STORE, META_STORE], "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(SLOT_STORE).put({ id, primary, backup: null, createdAt: savedAt });
      if (activate) tx.objectStore(META_STORE).put({ key: CATALOG_META_KEY, value: nextCatalog });
      await done;
      const readBack = await readOne(db, SLOT_STORE, id);
      if (!readBack || readBack.primary !== primary) throw new Error("新存档写入后读回校验失败");
      inspect(readBack.primary, id);
      slotRecords.set(id, readBack);
      if (activate) catalog = nextCatalog;
      return { id, name: nameOf(name), savedAt, state, recovered: false };
    } catch (error) {
      try { tx?.abort(); } catch {}
      throw decorate(error, "create_slot_write_verify", pendingBytes);
    }
  }

  async function saveCurrent(state, expectedId) {
    const id = catalog.activeId;
    if (!id || id !== expectedId) throw new SavePersistenceError("validation", "当前没有可保存的存档，请先选择一局。");
    const oldRecord = slotRecords.get(id);
    let oldMeta = null;
    let backup = oldRecord?.backup || null;
    if (oldRecord?.primary) {
      try { oldMeta = inspect(oldRecord.primary, id); backup = oldRecord.primary; } catch {}
    }
    if (!oldMeta && oldRecord?.backup) {
      try { oldMeta = inspect(oldRecord.backup, id); } catch {}
    }
    if (!oldMeta) throw new SavePersistenceError("corrupt", "存档损坏，且自动备份无法读取。原数据仍保留。");
    const savedAt = new Date().toISOString();
    const primary = encode(id, oldMeta.name, state, savedAt, content);
    const record = { ...oldRecord, id, primary, backup, updatedAt: savedAt };
    const pendingBytes = byteLength(primary) + byteLength(backup || "");
    try {
      await putOne(db, SLOT_STORE, record);
      const readBack = await readOne(db, SLOT_STORE, id);
      if (!readBack || readBack.primary !== primary || readBack.backup !== backup) throw new Error("存档写入后读回校验失败");
      inspect(readBack.primary, id);
      slotRecords.set(id, readBack);
      return { id, name: oldMeta.name, savedAt, state, recovered: false };
    } catch (error) {
      throw decorate(error, "save_current_write_verify", pendingBytes);
    }
  }

  async function activate(id) {
    if ((catalog.deletedIds || []).includes(id)) throw new SavePersistenceError("validation", "该存档已删除。");
    const entry = read(id);
    const nextCatalog = { ...catalog, activeId: id };
    try {
      await writeCatalog(nextCatalog);
      const readBack = await readOne(db, META_STORE, CATALOG_META_KEY);
      if (!readBack || readBack.value?.activeId !== id) throw new Error("激活存档目录读回校验失败");
      catalog = nextCatalog;
      return entry;
    } catch (error) {
      throw decorate(error, "activate_catalog_write_verify", byteLength(stringify(nextCatalog)));
    }
  }

  async function rename(id, newName) {
    const oldRecord = slotRecords.get(id);
    const entry = read(id);
    const primary = encode(id, nameOf(newName), entry.state, entry.savedAt, content);
    const record = { ...oldRecord, primary };
    try {
      await putOne(db, SLOT_STORE, record);
      const readBack = await readOne(db, SLOT_STORE, id);
      if (!readBack || readBack.primary !== primary) throw new Error("重命名写入后读回校验失败");
      slotRecords.set(id, readBack);
      return { ...decode(primary, id, content), recovered: false };
    } catch (error) {
      throw decorate(error, "rename_slot_write_verify", byteLength(primary));
    }
  }

  async function remove(id) {
    if (!slotRecords.has(id) || (catalog.deletedIds || []).includes(id)) throw new SavePersistenceError("validation", "存档不存在。");
    const current = catalog.activeId === id;
    const nextCatalog = { ...catalog, activeId: current ? null : catalog.activeId, deletedIds: [...new Set([...(catalog.deletedIds || []), id])] };
    try {
      const tx = db.transaction([SLOT_STORE, META_STORE], "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(META_STORE).put({ key: CATALOG_META_KEY, value: nextCatalog });
      tx.objectStore(SLOT_STORE).delete(id);
      await done;
      const readBack = await readOne(db, SLOT_STORE, id);
      if (readBack !== undefined) throw new Error("删除存档后读回仍存在");
      slotRecords.delete(id);
      catalog = nextCatalog;
      return { current };
    } catch (error) {
      throw decorate(error, "delete_slot_write_verify", byteLength(stringify(nextCatalog)));
    }
  }

  async function importFile(text, name) {
    const state = parseSaveFile(text, content);
    const defaultName = `导入存档 ${list().slots.length + 1}`;
    return createSlot(state, name || defaultName, false);
  }

  async function probePersistentStorage() {
    const key = `probe:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const value = { nonce: Math.random().toString(36).slice(2), at: new Date().toISOString() };
    const pendingBytes = byteLength(stringify(value));
    try {
      await putOne(db, META_STORE, { key, value });
      const readBack = await readOne(db, META_STORE, key);
      if (!readBack || stringify(readBack.value) !== stringify(value)) throw new Error("IndexedDB 探测写入后读回不一致");
      const tx = db.transaction(META_STORE, "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(META_STORE).delete(key);
      await done;
      const deleted = await readOne(db, META_STORE, key);
      if (deleted !== undefined) throw new Error("IndexedDB 探测键删除失败");
      return { ok: true };
    } catch (error) {
      try {
        const tx = db.transaction(META_STORE, "readwrite");
        const done = transactionDone(tx);
        tx.objectStore(META_STORE).delete(key);
        await done;
      } catch {}
      throw decorate(error, "indexeddb_probe_write_read_delete", pendingBytes);
    }
  }

  function storageStats() {
    return { indexedDB: indexedStats() };
  }

  return {
    backend: "indexedDB",
    initialize,
    list,
    read,
    createNew: name => createSlot(createInitialState({ content }), name),
    saveCurrent,
    saveAs: (state, name) => createSlot(state, name),
    activate,
    rename,
    remove,
    importFile,
    probePersistentStorage,
    storageStats,
    close: () => db.close()
  };
}
