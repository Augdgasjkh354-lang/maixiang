// 整栋所有制（docs/OWNERSHIP.md）：一栋产业建筑只有一个主人（镇里 / 一户 / 一家公司）。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { DAILY_STEPS } from "../src/systems/daily.js";
import { householdList, isActiveHousehold, jobCount, setJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { jobKeyForBuilding, privateJobKeyForBuilding } from "../src/selectors/labor.js";
import { buildingOwner, transferBuildingOwnership } from "../src/systems/ownership.js";
import { settleOwnershipTakeovers } from "../src/systems/ownership-takeover.js";
import { settleOwnerUpgrades } from "../src/systems/building-development.js";
import { arrangePrivateWorkers, processPrivateBuilding, processPrivateIndustries } from "../src/systems/private-industry.js";
import { wholesalePurchasePrice } from "../src/systems/wholesale-market.js";
import { spendableVoucherUnits, paymentWheatBalanceUnits } from "../src/economy/payment.js";
import { voucherBalance } from "../src/economy/currency.js";
import { refreshOperatingPlan } from "../src/economy/operating-plan.js";
import { grantResidentVouchers, richestHousehold } from "./helpers-v16.js";
import { legacyVoucherState, setHouseholdVoucherUnits } from "./helpers-monetary.js";
import { formCompany } from "./helpers-ipo.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function freePlot(state, feature = null) {
  return state.plots.find(row => (feature ? row.feature === feature : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
}

// 新建一栋建筑（不经施工），主人按参数设定；民营需要指定业主家庭。
function addBuilding(state, typeId, id, { level = 1, owner = "town", ownerId = null } = {}) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = freePlot(state, required);
  assert.ok(plot, `缺少地块 ${typeId}`);
  const ownership = { townLevels: 0, privateLevels: 0, listedLevels: 0 };
  ownership[owner === "household" ? "privateLevels" : owner === "company" ? "listedLevels" : "townLevels"] = level;
  const building = { id, typeId, level, ownership, plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 } };
  if (owner === "household") building.privateOwners = [ownerId];
  state.buildings.push(building);
  return building;
}

function household(state, id) {
  return state.households.byId[id];
}

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

test("整栋一个主人：卖出、收回、回购与升级后 validateState 恒成立", () => {
  const state = simulation.createInitialState({ seed: 7101 });
  addBuilding(state, "wholesale_market", "wm-inv");
  const salt = addBuilding(state, "saltworks", "salt-inv", { level: 2 });
  assertValid(state, "初始");
  assert.equal(simulation.setEmployment(state, `${salt.id}::salt_workers`, 10).assigned, 10);
  assert.equal(grantResidentVouchers(state, 100000, CONTENT, richestHousehold(state).id).ok, true);
  assert.equal(simulation.issueGrainVouchers(state, "town", 3000000).ok, true, "镇库需有粮券付回购款");
  const quote = simulation.selectOperatingRightPreview(state, salt.id);
  simulation.setOperatingRightPrice(state, salt.id, Math.min(quote.maximumPriceWheatJin / 2, quote.maxHouseholdPayVoucher / 2));
  const sold = simulation.sellBuildingToPrivate(state, salt.id);
  assert.equal(sold.ok, true, sold.reason);
  assertValid(state, "卖出后");
  const bought = simulation.buyBuildingBackFromPrivate(state, salt.id);
  assert.equal(bought.ok, true, bought.reason);
  assertValid(state, "回购后");
  assert.equal(buildingOwner(state, salt).kind, "town");
});

