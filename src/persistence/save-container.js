// 存档容器：IndexedDB 每个存档位存一段带校验和的 JSON 文本（头信息 + state）。
import { validateState } from "../core/validation.js";
import { parseSaveObject } from "./storage.js";

export const SAVE_CONTAINER_VERSION = 2;
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
  return entry && entry.containerVersion === SAVE_CONTAINER_VERSION && entry.id === id &&
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
