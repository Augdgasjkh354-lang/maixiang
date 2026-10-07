import { CONTENT } from "../content/index.js";
import { createInitialState } from "../core/state.js";
import { validateState } from "../core/validation.js";
import { SAVE_KEY, parseSaveFile, parseSaveObject } from "./storage.js";

export const SAVE_CONTAINER_VERSION = 2;
export const SAVE_CATALOG_VERSION = 1;
export const SAVE_CATALOG_KEY = "maixiang-save-catalog-v1";
export const SAVE_SLOT_PREFIX = "maixiang-save-slot-v1:";
const MAX_NAME_LENGTH = 36;

export class SavePersistenceError extends Error {
  constructor(code, message, original = null) {
    super(message, original ? { cause: original } : undefined);
    this.name = "SavePersistenceError";
    this.code = code;
    this.originalName = original?.name || null;
    this.originalMessage = original?.message || null;
  }
}

export function classifyPersistenceError(error, action = "访问") {
  if (error instanceof SavePersistenceError) return error;
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || /quota|storage.*full/i.test(message)) {
    return new SavePersistenceError("quota", `本机空间不足（存储配额已满），${action}未完成。`, error);
  }
  if (["SecurityError", "NotAllowedError", "InvalidStateError", "NotSupportedError"].includes(name) || /denied|permission|access/i.test(message)) {
    return new SavePersistenceError("denied", `浏览器拒绝本机存储访问，${action}未完成。`, error);
  }
  return new SavePersistenceError("program", `本机存储${action}失败。`, error);
}

function slotKey(id) { return SAVE_SLOT_PREFIX + id; }
function backupKey(id) { return slotKey(id) + ":backup"; }
export function checksumSaveText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
function get(storage, key) {
  try { return storage.getItem(key); }
  catch (error) { throw classifyPersistenceError(error, "读取"); }
}
function put(storage, key, value) {
  try { storage.setItem(key, value); }
  catch (error) { throw classifyPersistenceError(error, "写入"); }
}
function drop(storage, key) {
  try { storage.removeItem(key); return true; }
  catch (error) { throw classifyPersistenceError(error, "清理"); }
}
function storageLength(storage) {
  try { return storage.length; }
  catch (error) { throw classifyPersistenceError(error, "读取"); }
}
function storageKey(storage, index) {
  try { return storage.key(index); }
  catch (error) { throw classifyPersistenceError(error, "读取"); }
}
export function stringifySaveJson(value, label = "存档") {
  try { return JSON.stringify(value); }
  catch (error) { throw new SavePersistenceError("serialization", `${label}序列化失败，未写入本机存储。`, error); }
}
function catalogValue(activeId = null, deletedIds = []) {
  return { containerVersion: SAVE_CATALOG_VERSION, activeId, deletedIds };
}
function readCatalog(storage) {
  const raw = get(storage, SAVE_CATALOG_KEY);
  if (raw === null) return { value: catalogValue(), missing: true };
  try {
    const value = JSON.parse(raw);
    if (value.containerVersion !== SAVE_CATALOG_VERSION ||
      (value.activeId !== null && typeof value.activeId !== "string") ||
      !Array.isArray(value.deletedIds) || !value.deletedIds.every(id => typeof id === "string")) {
      throw new Error("unsupported");
    }
    return { value, missing: false };
  } catch {
    return { value: catalogValue(), damaged: true };
  }
}
function writeCatalog(storage, value) { put(storage, SAVE_CATALOG_KEY, stringifySaveJson(value, "存档目录")); }
function idsInStorage(storage) {
  const ids = new Set();
  const length = storageLength(storage);
  for (let i = 0; i < length; i += 1) {
    const key = storageKey(storage, i);
    if (key?.startsWith(SAVE_SLOT_PREFIX)) {
      const id = key.slice(SAVE_SLOT_PREFIX.length).replace(/:backup$/, "");
      if (id && !id.includes(":")) ids.add(id);
    }
  }
  return [...ids];
}
function newId(storage) {
  let id;
  do {
    id = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  } while (get(storage, slotKey(id)) !== null || get(storage, backupKey(id)) !== null);
  return id;
}
function nameOf(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new SavePersistenceError("validation", "请输入存档名称。");
  if (name.length > MAX_NAME_LENGTH) throw new SavePersistenceError("validation", `名称最多${MAX_NAME_LENGTH}字。`);
  return name;
}
function validState(state, content) {
  const result = validateState(state, content);
  if (!result.valid) {
    const error = new SavePersistenceError("validation", "游戏数据校验失败，原存档未更改。");
    error.validationErrors = result.errors.slice();
    throw error;
  }
}
export function encodeSaveContainer(id, name, state, savedAt, content) {
  validState(state, content);
  const stateText = stringifySaveJson(state, "游戏数据");
  const header = stringifySaveJson({
    containerVersion: SAVE_CONTAINER_VERSION, id, name, savedAt, checksum: checksumSaveText(stateText)
  }, "存档容器");
  // state 必须保持为最后一个字段：这样校验可直接复用本次持久化的原始 JSON 文本，
  // 不必再次 stringify 整个游戏状态。
  return header.slice(0, -1) + ',"state":' + stateText + '}';
}

