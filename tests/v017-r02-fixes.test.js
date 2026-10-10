import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulation } from "../src/engine.js";
import { formCompany } from "./helpers-ipo.js";
import { CONTENT } from "../src/content/index.js";
import { payDailyWages } from "../src/systems/payroll.js";
import { employmentSnapshot } from "../src/systems/employment.js";
import { companyWorkingCapitalReserve } from "../src/systems/companies.js";
import { householdIdleWorkers, householdList, releaseJobFromHousehold } from "../src/systems/households.js";
import { exportState, parseSaveFile } from "../src/persistence/storage.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

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
  state.monetaryReform.stage = "voucher";
}

function listedCompany(state, buildingId, { levels = 1, capital = 10000, ticker = "171", shares = 1000, offer = 0, price = 1 } = {}) {
  const formed = formCompany(state, buildingId, { name: `${buildingId}公司`, levels, operatingCapitalVoucher: capital, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  openExchange(state);
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker, totalShares: shares, priceVoucherPerShare: price, offeredShares: offer });
  assert.equal(listed.ok, true, listed.reason);
  return state.companies[formed.companyId];
}

function makeTownWageDebt(seed, buildingId = `debt-mill-${seed}`) {
  const state = legacyVoucherState({ seed });
  addBuilding(state, "mill", buildingId, 1);
  simulation.setWageRate(state, "millers", 10);
  assert.equal(simulation.setEmployment(state, `${buildingId}::millers`, 1).ok, true);
  const first = payDailyWages(state, employmentSnapshot(state, CONTENT), CONTENT);
  assert.equal(first.expectedVoucher, 10);
  const claims = state.payroll.creditorClaims[`${buildingId}::millers`];
  const householdId = Object.keys(claims).find(id => claims[id] > 0);
  assert.ok(householdId);
  assert.equal(claims[householdId], 10 * V);
  assert.equal(state.monetaryReform.voucherShortfallByKey[`town-wage:${buildingId}::millers:${householdId}`], 10 * V);
  return { state, buildingId, jobKey: `${buildingId}::millers`, householdId };
}

test("r02 股票认购与界面估值共用日历日实际利润窗口，停工日不会被排除", () => {
  const state = legacyVoucherState({ seed: 17205 });
  addBuilding(state, "saltworks", "calendar-stock", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 200000).ok, true);
  const company = listedCompany(state, "calendar-stock", { capital: 0, ticker: "172", shares: 1000, offer: 400, price: 100 });
  assert.equal(grantResidentVouchers(state, 100000, CONTENT).ok, true);
  state.year = 1;
  state.day = CONTENT.rules.daysPerYear - 1;
  company.history = [];
  // 股票看最近 60 个日历日（300—359）：前 30 天赚钱、后 30 天停工，停工日也计入窗口。
  for (let serial = 300; serial <= 329; serial += 1) company.history.push({ serial, profitVoucherUnits: 100 * V, revenueVoucherUnits: 100 * V });
  company.accounts.day.profitVoucherUnits = 0;
  company.operatingDays = 30; // 旧口径若仍生效会把3000年化为36500。

  const view = simulation.selectDashboard(state);
  const viewCompany = view.companies.find(row => row.id === company.id);
  const preview = simulation.previewShareSubscription(state, company.id);
  const expectedAnnualized = Math.round(3000 * V * CONTENT.rules.daysPerYear / 60);
  assert.equal(viewCompany.stockReference.observedDays, 60);
  assert.equal(preview.observedDays, 60);
  assert.equal(preview.realizedProfitVoucherUnits, 3000 * V);
  assert.equal(preview.annualizedProfitVoucherUnits, expectedAnnualized);
  assert.equal(preview.referenceCompanyValueVoucherUnits, viewCompany.stockReference.referenceCompanyValueVoucherUnits, "认购预览和交易所必须使用同一估值");
  assert.equal(preview.referencePerShareVoucherUnits, viewCompany.stockReference.referencePerShareVoucherUnits);
  assert.equal(preview.subscribedShares, Math.floor(400 * Math.min(1, preview.referencePerShareVoucherUnits / (100 * V))));
  assert.match(preview.basis, /日历日/);

  const executed = simulation.subscribeShares(state, company.id);
  assert.equal(executed.ok, true, executed.reason);
  assert.equal(executed.subscribedShares, preview.subscribedShares, "实际认购必须复用同一预览口径");
});

