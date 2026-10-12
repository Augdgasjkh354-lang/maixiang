import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { recordEvent } from "../src/economy/ledger.js";
import { GAZETTE_NOTES_PER_YEAR, GAZETTE_ISSUE_LIMIT } from "../src/economy/gazette-notes.js";
import { buildGazette, settleGazetteYear, gazetteBytes, GAZETTE_BYTE_LIMIT } from "../src/systems/gazette.js";
import { selectFoodDays } from "../src/selectors/economy.js";
import { renderGazettePanel } from "../src/ui/panel-gazette.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { validateState } from "../src/core/validation.js";

const QEQ = CONTENT.precision.qeqUnitsPerJin;
const CALM = ["平安年，镇务如常。", "风调雨顺，日子照旧。", "无大事，便是好年成。"];

function fresh(opening = "blank") {
  return simulation.createInitialState({ seed: 91, opening });
}

// 年报的最小替身：只放镇报会读的字段。
function report(year, over = {}) {
  return {
    summaryVersion: 1, year, harvestQeq: 0, populationAfterAging: 6600,
    wealth: { gini: 0.1 }, companies: {}, shops: {}, industries: {}, stampDuty: {},
    ...over
  };
}

// 把镇库小麦调到指定的口粮年数（镇库口粮天数与小麦数量成正比，先量一个比例）。
function setTownYears(state, years) {
  const townDays = () => selectFoodDays(state, CONTENT, true) - selectFoodDays(state, CONTENT, false);
  const probe = 1000000;
  state.accounts.town.wheat = probe;
  const perUnit = townDays() / probe;
  state.accounts.town.wheat = (years * CONTENT.rules.daysPerYear) / perUnit;
}

// 在 state 里放上一期“上一年”的年报，再用 current 作为本年报，返回 buildGazette 的结果。
function gazetteFor(state, current, previous = null) {
  state.annualReports = [...(previous ? [previous] : []), current];
  return buildGazette(state, CONTENT, { report: current });
}

test("recordEvent 默认不存储：没有 gazette 标记的消息不进任何地方", () => {
  const state = fresh();
  recordEvent(state, "一条普通消息", CONTENT);
  assert.equal("events" in state, false, "state.events 已取消");
  assert.equal(state.gazette.notes.length, 0);
});

test("recordEvent 带 gazette 标记的写入素材库（年、日、类别、权重、文字）", () => {
  const state = fresh();
  recordEvent(state, "小事一件", CONTENT, { gazette: { kind: "shop", weight: 2 } });
  assert.deepEqual(state.gazette.notes, [{ year: 1, day: 1, kind: "shop", weight: 2, text: "小事一件" }]);
});

test("素材库每年最多 40 条：满了替换掉权重最低的，同权重不替换", () => {
  const state = fresh();
  for (let i = 0; i < GAZETTE_NOTES_PER_YEAR; i += 1) {
    recordEvent(state, "平常" + i, CONTENT, { gazette: { kind: "x", weight: 1 } });
  }
  assert.equal(state.gazette.notes.length, GAZETTE_NOTES_PER_YEAR);
  recordEvent(state, "同权重不替换", CONTENT, { gazette: { kind: "x", weight: 1 } });
  assert.equal(state.gazette.notes.some(note => note.text === "同权重不替换"), false);
  recordEvent(state, "大事", CONTENT, { gazette: { kind: "built", weight: 6 } });
  assert.equal(state.gazette.notes.length, GAZETTE_NOTES_PER_YEAR);
  assert.equal(state.gazette.notes.filter(note => note.weight === 1).length, GAZETTE_NOTES_PER_YEAR - 1);
  assert.ok(state.gazette.notes.some(note => note.text === "大事"));
});

test("头条：人口跨过整万时写人口", () => {
  const state = fresh();
  const prev = report(1, { populationAfterAging: 9000 });
  const now = report(2, { populationAfterAging: 10050 });
  const { issue } = gazetteFor(state, now, prev);
  assert.match(issue.headline, /人丁兴旺|户口簿|生齿日繁/);
});

test("头条：歉收（低于上年 15%）与收成创新高", () => {
  const state = fresh();
  setTownYears(state, 1.5);
  const prev = report(1, { harvestQeq: 100 * QEQ });
  const bad = gazetteFor(state, report(2, { harvestQeq: 50 * QEQ }), prev).issue;
  assert.match(bad.headline, /歉收|秋风早来|田里欠收/);
  const earlier = report(1, { harvestQeq: 10 * QEQ });
  const good = gazetteFor(state, report(3, { harvestQeq: 300 * QEQ }), report(2, { harvestQeq: 100 * QEQ })).issue;
  assert.match(good.headline, /秋收创新高|金黄满田|仓门推不开/);
  assert.ok(earlier.year === 1);
});

test("头条：仓粮告急（镇库小麦不足半年口粮）", () => {
  const state = fresh();
  setTownYears(state, 0.2);
  const { issue } = gazetteFor(state, report(1));
  assert.match(issue.headline, /仓粮告急|粮仓见底|镇库存粮不多/);
});

test("无大事：头条用“平安年”模板", () => {
  const state = fresh();
  setTownYears(state, 1.5);
  const { issue } = gazetteFor(state, report(1));
  assert.ok(CALM.includes(issue.headline), `头条应为平安年模板，实际：${issue.headline}`);
});