function validateContainerMetadata(entry, id) {
  return entry && [1, SAVE_CONTAINER_VERSION].includes(entry.containerVersion) && entry.id === id &&
    typeof entry.name === "string" && entry.name.trim() &&
    typeof entry.savedAt === "string" && Number.isFinite(Date.parse(entry.savedAt)) &&
    typeof entry.checksum === "string";
}

function stateTextFromV2Container(raw, entry) {
  const header = stringifySaveJson({
    containerVersion: entry.containerVersion, id: entry.id, name: entry.name, savedAt: entry.savedAt, checksum: entry.checksum
  }, "存档容器头");
  const prefix = header.slice(0, -1) + ',"state":';
  if (!raw.startsWith(prefix) || !raw.endsWith('}')) return null;
  return raw.slice(prefix.length, -1);
}

function verifySaveContainerRaw(raw, id) {
  let entry;
  try { entry = JSON.parse(raw); }
  catch { throw new SavePersistenceError("corrupt", "存档内容损坏。"); }
  if (!validateContainerMetadata(entry, id)) throw new SavePersistenceError("corrupt", "存档内容损坏。");
  if (entry.containerVersion === SAVE_CONTAINER_VERSION) {
    const stateText = stateTextFromV2Container(raw, entry);
    if (stateText === null || entry.checksum !== checksumSaveText(stateText)) {
      throw new SavePersistenceError("corrupt", "存档内容损坏。");
    }
  } else {
    // v1 容器没有可直接复用的 state 文本，只在兼容读取时做一次旧式校验。
    const stateText = stringifySaveJson(entry.state, "旧存档校验");
    if (entry.checksum !== checksumSaveText(stateText)) throw new SavePersistenceError("corrupt", "存档内容损坏。");
  }
  return entry;
}

export function inspectSaveContainer(raw, id) {
  const entry = verifySaveContainerRaw(raw, id);
  return { id, name: entry.name, savedAt: entry.savedAt, containerVersion: entry.containerVersion };
}

export function decodeSaveContainer(raw, id, content) {
  const entry = verifySaveContainerRaw(raw, id);
  let state;
  try { state = parseSaveObject(entry.state, content); }
  catch (error) {
    if (error instanceof SavePersistenceError) throw error;
    const wrapped = new SavePersistenceError("validation", error.message || "存档数据校验失败。", error);
    throw wrapped;
  }
  return { id, name: entry.name, savedAt: entry.savedAt, state };
}

function readSlot(storage, id, content) {
  const primary = get(storage, slotKey(id));
  if (primary !== null) {
    try { return { ...decodeSaveContainer(primary, id, content), recovered: false }; }
    catch (error) { if (error.code !== "corrupt" && error.code !== "validation") throw error; }
  }
  const backup = get(storage, backupKey(id));
  if (backup !== null) {
    try { return { ...decodeSaveContainer(backup, id, content), recovered: true }; }
    catch (error) { if (error.code !== "corrupt" && error.code !== "validation") throw error; }
  }
  throw new SavePersistenceError("corrupt", "存档损坏，且自动备份无法读取。原文件仍保留。");
}
function writeSlot(storage, id, name, state, content, savedAt = new Date().toISOString()) {
  const next = encodeSaveContainer(id, name, state, savedAt, content);
  const primaryKey = slotKey(id);
  const previous = get(storage, primaryKey);

  // A brand-new slot has no useful previous version. Writing the same bytes to :backup first
  // doubled first-save space and could strand an orphan backup when the primary write failed.
  if (previous !== null) {
    try {
      inspectSaveContainer(previous, id);
      const currentBackup = get(storage, backupKey(id));
      if (currentBackup !== previous) put(storage, backupKey(id), previous);
    } catch (error) {
      if (error.code !== "corrupt" && error.code !== "validation") throw error;
      // Preserve any existing readable backup; do not overwrite it with a corrupt primary.
    }
  }
  put(storage, primaryKey, next);
  return { id, name, savedAt, state, recovered: false };
}

