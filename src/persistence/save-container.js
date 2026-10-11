// 存档容器：IndexedDB 每个存档位存一段带校验和的 JSON 文本（头信息 + state）。
import { validateState } from "../core/validation.js";
import { parseSaveObject } from "./storage.js";
import { gunzipToText, gzipSupported, gzipText, isGzipBytes } from "./compression.js";

// 写入版本：支持 CompressionStream 时写 v3（容器文本整体 gzip，IndexedDB 存字节）；否则写 v2（明文容器文本）。
// 两者的文本布局相同（头信息在前、"state" 在最后），读取时都接受，所以 v2 旧档照常可读。
export const SAVE_CONTAINER_VERSION = 3;
export const SAVE_CONTAINER_TEXT_VERSION = 2;
const READABLE_CONTAINER_VERSIONS = [2, 3];
export const SAVE_CATALOG_VERSION = 1;

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

export function checksumSaveText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
export function stringifySaveJson(value, label = "存档") {
  try { return JSON.stringify(value); }
  catch (error) { throw new SavePersistenceError("serialization", `${label}序列化失败，未写入本机存储。`, error); }
}
function validState(state, content) {
  const result = validateState(state, content);
  if (!result.valid) {
    const error = new SavePersistenceError("validation", "游戏数据校验失败，原存档未更改。");
    error.validationErrors = result.errors.slice();
    throw error;
  }
}
// 存档位元数据（列表用，写入时算好，列表不再解码正文）。
export function summarizeSaveState(state, content) {
  return {
    year: state.year,
    day: state.day + 1,
    population: (state.cohorts || []).reduce((sum, group) => sum + group.m + group.f, 0),
    version: content.rules.saveVersion
  };
}

// 存储值：v2 为明文字符串，v3 为 gzip 字节（Uint8Array）。
export function storedFormat(stored) {
  return typeof stored === "string" ? SAVE_CONTAINER_TEXT_VERSION : SAVE_CONTAINER_VERSION;
}

export function storedBytes(stored) {
  if (stored === null || stored === undefined) return 0;
  if (typeof stored === "string") return new TextEncoder().encode(stored).length;
  return stored.byteLength ?? stored.length ?? 0;
}

// 正文指纹：读写时算一次，用来判断主档是否还是写入时那一份（不必每次存档重新解码）。
export function storedDigest(stored) {
  if (typeof stored === "string") return "s" + checksumSaveText(stored);
  const bytes = stored instanceof ArrayBuffer ? new Uint8Array(stored) : stored;
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) hash = Math.imul(hash ^ bytes[i], 16777619);
  return `b${(hash >>> 0).toString(16)}:${bytes.length}`;
}

export function sameStored(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function containerText(id, name, savedAt, checksum, stateText, containerVersion) {
  const header = stringifySaveJson({ containerVersion, id, name, savedAt, checksum }, "存档容器");
  // state 必须保持为最后一个字段：这样校验可直接复用本次持久化的原始 JSON 文本，
  // 不必再次 stringify 整个游戏状态。
  return header.slice(0, -1) + ',"state":' + stateText + '}';
}

// 编码：校验后序列化；支持压缩时整体 gzip（v3），压缩失败或不支持时写明文 v2。
export async function encodeSaveContainer(id, name, state, savedAt, content, { compress = gzipSupported() } = {}) {
  validState(state, content);
  const stateText = stringifySaveJson(state, "游戏数据");
  const checksum = checksumSaveText(stateText);
  const summary = summarizeSaveState(state, content);
  if (compress) {
    try {
      const stored = await gzipText(containerText(id, name, savedAt, checksum, stateText, SAVE_CONTAINER_VERSION));
      return { stored, format: SAVE_CONTAINER_VERSION, checksum, summary };
    } catch (error) {
      console.warn("[麦乡存档] 压缩失败，改为明文保存", error);
    }
  }
  const stored = containerText(id, name, savedAt, checksum, stateText, SAVE_CONTAINER_TEXT_VERSION);
  return { stored, format: SAVE_CONTAINER_TEXT_VERSION, checksum, summary };
}

function validateContainerMetadata(entry, id) {
  return entry && READABLE_CONTAINER_VERSIONS.includes(entry.containerVersion) && entry.id === id &&
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
  const stateText = stateTextFromV2Container(raw, entry);
  if (stateText === null || entry.checksum !== checksumSaveText(stateText)) throw new SavePersistenceError("corrupt", "存档内容损坏。");
  return entry;
}

// 任意存储值（明文 v2 或 gzip 字节）转成容器文本。
async function containerTextOf(stored) {
  if (typeof stored === "string") return stored;
  const bytes = stored instanceof ArrayBuffer ? new Uint8Array(stored) : stored;
  if (!bytes || typeof bytes.length !== "number" || !isGzipBytes(bytes)) throw new SavePersistenceError("corrupt", "存档内容损坏。");
  if (!gzipSupported()) throw new SavePersistenceError("corrupt", "当前浏览器不支持读取压缩存档，请使用较新的浏览器。");
  try { return await gunzipToText(bytes); }
  catch { throw new SavePersistenceError("corrupt", "存档内容损坏。"); }
}

function parseStateFromEntry(entry, content) {
  try { return parseSaveObject(entry.state, content); }
  catch (error) {
    if (error instanceof SavePersistenceError) throw error;
    throw new SavePersistenceError("validation", error.message || "存档数据校验失败。", error);
  }
}

// 同步版：只接受明文容器文本（v2 或未压缩的 v3）。压缩存档请用异步的 decodeSaveContainer。
export function decodeSaveContainerText(raw, id, content) {
  const entry = verifySaveContainerRaw(raw, id);
  return { id, name: entry.name, savedAt: entry.savedAt, state: parseStateFromEntry(entry, content) };
}

export async function inspectSaveContainer(stored, id) {
  const entry = verifySaveContainerRaw(await containerTextOf(stored), id);
  return { id, name: entry.name, savedAt: entry.savedAt, containerVersion: entry.containerVersion };
}

export async function decodeSaveContainer(stored, id, content) {
  const entry = verifySaveContainerRaw(await containerTextOf(stored), id);
  return { id, name: entry.name, savedAt: entry.savedAt, state: parseStateFromEntry(entry, content) };
}