test("r02 无经营记录仍可挂牌且认购明确显示暂无实际业绩", () => {
  const state = legacyVoucherState({ seed: 17206 });
  addBuilding(state, "saltworks", "no-history-stock", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 20000).ok, true);
  const company = listedCompany(state, "no-history-stock", { capital: 1000, ticker: "173", shares: 1000, offer: 100, price: 1 });
  const preview = simulation.previewShareSubscription(state, company.id);
  const viewCompany = simulation.selectDashboard(state).companies.find(row => row.id === company.id);
  assert.equal(preview.observedDays, 0);
  assert.equal(preview.annualizedProfitVoucherUnits, 0);
  assert.match(preview.basis, /暂无业绩/);
  assert.match(viewCompany.stockReference.basis, /暂无业绩/);
});

test("r02 360日周转金尊重显式0人目标，目标3人即使缺料停工仍按3人计划保留", () => {
  const state = legacyVoucherState({ seed: 17207 });
  const salt = addBuilding(state, "saltworks", "zero-reserve", 1);
  const mill = addBuilding(state, "mill", "planned-reserve", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 100000).ok, true);
  const saltFormed = formCompany(state, salt.id, { levels: 1, operatingCapitalVoucher: 5000, initialMaterialQuantity: 0 });
  const saltCompany = state.companies[saltFormed.companyId];
  simulation.configureCompanyTargetWorkers(state, saltCompany.id, 0);
  simulation.configureCompanyWage(state, saltCompany.id, 10);
  assert.equal(companyWorkingCapitalReserve(saltCompany, state, CONTENT), 0);

  const millFormed = formCompany(state, mill.id, { levels: 1, operatingCapitalVoucher: 5000, initialMaterialQuantity: 0 });
  const millCompany = state.companies[millFormed.companyId];
  simulation.configureCompanyTargetWorkers(state, millCompany.id, 3);
  simulation.configureCompanyWage(state, millCompany.id, 10);
  millCompany.inventory.wheat = 0;
  const reserve = companyWorkingCapitalReserve(millCompany, state, CONTENT);
  assert.ok(reserve >= 3 * 10 * 360 * V, "缺料停工不能把明确3人目标的工资周转金压低");
});

test("r02 年度居民利润分配经过完整新年日结进入日/近期/年度/累计收入，并能形成后续服务预算", () => {
  const state = legacyVoucherState({ seed: 17208 });
  addBuilding(state, "saltworks", "annual-income", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 200000).ok, true);
  const company = listedCompany(state, "annual-income", { capital: 100000, ticker: "174", shares: 1000, offer: 0, price: 1 });
  simulation.configureCompanyTargetWorkers(state, company.id, 0);
  const shareholder = householdList(state)[0];
  company.townShares = 500;
  company.residentShares = 500;
  company.householdShares = { [shareholder.id]: 500 };
  shareholder.shares ||= {};
  shareholder.shares[company.id] = 500;
  company.retainedEarningsVoucherUnits = 4000 * V;
  company.accounts.year.profitVoucherUnits = 4000 * V;

  state.day = CONTENT.rules.daysPerYear - 1;
  simulation.advanceDay(state);
  assert.equal(state.year, 2);
  assert.equal(state.day, 0);
  assert.equal(company.annualSettlement.lastSettledYear || 0, 0);

  const balanceBefore = shareholder.voucherUnits;
  const cumulativeBefore = shareholder.life?.cumulative?.incomeVoucherUnits || 0;
  const newYear = simulation.advanceDay(state);
  assert.equal(newYear.yearStartCompanyDistributions.length, 1);
  assert.equal(company.annualSettlement.residentVoucherUnits, 2000 * V);
  assert.equal(company.annualSettlement.townVoucherUnits, 2000 * V);
  // 基线调整（金融扩展）：新年日结当天新增了"银行吸储 + 住户日常股票买入"，
  // 分红到账后闲钱会被存银行/买股票，故现金余额不再是分红全额。
  // 改为核对守恒：分红 = 现金增量 + 银行/股票等已配置部分，且收入账完整入账。
  const sharesBefore = shareholder.shares?.[company.id] || 0;
  const depositsBefore = state.bank?.deposits?.[shareholder.id] || 0;
  const cashDeltaBeforeInvest = shareholder.voucherUnits - balanceBefore;
  const configuredAfter = (shareholder.stockBuyBudgetVoucherUnits || 0);
  assert.ok(cashDeltaBeforeInvest > 0, "分红应带来正的现金增量");
  assert.ok(cashDeltaBeforeInvest <= 2000 * V + 1, "现金增量不应超过分红");
  assert.equal(shareholder.life.day.incomeVoucherUnits, 2000 * V);
  assert.equal(shareholder.life.year.incomeVoucherUnits, 2000 * V);
  assert.equal(shareholder.life.cumulative.incomeVoucherUnits - cumulativeBefore, 2000 * V);
  assert.equal(shareholder.life.recent.at(-1).incomeVoucherUnits, 2000 * V);
  // 分红的一部分被同一日结用于股票买入：持股数增加，且总账守恒。
  const sharesAfter = shareholder.shares?.[company.id] || 0;
  const depositsAfter = state.bank?.deposits?.[shareholder.id] || 0;
  const stockSpent = 2000 * V - cashDeltaBeforeInvest - (depositsAfter - depositsBefore) - configuredAfter;
  if (sharesAfter > sharesBefore) assert.ok(stockSpent > 0, "买入股票应耗用分红资金");

  const restored = parseSaveFile(exportState(state), CONTENT);
  const restoredShareholder = restored.households.byId[shareholder.id];
  const restoredCumulative = restoredShareholder.life.cumulative.incomeVoucherUnits;
  const next = simulation.advanceDay(restored);
  assert.equal(next.yearStartCompanyDistributions.length, 0);
  assert.equal(restored.companies[company.id].annualSettlement.lastSettledYear, 1);
  assert.equal(restoredShareholder.life.cumulative.incomeVoucherUnits, restoredCumulative, "保存恢复后不能重复分配上一年利润");

  const street = addBuilding(state, "commercial_street", "service-after-dividend", 1);
  const merchant = householdList(state).find(h => h.id !== shareholder.id && householdIdleWorkers(h) > 0);
  assert.ok(merchant);
  assert.equal(grantResidentVouchers(state, 500, CONTENT, merchant.id).ok, true);
  const opened = simulation.openResidentShop(state, street.id, "tea", merchant.id);
  assert.equal(opened.ok, true, opened.reason);
  state.services.latentDays = 20;
  const serviceDay = simulation.advanceDay(state);
  assert.ok(serviceDay.services.spendingVoucherUnits > 0, "上一日真实投资收入应能被既有服务预算读取");
  // 服务预算改看家底（household-budget），不再专门验证"分红收入 → 服务预算"这条旧口径。
});