test("整栋出售：买家是付得起整栋价的家底最多的一户，钱付给镇库", () => {
  const state = simulation.createInitialState({ seed: 7102 });
  addBuilding(state, "wholesale_market", "wm-richest");
  const salt = addBuilding(state, "saltworks", "salt-richest", { level: 2 });
  const [poor, rich] = householdList(state).filter(isActiveHousehold).slice(0, 2);
  setHouseholdVoucherUnits(state, poor, 0);
  setHouseholdVoucherUnits(state, rich, 0);
  assert.equal(grantResidentVouchers(state, 500, CONTENT, poor.id).ok, true);
  assert.equal(grantResidentVouchers(state, 80000, CONTENT, rich.id).ok, true);
  const townBefore = state.currency.balances.town;
  // 要价 1 券：两户都付得起，买家应是家底最多的那一户。
  const sale = simulation.sellBuildingToPrivate(state, salt.id, { priceVoucher: 1 });
  assert.equal(sale.ok, true, sale.reason);
  assert.equal(sale.preview.buyer.householdId, rich.id, "家底最多的一户买下整栋");
  assert.deepEqual(salt.privateOwners, [rich.id]);
  assert.equal(salt.ownership.privateLevels, 2);
  assert.equal(state.currency.balances.town - townBefore, 1 * V, "买价进了镇库");
  assert.equal(sale.priceVoucherUnits, 1 * V);
  assertValid(state, "整栋出售");
});

test("换主人时在岗人数整体搬到新主人的岗位键，并通知经营计划重算", () => {
  const state = simulation.createInitialState({ seed: 7103 });
  addBuilding(state, "wholesale_market", "wm-move");
  const mill = addBuilding(state, "mill", "mill-move", { level: 1 });
  assert.equal(simulation.setEmployment(state, `${mill.id}::millers`, 6).assigned, 6);
  state.market.operatingPlan ||= {};
  state.market.operatingPlan.updatedSerial = 5;
  const owner = richestHousehold(state);
  const moved = transferBuildingOwnership(state, mill, { kind: "household", id: owner.id }, CONTENT);
  assert.equal(moved.movedWorkers, 6);
  assert.equal(jobCount(state, jobKeyForBuilding(mill.id, "millers")), 0);
  assert.equal(jobCount(state, privateJobKeyForBuilding(mill.id, "millers")), 6);
  assert.equal(state.market.operatingPlan.updatedSerial, -1);
  assert.equal(mill.privateOwners[0], owner.id);
  assertValid(state, "换主人后");
});

test("民营欠薪连续超过30天：整栋收回镇营；存货先抵欠薪，余额镇库垫付，业主不补偿", () => {
  const state = simulation.createInitialState({ seed: 7104 });
  addBuilding(state, "wholesale_market", "wm-take");
  const owner = householdList(state).filter(isActiveHousehold)[0];
  const mill = addBuilding(state, "mill", "mill-take", { owner: "household", ownerId: owner.id, level: 1 });
  setHouseholdVoucherUnits(state, owner, 0);
  owner.inventory.flour = 50 * I;
  syncResidentAggregates(state, CONTENT);
  const flourPrice = wholesalePurchasePrice(state, "flour", CONTENT);
  // 欠薪 40 券：存货 50 斤面粉按收购价约 80 券，抵掉 40 券需 25 斤。
  const arrears = 40 * V;
  state.privateEconomy.payrollByBuilding[mill.id] = {
    arrearsVoucherUnits: arrears, cumulativeAccruedVoucherUnits: arrears, cumulativePaidVoucherUnits: 0,
    claimsVoucherUnits: { [owner.id]: arrears }, claimsPayment: {}
  };
  const townWheatBefore = state.accounts.town.wheat;
  const ownerVoucherBefore = owner.voucherUnits;
  for (let day = 1; day <= 30; day += 1) assert.deepEqual(settleOwnershipTakeovers(state, CONTENT), [], `第${day}天不收回`);
  const rows = settleOwnershipTakeovers(state, CONTENT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "private");
  assert.equal(buildingOwner(state, mill).kind, "town");
  assert.equal(mill.privateOwners, undefined);
  assert.equal(owner.inventory.flour, 25 * I, "只抵掉欠薪所需的存货");
  assert.ok(rows[0].inKindValueUnits >= arrears - 1 && rows[0].inKindValueUnits <= arrears + 1, `in-kind ${rows[0].inKindValueUnits}`);
  assert.equal(state.privateEconomy.payrollByBuilding[mill.id], undefined);
  assert.equal(owner.voucherUnits, ownerVoucherBefore, "业主拿不到补偿");
  assert.equal(state.accounts.town.wheat, townWheatBefore);
  assert.ok(flourPrice > 0);
  assertValid(state, "收回后");
});

