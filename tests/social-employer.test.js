// 雇主缴社保（docs/REDISTRIBUTION.md 第 3 节）：雇主替员工承担 employerSharePercent%，其余由员工家庭自付。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { currencyScale, issueTownVouchers, voucherBalance } from "../src/economy/currency.js";
import { householdList, householdIdleWorkers, isActiveHousehold, setHouseholdJobCount, syncResidentAggregates } from "../src/systems/households.js";
import {
  collectSocialContributions, selectSocialSecurityStats, setEmployerSocialSharePercent, socialEmployerForJobKey
} from "../src/systems/social-security.js";
import { buildingOwner } from "../src/systems/ownership.js";
import { formCompany } from "./helpers-ipo.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { currentPaymentComposition, maximumPayableValueUnits, settleMonetaryPayment } from "../src/economy/payment.js";
import { grantResidentVouchers } from "./helpers-v16.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;
const P = currencyScale(CONTENT); // 每人每天 1 斤折算的价值单位（dailyPerWorkerJin = 1）

function freePlot(state, feature = null) {
  return state.plots.find(row => (feature ? row.feature === feature : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
}

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

// 开启社保（需社保局）；清空全镇已有岗位，避免农民等自雇人员干扰金额断言。
function fixture(seed, { townVouchers = 1000 } = {}) {
  const state = legacyVoucherState({ seed });
  addBuilding(state, "social_security_office", "ss-office");
  assert.equal(simulation.setSocialSecurityPolicy(state, { enabled: true, dailyPerWorkerJin: 1 }).ok, true);
  for (const household of householdList(state)) {
    for (const key of Object.keys(household.jobs || {})) setHouseholdJobCount(state, household.id, key, 0, null);
  }
  if (townVouchers > 0) issueTownVouchers(state, townVouchers * V, CONTENT, "社保测试：镇库备付");
  syncResidentAggregates(state, CONTENT);
  return state;
}

function pickHousehold(state, minIdle = 2, exclude = []) {
  const found = householdList(state).find(h => isActiveHousehold(h) && householdIdleWorkers(h) >= minIdle && !exclude.includes(h.id));
  assert.ok(found, "需要一户有足够待业劳动力的家庭");
  return found;
}

// 把某账户的现金（粮券、可付小麦）经正式支付转给镇库，让它付不起。
function drainCash(state, owner) {
  const amount = maximumPayableValueUnits(state, owner, CONTENT);
  if (amount > 0) settleMonetaryPayment(state, owner, "town", currentPaymentComposition(state, amount), CONTENT, "test_drain", "测试：清空账户", { requireFull: false });
}

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

function openShopFixture(state) {
  addBuilding(state, "wholesale_market", "wm-social");
  addBuilding(state, "commercial_street", "street-social", { level: 2 });
  const owner = pickHousehold(state, 1);
  assert.equal(grantResidentVouchers(state, 20000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, "street-social", "general", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  return { owner, shop };
}

test("默认 100%：员工家庭不付，雇主（镇库）付全额", () => {
  const state = fixture(9101);
  addBuilding(state, "mill", "mill-town");
  const worker = pickHousehold(state);
  assert.equal(setHouseholdJobCount(state, worker.id, "mill-town::millers", 2, CONTENT).ok, true);
  const townBefore = voucherBalance(state, "town");
  const householdBefore = state.households.byId[worker.id].voucherUnits;
  const fundBefore = state.socialSecurity.cashVoucherUnits;

  const result = collectSocialContributions(state, CONTENT);

  const last = state.socialSecurity.lastContribution;
  assert.equal(last.workers, 2);
  assert.equal(last.dueValueUnits, 2 * P);
  assert.equal(last.employerDueValueUnits, 2 * P);
  assert.equal(last.employerCollectedValueUnits, 2 * P);
  assert.equal(last.householdDueValueUnits, 0);
  assert.equal(last.householdCollectedValueUnits, 0);
  assert.equal(last.employerArrearsValueUnits, 0);
  assert.equal(state.households.byId[worker.id].voucherUnits, householdBefore, "员工家庭不付");
  assert.equal(voucherBalance(state, "town"), townBefore - 2 * P, "镇库付全额");
  assert.equal(state.socialSecurity.cashVoucherUnits, fundBefore + 2 * P, "基金收到全额");
  assert.equal(result.collectedValueUnits, 2 * P);
  assertValid(state, "默认100%");
});

test("0%：与旧规则一致，员工家庭全额自付", () => {
  const state = fixture(9102);
  addBuilding(state, "mill", "mill-town");
  const worker = pickHousehold(state);
  setHouseholdJobCount(state, worker.id, "mill-town::millers", 2, CONTENT);
  assert.equal(setEmployerSocialSharePercent(state, 0).ok, true);
  assert.equal(grantResidentVouchers(state, 50, CONTENT, worker.id).ok, true);
  const townBefore = voucherBalance(state, "town");
  const householdBefore = state.households.byId[worker.id].voucherUnits;

  collectSocialContributions(state, CONTENT);

  const last = state.socialSecurity.lastContribution;
  assert.equal(last.employerDueValueUnits, 0);
  assert.equal(last.householdDueValueUnits, 2 * P);
  assert.equal(last.householdCollectedValueUnits, 2 * P);
  assert.equal(state.households.byId[worker.id].voucherUnits, householdBefore - 2 * P);
  assert.equal(voucherBalance(state, "town"), townBefore, "镇库不付");
  assertValid(state, "0%");
});

test("50%：雇主与员工家庭各付一半", () => {
  const state = fixture(9103);
  addBuilding(state, "mill", "mill-town");
  const worker = pickHousehold(state);
  setHouseholdJobCount(state, worker.id, "mill-town::millers", 2, CONTENT);
  assert.equal(setEmployerSocialSharePercent(state, 50).ok, true);
  assert.equal(grantResidentVouchers(state, 50, CONTENT, worker.id).ok, true);
  const townBefore = voucherBalance(state, "town");
  const householdBefore = state.households.byId[worker.id].voucherUnits;

  collectSocialContributions(state, CONTENT);

  const last = state.socialSecurity.lastContribution;
  assert.equal(last.dueValueUnits, 2 * P);
  assert.equal(last.employerDueValueUnits, P);
  assert.equal(last.householdDueValueUnits, P);
  assert.equal(last.employerCollectedValueUnits, P);
  assert.equal(last.householdCollectedValueUnits, P);
  assert.equal(voucherBalance(state, "town"), townBefore - P);
  assert.equal(state.households.byId[worker.id].voucherUnits, householdBefore - P);
  assertValid(state, "50%");
});

test("雇主认定：镇营、民营、公司、店铺店员、店主自雇、务农", () => {
  const state = fixture(9104);
  addBuilding(state, "mill", "mill-town");
  const owner = pickHousehold(state, 1);
  addBuilding(state, "mill", "mill-priv", { owner: "household", ownerId: owner.id });
  addBuilding(state, "mill", "mill-co");
  const company = formCompany(state, "mill-co", { name: "测试磨坊公司", operatingCapitalVoucher: 0, initialMaterialQuantity: 0 });
  const companyRow = company?.id ? company : Object.values(state.companies).find(row => row.buildingId === "mill-co");
  assert.ok(companyRow, "应已建公司");
  const { owner: shopOwner, shop } = openShopFixture(state);
  const other = householdList(state).find(h => isActiveHousehold(h) && h.id !== owner.id && h.id !== shopOwner.id);

  const town = socialEmployerForJobKey(state, other.id, "mill-town::millers");
  assert.deepEqual(town, { employer: "town", kind: "town", self: false });

  const priv = socialEmployerForJobKey(state, other.id, "mill-priv::millers::private");
  assert.deepEqual(priv, { employer: `household:${owner.id}`, kind: "private", self: false });
  assert.equal(socialEmployerForJobKey(state, other.id, "mill-priv::millers").employer, `household:${owner.id}`, "私营建筑的整栋岗位键也归业主");
  assert.equal(socialEmployerForJobKey(state, owner.id, "mill-priv::millers::private").self, true, "业主在自家民营建筑干活自付");

  const co = socialEmployerForJobKey(state, other.id, "mill-co::millers::listed");
  assert.deepEqual(co, { employer: `company:${companyRow.id}`, kind: "company", self: false });
  assert.equal(socialEmployerForJobKey(state, other.id, "mill-co::millers").employer, `company:${companyRow.id}`);

  const clerk = socialEmployerForJobKey(state, other.id, `shop:${shop.id}:clerk`);
  assert.deepEqual(clerk, { employer: `shop:${shop.id}`, kind: "shop", self: false });
  assert.equal(socialEmployerForJobKey(state, shopOwner.id, `shop:${shop.id}:merchant`).self, true, "店主本人当商人自雇");

  assert.deepEqual(socialEmployerForJobKey(state, other.id, "farmers"), { employer: null, kind: "self", self: true }, "务农自雇");
  assert.equal(socialEmployerForJobKey(state, other.id, "no-such-building::millers").self, true, "认不出的键自雇");
  assert.equal(socialEmployerForJobKey(state, other.id, "mill-co::millers::weird").self, true, "未知后缀自雇");
});

test("雇主付不起：记为欠缴，之后有钱时优先补缴，不影响欠薪", () => {
  const state = fixture(9105, { townVouchers: 0 });
  addBuilding(state, "mill", "mill-town");
  const worker = pickHousehold(state);
  setHouseholdJobCount(state, worker.id, "mill-town::millers", 2, CONTENT);
  const payrollBefore = JSON.stringify(state.payroll ?? null);
  const watchBefore = JSON.stringify(state.ownershipWatch ?? null);

  collectSocialContributions(state, CONTENT);
  let last = state.socialSecurity.lastContribution;
  assert.equal(state.socialSecurity.employerArrears.town, 2 * P, "镇库付不起，全额记欠缴");
  assert.equal(last.employerCollectedValueUnits, 0);
  assert.equal(last.employerArrearsValueUnits, 2 * P);
  assert.equal(JSON.stringify(state.payroll ?? null), payrollBefore, "欠缴不计入欠薪");
  assert.equal(JSON.stringify(state.ownershipWatch ?? null), watchBefore, "欠缴不触发收回");

  issueTownVouchers(state, P, CONTENT, "测试：镇库有少量钱");
  collectSocialContributions(state, CONTENT);
  last = state.socialSecurity.lastContribution;
  assert.equal(state.socialSecurity.employerArrears.town, 3 * P, "先补掉 1 份欠缴，再加今日 2 份");
  assert.equal(last.employerArrearsPaidValueUnits, P);
  assert.equal(last.employerCollectedValueUnits, P);

  issueTownVouchers(state, 10 * P, CONTENT, "测试：镇库有钱");
  collectSocialContributions(state, CONTENT);
  last = state.socialSecurity.lastContribution;
  assert.equal(state.socialSecurity.employerArrears.town, undefined, "欠缴还清后删除记录");
  assert.equal(last.employerArrearsPaidValueUnits, 3 * P);
  assert.equal(last.employerArrearsValueUnits, 0);
  assertValid(state, "欠缴补缴");
});

test("私营业主付不起：欠缴记在业主名下，不收回建筑、不计欠薪", () => {
  const state = fixture(9106);
  const owner = pickHousehold(state, 1);
  addBuilding(state, "mill", "mill-priv", { owner: "household", ownerId: owner.id });
  const worker = pickHousehold(state, 2, [owner.id]);
  setHouseholdJobCount(state, worker.id, "mill-priv::millers::private", 2, CONTENT);
  drainCash(state, `household:${owner.id}`);
  const building = state.buildings.find(row => row.id === "mill-priv");
  const payrollBefore = JSON.stringify(state.payroll ?? null);
  const watchBefore = JSON.stringify(state.ownershipWatch ?? null);

  collectSocialContributions(state, CONTENT);

  assert.equal(state.socialSecurity.employerArrears[`household:${owner.id}`], 2 * P);
  assert.deepEqual(buildingOwner(state, building), { kind: "household", id: owner.id }, "建筑不收回");
  assert.equal(JSON.stringify(state.payroll ?? null), payrollBefore);
  assert.equal(JSON.stringify(state.ownershipWatch ?? null), watchBefore);
  assertValid(state, "私营欠缴");
});

test("私营业主在自家民营建筑干活：自付全额，不记欠缴", () => {
  const state = fixture(9107);
  const owner = pickHousehold(state, 2);
  addBuilding(state, "mill", "mill-self", { owner: "household", ownerId: owner.id });
  setHouseholdJobCount(state, owner.id, "mill-self::millers::private", 2, CONTENT);
  assert.equal(grantResidentVouchers(state, 50, CONTENT, owner.id).ok, true);
  const before = state.households.byId[owner.id].voucherUnits;

  collectSocialContributions(state, CONTENT);

  const last = state.socialSecurity.lastContribution;
  assert.equal(last.employerDueValueUnits, 0);
  assert.equal(last.householdDueValueUnits, 2 * P);
  assert.equal(state.households.byId[owner.id].voucherUnits, before - 2 * P);
  assert.equal(state.socialSecurity.employerArrears[`household:${owner.id}`], undefined);
  assertValid(state, "私营自雇");
});

test("店铺：店员的雇主部分记给店铺；店铺关门后欠缴删除，店主自己当商人照常自付", () => {
  const state = fixture(9108);
  const { owner, shop } = openShopFixture(state);
  const clerkHome = pickHousehold(state, 2, [owner.id]);
  const clerkKey = `shop:${shop.id}:clerk`;
  const merchantKey = `shop:${shop.id}:merchant`;
  setHouseholdJobCount(state, clerkHome.id, clerkKey, 2, CONTENT);
  setHouseholdJobCount(state, owner.id, merchantKey, 1, CONTENT);
  drainCash(state, `shop:${shop.id}`);
  drainCash(state, `household:${owner.id}`);
  const ownerBefore = state.households.byId[owner.id].voucherUnits;

  collectSocialContributions(state, CONTENT);

  let last = state.socialSecurity.lastContribution;
  assert.equal(last.workers, 3);
  assert.equal(last.employerDueValueUnits, 2 * P, "店员 2 人的雇主部分归店铺");
  assert.equal(last.householdDueValueUnits, P, "店主自雇 1 人自付");
  assert.equal(state.socialSecurity.employerArrears[`shop:${shop.id}`], 2 * P, "店铺没钱，欠缴记在店铺名下");
  assert.equal(state.households.byId[owner.id].voucherUnits, ownerBefore, "店主自雇付不起则当天免缴（家庭段不记欠缴）");

  setHouseholdJobCount(state, clerkHome.id, clerkKey, 0, CONTENT);
  setHouseholdJobCount(state, owner.id, merchantKey, 0, CONTENT);
  state.shops[shop.id].status = "closed";
  collectSocialContributions(state, CONTENT);
  assert.equal(state.socialSecurity.employerArrears[`shop:${shop.id}`], undefined, "店铺不在营业，欠缴清理掉");
  assertValid(state, "店铺");
});

test("已不存在的雇主（家庭消失、公司清算、店铺删除）的欠缴直接删除", () => {
  const state = fixture(9109);
  state.socialSecurity.employerArrears = {
    "household:household-999999": 5,
    "company:company-999": 7,
    "shop:shop-999": 9,
    "bogus:x": 3
  };
  collectSocialContributions(state, CONTENT);
  assert.deepEqual(state.socialSecurity.employerArrears, {});
  assertValid(state, "清理");
});

test("比例校验：0–100，整数或一位小数；需社保局", () => {
  const bare = legacyVoucherState({ seed: 9110 });
  assert.equal(setEmployerSocialSharePercent(bare, 50).ok, false, "未建社保局不能调整");

  const state = fixture(9111);
  for (const good of [0, 100, 33.3, 12.5, 40]) {
    const result = setEmployerSocialSharePercent(state, good);
    assert.equal(result.ok, true, String(good));
  }
  assert.equal(state.socialSecurity.employerSharePercent, 40);
  for (const bad of [-1, 100.5, 101, 33.33, "", "abc", NaN, Infinity, null, undefined]) {
    assert.equal(setEmployerSocialSharePercent(state, bad).ok, false, String(bad));
  }
  assert.equal(state.socialSecurity.employerSharePercent, 40, "失败不改值");
  assertValid(state, "比例");
});

test("selectSocialSecurityStats：雇主比例、今日拆分、欠缴分类与前 5 名欠款人，且只读", () => {
  const state = fixture(9112, { townVouchers: 0 });
  addBuilding(state, "mill", "mill-town");
  const worker = pickHousehold(state);
  setHouseholdJobCount(state, worker.id, "mill-town::millers", 2, CONTENT);
  collectSocialContributions(state, CONTENT);
  state.socialSecurity.employerArrears = {
    ...state.socialSecurity.employerArrears,
    "shop:s-a": 9 * P, "shop:s-b": 1 * P, "company:c-a": 5 * P, "household:h-a": 4 * P, "household:h-b": 3 * P, "household:h-c": 2 * P
  };
  const before = JSON.stringify(state);

  const stats = selectSocialSecurityStats(state, CONTENT);

  assert.equal(JSON.stringify(state), before, "selector 不写 state");
  assert.equal(stats.employerSharePercent, 100);
  assert.equal(stats.lastContribution.employerDueJin, 2);
  assert.equal(stats.lastContribution.householdDueJin, 0);
  assert.equal(stats.lastContribution.employerCollectedJin, 0);
  assert.equal(stats.employerArrearsByKindJin.town, 2);
  assert.equal(stats.employerArrearsByKindJin.shop, 10);
  assert.equal(stats.employerArrearsByKindJin.company, 5);
  assert.equal(stats.employerArrearsByKindJin.private, 9);
  assert.equal(stats.employerArrearsJin, 2 + 10 + 5 + 9);
  assert.equal(stats.topEmployerDebtors.length, 5);
  assert.deepEqual(stats.topEmployerDebtors.map(row => row.owner),
    ["shop:s-a", "company:c-a", "household:h-a", "household:h-b", "household:h-c"]);
  const amounts = stats.topEmployerDebtors.map(row => row.arrearsJin);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a), "按欠缴额从大到小");
  assert.equal(stats.topEmployerDebtors[0].kind, "shop");
  assert.equal(stats.topEmployerDebtors[1].kind, "company");
});

test("旧档缺新字段时照常运行，比例回落到 100%", () => {
  const state = fixture(9113);
  delete state.socialSecurity.employerSharePercent;
  delete state.socialSecurity.employerArrears;
  collectSocialContributions(state, CONTENT);
  const stats = selectSocialSecurityStats(state, CONTENT);
  assert.equal(stats.employerSharePercent, 100);
  assert.deepEqual(stats.topEmployerDebtors, []);
  assertValid(state, "旧档");
});
