import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { formCompany } from "./helpers-ipo.js";
import { CONTENT } from "../src/content/index.js";
import { settleHouseholdStockBuying, offeredPoolShares } from "../src/systems/stock-exchange.js";
import { voucherBalance } from "../src/economy/currency.js";
import { householdList } from "../src/systems/households.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

// 二级市场：住户日常买股只能买发行池（镇长或业主挂出的股份），镇库不会自动卖股，也不会自动回购。

const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  state.buildings.push({ id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } });
}

// 已上市公司：镇库持有全部 1000 股，发行池 offer 股，每股 price 粮券。
function listedState({ offer = 0, price = 2, seed = 4101 } = {}) {
  const state = legacyVoucherState({ seed });
  addBuilding(state, "saltworks", "pool-salt", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 50000).ok, true);
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  const formed = formCompany(state, "pool-salt", { name: "盐业公司", levels: 1, operatingCapitalVoucher: 10000, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker: "041", totalShares: 1000, priceVoucherPerShare: price, offeredShares: offer });
  assert.equal(listed.ok, true, listed.reason);
  assert.equal(grantResidentVouchers(state, 200000, CONTENT).ok, true);
  return { state, company: state.companies[formed.companyId] };
}

// 给每户一笔当日股票购买预算（银行分流结果的替身）。
function giveStockBudget(state, voucherUnitsEach) {
  for (const household of householdList(state)) household.stockBuyBudgetVoucherUnits = voucherUnitsEach;
}

test("二级市场：镇库未挂出的股份不会卖给住户", () => {
  const { state, company } = listedState({ offer: 0 });
  giveStockBudget(state, 5000 * V);
  const townBefore = voucherBalance(state, "town");
  const result = settleHouseholdStockBuying(state, CONTENT);
  assert.equal(result, null, "没有发行池股份时不应成交");
  assert.equal(company.townShares, 1000);
  assert.equal(company.residentShares, 0);
  assert.equal(company.shareSale.offeredShares, 0);
  assert.equal(voucherBalance(state, "town"), townBefore, "镇库不收款");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("二级市场：买入只从发行池扣减，发行池与镇库持股同减，股款付给镇库", () => {
  const { state, company } = listedState({ offer: 300, price: 2 });
  const buyer = householdList(state)[0];
  for (const household of householdList(state)) household.stockBuyBudgetVoucherUnits = 0;
  buyer.stockBuyBudgetVoucherUnits = 400 * 2 * V;
  const townBefore = voucherBalance(state, "town");
  const result = settleHouseholdStockBuying(state, CONTENT);
  assert.ok(result && result.shares > 0, "发行池有股、预算足够时应成交");
  // 预算 800 粮券、单价 2：最多 400 股，但发行池只有 300 股。
  assert.equal(result.shares, 300, "成交量封顶于发行池");
  assert.equal(company.shareSale.offeredShares, 0, "发行池扣减");
  assert.equal(company.townShares, 700, "镇库持股同减");
  assert.equal(company.residentShares, 300, "居民持股增加");
  assert.equal(company.householdShares[buyer.id], 300);
  assert.equal(buyer.shares[company.id], 300);
  assert.equal(voucherBalance(state, "town") - townBefore, 300 * 2 * V, "股款付给镇库");
  assert.equal(company.townShares + company.residentShares + (company.fundShares || 0), company.totalShares, "总股本守恒");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("二级市场：卖方是家庭时股款付给该户，股份在居民之间转手，镇库持股不变", () => {
  const { state, company } = listedState({ offer: 100, price: 2 });
  const [seller, buyer] = householdList(state);
  // 构造：镇库 700 股，居民 300 股由 seller 持有，seller 挂出 100 股。
  company.townShares = 700;
  company.residentShares = 300;
  company.householdShares = { [seller.id]: 300 };
  seller.shares = { [company.id]: 300 };
  company.shareSale.sellerOwner = seller.id;
  company.shareSale.offeredShares = 100;
  assert.equal(offeredPoolShares(state, company), 100);
  for (const household of householdList(state)) household.stockBuyBudgetVoucherUnits = 0;
  buyer.stockBuyBudgetVoucherUnits = 1000 * V;
  const sellerBefore = voucherBalance(state, `household:${seller.id}`);
  const result = settleHouseholdStockBuying(state, CONTENT);
  assert.equal(result.shares, 100);
  assert.equal(company.townShares, 700, "镇库持股不变");
  assert.equal(company.residentShares, 300, "居民之间转手，居民总持股不变");
  assert.equal(company.householdShares[seller.id], 200);
  assert.equal(company.householdShares[buyer.id], 100);
  assert.equal(seller.shares[company.id], 200);
  assert.equal(voucherBalance(state, `household:${seller.id}`) - sellerBefore, 100 * 2 * V, "股款付给卖方家庭");
  assert.equal(company.shareSale.offeredShares, 0);
});

test("二级市场：镇库不会在 60 天内自动卖股（未挂出时持股不变）", () => {
  const { state, company } = listedState({ offer: 0, price: 1 });
  giveStockBudget(state, 3000 * V);
  simulation.advanceDays(state, 60);
  assert.equal(company.townShares, 1000, "60 天内镇库持股不变");
  assert.equal(company.residentShares, 0, "没有居民买入");
  assert.equal(company.shareSale.offeredShares, 0);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});
