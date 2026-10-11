import { createHousehold } from "../systems/households.js";
import { repairHouseholdLife } from "../systems/household-life.js";

// 存档兼容：让存档跨版本一直能读。三层兜底：
//
// 1. 补默认值：用当前版本的新开局状态当底板，把存档逐项盖上去。存档里没有的新字段自动取新默认值，
//    所以只是"新增字段/新系统/新商品/新外镇"的改动，开发时完全不用管存档。
// 2. 改名清单 RENAMES：字段改名或搬家时在这里加一行 { from, to }，读档时自动搬（幂等）。
// 3. 修复：数值坏了（NaN/∞）归零；仍校验不过的顶层子系统重置为新开局状态，其他进度保留，并在报告里说明。
//
// 合并规则：
// - 普通对象逐键合并（底板有、存档没有的键保留底板值；存档多出的键保留存档值）。
// - 数组、数值、字符串等直接用存档的值。
// - ENTITY_MAPS：按实体 id 存的表（如家庭），整表用存档的，不从底板补实体（否则已消亡的家庭会"复活"）。
// - FROM_CONTENT：完全由内容定义决定、运行时不改的数据（地块），一律用当前版本的。

export const RENAMES = Object.freeze([
  // 示例：{ from: "outsideTown", to: "outsideTowns.minzhen" },
]);

export const ENTITY_MAPS = new Set(["households.byId"]);
// 存档里出现这些键一律丢弃，防止原型污染。
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// 一户家庭的必备字段（与 systems/households.js 的 createHousehold 一致），读档缺失时以新开局户补齐。
const HOUSEHOLD_FIELDS = ["id", "name", "ageBands", "jobs", "inventory", "voucherUnits", "shares", "shopIds", "operatingRights", "income", "agricultureWorkUnits"];
const FROM_CONTENT = new Set(["plots"]);
// 校验失败时不允许单独重置的顶层键：它们和整体进度/货币恒等式绑在一起，重置反而会破坏一致性。
const NEVER_RESET = new Set(["version", "schemaVersion", "year", "day", "accounts", "currency", "households", "cohorts", "buildings", "plots", "rng"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(object, path) {
  return path.split(".").reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), object);
}

function setPath(object, path, value) {
  const keys = path.split(".");
  let node = object;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function deletePath(object, path) {
  const keys = path.split(".");
  const parent = keys.length > 1 ? getPath(object, keys.slice(0, -1).join(".")) : object;
  if (isPlainObject(parent)) delete parent[keys[keys.length - 1]];
}

export function applyRenames(raw, report, extraRenames = []) {
  for (const { from, to } of [...RENAMES, ...extraRenames]) {
    const value = getPath(raw, from);
    if (value === undefined || getPath(raw, to) !== undefined) continue;
    setPath(raw, to, value);
    deletePath(raw, from);
    report.renamed.push(`${from} → ${to}`);
  }
  return raw;
}

// 物品改名（酒改成四种酒）：旧存档里的 wine 并入普通白酒 baijiu，1:1 数量不变。
// 整棵存档树里：键 wine、以 wine 开头的驼峰键（如 wineConsumedUnits）、值为 "wine" 的字符串（itemId）一律改名。
// 同名键数值相加，避免覆盖。幂等：没有 wine 时是空操作。
export const ITEM_RENAMES = Object.freeze({ wine: "baijiu" });

function renamedItemKey(key) {
  for (const [from, to] of Object.entries(ITEM_RENAMES)) {
    if (key === from) return to;
    if (key.startsWith(from) && /^[A-Z]/.test(key.slice(from.length))) return to + key.slice(from.length);
  }
  return key;
}

export function renameItemIds(raw, report = null, path = "") {
  if (Array.isArray(raw)) {
    raw.forEach((value, index) => {
      if (typeof value === "string" && Object.hasOwn(ITEM_RENAMES, value)) { raw[index] = ITEM_RENAMES[value]; report?.renamed.push(`${path}[${index}]`); }
      else renameItemIds(value, report, `${path}[${index}]`);
    });
    return raw;
  }
  if (!isPlainObject(raw)) return raw;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === "string" && Object.hasOwn(ITEM_RENAMES, value)) {
      raw[key] = ITEM_RENAMES[value];
      report?.renamed.push(`${path}.${key}`);
    } else if (typeof value === "object" && value !== null) {
      renameItemIds(value, report, path ? `${path}.${key}` : key);
    }
  }
  for (const key of Object.keys(raw)) {
    const to = renamedItemKey(key);
    if (to === key || UNSAFE_KEYS.has(key)) continue;
    const value = raw[key];
    const existing = raw[to];
    if (existing !== undefined && typeof existing === "number" && typeof value === "number") raw[to] = existing + value;
    else if (existing === undefined) raw[to] = value;
    delete raw[key];
    report?.renamed.push(`${path ? path + "." : ""}${key} → ${to}`);
  }
  return raw;
}

