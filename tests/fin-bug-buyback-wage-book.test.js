// fin-bug：镇里回购民营整栋后，旧业主的民营工资账（privateEconomy.payrollByBuilding）残留在建筑上，
// 下一任民营业主会继承旧业主的欠薪，几十天后被误收回。回购时应像整户失效 / 收回一样，把工资债权转给镇库并删除该账。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { buildingOwner } from "../src/systems/ownership.js";
import { wageArrears } from "../src/systems/employer.js";
import { grantResidentVouchers, richestHousehold } from "./helpers-v16.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;

function freePlot(state, feature = null) {
  return state.plots.find(row => (feature ? row.feature === feature : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
}

function addTownBuilding(state, typeId, id, level = 1) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = freePlot(state, required);
  state.buildings.push({ id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } });
  return state.buildings[state.buildings.length - 1];
}

test("fin-bug：民营整栋回购后，旧业主的工资欠账不残留在建筑上，下一任民营业主不继承", () => {
  const state = simulation.createInitialState({ seed: 7101 });
  addTownBuilding(state, "wholesale_market", "wm-fin");
  const salt = addTownBuilding(state, "saltworks", "salt-fin", 2);
  assert.equal(grantResidentVouchers(state, 100000, CONTENT, richestHousehold(state).id).ok, true);
  assert.equal(simulation.issueGrainVouchers(state, "town", 3000000).ok, true);
  const quote = simulation.selectOperatingRightPreview(state, salt.id);
  simulation.setOperatingRightPrice(state, salt.id, Math.min(quote.maximumPriceWheatJin / 2, quote.maxHouseholdPayVoucher / 2));
  assert.equal(simulation.sellBuildingToPrivate(state, salt.id).ok, true);
  const owner1 = buildingOwner(state, salt).id;

  // 旧业主欠工人 5000 券工资（构造一笔已到期的欠薪账）。
  state.privateEconomy.payrollByBuilding ||= {};
  const debt = 5000 * V;
  state.privateEconomy.payrollByBuilding[salt.id] = {
    claimsVoucherUnits: { [owner1]: debt }, claimsPayment: {}, pendingByMonth: {},
    cumulativeAccruedVoucherUnits: debt, cumulativePaidVoucherUnits: 0, arrearsVoucherUnits: debt
  };

  const bought = simulation.buyBuildingBackFromPrivate(state, salt.id);
  assert.equal(bought.ok, true, bought.reason);
  assert.equal(buildingOwner(state, salt).kind, "town");
  assert.equal(state.privateEconomy.payrollByBuilding[salt.id], undefined, "回购后民营工资账必须删除，不能留在镇营建筑上");
  assert.equal(simulation.validateState(state).valid, true);

  // 工人的债权转为镇营的工资债权（镇库偿付），总额守恒。
  const townClaims = Object.values(state.payroll.creditorClaims || {}).flatMap(row => Object.values(row));
  assert.equal(townClaims.reduce((sum, value) => sum + value, 0), debt, "欠薪债权转给镇库，金额不变");

  // 再次卖给民营：新业主不继承旧欠薪。
  assert.equal(simulation.sellBuildingToPrivate(state, salt.id).ok, true);
  const book = state.privateEconomy.payrollByBuilding[salt.id];
  assert.equal(wageArrears(book || {}), 0, "新业主名下没有旧欠薪");
  assert.equal(simulation.validateState(state).valid, true);
});

test("fin-bug：民营建筑整栋上市后，旧业主的工资账转走，不残留在建筑上", () => {
  const state = simulation.createInitialState({ seed: 7102 });
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  addTownBuilding(state, "wholesale_market", "wm-fin-ipo");
  const salt = addTownBuilding(state, "saltworks", "salt-fin-ipo", 2);
  assert.equal(grantResidentVouchers(state, 100000, CONTENT, richestHousehold(state).id).ok, true);
  assert.equal(simulation.issueGrainVouchers(state, "town", 3000000).ok, true);
  const quote = simulation.selectOperatingRightPreview(state, salt.id);
  simulation.setOperatingRightPrice(state, salt.id, Math.min(quote.maximumPriceWheatJin / 2, quote.maxHouseholdPayVoucher / 2));
  assert.equal(simulation.sellBuildingToPrivate(state, salt.id).ok, true);
  const owner = buildingOwner(state, salt).id;
  const debt = 5000 * V;
  state.privateEconomy.payrollByBuilding ||= {};
  state.privateEconomy.payrollByBuilding[salt.id] = {
    claimsVoucherUnits: { [owner]: debt }, claimsPayment: {}, pendingByMonth: {},
    cumulativeAccruedVoucherUnits: debt, cumulativePaidVoucherUnits: 0, arrearsVoucherUnits: debt
  };
  const listed = simulation.listBuilding(state, salt.id, { ticker: "177", priceVoucherPerShare: 2, fromApplication: true });
  assert.equal(listed.ok, true, listed.reason);
  assert.equal(state.privateEconomy.payrollByBuilding[salt.id], undefined, "上市后民营工资账必须删除");
  assert.equal(simulation.validateState(state).valid, true);
});
