// 读档：只认当前存档版本（SAVE_VERSION），不做任何旧档兼容。版本不符直接拒绝，请开新游戏。
// 以后改数据结构：新字段在 createInitialState 里给默认值、运行时用 ||= 兜底即可；需要不兼容改动时把 SAVE_VERSION 加一。

import { CONTENT } from "../content/index.js";
import { validateState } from "../core/validation.js";
import { ensureProjectAccessor } from "../core/state.js";
import { syncShopEmployment } from "../systems/shops.js";
import { syncResidentAggregates } from "../systems/households.js";

function cloneJson(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function migrateSave(raw, content) {
  const definitions = content || CONTENT;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("存档必须是 JSON 对象。");
  const current = definitions.rules.saveVersion;
  const stored = Math.max(Number(raw.schemaVersion) || 0, Number(raw.version) || 0);
  if (stored > current) throw new Error("该存档来自更新版本，当前版本无法读取。");
  if (stored !== current) throw new Error("旧版存档不兼容，请开始新游戏。");
  const state = cloneJson(raw);
  // 存档里不保存的派生部分：单工程访问器、店铺岗位、居民汇总。
  ensureProjectAccessor(state);
  syncShopEmployment(state, definitions);
  syncResidentAggregates(state, definitions);
  const result = validateState(state, definitions);
  if (!result.valid) throw new Error("存档校验失败：" + result.errors.join("；"));
  return state;
}