// 酒坊整合（四种酒一座酒坊）：旧存档的啤酒坊 / 精酿坊 / 窖坊改成酒坊 winery，旧配方与旧岗位角色改成新的。
// 建筑 id 保持不变（岗位键按"建筑 id::角色"拼接，改 id 会断开人手）；只改类型、配方、角色段。
// 整棵存档树里：值恰等于旧类型 / 旧配方 / 旧角色 id 的改名；键或值里 "::<旧角色>"（其后可接 ::private / ::listed）的角色段改名；
// 键恰等于旧类型或旧角色 id 的并入新 id（industryExperience 工日相加，其余取酒坊已有的值）。幂等：没有旧 id 时是空操作。
export const BUILDING_TYPE_RENAMES = Object.freeze({ brewery: "winery", craft_brewery: "winery", premium_winery: "winery" });
export const RECIPE_RENAMES = Object.freeze({ brewery_beer: "winery_brewing", craft_brewery_beer: "winery_brewing", winery_baijiu: "winery_brewing", premium_winery_baijiu: "winery_brewing" });
export const JOB_ROLE_RENAMES = Object.freeze({ beer_brewers: "brewers", craft_brewers: "brewers", cellar_brewers: "brewers" });
const LIQUOR_JOB_SEGMENT = /::(beer_brewers|craft_brewers|cellar_brewers)(?=::|$)/g;

function renameLiquorText(text) {
  if (Object.hasOwn(BUILDING_TYPE_RENAMES, text)) return BUILDING_TYPE_RENAMES[text];
  if (Object.hasOwn(RECIPE_RENAMES, text)) return RECIPE_RENAMES[text];
  if (Object.hasOwn(JOB_ROLE_RENAMES, text)) return JOB_ROLE_RENAMES[text];
  return text.includes("::") ? text.replace(LIQUOR_JOB_SEGMENT, (_, role) => "::" + JOB_ROLE_RENAMES[role]) : text;
}

export function renameLiquorBuildings(raw, report = null, path = "") {
  if (Array.isArray(raw)) {
    raw.forEach((value, index) => {
      if (typeof value === "string") {
        const next = renameLiquorText(value);
        if (next !== value) { raw[index] = next; report?.renamed.push(`${path}[${index}]`); }
      } else renameLiquorBuildings(value, report, `${path}[${index}]`);
    });
    return raw;
  }
  if (!isPlainObject(raw)) return raw;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === "string") {
      const next = renameLiquorText(value);
      if (next !== value) { raw[key] = next; report?.renamed.push(`${path ? path + "." : ""}${key}`); }
    } else if (typeof value === "object" && value !== null) {
      renameLiquorBuildings(value, report, path ? `${path}.${key}` : key);
    }
  }
  for (const key of Object.keys(raw)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const to = Object.hasOwn(BUILDING_TYPE_RENAMES, key) ? BUILDING_TYPE_RENAMES[key]
      : Object.hasOwn(JOB_ROLE_RENAMES, key) ? JOB_ROLE_RENAMES[key]
      : key.includes("::") ? key.replace(LIQUOR_JOB_SEGMENT, (_, role) => "::" + JOB_ROLE_RENAMES[role]) : key;
    if (to === key) continue;
    const value = raw[key];
    const existing = raw[to];
    if (existing === undefined) raw[to] = value;
    else if (typeof existing === "number" && typeof value === "number" && (path === "industryExperience" || path.endsWith(".industryExperience"))) raw[to] = existing + value;
    delete raw[key];
    report?.renamed.push(`${path ? path + "." : ""}${key} → ${to}`);
  }
  return raw;
}

