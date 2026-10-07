import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { householdList, householdIdleWorkers, syncResidentAggregates } from "../src/systems/households.js";
import { issueVouchersFromWheat, transferVouchers, voucherBalance } from "../src/economy/currency.js";
import { prepareShopsForDay } from "../src/systems/shops.js";
import { payListedCompanyWages, resetCompanyDaily, resetCompanyYear, companyActualProfitValuation } from "../src/systems/companies.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const def = CONTENT.buildings[typeId];
  const required = def.requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = { id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function openTeaShop(state, id = "street-r05") {
  const street = addBuilding(state, "commercial_street", id, 1);
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.ok(owner);
  const opened = simulation.openResidentShop(state, street.id, "tea", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  return { street, owner, shop: state.shops[opened.shopId] };
}

test("r05 粮券必须先印入镇库；换券只转移镇库已有粮券，镇库可自由支出", () => {
  const state = legacyVoucherState({ seed: 110501 });
  const household = householdList(state).find(h => (h.jobs?.farmers || 0) > 0);
  assert.ok(household);
  state.accounts.town.wheat = 0;
  const householdWheatBefore = household.inventory.wheat;
  const householdVoucherBefore = household.voucherUnits;

  const beforeMintExchange = issueVouchersFromWheat(state, `household:${household.id}`, I, CONTENT, "未印钞先换券");
  assert.equal(beforeMintExchange.ok, false);
  assert.match(beforeMintExchange.reason, /先印制粮券/);

  const mint = simulation.issueGrainVouchers(state, "town", 100);
  assert.equal(mint.ok, true, mint.reason);
  assert.equal(state.accounts.town.wheat, 0, "印制粮券本身不得消耗小麦");
  assert.equal(voucherBalance(state, "town"), 100 * V);
  assert.equal(state.currency.issuedUnits, 100 * V);
  assert.equal(state.currency.issuedCumulativeUnits, 100 * V);

  const exchange = issueVouchersFromWheat(state, `household:${household.id}`, I, CONTENT, "居民交粮换券");
  assert.equal(exchange.ok, true, exchange.reason);
  assert.equal(householdWheatBefore - household.inventory.wheat, I);
  assert.equal(household.voucherUnits - householdVoucherBefore, V);
  assert.equal(state.accounts.town.wheat, I);
  assert.equal(voucherBalance(state, "town"), 99 * V, "换券应扣镇库现有粮券");
  assert.equal(state.currency.issuedUnits, 100 * V, "换券不得再次增发货币");
  assert.equal(state.currency.issuedCumulativeUnits, 100 * V, "累计印制量不得把换券重复算成发行");
  assert.equal(state.currency.exchangedCumulativeUnits, V);

  const spend = transferVouchers(state, "town", `household:${household.id}`, 5 * V, CONTENT, "r05_town_spend", "镇库自由支出已印粮券");
  assert.equal(spend.ok, true, spend.reason);
  assert.equal(voucherBalance(state, "town"), 94 * V);
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true);
});

test("r05 旧档无债权人的店铺工资欠款会归属并偿还，不再永久卡住账本", () => {
  const state = simulation.createInitialState({ seed: 110502 });
  const { shop } = openTeaShop(state);
  state.monetaryReform = {
    stage: "voucher", targetVoucherBps: 10000, residentExchangeEnabled: true, legacyBankAccess: true,
    started: null, completed: { legacy: true }, paymentHistory: [], voucherShortfallByKey: {}
  };
  assert.equal(simulation.issueGrainVouchers(state, "town", 100).ok, true);
  assert.equal(transferVouchers(state, "town", `shop:${shop.id}`, 60 * V, CONTENT, "r05_shop_fund", "测试店铺资金").ok, true);

  shop.liabilities.wageVoucherUnits = 30 * V;
  shop.liabilities.claimsVoucherUnits = {};
  shop.liabilities.claimsPayment = {};
  shop.liabilities.legacyUnattributedWageVoucherUnits = 30 * V;
  const residentsBefore = householdList(state).reduce((sum, h) => sum + (h.voucherUnits || 0), 0);

  prepareShopsForDay(state, CONTENT);
  const residentsAfter = householdList(state).reduce((sum, h) => sum + (h.voucherUnits || 0), 0);
  assert.equal(shop.liabilities.legacyUnattributedWageVoucherUnits, 0);
  assert.equal(shop.liabilities.wageVoucherUnits, 0, "30旧欠薪+当日商人工资都应有偿还路径");
  assert.equal(Object.values(shop.liabilities.claimsVoucherUnits).reduce((a, b) => a + b, 0), 0);
  // 基线清理：店主商人不领固定工资，仅旧欠薪 30 到账。
  assert.equal(residentsAfter - residentsBefore, 30 * V, "旧欠薪30应真实到账（店主商人当日工资为0）");
});

test("r05 公司旧档无债权人欠薪即使当前岗位为0也能偿还，不再永久阻塞分红", () => {
  const state = legacyVoucherState({ seed: 110503 });
  const mill = addBuilding(state, "mill", "r05-company-mill", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 100).ok, true);
  const created = simulation.createCompany(state, mill.id, { name: "旧债测试公司", levels: 1, operatingCapitalVoucher: 20, initialMaterials: {} });
  assert.equal(created.ok, true, created.reason);
  const company = state.companies[created.companyId];
  company.payroll.arrearsVoucherUnits = 10 * V;
  company.payroll.claimsVoucherUnits = {};
  company.payroll.claimsPayment = {};
  company.payroll.legacyUnattributedArrearsVoucherUnits = 10 * V;
  syncResidentAggregates(state, CONTENT);

  const paid = payListedCompanyWages(state, CONTENT).find(row => row.companyId === company.id);
  assert.ok(paid);
  assert.equal(company.payroll.legacyUnattributedArrearsVoucherUnits, 0);
  assert.equal(company.payroll.arrearsVoucherUnits, 0);
  assert.equal(paid.paidVoucherUnits, 10 * V);
});

