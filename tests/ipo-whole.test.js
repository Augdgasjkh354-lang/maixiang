// 上市（整栋）与民营业主上市申请（docs/OWNERSHIP.md 第 2 条）。
// 一步完成：建筑的现主人（镇里或一户）把整栋放进新公司并挂牌；发行池股款付给卖方；申请、批准、驳回与冷却。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { DAILY_STEPS } from "../src/systems/daily.js";
import { householdList, isActiveHousehold, jobCount } from "../src/systems/households.js";
import { buildingOwner, transferBuildingOwnership } from "../src/systems/ownership.js";
import { settleIpoApplications } from "../src/systems/ipo.js";
import { settleHouseholdStockBuying } from "../src/systems/stock-exchange.js";
import { voucherBalance } from "../src/economy/currency.js";
import { jobKeyForBuilding, listedJobKeyForBuilding } from "../src/selectors/labor.js";
import { grantResidentVouchers, richestHousehold } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { formCompany } from "./helpers-ipo.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function freePlot(state, feature = null) {
  return state.plots.find(row => (feature ? row.feature === feature : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
}

// 新建一栋建筑（不经施工）。owner = "town" | "household"（household 需 ownerId）。
function addBuilding(state, typeId, id, { level = 1, owner = "town", ownerId = null } = {}) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = freePlot(state, required);
  assert.ok(plot, `缺少地块 ${typeId}`);
  const ownership = { townLevels: 0, privateLevels: 0, listedLevels: 0 };
  ownership[owner === "household" ? "privateLevels" : "townLevels"] = level;
  const building = { id, typeId, level, ownership, plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 } };
  if (owner === "household") building.privateOwners = [ownerId];
  state.buildings.push(building);
  return building;
}

// 交易所已建成、货币改革已完成（粮券阶段）。
function exchangeState(seed) {
  const state = legacyVoucherState({ seed });
  state.stockExchange = { legacyAccess: true, rotation: 0 };
  return state;
}

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

// 只让某一户有当日股票买入预算，其余户清零。
function onlyBudget(state, householdId, voucherUnits) {
  for (const household of householdList(state)) household.stockBuyBudgetVoucherUnits = 0;
  state.households.byId[householdId].stockBuyBudgetVoucherUnits = voucherUnits;
}

// 日结检查日：year=1 时 serial = day。
function atSerial(state, serial) {
  state.year = 1;
  state.day = serial;
}

// 民营建筑的近期利润（privateProfitHistory 由民营生产逐日写入；这里造当天一条记录）。
function setRecentProfit(state, building, serial, profitVoucherUnits = 500) {
  building.privateProfitHistory = [{ serial, profitVoucherUnits, workers: 1 }];
}

function outputItemOf(typeId) {
  return CONTENT.recipes[CONTENT.buildings[typeId].recipeId].outputs[0].itemId;
}

function brokeHousehold(state, index = 0) {
  const household = householdList(state).filter(isActiveHousehold)[index];
  household.voucherUnits = 0;
  household.inventory.wheat = 0;
  return household;
}

test("镇营建筑整栋上市：公司整栋持有；镇库名下全部股份，挂出 49% 为发行池，卖方是镇库", () => {
  const state = exchangeState(7201);
  const salt = addBuilding(state, "saltworks", "ipo-town-salt", { level: 2 });
  const result = simulation.listBuilding(state, salt.id, { ticker: "101", priceVoucherPerShare: 2 });
  assert.equal(result.ok, true, result.reason);
  const company = state.companies[result.companyId];
  assert.equal(buildingOwner(state, salt).kind, "company");
  assert.deepEqual([salt.ownership.townLevels, salt.ownership.privateLevels, salt.ownership.listedLevels], [0, 0, 2]);
  assert.equal(salt.privateOwners, undefined);
  assert.equal(company.listing.listed, true);
  assert.equal(company.listing.ticker, "101");
  assert.equal(company.totalShares, 100000, "默认总股本 10 万股");
  assert.equal(company.shareSale.offeredShares, 49000, "默认卖出 49%");
  assert.equal(company.shareSale.sellerOwner, "town");
  assert.equal(company.townShares, 100000, "挂牌时全部股份记在镇库名下，挂出部分售出后镇库保留 51%");
  assert.equal(company.residentShares, 0);
  assert.equal(company.shareSale.sharePriceVoucherUnits, 2 * V);
  assert.equal(result.keptShares, 51000);
  assert.equal(result.sellerOwner, "town");
  assertValid(state, "镇营整栋上市");
});

