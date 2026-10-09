import test from "node:test";
import assert from "node:assert/strict";
import { number, numberMax } from "../src/ui/format.js";

// number / numberMax 改为缓存 Intl.NumberFormat 后，输出必须与原来的 Number#toLocaleString 逐字一致。
const VALUES = [0, -0, 1, -1, 0.5, -0.5, 0.005, 1.005, 1.5, 2.5, -2.5, 0.1 + 0.2, -0.0001,
  1234.5, -1234.5, 12345678.9, 99999.999, 1e6, 1e15, 1e21, 123456789012.345,
  NaN, Infinity, -Infinity, undefined, null, "", "12.5", "abc", false, true];
const DIGITS = [undefined, null, 0, 1, 2, 3, 4];

function referenceNumber(value, digits) {
  const precision = digits ?? 0;
  return Number(value || 0).toLocaleString("zh-CN", {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision
  });
}

function referenceNumberMax(value, digits = 1) {
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

test("number 与原 toLocaleString 输出逐字一致", () => {
  for (const digits of DIGITS) {
    for (const value of VALUES) {
      assert.equal(number(value, digits), referenceNumber(value, digits), `number(${String(value)}, ${digits})`);
    }
  }
});

test("numberMax 与原 toLocaleString 输出逐字一致（含默认精度）", () => {
  for (const digits of [undefined, 0, 1, 2, 3]) {
    for (const value of VALUES) {
      assert.equal(numberMax(value, digits), referenceNumberMax(value, digits), `numberMax(${String(value)}, ${digits})`);
    }
  }
});

test("number 与 numberMax 的缓存互不干扰（同精度最小小数位不同）", () => {
  assert.equal(number(1.5, 2), "1.50");
  assert.equal(numberMax(1.5, 2), "1.5");
  assert.equal(number(1.5, 2), "1.50");
  assert.equal(numberMax(1.5), "1.5");
  assert.equal(number(1234.5, 1), "1,234.5");
  assert.equal(number(0), "0");
});
