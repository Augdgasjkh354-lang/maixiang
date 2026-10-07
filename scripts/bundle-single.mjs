// scripts/bundle-single.mjs
// 把 src/**/*.js 按依赖拓扑顺序内联进一个 <script type="module">、
// 把 src/styles/*.css 内联进 <style>，输出自包含单文件 HTML。
//
// 原理：ESM 每个文件是独立作用域，直接拼接会因重名顶层声明而报错。
// 这里把每个模块包进一个 IIFE：import 语句改写为从依赖模块的
// 导出对象上解构，export 改写为 return 对象。源码中无循环依赖、
// 无 export let/var、无 export * / export default（若将来出现，
// 脚本会直接报错而不是默默产出错误包）。
//
// 用法：
//   node scripts/bundle-single.mjs [--out dist-single/maixiang.html] [--no-smoke]
//   --out    输出路径（默认 dist-single/maixiang.html）
//   --no-smoke 跳过 headless 启动冒烟测试
//
// 只新增本文件，不改 src/ 下任何游戏逻辑与数值。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(root, "src");
const STYLES_DIR = path.join(SRC_DIR, "styles");
const ENTRY = "main.js";
const WRAP_PREFIX = "__mxmod";

function fail(message) {
  console.error("bundle-single 失败：" + message);
  process.exit(1);
}

// ---- 文件收集 ----
import { readdir } from "node:fs/promises";
async function collectJsFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectJsFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}
const relKey = (full) => path.relative(SRC_DIR, full).split(path.sep).join("/");

// ---- 注释屏蔽（保持长度，用于定位 import/export 语句）----
// 只屏蔽注释，不动字符串：import 路径还在引号里，可直接解析。
function maskComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      let s = "";
      for (let k = i; k < j; k++) s += src[k] === "\n" ? "\n" : " ";
      out += s;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// 字符串感知的顶层逗号/分号拆分（用于 export const a=.., b=..）
