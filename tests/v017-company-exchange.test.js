import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { formCompany } from "./helpers-ipo.js";
import { CONTENT } from "../src/content/index.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { exportState, parseSaveFile } from "../src/persistence/storage.js";
import { companyActualProfitValuation, companyWorkingCapitalReserve } from "../src/systems/companies.js";
import { richestHousehold, grantResidentVouchers } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = { id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  return building;
}

function openExchange(state) {
  state.stockExchange ||= { legacyAccess: false, rotation: 0 };
  state.stockExchange.legacyAccess = true;
}

function listedCompany(state, buildingId, { levels = 1, capital = 10000, ticker = "001", shares = 1000, offer = 0, price = 1 } = {}) {
  const formed = formCompany(state, buildingId, { name: `${buildingId}公司`, levels, operatingCapitalVoucher: capital, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  openExchange(state);
  state.monetaryReform.stage = "voucher";
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker, totalShares: shares, priceVoucherPerShare: price, offeredShares: offer });
  assert.equal(listed.ok, true, listed.reason);
  return state.companies[formed.companyId];
}

test("已取消单独成立公司：createCompany / listCompany 只返回原因，建筑与公司都不变", () => {
  const state = simulation.createInitialState({ seed: 1701 });
  const mill = addBuilding(state, "mill", "company-mill", 2);
  const before = { ownership: { ...mill.ownership } };
  for (const result of [simulation.createCompany(state, mill.id, { name: "麦香磨坊", levels: 1 }), simulation.listCompany(state, mill.id, { levels: 1 })]) {
    assert.equal(result.ok, false);
    assert.match(result.reason, /已取消单独成立公司：请直接整栋上市/);
  }
  assert.deepEqual(mill.ownership, before.ownership, "建筑归属不变");
  assert.deepEqual(Object.keys(state.companies), []);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("没有交易所或未完成货币改革时不能上市；完成后代码与整除规则生效", () => {
  const state = legacyVoucherState();
  const salt = addBuilding(state, "saltworks", "gate-salt", 2);
  assert.equal(simulation.issueGrainVouchers(state, "town", 50000).ok, true);
  const formed = formCompany(state, salt.id, { levels: 2, operatingCapitalVoucher: 10000, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  state.stockExchange = { legacyAccess: false, rotation: 0 };
  assert.match(simulation.listCompanyShares(state, formed.companyId, { ticker: "007", totalShares: 1000, priceVoucherPerShare: 1, offeredShares: 100 }).reason, /交易所/);
  openExchange(state);
  state.monetaryReform.stage = "transition";
  assert.match(simulation.listCompanyShares(state, formed.companyId, { ticker: "007", totalShares: 1000, priceVoucherPerShare: 1, offeredShares: 100 }).reason, /货币改革/);
  state.monetaryReform.stage = "voucher";
  const bad = simulation.listCompanyShares(state, formed.companyId, { ticker: "007", totalShares: 1001, priceVoucherPerShare: 1, offeredShares: 100 });
  assert.equal(bad.ok, false);
  assert.ok(bad.nearby?.every(value => value % 2 === 0));
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker: "007", totalShares: 1000, priceVoucherPerShare: 2, offeredShares: 100 });
  assert.equal(listed.ok, true, listed.reason);
  assert.equal(state.companies[formed.companyId].townShares, 1000);
  assert.equal(state.companies[formed.companyId].residentShares, 0);
});

test("部分认购可分批出售，售股款只进镇库且总股本守恒", () => {
  const state = legacyVoucherState();
  addBuilding(state, "saltworks", "sale-salt", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 50000).ok, true);
  const company = listedCompany(state, "sale-salt", { capital: 10000, ticker: "021", shares: 1000, offer: 300, price: 5 });
  assert.equal(grantResidentVouchers(state, 100000, CONTENT).ok, true);
  const companyCash = company.cashVoucherUnits;
  const first = simulation.subscribeShares(state, company.id);
  assert.equal(first.ok, true, first.reason);
  assert.ok(first.subscribedShares > 0 && first.subscribedShares <= 300);
  assert.equal(company.cashVoucherUnits, companyCash);
  const heldAfterFirst = company.townShares;
  assert.equal(simulation.configureShareOffer(state, company.id, Math.min(200, heldAfterFirst), 5).ok, true);
  const second = simulation.subscribeShares(state, company.id);
  assert.equal(second.ok, true, second.reason);
  assert.equal(company.townShares + company.residentShares, company.totalShares);
  assert.ok(company.shareSale.cumulativeProceedsVoucherUnits >= first.proceedsVoucherUnits + second.proceedsVoucherUnits);
});

test("360日周转金按目标经营规模计算，停工不会把储备目标压成零", () => {
  const state = legacyVoucherState();
  const salt = addBuilding(state, "saltworks", "reserve-salt", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 100000).ok, true);
  const formed = formCompany(state, salt.id, { levels: 1, operatingCapitalVoucher: 50000, initialMaterialQuantity: 0 });
  const company = state.companies[formed.companyId];
  assert.equal(simulation.configureCompanyTargetWorkers(state, company.id, 3).ok, true);
  assert.equal(simulation.configureCompanyWage(state, company.id, 20).ok, true);
  const reserve = companyWorkingCapitalReserve(company, state, CONTENT);
  assert.equal(reserve, 3 * 20 * 360 * V);
  assert.ok(reserve > 0);
});

