import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount } from "../src/systems/households.js";
import { settleTradeAgreementsMonth } from "../src/systems/trade-agreements.js";
import { ensureOutsideTowns, tradeWithOutsideTown } from "../src/systems/outside-town.js";
import { townWheatReserveUnits } from "../src/selectors/production.js";

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

// 外贸房在岗、批发盐充足、签一年 1200 斤盐的长协（月交 100 斤）。运力给足。
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

test("外镇付不起的月份：本月应交整笔顺延到下月，下月一起交付 200 斤，不计我方违约", () => {
  const state = agreementState(7501);
  const agreement = state.tradeAgreements[0];
  const town = state.outsideTowns[agreement.townId];
  const relationsBefore = town.relations;
  town.wheatStockJin = 0; // 外镇付不起小麦
  state.day = 1;
  const first = settleTradeAgreementsMonth(state, CONTENT);
  assert.equal(first.partnerBreached, 1, "第一个月对方付不起");
  assert.equal(first.breached, 0, "不计我方违约");
  assert.equal(agreement.breachCount, 0);
  assert.ok(Math.abs(agreement.carryJin - 100) < 0.01, `顺延 100 斤，实际 ${agreement.carryJin}`);
  assert.equal(town.relations, relationsBefore - 3, "关系分 −3");
  assert.ok(state.events.some(event => event.text.includes("交付顺延") && event.text.includes("待交累计")), "事件写明顺延与待交量");
  assertValid(state, "第一个月之后");

  town.wheatStockJin = 1e9; // 外镇恢复付款
  state.day = 31;
  const second = settleTradeAgreementsMonth(state, CONTENT);
  assert.equal(second.delivered, 1, "第二个月照常交付");
  assert.equal(second.breached, 0);
  assert.equal(agreement.carryJin, 0, "顺延清零");
  assert.ok(Math.abs(agreement.totalDeliveredJin - 200) < 0.01, `两个月的量一起交付 200 斤，实际 ${agreement.totalDeliveredJin}`);
  assertValid(state, "第二个月之后");
});

test("长协期满时仍有顺延量：不顺延，到期事件明说随协定作废，顺延量清零", () => {
  const state = agreementState(7502);
  const agreement = state.tradeAgreements[0];
  const town = state.outsideTowns[agreement.townId];
  town.wheatStockJin = 0; // 最后一个月外镇付不起
  agreement.monthsLeft = 1;
  agreement.yearsLeft = 1;
  agreement.carryJin = 50;
  state.day = 1;
  settleTradeAgreementsMonth(state, CONTENT);
  assert.equal(agreement.status, "expired", "期满");
  assert.equal(agreement.carryJin, 0, "顺延量清零");
  assert.equal(agreement.breachCount, 0, "期满不计违约");
  assert.ok(
    state.events.some(event => event.text.includes("已到期") && event.text.includes("随协定作废")),
    "到期事件写明顺延量随协定作废"
  );
  assertValid(state, "期满之后");
});

test("镇长手动进口不得把镇库小麦压到口粮储备线以下：超出时拒绝且不改任何状态", () => {
  const state = simulation.createInitialState({ seed: 9105 });
  addBuilding(state, "ftrade", "foreign_trade_house");
  simulation.setEmployment(state, "ftrade::trade_staff", 8);
  const reserve = townWheatReserveUnits(state, CONTENT);
  state.accounts.town.wheat = reserve + 10 * I; // 只比储备线高 10 斤
  ensureOutsideTowns(state, CONTENT);
  state.logistics.poolJin = 300;
  const wheatBefore = state.accounts.town.wheat;
  const stockBefore = JSON.stringify(state.outsideTowns.minzhen.stocks);
  const snapshot = JSON.stringify(state);

  const result = tradeWithOutsideTown(state, "buy", "flour", 5, CONTENT, "minzhen");
  assert.equal(result.ok, false, "付款会压到储备线以下，应拒绝");
  assert.ok(typeof result.reason === "string" && result.reason.length > 0, "给出原因");
  assert.equal(state.accounts.town.wheat, wheatBefore, "镇库小麦不变");
  assert.equal(JSON.stringify(state.outsideTowns.minzhen.stocks), stockBefore, "外镇库存不变");
  assert.equal(JSON.stringify(state), snapshot, "拒绝时不改任何状态");
  assertValid(state, "拒绝之后");
});

test("镇长手动进口：镇库小麦有富余时照常成交，付款后镇库小麦仍不低于储备线", () => {
  const state = simulation.createInitialState({ seed: 9106 });
  addBuilding(state, "ftrade", "foreign_trade_house");
  simulation.setEmployment(state, "ftrade::trade_staff", 8);
  const reserve = townWheatReserveUnits(state, CONTENT);
  state.accounts.town.wheat = reserve + 1000 * I;
  ensureOutsideTowns(state, CONTENT);
  state.logistics.poolJin = 300;
  const result = tradeWithOutsideTown(state, "buy", "flour", 5, CONTENT, "minzhen");
  assert.equal(result.ok, true, result.reason);
  assert.ok(state.accounts.town.wheat >= reserve, "付款后镇库小麦不低于储备线");
  assertValid(state, "成交之后");
});