// masked 中注释已屏蔽；这里再跳过字符串字面量（含模板字符串 ${} 嵌套）
function splitTopLevel(rest) {
  const parts = [];
  let depth = 0, cur = "", i = 0;
  const n = rest.length;
  const pushCur = () => { if (cur.trim()) parts.push(cur.trim()); cur = ""; };
  while (i < n) {
    const c = rest[i];
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      cur += c; i++;
      while (i < n) {
        cur += rest[i];
        if (rest[i] === "\\") { if (i + 1 < n) { cur += rest[i + 1]; i += 2; } else i++; continue; }
        if (rest[i] === q) { i++; break; }
        if (q === "`" && rest[i] === "$" && rest[i + 1] === "{") {
          let d = 1; i += 2;
          while (i < n && d > 0) {
            cur += rest[i];
            if (rest[i] === "\\") { if (i + 1 < n) { cur += rest[i + 1]; i += 2; } else i++; continue; }
            if (rest[i] === '"' || rest[i] === "'") {
              const q2 = rest[i]; i++;
              while (i < n) { cur += rest[i]; if (rest[i] === "\\") { if (i + 1 < n) { cur += rest[i + 1]; i += 2; } else i++; continue; } if (rest[i] === q2) { i++; break; } i++; }
              continue;
            }
            if (rest[i] === "{") d++;
            else if (rest[i] === "}") d--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if ((c === "," || c === ";") && depth === 0) { pushCur(); if (c === ";") { i++; break; } }
    else cur += c;
    i++;
  }
  pushCur();
  return parts;
}

// ---- 解析单个模块 ----
function parseModule(key, masked) {
  const imports = []; // { clause, path, start, end }
  const importRe = /^\s*import\s+([\s\S]*?)\s*;\s*$/gm;
  let m;
  while ((m = importRe.exec(masked))) {
    const clause = m[1].trim();
    const stmtStart = m.index;
    const stmtEnd = m.index + m[0].length;
    const fromMatch = clause.match(/\bfrom\s*["']([^"']+)["']\s*$/);
    if (fromMatch) {
      const importList = clause.slice(0, fromMatch.index).trim();
      imports.push({ kind: "named", list: importList, path: fromMatch[1], start: stmtStart, end: stmtEnd });
    } else {
      const bare = clause.match(/^["']([^"']+)["']$/);
      if (!bare) fail(`模块 ${key} 有无法解析的 import 语句：${clause.slice(0, 80)}`);
      imports.push({ kind: "side-effect", path: bare[1], start: stmtStart, end: stmtEnd });
    }
  }
  // 命名导入明细：{ a, b as c } / * as ns
  const bindings = []; // { imported, local, kind: 'named'|'namespace', impIndex }
  imports.forEach((imp, impIndex) => {
    if (imp.kind !== "named") return;
    const list = imp.list.trim();
    if (list.startsWith("*")) {
      const ns = list.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (!ns) fail(`模块 ${key} 有无法解析的 import * 语句：${list.slice(0, 80)}`);
      bindings.push({ imported: "*", local: ns[1], kind: "namespace", impIndex });
      return;
    }
    if (!list.startsWith("{")) fail(`模块 ${key} 出现默认导入（不支持）：${list.slice(0, 80)}`);
    const inner = list.replace(/^\{/, "").replace(/\}$/, "");
    for (const part of inner.split(",")) {
      const p = part.trim();
      if (!p) continue;
      const asMatch = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asMatch) bindings.push({ imported: asMatch[1], local: asMatch[2], kind: "named", impIndex });
      else if (/^[A-Za-z_$][\w$]*$/.test(p)) bindings.push({ imported: p, local: p, kind: "named", impIndex });
      else fail(`模块 ${key} 有无法解析的导入项：${p}`);
    }
  });

  // 导出：三类
  // 1) export [async] function/class/const/let/var  -> 只去掉 "export " 前缀，名字记入导出表
  // 2) export { a, b as c };                       -> 整句删除，记映射
  const keywordRanges = []; // [start, end) of "export " 前缀
  const keywordExports = []; // { exported, local }（exported === local）
  const exportList = []; // { exported, local }
  const listRanges = [];
  const kwRe = /^\s*export\s+(?=(?:async\s+function|function|class|const|let|var)\b)/gm;
  while ((m = kwRe.exec(masked))) {
    const kwStart = m.index + m[0].lastIndexOf("export");
    keywordRanges.push([kwStart, kwStart + "export ".length]);
    // 解析声明的名字：从 "export " 之后开始
    let rest = masked.slice(kwStart + "export ".length);
    const declKind = rest.match(/^(async\s+function|function|class|const|let|var)\b/)[1];
    rest = rest.slice(declKind.length).trimStart();
    if (declKind === "function" || declKind === "class" || declKind === "async function") {
      const nameMatch = rest.match(/^([A-Za-z_$][\w$]*)/);
      if (!nameMatch) fail(`模块 ${key} 的 ${declKind} 声明缺少名字`);
      keywordExports.push({ exported: nameMatch[1], local: nameMatch[1] });
    } else {
      // const/let/var：按顶层逗号拆分 declarator
      for (const part of splitTopLevel(rest)) {
        if (/^[{[]/.test(part)) fail(`模块 ${key} 使用了解构导出（不支持）：${part.slice(0, 40)}`);
        const nameMatch = part.match(/^([A-Za-z_$][\w$]*)/);
        if (!nameMatch) fail(`模块 ${key} 有无法解析的导出声明：${part.slice(0, 40)}`);
        keywordExports.push({ exported: nameMatch[1], local: nameMatch[1] });
      }
    }
  }
  const listRe = /^\s*export\s*\{([^}]*)\}\s*;/gm;
  while ((m = listRe.exec(masked))) {
    listRanges.push([m.index, m.index + m[0].length]);
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      const asMatch = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asMatch) exportList.push({ exported: asMatch[2], local: asMatch[1] });
      else if (/^[A-Za-z_$][\w$]*$/.test(p)) exportList.push({ exported: p, local: p });
      else fail(`模块 ${key} 有无法解析的导出项：${p}`);
    }
  }
  // 防御：export * / export default / export {} from 一律拒绝
  if (/^\s*export\s*\*/m.test(masked)) fail(`模块 ${key} 使用了 export *（不支持）`);
  if (/^\s*export\s+default\b/m.test(masked)) fail(`模块 ${key} 使用了 export default（不支持）`);
  if (/^\s*export\s*\{[^}]*\}\s*from\b/m.test(masked)) fail(`模块 ${key} 使用了 export..from 转发（不支持）`);
  if (/^\s*export\s+(let|var)\b/m.test(masked)) fail(`模块 ${key} 使用了 export let/var（活绑定不支持）`);
  return { imports, bindings, keywordRanges, keywordExports, exportList, listRanges };
}

function resolveImport(fromKey, importPath) {
  if (!importPath.startsWith(".")) fail(`模块 ${fromKey} 引用了非相对路径 ${importPath}（不支持）`);
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromKey), importPath));
  return target;
}

