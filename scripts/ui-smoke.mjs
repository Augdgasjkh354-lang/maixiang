// scripts/ui-smoke.mjs
// 界面冒烟：打包成单文件 → 无头 Chromium 打开 → 新游戏 → 依次打开各面板，点面板里的非破坏性按钮，
// 再让时间跑一小会儿，收集 console.error / pageerror。打包自带的 30 天冒烟只跑模拟、不渲染界面，界面报错靠这个查。
//
// 用法：node scripts/ui-smoke.mjs [--max-clicks 15] [--run-ms 4000] [--keep]
//   --max-clicks N  每个面板最多点 N 个按钮（默认 15；设 0 只开面板不点）
//   --run-ms N      点完后让时间跑 N 毫秒（默认 4000；设 0 不跑）
//   --keep          保留生成的 html（默认用完删除）
// 退出码：0 无报错；1 有 console.error / pageerror / 脚本失败。
// 需要 Playwright 与 Chromium（云端环境已装：/opt/node-tools、/opt/pw-browsers；不要 playwright install）。

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const numArg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const maxClicks = numArg("--max-clicks", 15);
const runMs = numArg("--run-ms", 4000);
const keep = args.includes("--keep");

// 会删档、改存档位、弹文件框或离开当前局的按钮不点。
const SKIP = /删除|拆除|读取|载入|新游戏|导入|导出|覆盖|另存|重置|退出|清算|关停|停业|解散|取消|关闭/;

function loadPlaywright() {
  const candidates = [
    () => createRequire(import.meta.url)("playwright"),
    () => createRequire("/opt/node-tools/package.json")("playwright"),
    () => createRequire(join(process.env.NODE_PATH || "/usr/local/lib/node_modules_global", "x.js"))("playwright")
  ];
  for (const load of candidates) {
    try { return load(); } catch { /* 试下一个 */ }
  }
  throw new Error("找不到 playwright（云端环境应在 /opt/node-tools）。");
}

function chromiumPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  for (const rel of ["chromium", "chromium-1194/chrome-linux/chrome"]) {
    const path = join(base, rel);
    if (existsSync(path) && !path.endsWith("chromium")) return path;
  }
  return undefined; // 让 playwright 自己找
}

const dir = mkdtempSync(join(tmpdir(), "maixiang-ui-smoke-"));
const html = join(dir, "index.html");
execFileSync("node", [join(root, "scripts/bundle-single.mjs"), "--out", html], { stdio: "inherit" });

const problems = [];
let clicked = 0;
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on("pageerror", error => problems.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  await page.goto(pathToFileURL(html).href);
  await page.waitForSelector("#panelSurface", { state: "attached" });

  // 新游戏：设置面板里点「新游戏」→「确认」。
  if (!(await page.locator("[data-new-game]").first().isVisible().catch(() => false))) await page.click("#settingsBtn");
  await page.locator("[data-new-game]").first().click();
  await page.locator("[data-confirm-save-action]").first().click();
  await page.waitForFunction(() => document.querySelector("#dateLabel")?.textContent?.includes("第1年"), null, { timeout: 15000 });

  for (const panel of ["build", "residents", "business", "policy", "gazette"]) {
    const openPanel = async () => {
      // 点已打开的标签会收起面板，所以没打开就再点一次。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await page.click(`.tab[data-panel="${panel}"]`, { force: true });
        if (await page.locator("#panelSurface:not([hidden])").count()) return;
      }
      await page.waitForSelector("#panelSurface:not([hidden])", { timeout: 3000 });
    };
    await openPanel();
    const buttons = () => page.locator("#panel button:not([disabled]):not([data-confirm-save-action])");
    const count = await buttons().count();
    let done = 0;
    // 点击会重绘面板、可用按钮数会变，所以每轮重新数。
    for (let i = 0; i < (await buttons().count()) && done < maxClicks; i += 1) {
      if (!(await page.locator("#panelSurface:not([hidden])").count())) await openPanel();
      const button = buttons().nth(i);
      if (!(await button.count())) break;
      const label = ((await button.innerText().catch(() => "")) || (await button.getAttribute("aria-label").catch(() => "")) || "").trim();
      if (SKIP.test(label)) continue;
      try {
        await button.click({ timeout: 2000 });
        done += 1;
        clicked += 1;
      } catch { /* 按钮被重绘掉了，跳过 */ }
    }
    console.log(`面板 ${panel}：按钮 ${count} 个，点击 ${done} 个`);
  }

  if (runMs > 0) {
    await page.click("#panelClose").catch(() => {});
    const speed = page.locator(".time-button:not(#pauseBtn):not(#settingsBtn)").last();
    await speed.click().catch(() => {});
    await page.waitForTimeout(runMs);
    await page.click("#pauseBtn").catch(() => {});
    console.log(`时间运行 ${runMs} 毫秒后：${await page.locator("#dateLabel").innerText()}`);
  }
} catch (error) {
  problems.push(`脚本失败: ${error.message}`);
} finally {
  await browser.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
  else console.log(`保留：${html}`);
}

console.log(`共点击 ${clicked} 个按钮，报错 ${problems.length} 条。`);
for (const line of [...new Set(problems)].slice(0, 20)) console.log("  " + line);
process.exit(problems.length ? 1 : 0);