test("r05 跨年立即归档第365天公司利润，新年Day0估值不会漏掉最后一天", () => {
  const state = legacyVoucherState({ seed: 110504 });
  state.year = 2;
  state.day = 0;
  state.companies = {
    c1: {
      id: "c1", name: "跨年公司", typeId: "mill", buildingId: "none", listedLevels: 1,
      initialInvestment: { cashValueUnits: 1000 * V, materials: [] },
      accounts: {
        day: { profitVoucherUnits: 100 * V, revenueVoucherUnits: 200 * V, producedUnits: {}, soldUnits: {}, taxedUnits: {}, purchasedInputUnits: {} },
        year: { profitVoucherUnits: 101 * V, revenueVoucherUnits: 202 * V, producedUnits: {}, soldUnits: {}, taxedUnits: {}, purchasedInputUnits: {} },
        cumulative: { profitVoucherUnits: 101 * V, revenueVoucherUnits: 202 * V, producedUnits: {}, soldUnits: {}, taxedUnits: {}, purchasedInputUnits: {} }
      },
      history: [{ serial: 364, profitVoucherUnits: V, revenueVoucherUnits: 2 * V }],
      plan: { lastArchivedSerial: 364 }, inventory: {}, inventoryCostVoucherUnits: {}, payroll: {}
    }
  };

  resetCompanyYear(state, CONTENT, 1);
  const company = state.companies.c1;
  assert.equal(company.history.at(-1).serial, 365);
  assert.equal(company.history.at(-1).profitVoucherUnits, 100 * V);
  const value = companyActualProfitValuation(state, company, CONTENT);
  assert.equal(value.actualProfitVoucherUnits, 101 * V, "Day0估值必须包含旧年第365天利润");

  const count = company.history.length;
  resetCompanyDaily(state, CONTENT);
  assert.equal(company.history.length, count, "新年首次日结不得重复归档第365天");
});
