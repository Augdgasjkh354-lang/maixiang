import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { payDailyWages } from "../src/systems/payroll.js";
import { householdList, householdIdleWorkers, isActiveHousehold } from "../src/systems/households.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { transferVouchers } from "../src/economy/currency.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const def = CONTENT.buildings[typeId];
  const required = def.requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = {
    id, typeId, level,
    ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [],
    completed: { year: state.year, day: 1 }
  };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

test("r07 镇营历史总欠薪即使原岗位已消失，也必须恢复家庭债权并用镇库余额偿还", () => {
  const state = legacyVoucherState({ seed: 110701 });
  assert.equal(simulation.issueGrainVouchers(state, "town", 100).ok, true);
  state.payroll.creditorClaims = {};
  state.payroll.creditorPaymentClaims = {};
  state.payroll.arrearsVoucherUnits = { "removed-building::workers": 10 * V };
  state.payroll.arrearsWheatUnits = state.payroll.arrearsVoucherUnits;
  state.payroll.legacyUnattributedArrearsVoucherUnits = { "removed-building::workers": 10 * V };
  state.payroll.legacyUnattributedPaymentClaims = {
    "removed-building::workers": { valueUnits: 10 * V, wheatValueUnits: 0, voucherValueUnits: 10 * V }
  };
  const townBefore = state.currency.balances.town;
  const householdBefore = householdList(state).reduce((sum, h) => sum + (h.voucherUnits || 0), 0);

  const result = payDailyWages(state, { rows: [], idle: 0 }, CONTENT);

  assert.equal(state.payroll.arrearsVoucherUnits["removed-building::workers"], 0);
  assert.equal(state.payroll.legacyUnattributedArrearsVoucherUnits["removed-building::workers"], undefined);
  assert.equal(state.currency.balances.town, townBefore - 10 * V);
  assert.equal(householdList(state).reduce((sum, h) => sum + (h.voucherUnits || 0), 0), householdBefore + 10 * V);
  assert.equal(result.arrearsBalanceVoucher, 0);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));
});

test("r07 已进入清算的旧店铺总欠薪必须恢复债权并偿清，不能反复吞业主补资", () => {
  const state = legacyVoucherState({ seed: 110702 });
  assert.equal(simulation.issueGrainVouchers(state, "town", 500).ok, true);
  const street = addBuilding(state, "commercial_street", "r07-street", 1);
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.ok(owner);
  assert.equal(transferVouchers(state, "town", `household:${owner.id}`, 200 * V, CONTENT, "r07_shop_startup", "测试开店资金").ok, true);
  const opened = simulation.openResidentShop(state, street.id, "tea", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  shop.status = "liquidating";
  shop.statusReason = "旧档清算测试";
  shop.liabilities.claimsVoucherUnits = {};
  shop.liabilities.claimsPayment = {};
  shop.liabilities.wageVoucherUnits = 30 * V;
  shop.liabilities.legacyUnattributedWageVoucherUnits = 30 * V;
  shop.liabilities.rentVoucherUnits = 0;
  shop.liabilities.taxVoucherUnits = 0;
  shop.liabilities.rentPaymentClaim = { valueUnits: 0, wheatValueUnits: 0, voucherValueUnits: 0 };
  shop.liabilities.taxPaymentClaim = { valueUnits: 0, wheatValueUnits: 0, voucherValueUnits: 0 };
  assert.ok((shop.cashVoucherUnits || 0) >= 30 * V, "店铺测试现金应足以先偿还旧工资债");

  const result = simulation.fundResidentShopLiquidation(state, shop.id);

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.contributedVoucherUnits, 0, "店铺已有现金时不应再从业主家庭反复补资");
  assert.equal(shop.liabilities.wageVoucherUnits, 0);
  assert.equal(shop.liabilities.legacyUnattributedWageVoucherUnits, 0);
  assert.equal(shop.status, "closed");
  assert.equal(result.liquidationPending, false);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));
});

test("r07 人口归零家庭持有的上市股份仍必须可由镇库回购，避免永久锁死公司清算", () => {
  const state = legacyVoucherState({ seed: 110703 });
  addBuilding(state, "stock_exchange", "r07-stock-exchange", 1);
  const mill = addBuilding(state, "mill", "r07-share-mill", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 10000).ok, true);
  const formed = simulation.createCompany(state, mill.id, { name: "遗产股份测试公司", levels: 1, operatingCapitalVoucher: 0, initialMaterials: {} });
  assert.equal(formed.ok, true, formed.reason);
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker: "707", totalShares: 1000, offeredShares: 0, priceVoucherPerShare: 1 });
  assert.equal(listed.ok, true, listed.reason);
  const company = state.companies[formed.companyId];

  const households = householdList(state);
  const holder = households.find(h => Object.values(h.jobs || {}).reduce((sum, value) => sum + (value || 0), 0) === 0 && isActiveHousehold(h));
  const receiver = households.find(h => h.id !== holder?.id && isActiveHousehold(h));
  assert.ok(holder && receiver);
  company.townShares = 900;
  company.residentShares = 100;
  company.householdShares = { [holder.id]: 100 };
  holder.shares ||= {};
  holder.shares[company.id] = 100;
  for (const band of ["children", "workers", "elders"]) {
    receiver.ageBands[band] = (receiver.ageBands[band] || 0) + (holder.ageBands[band] || 0);
    holder.ageBands[band] = 0;
  }
  assert.equal(isActiveHousehold(holder), false);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));

  const preview = simulation.previewTownBuyback(state, company.id, { shares: 100, priceVoucherPerShare: 10 });
  assert.equal(preview.available, true, preview.reason);
  assert.equal(preview.willingShares, 100);
  const bought = simulation.buybackCompanyShares(state, company.id, { shares: 100, priceVoucherPerShare: 10 });
  assert.equal(bought.ok, true, bought.reason);
  assert.equal(company.residentShares, 0);
  assert.equal(company.townShares, 1000);
  const liquidated = simulation.liquidateCompany(state, company.id);
  assert.equal(liquidated.ok, true, liquidated.reason);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));
});
