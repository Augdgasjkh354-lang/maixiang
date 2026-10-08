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

function kindOf(value) {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// 类型对不上（比如该是对象却存成了字符串、该是数字却是 null）时用新版本的默认值，并记一笔修复。
export function mergeOntoBase(base, saved, path = "", report = null, entityMaps = ENTITY_MAPS) {
  if (FROM_CONTENT.has(path)) return base;
  if (saved === undefined) return base;
  const baseKind = kindOf(base);
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
  return parts.length ? `存档来自旧版本，已自动处理（${parts.join("；")}），其余进度保留。` : null;
}
