import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import {
  householdList, householdIdleWorkers, residentVoucherUnits, setForceFullResidentSync,
  syncResidentAggregates, withDeferredHouseholdSync
} from "../src/systems/households.js";
import { transferVouchers, redeemVouchersForWheat } from "../src/economy/currency.js";
import { ensureSocialSecurity } from "../src/systems/social-security.js";
import { payUnemploymentBenefit } from "../src/systems/payroll.js";
import { applyAutomaticRelief, redeemEssentialFoodForHouseholds } from "../src/systems/finance.js";
import { cloneFixture } from "./helpers-fixture.js";

// 逐户改动后居民汇总改为增量维护（applyResidentAggregateDelta）。
// 这里用两条路径比对：增量路径（默认）与逐笔全量同步路径（setForceFullResidentSync(true)，即旧做法）。
// 同一状态分别跑两遍，状态 JSON（含键顺序）与返回值都必须逐字段一致，并且居民汇总等于逐户之和。

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function assertMirrorMatchesHouseholds(state) {
  const households = householdList(state);
  for (const itemId of Object.keys(CONTENT.items)) {
    const sum = households.reduce((total, household) => total + (household.inventory?.[itemId] || 0), 0);
    assert.equal(state.accounts.residents[itemId], sum, `居民汇总 ${itemId} 与逐户之和不一致`);
  }
  const voucherSum = households.reduce((total, household) => total + (household.voucherUnits || 0), 0);
  assert.equal(state.currency.balances.residents, voucherSum, "居民粮券汇总与逐户之和不一致");
}

function assertValid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

function runBothPaths(base, run) {
  const incremental = cloneFixture({ state: base }).state;
  const perPayment = cloneFixture({ state: base }).state;
  const resultIncremental = run(incremental);
  const previous = setForceFullResidentSync(true);
  let resultPerPayment;
  try {
    resultPerPayment = run(perPayment);
  } finally {
    setForceFullResidentSync(previous);
  }
  assert.equal(JSON.stringify(incremental), JSON.stringify(perPayment), "增量路径与逐笔路径的状态不一致");
  assert.deepEqual(resultIncremental, resultPerPayment, "增量路径与逐笔路径的返回值不一致");
  assertMirrorMatchesHouseholds(incremental);
  assertValid(incremental);
  return { state: incremental, result: resultIncremental };
}

function baseState(seed) {
  const state = simulation.createInitialState({ seed });
  assertValid(state);
  return state;
}

// 饿着肚子的镇子：所有家庭没有口粮；偶数户有粮券；镇库只有指定斤数的小麦（救济与兑付的供给）。
// 有粮券的家庭先自费兑付（优先于镇库拨粮），所以粮券要少于镇库小麦，救济才有剩余可拨。
function hungryTownState(seed, townWheatJin, voucherPerHouseholdJin = 60) {
  const state = baseState(seed);
  for (const household of householdList(state)) {
    for (const [itemId, item] of Object.entries(CONTENT.items)) if (item.edible) household.inventory[itemId] = 0;
  }
  syncResidentAggregates(state, CONTENT);
  // 开局家庭手里已有粮券：先全部收回镇库，再只给偶数户少量粮券。
  for (const household of householdList(state)) {
    const r = transferVouchers(state, `household:${household.id}`, "town", household.voucherUnits || 0, CONTENT, "test_recall", "测试收回粮券");
    assert.equal(r.ok, true, r.reason);
  }
  householdList(state).forEach((household, index) => {
    if (index % 2 !== 0) return;
    const r = transferVouchers(state, "town", `household:${household.id}`, voucherPerHouseholdJin * V, CONTENT, "test_income", "测试居民收入");
    assert.equal(r.ok, true, r.reason);
  });
  for (const [itemId, item] of Object.entries(CONTENT.items)) if (item.edible) state.accounts.town[itemId] = 0;
  state.accounts.town.wheat = Math.round(townWheatJin * I);
  syncResidentAggregates(state, CONTENT);
  state.autoRelief = true;
  assertMirrorMatchesHouseholds(state);
  return state;
}