test("镇营上市后发行池售出：股款付给镇库，售完镇库保留 51%，居民持有 49%", () => {
  const state = exchangeState(7202);
  const salt = addBuilding(state, "saltworks", "ipo-town-pool", { level: 2 });
  const result = simulation.listBuilding(state, salt.id, { ticker: "102", priceVoucherPerShare: 2 });
  assert.equal(result.ok, true, result.reason);
  const company = state.companies[result.companyId];
  const buyer = householdList(state).filter(isActiveHousehold)[0];
  assert.equal(grantResidentVouchers(state, 300000, CONTENT, buyer.id).ok, true);
  onlyBudget(state, buyer.id, 49000 * 2 * V);
  const townBefore = state.currency.balances.town;
  const trade = settleHouseholdStockBuying(state, CONTENT);
  assert.equal(trade.shares, 49000, "发行池 49000 股全部售出");
  assert.equal(state.currency.balances.town - townBefore, 49000 * 2 * V, "股款付给镇库（卖方）");
  assert.equal(company.townShares, 51000, "镇库保留 51%");
  assert.equal(company.residentShares, 49000);
  assert.equal(company.shareSale.offeredShares, 0);
  assert.equal(buyer.shares[company.id], 49000);
  assert.equal(company.townShares + company.residentShares + (company.fundShares || 0), company.totalShares, "总股本守恒");
  assertValid(state, "镇营发行池售出后");
});

test("镇营整栋上市：镇库可投入营运资金；岗位人数整体搬到公司岗位键", () => {
  const state = exchangeState(7203);
  assert.equal(simulation.issueGrainVouchers(state, "town", 50000).ok, true, "镇库需有粮券投入营运资金");
  const salt = addBuilding(state, "saltworks", "ipo-capital-salt", { level: 1 });
  assert.equal(simulation.setEmployment(state, `${salt.id}::salt_workers`, 5).assigned, 5);
  const townCashBefore = voucherBalance(state, "town");
  const result = simulation.listBuilding(state, salt.id, { ticker: "103", operatingCapitalVoucher: 5000, initialMaterialQuantity: 0 });
  assert.equal(result.ok, true, result.reason);
  const company = state.companies[result.companyId];
  assert.equal(company.initialInvestment.cashVoucherUnits, 5000 * V);
  assert.equal(townCashBefore - voucherBalance(state, "town"), 5000 * V, "镇库付出营运资金");
  assert.equal(jobCount(state, jobKeyForBuilding(salt.id, "salt_workers")), 0, "镇营岗位键清空");
  assert.equal(jobCount(state, listedJobKeyForBuilding(salt.id, "salt_workers")), 5, "在岗人数随建筑进入公司岗位键");
  assertValid(state, "镇营整栋上市营运资金与岗位");
});

test("民营建筑经镇长批准上市：业主家庭保留 51%，卖方是业主，存货随建筑入公司，二级市场股款付给业主", () => {
  const state = exchangeState(7204);
  const owner = householdList(state).filter(isActiveHousehold)[0];
  const salt = addBuilding(state, "saltworks", "ipo-hh-salt", { level: 1, owner: "household", ownerId: owner.id });
  const itemId = outputItemOf("saltworks");
  owner.inventory[itemId] = 30 * I;
  assert.match(simulation.listBuilding(state, salt.id, { ticker: "204" }).reason, /业主递交上市申请/, "镇长不能直接拿民营建筑上市");
  state.ipoApplications = { [salt.id]: { householdId: owner.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 2 } };
  const result = simulation.approveIpoApplication(state, salt.id, { ticker: "204" });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.fromApplication, true);
  assert.equal(state.ipoApplications[salt.id], undefined, "批准后申请移除");
  const company = state.companies[result.companyId];
  assert.equal(buildingOwner(state, salt).kind, "company");
  assert.equal(company.householdShares[owner.id], 100000, "业主名下全部股份，挂出的 49% 售出后保留 51%");
  assert.equal(company.townShares, 0);
  assert.equal(company.residentShares, 100000, "业主家庭持股计入居民持股");
  assert.equal(owner.shares[company.id], 100000);
  assert.equal(company.shareSale.sellerOwner, owner.id);
  assert.equal(company.shareSale.offeredShares, 49000);
  assert.equal(company.inventory[itemId], 30 * I, "业主存货随建筑入公司");
  assert.equal(owner.inventory[itemId], 0);
  assert.ok(company.inventoryCostVoucherUnits[itemId] > 0, "存货按收购价计成本");
  assertValid(state, "民营上市后");

  const buyer = householdList(state).filter(row => isActiveHousehold(row) && row.id !== owner.id)[0];
  assert.equal(grantResidentVouchers(state, 300000, CONTENT, buyer.id).ok, true);
  onlyBudget(state, buyer.id, 49000 * 2 * V);
  const ownerBefore = voucherBalance(state, `household:${owner.id}`);
  const trade = settleHouseholdStockBuying(state, CONTENT);
  assert.equal(trade.shares, 49000);
  assert.equal(voucherBalance(state, `household:${owner.id}`) - ownerBefore, 49000 * 2 * V, "股款付给业主家庭");
  assert.equal(company.householdShares[owner.id], 51000, "业主保留 51%");
  assert.equal(owner.shares[company.id], 51000);
  assert.equal(company.residentShares, 100000, "居民之间转手，居民总持股不变");
  assert.equal(company.shareSale.offeredShares, 0);
  assertValid(state, "民营发行池售出后");
});

