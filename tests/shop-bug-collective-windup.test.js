import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { openCollectiveShop, windUpCollectiveShop, closeShop } from "../src/systems/shops.js";
import { manageStalls } from "../src/systems/stalls.js";

const I = CONTENT.precision.inventoryUnitsPerJin;

function squareState(seed) {
  const state = simulation.createInitialState({ seed });
  const plot = state.plots.find(p => !p.feature && !state.buildings.some(b => b.plotId === p.id));
  assert.ok(plot, "需要空地");
  state.buildings.push({ id: "square-1", typeId: "times_square", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return state;
}

// 缺陷：集市拆除时，剩货归镇库只加了数量，没有带走成本基础（shop.inventoryCostVoucherUnits 的成本没有进镇库的成本账）。
test("集市拆除：剩货归镇库时成本基础随货转入镇库", () => {
  const state = squareState(9301);
  const square = state.buildings.find(b => b.typeId === "times_square");
  const shop = openCollectiveShop(state, square, "stall", CONTENT);
  shop.inventory.flour = 100 * I;
  shop.inventoryCostVoucherUnits.flour = 5000;
  const townBasisBefore = state.business?.inventoryCostWheatUnits?.town?.flour || 0;
  const townStockBefore = state.accounts.town.flour || 0;
  windUpCollectiveShop(state, shop, CONTENT);
  assert.equal(state.accounts.town.flour, townStockBefore + 100 * I, "货数归镇库");
  const townBasisAfter = state.business?.inventoryCostWheatUnits?.town?.flour || 0;
  assert.equal(townBasisAfter - townBasisBefore, 5000, "成本基础 5000 应随货转入镇库");
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
});

// 缺陷：集体摊位（时代广场）没有业主、由 manageStalls 每日自动补位；若被"停业"，它会留在列表里并被继续招摊主。
test("集体摊位不能被停业（它由时代广场自动经营）", () => {
  const state = squareState(9302);
  const square = state.buildings.find(b => b.typeId === "times_square");
  const shop = openCollectiveShop(state, square, "stall", CONTENT);
  const result = closeShop(state, shop.id, CONTENT, false);
  assert.equal(result.ok, false, "集体摊位停业应被拒绝");
  assert.equal(shop.status, "open", "状态不变");
  manageStalls(state, CONTENT);
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
});
