import test from "node:test";
import assert from "node:assert/strict";
import { jobCount, setJobCount, householdList, householdIdleWorkers } from "../src/systems/households.js";
import { simulation } from "../src/engine.js";
import { formCompany } from "./helpers-ipo.js";
import { CONTENT } from "../src/content/index.js";
import { refreshOperatingPlan, shopTradePrices } from "../src/economy/operating-plan.js";
import { theoreticalFullSaleProfitPerWorker } from "../src/economy/prices.js";
import { companySummary, processListedCompany } from "../src/systems/companies.js";
import { prepareShopsForDay, shopSalesCapacityUnits } from "../src/systems/shops.js";
import { transferVouchers } from "../src/economy/currency.js";
import { exportState, importState } from "../src/persistence/storage.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = { id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  const jobs = CONTENT.buildings[typeId].jobs || [];
  return building;
}

function fundTown(state, amount = 100000) {
  const result = simulation.issueGrainVouchers(state, "town", amount);
  assert.equal(result.ok, true, result.reason);
}

function list(state, buildingId, capital = 20000) {
  const result = formCompany(state, buildingId, { levels: 1, operatingCapitalVoucher: capital, initialMaterialQuantity: 0 });
  assert.equal(result.ok, true, result.reason);
  return state.companies[result.companyId];
}

function addStreetAndOwner(state, id = "street-011") {
  const street = addBuilding(state, "commercial_street", id);
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.ok(owner);
  assert.equal(grantResidentVouchers(state, 2000, CONTENT, owner.id).ok, true);
  return { street, owner };
}