// ---- 主流程 ----
const jsFiles = (await collectJsFiles(SRC_DIR)).sort();
const keyOf = new Map(jsFiles.map((f) => [relKey(f), f]));
const modules = new Map(); // key -> { source, parsed, varName }
for (const full of jsFiles) {
  const key = relKey(full);
  const source = await readFile(full, "utf8");
  if (source.includes(WRAP_PREFIX)) fail(`模块 ${key} 包含包装前缀 ${WRAP_PREFIX}，会冲突`);
  modules.set(key, { source, parsed: parseModule(key, maskComments(source)), varName: null });
}

// 打包时给 BUILD_ID 盖构建戳（git short hash），否则线上永远显示同一构建号，用户无法分辨版本。
{
  const versionMod = modules.get("content/version.js");
  if (versionMod) {
    let hash = "local";
    try {
      hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim() || "local";
    } catch { /* 非 git 环境时保留 local */ }
    const stamped = versionMod.source.replace(
      /BUILD_ID\s*=\s*["'][^"']*["']/,
      `BUILD_ID = "0203-${hash}"`
    );
    if (stamped !== versionMod.source) {
      versionMod.source = stamped;
      versionMod.parsed = parseModule("content/version.js", maskComments(stamped));
      console.log(`构建戳：BUILD_ID = 0203-${hash}`);
    }
  }
}

// 依赖图 + 校验
const graph = new Map();
for (const [key, mod] of modules) {
  const deps = new Set();
  for (const imp of mod.parsed.imports) {
    const target = resolveImport(key, imp.path);
    if (!modules.has(target)) fail(`模块 ${key} 引用的 ${imp.path} 解析为 ${target}，文件不存在`);
    deps.add(target);
  }
  graph.set(key, [...deps]);
}
// 环检测
{
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...modules.keys()].map((k) => [k, WHITE]));
  const visit = (u, stack) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of graph.get(u)) {
      if (color.get(v) === GRAY) fail("发现循环依赖：" + [...stack.slice(stack.indexOf(v)), v].join(" -> "));
      if (color.get(v) === WHITE) visit(v, stack);
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const k of modules.keys()) if (color.get(k) === WHITE) visit(k, []);
}
// 拓扑排序（依赖在前）
const topo = [];
{
  const seen = new Set();
  const visit = (u) => {
    if (seen.has(u)) return;
    seen.add(u);
    for (const v of graph.get(u)) visit(v);
    topo.push(u);
  };
  if (!modules.has(ENTRY)) fail(`入口 ${ENTRY} 不存在`);
  for (const k of modules.keys()) visit(k); // 全部模块都打包（含未被入口引用到的）
  // 去重保持顺序
  const uniq = [...new Set(topo)];
  topo.length = 0;
  topo.push(...uniq);
}
topo.forEach((key, i) => modules.get(key).varName = `${WRAP_PREFIX}${i}`);

// ---- 生成拼接体 ----
function blankRanges(source, ranges) {
  const chars = source.split("");
  for (const [s, e] of ranges) {
    for (let i = s; i < e; i++) chars[i] = chars[i] === "\n" ? "\n" : " ";
  }
  return chars.join("");
}

const chunks = [];
for (const key of topo) {
  const mod = modules.get(key);
  const { parsed } = mod;
  const ranges = [
    ...parsed.imports.map((imp) => [imp.start, imp.end]),
    ...parsed.keywordRanges,
    ...parsed.listRanges,
  ];
  const body = blankRanges(mod.source, ranges).trim();
  const depVar = (target) => modules.get(target).varName;
  const importLines = [];
  for (const imp of parsed.imports) {
    if (imp.kind === "side-effect") continue; // 仅保证执行顺序，拓扑已保证
    const target = resolveImport(key, imp.path);
    const nsBindings = parsed.bindings.filter((b) => b.impIndex === parsed.imports.indexOf(imp) && b.kind === "namespace");
    const named = parsed.bindings.filter((b) => b.impIndex === parsed.imports.indexOf(imp) && b.kind === "named");
    for (const b of nsBindings) importLines.push(`const ${b.local} = ${depVar(target)};`);
    if (named.length) {
      const pairs = named.map((b) => (b.imported === b.local ? b.local : `${b.imported}: ${b.local}`));
      importLines.push(`const { ${pairs.join(", ")} } = ${depVar(target)};`);
    }
  }
  const returnPairs = [
    ...parsed.keywordExports.map((e) => e.local),
    ...parsed.exportList.map((e) => (e.exported === e.local ? e.local : `${e.exported}: ${e.local}`)),
  ];
  // 防御：同一模块内导出名重复
  const seenExp = new Set();
  for (const pair of returnPairs) {
    const expName = pair.includes(":") ? pair.split(":")[0].trim() : pair;
    if (seenExp.has(expName)) fail(`模块 ${key} 重复导出 ${expName}`);
    seenExp.add(expName);
  }
  chunks.push(
    `// ===== ${key} =====\n` +
    `const ${mod.varName} = (() => {\n` +
    (importLines.length ? importLines.join("\n") + "\n" : "") +
    body + "\n" +
    `return { ${returnPairs.join(", ")} };\n` +
    `})();`
  );
}
const bundledJs = chunks.join("\n\n");

