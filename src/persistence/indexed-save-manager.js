import { CONTENT } from "../content/index.js";
import { createInitialState } from "../core/state.js";
import { SAVE_KEY, parseSaveFile } from "./storage.js";
import {
  SAVE_CATALOG_KEY,
  SAVE_CATALOG_VERSION,
  SAVE_SLOT_PREFIX,
  SavePersistenceError,
  checksumSaveText as checksum,
  classifyPersistenceError,
  decodeSaveContainer as decode,
  encodeSaveContainer as encode,
  inspectSaveContainer as inspect,
  stringifySaveJson as stringify
} from "./save-manager.js";

export const SAVE_DB_NAME = "maixiang-save-db-v2";
export const SAVE_DB_VERSION = 1;
const SLOT_STORE = "slots";
const META_STORE = "meta";
const LEGACY_STORE = "legacy";
const CATALOG_META_KEY = "catalog";
const MIGRATION_META_KEY = "legacyMigration";
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

function safeLocalGet(storage, key) {
  if (!storage) return null;
  try { return storage.getItem(key); }
  catch (error) { throw classifyPersistenceError(error, "读取遗留 localStorage"); }
}

function safeLocalRemove(storage, key) {
  if (!storage) return;
  try { storage.removeItem(key); }
  catch (error) { throw classifyPersistenceError(error, "清理遗留 localStorage"); }
}

function localKeys(storage) {
  if (!storage) return [];
  try {
    return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(Boolean);
  } catch (error) {
    throw classifyPersistenceError(error, "扫描遗留 localStorage");
  }
}

function legacyKind(key) {
  if (key === SAVE_KEY) return { kind: "legacy-single", label: "旧单存档" };
  if (key.startsWith(SAVE_KEY + ".backup-")) return { kind: "legacy-history", label: "旧单存档历史备份" };
  if (key === SAVE_CATALOG_KEY) return { kind: "r01-catalog", label: "0.1.5-r01 存档目录" };
  if (key.startsWith(SAVE_SLOT_PREFIX) && key.endsWith(":backup")) return { kind: "r01-backup", label: "0.1.5-r01 自动备份" };
  if (key.startsWith(SAVE_SLOT_PREFIX)) return { kind: "r01-primary", label: "0.1.5-r01 主存档" };
  return null;
}

export function scanLegacyLocalStorage(storage) {
  const artifacts = [];
  const stats = { mainBytes: 0, slotPrimaryBytes: 0, oldSingleBytes: 0, backupBytes: 0, catalogBytes: 0, totalBytes: 0, count: 0 };
  for (const key of localKeys(storage)) {
    const info = legacyKind(key);
    if (!info) continue;
    const raw = safeLocalGet(storage, key) ?? "";
    const bytes = byteLength(key) + byteLength(raw);
    const artifact = { key, raw, bytes, checksum: checksum(raw), ...info };
    artifacts.push(artifact);
    stats.count += 1;
    stats.totalBytes += bytes;
    if (info.kind === "r01-catalog") stats.catalogBytes += bytes;
    else if (info.kind.includes("backup") || info.kind === "legacy-history") stats.backupBytes += bytes;
    else if (info.kind === "legacy-single") { stats.oldSingleBytes += bytes; stats.mainBytes += bytes; }
    else { stats.slotPrimaryBytes += bytes; stats.mainBytes += bytes; }
  }
  return { artifacts, stats };
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
      if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE, { keyPath: "key" });
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

function parseLegacyCatalog(raw) {
  try {
    const value = JSON.parse(raw);
    if (value?.containerVersion !== SAVE_CATALOG_VERSION || (value.activeId !== null && typeof value.activeId !== "string")) return null;
    return { ...defaultCatalog(), ...value, deletedIds: Array.isArray(value.deletedIds) ? value.deletedIds.filter(id => typeof id === "string") : [] };
  } catch { return null; }
}

function slotIdFromLegacyKey(key) {
  if (!key.startsWith(SAVE_SLOT_PREFIX)) return null;
  return key.slice(SAVE_SLOT_PREFIX.length).replace(/:backup$/, "");
}

function legacyPlayable(raw, content) {
  try { return { state: parseSaveFile(raw, content), readable: true }; }
  catch (error) { return { state: null, readable: false, reason: error.message }; }
}

