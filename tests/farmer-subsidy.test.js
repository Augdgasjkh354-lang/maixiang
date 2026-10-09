// 社保基金农民补贴：仿养老金（payPensions），按在岗务农人数（household.jobs.farmers）发到家庭。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { currencyScale, issueTownVouchers, voucherBalance } from "../src/economy/currency.js";
import { householdList, householdIdleWorkers, isActiveHousehold, setHouseholdJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { payFarmerSubsidies, selectSocialSecurityStats } from "../src/systems/social-security.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;
const P = currencyScale(CONTENT); // 每斤对应的价值单位

function addBuilding(state, typeId, id) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `缺少地块 ${typeId}`);
  state.buildings.push({ id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 } });
}

// 开启社保（需社保局），清空全镇岗位（避免其他自雇人员干扰），镇库备付粮券。
function fixture(seed, { enabled = true } = {}) {
  const state = legacyVoucherState({ seed });
  addBuilding(state, "social_security_office", "ss-office");
  assert.equal(simulation.setSocialSecurityPolicy(state, { enabled, dailyPerWorkerJin: 0 }).ok, true);
  for (const household of householdList(state)) {
    for (const key of Object.keys(household.jobs || {})) setHouseholdJobCount(state, household.id, key, 0, null);
  }
  issueTownVouchers(state, 1000 * V, CONTENT, "农民补贴测试：镇库备付");
  syncResidentAggregates(state, CONTENT);
  return state;
}

function pickHousehold(state, minIdle, exclude = []) {
  const found = householdList(state).find(h => isActiveHousehold(h) && householdIdleWorkers(h) >= minIdle && !exclude.includes(h.id));
  assert.ok(found, "需要一户有足够待业劳动力的家庭");
  return found;
}

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

// 两户务农：A 户 3 人、B 户 2 人。
function withFarmers(state) {
  const a = pickHousehold(state, 3);
  assert.equal(setHouseholdJobCount(state, a.id, "farmers", 3, null).ok, true);
  const b = pickHousehold(state, 2, [a.id]);
  assert.equal(setHouseholdJobCount(state, b.id, "farmers", 2, null).ok, true);
  return { a, b };
}

test("默认标准为 0：即使基金开启也不发农民补贴", () => {
  const state = fixture(9201);
  const { a } = withFarmers(state);
  assert.equal(state.socialSecurity.farmerSubsidyPerFarmerJin, 0);
  const before = voucherBalance(state, `household:${a.id}`);
  const result = payFarmerSubsidies(state, CONTENT);
  assert.equal(result.paidValueUnits, 0);
  assert.equal(voucherBalance(state, `household:${a.id}`), before);
  assertValid(state, "默认 0");
});

test("设标准后：农民户收到 农民数 × 标准，非务农户不收", () => {
  const state = fixture(9202);
  const { a, b } = withFarmers(state);
  const idle = pickHousehold(state, 1, [a.id, b.id]);
  assert.equal(simulation.setSocialSecurityPolicy(state, { farmerSubsidyPerFarmerJin: 1.5 }).ok, true);
  const aBefore = voucherBalance(state, `household:${a.id}`);
  const bBefore = voucherBalance(state, `household:${b.id}`);
  const idleBefore = voucherBalance(state, `household:${idle.id}`);
  const result = payFarmerSubsidies(state, CONTENT);
  const perFarmer = Math.round(1.5 * P);
  assert.equal(voucherBalance(state, `household:${a.id}`) - aBefore, 3 * perFarmer, "A 户 3 位农民");
  assert.equal(voucherBalance(state, `household:${b.id}`) - bBefore, 2 * perFarmer, "B 户 2 位农民");
  assert.equal(voucherBalance(state, `household:${idle.id}`), idleBefore, "无务农家庭不收补贴");
  assert.equal(result.paidValueUnits, 5 * perFarmer);
  assertValid(state, "发放后");
});

test("基金不足：镇库垫付并记为基金负债", () => {
  const state = fixture(9203);
  const { a } = withFarmers(state);
  simulation.setSocialSecurityPolicy(state, { farmerSubsidyPerFarmerJin: 1 });
  assert.equal(state.socialSecurity.cashVoucherUnits + state.socialSecurity.cashWheatUnits, 0, "基金初始无现金");
  const debtBefore = state.socialSecurity.debtToTownUnits;
  const advancedBefore = state.socialSecurity.totalAdvancedUnits;
  const aBefore = voucherBalance(state, `household:${a.id}`);
  const result = payFarmerSubsidies(state, CONTENT);
  const total = 5 * Math.round(P); // A 户 3 人 + B 户 2 人
  assert.equal(result.fromFundValueUnits, 0);
  assert.equal(result.paidValueUnits, total, "镇库垫付全额");
  assert.equal(voucherBalance(state, `household:${a.id}`) - aBefore, 3 * Math.round(P), "A 户实际收到");
  assert.equal(state.socialSecurity.debtToTownUnits - debtBefore, total, "垫付记为基金负债");
  assert.equal(state.socialSecurity.totalAdvancedUnits - advancedBefore, total);
  assert.equal(state.socialSecurity.totalSubsidyUnits, total, "累计补贴支出");
  assertValid(state, "基金不足");
});