// 防御性检查：屏蔽注释/字符串后的拼接体里不应再有 import/export 语句
{
  const checkMasked = maskComments(bundledJs);
  const leftover = checkMasked.match(/^\s*(import|export)\b/m);
  if (leftover) fail("拼接体中残留 import/export 语句，打包逻辑有误");
}

// ---- CSS ----
const cssFiles = (await readdir(STYLES_DIR)).filter((f) => f.endsWith(".css")).sort();
let css = "";
for (const f of cssFiles) css += `/* ===== styles/${f} ===== */\n` + (await readFile(path.join(STYLES_DIR, f), "utf8")) + "\n";

// ---- 版本号 ----
const versionSrc = await readFile(path.join(SRC_DIR, "content", "version.js"), "utf8");
const versionMatch = versionSrc.match(/APP_VERSION\s*=\s*["']([^"']+)["']/);
const appVersion = versionMatch ? versionMatch[1] : "0.0.0";

// ---- 组装 HTML（对齐线上单文件 head 结构：title/meta/style/script/body#app）----
const html =
`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#385443">
  <meta name="description" content="一座以粮食为本的古代小镇模拟经营游戏。">
  <meta name="color-scheme" content="light dark">
  <link rel="icon" href="data:,">
  <title>麦乡 ${appVersion} · 小镇岁时</title>
  <style>
${css.trim()}
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module">
${bundledJs}
  </script>
</body>
</html>
`;

// ---- 输出 ----
const args = process.argv.slice(2);
let outPath = path.join(root, "dist-single", "maixiang.html");
let doSmoke = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) outPath = path.resolve(args[++i]);
  else if (args[i] === "--no-smoke") doSmoke = false;
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("用法: node scripts/bundle-single.mjs [--out <路径>] [--no-smoke]");
    process.exit(0);
  }
}
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, html, "utf8");

// ---- 验证 1：抽出内联脚本做 node --check ----
{
  const scriptMatch = html.match(/<script type="module">\n([\s\S]*)\n  <\/script>/);
  if (!scriptMatch) fail("组装后的 HTML 中找不到内联脚本");
  const tmpJs = path.join(tmpdir(), `maixiang-bundle-check-${Date.now()}.js`);
  await writeFile(tmpJs, scriptMatch[1], "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmpJs], { stdio: "pipe" });
  } catch (e) {
    fail("内联脚本 node --check 未通过：\n" + (e.stderr?.toString() || e.message).slice(0, 2000));
  }
  console.log("验证通过：内联脚本 node --check 无语法错误");
}

// ---- 验证 2：headless 启动冒烟（引擎跑 30 天 + validateState）----
if (doSmoke) {
  const { pathToFileURL } = await import("node:url");
  const engineUrl = pathToFileURL(path.join(root, "src", "engine.js")).href;
  const smokeCode = `
import(${JSON.stringify(engineUrl)}).then(({ createSimulation, CONTENT }) => {
  const sim = createSimulation(CONTENT);
  const state = sim.createInitialState({ seed: 20261005 });
  sim.advanceDays(state, 30);
  const check = sim.validateState(state);
  if (!check.valid) { console.error("冒烟失败：" + check.errors.join("；")); process.exit(1); }
  console.log("冒烟通过：headless 跑 30 天，validateState 全绿（人口 " + state.cohorts.reduce((a, c) => a + c.m + c.f, 0) + "）");
}).catch((e) => { console.error("冒烟失败：" + (e && e.stack || e)); process.exit(1); });
`;
  const tmpSmoke = path.join(tmpdir(), `maixiang-smoke-${Date.now()}.mjs`);
  await writeFile(tmpSmoke, smokeCode, "utf8");
  try {
    const out = execFileSync(process.execPath, [tmpSmoke], { cwd: root, stdio: "pipe" }).toString().trim();
    console.log("验证通过：" + out);
  } catch (e) {
    fail("headless 冒烟测试未通过：\n" + (e.stderr?.toString() || e.stdout?.toString() || e.message).slice(0, 2000));
  }
}

console.log(`打包完成：${outPath}（${topo.length} 个模块，HTML ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB）`);
