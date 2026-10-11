import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { simulation } from "../src/engine.js";
import { renderSite } from "../src/ui/panel-site.js";

// 银行面板：金额统一两位小数；窄屏样式允许数值折行，避免 360px 横向溢出。

function bankTown(seed) {
  const state = simulation.createInitialState({ seed });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({ id: "bank-fmt", typeId: "bank", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return state;
}

function bankHtml(seed) {
  const state = bankTown(seed);
  return renderSite(simulation.selectDashboard(state, { panel: "site", site: "building:bank-fmt" }));
}

const CSS = readFileSync(fileURLToPath(new URL("../src/styles/main.css", import.meta.url)), "utf8");

test("银行面板：摘要金额统一为两位小数，没有一位小数的「券」", () => {
  const html = bankHtml(9201);
  const oneDecimalVoucher = html.match(/\d[\d,]*\.\d券/g) || [];
  assert.deepEqual(oneDecimalVoucher, [], "银行面板不应出现一位小数的券金额");
  assert.ok(html.includes("存款总额</span><strong class=\"value\">0.00券"), "存款总额应为 0.00券");
  assert.ok(html.includes("闲置现金</span><strong class=\"value\">0.00券"), "闲置现金应为 0.00券");
});

test("银行面板：欠镇库的累计垫付、累计还款、可还拆成独立一行，数值行不再塞长括号", () => {
  const html = bankHtml(9202);
  assert.ok(html.includes("<strong class=\"value\">0.00券</strong></div>"), "欠镇库数值行只放欠额");
  assert.ok(/<div class="subtle">累计垫付 0\.00券 · 累计还款 0\.00券 · 可还 0\.00券<\/div>/.test(html), "累计明细应在单独的 subtle 行");
});

test("银行面板：镇库 / 居民资金的手头与存款明细移到 subtle 行", () => {
  const html = bankHtml(9203);
  assert.ok(/<div class="subtle">居民资金：手头 [\d,.]+ \+ 存款 [\d,.]+粮券<\/div>/.test(html), "资金明细应为独立 subtle 行");
  assert.ok(!/<strong class="value">[^<]*<small/.test(html), "数值行内不再嵌套 small 明细");
});

test("银行面板：窄屏（430px 以下）允许数值与输入行折行，桌面规则保持不变", () => {
  const mobile = CSS.match(/@media \(max-width: 430px\) \{[^@]*?\.bank-summary \.value[\s\S]*?\n\}/);
  assert.ok(mobile, "应存在针对银行面板的窄屏媒体规则");
  assert.match(mobile[0], /\.bank-summary \.row, \.bank-groups \.row \{ flex-wrap: wrap; \}/, "标签行应可折行");
  assert.match(mobile[0], /\.bank-summary \.value, \.bank-groups \.value \{ white-space: normal;/, "窄屏数值应允许折行");
  assert.match(mobile[0], /\.setting-input \{ flex-wrap: wrap;/, "输入与偿还按钮应可折行");
  assert.match(CSS, /\.bank-summary \.value, \.bank-groups \.value \{ white-space: nowrap; \}/, "桌面数值仍为 nowrap");
});