test("民营上市后认购（发行池认购）：股款付给业主家庭，业主减持，镇库不参与", () => {
  const state = exchangeState(7219);
  const owner = householdList(state).filter(isActiveHousehold)[0];
  const salt = addBuilding(state, "saltworks", "ipo-sub-salt", { level: 1, owner: "household", ownerId: owner.id });
  state.ipoApplications = { [salt.id]: { householdId: owner.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 2 } };
  const result = simulation.approveIpoApplication(state, salt.id, { ticker: "219" });
  assert.equal(result.ok, true, result.reason);
  const company = state.companies[result.companyId];
  assert.equal(grantResidentVouchers(state, 100000, CONTENT).ok, true);
  const preview = simulation.previewShareSubscription(state, company.id);
  assert.equal(preview.sellerOwner, owner.id);
  const ownerBefore = voucherBalance(state, `household:${owner.id}`);
  const townBefore = state.currency.balances.town;
  const sub = simulation.subscribeShares(state, company.id);
  assert.equal(sub.ok, true, sub.reason);
  assert.ok(sub.subscribedShares > 0);
  assert.equal(state.currency.balances.town, townBefore, "镇库不收股款");
  assert.equal(voucherBalance(state, `household:${owner.id}`) - ownerBefore, sub.proceedsVoucherUnits, "股款付给业主家庭");
  assert.equal(company.householdShares[owner.id], 100000 - sub.subscribedShares, "业主减持");
  assert.equal(company.shareSale.offeredShares, 49000 - sub.subscribedShares);
  assert.equal(company.residentShares, 100000, "居民之间转手，居民总持股不变");
  assertValid(state, "民营认购后");
});

test("镇长批准时可改卖出比例与每股价，覆盖申请里的默认值", () => {
  const state = exchangeState(7205);
  const owner = richestHousehold(state);
  const salt = addBuilding(state, "saltworks", "ipo-override-salt", { owner: "household", ownerId: owner.id });
  state.ipoApplications = { [salt.id]: { householdId: owner.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 2 } };
  const result = simulation.approveIpoApplication(state, salt.id, { offerPercent: 30, priceVoucherPerShare: 3, ticker: "205" });
  assert.equal(result.ok, true, result.reason);
  const company = state.companies[result.companyId];
  assert.equal(company.shareSale.offeredShares, 30000);
  assert.equal(company.shareSale.sharePriceVoucherUnits, 3 * V);
  assertValid(state, "批准覆盖");
});

test("没有待批申请时不能批准或驳回", () => {
  const state = exchangeState(7206);
  const salt = addBuilding(state, "saltworks", "ipo-none-salt");
  assert.equal(simulation.approveIpoApplication(state, salt.id, {}).ok, false);
  assert.equal(simulation.rejectIpoApplication(state, salt.id).ok, false);
});

