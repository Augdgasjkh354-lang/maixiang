import test from "node:test";
import assert from "node:assert/strict";
import { householdIdleWorkers, householdList, jobAssignments, jobCount, releaseJobFromHousehold, setJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { simulation, CONTENT } from "../src/engine.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { buyInputForCompany } from "../src/systems/companies.js";
import { purchaseItemForResidents } from "../src/systems/consumer-market.js";
import { prepareShopsForDay, closeShop, syncShopEmployment } from "../src/systems/shops.js";
import { transferVouchers } from "../src/economy/currency.js";
import { addInventory } from "../src/economy/inventory.js";
import { loadState, saveState, SAVE_KEY } from "../src/persistence/storage.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { renderSite } from "../src/ui/panel-site.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { shopTradePrices } from "../src/economy/operating-plan.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function memoryStorage(raw = null) {
  const data = new Map(raw == null ? [] : [[SAVE_KEY, raw]]);
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    raw() { return data.get(SAVE_KEY); }
  };
}

function addBuilding(state, typeId, id, level = 1) {
  const def = CONTENT.buildings[typeId];
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = { id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function shopOwner(state, amount = 3000) {
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.ok(owner);
  assert.equal(grantResidentVouchers(state, amount, CONTENT, owner.id).ok, true);
  return owner;
}

function merchantKey(shop) { return `shop:${shop.id}:merchant`; }
function clerkKey(shop) { return `shop:${shop.id}:clerk`; }

test("r03 商业街商人岗位失效后暂停经营，可保存、读取并继续一天", () => {
  const state = legacyVoucherState({ seed: 120301 });
  const street = addBuilding(state, "commercial_street", "r03-street-retire");
  const owner = shopOwner(state);
  const opened = simulation.openResidentShop(state, street.id, "grain", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, 1).assigned, 1);
  const shop = state.shops[opened.shopId];
  assert.equal(jobCount(state, merchantKey(shop)), 1);
  assert.equal(jobCount(state, clerkKey(shop)), 1);

  // 聚合模型中“商人无法维持岗位”由家庭岗位记录体现；具体退休链另由0.1.3人口测试覆盖。
  assert.equal(releaseJobFromHousehold(state, owner.id, merchantKey(shop), 1), 1);
  syncShopEmployment(state, CONTENT);
  assert.equal(shop.status, "paused");
  assert.equal(jobCount(state, merchantKey(shop)), 0);
  assert.equal(jobCount(state, clerkKey(shop)), 0);
  assert.equal(simulation.selectDashboard(state).shops.find(row => row.id === shop.id).capacityJin, 0);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));

  const storage = memoryStorage();
  assert.equal(saveState(storage, state, CONTENT), true);
  const loaded = loadState(storage, CONTENT).state;
  const loadedShop = loaded.shops[shop.id];
  assert.equal(loadedShop.status, "paused");
  assert.equal(jobCount(loaded, merchantKey(loadedShop)), 0);
  assert.equal(jobCount(loaded, clerkKey(loadedShop)), 0);
  assert.equal(simulation.validateState(loaded).valid, true, simulation.validateState(loaded).errors.join("；"));
  simulation.advanceDay(loaded);
  assert.equal(simulation.validateState(loaded).valid, true, simulation.validateState(loaded).errors.join("；"));
});

test("r03 读取当前版本 paused 存档时清理残留店员岗位，再执行正常校验", () => {
  const state = legacyVoucherState({ seed: 120302 });
  const street = addBuilding(state, "commercial_street", "r03-street-missing");
  const owner = shopOwner(state);
  const opened = simulation.openResidentShop(state, street.id, "salt", owner.id);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, 1).assigned, 1);
  const shop = state.shops[opened.shopId];
  assert.equal(releaseJobFromHousehold(state, owner.id, merchantKey(shop), 1), 1);
  shop.status = "paused";
  shop.statusReason = "商人缺位，暂停经营";
  assert.equal(jobCount(state, clerkKey(shop)), 1, "构造旧 paused 存档中的残留店员岗位");

  const loaded = loadState(memoryStorage(JSON.stringify(state)), CONTENT).state;
  const loadedShop = loaded.shops[shop.id];
  assert.equal(loadedShop.status, "paused");
  assert.equal(loadedShop.statusReason, "商人缺位，店员已遣散");
  assert.equal(jobCount(loaded, merchantKey(loadedShop)), 0);
  assert.equal(jobCount(loaded, clerkKey(loadedShop)), 0);
  assert.equal(simulation.validateState(loaded).valid, true, simulation.validateState(loaded).errors.join("；"));
});