test("逐户转账与兑付后居民汇总每一步都等于逐户之和（增量维护，不靠整表重算）", () => {
  const state = baseState(8301);
  const households = householdList(state);
  households.forEach((household, index) => {
    const r = transferVouchers(state, "town", `household:${household.id}`, (10 + (index % 7)) * V, CONTENT, "test_income", "测试");
    assert.equal(r.ok, true, r.reason);
    if (index < 25) assertMirrorMatchesHouseholds(state);
  });
  assertMirrorMatchesHouseholds(state);
  state.accounts.town.wheat = 100000 * I;
  households.forEach((household, index) => {
    if (index % 3 !== 0) return;
    const r = redeemVouchersForWheat(state, `household:${household.id}`, 5 * V, CONTENT, "测试兑付");
    assert.equal(r.ok, true, r.reason);
    if (index < 60) assertMirrorMatchesHouseholds(state);
  });
  assertMirrorMatchesHouseholds(state);
  assertValid(state);
});

test("延迟同步窗口内逐户兑付后读居民粮券，读到的是逐户之和（不是陈旧汇总）", () => {
  const state = baseState(8302);
  const households = householdList(state);
  state.accounts.town.wheat = 100000 * I;
  withDeferredHouseholdSync(state, CONTENT, () => {
    for (const household of households.slice(0, 40)) {
      const r = transferVouchers(state, "town", `household:${household.id}`, 9 * V, CONTENT, "test_income", "测试");
      assert.equal(r.ok, true, r.reason);
      const r2 = redeemVouchersForWheat(state, `household:${household.id}`, 2 * V, CONTENT, "测试兑付");
      assert.equal(r2.ok, true, r2.reason);
      const sum = households.reduce((total, row) => total + (row.voucherUnits || 0), 0);
      assert.equal(residentVoucherUnits(state), sum, "窗口内读数必须等于逐户之和");
    }
  });
  assertMirrorMatchesHouseholds(state);
  assertValid(state);
});

test("失业金：增量路径与逐笔全量同步路径结果逐字段一致（含社保基金垫付分支）", () => {
  for (const fundEnabled of [false, true]) {
    const base = baseState(fundEnabled ? 8303 : 8304);
    simulation.setUnemploymentPolicy(base, { enabled: true, dailyPerWorkerJin: 2 });
    if (fundEnabled) ensureSocialSecurity(base).enabled = true;
    const idle = householdList(base).reduce((total, household) => total + householdIdleWorkers(household), 0);
    assert.ok(idle > 0, "测试需要待业者");
    const { result } = runBothPaths(base, state => payUnemploymentBenefit(state, { idle }, CONTENT));
    assert.ok(result.paidVoucher > 0, "失业金应当实际发放");
    assert.equal(result.paidPeople > 0, true);
  }
});

test("兑付：增量路径与逐笔全量同步路径结果逐字段一致", () => {
  const base = hungryTownState(8305, 6000);
  const { result } = runBothPaths(base, state => redeemEssentialFoodForHouseholds(state, CONTENT));
  assert.ok(result.redeemedUnits > 0, "兑付应当实际发生");
});

test("救济：增量路径与逐笔全量同步路径结果逐字段一致（资格核算兑付 + 镇库拨粮）", () => {
  const base = hungryTownState(8306, 2000, 5);
  const population = simulation.populationStats(base).total;
  const { result } = runBothPaths(base, state => applyAutomaticRelief(state, population, CONTENT));
  assert.ok(result.eligibleHouseholds > 0, "救济应当有合格家庭");
  assert.ok(result.servedHouseholds > 0, "救济应当实际拨粮");
  assert.ok(result.redeemedWheatUnits > 0, "救济资格核算阶段应当有家庭自费兑付");
});