test("上市前置条件：无交易所、未完成货币改革、代码与整除规则、同一建筑只能一家公司", () => {
  const plain = legacyVoucherState({ seed: 7207 });
  plain.stockExchange = { legacyAccess: false, rotation: 0 };
  const salt = addBuilding(plain, "mill", "ipo-gate-salt", { level: 3 });
  assert.match(simulation.listBuilding(plain, salt.id, {}).reason, /交易所/);
  plain.stockExchange = { legacyAccess: true, rotation: 0 };
  plain.monetaryReform.stage = "transition";
  assert.match(simulation.listBuilding(plain, salt.id, {}).reason, /货币改革/);
  plain.monetaryReform.stage = "voucher";
  const bad = simulation.listBuilding(plain, salt.id, { ticker: "12" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /三位数字/);
  // 3 级建筑：1000 股不能被 3 整除，应给出最近的可整除股本。
  const notDivisible = simulation.listBuilding(plain, salt.id, { ticker: "301", totalShares: 1000, priceVoucherPerShare: 1 });
  assert.equal(notDivisible.ok, false);
  assert.match(notDivisible.reason, /整除/);
  assert.ok(notDivisible.nearby.every(value => value % 3 === 0));
  const first = simulation.listBuilding(plain, salt.id, { priceVoucherPerShare: 1 });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.totalShares % 3, 0, "默认总股本取最接近且能被级数整除的值");
  assert.equal(first.ticker, "001", "未给代码时取第一个空闲代码");
  assert.match(simulation.listBuilding(plain, salt.id, { ticker: "002" }).reason, /已有公司/, "同一建筑只能有一家公司");
  const other = addBuilding(plain, "mill", "ipo-gate-salt-2", { level: 1 });
  assert.equal(simulation.listBuilding(plain, other.id, { ticker: "001", priceVoucherPerShare: 1 }).reason, "股票代码已被使用");
  const second = simulation.listBuilding(plain, other.id, { priceVoucherPerShare: 1 });
  assert.equal(second.ticker, "002", "自动代码跳过已占用的 001");
  assertValid(plain, "上市前置条件");
});

test("已取消单独成立公司：createCompany / listCompany 只返回原因，建筑不变", () => {
  const state = exchangeState(7208);
  const salt = addBuilding(state, "saltworks", "ipo-no-found-salt");
  assert.match(simulation.createCompany(state, salt.id, {}).reason, /已取消单独成立公司：请直接整栋上市/);
  assert.match(simulation.listCompany(state, salt.id, {}).reason, /已取消单独成立公司：请直接整栋上市/);
  assert.equal(salt.ownership.townLevels, 1);
  assert.deepEqual(state.companies, {});
});

test("老公司（整栋已在公司名下、尚未上市）仍可挂牌；未给出售股数时按 49%", () => {
  const state = exchangeState(7209);
  const salt = addBuilding(state, "saltworks", "ipo-legacy-salt", { level: 1 });
  const formed = formCompany(state, salt.id, { name: "旧公司", operatingCapitalVoucher: 0, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  assert.equal(state.companies[formed.companyId].listing.listed, false);
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker: "401", totalShares: 1000, priceVoucherPerShare: 1 });
  assert.equal(listed.ok, true, listed.reason);
  const company = state.companies[formed.companyId];
  assert.equal(company.shareSale.offeredShares, 490, "未给出售股数时按 49%");
  assert.equal(company.shareSale.sellerOwner, "town");
  assert.equal(company.townShares, 1000);
  assert.equal(simulation.listCompanyShares(state, formed.companyId, { ticker: "402" }).ok, false, "已上市不可重复挂牌");
  assertValid(state, "老公司挂牌");
});

test("发行池股数不得超过卖方持股：挂出超量时 validateState 拦截", () => {
  const state = exchangeState(7210);
  const owner = richestHousehold(state);
  const salt = addBuilding(state, "saltworks", "ipo-overoffer-salt", { owner: "household", ownerId: owner.id });
  state.ipoApplications = { [salt.id]: { householdId: owner.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 1 } };
  const result = simulation.approveIpoApplication(state, salt.id, { ticker: "501" });
  assert.equal(result.ok, true, result.reason);
  const company = state.companies[result.companyId];
  assert.equal(simulation.configureShareOffer(state, company.id, 100001, 1).ok, false, "出售股数不能超过卖方持股");
  company.shareSale.offeredShares = 100001;
  const check = simulation.validateState(state);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(error => /股份出售记录无效/.test(error)));
  company.shareSale.offeredShares = 49000;
  assertValid(state, "修正后");
});