test("r03 负债店铺停业进入待清算，停止新增费用，补资按工资→租金→税款清偿后才返还资产", () => {
  const state = legacyVoucherState({ seed: 120303 });
  // 基线清理：换券额度固定为旧默认 2 斤，避免新默认 5 斤改变店员工资与租金的清偿口径。
  state.policy.employmentExchangeJin = 2;
  const street = addBuilding(state, "commercial_street", "r03-street-liquidation");
  const owner = shopOwner(state, 3000);
  const opened = simulation.openResidentShop(state, street.id, "salt", owner.id);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, 1).assigned, 1);
  const shop = state.shops[opened.shopId];
  const clerkAssignment = jobAssignments(state, clerkKey(shop))[0];
  assert.ok(clerkAssignment);
  const clerkHouseholdId = clerkAssignment.householdId;
  shop.inventory.salt = 55 * I;
  const ownerSaltBefore = owner.inventory.salt || 0;
  const townSaltBefore = state.accounts.town.salt || 0;
  if (shop.cashVoucherUnits > 0) {
    assert.equal(transferVouchers(state, `shop:${shop.id}`, `household:${owner.id}`, shop.cashVoucherUnits, CONTENT,
      "test_drain", "测试抽干店铺现金").ok, true);
  }
  prepareShopsForDay(state, CONTENT);
  // 基线清理：店主商人不领固定工资，仅店员（5/天，默认日薪 10→5 斤）计提，共 5*V。
  assert.equal(shop.liabilities.wageVoucherUnits, 5 * V);
  assert.equal(shop.liabilities.rentVoucherUnits, 1 * V);
  shop.settlement.profitVoucherUnits = 100 * V;
  shop.retainedEarningsVoucherUnits = 100 * V;

  const firstClose = closeShop(state, shop.id, CONTENT, false);
  assert.equal(firstClose.ok, true);
  assert.equal(shop.status, "liquidating");
  assert.equal(jobCount(state, merchantKey(shop)), 0);
  assert.equal(jobCount(state, clerkKey(shop)), 0);
  assert.equal(owner.inventory.salt || 0, ownerSaltBefore, "有债务时库存不能返还业主");
  assert.equal(state.accounts.town.salt || 0, townSaltBefore, "清算不得强迫镇库买库存");
  assert.ok(shop.liabilities.taxVoucherUnits > 0, "停业日应结清应计利润税");
  const liquidationHtml = renderSite(simulation.selectDashboard(state, { site: `building:${street.id}`, paused: true }));
  assert.match(liquidationHtml, /业主补资清偿/);
  assert.doesNotMatch(liquidationHtml, /data-shop-clerk=/, "待清算店铺不应继续提供店员操作");
  const debtAfterClose = { ...shop.liabilities };
  const repeated = closeShop(state, shop.id, CONTENT, false);
  assert.equal(repeated.ok, true);
  assert.deepEqual(shop.liabilities, debtAfterClose, "重复停业不能重复计税或还款");
  const wageBeforeDay = shop.liabilities.wageVoucherUnits;
  const rentBeforeDay = shop.liabilities.rentVoucherUnits;
  prepareShopsForDay(state, CONTENT);
  assert.equal(shop.liabilities.wageVoucherUnits, wageBeforeDay, "待清算不再新增工资");
  assert.equal(shop.liabilities.rentVoucherUnits, rentBeforeDay, "待清算不再新增租金");

  const ownerBalance = owner.voucherUnits;
  if (ownerBalance > 5 * V) {
    assert.equal(transferVouchers(state, `household:${owner.id}`, "town", ownerBalance - 5 * V, CONTENT,
      "test_reduce_owner_cash", "测试保留少量补资").ok, true);
  }
  const wageLiabilityBefore = shop.liabilities.wageVoucherUnits;
  const rentLiabilityBefore = shop.liabilities.rentVoucherUnits;
  const taxLiabilityBefore = shop.liabilities.taxVoucherUnits;
  const partial = simulation.fundResidentShopLiquidation(state, shop.id);
  assert.equal(partial.ok, true);
  assert.equal(partial.liquidationPending, true);
  // 基线清理：补资按 waterfall 先偿工资→租金→税款。contribution 是补资总额，
  // 未必等于工资减少额（清偿额够多时会顺带清掉租金/税款），所以逐级核对 waterfall 是否被越级：
  // 工资未清则租税必须原封不动；工资已清才轮到租金；租金已清才轮到税款。
  const wagePaid = wageLiabilityBefore - shop.liabilities.wageVoucherUnits;
  const rentPaid = rentLiabilityBefore - shop.liabilities.rentVoucherUnits;
  const taxPaid = taxLiabilityBefore - shop.liabilities.taxVoucherUnits;
  assert.ok(partial.contributedVoucherUnits >= wagePaid, "补资先偿付工资债权");
  assert.ok(wagePaid <= wageLiabilityBefore);
  if (wagePaid < wageLiabilityBefore) {
    assert.equal(rentPaid, 0, "工资未清前不得支付租金");
    assert.equal(taxPaid, 0, "工资未清前不得缴纳利润税");
  } else if (rentPaid < rentLiabilityBefore) {
    assert.equal(taxPaid, 0, "租金未清前不得缴纳利润税");
  }

  assert.equal(grantResidentVouchers(state, 100, CONTENT, owner.id).ok, true);
  const finished = simulation.fundResidentShopLiquidation(state, shop.id);
  assert.equal(finished.ok, true);
  assert.equal(finished.liquidationPending, false);
  assert.equal(shop.status, "closed");
  assert.equal(shop.liabilities.wageVoucherUnits, 0);
  assert.equal(shop.liabilities.rentVoucherUnits, 0);
  assert.equal(shop.liabilities.taxVoucherUnits, 0);
  assert.equal(owner.inventory.salt, ownerSaltBefore + 55 * I, "债务清零后才返还库存");
  assert.equal(closeShop(state, shop.id, CONTENT, false).alreadyClosed, true, "重复执行不能再次返还资产");
  assert.equal(owner.inventory.salt, ownerSaltBefore + 55 * I);
});

