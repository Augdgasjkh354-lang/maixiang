import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { formCompany } from "./helpers-ipo.js";
import { setJobCount } from "../src/systems/households.js";
import { refreshOperatingPlan } from "../src/economy/operating-plan.js";
import { processListedCompany } from "../src/systems/companies.js";
import { listedJobKeyForBuilding, privateJobKeyForBuilding } from "../src/selectors/labor.js";
import { ensureWholesaleMarket } from "../src/systems/wholesale-market.js";
import { processPrivateBuilding } from "../src/systems/private-industry.js";
import { grantResidentVouchers } from "./helpers-v16.js";

// 处理型产业按原料封顶排产（无原料不招人空转），以及民营/公司实物税入批发市场。
// 口径同 operating-plan-stability.test.js：直接在空地放建成的建筑，跳过开工流程。

const I = CONTENT.precision.inventoryUnitsPerJin;
const BAKERY_RECIPE = CONTENT.recipes[CONTENT.buildings.bakery.recipeId];
const FLOUR_PER_BATCH = BAKERY_RECIPE.inputs[0].quantity * I;
const BAKERY_JOB = CONTENT.buildings.bakery.jobs[0].id;
const SALT_JOB = CONTENT.buildings.saltworks.jobs[0].id;

function addBuilding(state, typeId, id, { level = 1, townLevels = level, privateLevels = 0 } = {}) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) &&
    !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `缺少地块 ${typeId}`);
  state.buildings.push({ id, typeId, level, ownership: { townLevels, privateLevels, listedLevels: 0 }, plotId: plot.id,
    x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return state.buildings.at(-1);
}

// 居民每日面包需求：近 7 日实销 2000 斤，让面包有真实需求，排产才会被原料卡住。
function breadDemandHistory(state, jin = 2000) {
  state.market ||= {};
  state.market.consumerHistory = { bread: Array.from({ length: 7 }, () => ({ year: 1, day: 1, soldUnits: jin * I })), salt: [], wood: [] };
}

// 公司面包坊：挂牌 1 级，资金充足，10 名挂牌工人，计划年龄已过试营业期。
function bakeryCompanyState({ marketFlourJin = null, seed = 8101 } = {}) {
  const state = simulation.createInitialState({ seed });
  grantResidentVouchers(state, 300000, CONTENT);
  simulation.issueGrainVouchers(state, "town", 200000);
  addBuilding(state, "wholesale_market", "bk-market", { level: 1, townLevels: 1 });
  addBuilding(state, "bakery", "bk-co", { level: 1, townLevels: 1 });
  const result = formCompany(state, "bk-co", { levels: 1, operatingCapitalVoucher: 20000, initialMaterialQuantity: 0 });
  assert.equal(result.ok, true, result.reason);
  const company = state.companies[result.companyId];
  company.plan = { ageDays: 30 };
  setJobCount(state, listedJobKeyForBuilding("bk-co", BAKERY_JOB), 10, CONTENT);
  breadDemandHistory(state);
  if (marketFlourJin !== null) ensureWholesaleMarket(state, CONTENT).inventory.flour = Math.round(marketFlourJin * I);
  return { state, company };
}

test("面包坊无面粉来源时计划批次为 0，招工每周期裁 1 人，不再空占 10 人", () => {
  const { state, company } = bakeryCompanyState();
  refreshOperatingPlan(state, CONTENT, true);
  const row = state.market.operatingPlan.rows[`company:${company.id}`];
  assert.equal(row.plannedBatches, 0, "原料撑不起任何批次");
  assert.equal(row.desiredWorkers, 9, "现有 10 人、需求 0：每周期只裁 1 人");
  assert.equal(state.market.operatingPlan.demand.bakery.inputLimitedBatches, 0);
  assert.ok(state.market.operatingPlan.demand.bakery.basis.includes("原料不足"), "面板口径应说明原料不足");

  // 连续两个周期：10 → 9 → 8。
  setJobCount(state, listedJobKeyForBuilding("bk-co", BAKERY_JOB), row.desiredWorkers, CONTENT);
  refreshOperatingPlan(state, CONTENT, true);
  assert.equal(state.market.operatingPlan.rows[`company:${company.id}`].desiredWorkers, 8, "第二个周期继续每周期 −1");
});

test("面包坊计划批次不超过批发市场面粉现货能撑起的批次数", () => {
  const N = 3;
  const { state, company } = bakeryCompanyState({ marketFlourJin: N * 5 });
  refreshOperatingPlan(state, CONTENT, true);
  const row = state.market.operatingPlan.rows[`company:${company.id}`];
  assert.equal(FLOUR_PER_BATCH, 5 * I, "本测试按每批 5 斤面粉写算式");
  assert.ok(row.plannedBatches > 0 && row.plannedBatches <= N, `计划批次应在 1..${N}：${row.plannedBatches}`);
  assert.equal(state.market.operatingPlan.demand.bakery.inputLimitedBatches, N, "原料封顶批次记入口径");
  assert.ok(state.market.operatingPlan.demand.bakery.basis.includes("原料不足"));
});

function saltState({ withMarket }) {
  const state = simulation.createInitialState({ seed: 8201 });
  grantResidentVouchers(state, 300000, CONTENT);
  simulation.issueGrainVouchers(state, "town", 200000);
  if (withMarket) addBuilding(state, "wholesale_market", "tx-market", { level: 1, townLevels: 1 });
  const salt = addBuilding(state, "saltworks", "tx-salt", { level: 2, townLevels: 0, privateLevels: 2 });
  setJobCount(state, privateJobKeyForBuilding(salt.id, SALT_JOB), 2, CONTENT);
  return { state, salt };
}

test("民营盐场实物税入批发市场（成本随货带入），镇库盐不变；无批发市场时仍入镇库", () => {
  const withMarket = saltState({ withMarket: true });
  refreshOperatingPlan(withMarket.state, CONTENT, true);
  const townBefore = withMarket.state.accounts.town.salt || 0;
  const result = processPrivateBuilding(withMarket.state, withMarket.salt, CONTENT);
  assert.ok(result.batches > 0, result.reason);
  const taxUnits = result.taxRows.reduce((sum, row) => sum + row.taxUnits, 0);
  assert.ok(taxUnits > 0, "应有实物税");
  assert.equal(withMarket.state.wholesaleMarket.inventory.salt, taxUnits, "税盐进入批发市场库存");
  assert.equal(withMarket.state.accounts.town.salt || 0, townBefore, "镇库盐不因税增加");
  assert.equal(withMarket.state.accounts.town.salt || 0, 0, "原子交易记入镇库的税货已全部搬走");
  const unitCost = CONTENT.items.salt.openingCostWheatPerJin ?? 0;
  assert.equal(withMarket.state.wholesaleMarket.inventoryCostVoucherUnits.salt || 0, Math.round(taxUnits * unitCost), "成本基础随货进入市场");
  assert.equal(withMarket.state.business?.inventoryCostWheatUnits?.town?.salt ?? 0, 0, "镇库成本基础不再因税增加");

  const noMarket = saltState({ withMarket: false });
  refreshOperatingPlan(noMarket.state, CONTENT, true);
  const noMarketResult = processPrivateBuilding(noMarket.state, noMarket.salt, CONTENT);
  const noMarketTax = noMarketResult.taxRows.reduce((sum, row) => sum + row.taxUnits, 0);
  assert.equal(noMarket.state.accounts.town.salt, noMarketTax, "无批发市场时税盐仍入镇库");
});

test("公司实物税入批发市场（成本随货带入），无批发市场时仍入镇库", () => {
  const build = withMarket => {
    const state = simulation.createInitialState({ seed: 8301 });
    grantResidentVouchers(state, 300000, CONTENT);
  simulation.issueGrainVouchers(state, "town", 200000);
    if (withMarket) addBuilding(state, "wholesale_market", "cs-market", { level: 1, townLevels: 1 });
    addBuilding(state, "saltworks", "cs-salt", { level: 1, townLevels: 1 });
    const result = formCompany(state, "cs-salt", { levels: 1, operatingCapitalVoucher: 20000, initialMaterialQuantity: 0 });
    assert.equal(result.ok, true, result.reason);
    setJobCount(state, listedJobKeyForBuilding("cs-salt", SALT_JOB), 2, CONTENT);
    refreshOperatingPlan(state, CONTENT, true);
    return { state, companyId: result.companyId };
  };
  const producedUnits = CONTENT.recipes[CONTENT.buildings.saltworks.recipeId].outputs[0].quantity * I;

  const withMarket = build(true);
  const townBefore = withMarket.state.accounts.town.salt || 0;
  const result = processListedCompany(withMarket.state, withMarket.state.companies[withMarket.companyId], CONTENT);
  assert.equal(result.status, "ready");
  const company = withMarket.state.companies[withMarket.companyId];
  const marketSalt = withMarket.state.wholesaleMarket.inventory.salt || 0;
  assert.ok(marketSalt > 0, "公司税盐应进入批发市场");
  assert.equal(company.inventory.salt + marketSalt, result.batches * producedUnits, "税盐 + 净产出 = 当日产量");
  assert.equal(withMarket.state.accounts.town.salt || 0, townBefore, "镇库盐不因公司税增加");
  assert.equal(simulation.validateCurrencyInvariant(withMarket.state).valid, true);
  assert.equal(simulation.validateState(withMarket.state).valid, true);

  const noMarket = build(false);
  const noMarketResult = processListedCompany(noMarket.state, noMarket.state.companies[noMarket.companyId], CONTENT);
  assert.equal(noMarketResult.status, "ready");
  assert.ok((noMarket.state.accounts.town.salt || 0) > 0, "无批发市场时公司税盐仍入镇库");
});

test("含民营、公司与批发市场的多日推进后，结构校验与货币守恒通过", () => {
  const state = simulation.createInitialState({ seed: 8401 });
  grantResidentVouchers(state, 300000, CONTENT);
  simulation.issueGrainVouchers(state, "town", 200000);
  addBuilding(state, "wholesale_market", "inv-market", { level: 1, townLevels: 1 });
  addBuilding(state, "saltworks", "inv-salt-priv", { level: 2, townLevels: 0, privateLevels: 2 });
  addBuilding(state, "bakery", "inv-bakery-co", { level: 1, townLevels: 1 });
  const bakery = formCompany(state, "inv-bakery-co", { levels: 1, operatingCapitalVoucher: 20000, initialMaterialQuantity: 0 });
  assert.equal(bakery.ok, true, bakery.reason);
  setJobCount(state, privateJobKeyForBuilding("inv-salt-priv", SALT_JOB), 2, CONTENT);
  setJobCount(state, listedJobKeyForBuilding("inv-bakery-co", BAKERY_JOB), 4, CONTENT);
  breadDemandHistory(state, 200);
  for (let day = 0; day < 20; day += 1) simulation.advanceDay(state);
  const structure = simulation.validateState(state);
  assert.equal(structure.valid, true, structure.errors.join("；"));
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true);
});
