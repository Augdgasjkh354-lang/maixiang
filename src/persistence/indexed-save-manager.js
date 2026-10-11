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
  sameStored,
  storedBytes,
  storedDigest,
  storedFormat,
  stringifySaveJson as stringify,
  summarizeSaveState
} from "./save-container.js";

export const SAVE_DB_NAME = "maixiang-save-db-v2";
export const SAVE_DB_VERSION = 1;
const SLOT_STORE = "slots";
const META_STORE = "meta";
const CATALOG_META_KEY = "catalog";
const MAX_NAME_LENGTH = 36;
const VERSION_CHANGE_MESSAGE = "本页存档数据库已被其他标签页升级，请刷新页面后再试。";

function byteLength(value) {
  return storedBytes(value);
}

function megabytes(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// 浏览器给出的存储用量与配额（navigator.storage.estimate）；不可用时返回 null。
async function storageEstimate() {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    if (!estimate || !Number.isFinite(estimate.quota)) return null;
    return { usage: Number(estimate.usage) || 0, quota: estimate.quota };
  } catch {
    return null;
  }
}

// 元数据：列表与备份选择只读它，不解码正文。verified 表示写入/解码时已通过完整校验，
// digest 是写入时正文的指纹，正文变了（指纹对不上）就不能再信它。
function metaFromParts({ name, savedAt, stored, summary, format }) {
  return {
    name,
    savedAt,
    year: summary.year,
    day: summary.day,
    population: summary.population,
    version: summary.version,
    bytes: storedBytes(stored),
    digest: storedDigest(stored),
    format: format ?? storedFormat(stored),
    verified: true
  };
}

function isKnownGood(record) {
  return Boolean(record?.primary) && Boolean(record.meta?.verified) && record.meta.digest === storedDigest(record.primary);
}