test("存货不够抵欠薪时余额由镇库偿付给工人，记事件", () => {
  const state = simulation.createInitialState({ seed: 7105 });
  addBuilding(state, "wholesale_market", "wm-advance");
  const owner = householdList(state).filter(isActiveHousehold)[1];
  const mill = addBuilding(state, "mill", "mill-advance", { owner: "household", ownerId: owner.id, level: 1 });
  setHouseholdVoucherUnits(state, owner, 0);
  owner.inventory.flour = 0;
  syncResidentAggregates(state, CONTENT);
  const arrears = 30 * V;
  const workerHouse = householdList(state).filter(isActiveHousehold)[2];
  state.privateEconomy.payrollByBuilding[mill.id] = {
    arrearsVoucherUnits: arrears, cumulativeAccruedVoucherUnits: arrears, cumulativePaidVoucherUnits: 0,
    claimsVoucherUnits: { [workerHouse.id]: arrears }, claimsPayment: {}
  };
  const holderValue = () => voucherBalance(state, `household:${workerHouse.id}`) + paymentWheatBalanceUnits(state, `household:${workerHouse.id}`);
  const workerBefore = holderValue();
  const townTotal = () => voucherBalance(state, "town") + state.accounts.town.wheat;
  const townBefore = townTotal();
  for (let day = 0; day < 31; day += 1) settleOwnershipTakeovers(state, CONTENT);
  assert.equal(buildingOwner(state, mill).kind, "town");
  assert.ok(townTotal() < townBefore, "镇库垫付余额");
  assert.ok(holderValue() > workerBefore, "工人家庭拿到工资");
  assertValid(state, "垫付后");
});

test("公司欠薪连续超过30天：清算，现金与存货先还欠薪，余额镇库垫付，股份作废，建筑回镇营", () => {
  const state = simulation.createInitialState({ seed: 7106 });
  addBuilding(state, "wholesale_market", "wm-co");
  const mill = addBuilding(state, "mill", "mill-co", { level: 2 });
  const created = formCompany(state, mill.id, { name: "欠薪磨坊", operatingCapitalVoucher: 0, initialMaterialQuantity: 0 });
  assert.equal(created.ok, true, created.reason);
  const company = state.companies[created.companyId];
  // 人为造成：公司有欠薪，现金为 0，持有少量面粉；家庭持有股份、基金持股。
  const holder = householdList(state).filter(isActiveHousehold)[3];
  const arrears = 20 * V;
  company.payroll.arrearsVoucherUnits = arrears;
  company.payroll.claimsVoucherUnits = { [holder.id]: arrears };
  company.payroll.claimsPayment = {};
  company.inventory.flour = 10 * I;
  company.inventoryCostVoucherUnits.flour = 0;
  company.listing = { listed: true, ticker: "123", listedAt: null };
  company.totalShares = 1000;
  company.townShares = 300;
  company.residentShares = 500;
  company.fundShares = 200;
  company.householdShares = { [holder.id]: 500 };
  company.shareSale = { ...company.shareSale, offeredShares: 0 };
  holder.shares = { [company.id]: 500 };
  for (let day = 0; day < 30; day += 1) settleOwnershipTakeovers(state, CONTENT);
  assert.ok(state.companies[company.id], "第30天仍未清算");
  const rows = settleOwnershipTakeovers(state, CONTENT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "company");
  assert.equal(state.companies[company.id], undefined, "公司已删除");
  assert.equal(buildingOwner(state, mill).kind, "town");
  assert.equal(holder.shares?.[company.id], undefined, "居民股份作废");
  assert.equal(rows[0].cancelledResidentShares, 500);
  assert.equal(rows[0].cancelledFundShares, 200);
  assert.ok(rows[0].inKindValueUnits > 0, "存货先抵欠薪");
  assert.ok(rows[0].transferredClaimsUnits >= 0);
  assertValid(state, "公司清算后");
});