function describeSlot(record, catalog, content) {
  let entry = null;
  let recovered = false;
  if (record?.primary) {
    try { entry = decode(record.primary, record.id, content); }
    catch (error) { if (!["corrupt", "validation"].includes(error.code)) throw error; }
  }
  if (!entry && record?.backup) {
    try { entry = decode(record.backup, record.id, content); recovered = true; }
    catch (error) { if (!["corrupt", "validation"].includes(error.code)) throw error; }
  }
  if (!entry) return { id: record.id, name: "损坏的存档", savedAt: null, current: catalog.activeId === record.id, damaged: true };
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

export async function probeLocalStorageWrite(storage) {
  if (!storage) return { ok: false, code: "unavailable", message: "localStorage 不可用。" };
  const key = `maixiang-storage-probe-v2:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const value = "mx-probe";
  try {
    storage.setItem(key, value);
    const read = storage.getItem(key);
    if (read !== value) throw new Error("localStorage 写入后读回不一致");
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new Error("localStorage 探测键删除失败");
    return { ok: true };
  } catch (error) {
    try { storage.removeItem(key); } catch {}
    const classified = classifyPersistenceError(error, "localStorage 写入探测");
    return { ok: false, code: classified.code, message: classified.message, originalName: classified.originalName, originalMessage: classified.originalMessage };
  }
}

export async function createIndexedSaveManager({ indexedDB: factory = globalThis.indexedDB, legacyStorage = null, content = CONTENT } = {}) {
  let db;
  try { db = await openDatabase(factory); }
  catch (error) {
    const classified = safeError(error, "打开 IndexedDB");
    classified.step = "indexeddb_open";
    classified.pendingBytes = 0;
    try { classified.storageUsage = { indexedDB: null, localStorage: scanLegacyLocalStorage(legacyStorage).stats }; } catch {}
    throw classified;
  }
  let catalog = defaultCatalog();
  let slotRecords = new Map();
  let legacyRecords = new Map();

  function localStats() {
    try { return scanLegacyLocalStorage(legacyStorage).stats; }
    catch { return { mainBytes: 0, slotPrimaryBytes: 0, oldSingleBytes: 0, backupBytes: 0, catalogBytes: 0, totalBytes: 0, count: 0, unavailable: true }; }
  }

  function indexedStats() {
    let primaryBytes = 0;
    let backupBytes = 0;
    for (const record of slotRecords.values()) {
      primaryBytes += byteLength(record.primary || "");
      backupBytes += byteLength(record.backup || "");
    }
    let archiveBytes = 0;
    for (const record of legacyRecords.values()) archiveBytes += byteLength(record.raw || "");
    return { primaryBytes, backupBytes, archiveBytes, totalBytes: primaryBytes + backupBytes + archiveBytes, slotCount: slotRecords.size, archiveCount: legacyRecords.size };
  }

  function decorate(error, step, pendingBytes = 0) {
    const classified = safeError(error, "写入 IndexedDB");
    classified.step = classified.step || step;
    classified.pendingBytes = Number.isFinite(classified.pendingBytes) ? classified.pendingBytes : pendingBytes;
    classified.storageUsage = { indexedDB: indexedStats(), localStorage: localStats() };
    return classified;
  }

  async function refreshCaches() {
    try {
      const [slots, metaRows, legacy] = await Promise.all([
        readAll(db, SLOT_STORE), readAll(db, META_STORE), readAll(db, LEGACY_STORE)
      ]);
      slotRecords = new Map(slots.map(row => [row.id, row]));
      legacyRecords = new Map(legacy.map(row => [row.key, row]));
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

  async function archiveLegacyArtifacts(artifacts) {
    for (const artifact of artifacts) {
      const current = legacyRecords.get(artifact.key);
      if (current?.checksum === artifact.checksum && current?.raw === artifact.raw && current?.verified) continue;
      const row = {
        key: artifact.key,
        raw: artifact.raw,
        bytes: artifact.bytes,
        checksum: artifact.checksum,
        kind: artifact.kind,
        label: artifact.label,
        archivedAt: new Date().toISOString(),
        verified: false
      };
      try {
        await putOne(db, LEGACY_STORE, row);
        const readBack = await readOne(db, LEGACY_STORE, artifact.key);
        if (!readBack || readBack.raw !== artifact.raw || readBack.checksum !== artifact.checksum) {
          throw new Error("IndexedDB 遗留数据读回校验不一致");
        }
        readBack.verified = true;
        await putOne(db, LEGACY_STORE, readBack);
        legacyRecords.set(artifact.key, readBack);
      } catch (error) {
        throw decorate(error, "legacy_archive_verify", artifact.bytes);
      }
    }
  }

  async function migrateLegacyArtifacts() {
    let scan;
    try { scan = scanLegacyLocalStorage(legacyStorage); }
    catch (error) {
      // localStorage 可能被拒，但 IndexedDB 仍可作为新持久层使用。
      return { warning: `无法扫描遗留 localStorage：${error.message}`, migratedCount: 0 };
    }
    if (!scan.artifacts.length) return { warning: null, migratedCount: 0 };

    await archiveLegacyArtifacts(scan.artifacts);

    const byKey = new Map(scan.artifacts.map(row => [row.key, row]));
    const existingBefore = slotRecords.size;
    let migratedCount = 0;
    let legacyCatalog = null;
    const catalogArtifact = byKey.get(SAVE_CATALOG_KEY);
    if (catalogArtifact) legacyCatalog = parseLegacyCatalog(catalogArtifact.raw);

    // r01 多存档：主档和轮换备份原样搬入同一个 IndexedDB 记录。
    const r01Ids = new Set(scan.artifacts.map(row => slotIdFromLegacyKey(row.key)).filter(Boolean));
    for (const id of r01Ids) {
      if (slotRecords.has(id)) continue;
      const primary = byKey.get(SAVE_SLOT_PREFIX + id)?.raw ?? null;
      const backup = byKey.get(SAVE_SLOT_PREFIX + id + ":backup")?.raw ?? null;
      let readable = false;
      if (primary) { try { decode(primary, id, content); readable = true; } catch {} }
      if (!readable && backup) { try { decode(backup, id, content); readable = true; } catch {} }
      if (!readable) continue;
      const record = { id, primary, backup, migratedFrom: "localStorage-r01", migratedAt: new Date().toISOString() };
      try {
        await putOne(db, SLOT_STORE, record);
        const readBack = await readOne(db, SLOT_STORE, id);
        if (!readBack || readBack.primary !== primary || readBack.backup !== backup) throw new Error("r01 存档迁移读回校验失败");
        slotRecords.set(id, readBack);
        migratedCount += 1;
      } catch (error) {
        throw decorate(error, "legacy_r01_slot_verify", byteLength(primary || "") + byteLength(backup || ""));
      }
    }

    // 更早的单存档及历史备份：迁移为独立 IndexedDB 存档，原 localStorage 字节继续保留，等待玩家确认清理。
    const directArtifacts = scan.artifacts.filter(row => row.kind === "legacy-single" || row.kind === "legacy-history");
    for (const artifact of directArtifacts) {
      const parsed = legacyPlayable(artifact.raw, content);
      const archived = legacyRecords.get(artifact.key);
      if (archived) {
        archived.readable = parsed.readable;
        archived.readError = parsed.reason || null;
        legacyRecords.set(artifact.key, archived);
        try { await putOne(db, LEGACY_STORE, archived); } catch (error) { throw decorate(error, "legacy_archive_metadata", artifact.bytes); }
      }
      if (!parsed.readable) continue;
      const prefix = artifact.kind === "legacy-single" ? "legacy-single" : "legacy-history";
      const id = `${prefix}-${artifact.checksum}`;
      if (slotRecords.has(id)) continue;
      const name = artifact.kind === "legacy-single" ? "迁移：旧单存档" : `迁移：历史备份 ${artifact.key.slice(-12)}`;
      const savedAt = new Date().toISOString();
      const primary = encode(id, name, parsed.state, savedAt, content);
      const record = { id, primary, backup: null, migratedFrom: artifact.key, migratedAt: savedAt };
      try {
        await putOne(db, SLOT_STORE, record);
        const readBack = await readOne(db, SLOT_STORE, id);
        if (!readBack || readBack.primary !== primary) throw new Error("旧单存档迁移读回校验失败");
        decode(readBack.primary, id, content);
        slotRecords.set(id, readBack);
        migratedCount += 1;
      } catch (error) {
        throw decorate(error, "legacy_single_slot_verify", byteLength(primary));
      }
    }

    let nextCatalog = { ...catalog, deletedIds: [...new Set(catalog.deletedIds || [])] };
    if (!nextCatalog.activeId) {
      if (legacyCatalog?.activeId && slotRecords.has(legacyCatalog.activeId)) nextCatalog.activeId = legacyCatalog.activeId;
      else if (existingBefore === 0) {
        const migratedSingle = [...slotRecords.values()].find(row => row.migratedFrom === SAVE_KEY);
        if (migratedSingle) nextCatalog.activeId = migratedSingle.id;
      }
    }
    try {
      await writeCatalog(nextCatalog);
      const readBack = await readOne(db, META_STORE, CATALOG_META_KEY);
      if (!readBack || stringify(readBack.value) !== stringify(nextCatalog)) throw new Error("迁移目录读回校验失败");
      catalog = nextCatalog;
      const fingerprints = scan.artifacts.map(row => ({ key: row.key, checksum: row.checksum, bytes: row.bytes }));
      await putOne(db, META_STORE, { key: MIGRATION_META_KEY, value: { verifiedAt: new Date().toISOString(), fingerprints } });
    } catch (error) {
      throw decorate(error, "legacy_migration_mark", byteLength(stringify(nextCatalog)));
    }
    return { warning: null, migratedCount };
  }

  await refreshCaches();
  let migration = { warning: null, migratedCount: 0, failed: false };
  try {
    migration = { ...(await migrateLegacyArtifacts()), failed: false };
  } catch (error) {
    const issue = error?.code ? error : safeError(error, "迁移遗留存档");
    migration = {
      warning: `遗留 localStorage 迁移未完成：${issue.message} 原数据仍保留；现有 IndexedDB 存档仍可读取。可稍后再次打开页面重试迁移。`,
      migratedCount: 0,
      failed: true,
      issue
    };
  }
  // 迁移可能在失败前已完成部分独立写入；重新读取缓存，但迁移故障本身不阻断管理器。
  await refreshCaches();

  function list() {
    const deleted = new Set(catalog.deletedIds || []);
    const slots = [...slotRecords.values()].filter(row => !deleted.has(row.id)).map(record => describeSlot(record, catalog, content));
    slots.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
    return { slots, activeId: catalog.activeId, warning: migration.warning };
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
      return { ok: true, localStorage: await probeLocalStorageWrite(legacyStorage) };
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

  function legacyArtifacts() {
    let current = new Map();
    try { current = new Map(scanLegacyLocalStorage(legacyStorage).artifacts.map(row => [row.key, row])); } catch {}
    return [...legacyRecords.values()].map(row => ({
      key: row.key,
      kind: row.kind,
      label: row.label,
      bytes: row.bytes,
      checksum: row.checksum,
      verified: Boolean(row.verified),
      readable: row.readable !== false,
      readError: row.readError || null,
      stillInLocalStorage: current.get(row.key)?.checksum === row.checksum
    })).sort((a, b) => a.label.localeCompare(b.label, "zh-CN") || a.key.localeCompare(b.key));
  }

  function exportLegacy(key) {
    const row = legacyRecords.get(key);
    if (!row?.verified) throw new SavePersistenceError("validation", "该遗留数据尚未完成 IndexedDB 读回校验，不能清理或替代原数据。");
    return row.raw;
  }

  async function removeLegacy(key) {
    const row = legacyRecords.get(key);
    if (!row?.verified) throw new SavePersistenceError("validation", "该遗留数据尚未完成迁移校验，不能清理。");
    const current = safeLocalGet(legacyStorage, key);
    if (current === null) return { removed: false, alreadyMissing: true };
    if (checksum(current) !== row.checksum || current !== row.raw) throw new SavePersistenceError("validation", "遗留数据已发生变化，未清理；请先重新载入并再次迁移校验。");
    safeLocalRemove(legacyStorage, key);
    if (safeLocalGet(legacyStorage, key) !== null) throw new SavePersistenceError("program", "遗留数据清理后仍可读，未确认删除成功。");
    return { removed: true };
  }

  function storageStats() {
    return { indexedDB: indexedStats(), localStorage: localStats() };
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
    legacyArtifacts,
    exportLegacy,
    removeLegacy,
    storageStats,
    close: () => db.close()
  };
}