// 每条存档记录的字节数缓存，按记录对象引用挂载（WeakMap）。记录只会整体替换、不会原地修改，
// 记录被替换或删除后缓存随之失效，且不会额外持有字符串。
const recordByteCounts = new WeakMap();
function countsOf(record) {
  let counts = recordByteCounts.get(record);
  if (!counts) { counts = {}; recordByteCounts.set(record, counts); }
  return counts;
}
function recordFieldBytes(record, field) {
  const counts = countsOf(record);
  if (counts[field] === undefined) counts[field] = byteLength(record[field] || "");
  return counts[field];
}
// 新记录的 backup 就是旧记录的 primary（或旧 backup），字节数已知时直接沿用，省一次 UTF-8 编码。
function seedBackupBytes(record, oldRecord, backup) {
  if (!oldRecord || typeof backup !== "string") return;
  const old = countsOf(oldRecord);
  const known = backup === oldRecord.primary ? old.primary : backup === oldRecord.backup ? old.backup : undefined;
  if (known !== undefined) countsOf(record).backup = known;
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

function openDatabase(factory, onVersionChange = () => {}) {
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
    request.onsuccess = () => {
      const db = request.result;
      // 其他标签页要升级数据库时关闭本页连接，免得阻塞升级；之后本页的存档操作给出明确提示。
      db.onversionchange = () => {
        try { db.close(); } catch {}
        onVersionChange();
      };
      resolve(db);
    };
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

// 列表只读元数据（record.meta / record.backupMeta）。元数据缺失的记录在打开时已由 backfillMeta 解码一次补全。
function describeSlot(record, catalog, damage) {
  const current = catalog.activeId === record.id;
  const source = record.meta ? { meta: record.meta, recovered: false } : record.backupMeta ? { meta: record.backupMeta, recovered: true } : null;
  if (!source) {
    return { id: record.id, name: damage?.oldVersion ? "旧版存档（不兼容，可删除）" : "损坏的存档", savedAt: null, current, damaged: true };
  }
  const { meta } = source;
  return {
    id: record.id,
    name: meta.name,
    savedAt: meta.savedAt,
    year: meta.year,
    day: meta.day,
    population: meta.population,
    recovered: source.recovered,
    current,
    damaged: false
  };
}

async function readSlotFromRecord(record, content) {
  if (record?.primary) {
    try { return { ...await decode(record.primary, record.id, content), recovered: false }; }
    catch (error) { if (!["corrupt", "validation"].includes(error.code)) throw error; }
  }
  if (record?.backup) {
    try { return { ...await decode(record.backup, record.id, content), recovered: true }; }
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
  let dbClosedReason = null;
  try { db = await openDatabase(factory, () => { dbClosedReason = VERSION_CHANGE_MESSAGE; }); }
  catch (error) {
    const classified = safeError(error, "打开 IndexedDB");
    classified.step = "indexeddb_open";
    classified.pendingBytes = 0;
    throw classified;
  }
  // 所有事务经此入口：连接被其他标签页升级关闭后给出明确提示，而不是 InvalidStateError。
  const handle = {
    transaction(names, mode) {
      if (dbClosedReason) throw new SavePersistenceError("denied", dbClosedReason);
      return db.transaction(names, mode);
    }
  };
  let catalog = defaultCatalog();
  let slotRecords = new Map();
  // 打不开正文的存档位（旧版不兼容或损坏），只在内存里记一下原因，不写回存档。
  const damaged = new Map();
  // 持久存储申请：存档前后各一次，不等待结果、不阻塞存档，失败忽略。
  let persistAttempts = 0;
  let persistState = "unknown";
  function requestPersistence() {
    if (persistState === "granted" || persistAttempts >= 2) return;
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.persist !== "function") { persistState = "unsupported"; return; }
    persistAttempts += 1;
    Promise.resolve()
      .then(() => storage.persist())
      .then(granted => { persistState = granted ? "granted" : "denied"; }, () => { persistState = "unknown"; });
  }

  // 解码一份正文，成功则返回它的元数据；失败只说明是否为旧版不兼容。
  async function probeStored(stored, id) {
    try {
      const entry = await decode(stored, id, content);
      return { ok: true, meta: metaFromParts({ name: entry.name, savedAt: entry.savedAt, stored, summary: summarizeSaveState(entry.state, content) }) };
    } catch (error) {
      return { ok: false, oldVersion: /旧版存档/.test(error?.message || "") };
    }
  }

  // 旧存档位（没有元数据、或正文与元数据对不上）：打开时解码一次，把元数据写回。之后列表只读元数据。
  async function backfillMeta() {
    for (const record of [...slotRecords.values()]) {
      if (isKnownGood(record)) continue;
      const primary = record.primary ? await probeStored(record.primary, record.id) : { ok: false };
      const backup = !primary.ok && record.backup ? await probeStored(record.backup, record.id) : null;
      const next = {
        ...record,
        meta: primary.ok ? primary.meta : null,
        backupMeta: primary.ok ? record.backupMeta ?? null : backup?.ok ? backup.meta : null
      };
      if (!primary.ok && !backup?.ok) damaged.set(record.id, { oldVersion: Boolean(primary.oldVersion || backup?.oldVersion) });
      else damaged.delete(record.id);
      slotRecords.set(record.id, next);
      if (primary.ok || backup?.ok) {
        try { await putOne(handle, SLOT_STORE, next); }
        catch { /* 写回失败不影响读取；下次打开会再解码一次 */ }
      }
    }
  }

  function indexedStats() {
    let primaryBytes = 0;
    let backupBytes = 0;
    for (const record of slotRecords.values()) {
      primaryBytes += recordFieldBytes(record, "primary");
      backupBytes += recordFieldBytes(record, "backup");
    }
    return { primaryBytes, backupBytes, totalBytes: primaryBytes + backupBytes, slotCount: slotRecords.size };
  }

  // pendingBytes 可以是计算函数：只在出错时才统计字节数，成功路径不做 UTF-8 编码。
  // 异步：要问一下浏览器配额，附在错误提示里（不可用时只是没有这一段）。
  async function decorate(error, step, pendingBytes = 0) {
    const classified = safeError(error, "写入 IndexedDB");
    classified.step = classified.step || step;
    if (!Number.isFinite(classified.pendingBytes)) classified.pendingBytes = typeof pendingBytes === "function" ? pendingBytes() : pendingBytes;
    classified.storageUsage = { indexedDB: indexedStats(), quota: null };
    const quota = await storageEstimate();
    if (quota) {
      classified.storageUsage.quota = quota;
      if (!classified.quotaNoted) {
        classified.message += `（浏览器存储已用 ${megabytes(quota.usage)} / 配额 ${megabytes(quota.quota)}）`;
        classified.quotaNoted = true;
      }
    }
    return classified;
  }

  async function refreshCaches() {
    try {
      const [slots, metaRows] = await Promise.all([readAll(handle, SLOT_STORE), readAll(handle, META_STORE)]);
      slotRecords = new Map(slots.map(row => [row.id, row]));
      const catalogRow = metaRows.find(row => row.key === CATALOG_META_KEY);
      catalog = catalogRow?.value && typeof catalogRow.value === "object" ? { ...defaultCatalog(), ...catalogRow.value } : defaultCatalog();
      catalog.deletedIds = Array.isArray(catalog.deletedIds) ? catalog.deletedIds : [];
    } catch (error) {
      throw await decorate(error, "indexeddb_refresh", 0);
    }
    await backfillMeta();
  }

  async function writeCatalog(nextCatalog, tx = null) {
    const row = { key: CATALOG_META_KEY, value: nextCatalog };
    if (tx) tx.objectStore(META_STORE).put(row);
    else await putOne(handle, META_STORE, row);
  }

  await refreshCaches();

  // 同步、不解码：只读每个存档位的元数据。
  function list() {
    const deleted = new Set(catalog.deletedIds || []);
    const slots = [...slotRecords.values()].filter(row => !deleted.has(row.id)).map(record => describeSlot(record, catalog, damaged.get(record.id)));
    slots.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
    return { slots, activeId: catalog.activeId, warning: null };
  }

  async function read(id) {
    const record = slotRecords.get(id);
    if (!record) throw new SavePersistenceError("validation", "存档不存在。");
    return readSlotFromRecord(record, content);
  }

  async function initialize() {
    const listed = list();
    if (!catalog.activeId) return { state: null, ...listed, created: false };
    try {
      const entry = await read(catalog.activeId);
      return { state: entry.state, ...listed, warning: entry.recovered ? "当前存档损坏，已从自动备份恢复；请保存当前进度。" : listed.warning };
    } catch (error) {
      if (["quota", "denied", "program"].includes(error.code)) throw error;
      return { state: null, ...listed, warning: "当前存档无法读取，请从列表选择可用存档或备份。" };
    }
  }

  // 新存档或另存：编码、写入、读回比对。
  async function createSlot(state, name, activate = true) {
    const id = randomId(new Set(slotRecords.keys()));
    const savedAt = new Date().toISOString();
    const validName = nameOf(name);
    requestPersistence();
    const encoded = await encode(id, validName, state, savedAt, content);
    const primary = encoded.stored;
    const meta = metaFromParts({ name: validName, savedAt, stored: primary, summary: encoded.summary, format: encoded.format });
    const nextCatalog = activate ? { ...catalog, activeId: id } : catalog;
    const catalogBytes = activate ? byteLength(stringify(nextCatalog)) : 0;
    const pendingBytes = () => byteLength(primary) + catalogBytes;
    let tx;
    try {
      tx = handle.transaction([SLOT_STORE, META_STORE], "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(SLOT_STORE).put({ id, primary, backup: null, meta, backupMeta: null, createdAt: savedAt });
      if (activate) tx.objectStore(META_STORE).put({ key: CATALOG_META_KEY, value: nextCatalog });
      await done;
      const readBack = await readOne(handle, SLOT_STORE, id);
      if (!readBack || !sameStored(readBack.primary, primary)) throw new Error("新存档写入后读回校验失败");
      // 新建时多做一次完整容器校验（解压 + 校验和）：之后的存档只做字节比对。
      await inspect(readBack.primary, id);
      slotRecords.set(id, readBack);
      damaged.delete(id);
      if (activate) catalog = nextCatalog;
      requestPersistence();
      return { id, name: validName, savedAt, state, recovered: false };
    } catch (error) {
      try { tx?.abort(); } catch {}
      throw await decorate(error, "create_slot_write_verify", pendingBytes);
    }
  }

  // 决定本次存档如何轮换备份。只有旧主档确认可读（元数据指纹对得上，或现场解码通过）才把它轮为备份；
  // 仅校验和通过但解不开的主档不能覆盖仍可读的备份。正常情况下不解码旧主档。
  async function planRotation(oldRecord, id) {
    let backup = oldRecord?.backup || null;
    let backupMeta = oldRecord?.backupMeta || null;
    let name = null;
    if (oldRecord?.primary) {
      if (isKnownGood(oldRecord)) {
        backup = oldRecord.primary;
        backupMeta = oldRecord.meta;
        name = oldRecord.meta.name;
      } else {
        try {
          const entry = await decode(oldRecord.primary, id, content);
          backup = oldRecord.primary;
          backupMeta = metaFromParts({ name: entry.name, savedAt: entry.savedAt, stored: oldRecord.primary, summary: summarizeSaveState(entry.state, content) });
          name = entry.name;
        } catch {
          // 旧主档解不开：不轮转，备份保持原样；名称只为取名字，校验和通过即可。
          try { name = (await inspect(oldRecord.primary, id)).name; } catch {}
        }
      }
    }
    if (!name && oldRecord?.backup) {
      try { name = (await inspect(oldRecord.backup, id)).name; } catch {}
    }
    if (!name) throw new SavePersistenceError("corrupt", "存档损坏，且自动备份无法读取。原数据仍保留。");
    return { backup, backupMeta, name };
  }

  async function saveCurrent(state, expectedId) {
    const id = catalog.activeId;
    if (!id || id !== expectedId) throw new SavePersistenceError("validation", "当前没有可保存的存档，请先选择一局。");
    const oldRecord = slotRecords.get(id);
    requestPersistence();
    const plan = await planRotation(oldRecord, id);
    const savedAt = new Date().toISOString();
    const encoded = await encode(id, plan.name, state, savedAt, content);
    const primary = encoded.stored;
    const backup = plan.backup;
    const meta = metaFromParts({ name: plan.name, savedAt, stored: primary, summary: encoded.summary, format: encoded.format });
    const record = { ...oldRecord, id, primary, backup, meta, backupMeta: plan.backupMeta, updatedAt: savedAt };
    try {
      await putOne(handle, SLOT_STORE, record);
      const readBack = await readOne(handle, SLOT_STORE, id);
      // 回读校验：主档与备份都与刚写入的字节逐一比对，能发现截断与任意字节改动。
      if (!readBack || !sameStored(readBack.primary, primary) || !sameStored(readBack.backup, backup)) throw new Error("存档写入后读回校验失败");
      seedBackupBytes(record, oldRecord, backup);
      slotRecords.set(id, record);
      damaged.delete(id);
      requestPersistence();
      return { id, name: plan.name, savedAt, state, recovered: false };
    } catch (error) {
      throw await decorate(error, "save_current_write_verify", () => byteLength(primary) + byteLength(backup || ""));
    }
  }

  async function activate(id) {
    if ((catalog.deletedIds || []).includes(id)) throw new SavePersistenceError("validation", "该存档已删除。");
    const entry = await read(id);
    const nextCatalog = { ...catalog, activeId: id };
    try {
      await writeCatalog(nextCatalog);
      const readBack = await readOne(handle, META_STORE, CATALOG_META_KEY);
      if (!readBack || readBack.value?.activeId !== id) throw new Error("激活存档目录读回校验失败");
      catalog = nextCatalog;
      return entry;
    } catch (error) {
      throw await decorate(error, "activate_catalog_write_verify", byteLength(stringify(nextCatalog)));
    }
  }

  async function rename(id, newName) {
    const oldRecord = slotRecords.get(id);
    const entry = await read(id);
    const name = nameOf(newName);
    const encoded = await encode(id, name, entry.state, entry.savedAt, content);
    const primary = encoded.stored;
    const meta = metaFromParts({ name, savedAt: entry.savedAt, stored: primary, summary: encoded.summary, format: encoded.format });
    const backupMeta = oldRecord?.backupMeta ? { ...oldRecord.backupMeta, name } : null;
    const record = { ...oldRecord, primary, meta, backupMeta };
    try {
      await putOne(handle, SLOT_STORE, record);
      const readBack = await readOne(handle, SLOT_STORE, id);
      if (!readBack || !sameStored(readBack.primary, primary)) throw new Error("重命名写入后读回校验失败");
      slotRecords.set(id, readBack);
      damaged.delete(id);
      return { id, name, savedAt: entry.savedAt, state: entry.state, recovered: false };
    } catch (error) {
      throw await decorate(error, "rename_slot_write_verify", byteLength(primary));
    }
  }

  async function remove(id) {
    if (!slotRecords.has(id) || (catalog.deletedIds || []).includes(id)) throw new SavePersistenceError("validation", "存档不存在。");
    const current = catalog.activeId === id;
    const nextCatalog = { ...catalog, activeId: current ? null : catalog.activeId, deletedIds: [...new Set([...(catalog.deletedIds || []), id])] };
    try {
      const tx = handle.transaction([SLOT_STORE, META_STORE], "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(META_STORE).put({ key: CATALOG_META_KEY, value: nextCatalog });
      tx.objectStore(SLOT_STORE).delete(id);
      await done;
      const readBack = await readOne(handle, SLOT_STORE, id);
      if (readBack !== undefined) throw new Error("删除存档后读回仍存在");
      slotRecords.delete(id);
      damaged.delete(id);
      catalog = nextCatalog;
      return { current };
    } catch (error) {
      throw await decorate(error, "delete_slot_write_verify", byteLength(stringify(nextCatalog)));
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
      await putOne(handle, META_STORE, { key, value });
      const readBack = await readOne(handle, META_STORE, key);
      if (!readBack || stringify(readBack.value) !== stringify(value)) throw new Error("IndexedDB 探测写入后读回不一致");
      const tx = handle.transaction(META_STORE, "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(META_STORE).delete(key);
      await done;
      const deleted = await readOne(handle, META_STORE, key);
      if (deleted !== undefined) throw new Error("IndexedDB 探测键删除失败");
      return { ok: true };
    } catch (error) {
      try {
        const tx = handle.transaction(META_STORE, "readwrite");
        const done = transactionDone(tx);
        tx.objectStore(META_STORE).delete(key);
        await done;
      } catch {}
      throw await decorate(error, "indexeddb_probe_write_read_delete", pendingBytes);
    }
  }

  function storageStats() {
    return { indexedDB: indexedStats(), persist: persistState };
  }

  return {
    backend: "indexedDB",
    initialize,
    list,
    read,
    // 界面"新游戏"用标准开局（伐木场、盐场、码头开局即建好）；空白开局只给引擎与脚本。
    createNew: name => createSlot(createInitialState({ content, opening: "standard" }), name),
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
