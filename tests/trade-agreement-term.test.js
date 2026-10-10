import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount, householdIdleWorkers, householdList } from "../src/systems/households.js";
import { settleTradeAgreementsMonth, agreementMonthlyDueJin } from "../src/systems/trade-agreements.js";
import { exportReserveJin, settleTradingHouses } from "../src/systems/trading-houses.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const DAYS_PER_YEAR = CONTENT.rules.daysPerYear;

function freePlot(state, feature = null) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => !used.has(row.id) && (feature ? row.feature === feature : !row.feature));
  assert.ok(plot, "需要空地");
  return plot;
}

function addBuilding(state, id, typeId, feature = null) {
  const plot = freePlot(state, feature);
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
}

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

// 外贸房在岗、批发市场、盐存货充足、运力给足；在 (year, day) 签一笔盐长协（年 1200 斤，月交 100 斤）。
function agreementState(seed, { year = 1, day = 1, years = 1 } = {}) {
  const state = simulation.createInitialState({ seed });
  state.year = year;
  state.day = day;
  addBuilding(state, "ftrade", "foreign_trade_house");
  setJobCount(state, "ftrade::trade_staff", 2, CONTENT);
  addBuilding(state, "wm1", "wholesale_market");
  state.wholesaleMarket.inventory.salt = 10000 * I;
  state.logistics.poolJin = 1000000;
  const signed = simulation.signTradeAgreement(state, { itemId: "salt", annualJin: 1200, years });
  assert.equal(signed.ok, true, signed.reason);
  return { state, agreement: state.tradeAgreements[0] };
}

// 从签约那天起逐日调用月结算（与日结流水线一致），库存与运力每天补足，只观察期限。返回结算次数。
function runUntilExpired(state, agreement, maxDays = DAYS_PER_YEAR * 6) {
  let settlements = 0;
  for (let i = 0; i < maxDays && agreement.status === "active"; i++) {
    state.wholesaleMarket.inventory.salt = 10000 * I;
    state.logistics.poolJin = 1000000;
    state.outsideTowns[agreement.townId].wheatStockJin = 1e9;
    const result = settleTradeAgreementsMonth(state, CONTENT);
    if (result.settled) settlements += 1;
    state.day += 1;
    if (state.day >= DAYS_PER_YEAR) {
      state.day = 0;
      state.year += 1;
    }
  }
  return settlements;
}

test("期限按结算月计：N 年合约履约满 12N 个月，与签约是第 0 天、第 1 天还是第 359 天无关", () => {
  const cases = [
    { day: 0, years: 1 }, { day: 1, years: 1 }, { day: 359, years: 1 },
    { day: 0, years: 2 }, { day: 1, years: 2 }, { day: 359, years: 2 }
  ];
  for (const [index, { day, years }] of cases.entries()) {
    const { state, agreement } = agreementState(9100 + index, { year: 1, day, years });
    const settlements = runUntilExpired(state, agreement);
    assert.equal(agreement.status, "expired", `第${day}天签${years}年期应到期`);
    assert.equal(settlements, 12 * years, `第${day}天签${years}年期应结算 ${12 * years} 次，实际 ${settlements}`);
    assert.ok(Math.abs(agreement.totalDeliveredJin - 100 * 12 * years) < 0.01, `交付 ${100 * 12 * years} 斤，实际 ${agreement.totalDeliveredJin}`);
    assert.equal(agreement.breachCount, 0, "每月都按时交付，不违约");
    assert.ok(state.events.some(event => event.text.includes("长期协定已到期")), "到期写事件");
    assertValid(state, `第${day}天签${years}年期到期后`);
  }
});

test("旧档只有 yearsLeft（没有 monthsLeft）：按年折成月，仍履约满 12 个月", () => {
  const { state, agreement } = agreementState(9120, { year: 2, day: 100, years: 1 });
  delete agreement.monthsLeft;
  agreement.yearsLeft = 1;
  const settlements = runUntilExpired(state, agreement);
  assert.equal(agreement.status, "expired");
  assert.equal(settlements, 12);
  assertValid(state, "旧档到期后");
});

test("库存不足：能交的部分照常交付，短缺一截算一次违约，赔偿按未交占比折算", () => {
  const { state, agreement } = agreementState(9130, { day: 1 });
  state.wholesaleMarket.inventory.salt = 60 * I;
  state.accounts.town.wheat = 1000000 * I;
  const town = state.outsideTowns[agreement.townId];
  town.wheatStockJin = 1e9;
  const relationsBefore = town.relations;
  const wheatBefore = state.accounts.town.wheat;
  const result = settleTradeAgreementsMonth(state, CONTENT);
  assert.equal(result.delivered, 1, "能交的 60 斤照常交付");
  assert.equal(result.breached, 1, "短缺的 40 斤算一次违约");
  assert.ok(Math.abs(agreement.totalDeliveredJin - 60) < 0.01, `交付 60 斤，实际 ${agreement.totalDeliveredJin}`);
  assert.equal(agreement.breachCount, 1);
  // 关系分 −5（成交本身还会有极小的增益，所以只看量级）。
  assert.ok(Math.abs(town.relations - (relationsBefore - 5)) < 0.5, `关系分约 −5，实际变化 ${town.relations - relationsBefore}`);
  // 赔偿 = 年货值 × 10% × 未交占比（40/100）。
  const expectedPenaltyJin = agreement.annualJin * agreement.pricePerUnit * 0.1 * 0.4;
  const paidJin = result.revenueJin - (state.accounts.town.wheat - wheatBefore) / I;
  assert.ok(Math.abs(paidJin - expectedPenaltyJin) < 0.05, `赔偿约 ${expectedPenaltyJin.toFixed(2)} 斤，实际 ${paidJin.toFixed(2)}`);
  assert.ok(state.events.some(event => event.text.includes("库存不足") && event.text.includes("只交付60斤")), "事件写明库存不足与实交量");
  assert.equal(state.wholesaleMarket.inventory.salt, 0, "批发库存被取完");
  assertValid(state, "库存不足的部分交付后");
});