function kindOf(value) {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// 能转成有限数字就转（数字字符串），否则返回 null。JSON 存不下 NaN/∞，它们在存档里就是 null。
export function coerceNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

// 类型对不上（比如该是对象却存成了字符串）时用新版本的默认值，并记一笔修复。
// 数值字段例外：读到 null、非有限数、数字字符串时，能转就转，否则归零，绝不取底板默认值
// （库存、账户余额取底板默认会凭空变出货币和粮食）。
export function mergeOntoBase(base, saved, path = "", report = null, entityMaps = ENTITY_MAPS) {
  if (FROM_CONTENT.has(path)) return base;
  if (saved === undefined) return base;
  const baseKind = kindOf(base);
  if (baseKind === "number") {
    if (typeof saved === "number" && Number.isFinite(saved)) return saved;
    report?.repaired.push(path);
    return coerceNumber(saved) ?? 0;
  }
  if (baseKind !== "empty" && kindOf(saved) !== baseKind) {
    report?.repaired.push(path);
    return base;
  }
  if (!isPlainObject(base) || entityMaps.has(path)) return saved;
  const result = { ...base };
  for (const [key, value] of Object.entries(saved)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const childPath = path ? `${path}.${key}` : key;
    result[key] = key in base ? mergeOntoBase(base[key], value, childPath, report, entityMaps) : value;
  }
  return result;
}

// 家庭表读档修复（家庭按实体 id 存，不走底板合并，所以在这里逐户补齐）：
// - 键是危险键（__proto__ 等）：丢弃；值不是对象：丢弃该户（人口对不上时校验会给出中文错误）。
// - id 与键不一致：以键为准。缺字段：以新开局户模板补齐。
// - 数值 null / 数字字符串：能转就转，否则归零；库存 null 归零。
// 每一处修复都写进读档报告。修不了的由后续校验抛中文错误。
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numberInPlace(holder, key, path, report) {
  const value = holder[key];
  if (value === undefined || isFiniteNumber(value)) return;
  holder[key] = coerceNumber(value) ?? 0;
  report.repaired.push(`${path}.${key}`);
}

function safeKeys(object, path, report) {
  return Object.keys(object).filter(key => {
    if (!UNSAFE_KEYS.has(key)) return true;
    report.repaired.push(`${path}.${key}`);
    return false;
  });
}

// 已不再存档的派生字段：满意度分项全镇快照（satisfactionFactors.rows，现由日结缓存或界面现算）。
// 逐户的 life.recent / life.satisfactionHistory / life.lastFactors 与观察行格式在下面的户循环里由 repairHouseholdLife 处理。
function dropRetiredFields(saved) {
  if (isPlainObject(saved?.satisfactionFactors)) delete saved.satisfactionFactors.rows;
}

export function repairHouseholdTable(saved, content, report) {
  dropRetiredFields(saved);
  const table = saved?.households;
  if (!isPlainObject(table) || table.byId === undefined) return;
  if (!isPlainObject(table.byId)) throw new Error("家庭数据损坏：家庭表不是对象，无法读取。");
  const template = createHousehold(0, content);
  const byId = {};
  for (const key of safeKeys(table.byId, "households.byId", report)) {
    const path = `households.byId.${key}`;
    const entry = table.byId[key];
    if (!isPlainObject(entry)) { report.repaired.push(path); continue; }
    const household = { ...entry };
    repairHouseholdLife(household.life);
    if (household.id !== key) { household.id = key; report.repaired.push(`${path}.id`); }
    for (const field of HOUSEHOLD_FIELDS) {
      if (household[field] === undefined) { household[field] = structuredClone(template[field]); report.repaired.push(`${path}.${field}`); }
    }
    if (!isPlainObject(household.ageBands)) { household.ageBands = structuredClone(template.ageBands); report.repaired.push(`${path}.ageBands`); }
    for (const band of ["children", "workers", "elders"]) {
      if (household.ageBands[band] === undefined) { household.ageBands[band] = 0; report.repaired.push(`${path}.ageBands.${band}`); }
      else numberInPlace(household.ageBands, band, `${path}.ageBands`, report);
    }
    if (!isPlainObject(household.inventory)) { household.inventory = structuredClone(template.inventory); report.repaired.push(`${path}.inventory`); }
    else {
      const inventory = {};
      for (const itemId of safeKeys(household.inventory, `${path}.inventory`, report)) {
        const value = household.inventory[itemId];
        if (value === undefined || isFiniteNumber(value)) { inventory[itemId] = value; continue; }
        inventory[itemId] = coerceNumber(value) ?? 0;
        report.repaired.push(`${path}.inventory.${itemId}`);
      }
      household.inventory = inventory;
    }
    if (!isPlainObject(household.jobs)) { household.jobs = {}; report.repaired.push(`${path}.jobs`); }
    else {
      const jobs = {};
      for (const jobKey of safeKeys(household.jobs, `${path}.jobs`, report)) {
        const value = household.jobs[jobKey];
        if (isFiniteNumber(value)) { jobs[jobKey] = value; continue; }
        jobs[jobKey] = coerceNumber(value) ?? 0;
        report.repaired.push(`${path}.jobs.${jobKey}`);
      }
      household.jobs = jobs;
    }
    numberInPlace(household, "voucherUnits", path, report);
    numberInPlace(household, "agricultureWorkUnits", path, report);
    for (const field of ["shares", "income"]) {
      if (!isPlainObject(household[field])) { household[field] = structuredClone(template[field]); report.repaired.push(`${path}.${field}`); }
    }
    for (const field of ["shopIds", "operatingRights"]) {
      if (!Array.isArray(household[field])) { household[field] = structuredClone(template[field]); report.repaired.push(`${path}.${field}`); }
    }
    byId[key] = household;
  }
  table.byId = byId;
}

// 把 NaN / ±Infinity 归零，记录路径。
export function sanitizeNumbers(node, report, path = "") {
  if (Array.isArray(node)) {
    node.forEach((value, index) => {
      if (typeof value === "number" && !Number.isFinite(value)) { node[index] = 0; report.repaired.push(`${path}[${index}]`); }
      else sanitizeNumbers(value, report, `${path}[${index}]`);
    });
  } else if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof value === "number" && !Number.isFinite(value)) { node[key] = 0; report.repaired.push(childPath); }
      else sanitizeNumbers(value, report, childPath);
    }
  }
}

