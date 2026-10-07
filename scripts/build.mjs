import { access, cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "index.html"), path.join(output, "index.html"));
await cp(path.join(root, "src"), path.join(output, "src"), { recursive: true });
const publicDir = path.join(root, "public");
if (await exists(publicDir)) await cp(publicDir, path.join(output, "public"), { recursive: true });
console.log("构建完成：dist/（浏览器原生 ES modules，无第三方运行时依赖）");
