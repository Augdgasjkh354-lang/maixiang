import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { formCompany } from "./helpers-ipo.js";
import { CONTENT } from "../src/content/index.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { householdList } from "../src/systems/households.js";

// 股市测试夹具（docs/STOCK.md）：一座有交易所的小镇，一家上市的盐业公司。

export const V = CONTENT.precision.currencyUnitsPerVoucher;

export function addBuilding(state, typeId, id, level = 1) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  state.buildings.push({ id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } });
}

// 已上市公司：镇库持有全部股份（totalShares），发行池挂出 offer 股，每股 price 粮券。居民各户合计 200000 券。
export function listedState({ offer = 0, price = 2, seed = 4101, totalShares = 1000, residents = true } = {}) {
  const state = legacyVoucherState({ seed });
  addBuilding(state, "saltworks", "pool-salt", 1);
  assert.equal(simulation.issueGrainVouchers(state, "town", 50000).ok, true);
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  const formed = formCompany(state, "pool-salt", { name: "盐业公司", levels: 1, operatingCapitalVoucher: 10000, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker: "041", totalShares, priceVoucherPerShare: price, offeredShares: offer });
  assert.equal(listed.ok, true, listed.reason);
  if (residents) assert.equal(grantResidentVouchers(state, 200000, CONTENT).ok, true);
  return { state, company: state.companies[formed.companyId] };
}

// 只给某一户当日股票预算，其余户为 0（直接买股的替身，银行分流之外）。
export function onlyBudget(state, householdId, units) {
  for (const household of householdList(state)) household.stockBuyBudgetVoucherUnits = 0;
  state.households.byId[householdId].stockBuyBudgetVoucherUnits = units;
}

// 把镇库股份分给各户（holdings: { householdId: shares }），同步公司与户的持股表。
export function giveHoldings(state, company, holdings) {
  for (const [householdId, shares] of Object.entries(holdings)) {
    const household = state.households.byId[householdId];
    company.townShares -= shares;
    company.residentShares += shares;
    company.householdShares ||= {};
    company.householdShares[householdId] = (company.householdShares[householdId] || 0) + shares;
    household.shares ||= {};
    household.shares[company.id] = (household.shares[company.id] || 0) + shares;
  }
}

export function assertValid(state, label) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label}：${check.errors.join("；")}`);
}