// 校验不过时尽量少动：先逐个把子系统里的单个字段换回默认值，不够再整个子系统换回新开局状态。
// 只保留能减少错误的替换。
function tryReplace(holder, key, replacement, validate, errors) {
  const previous = holder[key];
  holder[key] = structuredClone(replacement);
  const next = validate();
  if (next.length < errors.length) return next;
  holder[key] = previous;
  return null;
}

export function resetFailingSubsystems(state, base, validate, report) {
  let errors = validate(state);
  if (!errors.length) return errors;
  for (const key of Object.keys(base)) {
    if (!errors.length) break;
    if (NEVER_RESET.has(key) || !(key in state)) continue;
    if (isPlainObject(state[key]) && isPlainObject(base[key])) {
      for (const child of Object.keys(base[key])) {
        if (!errors.length) break;
        if (!(child in state[key])) continue;
        const next = tryReplace(state[key], child, base[key][child], () => validate(state), errors);
        if (next) { errors = next; report.reset.push(`${key}.${child}`); }
      }
    }
    if (!errors.length) break;
    const next = tryReplace(state, key, base[key], () => validate(state), errors);
    if (next) { errors = next; report.reset.push(key); }
  }
  return errors;
}

export function emptyLoadReport() {
  return { renamed: [], repaired: [], reset: [], ownership: [] };
}

export function describeLoadReport(report) {
  if (!report) return null;
  const parts = [];
  if (report.renamed.length) parts.push(`迁移字段 ${report.renamed.length} 处`);
  if (report.repaired.length) parts.push(`修复坏数据 ${report.repaired.length} 处`);
  if (report.reset.length) parts.push(`重置子系统：${report.reset.join("、")}`);
  if (report.ownership?.length) parts.push(`整栋归属换算 ${report.ownership.length} 栋：${report.ownership.join("；")}`);
  if (report.households?.length) parts.push(report.households.join("；"));
  if (report.calendar?.length) parts.push(report.calendar.join("；"));
  return parts.length ? `存档来自旧版本，已自动处理（${parts.join("；")}），其余进度保留。` : null;
}
