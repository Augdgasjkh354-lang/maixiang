import { CONTENT } from "../content/index.js";
import { createInitialState } from "../core/state.js";
import { validateState } from "../core/validation.js";
import { migrateSave } from "./migrations.js";

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
  const currentVersion = definitions.rules.saveVersion || 3;
  const storedVersion = Math.max(Number(parsed.version) || 0, Number(parsed.schemaVersion) || 0);
  if (storedVersion < 10) {
    return { state: null, migrated: false, created: false, legacy: true, legacyVersion: storedVersion || null };
  }
  const state = migrateSave(parsed, definitions);
  const migrated = JSON.stringify(parsed) !== JSON.stringify(state);
  if (migrated) {
    if (storedVersion < currentVersion) preserveRaw(storage, raw, `before-v${currentVersion}-migration`);
    storage.setItem(SAVE_KEY, JSON.stringify(state));
  }
  return { state, migrated, created: false, legacy: false };
}

export function exportState(state) {
  return JSON.stringify(state, null, 2);
}

export function parseSaveObject(parsed, content) {
  const definitions = content || CONTENT;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("文件不是麦乡存档。");
  const currentVersion = definitions.rules.saveVersion || 10;
  const storedVersion = Math.max(Number(parsed.version) || 0, Number(parsed.schemaVersion) || 0);
  if (storedVersion < 10) throw new Error("旧版存档不兼容，请开始新游戏。");
  if (storedVersion > currentVersion) throw new Error("此存档来自更新版本，暂无法读取。");
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