test("物价栏：涨跌幅榜数字来自状态（面粉 1.80 → 2.70 为 +50%）", () => {
  const state = fresh();
  setTownYears(state, 1.5);
  state.wholesaleMarket.pricesVoucherPerUnit.flour = 2.7;
  const { issue } = gazetteFor(state, report(1));
  const prices = issue.sections.find(section => section.title === "市井物价");
  assert.ok(prices, "应有市井物价栏");
  assert.equal(prices.lines[0], `${CONTENT.items.flour.name}+50.0%：1.80→2.70券/斤`);
});

test("没有上市公司则没有股市栏", () => {
  const state = fresh();
  setTownYears(state, 1.5);
  const { issue } = gazetteFor(state, report(1));
  assert.equal(issue.sections.some(section => section.title === "股市简讯"), false);
});

test("确定性：同状态两次生成逐字相同，且不消耗随机数、不改状态", () => {
  const state = fresh();
  setTownYears(state, 2);
  const current = report(1, { harvestQeq: 40 * QEQ });
  state.annualReports = [current];
  const rngBefore = JSON.stringify(state.rng);
  const snapshot = JSON.stringify(state);
  const first = buildGazette(state, CONTENT, { report: current });
  const second = buildGazette(state, CONTENT, { report: current });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(state.rng), rngBefore, "随机数状态不变");
  assert.equal(JSON.stringify(state), snapshot, "生成镇报是纯读取");
});

test("settleGazetteYear：存入 issues，超过 12 期只留最近 12 期，清空当年要闻、更新快照", () => {
  const state = fresh();
  setTownYears(state, 1.5);
  recordEvent(state, "斗兽场落成，可以安排工人开工了。", CONTENT, { gazette: { kind: "built", weight: 6 } });
  for (let year = 1; year <= GAZETTE_ISSUE_LIMIT + 2; year += 1) {
    const current = report(year);
    state.annualReports.push(current);
    settleGazetteYear(state, CONTENT, current);
    assert.deepEqual(state.gazette.notes, [], "年终后要闻清空");
  }
  assert.equal(state.gazette.issues.length, GAZETTE_ISSUE_LIMIT);
  assert.equal(state.gazette.issues[0].year, 3);
  assert.equal(state.gazette.issues.at(-1).year, GAZETTE_ISSUE_LIMIT + 2);
  assert.equal(state.gazette.marks.year, GAZETTE_ISSUE_LIMIT + 2);
  assert.ok(state.gazette.issues.every(issue => gazetteBytes(issue) < GAZETTE_BYTE_LIMIT), "每期 <3KB");
});

test("[slow] 日结跑满一年：年终生成第 1 期，未读；读后不再未读；状态合法", () => {
  const state = simulation.createInitialState({ seed: 91, opening: "standard" });
  simulation.advanceDays(state, CONTENT.rules.daysPerYear + 1);
  assert.equal(state.gazette.issues.length, 1);
  const [issue] = state.gazette.issues;
  assert.equal(issue.year, 1);
  assert.ok(issue.headline.length > 0);
  assert.ok(gazetteBytes(issue) < GAZETTE_BYTE_LIMIT);
  const view = simulation.selectDashboard(state, { panel: "gazette" });
  assert.equal(view.gazette.unread, true);
  assert.equal(view.gazette.latest.year, 1);
  assert.equal(view.gazette.archive.length, 1);
  state.gazette.readYear = 1;
  assert.equal(simulation.selectDashboard(state, { panel: "gazette" }).gazette.unread, false);
  assert.deepEqual(validateState(state, CONTENT).errors, []);
});

test("selectDashboard 的 gazette 只读：不改状态，往期新的在前", () => {
  const state = fresh();
  setTownYears(state, 1.5);
  for (let year = 1; year <= 3; year += 1) settleGazetteYear(state, CONTENT, report(year));
  const snapshot = JSON.stringify(state);
  const view = simulation.selectDashboard(state, { panel: "gazette" });
  assert.equal(JSON.stringify(state), snapshot);
  assert.deepEqual(view.gazette.archive.map(issue => issue.year), [3, 2, 1]);
  assert.equal(view.gazette.unread, true);
});

test("旧档读入：丢弃 state.events，镇报与开局横幅用底板", () => {
  const raw = JSON.parse(JSON.stringify(fresh()));
  delete raw.gazette;
  delete raw.openingHint;
  raw.events = [{ year: 1, day: 1, text: "旧事件" }];
  const loaded = migrateSave(raw, CONTENT);
  assert.equal("events" in loaded, false);
  assert.deepEqual(loaded.gazette.issues, []);
  assert.equal(loaded.gazette.readYear, 0);
  assert.equal(loaded.openingHint, null);
});

test("开局横幅：标准开局有提示，空白开局没有", () => {
  assert.match(fresh("standard").openingHint, /新任镇长上任.*就业面板设人数/);
  assert.equal(fresh("blank").openingHint, null);
});

test("validateState 不再校验 events，但坏的镇报结构要报错", () => {
  const state = fresh();
  assert.deepEqual(validateState(state, CONTENT).errors, []);
  state.gazette = { notes: "坏", issues: [] };
  assert.ok(validateState(state, CONTENT).errors.includes("镇报素材库结构无效"));
});

test("镇报面板：默认最新一期、点期号翻阅、正文转义", () => {
  const state = fresh();
  setTownYears(state, 1.5);
  settleGazetteYear(state, CONTENT, report(1));
  const issue = { ...state.gazette.issues[0], headline: "<b>坏</b>" };
  const view = { gazette: { archive: [issue] } };
  const html = renderGazettePanel(view, null);
  assert.match(html, /data-gazette-issue="1"/);
  assert.match(html, /&lt;b&gt;坏&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>坏<\/b>/);
  assert.match(renderGazettePanel({ gazette: { archive: [] } }), /镇报还未出版/);
});