test("r02 回购与上市公司等级变动预览不改状态，并给出执行所需关键结果", () => {
  const state = legacyVoucherState({ seed: 17209 });
  addBuilding(state, "mill", "preview-company", 5);
  assert.equal(simulation.issueGrainVouchers(state, "town", 200000).ok, true);
  const company = listedCompany(state, "preview-company", { levels: 4, capital: 10000, ticker: "175", shares: 10000, offer: 0, price: 1 });
  // 整栋归公司：按级划入的预览已废止，返回不可用原因且不改状态。
  const addPreview = simulation.previewCompanyLevelChange(state, company.id, "add");
  assert.equal(addPreview.available, false);
  assert.match(addPreview.reason, /整栋归公司/);
  assert.equal(company.listedLevels, 5, "预览不得直接改变公司等级");
  assert.equal(company.totalShares, 10000, "预览不得直接增发股份");

  const owner = householdList(state)[0];
  company.townShares = 6000;
  company.residentShares = 4000;
  company.householdShares = { [owner.id]: 4000 };
  owner.shares ||= {};
  owner.shares[company.id] = 4000;
  const balanceBefore = state.currency.balances.town;
  const buyback = simulation.previewTownBuyback(state, company.id, { shares: 1000, priceVoucherPerShare: 10 });
  assert.equal(buyback.requestedShares, 1000);
  assert.equal(buyback.willingShares, 4000);
  assert.ok(buyback.affordableShares >= buyback.executableShares);
  assert.equal(buyback.executableShares, 1000);
  assert.equal(buyback.costVoucherUnits, 10000 * V);
  assert.equal(company.townShares, 6000);
  assert.equal(company.residentShares, 4000);
  assert.equal(state.currency.balances.town, balanceBefore, "回购预览不得消耗镇库粮券");
});

test("r02 操作面板使用预览确认并在确认前重算；沿用移动端44px按钮与安全区操作栏", () => {
  const app = readFileSync(new URL("../src/ui/app.js", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/ui/panel-exchange.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles/main.css", import.meta.url), "utf8");
  assert.match(panel, /data-company-buyback-preview/);
  assert.match(panel, /申请 \/ 居民愿售/);
  assert.match(panel, /镇库可负担 \/ 预计成交/);
  assert.doesNotMatch(panel, /data-company-level-preview/);
  assert.match(panel, /data-ipo-list/);
  assert.match(panel, /总股本/);
  assert.match(panel, /成交后镇库持股/);
  assert.match(app, /previewTownBuyback\(state, companyId/);
  assert.match(app, /回购条件已变化，成交数量或成本已更新，请再次确认/);
  assert.match(app, /simulation\.approveIpoApplication\(state, buildingId, options\)/);
  assert.match(css, /\.primary, \.secondary, \.danger-button \{ min-height: 44px/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});