test("r03 镇库销售统一同步移除库存成本：企业连续采购、店铺进货、居民购买与失败交易", () => {
  const companyState = legacyVoucherState({ seed: 120304 });
  const mill = addBuilding(companyState, "mill", "r03-company-mill");
  assert.equal(simulation.issueGrainVouchers(companyState, "town", 50000).ok, true);
  const listed = simulation.listCompany(companyState, mill.id, { levels: 1, operatingCapitalVoucher: 10000, initialMaterialQuantity: 0 });
  assert.equal(listed.ok, true, listed.reason);
  for (const household of householdList(companyState)) household.inventory.wheat = 0;
  syncResidentAggregates(companyState, CONTENT);
  const company = companyState.companies[listed.companyId];
  const stock0 = companyState.accounts.town.wheat;
  const basis0 = companyState.business.inventoryCostWheatUnits.town.wheat;
  const r1 = buyInputForCompany(companyState, company, "wheat", 10 * I, CONTENT);
  assert.equal(r1.boughtUnits, 10 * I);
  const expected1 = Math.floor(basis0 * (10 * I) / stock0);
  assert.equal(companyState.business.inventoryCostWheatUnits.town.wheat, basis0 - expected1);
  const stock1 = stock0 - 10 * I;
  const basis1 = basis0 - expected1;
  const r2 = buyInputForCompany(companyState, company, "wheat", 10 * I, CONTENT);
  const expected2 = Math.floor(basis1 * (10 * I) / stock1);
  assert.equal(r2.boughtUnits, 10 * I);
  assert.equal(companyState.business.inventoryCostWheatUnits.town.wheat, basis1 - expected2, "连续交易按卖方剩余账面成本继续移除");
  assert.equal(company.inventoryCostVoucherUnits.wheat, r1.paidVoucherUnits + r2.paidVoucherUnits, "买方按实际成交价入账");

  const shopState = legacyVoucherState({ seed: 120305 });
  const street = addBuilding(shopState, "commercial_street", "r03-cost-street");
  const owner = shopOwner(shopState);
  shopState.accounts.town.bread = 100 * I;
  shopState.business.inventoryCostWheatUnits.town.bread = 60 * V;
  const opened = simulation.openResidentShop(shopState, street.id, "bakery", owner.id);
  // 基线清理：综合商店按店员数折算客容量，无店员则不进货；补配 1 名店员以产生进货需求。
  assert.equal(simulation.configureShopClerks(shopState, opened.shopId, 1).assigned, 1);
  const shop = shopState.shops[opened.shopId];
  const beforeStock = shopState.accounts.town.bread;
  const beforeBasis = shopState.business.inventoryCostWheatUnits.town.bread;
  prepareShopsForDay(shopState, CONTENT);
  const bought = shop.accounts.day.purchasedUnits.bread || 0;
  assert.ok(bought > 0);
  assert.equal(shopState.business.inventoryCostWheatUnits.town.bread,
    beforeBasis - Math.floor(beforeBasis * bought / beforeStock));
  const breadTrade = shopTradePrices(shopState, "general", CONTENT, "bread");
  const expectedBreadPurchaseCost = Math.round((bought / I) * breadTrade.wholesaleVoucherPerUnit * V);
  assert.equal(shop.inventoryCostVoucherUnits.bread, expectedBreadPurchaseCost, "综合商店按商品独立记录面包进货成本");
  assert.ok(shop.accounts.day.purchaseVoucherUnits >= expectedBreadPurchaseCost, "店铺总采购额可以包含其他商品，但不得重复计入面包成本");

  const residentState = legacyVoucherState({ seed: 120306 });
  const buyer = householdList(residentState)[0];
  residentState.policy.employmentExchangeJin = 0;
  residentState.accounts.town.bread = 10 * I;
  residentState.business.inventoryCostWheatUnits.town.bread = 7 * V;
  assert.equal(grantResidentVouchers(residentState, 100, CONTENT, buyer.id).ok, true);
  // 基线清理：面包只能经综合商店零售（consumer-market.js generalStoreOnly），镇库不做零售；
  // 先建综合商店并从镇库进货（镇库→商店，成本同步移除），再由居民从商店购买。
  const rStreet = addBuilding(residentState, "commercial_street", "r03-resident-street");
  const rOwner = shopOwner(residentState);
  const rOpened = simulation.openResidentShop(residentState, rStreet.id, "general", rOwner.id);
  assert.equal(simulation.configureShopClerks(residentState, rOpened.shopId, 5).assigned, 5);
  prepareShopsForDay(residentState, CONTENT);
  const rShop = residentState.shops[rOpened.shopId];
  assert.ok((rShop.inventory.bread || 0) > 0, "商店应从镇库进到面包");
  const sale = purchaseItemForResidents(residentState, "bread", 10 * I, 1, CONTENT, "r03全量购买",
    { householdNeedsUnits: { [buyer.id]: 10 * I } });
  assert.ok(sale.purchasedUnits > 0, "居民应能从综合商店买到面包");
  // 镇库面包已全部被商店进货提走，成本基数归零。
  assert.equal(residentState.accounts.town.bread, 0);
  assert.equal(residentState.business.inventoryCostWheatUnits.town.bread, 0, "库存归零时成本基数必须归零");

  const failed = legacyVoucherState({ seed: 120307 });
  const poor = householdList(failed)[0];
  failed.policy.employmentExchangeJin = 0;
  failed.accounts.town.bread = 10 * I;
  failed.business.inventoryCostWheatUnits.town.bread = 7 * V;
  const failedStock = failed.accounts.town.bread;
  const failedBasis = failed.business.inventoryCostWheatUnits.town.bread;
  const noSale = purchaseItemForResidents(failed, "bread", 10 * I, 1, CONTENT, "r03失败购买",
    { householdNeedsUnits: { [poor.id]: 10 * I } });
  assert.equal(noSale.purchasedUnits, 0);
  assert.equal(failed.accounts.town.bread, failedStock);
  assert.equal(failed.business.inventoryCostWheatUnits.town.bread, failedBasis, "失败交易不能留下半笔库存成本");
});