test("基金有钱：先由基金付，不动负债", () => {
  const state = fixture(9204);
  const { a } = withFarmers(state);
  simulation.setSocialSecurityPolicy(state, { farmerSubsidyPerFarmerJin: 1 });
  assert.equal(simulation.injectSocialSecurity(state, 100).ok, true);
  const advancedBefore = state.socialSecurity.totalAdvancedUnits;
  const result = payFarmerSubsidies(state, CONTENT);
  assert.equal(result.paidValueUnits, 5 * Math.round(P));
  assert.equal(result.fromFundValueUnits, result.paidValueUnits, "全部由基金付");
  assert.equal(state.socialSecurity.totalAdvancedUnits, advancedBefore, "未发生镇库垫付");
  assert.ok(voucherBalance(state, `household:${a.id}`) > 0);
  assertValid(state, "基金有钱");
});

test("基金关闭：不发农民补贴", () => {
  const state = fixture(9205, { enabled: false });
  const { a } = withFarmers(state);
  assert.equal(simulation.setSocialSecurityPolicy(state, { farmerSubsidyPerFarmerJin: 2 }).ok, true);
  const before = voucherBalance(state, `household:${a.id}`);
  const result = payFarmerSubsidies(state, CONTENT);
  assert.equal(result.paidValueUnits, 0);
  assert.equal(voucherBalance(state, `household:${a.id}`), before);
  assert.equal(state.socialSecurity.totalSubsidyUnits, 0);
  assertValid(state, "基金关闭");
});

test("政策校验：返回新字段；负数与 NaN 拒绝", () => {
  const state = fixture(9206);
  const ok = simulation.setSocialSecurityPolicy(state, { farmerSubsidyPerFarmerJin: 3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.socialSecurity.farmerSubsidyPerFarmerJin, 3);
  assert.equal(simulation.setSocialSecurityPolicy(state, { farmerSubsidyPerFarmerJin: -1 }).ok, false);
  assert.equal(simulation.setSocialSecurityPolicy(state, { farmerSubsidyPerFarmerJin: NaN }).ok, false);
  assert.equal(simulation.setSocialSecurityPolicy(state, { farmerSubsidyPerFarmerJin: 100001 }).ok, false);
  assert.equal(state.socialSecurity.farmerSubsidyPerFarmerJin, 3, "拒绝时不改值");
  assertValid(state, "政策校验");
});

test("validateState 拒绝非法的农民补贴字段", () => {
  const state = fixture(9207);
  state.socialSecurity.farmerSubsidyPerFarmerJin = NaN;
  assert.equal(simulation.validateState(state).valid, false);
  state.socialSecurity.farmerSubsidyPerFarmerJin = 0;
  state.socialSecurity.totalSubsidyUnits = -5;
  assert.equal(simulation.validateState(state).valid, false);
});

test("selectSocialSecurityStats 输出农民补贴标准与累计，且只读", () => {
  const state = fixture(9208);
  withFarmers(state);
  simulation.setSocialSecurityPolicy(state, { farmerSubsidyPerFarmerJin: 1 });
  payFarmerSubsidies(state, CONTENT);
  const snapshot = JSON.stringify(state.socialSecurity);
  const stats = selectSocialSecurityStats(state, CONTENT);
  assert.equal(stats.farmerSubsidyPerFarmerJin, 1);
  assert.equal(stats.totalSubsidyJin, 5);
  assert.equal(JSON.stringify(state.socialSecurity), snapshot, "selector 不写 state");
});

test("旧档缺新字段时照常运行：补贴标准回落到 0", () => {
  const state = fixture(9209);
  withFarmers(state);
  delete state.socialSecurity.farmerSubsidyPerFarmerJin;
  delete state.socialSecurity.totalSubsidyUnits;
  assert.equal(payFarmerSubsidies(state, CONTENT).paidValueUnits, 0);
  assert.equal(selectSocialSecurityStats(state, CONTENT).farmerSubsidyPerFarmerJin, 0);
  assertValid(state, "旧档");
});