test("0.1.1真实面包链：采购、生产、批发、零售分别记账且实物与粮券守恒", () => {
  const state = legacyVoucherState({ seed: 1101 });
  state.policy.unemploymentBenefit.enabled = false;
  addBuilding(state, "wholesale_market", "011-wholesale");
  addBuilding(state, "mill", "011-mill");
  addBuilding(state, "bakery", "011-bakery");
  const { street, owner } = addStreetAndOwner(state);
  fundTown(state, 120000);
  const mill = list(state, "011-mill", 25000);
  const bakery = list(state, "011-bakery", 25000);
  const opened = simulation.openResidentShop(state, street.id, "bakery", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, 1).ok, true);
  assert.equal(transferVouchers(state, "town", `shop:${opened.shopId}`, 1000 * V, CONTENT, "test_shop_capital", "补足测试进货资金").ok, true);
  assert.equal(simulation.configureWholesaleTownAllocation(state, "wheat", 1000).ok, true);
  // 原料链分两个计划周期才通：面包坊先等上游上一周期的面粉计划产量，再排产、进货、零售。
  simulation.advanceDays(state, 20);
  const shop = state.shops[opened.shopId];
  assert.ok((mill.accounts.cumulative.purchasedInputUnits.wheat || 0) > 0);
  assert.ok((bakery.accounts.cumulative.purchasedInputUnits.flour || 0) > 0);
  assert.ok((mill.accounts.cumulative.revenueVoucherUnits || 0) > 0);
  assert.ok((bakery.accounts.cumulative.producedUnits.bread || 0) > 0);
  assert.ok((shop.accounts.cumulative.purchasedUnits.bread || 0) > 0, "店铺必须真实进货");
  assert.ok((shop.accounts.cumulative.soldUnits.bread || 0) > 0, "店铺必须取得真实零售成交");
  const bakeryNetProduced = (bakery.accounts.cumulative.producedUnits.bread || 0) - (bakery.accounts.cumulative.taxedUnits.bread || 0);
  assert.equal((bakery.inventory.bread || 0) + (bakery.accounts.cumulative.soldUnits.bread || 0), bakeryNetProduced,
    "企业面包只能留库或真实售出一次");
  assert.equal((shop.inventory.bread || 0) + (shop.accounts.cumulative.soldUnits.bread || 0), shop.accounts.cumulative.purchasedUnits.bread || 0,
    "店铺库存只能来自真实进货，零售后只扣一次");
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("0.1.1多家企业共享同一需求，过剩库存后按周期缩减计划与用工", () => {
  const state = legacyVoucherState({ seed: 1102 });
  // 基线清理：换券额度固定为旧默认 2 斤，避免新默认 5 斤改变居民需求口径。
  state.policy.employmentExchangeJin = 2;
  addBuilding(state, "bakery", "011-bakery-a");
  addBuilding(state, "bakery", "011-bakery-b");
  fundTown(state, 100000);
  // 面粉现货：无批发市场时看镇库存量。无原料的面包坊不排产，本测试只比较需求与积压减产。
  state.accounts.town.flour = 100000 * I;
  const a = list(state, "011-bakery-a");
  const b = list(state, "011-bakery-b");
  refreshOperatingPlan(state, CONTENT, true);
  const rows = [a, b].map(c => state.market.operatingPlan.rows[`company:${c.id}`]);
  const target = state.market.operatingPlan.demand.bakery.targetUnits;
  const maxBatches = Math.ceil(target / (6 * I));
  assert.ok(rows.reduce((sum, row) => sum + row.plannedBatches, 0) <= maxBatches,
    "全镇需求只能分一次，不能每家复制一份");
  a.plan.ageDays = b.plan.ageDays = CONTENT.rules.newBusinessTrialDays + 1;
  setJobCount(state, `${a.buildingId}::bakers::listed`, 5, CONTENT);
  setJobCount(state, `${b.buildingId}::bakers::listed`, 5, CONTENT);
  refreshOperatingPlan(state, CONTENT, true);
  const plannedWithoutStock = [a, b].reduce((sum, c) => sum + state.market.operatingPlan.rows[`company:${c.id}`].plannedBatches, 0);
  // 市面积压大量面包：备货缺口分几天消化，计划减产而不是一刀切停工；用工每个周期最多减 1 人。
  a.inventory.bread = 2000 * I;
  b.inventory.bread = 2000 * I;
  refreshOperatingPlan(state, CONTENT, true);
  const after = [a, b].map(c => state.market.operatingPlan.rows[`company:${c.id}`]);
  const plannedWithStock = after.reduce((sum, row) => sum + row.plannedBatches, 0);
  assert.ok(plannedWithStock < plannedWithoutStock, `积压时应减产：${plannedWithStock} vs ${plannedWithoutStock}`);
  assert.ok(after.every(row => row.desiredWorkers === 4), "裁人每个周期最多 1 人，避免开停工抖动");
});

test("0.1.1高工资、高生产税和原料涨价都会压低利润，经营反馈能指出主要成本问题", () => {
  const state = legacyVoucherState({ seed: 1103 });
  const base = theoreticalFullSaleProfitPerWorker(state, "bakery", CONTENT).profitVoucher;
  state.employment.wageRates.bakers = 30;
  const highWage = theoreticalFullSaleProfitPerWorker(state, "bakery", CONTENT).profitVoucher;
  state.employment.wageRates.bakers = 10;
  state.policy.privateProductionTaxPercent.bakery = 40;
  const highTax = theoreticalFullSaleProfitPerWorker(state, "bakery", CONTENT).profitVoucher;
  state.policy.privateProductionTaxPercent.bakery = 10;
  simulation.configureIntermediatePrice(state, "flour", 3);
  const highInput = theoreticalFullSaleProfitPerWorker(state, "bakery", CONTENT).profitVoucher;
  assert.ok(highWage < base && highTax < base && highInput < base);

  addBuilding(state, "bakery", "011-cost-bakery");
  fundTown(state, 30000);
  const company = list(state, "011-cost-bakery", 10000);
  company.history = Array.from({ length: 7 }, (_, serial) => ({ serial, soldUnits: 20 * I,
    revenueVoucherUnits: 40 * V, inputPurchaseVoucherUnits: 70 * V, wageExpenseVoucherUnits: 10 * V, profitVoucherUnits: -40 * V }));
  company.inventory.bread = 10 * I;
  const summary = companySummary(state, company, CONTENT);
  assert.equal(summary.status, "原料成本高");
});

test("0.1.1新企业可试生产；缺订单停产后，有预算木材订单会重新形成生产计划", () => {
  const state = legacyVoucherState({ seed: 1104 });
  addBuilding(state, "lumberyard", "011-lumber");
  fundTown(state, 50000);
  const company = list(state, "011-lumber", 10000);
  refreshOperatingPlan(state, CONTENT, true);
  assert.ok(company.plan.plannedBatches > 0 && company.plan.desiredWorkers > 0, "无历史的新企业允许小规模试产");
  company.plan.ageDays = CONTENT.rules.newBusinessTrialDays + 1;
  refreshOperatingPlan(state, CONTENT, true);
  assert.equal(company.plan.plannedBatches, 0, "观察期后无建设订单不继续伐木");
  const intent = simulation.setPublicProcurementIntent(state, { kind: "build", typeId: "commercial_street" });
  assert.equal(intent.ok, true, intent.reason);
  refreshOperatingPlan(state, CONTENT, true);
  assert.ok(company.plan.plannedBatches > 0, "有预算的实际订单恢复生产计划");
});

test("0.1.1木材生产不等于销售：有订单可生产，但没有实际采购就不确认收入", () => {
  const state = legacyVoucherState({ seed: 1105 });
  addBuilding(state, "lumberyard", "011-lumber-revenue");
  fundTown(state, 50000);
  const company = list(state, "011-lumber-revenue", 10000);
  company.plan.ageDays = CONTENT.rules.newBusinessTrialDays + 1;
  simulation.setPublicProcurementIntent(state, { kind: "build", typeId: "town_hall" });
  refreshOperatingPlan(state, CONTENT, true);
  setJobCount(state, `${company.buildingId}::lumberjacks::listed`, 2, CONTENT);
  const result = processListedCompany(state, company, CONTENT);
  assert.ok(result.batches > 0);
  assert.ok(company.inventory.wood > 0);
  assert.equal(company.accounts.day.revenueVoucherUnits, 0, "未成交库存不能冒充收入");
  simulation.clearPublicProcurementIntent(state, "wood");
  company.plan.ageDays = CONTENT.rules.newBusinessTrialDays + 1;
  refreshOperatingPlan(state, CONTENT, true);
  assert.equal(company.plan.plannedBatches, 0);
});

test("0.1.1综合商店按真实客流增员，且新店员满30日后才允许缩员", () => {
  const state = legacyVoucherState({ seed: 1106 });
  const { street, owner } = addStreetAndOwner(state, "011-street-clerk");
  const opened = simulation.openResidentShop(state, street.id, "bakery", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  // 商人计入接待能力；客流按户计，每位客人按一户人家的日用量（shopJinPerCustomer）折算。
  const perStaffUnits = CONTENT.rules.generalStoreCustomersPerStaff * CONTENT.rules.shopJinPerCustomer * I;
  assert.equal(shopSalesCapacityUnits(state, shop, CONTENT), perStaffUnits, "仅商人时应有商人本人的接待能力");
  // 用户 0.1.11 新增增员经济性门槛：需盈利且资金充足才增员，先注资。
  // 资金门槛 = (店员+商人) × 每人日接待量 × 平均批发价 + 3 日工资；每人 400 斤（20 户 × 20 斤）后，
  // 2 人的备货门槛约 6000 多粮券（2000 粮券已不够），因此注资 10000 粮券。
  fundTown(state, 100000);
  assert.equal(transferVouchers(state, "town", `shop:${shop.id}`, 10000 * V, CONTENT, "test_shop_capital", "补足测试增员资金").ok, true);
  shop.history = Array.from({ length: CONTENT.rules.operatingObservationDays }, (_, serial) => ({
    serial, customerCount: 0, rejectedCustomerCount: 100, soldUnits: 0, profitVoucherUnits: 0
  }));
  prepareShopsForDay(state, CONTENT);
  assert.equal(jobCount(state, `shop:${shop.id}:clerk`), 1);
  assert.equal(shopSalesCapacityUnits(state, shop, CONTENT), 2 * perStaffUnits, "1名店员加商人的接待能力是商人一人时的两倍");

  state.day += CONTENT.rules.operatingPlanIntervalDays;
  shop.history = Array.from({ length: CONTENT.rules.operatingObservationDays }, (_, serial) => ({
    serial, customerCount: 0, rejectedCustomerCount: 0, soldUnits: 0, profitVoucherUnits: -1 * V
  }));
  prepareShopsForDay(state, CONTENT);
  assert.equal(jobCount(state, `shop:${shop.id}:clerk`), 1, "工作未满30天不得自动解雇");

  state.day += CONTENT.rules.shopMinimumEmploymentDays;
  prepareShopsForDay(state, CONTENT);
  assert.equal(jobCount(state, `shop:${shop.id}:clerk`), 0, "满30天且持续无客流后允许缩员");
});

test("0.1.1本金、未售库存和债务继续分开：本金不成利润，停业不抹掉既有欠薪", () => {
  const state = legacyVoucherState({ seed: 1107 });
  addBuilding(state, "saltworks", "011-capital-company");
  fundTown(state, 30000);
  const company = list(state, "011-capital-company", 5000);
  const retained = company.retainedEarningsVoucherUnits;
  assert.equal(simulation.addCompanyCapital(state, company.id, 2000).ok, true);
  assert.equal(company.retainedEarningsVoucherUnits, retained, "企业注资不是利润");

  const { street, owner } = addStreetAndOwner(state, "011-street-debt");
  const opened = simulation.openResidentShop(state, street.id, "bakery", owner.id);
  const shop = state.shops[opened.shopId];
  state.accounts.town.bread = 1000 * I;
  assert.equal(simulation.configureShopClerks(state, shop.id, 1).assigned, 1);
  if (shop.cashVoucherUnits > 0) {
    assert.equal(transferVouchers(state, `shop:${shop.id}`, `household:${owner.id}`, shop.cashVoucherUnits, CONTENT, "test_drain", "测试抽干现金").ok, true);
  }
  prepareShopsForDay(state, CONTENT);
  assert.equal(shop.accounts.day.revenueVoucherUnits, 0);
  assert.ok(shop.inventory.bread >= 0);
  const debt = shop.liabilities.wageVoucherUnits;
  assert.ok(debt > 0);
  assert.equal(simulation.closeResidentShop(state, shop.id).ok, true);
  assert.equal(shop.liabilities.wageVoucherUnits, debt, "停业只释放岗位，不清除已形成债务");
});

test("0.1.1保存恢复保持家庭、岗位、库存、股份与经营计划一致，使用v12货币改革结构", () => {
  const state = legacyVoucherState({ seed: 1108 });
  addBuilding(state, "bakery", "011-save-bakery");
  fundTown(state, 50000);
  const company = list(state, "011-save-bakery", 10000);
  refreshOperatingPlan(state, CONTENT, true);
  const before = JSON.parse(JSON.stringify({ households: state.households, employment: state.employment,
    inventory: company.inventory, shares: { total: company.totalShares, town: company.townShares, resident: company.residentShares },
    plan: company.plan, operatingPlan: state.market.operatingPlan }));
  const restored = importState({ getItem() { return null; }, setItem() {} }, exportState(state), CONTENT);
  const restoredCompany = restored.companies[company.id];
  assert.equal(restored.schemaVersion, CONTENT.rules.saveVersion);
  for (const [id, household] of Object.entries(before.households.byId)) {
    assert.deepEqual(restored.households.byId[id].inventory, household.inventory);
    assert.equal(restored.households.byId[id].voucherUnits, household.voucherUnits);
    assert.deepEqual(restored.households.byId[id].shares, household.shares);
    assert.deepEqual(restored.households.byId[id].ageBands, household.ageBands);
    assert.deepEqual(restored.households.byId[id].jobs, household.jobs);
  }
  assert.equal(restored.households.members, undefined);
  assert.deepEqual(restored.employment, before.employment);
  assert.deepEqual(restoredCompany.inventory, before.inventory);
  assert.deepEqual({ total: restoredCompany.totalShares, town: restoredCompany.townShares, resident: restoredCompany.residentShares }, before.shares);
  assert.deepEqual(restoredCompany.plan, before.plan);
  assert.deepEqual(restored.market.operatingPlan, before.operatingPlan);
  assert.equal(simulation.validateState(restored).valid, true, simulation.validateState(restored).errors.join("；"));
});

test("0.1.1综合商店售价固定为批发价加20%", () => {
  const state = legacyVoucherState();
  assert.equal(simulation.setBreadPrice(state, 2.5).ok, true);
  const price = shopTradePrices(state, "bakery", CONTENT);
  assert.equal(price.wholesaleVoucherPerUnit, 2.5);
  assert.equal(price.retailVoucherPerUnit, 3);
});

test("0.1.1修正：木材订单被现有企业库存完全覆盖时不再追加生产", () => {
  const state = legacyVoucherState({ seed: 1110 });
  addBuilding(state, "lumberyard", "011-wood-covered");
  fundTown(state, 50000);
  const company = list(state, "011-wood-covered", 10000);
  company.plan.ageDays = CONTENT.rules.newBusinessTrialDays + 1;
  company.inventory.wood = 2000 * I;
  assert.equal(simulation.setPublicProcurementIntent(state, { kind: "build", typeId: "public_housing" }).ok, true);
  refreshOperatingPlan(state, CONTENT, true);
  assert.equal(state.market.operatingPlan.demand.lumberyard.targetUnits, 0);
  assert.equal(company.plan.plannedBatches, 0, "2000木材库存已覆盖2000订单，不应再安排20批生产");
});

test("0.1.1修正：木材订单部分被库存覆盖时只生产剩余缺口", () => {
  const state = legacyVoucherState({ seed: 1111 });
  addBuilding(state, "lumberyard", "011-wood-partial");
  fundTown(state, 50000);
  const company = list(state, "011-wood-partial", 10000);
  company.plan.ageDays = CONTENT.rules.newBusinessTrialDays + 1;
  company.inventory.wood = 750 * I;
  simulation.setPublicProcurementIntent(state, { kind: "build", typeId: "public_housing" });
  refreshOperatingPlan(state, CONTENT, true);
  assert.equal(state.market.operatingPlan.demand.lumberyard.targetUnits, 1250 * I);
  assert.equal(company.plan.plannedBatches, 20, "剩余1250单位缺口存在，但单日计划不得超过当前伐木场20批产能");
});

test("0.1.1修正：木材订单取消后立即清零生产缺口", () => {
  const state = legacyVoucherState({ seed: 1112 });
  addBuilding(state, "lumberyard", "011-wood-cancel");
  fundTown(state, 50000);
  const company = list(state, "011-wood-cancel", 10000);
  company.plan.ageDays = CONTENT.rules.newBusinessTrialDays + 1;
  simulation.setPublicProcurementIntent(state, { kind: "build", typeId: "public_housing" });
  refreshOperatingPlan(state, CONTENT, true);
  assert.ok(company.plan.plannedBatches > 0);
  simulation.clearPublicProcurementIntent(state, "wood");
  refreshOperatingPlan(state, CONTENT, true);
  assert.equal(company.plan.plannedBatches, 0);
  assert.equal(state.market.operatingPlan.demand.lumberyard.targetUnits, 0);
});

test("0.1.1修正：木材订单由镇库库存补足或完成后不再安排生产", () => {
  const state = legacyVoucherState({ seed: 1113 });
  addBuilding(state, "lumberyard", "011-wood-finished");
  fundTown(state, 50000);
  const company = list(state, "011-wood-finished", 10000);
  company.plan.ageDays = CONTENT.rules.newBusinessTrialDays + 1;
  simulation.setPublicProcurementIntent(state, { kind: "build", typeId: "public_housing" });
  state.accounts.town.wood = 2000 * I;
  refreshOperatingPlan(state, CONTENT, true);
  assert.equal(company.plan.plannedBatches, 0, "镇库库存变化应即时覆盖剩余订单");
  simulation.clearPublicProcurementIntent(state, "wood");
  refreshOperatingPlan(state, CONTENT, true);
  assert.equal(company.plan.plannedBatches, 0, "订单完成清除后保持无新增生产");
});
