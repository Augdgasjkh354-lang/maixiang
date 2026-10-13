import { CONTENT } from "../content/index.js";
import { createInitialState } from "../core/state.js";
import { validateState } from "../core/validation.js";
import { migrateSave } from "./migrations.js";
import { gunzipToText, gzipSupported, gzipText, isGzipBytes } from "./compression.js";

export const SAVE_KEY = "maixiang-town-save-v1";

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function preserveRaw(storage, raw, label) {
  if (!raw) return null;
  const backupKey = SAVE_KEY + ".backup-" + label + "-" + hashText(raw);
  if (storage.getItem(backupKey) === null) storage.setItem(backupKey, raw);
  return backupKey;
}

export function saveState(storage, state, content) {
  const definitions = content || CONTENT;
  const result = validateState(state, definitions);
  if (!result.valid) throw new Error("存档未保存：" + result.errors.join("；"));
  storage.setItem(SAVE_KEY, JSON.stringify(state));
  return true;
}

export function loadState(storage, content) {
  const definitions = content || CONTENT;
  const raw = storage.getItem(SAVE_KEY);
  if (raw === null) return { state: createInitialState({ content: definitions }), created: true, legacy: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("本机存档无法读取。原存档未更改。");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("本机存档无法读取。原存档未更改。");
  const currentVersion = definitions.rules.saveVersion;
  const storedVersion = Math.max(Number(parsed.version) || 0, Number(parsed.schemaVersion) || 0);
  if (storedVersion !== currentVersion) {
    return { state: null, migrated: false, created: false, legacy: true, legacyVersion: storedVersion || null };
  }
  return { state: migrateSave(parsed, definitions), migrated: false, created: false, legacy: false };
}

// 明文导出：紧凑 JSON（不缩进，体积约为缩进版的 0.6 倍）。导入两种格式都认。
export function exportState(state) {
  return JSON.stringify(state);
}

// 压缩导出：紧凑 JSON 的 gzip（.json.gz）。调用方先用 gzipSupported() 判断，不支持时不要调用。
export async function exportStateGzipBlob(state) {
  const text = exportState(state); // 同步序列化：之后 state 再变也不影响这份导出
  return new Blob([await gzipText(text)], { type: "application/gzip" });
}

// 导入文件转文本：gzip（魔数 1f 8b）先解压，否则按 UTF-8 明文读取。
export async function readSaveFileText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isGzipBytes(bytes)) {
    if (!gzipSupported()) throw new Error("当前浏览器不支持读取压缩存档，请改用明文 JSON 文件。");
    try { return await gunzipToText(bytes); }
    catch { throw new Error("压缩存档无法解压，文件可能已损坏。"); }
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("导入文件不是有效 JSON。"); }
}

export function parseSaveObject(parsed, content) {
  const definitions = content || CONTENT;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("文件不是麦乡存档。");
  return migrateSave(parsed, definitions);
}

export function parseSaveFile(jsonText, content) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("导入文件不是有效 JSON。");
  }
  return parseSaveObject(parsed, content);
}

export function importState(storage, jsonText, content) {
  const state = parseSaveFile(jsonText, content);
  const previous = storage.getItem(SAVE_KEY);
  preserveRaw(storage, previous, "before-import");
  storage.setItem(SAVE_KEY, JSON.stringify(state));
  return state;
}

export function resetState(storage, content) {
  const definitions = content || CONTENT;
  const previous = storage.getItem(SAVE_KEY);
  preserveRaw(storage, previous, "before-reset");
  const state = createInitialState({ content: definitions });
  saveState(storage, state, definitions);
  return state;
}
