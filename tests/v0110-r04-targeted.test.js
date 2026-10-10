import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { initializeBuildingJobs, employmentSnapshot } from "../src/systems/employment.js";
import { householdList, householdIdleWorkers, jobAssignments, syncResidentAggregates } from "../src/systems/households.js";
import { payDailyWages } from "../src/systems/payroll.js";
import { prepareShopsForDay, serviceShopCapacityUses } from "../src/systems/shops.js";
import { accrueServiceDemand, processServiceDemand } from "../src/systems/services.js";
import { ensureHouseholdLife } from "../src/systems/household-life.js";
import { issueVouchersFromWheat } from "../src/economy/currency.js";
import { currentPaymentComposition, settleMonetaryPayment } from "../src/economy/payment.js";
import { companyActualProfitValuation } from "../src/systems/companies.js";
import { migrateSave } from "../src/persistence/migrations.js";
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

function openTeaShop(state, id = "street-r04") {
  const street = addBuilding(state, "commercial_street", id, 1);
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.ok(owner);
  const opened = simulation.openResidentShop(state, street.id, "tea", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  return { street, owner, shop: state.shops[opened.shopId] };
}

function setServiceBudget(household, voucherPerDay) {
  const life = ensureHouseholdLife(household, CONTENT);
  life.recent = [{ incomeVoucherUnits: Math.round(voucherPerDay * V), lifeExpenseVoucherUnits: 0 }];
  life.day = {};
}

function valuationCompany({ capitalVoucher = 20000, inventoryCostVoucher = 0, dailyProfitVoucher = 10 } = {}) {
  return {
    initialInvestment: { cashValueUnits: capitalVoucher * V, materials: [] },
    inventoryCostVoucherUnits: { wheat: inventoryCostVoucher * V },
    inventory: { wheat: inventoryCostVoucher * I },
    history: Array.from({ length: 30 }, (_, index) => ({ serial: index + 1, profitVoucherUnits: dailyProfitVoucher * V, revenueVoucherUnits: dailyProfitVoucher * 2 * V })),
    accounts: { day: { profitVoucherUnits: 0, revenueVoucherUnits: 0 } }
  };
}

test("r04 单店可配置4商人/20店员，茶馆需求与服务容量按新规则扩容", () => {
  const state = simulation.createInitialState({ seed: 110403 });
  const { shop } = openTeaShop(state);
  assert.equal(simulation.configureShopMerchants(state, shop.id, 4).assigned, 4);
  assert.equal(simulation.configureShopClerks(state, shop.id, 20).assigned, 20);
  assert.equal(serviceShopCapacityUses(state, shop, CONTENT), 4 * 40 + 20 * 48);
  const rows = simulation.selectJobRows(state).rows.filter(row => row.scope === "shop");
  assert.equal(rows.find(row => row.roleId === "merchants").count, 4);
  assert.equal(rows.find(row => row.roleId === "shop_clerks").count, 20);

  let demand = 0;
  for (let day = 0; day < 5; day += 1) demand += accrueServiceDemand(state, CONTENT).tea || 0;
  assert.ok(demand >= simulation.populationStats(state).total * 0.95, `5日茶馆需求应接近全镇人口1轮，实际${demand}`);
});

test("r04 服务收入只来自真实居民消费；无支付能力时记录未成交而不虚增收入", () => {
  const state = simulation.createInitialState({ seed: 110404 });
  const { owner, shop } = openTeaShop(state);
  const buyers = householdList(state).filter(h => h.id !== owner.id && householdIdleWorkers(h) >= 0);
  const poor = buyers[0];
  poor.inventory.wheat = 0;
  poor.voucherUnits = 0;
  syncResidentAggregates(state, CONTENT);
  setServiceBudget(poor, 100);
  state.services.demandByHousehold[poor.id] = { tea: 1000, haircut: 0, repair: 0 };
  const revenueBefore = shop.accounts.day.revenueVoucherUnits;
  const poorResult = processServiceDemand(state, CONTENT);
  assert.equal(poorResult.servedUses.tea || 0, 0);
  assert.ok((poorResult.unaffordableUses.tea || 0) >= 1);
  assert.equal(shop.accounts.day.revenueVoucherUnits, revenueBefore);

  const buyer = buyers[1];
  setServiceBudget(buyer, 100);
  state.services.demandByHousehold[buyer.id] = { tea: 1000, haircut: 0, repair: 0 };
  // 开局即粮券：服务付的是粮券，进店铺的粮券现金。
  const beforeCash = shop.cashVoucherUnits;
  const paidResult = processServiceDemand(state, CONTENT);
  assert.equal(paidResult.servedUses.tea || 0, 1);
  assert.equal(shop.accounts.day.revenueVoucherUnits - revenueBefore, 3 * V);
  assert.equal(shop.cashVoucherUnits - beforeCash, 3 * V);
});

test("r04 兑付储备为0仍可直接换券；小麦进入镇库且自动换券与直接换券使用同一汇率", () => {
  const direct = legacyVoucherState({ seed: 110405 });
  const household = householdList(direct).find(h => (h.jobs?.farmers || 0) > 0);
  assert.ok(household);
  const townBefore = direct.accounts.town.wheat;
  const wheatBefore = household.inventory.wheat;
  direct.currency.reserveWheatUnits = 0;
  direct.currency.reserveWheatCostVoucherUnits = 0;
  assert.equal(simulation.issueGrainVouchers(direct, "town", 10).ok, true);
  const issued = issueVouchersFromWheat(direct, `household:${household.id}`, I, CONTENT, "r04直接换券");
  assert.equal(issued.ok, true, issued.reason);
  assert.equal(issued.voucherUnits, V);
  assert.equal(direct.accounts.town.wheat - townBefore, I);
  assert.equal(wheatBefore - household.inventory.wheat, I);
  assert.equal(direct.currency.reserveWheatUnits, 0);
  assert.equal(simulation.validateCurrencyInvariant(direct).valid, true);

  const automatic = legacyVoucherState({ seed: 110406 });
  const payer = householdList(automatic).find(h => (h.jobs?.farmers || 0) > 0);
  payer.voucherUnits = 0;
  syncResidentAggregates(automatic, CONTENT);
  assert.equal(simulation.issueGrainVouchers(automatic, "town", 10).ok, true);
  const autoTownBefore = automatic.accounts.town.wheat;
  const autoIssuedBefore = automatic.currency.issuedCumulativeUnits;
  const payment = settleMonetaryPayment(automatic, `household:${payer.id}`, "town", currentPaymentComposition(automatic, V), CONTENT,
    "r04_auto_exchange", "r04自动换券支付", { requireFull: true });
  assert.equal(payment.ok, true, payment.reason);
  assert.equal(automatic.accounts.town.wheat - autoTownBefore, I);
  assert.equal(automatic.currency.issuedCumulativeUnits - autoIssuedBefore, 0, "自动换券只能转移已印粮券，不能再次发行");
  assert.equal(automatic.currency.reserveWheatUnits, 0);
  assert.equal(simulation.validateCurrencyInvariant(automatic).valid, true);
});

test("r04 公司估值不受库存直接影响；相同利润下投入资本利润率会改变估值", () => {
  const state = { year: 1, day: 30 };
  const a = valuationCompany({ capitalVoucher: 20000, inventoryCostVoucher: 0, dailyProfitVoucher: 10 });
  const b = valuationCompany({ capitalVoucher: 20000, inventoryCostVoucher: 999999, dailyProfitVoucher: 10 });
  const va = companyActualProfitValuation(state, a, CONTENT);
  const vb = companyActualProfitValuation(state, b, CONTENT);
  assert.equal(va.actualProfitVoucherUnits, vb.actualProfitVoucherUnits);
  assert.equal(va.referenceCompanyValueVoucherUnits, vb.referenceCompanyValueVoucherUnits, "库存价值不得直接抬高估值");
  assert.equal(va.annualizedProfitRateBps, vb.annualizedProfitRateBps);

  const highCapital = valuationCompany({ capitalVoucher: 50000, inventoryCostVoucher: 0, dailyProfitVoucher: 10 });
  const vh = companyActualProfitValuation(state, highCapital, CONTENT);
  assert.ok(va.annualizedProfitRateBps > vh.annualizedProfitRateBps);
  assert.ok(va.referenceCompanyValueVoucherUnits > vh.referenceCompanyValueVoucherUnits, "利润率差异应真实进入统一估值");
});