test("年度利润只在新年首日结算上一年，保存恢复不会重复结算", () => {
  const state = legacyVoucherState();
  addBuilding(state, "saltworks", "annual-salt", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 200000).ok, true);
  const formed = formCompany(state, "annual-salt", { levels: 1, operatingCapitalVoucher: 100000, initialMaterialQuantity: 0 });
  const company = state.companies[formed.companyId];
  simulation.configureCompanyTargetWorkers(state, company.id, 0);
  company.retainedEarningsVoucherUnits = 5000 * V;
  company.accounts.year.profitVoucherUnits = 5000 * V;
  state.day = CONTENT.rules.daysPerYear - 1;
  simulation.advanceDay(state);
  assert.equal(state.year, 2);
  assert.equal(state.day, 0);
  assert.equal(company.annualSettlement.lastSettledYear || 0, 0, "年末只封账，不提前分配");
  const townBefore = state.currency.balances.town;
  simulation.advanceDay(state);
  assert.equal(company.annualSettlement.lastSettledYear, 1);
  assert.ok(state.currency.balances.town >= townBefore);
  const annualReport = state.annualReports.find(row => row.year === 1);
  assert.equal(annualReport?.summaryVersion, 1);
  assert.equal(annualReport?.companies?.[company.id]?.history, undefined, "年报不得复制公司日级历史");
  assert.equal(annualReport?.companies?.[company.id]?.dividendHistory, undefined, "年报不得复制历年分红历史");
  assert.equal(annualReport?.companies?.[company.id]?.distribution?.totalVoucherUnits, company.annualSettlement.distributedVoucherUnits);
  const exported = exportState(state);
  const restored = parseSaveFile(exported, CONTENT);
  const restoredCompany = restored.companies[company.id];
  const distribution = restoredCompany.annualSettlement.distributedVoucherUnits;
  simulation.advanceDay(restored);
  assert.equal(restoredCompany.annualSettlement.lastSettledYear, 1);
  assert.equal(restoredCompany.annualSettlement.distributedVoucherUnits, distribution);
});

test("全年（daysPerYear 天）实际利润估值包含停工日，不只按有生产日期年化", () => {
  const state = legacyVoucherState();
  addBuilding(state, "saltworks", "valuation-salt", 1);
  const formed = formCompany(state, "valuation-salt", { levels: 1, operatingCapitalVoucher: 0, initialMaterialQuantity: 0 });
  const company = state.companies[formed.companyId];
  state.year = 2; state.day = 100;
  company.history = [];
  const now = (state.year - 1) * CONTENT.rules.daysPerYear + state.day;
  for (let i = 0; i < 99; i++) company.history.push({ serial: now - 99 + i, profitVoucherUnits: i === 0 ? 1000 * V : 0 });
  company.accounts.day.profitVoucherUnits = 0;
  const valuation = companyActualProfitValuation(state, company, CONTENT);
  assert.equal(valuation.observedDays, 100);
  assert.equal(valuation.actualProfitVoucherUnits, 1000 * V);
  assert.equal(valuation.annualizedProfitVoucherUnits, 10 * CONTENT.rules.daysPerYear * V, "100日窗口中只有1日盈利，也必须按完整100个日历日年化");
  assert.equal(valuation.fiveYearReferenceVoucherUnits, 50 * CONTENT.rules.daysPerYear * V);
});


test("有上市公司时交易所禁止拆除", () => {
  const state = legacyVoucherState();
  addBuilding(state, "saltworks", "exchange-company", 1);
  const exchange = addBuilding(state, "stock_exchange", "exchange-1", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 20000).ok, true);
  const formed = formCompany(state, "exchange-company", { levels: 1, operatingCapitalVoucher: 1000, initialMaterialQuantity: 0 });
  state.monetaryReform.stage = "voucher";
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker: "088", totalShares: 1000, priceVoucherPerShare: 1, offeredShares: 0 });
  assert.equal(listed.ok, true, listed.reason);
  const preview = simulation.selectDemolitionPreview(state, exchange.id);
  assert.equal(preview.available, false);
  assert.match(preview.reason, /上市公司/);
});