export function createSaveManager(storage, content = CONTENT) {
  if (!storage) throw new SavePersistenceError("denied", "浏览器未提供可用的本机存储。请使用临时游玩或调整浏览器站点存储权限。");
  function catalog() { return readCatalog(storage).value; }
  function list() {
    const known = readCatalog(storage);
    const deleted = new Set(known.value.deletedIds);
    const slots = idsInStorage(storage).filter(id => !deleted.has(id)).map(id => {
      try {
        const entry = readSlot(storage, id, content);
        return { id, name: entry.name, savedAt: entry.savedAt, year: entry.state.year,
          day: entry.state.day + 1, population: (entry.state.cohorts || []).reduce((sum, group) => sum + group.m + group.f, 0),
          recovered: entry.recovered, current: known.value.activeId === id, damaged: false };
      } catch (error) {
        if (["quota", "denied", "program", "serialization"].includes(error.code)) throw error;
        return { id, name: "损坏的存档", savedAt: null, current: known.value.activeId === id, damaged: true };
      }
    });
    slots.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
    return { slots, activeId: known.value.activeId,
      warning: known.damaged ? "存档目录损坏；可读取的存档仍在，请手动选择。"
        : known.missing && slots.length ? "已找到存档，请选择要读取的一局。" : null };
  }
  function createSlot(state, name, activate = true) {
    const id = newId(storage);
    let wroteSlot = false;
    try {
      const result = writeSlot(storage, id, nameOf(name), state, content);
      wroteSlot = true;
      if (activate) {
        const previous = catalog();
        writeCatalog(storage, { ...previous, activeId: id });
      }
      return result;
    } catch (error) {
      // New slot creation is transactional from the catalog's point of view. A failed create
      // never leaves a new index entry and best-effort removes any just-written slot bytes.
      if (wroteSlot) {
        try { drop(storage, slotKey(id)); } catch {}
        try { drop(storage, backupKey(id)); } catch {}
      }
      throw error;
    }
  }
  function initialize() {
    const known = readCatalog(storage);
    const existing = list();
    if (known.value.activeId) {
      try {
        const entry = readSlot(storage, known.value.activeId, content);
        return { state: entry.state, ...existing,
          warning: entry.recovered ? "当前存档损坏，已从自动备份恢复；请保存当前进度。" : existing.warning };
      }
      catch (error) {
        if (["quota", "denied", "program"].includes(error.code)) throw error;
        return { state: null, ...existing, warning: "当前存档无法读取，请从列表选择可用存档或备份。" };
      }
    }
    if (!known.missing || existing.slots.length) return { state: null, ...existing };
    const raw = get(storage, SAVE_KEY);
    if (raw !== null) {
      let state;
      try { state = parseSaveFile(raw, content); }
      catch (error) { return { state: null, ...existing, warning: `原有存档无法接入：${error.message} 原数据仍保留。` }; }
      const entry = createSlot(state, "原有进度");
      return { state, ...list(), migrated: true, entry };
    }
    // 空存储只展示“新游戏”入口；真正初始化与首次持久化必须由玩家确认新游戏后完成。
    // 这样存储受限不会在页面启动阶段阻断恢复入口，也避免生成玩家从未进入的半成品新局。
    return { state: null, ...existing, created: false };
  }
  function saveCurrent(state, expectedId) {
    const id = catalog().activeId;
    if (!id || id !== expectedId) throw new SavePersistenceError("validation", "当前没有可保存的存档，请先选择一局。");
    const old = readSlot(storage, id, content);
    return writeSlot(storage, id, old.name, state, content);
  }
  function activate(id) {
    const known = catalog();
    if (known.deletedIds.includes(id)) throw new SavePersistenceError("validation", "该存档已删除。");
    const entry = readSlot(storage, id, content);
    writeCatalog(storage, { ...known, activeId: id });
    return entry;
  }
  function rename(id, newName) {
    const entry = readSlot(storage, id, content);
    return writeSlot(storage, id, nameOf(newName), entry.state, content, entry.savedAt);
  }
  function remove(id) {
    const known = catalog();
    if (!idsInStorage(storage).includes(id) || known.deletedIds.includes(id)) throw new SavePersistenceError("validation", "存档不存在。");
    const current = known.activeId === id;
    writeCatalog(storage, { ...known, activeId: current ? null : known.activeId,
      deletedIds: [...known.deletedIds, id] });
    try { drop(storage, slotKey(id)); drop(storage, backupKey(id)); } catch { /* tombstone hides retained bytes */ }
    return { current };
  }
  function importFile(text, name) {
    const state = parseSaveFile(text, content);
    const defaultName = `导入存档 ${list().slots.length + 1}`;
    return createSlot(state, name || defaultName, false);
  }
  function storageStats() {
    let primaryBytes = 0;
    let backupBytes = 0;
    let legacyBytes = 0;
    let catalogBytes = 0;
    let slotCount = 0;
    let backupCount = 0;
    const length = storageLength(storage);
    for (let i = 0; i < length; i += 1) {
      const key = storageKey(storage, i);
      if (!key) continue;
      const value = get(storage, key) || "";
      const bytes = (key.length + value.length) * 2;
      if (key === SAVE_KEY) legacyBytes += bytes;
      else if (key === SAVE_CATALOG_KEY) catalogBytes += bytes;
      else if (key.startsWith(SAVE_SLOT_PREFIX) && key.endsWith(":backup")) { backupBytes += bytes; backupCount += 1; }
      else if (key.startsWith(SAVE_SLOT_PREFIX)) { primaryBytes += bytes; slotCount += 1; }
    }
    return { primaryBytes, backupBytes, legacyBytes, catalogBytes, totalBytes: primaryBytes + backupBytes + legacyBytes + catalogBytes, slotCount, backupCount };
  }
  return { initialize, list, createNew: name => createSlot(createInitialState({ content }), name),
    createTransient: name => ({ id: null, name: name || "临时游戏", savedAt: null, state: createInitialState({ content }), transient: true }),
    saveCurrent, saveAs: (state, name) => createSlot(state, name), activate, rename, remove, importFile,
    read: id => readSlot(storage, id, content), storageStats };
}