test("民营业主自主升级：盈利、在岗、现金达标 → 一次性付给镇库，工程照常施工，新等级归业主", () => {
  const state = simulation.createInitialState({ seed: 7107 });
  addBuilding(state, "wholesale_market", "wm-upgrade");
  const owner = richestHousehold(state);
  const lumber = addBuilding(state, "lumberyard", "lumber-upgrade", { owner: "household", ownerId: owner.id, level: 1 });
  const job = CONTENT.buildings.lumberyard.jobs[0];
  // 在岗达到岗位上限的 90%（20 人岗位的 90% 为 18 人）。
  setJobCount(state, privateJobKeyForBuilding(lumber.id, job.id), job.slots, CONTENT);
  lumber.privateProfitHistory = [{ serial: 0, profitVoucherUnits: 500, workers: job.slots }];
  assert.equal(grantResidentVouchers(state, 50000, CONTENT, owner.id).ok, true);
  state.day = 0;
  state.year = 1;
  const townBefore = state.currency.balances.town;
  state.accounts.town.wood = 1000 * I;
  const rows = settleOwnerUpgrades(state, CONTENT);
  const row = rows.find(item => item.buildingId === lumber.id);
  assert.ok(row, "业主检查了这栋建筑");
  assert.equal(row.status, "started", row.reason);
  assert.ok(state.currency.balances.town > townBefore || state.accounts.town.wheat > 0, "升级花费一次性付给镇库");
  const project = state.projects.find(item => item.buildingId === lumber.id);
  assert.ok(project?.prepaid, "工程标记为业主预付");
  // 工程由镇里施工：推进到完工。
  for (let day = 0; day < 400 && state.buildings.find(item => item.id === lumber.id).level === 1; day += 1) simulation.advanceDay(state);
  const built = state.buildings.find(item => item.id === lumber.id);
  assert.equal(built.level, 2, "工程完工");
  assert.equal(built.ownership.privateLevels, 2, "新等级归原业主");
  assert.equal(built.ownership.townLevels, 0);
  assert.deepEqual(built.privateOwners, [owner.id]);
  assertValid(state, "升级完工");
});

test("业主自主升级的条件不满足时不动钱：在岗不足、利润不为正、现金不够", () => {
  const state = simulation.createInitialState({ seed: 7108 });
  addBuilding(state, "wholesale_market", "wm-noupgrade");
  const owner = richestHousehold(state);
  const lumber = addBuilding(state, "lumberyard", "lumber-noupgrade", { owner: "household", ownerId: owner.id, level: 1 });
  state.day = 0;
  state.year = 1;
  lumber.privateProfitHistory = [{ serial: 0, profitVoucherUnits: 500, workers: 1 }];
  assert.equal(grantResidentVouchers(state, 50000, CONTENT, owner.id).ok, true);
  const understaffed = settleOwnerUpgrades(state, CONTENT).find(row => row.buildingId === lumber.id);
  assert.equal(understaffed.status, "skipped");
  assert.match(understaffed.reason, /在岗/);
  setJobCount(state, privateJobKeyForBuilding(lumber.id, CONTENT.buildings.lumberyard.jobs[0].id), CONTENT.buildings.lumberyard.jobs[0].slots, CONTENT);
  lumber.privateProfitHistory = [{ serial: 0, profitVoucherUnits: -5, workers: 20 }];
  const unprofitable = settleOwnerUpgrades(state, CONTENT).find(row => row.buildingId === lumber.id);
  assert.match(unprofitable.reason, /利润/);
  lumber.privateProfitHistory = [{ serial: 0, profitVoucherUnits: 500, workers: 20 }];
  setHouseholdVoucherUnits(state, owner, 0);
  const townBeforePoor = state.currency.balances.town;
  const poor = settleOwnerUpgrades(state, CONTENT).find(row => row.buildingId === lumber.id);
  assert.equal(poor.status, "skipped");
  assert.equal(state.currency.balances.town, townBeforePoor, "没有成交就不收钱");
  assertValid(state, "未升级");
});

