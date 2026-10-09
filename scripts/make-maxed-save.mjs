// scripts/make-maxed-save.mjs
// 生成满级测试存档：tests/fixtures/maxed-save.json（用途与做法见 scripts/maxed-state.mjs）。
// 产物是纯 state JSON（格式同 storage.js 的 exportState），界面“导入存档”与 parseSaveFile 都能读回。
// 用法：node scripts/make-maxed-save.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMaxedState } from "./maxed-state.mjs";
import { exportState } from "../src/persistence/storage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(root, "tests/fixtures/maxed-save.json");

const state = createMaxedState();
mkdirSync(dirname(outPath), { recursive: true });
const text = exportState(state);
writeFileSync(outPath, text);
console.log(`满级测试存档已写入 ${outPath}（${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MB，第 ${state.year} 年第 ${state.day} 天）`);
