import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { selectInequality } from "../src/selectors/inequality.js";
import { renderPolicy } from "../src/ui/panel-policy.js";
import { renderSite } from "../src/ui/panel-site.js";

// 银行与国债的控件搬进银行建筑面板（政策页只留摘要与「前往银行」）。

function bankTown(seed) {
  const state = simulation.createInitialState({ seed });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({ id: "bank-ui", typeId: "bank", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return state;
}

function bankSiteView(state) {
  return simulation.selectDashboard(state, { panel: "site", site: "building:bank-ui" });
}

function policyView(state) {
  return { ...simulation.selectDashboard(state, { panel: "policy" }), inequality: selectInequality(state, CONTENT), numericDrafts: {} };
}

test("银行面板：利率、准备金率、印券与国债控件都在银行建筑面板里", () => {
  const state = bankTown(9101);
  const html = renderSite(bankSiteView(state));
  for (const key of ["bank-deposit-rate", "bank-loan-rate", "bank-reserve", "bond-issue-total", "bond-issue-years", "bond-issue-rate", "employment-exchange", "currency-amount"]) {
    assert.ok(html.includes(`data-draft-key="${key}"`), `银行面板应包含 ${key}`);
  }
  assert.ok(html.includes("data-bond-issue"), "国债发行按钮应在银行面板");
  assert.ok(html.includes("data-currency-preview=\"issue\""), "印券按钮应在银行面板");
});

test("银行面板：三个折叠分组，印券默认展开，摘要带关键数字", () => {
  const state = bankTown(9102);
  const html = renderSite(bankSiteView(state));
  assert.match(html, /data-detail-key="bank-issue"[^>]* open>/, "印券与换券默认展开");
  assert.doesNotMatch(html, /data-detail-key="bank-rates"[^>]* open>/, "利率与存款默认收起");
  assert.doesNotMatch(html, /data-detail-key="bank-bonds"[^>]* open>/, "国债默认收起");
  assert.ok(html.includes("<span>利率与存款</span>"));
  assert.ok(html.includes("<span>国债</span>"));
  assert.ok(html.includes("在售 0 笔"), "国债摘要应给出在售笔数");
  assert.ok(html.includes("存款 2% · 贷款 6%"), "利率摘要应给出存贷款利率");
  for (const label of ["当前制度", "镇库券池", "发行量", "存款总额", "贷款总额"]) {
    assert.ok(html.includes(`<span class="label">${label}</span>`), `摘要卡应有「${label}」`);
  }
});

test("政策页：不再包含银行与国债折叠块，只留摘要和前往银行按钮", () => {
  const state = bankTown(9103);
  const html = renderPolicy(policyView(state));
  assert.ok(!html.includes(`data-detail-key="policy-bank"`), "政策页不应有银行折叠块");
  assert.ok(!html.includes(`data-detail-key="policy-bonds"`), "政策页不应有国债折叠块");
  assert.ok(!html.includes(`data-draft-key="bank-deposit-rate"`), "政策页不应有存款利率输入框");
  assert.ok(!html.includes(`data-bond-issue`), "政策页不应有国债发行按钮");
  assert.ok(html.includes("存款 2% · 贷款 6% · 国债 0 笔"), "政策页应有一行银行摘要");
  assert.ok(html.includes("前往银行") && html.includes("data-bank-open"), "政策页应有前往银行按钮");
});

test("政策页：粮券阶段的货币改革是默认可见的一行，不藏在折叠里", () => {
  const state = bankTown(9104);
  const html = renderPolicy(policyView(state));
  assert.ok(!html.includes(`data-detail-key="policy-reform"`), "粮券阶段不应折叠货币改革");
  assert.ok(html.includes("进入银行管理"), "货币改革应带进入银行管理按钮");
});

test("没有银行时：政策页提示需先建成银行，不出现前往银行按钮", () => {
  const state = simulation.createInitialState({ seed: 9105 });
  const html = renderPolicy(policyView(state));
  assert.ok(html.includes("国债：建成银行后可发行。"));
  assert.ok(!html.includes("前往银行"));
  assert.ok(!html.includes("data-bank-open"));
});