test("估值按批发收购价减实物生产税计，售价变化不影响经营权估值", () => {
  const state = simulation.createInitialState({ seed: 7109 });
  addBuilding(state, "wholesale_market", "wm-value");
  const salt = addBuilding(state, "saltworks", "salt-value", { level: 1 });
  const base = simulation.selectOperatingRightPreview(state, salt.id);
  assert.ok(base.outputPriceVoucherPerUnit > 0);
  assert.equal(base.outputPriceVoucherPerUnit, state.wholesaleMarket.purchasePricesVoucherPerUnit.salt, "产出按收购价");
  assert.equal(simulation.configureWholesalePrice(state, "salt", 50).ok, true, "抬高售价");
  const repriced = simulation.selectOperatingRightPreview(state, salt.id);
  assert.equal(repriced.outputPriceVoucherPerUnit, base.outputPriceVoucherPerUnit, "售价变化不影响估值");
  assert.equal(repriced.referencePriceWheatJin, base.referencePriceWheatJin);
  assert.equal(simulation.configureWholesalePurchasePrice(state, "salt", 4).ok, true, "压低收购价");
  const lowered = simulation.selectOperatingRightPreview(state, salt.id);
  assert.ok(lowered.referencePriceWheatJin < base.referencePriceWheatJin, "收购价下降，估值下降");
  assert.ok(lowered.dailyNetWheatJin < base.dailyNetWheatJin, "日净利随收购价下降");
});

test("没有批发市场建筑时没有收购口径，经营权估值为 0", () => {
  const state = simulation.createInitialState({ seed: 7110 });
  const salt = addBuilding(state, "saltworks", "salt-nomarket", { level: 1 });
  const preview = simulation.selectOperatingRightPreview(state, salt.id);
  assert.equal(preview.outputPriceVoucherPerUnit, 0);
  assert.equal(preview.maximumPriceWheatJin, 0);
});

test("民营磨坊产出当日按收购价入批发市场，同日民营面包房可买到", () => {
  const state = simulation.createInitialState({ seed: 7111 });
  addBuilding(state, "wholesale_market", "wm-chain");
  const owner = householdList(state).filter(isActiveHousehold)[0];
  const mill = addBuilding(state, "mill", "mill-chain", { owner: "household", ownerId: owner.id, level: 1 });
  const bakery = addBuilding(state, "bakery", "bakery-chain", { owner: "household", ownerId: owner.id, level: 1 });
  setJobCount(state, privateJobKeyForBuilding(mill.id, "millers"), 2, CONTENT);
  setJobCount(state, privateJobKeyForBuilding(bakery.id, "bakers"), 2, CONTENT);
  state.wholesaleMarket.inventory.flour = 0;
  state.wholesaleMarket.inventoryCostVoucherUnits.flour = 0;
  state.wholesaleMarket.dailyTownAllocationUnits = {};
  state.policy.unemploymentBenefit.enabled = false;
  const rows = processPrivateIndustries(state, CONTENT);
  const millRow = rows.find(row => row.buildingId === mill.id);
  const bakeryRow = rows.find(row => row.buildingId === bakery.id);
  assert.ok(millRow.intake.flour > 0, "磨坊的面粉当场入市");
  assert.ok(bakeryRow.batches > 0, "同日面包房用上了磨坊面粉");
  assert.ok(bakeryRow.inputPurchases.some(row => row.itemId === "flour" && row.purchasedUnits > 0));
});

