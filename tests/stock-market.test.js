import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { formCompany } from "./helpers-ipo.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import {
  settleStockMarketDay, stepSharePrice, shareTick, stockReference, suggestedSharePriceVoucher, SHARE_PRICE_DAILY_LIMIT
} from "../src/systems/stock-exchange.js";

// 股价模型：0.01 粮券一档、单日涨跌 ≤ 20%、偶发泡沫→破裂；没有上市公司时不消耗随机数。

const V = CONTENT.precision.currencyUnitsPerVoucher;
const TICK = shareTick(CONTENT);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function path(seed, days, { anchor = 2 * V, price = anchor, sentiment = 0 } = {}) {
  const uniform = rng(seed);
  const draw = { uniform, gauss: () => (uniform() + uniform() + uniform() - 1.5) / 0.5 };
  const market = { regime: "normal", daysLeft: 0, drift: 0, momentum: 0, anchorUnits: anchor };
  const rows = [];
  let current = price;
  for (let day = 0; day < days; day += 1) {
    const next = stepSharePrice(current, anchor, market, sentiment, draw, CONTENT);
    rows.push({ from: current, to: next, regime: market.regime });
    current = next;
  }
  return rows;
}

test("一档价是 0.01 粮券", () => {
  assert.equal(TICK, V / 100);
  assert.equal(suggestedSharePriceVoucher(0.5, 1000), 0.01, "建议价最低一档");
  assert.equal(suggestedSharePriceVoucher(1600, 2520), 0.63);
});

test("每天的股价都是一档的整数倍，涨跌幅不超过 20%（价格极低时最多动一档）", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const { from, to } of path(seed, 1500)) {
      assert.equal(to % TICK, 0, `股价 ${to} 不是一档整数倍`);
      assert.ok(to >= TICK);
      const limit = Math.max(TICK, Math.floor(from * SHARE_PRICE_DAILY_LIMIT / TICK) * TICK);
      assert.ok(Math.abs(to - from) <= limit, `涨跌 ${from}→${to} 超过 20%`);
    }
  }
});

test("会出现泡沫：价格持续脱离业绩锚上涨，之后破裂回落", () => {
  let bubbles = 0;
  let burst = 0;
  let highest = 0;
  for (let seed = 1; seed <= 60; seed += 1) {
    let previous = "normal";
    for (const row of path(seed, 3650)) {
      if (previous === "normal" && row.regime === "bubble") bubbles += 1;
      if (previous === "bubble" && row.regime === "crash") burst += 1;
      highest = Math.max(highest, row.to / (2 * V));
      previous = row.regime;
    }
  }
  assert.ok(bubbles >= 60, `十年里应常有泡沫，实际 ${bubbles} 次`);
  assert.ok(burst >= bubbles * 0.9, "泡沫都会破裂");
  assert.ok(highest > 1.8, `泡沫期价格应明显高于业绩锚，最高 ${highest.toFixed(2)} 倍`);
});

test("没有泡沫时价格围绕业绩锚波动，不会长期偏离", () => {
  const ratios = [];
  for (let seed = 1; seed <= 40; seed += 1) {
    const rows = path(seed, 3650);
    for (let i = 0; i < rows.length; i += 1) if (rows[i].regime === "normal" && i > 365) ratios.push(rows[i].to / (2 * V));
  }
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  assert.ok(median > 0.9 && median < 1.15, `常态价格中位数应接近业绩锚，实际 ${median.toFixed(2)} 倍`);
});

test("同一种子的股价走势可复现", () => {
  assert.deepEqual(path(9, 500).map(row => row.to), path(9, 500).map(row => row.to));
});

function listedState({ price = 2, seed = 4401 } = {}) {
  const state = legacyVoucherState({ seed });
  const required = CONTENT.buildings.saltworks.requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  state.buildings.push({ id: "mkt-salt", typeId: "saltworks", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } });
  assert.equal(simulation.issueGrainVouchers(state, "town", 50000).ok, true);
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  const formed = formCompany(state, "mkt-salt", { name: "盐业公司", levels: 1, operatingCapitalVoucher: 10000, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker: "061", totalShares: 1000, priceVoucherPerShare: price, offeredShares: 0 });
  assert.equal(listed.ok, true, listed.reason);
  return { state, company: state.companies[formed.companyId] };
}

test("挂牌价取整到一档；每日结算后股价仍是一档整数倍并记入走势", () => {
  const { state, company } = listedState({ price: 1.2345 });
  assert.equal(company.sharePriceVoucherUnits, 123 * TICK, "1.2345 取整为 1.23");
  for (let day = 0; day < 300; day += 1) {
    settleStockMarketDay(state, CONTENT);
    assert.equal(company.sharePriceVoucherUnits % TICK, 0);
  }
  assert.equal(company.sharePriceHistory.length, 30, "走势只留最近 30 天");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("老档里不是一档整数倍的旧股价，第一次结算时取整", () => {
  const { state, company } = listedState({ price: 2 });
  company.sharePriceVoucherUnits = 2 * V + 7;
  settleStockMarketDay(state, CONTENT);
  assert.equal(company.sharePriceVoucherUnits % TICK, 0);
});

test("没有上市公司时股市结算不消耗随机数", () => {
  const state = legacyVoucherState({ seed: 4402 });
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  const before = state.rng.state;
  assert.equal(settleStockMarketDay(state, CONTENT), null);
  assert.equal(state.rng.state, before);
});

test("合理价 = 年利润 ÷ 4%：按现价的年利润率 4% 算合理", () => {
  const { state, company } = listedState({ price: 2 });
  state.year = 1; state.day = 60;
  company.history = [];
  for (let serial = 1; serial <= 59; serial += 1) company.history.push({ serial, profitVoucherUnits: 10 * V, revenueVoucherUnits: 20 * V, soldUnits: 0 });
  const performance = stockReference(state, company, CONTENT);
  // 60 个观察日内每天 10 粮券 → 年化约 3650 粮券；合理总价 = 年利润 ÷ 4%。
  assert.equal(performance.validProfitMethod, true);
  assert.equal(performance.referenceCompanyValueVoucherUnits, Math.round(performance.annualizedProfitVoucherUnits * 100 / 4));
  assert.equal(performance.referencePerShareVoucherUnits, Math.floor(performance.referenceCompanyValueVoucherUnits / company.totalShares));
});

test("业绩锚跟着合理价走；观察够了仍不赚钱，锚缓慢下滑", () => {
  const { state, company } = listedState({ price: 2 });
  state.year = 1; state.day = 60;
  company.history = [];
  for (let serial = 1; serial <= 59; serial += 1) company.history.push({ serial, profitVoucherUnits: 10 * V, revenueVoucherUnits: 20 * V, soldUnits: 0 });
  settleStockMarketDay(state, CONTENT);
  assert.equal(company.stockMarket.anchorUnits, stockReference(state, company, CONTENT).referencePerShareVoucherUnits);
  company.history = company.history.map(row => ({ ...row, profitVoucherUnits: -V }));
  const before = company.stockMarket.anchorUnits;
  settleStockMarketDay(state, CONTENT);
  assert.ok(company.stockMarket.anchorUnits < before, "亏损公司的锚下滑");
});
