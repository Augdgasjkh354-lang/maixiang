import { splitOversizedHouseholds } from "../systems/household-split.js";
// 读档：新版本读旧存档时自动补默认值、按改名清单搬字段、修复坏数据（见 save-compat.js）。
// 存档版本号只在"彻底不兼容"时才加一；日常加字段、加系统都不用改版本号，也不用写迁移代码。
// 只拒读两种存档：来自更新版本的，以及早于 MIN_SAVE_VERSION 的远古存档。

import { CONTENT } from "../content/index.js";
import { validateState } from "../core/validation.js";
import { createInitialState, ensureProjectAccessor } from "../core/state.js";
import { syncShopEmployment } from "../systems/shops.js";
import { syncResidentAggregates } from "../systems/households.js";
import { convertSplitOwnership } from "../systems/ownership-migrate.js";
import { convertResidualWheatCash } from "./wheat-cash-migrate.js";
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

  // 小麦阶段（实物当货币）的旧档不再支持：粮券阶段的存档才读得进来。新版存档的 monetaryReform 只有 legacyBankAccess。
  if (!raw.monetaryReform || typeof raw.monetaryReform !== "object" || raw.monetaryReform.stage === "wheat") {
    throw new Error("该存档仍是小麦结算的旧版本，已不再支持，请开始新游戏。");
  }

  const report = emptyLoadReport();
  // mod 在 content.js 的 save 里登记的改名与实体表（state.mods.<id>... 路径）。
  const saved = applyRenames(cloneJson(raw), report, definitions.modSave?.renames || []);
  const base = createInitialState({ content: definitions });
  const entityMaps = new Set([...ENTITY_MAPS, ...(definitions.modSave?.entityMaps || [])]);
  const state = mergeOntoBase(cloneJson(base), saved, "", report, entityMaps);
  state.version = current;
  state.schemaVersion = current;
  // 货币阶段已删除：旧的粮券阶段存档里的 stage/started/completed 丢掉，只留银行入口标记。
  state.monetaryReform = { legacyBankAccess: Boolean(saved.monetaryReform?.legacyBankAccess) };
  convertResidualWheatCash(state, definitions, report);
  sanitizeNumbers(state, report);
  rehydrate(state, definitions);
  // 旧存档里按等级拆开的建筑整栋换主人（docs/OWNERSHIP.md 旧存档换算）；必须在校验之前，整栋已是空操作。
  convertSplitOwnership(state, definitions, report);
  // 日历换算：旧存档一年 365 天（没有 calendarDaysPerYear），按比例换到现在的天数（秋收日、季节对应不变）。
  const savedDaysPerYear = Number(saved?.calendarDaysPerYear) || 365;
  const daysPerYear = definitions.rules.daysPerYear;
  if (savedDaysPerYear !== daysPerYear) {
    state.day = Math.min(daysPerYear - 1, Math.floor((state.day || 0) * daysPerYear / savedDaysPerYear));
    report.calendar = [`日历改为一年${daysPerYear}天（12个月），日期已按比例换算`];
  }
  state.calendarDaysPerYear = daysPerYear;
  rehydrate(state, definitions);
  // 旧存档的大户（开局 250 户、每户十几人）读档时一次分到每户不超过 8 人；已分好的存档是空操作。
  const split = splitOversizedHouseholds(state, definitions, { recordEvents: false });
  if (split.splits > 0) report.households = [`旧存档大户已分家：新增${split.splits}户`];
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