test("民营招工受业主可用资金限制：日工资总额不超过可用资金的 1/7", () => {
  const state = simulation.createInitialState({ seed: 7112 });
  addBuilding(state, "wholesale_market", "wm-hire");
  const owner = householdList(state).filter(isActiveHousehold)[0];
  const mill = addBuilding(state, "mill", "mill-hire", { owner: "household", ownerId: owner.id, level: 1 });
  setHouseholdVoucherUnits(state, owner, 0);
  owner.inventory.wheat = 0;
  syncResidentAggregates(state, CONTENT);
  refreshOperatingPlan(state, CONTENT);
  arrangePrivateWorkers(state, CONTENT);
  assert.equal(jobCount(state, privateJobKeyForBuilding(mill.id, "millers")), 0, "没有资金不招工");
  assert.equal(grantResidentVouchers(state, 70, CONTENT, owner.id).ok, true);
  refreshOperatingPlan(state, CONTENT);
  arrangePrivateWorkers(state, CONTENT);
  const hired = jobCount(state, privateJobKeyForBuilding(mill.id, "millers"));
  const rate = state.employment.wageRates?.millers ?? CONTENT.buildings.mill.jobs[0].wagePerWorkerDay;
  const money = spendableVoucherUnits(state, `household:${owner.id}`);
  assert.ok(hired > 0, "有资金就招工");
  assert.ok(hired * rate * V * 7 <= money, `日工资总额 ${hired * rate * V} 不得超过资金的 1/7（资金 ${money}）`);
  assert.ok(hired < CONTENT.buildings.mill.jobs[0].slots, "资金不足以招满岗位");
});

test("欠薪只作为旁路标记，不覆盖真实生产状态", () => {
  const state = simulation.createInitialState({ seed: 7113 });
  addBuilding(state, "wholesale_market", "wm-status");
  const owner = householdList(state).filter(isActiveHousehold)[0];
  const mill = addBuilding(state, "mill", "mill-status", { owner: "household", ownerId: owner.id, level: 1 });
  setJobCount(state, privateJobKeyForBuilding(mill.id, "millers"), 3, CONTENT);
  state.privateEconomy.payrollByBuilding[mill.id] = {
    arrearsVoucherUnits: 9 * V, cumulativeAccruedVoucherUnits: 9 * V, cumulativePaidVoucherUnits: 0,
    claimsVoucherUnits: { [owner.id]: 9 * V }, claimsPayment: {}
  };
  owner.inventory.wheat = 0;
  setHouseholdVoucherUnits(state, owner, 0);
  const row = processPrivateBuilding(state, mill, CONTENT);
  assert.equal(row.arrears, true, "欠薪以旁路标记给出");
  assert.notEqual(row.status, "wage_arrears", "欠薪不再覆盖生产状态");
  assert.equal(row.status, "no_materials", "真实状态：没有原料");
});

test("镇营面包房的面粉需求计入民营磨坊的经营权估值", () => {
  const state = simulation.createInitialState({ seed: 7114 });
  addBuilding(state, "wholesale_market", "wm-demand");
  const mill = addBuilding(state, "mill", "mill-demand", { level: 1 });
  const before = simulation.selectOperatingRightPreview(state, mill.id).demandUnits;
  const bakery = addBuilding(state, "bakery", "bakery-town-demand", { level: 1 });
  setJobCount(state, jobKeyForBuilding(bakery.id, "bakers"), 5, CONTENT);
  const after = simulation.selectOperatingRightPreview(state, mill.id).demandUnits;
  assert.ok(after > before, `镇营面包房需求应计入：${before} → ${after}`);
});

test("整栋上市：建筑整栋划入新公司并挂牌；按级增减的预览与操作不可用", () => {
  const state = legacyVoucherState({ seed: 7115 });
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  addBuilding(state, "wholesale_market", "wm-company");
  const mill = addBuilding(state, "mill", "mill-whole-company", { level: 3 });
  const listed = simulation.listBuilding(state, mill.id, { name: "整栋磨坊", operatingCapitalVoucher: 0, initialMaterialQuantity: 0 });
  assert.equal(listed.ok, true, listed.reason);
  assert.deepEqual([mill.ownership.townLevels, mill.ownership.privateLevels, mill.ownership.listedLevels], [0, 0, 3]);
  assert.equal(state.companies[listed.companyId].listedLevels, 3);
  assert.equal(state.companies[listed.companyId].listing.listed, true);
  const preview = simulation.previewCompanyLevelChange(state, listed.companyId, "add");
  assert.equal(preview.available, false);
  assert.match(preview.reason, /整栋归公司/);
  assert.equal(simulation.addCompanyOperatingLevel(state, listed.companyId).ok, false);
  assert.equal(simulation.removeCompanyOperatingLevel(state, listed.companyId).ok, false);
  assertValid(state, "整栋上市");
});

