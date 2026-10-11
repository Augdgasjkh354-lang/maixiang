// 存档压缩（gzip，CompressionStream / DecompressionStream）。浏览器与 Node 18+ 都有；
// 没有时调用方回退到明文（存档）或禁用压缩导出（界面）。不依赖任何第三方库。

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export function gzipSupported() {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function" &&
    typeof Blob === "function" && typeof Response === "function";
}

export function isGzipBytes(bytes) {
  return Boolean(bytes) && bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

async function pipeBytes(bytes, transform) {
  const readable = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(readable).arrayBuffer());
}

export async function gzipText(text) {
  return pipeBytes(new TextEncoder().encode(text), new CompressionStream("gzip"));
}

export async function gunzipToBytes(bytes) {
  return pipeBytes(bytes, new DecompressionStream("gzip"));
}

export async function gunzipToText(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(await gunzipToBytes(bytes));
}