test("民营业主经营好但现金不够升级：检查日自动递交申请；非检查日、无利润、现金够、交易所未建、镇营都不递交", () => {
  const state = exchangeState(7211);
  const owner = brokeHousehold(state);
  const mill = addBuilding(state, "mill", "ipo-file-mill", { level: 1, owner: "household", ownerId: owner.id });
  atSerial(state, 29);
  setRecentProfit(state, mill, 29);
  settleIpoApplications(state, CONTENT);
  assert.equal(state.ipoApplications[mill.id], undefined, "非检查日不递交");
  atSerial(state, 30);
  setRecentProfit(state, mill, 30);
  const rows = settleIpoApplications(state, CONTENT);
  assert.ok(rows.some(row => row.status === "filed" && row.buildingId === mill.id));
  const application = state.ipoApplications[mill.id];
  assert.equal(application.householdId, owner.id);
  assert.equal(application.offerPercent, 49);
  assert.ok(application.priceVoucherPerShare >= 0.001);
  assert.equal(application.filedSerial, 30);
  assert.ok(state.events.some(event => /递交上市申请/.test(event.text)), "递交申请有事件");
  atSerial(state, 60);
  setRecentProfit(state, mill, 60);
  settleIpoApplications(state, CONTENT);
  assert.equal(state.ipoApplications[mill.id].filedSerial, 30, "已有待批不重复递交");
  assertValid(state, "递交申请后");
});

test("不递交的情形：无利润、现金够升级、交易所未建、镇营建筑", () => {
  const noProfit = exchangeState(7212);
  const poorOwner = brokeHousehold(noProfit);
  const loss = addBuilding(noProfit, "mill", "ipo-noprofit-mill", { owner: "household", ownerId: poorOwner.id });
  atSerial(noProfit, 30);
  setRecentProfit(noProfit, loss, 30, -5);
  settleIpoApplications(noProfit, CONTENT);
  assert.equal(noProfit.ipoApplications[loss.id], undefined, "利润不为正不递交");

  const rich = exchangeState(7213);
  const richOwner = householdList(rich).filter(isActiveHousehold)[0];
  assert.equal(grantResidentVouchers(rich, 1000000, CONTENT, richOwner.id).ok, true);
  const richMill = addBuilding(rich, "mill", "ipo-rich-mill", { owner: "household", ownerId: richOwner.id });
  atSerial(rich, 30);
  setRecentProfit(rich, richMill, 30);
  settleIpoApplications(rich, CONTENT);
  assert.equal(rich.ipoApplications[richMill.id], undefined, "现金够升级不递交");

  const noExchange = legacyVoucherState({ seed: 7214 });
  const poor = brokeHousehold(noExchange);
  const nxMill = addBuilding(noExchange, "mill", "ipo-noex-mill", { owner: "household", ownerId: poor.id });
  atSerial(noExchange, 30);
  setRecentProfit(noExchange, nxMill, 30);
  settleIpoApplications(noExchange, CONTENT);
  assert.equal(noExchange.ipoApplications[nxMill.id], undefined, "没有交易所不递交");

  const townMill = addBuilding(noExchange, "mill", "ipo-town-mill");
  noExchange.stockExchange = { legacyAccess: true, rotation: 0 };
  setRecentProfit(noExchange, townMill, 30);
  settleIpoApplications(noExchange, CONTENT);
  assert.equal(noExchange.ipoApplications[townMill.id], undefined, "镇营建筑不递交申请");
  assertValid(noExchange, "不递交情形");
});

test("驳回后同一业主 180 天内不再申请，满 180 天可再次递交", () => {
  const state = exchangeState(7215);
  const owner = brokeHousehold(state);
  const mill = addBuilding(state, "mill", "ipo-reject-mill", { owner: "household", ownerId: owner.id });
  atSerial(state, 60);
  setRecentProfit(state, mill, 60);
  settleIpoApplications(state, CONTENT);
  assert.ok(state.ipoApplications[mill.id], "先递交一份申请");
  const rejected = simulation.rejectIpoApplication(state, mill.id);
  assert.equal(rejected.ok, true, rejected.reason);
  assert.equal(state.ipoApplications[mill.id], undefined);
  assert.equal(state.ipoCooldowns[mill.id].householdId, owner.id);
  assert.equal(state.ipoCooldowns[mill.id].untilSerial, 60 + CONTENT.rules.ipoReapplyCooldownDays);
  assert.equal(CONTENT.rules.ipoReapplyCooldownDays, 180);
  for (const serial of [90, 120, 150, 180, 210]) {
    atSerial(state, serial);
    setRecentProfit(state, mill, serial);
    settleIpoApplications(state, CONTENT);
    assert.equal(state.ipoApplications[mill.id], undefined, `第 ${serial} 天仍在冷却期`);
  }
  assertValid(state, "冷却期内");
  atSerial(state, 240);
  setRecentProfit(state, mill, 240);
  settleIpoApplications(state, CONTENT);
  assert.ok(state.ipoApplications[mill.id], "满 180 天后可再次递交");
  assert.equal(state.ipoCooldowns[mill.id], undefined, "过期冷却清除");
  assertValid(state, "冷却期满");
});