test("r03 建设预览与实际分配共用真实就业：5名待业只安排5人，0待业显示等待用工", () => {
  const state = legacyVoucherState({ seed: 120308 });
  setJobCount(state, "farmers", 0, CONTENT);
  // 劳动力 600→1750（8cf03ae）：50 级磨坊仅 600 岗位，不足以吃掉新劳动力，
  // 提升到 146 级（146×12=1752 岗位）才能精确构造"仅剩 5 名待业"。
  const listedBuilding = addBuilding(state, "mill", "r03-labor-listed", 146);
  listedBuilding.ownership = { townLevels: 0, privateLevels: 0, listedLevels: 146 };
  setJobCount(state, `${listedBuilding.id}::millers::listed`, 1745, CONTENT);
  assert.equal(simulation.selectJobRows(state).idle, 5);
  const preview = simulation.selectDashboard(state).constructionOptions.find(row => row.id === "bakery");
  assert.equal(preview.previewBuilders, 5);
  assert.equal(preview.constructionCrewDays, Math.ceil(CONTENT.buildings.bakery.construction.workDays / 5));
  const targetPlot = state.plots.find(p => !p.feature && !state.buildings.some(b => b.plotId === p.id));
  addInventory(state, "town", "wood", 500, "r03建设材料", "test", CONTENT);
  const started = simulation.buildAt(state, "bakery", targetPlot.id);
  assert.equal(started.ok, true, started.reason);
  assert.equal(started.assignedBuilders, 5);
  assert.equal(jobCount(state, "builders"), 5);

  const noIdle = legacyVoucherState({ seed: 120309 });
  setJobCount(noIdle, "farmers", 0, CONTENT);
  const full = addBuilding(noIdle, "mill", "r03-labor-full", 146);
  full.ownership = { townLevels: 0, privateLevels: 0, listedLevels: 146 };
  setJobCount(noIdle, `${full.id}::millers::listed`, 1750, CONTENT);
  assert.equal(simulation.selectJobRows(noIdle).idle, 0);
  const zeroPreview = simulation.selectDashboard(noIdle).constructionOptions.find(row => row.id === "bakery");
  assert.equal(zeroPreview.waitingForWorkers, true);
  assert.equal(zeroPreview.constructionCrewDays, null);
  assert.equal(zeroPreview.estimatedWageJin, 0);
  const zeroPlot = noIdle.plots.find(p => !p.feature && !noIdle.buildings.some(b => b.plotId === p.id));
  addInventory(noIdle, "town", "wood", 500, "r03建设材料", "test", CONTENT);
  const zeroStart = simulation.buildAt(noIdle, "bakery", zeroPlot.id);
  assert.equal(zeroStart.ok, true, zeroStart.reason);
  assert.equal(zeroStart.assignedBuilders, 0);
  assert.equal(jobCount(noIdle, "builders"), 0);

  const existingBuilders = legacyVoucherState({ seed: 120311 });
  setJobCount(existingBuilders, "farmers", 0, CONTENT);
  setJobCount(existingBuilders, "builders", 10, CONTENT);
  const almostFull = addBuilding(existingBuilders, "mill", "r03-labor-existing-builders", 146);
  almostFull.ownership = { townLevels: 0, privateLevels: 0, listedLevels: 146 };
  // 1740 磨坊 + 10 营造 = 1750，恰好零待业。
  setJobCount(existingBuilders, `${almostFull.id}::millers::listed`, 1740, CONTENT);
  assert.equal(simulation.selectJobRows(existingBuilders).idle, 0);
  const retainedPreview = simulation.selectDashboard(existingBuilders).constructionOptions.find(row => row.id === "bakery");
  assert.equal(retainedPreview.previewBuilders, 10, "已有建筑工即使没有待业者也应计入施工口径");
  const retainedPlot = existingBuilders.plots.find(p => !p.feature && !existingBuilders.buildings.some(b => b.plotId === p.id));
  addInventory(existingBuilders, "town", "wood", 500, "r03建设材料", "test", CONTENT);
  const retainedStart = simulation.buildAt(existingBuilders, "bakery", retainedPlot.id);
  assert.equal(retainedStart.ok, true, retainedStart.reason);
  assert.equal(retainedStart.assignedBuilders, 10);
  assert.equal(jobCount(existingBuilders, "builders"), 10, "开工不得意外撤回已有建筑工");

  const upgradeState = legacyVoucherState({ seed: 120310 });
  setJobCount(upgradeState, "farmers", 0, CONTENT);
  // 同上：劳动力 1750，需 146 级磨坊（1752 岗位）才能构造零待业。
  const fullUpgradeLabor = addBuilding(upgradeState, "mill", "r03-upgrade-labor-full", 146);
  fullUpgradeLabor.ownership = { townLevels: 0, privateLevels: 0, listedLevels: 146 };
  setJobCount(upgradeState, `${fullUpgradeLabor.id}::millers::listed`, 1750, CONTENT);
  const housing = addBuilding(upgradeState, "public_housing", "r03-upgrade-target");
  addInventory(upgradeState, "town", "wood", 2000, "r03升级材料", "test", CONTENT);
  assert.equal(simulation.selectJobRows(upgradeState).idle, 0);
  const upgradePreview = simulation.selectUpgradePreview(upgradeState, housing.id);
  assert.equal(upgradePreview.available, true);
  assert.equal(upgradePreview.waitingForWorkers, true);
  assert.equal(upgradePreview.availableBuilders, 0);
  assert.equal(upgradePreview.estimatedDays, null);
  assert.equal(upgradePreview.estimatedWageJin, 0);
  const upgradeStart = simulation.upgradeBuilding(upgradeState, housing.id);
  assert.equal(upgradeStart.ok, true, upgradeStart.reason);
  assert.equal(upgradeStart.assignedBuilders, 0);
  assert.equal(jobCount(upgradeState, "builders"), 0);
});