test("库存完全没有：整月未交，赔偿为年货值 10%，与原来的整月违约一致", () => {
  const { state, agreement } = agreementState(9131, { day: 1 });
  state.wholesaleMarket.inventory.salt = 0;
  state.accounts.town.wheat = 1000000 * I;
  state.outsideTowns[agreement.townId].wheatStockJin = 1e9;
  const wheatBefore = state.accounts.town.wheat;
  const result = settleTradeAgreementsMonth(state, CONTENT);
  assert.equal(result.delivered, 0);
  assert.equal(result.breached, 1);
  assert.equal(agreement.breachCount, 1);
  assert.equal(agreement.totalDeliveredJin, undefined);
  const expectedPenaltyJin = agreement.annualJin * agreement.pricePerUnit * 0.1;
  const paidJin = (wheatBefore - state.accounts.town.wheat) / I;
  assert.ok(Math.abs(paidJin - expectedPenaltyJin) < 0.05, `整月违约赔偿约 ${expectedPenaltyJin.toFixed(2)} 斤，实际 ${paidJin.toFixed(2)}`);
  assert.ok(state.events.some(event => event.text.includes("未能交付")), "事件写明未能交付");
  assertValid(state, "整月违约后");
});

test("运力不足按同一口径：运力余量先于库存用完，未交部分占比折算赔偿", () => {
  const { state, agreement } = agreementState(9132, { day: 1 });
  state.logistics.poolJin = 40;
  state.accounts.town.wheat = 1000000 * I;
  state.outsideTowns[agreement.townId].wheatStockJin = 1e9;
  const wheatBefore = state.accounts.town.wheat;
  const result = settleTradeAgreementsMonth(state, CONTENT);
  assert.equal(result.delivered, 1);
  assert.equal(result.breached, 1);
  assert.ok(Math.abs(agreement.totalDeliveredJin - 40) < 0.01);
  const expectedPenaltyJin = agreement.annualJin * agreement.pricePerUnit * 0.1 * 0.6;
  const paidJin = result.revenueJin - (state.accounts.town.wheat - wheatBefore) / I;
  assert.ok(Math.abs(paidJin - expectedPenaltyJin) < 0.05, `赔偿约 ${expectedPenaltyJin.toFixed(2)} 斤，实际 ${paidJin.toFixed(2)}`);
  assert.ok(state.events.some(event => event.text.includes("运力不足")), "事件写明运力不足");
  assertValid(state, "运力不足的部分交付后");
});

test("出口保留量 = 保本线 + 同品长协本月应交（含顺延），只影响同一商品", () => {
  const { state, agreement } = agreementState(9140, { day: 1 });
  assert.equal(agreementMonthlyDueJin(state, "salt"), 100);
  assert.equal(agreementMonthlyDueJin(state, "wood"), 0, "别的商品不算");
  assert.equal(exportReserveJin(state, CONTENT, "salt"), 200 + 100, "保本线 200 斤 + 本月应交 100 斤");
  assert.equal(exportReserveJin(state, CONTENT, "wood"), 200, "没有长协的商品只留保本线");
  agreement.carryJin = 50;
  assert.equal(exportReserveJin(state, CONTENT, "salt"), 200 + 150, "顺延的部分也留");
  agreement.status = "terminated";
  assert.equal(exportReserveJin(state, CONTENT, "salt"), 200, "解约后不再留");
});

test("贸易行出口不动长协本月应交的货：批发 300 斤、有 100 斤长协时不出口盐；没有长协时出 100 斤", () => {
  const exportedSalt = withAgreement => {
    const state = simulation.createInitialState({ seed: 9141 });
    addBuilding(state, "ftrade", "foreign_trade_house");
    setJobCount(state, "ftrade::trade_staff", 8, CONTENT);
    addBuilding(state, "wm1", "wholesale_market");
    addBuilding(state, "tc1", "trade_center");
    setJobCount(state, "wm1::wholesale_workers", 3, CONTENT);
    grantResidentVouchers(state, 300000);
    issueTownVouchers(state, 50000 * V, CONTENT, "测试：镇库付货款");
    assert.equal(simulation.configureWholesalePrice(state, "salt", 10).ok, true);
    state.wholesaleMarket.inventory.salt = 300 * I;
    state.logistics.poolJin = 300;
    const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
    assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
    const opened = simulation.openResidentShop(state, "tc1", "trading_house", owner.id);
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(simulation.configureShopClerks(state, opened.shopId, 10).ok, true);
    transferVouchers(state, "town", `shop:${opened.shopId}`, 20000 * V, CONTENT, "test", "测试：贸易行周转金");
    if (withAgreement) {
      const signed = simulation.signTradeAgreement(state, { itemId: "salt", annualJin: 1200, years: 1 });
      assert.equal(signed.ok, true, signed.reason);
      // 签约时批发库存只为检验保留量，不影响长协本身的交付（这里只看出口）。
    }
    settleTradingHouses(state, CONTENT);
    assertValid(state, withAgreement ? "有长协" : "无长协");
    return state.shops[opened.shopId].tradeLog.at(-1).exportJin?.salt || 0;
  };
  const without = exportedSalt(false);
  const withLong = exportedSalt(true);
  assert.ok(without > 0, `没有长协时应出口盐，实际 ${without}`);
  assert.equal(withLong, 0, `有 100 斤长协时保留量 300 斤等于库存，不出口，实际 ${withLong}`);
});