test("业主变更后申请作废：日结清理；批准时也会拒绝并作废", () => {
  const state = exchangeState(7216);
  const [first, second] = householdList(state).filter(isActiveHousehold);
  const mill = addBuilding(state, "mill", "ipo-change-mill", { owner: "household", ownerId: first.id });
  state.ipoApplications = { [mill.id]: { householdId: first.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 1 } };
  transferBuildingOwnership(state, mill, { kind: "household", id: second.id }, CONTENT);
  atSerial(state, 3);
  settleIpoApplications(state, CONTENT);
  assert.equal(state.ipoApplications[mill.id], undefined, "业主已变更，申请清理");
  assertValid(state, "业主变更后");
  state.ipoApplications = { [mill.id]: { householdId: first.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 1 } };
  const approved = simulation.approveIpoApplication(state, mill.id, {});
  assert.equal(approved.ok, false);
  assert.match(approved.reason, /业主已变更/);
  assert.equal(state.ipoApplications[mill.id], undefined);
});

test("日结流水线：ipoApplications 排在 ownerUpgrades 之后", () => {
  const ids = DAILY_STEPS.map(step => step.id);
  assert.equal(ids[ids.indexOf("ownerUpgrades") + 1], "ipoApplications");
});

test("上市视图：镇营可直接上市，建议价与上市结果一致；民营未申请说明原因，申请后可批准", () => {
  const state = exchangeState(7217);
  const salt = addBuilding(state, "saltworks", "ipo-view-salt", { level: 1 });
  const owner = householdList(state).filter(isActiveHousehold)[1];
  const hhSalt = addBuilding(state, "mill", "ipo-view-hh", { owner: "household", ownerId: owner.id });
  const view = simulation.selectIpoView(state);
  assert.equal(view.exchangeBuilt, true);
  assert.equal(view.gateReason, null);
  const townRow = view.buildings.find(row => row.buildingId === salt.id);
  assert.equal(townRow.canList, true);
  assert.equal(townRow.route, "mayor");
  const hhRow = view.buildings.find(row => row.buildingId === hhSalt.id);
  assert.equal(hhRow.canList, false);
  assert.match(hhRow.reason, /尚未递交上市申请/);
  state.ipoApplications = { [hhSalt.id]: { householdId: owner.id, filedSerial: 1, offerPercent: 49, priceVoucherPerShare: 4 } };
  const withApplication = simulation.selectIpoView(state);
  assert.equal(withApplication.applications.length, 1);
  assert.equal(withApplication.applications[0].suggestedPriceVoucherPerShare, 4);
  assert.equal(withApplication.buildings.find(row => row.buildingId === hhSalt.id).canList, true);
  assertValid(state, "视图只读");
  const listed = simulation.listBuilding(state, salt.id, { ticker: "601" });
  assert.equal(listed.ok, true, listed.reason);
  assert.equal(state.companies[listed.companyId].shareSale.sharePriceVoucherUnits, Math.round(townRow.suggestedPriceVoucherPerShare * V), "不填价格时用视图的建议价");
  assertValid(state, "上市后");
  const afterRow = simulation.selectIpoView(state).buildings.find(row => row.buildingId === salt.id);
  assert.equal(afterRow.canList, false);
  assert.equal(afterRow.listed, true);
  assert.equal(simulation.selectDashboard(state, { panel: "all" }).ipo.buildings.length, simulation.selectIpoView(state).buildings.length);
});

test("validateState：公司 offeredShares 超过卖方持股时报错，修正后通过", () => {
  const state = exchangeState(7218);
  const salt = addBuilding(state, "saltworks", "ipo-valid-salt", { level: 1 });
  const result = simulation.listBuilding(state, salt.id, { ticker: "701", priceVoucherPerShare: 1 });
  assert.equal(result.ok, true, result.reason);
  assertValid(state, "上市后");
  const company = state.companies[result.companyId];
  company.shareSale.sellerOwner = "no-such-household";
  assert.equal(simulation.validateState(state).valid, false);
  company.shareSale.sellerOwner = "town";
  assertValid(state, "卖方恢复");
});
