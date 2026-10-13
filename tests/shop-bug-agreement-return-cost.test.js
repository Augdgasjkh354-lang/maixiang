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

function agreementState(seed) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "ftrade", "foreign_trade_house");
  setJobCount(state, "ftrade::trade_staff", 2, CONTENT);
  addBuilding(state, "wm1", "wholesale_market");
  state.wholesaleMarket.inventory.salt = 10000 * I;
  state.wholesaleMarket.inventoryCostVoucherUnits ||= {};
  state.wholesaleMarket.inventoryCostVoucherUnits.salt = 5000 * I;
  state.logistics.poolJin = 1000000;
  const signed = simulation.signTradeAgreement(state, { itemId: "salt", annualJin: 1200, years: 2 });
  assert.equal(signed.ok, true, signed.reason);
  return state;
}

// 缺陷：对方付不起（partner breach）时，本月取出的批发货被 returnToMarket 原样退回，
// 但取货时带走的成本基础（inventoryCostVoucherUnits）没有退回，成本凭空消失。
test("长协对方付不起、退货入市时批发库存的成本基础守恒", () => {
  const state = agreementState(9101);
  const town = state.outsideTowns[state.tradeAgreements[0].townId];
  town.wheatStockJin = 0; // 对方无余粮付款
  const before = state.wholesaleMarket.inventory.salt;
  const basisBefore = state.wholesaleMarket.inventoryCostVoucherUnits.salt;
  const result = settleTradeAgreementsMonth(state, CONTENT);
  assert.equal(result.partnerBreached, 1, "走的是对方违约分支");
  assert.equal(state.wholesaleMarket.inventory.salt, before, "货数退回");
  assert.equal(state.wholesaleMarket.inventoryCostVoucherUnits.salt, basisBefore, "成本基础应原样退回");
});
