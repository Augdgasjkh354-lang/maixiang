// 读档：新版本读旧存档时自动补默认值、按改名清单搬字段、修复坏数据（见 save-compat.js）。
// 存档版本号只在"彻底不兼容"时才加一；日常加字段、加系统都不用改版本号，也不用写迁移代码。
// 只拒读两种存档：来自更新版本的，以及早于 MIN_SAVE_VERSION 的远古存档。

import { CONTENT } from "../content/index.js";
import { validateState } from "../core/validation.js";
import { createInitialState, ensureProjectAccessor } from "../core/state.js";
import { syncShopEmployment } from "../systems/shops.js";
import { syncResidentAggregates } from "../systems/households.js";
import { convertSplitOwnership } from "../systems/ownership-migrate.js";
import {
  ENTITY_MAPS, applyRenames, describeLoadReport, emptyLoadReport, mergeOntoBase, resetFailingSubsystems, sanitizeNumbers
} from "./save-compat.js";

export const MIN_SAVE_VERSION = 17;

function cloneJson(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// 存档里不保存的派生部分：单工程访问器、店铺岗位、居民汇总。
function rehydrate(state, definitions) {
  ensureProjectAccessor(state);
  syncShopEmployment(state, definitions);
  syncResidentAggregates(state, definitions);
  return state;
}

export function migrateSave(raw, content) {
  const definitions = content || CONTENT;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("存档必须是 JSON 对象。");
  const current = definitions.rules.saveVersion;
  const stored = Math.max(Number(raw.schemaVersion) || 0, Number(raw.version) || 0);
  if (stored > current) throw new Error("该存档来自更新版本，当前版本无法读取。");
  if (stored < MIN_SAVE_VERSION) throw new Error("旧版存档不兼容，请开始新游戏。");

  const report = emptyLoadReport();
  // mod 在 content.js 的 save 里登记的改名与实体表（state.mods.<id>... 路径）。
  const saved = applyRenames(cloneJson(raw), report, definitions.modSave?.renames || []);
  const base = createInitialState({ content: definitions });
  const entityMaps = new Set([...ENTITY_MAPS, ...(definitions.modSave?.entityMaps || [])]);
  const state = mergeOntoBase(cloneJson(base), saved, "", report, entityMaps);
  state.version = current;
  state.schemaVersion = current;
  sanitizeNumbers(state, report);
  rehydrate(state, definitions);
  // 旧存档里按等级拆开的建筑整栋换主人（docs/OWNERSHIP.md 旧存档换算）；必须在校验之前，整栋已是空操作。
  convertSplitOwnership(state, definitions, report);
  rehydrate(state, definitions);

  const validate = candidate => validateState(rehydrate(candidate, definitions), definitions).errors;
  const errors = resetFailingSubsystems(state, base, validate, report);
  if (errors.length) throw new Error("存档校验失败：" + errors.slice(0, 5).join("；"));

  // 读档报告不进存档（不可枚举），界面用 loadReportMessage 提示玩家。
  Object.defineProperty(state, "_loadReport", { value: report, enumerable: false, configurable: true, writable: true });
  return state;
}

export function loadReportMessage(state) {
  return describeLoadReport(state?._loadReport);
}
