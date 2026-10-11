// 挂牌建议价与业绩锚同口径：经营权估值 × 倍数（业绩锚市盈率 ÷ 经营权回本年数），见 stock-exchange.js 的 listingValuationMultiple。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { currencyScale } from "../src/economy/currency.js";
import { buildingMaterialValueUnits } from "../src/systems/ownership.js";
import {
  buildingValuationVoucher, listingValuationMultiple, settleStockMarketDay, stockReference, suggestedSharePriceVoucher
} from "../src/systems/stock-exchange.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const S = currencyScale(CONTENT);
const T = 2520; // 默认总股本（2 级整除）

function freePlot(state, feature = null) {
  return state.plots.find(row => (feature ? row.feature === feature : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
}

// 交易所已建成的粮券阶段；镇库有批发市场（盐的理论利润需要市场价）。
function exchangeTown(seed) {
  const state = legacyVoucherState({ seed });
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  addBuilding(state, "wholesale_market", "market");
  return state;
}

function addBuilding(state, typeId, id, { level = 1 } = {}) {
  const feature = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = freePlot(state, feature);
  const building = { id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } };
  state.buildings.push(building);
  return building;
}

// 2 级盐场、12 人在岗：有正的理论经营权估值。
function staffedSalt(seed) {
  const state = exchangeTown(seed);
  const salt = addBuilding(state, "saltworks", "salt", { level: 2 });
  simulation.setEmployment(state, `${salt.id}::${CONTENT.buildings.saltworks.jobs[0].id}`, 12);
  return { state, salt };
}

test("挂牌倍数 = 业绩锚市盈率（100 ÷ 4 = 25）÷ 经营权回本年数（5）= 5；倍数随合理利润率变化", () => {
  assert.equal(listingValuationMultiple(CONTENT), 5);
  const at = yieldPercent => listingValuationMultiple({ ...CONTENT, rules: { ...CONTENT.rules, stockFairYieldPercent: yieldPercent } });
  assert.equal(at(2), 10, "合理利润率 2% → 市盈率 50 → 倍数 10");
  assert.equal(at(8), 2.5, "合理利润率 8% → 市盈率 12.5 → 倍数 2.5");
  assert.equal(listingValuationMultiple({ ...CONTENT, rules: { ...CONTENT.rules, stockFairYieldPercent: undefined } }), 5, "缺省利润率回退 4%");
});

test("有经营权估值的建筑：挂牌估值 = 经营权估值 × 5，建议每股价 = 估值 ÷ 总股本", () => {
  const { state, salt } = staffedSalt(7201);
  const preview = simulation.selectOperatingRightPreview(state, salt.id);
  assert.ok(preview.valuationWheatJin > 0, "盐场应有正的经营权估值");
  const valuation = buildingValuationVoucher(state, salt.id, CONTENT);
  assert.equal(valuation, preview.valuationWheatJin * 5);
  // 与股价业绩锚同口径：挂牌估值折成总价 ÷ 总股本 ≈ 年理论利润 × 100 ÷ 4 ÷ 总股本。
  assert.equal(valuation, preview.theoreticalAnnualProfitWheatJin * 25);
  assert.equal(suggestedSharePriceVoucher(valuation, T), Math.round(valuation / T * 100) / 100);

  const listed = simulation.listBuilding(state, salt.id, { ticker: "010" });
  assert.equal(listed.ok, true, listed.reason);
  assert.equal(listed.totalShares, T);
  assert.equal(listed.priceVoucherUnits / S, suggestedSharePriceVoucher(valuation, T), "挂牌默认价即建议价");
});

test("无利润信息的新建筑仍按建造材料价值估，不乘倍数", () => {
  const state = exchangeTown(7202);
  const mill = addBuilding(state, "mill", "new-mill", { level: 1 });
  const preview = simulation.selectOperatingRightPreview(state, mill.id);
  assert.equal(preview.valuationWheatJin, 0, "未配工人、无经营记录，经营权估值为 0");
  const material = buildingMaterialValueUnits(state, mill, CONTENT) / S;
  assert.ok(material > 0);
  assert.equal(buildingValuationVoucher(state, mill.id, CONTENT), material, "回退为建造材料价值，不乘 5");
  const listed = simulation.listBuilding(state, mill.id, { ticker: "011" });
  assert.equal(listed.ok, true, listed.reason);
  assert.equal(listed.priceVoucherUnits / S, suggestedSharePriceVoucher(material, T));
});

test("倍数随 stockFairYieldPercent 变化：估值 ÷ 年理论利润 = 100 ÷ 合理利润率", () => {
  const { state, salt } = staffedSalt(7203);
  const preview = simulation.selectOperatingRightPreview(state, salt.id);
  for (const yieldPercent of [2, 4, 8]) {
    const content = { ...CONTENT, rules: { ...CONTENT.rules, stockFairYieldPercent: yieldPercent } };
    const valuation = buildingValuationVoucher(state, salt.id, content);
    assert.ok(Math.abs(valuation / preview.theoreticalAnnualProfitWheatJin - 100 / yieldPercent) < 1e-6,
      `利润率 ${yieldPercent}%：估值应为年利润 × ${100 / yieldPercent}`);
  }
});

test("上市后首个有业绩日：业绩锚与挂牌价的比值落在 0.5–2（改前约 9.5）", () => {
  // 实际利润 = 理论年利润 × k 时，业绩参考价 ÷ 挂牌价 应约等于 k（挂牌按理论、业绩按实际，同为 25 倍市盈率）。
  for (const k of [1, 1.9]) {
    const { state, salt } = staffedSalt(7204);
    const listed = simulation.listBuilding(state, salt.id, { ticker: "010" });
    assert.equal(listed.ok, true, listed.reason);
    const company = state.companies[listed.companyId];
    const listPerShare = company.stockMarket.listingUnits;
    const theoreticalAnnual = simulation.selectOperatingRightPreview(state, salt.id, CONTENT).theoreticalAnnualProfitWheatJin;
    // 造 31 天的日利润（常数，窗口观察天数含当天 = 32 天），使年化利润 = k × 理论年利润（单位：分）。
    const daysYear = CONTENT.rules.daysPerYear || 360;
    state.year = 1;
    state.day = 40;
    const rows = 31;
    const observed = 40 - (40 - rows) + 1;
    const annualUnits = k * theoreticalAnnual * S;
    const dailyProfit = Math.round(annualUnits * observed / (rows * daysYear));
    company.history = [];
    for (let serial = 40 - rows; serial < 40; serial += 1) {
      company.history.push({ serial, profitVoucherUnits: dailyProfit, revenueVoucherUnits: dailyProfit * 2 });
    }
    company.accounts ||= {};
    company.accounts.day = { profitVoucherUnits: 0, revenueVoucherUnits: 0 };
    const reference = stockReference(state, company, CONTENT);
    assert.equal(reference.validProfitMethod, true, `k=${k} 应已有有效业绩`);
    const ratio = reference.referencePerShareVoucherUnits / listPerShare;
    assert.ok(ratio >= 0.5 && ratio <= 2, `k=${k}：业绩参考价 ÷ 挂牌价 = ${ratio.toFixed(3)}，应落在 0.5–2`);
    assert.ok(Math.abs(ratio - k) < 0.05, `k=${k}：比值应接近实际 ÷ 理论利润 ${k}，实际 ${ratio.toFixed(3)}`);
    // 业绩锚逐日逼近（每天最多 4%），首个有业绩日的一步不会跳到 9 倍。
    settleStockMarketDay(state, CONTENT);
    const anchorRatio = company.stockMarket.anchorUnits / listPerShare;
    assert.ok(anchorRatio >= 0.95 && anchorRatio <= 1.05, `首日业绩锚只能逐步移动，实际 ${anchorRatio.toFixed(3)}`);
  }
});