test("回购：镇库按整栋估值付给业主，建筑与岗位回到镇营", () => {
  const state = simulation.createInitialState({ seed: 7116 });
  addBuilding(state, "wholesale_market", "wm-buyback");
  const owner = richestHousehold(state);
  const salt = addBuilding(state, "saltworks", "salt-buyback", { owner: "household", ownerId: owner.id, level: 1 });
  setJobCount(state, privateJobKeyForBuilding(salt.id, "salt_workers"), 4, CONTENT);
  const valuation = simulation.selectOperatingRightPreview(state, salt.id).valuationWheatJin;
  assert.ok(valuation > 0);
  const ownerValue = () => voucherBalance(state, `household:${owner.id}`) + paymentWheatBalanceUnits(state, `household:${owner.id}`);
  const ownerBefore = ownerValue();
  const result = simulation.buyBuildingBackFromPrivate(state, salt.id);
  assert.equal(result.ok, true, result.reason);
  assert.equal(buildingOwner(state, salt).kind, "town");
  assert.equal(jobCount(state, jobKeyForBuilding(salt.id, "salt_workers")), 4);
  assert.ok(ownerValue() > ownerBefore, "镇库付给业主估值");
  assertValid(state, "回购后");
});

test("日结流水线：欠薪收回排在民营工资之后，业主升级排在收回之后", () => {
  const ids = DAILY_STEPS.map(step => step.id);
  const wagesIndex = ids.indexOf("privateWages");
  assert.ok(wagesIndex >= 0);
  assert.equal(ids[wagesIndex + 1], "ownershipTakeover");
  assert.equal(ids[wagesIndex + 2], "ownerUpgrades");
  assert.equal(ids.includes("wholesalePrivateIntake"), false, "民营产出入市已改为逐栋即时入市");
});

test("整栋出售、回购与旧命令名共存：旧 sellOperatingLevel 作为整栋出售的别名", () => {
  const state = simulation.createInitialState({ seed: 7117 });
  assert.equal(typeof simulation.sellBuildingToPrivate, "function");
  assert.equal(typeof simulation.buyBuildingBackFromPrivate, "function");
  assert.equal(typeof simulation.sellOperatingLevel, "function");
  addBuilding(state, "wholesale_market", "wm-alias");
  const salt = addBuilding(state, "saltworks", "salt-alias", { level: 1 });
  const result = simulation.sellOperatingLevel(state, salt.id);
  assert.equal(result.ok, false, "没有买家与要价时不成交，但不再按级拆分");
  assert.equal(salt.ownership.townLevels, 1);
});

test("validateState 拒绝混合主人、民营无业主、公司无对应公司的建筑", () => {
  const state = simulation.createInitialState({ seed: 7118 });
  addBuilding(state, "wholesale_market", "wm-invariant");
  const salt = addBuilding(state, "saltworks", "salt-invariant", { level: 2 });
  assertValid(state, "整栋镇营");
  salt.ownership = { townLevels: 1, privateLevels: 1, listedLevels: 0 };
  assert.match(simulation.validateState(state).errors.join("；"), /须只有一个主人/);
  salt.ownership = { townLevels: 0, privateLevels: 2, listedLevels: 0 };
  salt.privateOwners = [];
  assert.match(simulation.validateState(state).errors.join("；"), /恰好一户业主/);
  salt.privateOwners = ["household-missing"];
  assert.match(simulation.validateState(state).errors.join("；"), /恰好一户业主/);
  salt.ownership = { townLevels: 0, privateLevels: 0, listedLevels: 2 };
  delete salt.privateOwners;
  assert.match(simulation.validateState(state).errors.join("；"), /公司建筑须有对应公司/);
});
