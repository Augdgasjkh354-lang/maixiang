import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount } from "../src/systems/households.js";
import { settleTradeAgreementsMonth } from "../src/systems/trade-agreements.js";

const I = CONTENT.precision.inventoryUnitsPerJin;

function freePlot(state) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => !row.feature && !used.has(row.id));
  assert.ok(plot, "需要空地");
  return plot;
}

function addBuilding(state, id, typeId) {
  const plot = freePlot(state);
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
}

// 有外贸房（在岗）与批发市场、批发盐存货充足、签了一年 1200 斤盐的长协（月交 100 斤）。运力给足。
function agreementState(seed) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "ftrade", "foreign_trade_house");
  setJobCount(state, "ftrade::trade_staff", 2, CONTENT);
  addBuilding(state, "wm1", "wholesale_market");
  state.wholesaleMarket.inventory.salt = 10000 * I;
  state.logistics.poolJin = 1000000;
  const signed = simulation.signTradeAgreement(state, { itemId: "salt", annualJin: 1200, years: 2 });
  assert.equal(signed.ok, true, signed.reason);
  return state;
}

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

test("商路断绝的月份：长协交付顺延到下月，不计违约、不动关系分，写事件说明顺延", () => {
  const state = agreementState(7401);
  const agreement = state.tradeAgreements[0];
  const town = state.outsideTowns[agreement.townId];
  const relationsBefore = town.relations;
  town.tradeClosed = true;
  state.day = 1; // 第一个月
  const result = settleTradeAgreementsMonth(state, CONTENT);
  assert.equal(result.settled, true);
  assert.equal(result.postponed, 1, "本月顺延一笔");
  assert.equal(result.delivered, 0);
  assert.equal(result.breached, 0, "不计违约");
  assert.equal(agreement.breachCount, 0);
  assert.equal(town.relations, relationsBefore, "关系分不变");
  assert.ok(Math.abs(agreement.carryJin - 100) < 0.01, `待交累计 100 斤，实际 ${agreement.carryJin}`);
  assert.ok(agreement.totalDeliveredJin === undefined || agreement.totalDeliveredJin === 0, "没有交付");
  assert.ok(state.events.some(event => event.text.includes("商路断绝") && event.text.includes("顺延")), "事件文字写明顺延");
  assertValid(state, "顺延之后");
});

test("商路恢复后：顺延的部分与当月 1/12 一起交付，顺延清零，不违约", () => {
  const state = agreementState(7402);
  const agreement = state.tradeAgreements[0];
  const town = state.outsideTowns[agreement.townId];
  town.tradeClosed = true;
  state.day = 1;
  settleTradeAgreementsMonth(state, CONTENT);
  town.tradeClosed = false;
  state.day = 31; // 第二个月
  const result = settleTradeAgreementsMonth(state, CONTENT);
  assert.equal(result.delivered, 1, "恢复后照常交付");
  assert.equal(result.breached, 0);
  assert.equal(agreement.carryJin, 0, "顺延清零");
  assert.ok(Math.abs(agreement.totalDeliveredJin - 200) < 0.01, `两个月的量一起交付 200 斤，实际 ${agreement.totalDeliveredJin}`);
  assert.equal(agreement.breachCount, 0);
  assertValid(state, "补交之后");
});
