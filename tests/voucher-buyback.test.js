// 粮券收购：镇库用小麦向居民收购超额粮券（systems/voucher-buyback.js）。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { DAILY_STEPS } from "../src/systems/daily.js";
import { settleVoucherBuybackDay, readVoucherBuybackPolicy } from "../src/systems/voucher-buyback.js";
import { householdList, householdPopulation } from "../src/systems/households.js";
import { householdBudgets, invalidateHouseholdBudgets } from "../src/systems/household-budget.js";
import { validateCurrencyInvariant } from "../src/economy/currency.js";
import { validateState } from "../src/core/validation.js";
import { selectVoucherBuyback } from "../src/selectors/voucher-buyback.js";
import { selectDashboard } from "../src/selectors/dashboard.js";
import { townWheatReserveUnits } from "../src/selectors/production.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { clearAllHouseholdVouchers, setHouseholdVoucherUnits } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const RETENTION_DAYS = CONTENT.rules.voucherBuybackRetentionDays ?? 30;
const SELL_SHARE = CONTENT.rules.voucherBuybackSellShare ?? 0.2;

// 有银行（兼容入口）的开局，开关由测试自己打开。
function bankState(seed = 91) {
  const state = simulation.createInitialState({ seed });
  state.monetaryReform = { legacyBankAccess: true };
  return state;
}

// 粮券总量与小麦总量（居民 + 镇库）。
function totals(state) {
  let vouchers = state.currency.balances.town || 0;
  let wheat = state.accounts.town.wheat || 0;
  for (const h of householdList(state)) {
    vouchers += h.voucherUnits || 0;
    wheat += h.inventory.wheat || 0;
  }
  return { vouchers, wheat };
}

// 只留一户有粮券（其余户清零，粮券总量不变），便于按户核算。
function onlyHousehold(state, index, voucherJin) {
  clearAllHouseholdVouchers(state);
  const household = householdList(state)[index];
  setHouseholdVoucherUnits(state, household, voucherJin * V);
  invalidateHouseholdBudgets(state);
  return household;
}

// 与实现独立的留存线计算（测试里重算一遍）。
function retentionUnits(state, household) {
  const row = householdBudgets(state, CONTENT).get(household.id);
  // 口粮钱：每人每日 2 斤 × 天数，按 1 券 / 斤计。
  const foodMoney = householdPopulation(household) * CONTENT.rules.foodPerPersonDay * RETENTION_DAYS * V;
  return Math.max(row.dailySpendUnits * RETENTION_DAYS, foodMoney);
}

test("粮券收购：未建银行拒绝开启；建成银行后可开启；关闭不受限", () => {
  const state = simulation.createInitialState({ seed: 91 });
  const denied = simulation.setVoucherBuyback(state, { enabled: true });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /银行/);
  assert.equal(state.policy.voucherBuyback.enabled, false);

  state.buildings.push({ id: "bank-test", typeId: "bank", level: 1, plotId: "x", x: 0, y: 0, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, materialInvestments: [], completed: { year: 1, day: 1 }, jobs: [] });
  assert.equal(simulation.setVoucherBuyback(state, { enabled: true }).ok, true);
  assert.equal(simulation.setVoucherBuyback(state, { enabled: false }).ok, true);

  const legacy = simulation.createInitialState({ seed: 92 });
  legacy.monetaryReform = { legacyBankAccess: true };
  assert.equal(simulation.setVoucherBuyback(legacy, { enabled: true }).ok, true);
});

test("粮券收购：命令校验类型与范围，比价按一位小数取整", () => {
  const state = bankState();
  assert.equal(simulation.setVoucherBuyback(state, { enabled: "yes" }).ok, false);
  assert.equal(simulation.setVoucherBuyback(state, { dailyWheatJin: -1 }).ok, false);
  assert.equal(simulation.setVoucherBuyback(state, { dailyWheatJin: "abc" }).ok, false);
  assert.equal(simulation.setVoucherBuyback(state, { dailyWheatJin: null }).ok, false);
  assert.equal(simulation.setVoucherBuyback(state, { wheatPerVoucher: 0.4 }).ok, false);
  assert.equal(simulation.setVoucherBuyback(state, { wheatPerVoucher: 2.1 }).ok, false);
  assert.equal(simulation.setVoucherBuyback(state, { wheatPerVoucher: NaN }).ok, false);
  assert.equal(state.policy.voucherBuyback.dailyWheatJin, 50000, "失败的命令不改政策");
  const ok = simulation.setVoucherBuyback(state, { dailyWheatJin: 12345.6, wheatPerVoucher: 1.27 });
  assert.equal(ok.ok, true);
  assert.equal(state.policy.voucherBuyback.dailyWheatJin, 12346);
  assert.equal(state.policy.voucherBuyback.wheatPerVoucher, 1.3);
});

test("粮券收购：开局默认关闭，且步骤表里在金融之后、富人税之前", () => {
  const state = bankState();
  assert.deepEqual(state.policy.voucherBuyback, { enabled: false, dailyWheatJin: 50000, wheatPerVoucher: 1 });
  const ids = DAILY_STEPS.map(step => step.id);
  assert.ok(ids.indexOf("voucherBuyback") > ids.indexOf("finance"));
  assert.ok(ids.indexOf("voucherBuyback") < ids.indexOf("wealthTax"));
  // 关闭时不动账
  const before = totals(state);
  settleVoucherBuybackDay(state, CONTENT);
  assert.deepEqual(totals(state), before);
  assert.equal(state.voucherBuyback.day.households, undefined);
});

test("粮券收购：按留存线与出售比例成交（超额 × 20%，小麦 1:1 进户库）", () => {
  const state = bankState();
  assert.equal(simulation.setVoucherBuyback(state, { enabled: true }).ok, true);
  const household = onlyHousehold(state, 0, 200000);
  const retention = retentionUnits(state, household);
  const expected = Math.floor((200000 * V - retention) * SELL_SHARE);
  assert.ok(expected > 0 && expected < 50000 * I, "测试数值应落在每日上限之内");
  const wheatBefore = household.inventory.wheat;
  const townWheatBefore = state.accounts.town.wheat;
  const townVouchersBefore = state.currency.balances.town;

  settleVoucherBuybackDay(state, CONTENT);

  assert.equal(state.voucherBuyback.day.voucherUnits, expected);
  assert.equal(state.voucherBuyback.day.wheatUnits, expected);
  assert.equal(state.voucherBuyback.day.households, 1);
  assert.equal(household.voucherUnits, 200000 * V - expected);
  assert.equal(household.inventory.wheat, wheatBefore + expected);
  assert.equal(state.accounts.town.wheat, townWheatBefore - expected);
  assert.equal(state.currency.balances.town, townVouchersBefore + expected);
  assert.equal(state.voucherBuyback.cumulative.voucherUnits, expected);
  assert.equal(state.voucherBuyback.year.wheatUnits, expected);
});

test("粮券收购：留存线以内的户不卖", () => {
  const state = bankState();
  simulation.setVoucherBuyback(state, { enabled: true });
  const household = onlyHousehold(state, 3, 1);
  settleVoucherBuybackDay(state, CONTENT);
  assert.equal(state.voucherBuyback.day.voucherUnits || 0, 0);
  assert.equal(household.voucherUnits, V);
});

test("粮券收购：每日小麦上限生效", () => {
  const state = bankState();
  simulation.setVoucherBuyback(state, { enabled: true, dailyWheatJin: 1000 });
  for (const household of householdList(state).slice(0, 40)) setHouseholdVoucherUnits(state, household, 100000 * V);
  invalidateHouseholdBudgets(state);
  settleVoucherBuybackDay(state, CONTENT);
  assert.equal(state.voucherBuyback.day.wheatUnits, 1000 * I, "比价 1 时小麦恰好用满上限");
  assert.ok(state.voucherBuyback.day.households >= 1);
});

test("粮券收购：镇库可卖小麦以口粮储备线为界", () => {
  const state = bankState();
  simulation.setVoucherBuyback(state, { enabled: true, dailyWheatJin: 50000 });
  state.accounts.town.wheat = townWheatReserveUnits(state, CONTENT) + 500 * I;
  for (const household of householdList(state).slice(0, 40)) setHouseholdVoucherUnits(state, household, 100000 * V);
  invalidateHouseholdBudgets(state);
  const view = selectVoucherBuyback(state, CONTENT);
  assert.equal(Math.round(view.townSellableWheatJin), 500);
  settleVoucherBuybackDay(state, CONTENT);
  assert.equal(state.voucherBuyback.day.wheatUnits, 500 * I);
  assert.ok(state.accounts.town.wheat >= townWheatReserveUnits(state, CONTENT), "收购后镇库小麦不低于口粮储备线");
});

test("粮券收购：比价 0.5 / 1 / 2 的换算", () => {
  for (const ratio of [0.5, 1, 2]) {
    const state = bankState();
    simulation.setVoucherBuyback(state, { enabled: true, wheatPerVoucher: ratio });
    onlyHousehold(state, 5, 200000);
    settleVoucherBuybackDay(state, CONTENT);
    const v = state.voucherBuyback.day.voucherUnits;
    const w = state.voucherBuyback.day.wheatUnits;
    assert.ok(v > 0, `比价 ${ratio} 应有成交`);
    assert.equal(w, Math.floor(v * ratio), `比价 ${ratio}：小麦 = 粮券 × 比价`);
    assert.ok(w <= 50000 * I, "不超过每日上限");
  }
});

test("粮券收购：某户小麦入库不成立时整户回滚，其余户照常", () => {
  const state = bankState();
  simulation.setVoucherBuyback(state, { enabled: true });
  const households = householdList(state);
  clearAllHouseholdVouchers(state);
  const broken = households[0];
  const normal = households[1];
  setHouseholdVoucherUnits(state, broken, 200000 * V);
  setHouseholdVoucherUnits(state, normal, 200000 * V);
  broken.inventory.wheat = Number.MAX_SAFE_INTEGER - 1000;
  invalidateHouseholdBudgets(state);
  const townVouchersBefore = state.currency.balances.town;
  const townWheatBefore = state.accounts.town.wheat;
  const brokenVouchers = broken.voucherUnits;
  const brokenWheat = broken.inventory.wheat;
  const normalWheat = normal.inventory.wheat;

  settleVoucherBuybackDay(state, CONTENT);

  assert.equal(broken.voucherUnits, brokenVouchers, "失败的户粮券不动");
  assert.equal(broken.inventory.wheat, brokenWheat, "失败的户小麦不动");
  assert.equal(state.voucherBuyback.day.households, 1, "只有正常户成交");
  const sold = state.voucherBuyback.day.voucherUnits;
  assert.ok(sold > 0);
  assert.equal(state.currency.balances.town, townVouchersBefore + sold);
  assert.equal(state.accounts.town.wheat, townWheatBefore - sold);
  assert.equal(normal.inventory.wheat, normalWheat + sold);
  assert.equal(state.voucherBuyback.lastError, null);
});

test("粮券收购：粮券与小麦总量守恒，validateState 通过", () => {
  const state = bankState();
  simulation.setVoucherBuyback(state, { enabled: true });
  const before = totals(state);
  for (let day = 0; day < 3; day += 1) settleVoucherBuybackDay(state, CONTENT);
  const after = totals(state);
  assert.deepEqual(after, before, "居民 + 镇库的粮券与小麦总量不变");
  assert.equal(validateCurrencyInvariant(state, CONTENT).valid, true);
  assert.deepEqual(validateState(state, CONTENT).errors, []);
  assert.ok(state.voucherBuyback.cumulative.wheatUnits > 0);
});

test("粮券收购：关闭后不再成交", () => {
  const state = bankState();
  simulation.setVoucherBuyback(state, { enabled: true });
  settleVoucherBuybackDay(state, CONTENT);
  assert.ok(state.voucherBuyback.day.wheatUnits > 0);
  simulation.setVoucherBuyback(state, { enabled: false });
  const before = totals(state);
  settleVoucherBuybackDay(state, CONTENT);
  assert.deepEqual(totals(state), before);
  assert.equal(state.voucherBuyback.day.wheatUnits || 0, 0);
});

test("粮券收购：每日上限用满时从上次停下的户接着轮转", () => {
  const state = bankState();
  simulation.setVoucherBuyback(state, { enabled: true, dailyWheatJin: 2000 });
  for (const household of householdList(state)) setHouseholdVoucherUnits(state, household, 20000 * V);
  invalidateHouseholdBudgets(state);
  const households = householdList(state);
  const before1 = households.map(h => h.voucherUnits);
  settleVoucherBuybackDay(state, CONTENT);
  const sold1 = households.map((h, i) => before1[i] - h.voucherUnits > 0);
  const last1 = sold1.lastIndexOf(true);
  assert.equal(state.voucherBuyback.rotation, (last1 + 1) % households.length, "rotation 指向上次最后成交户的下一户");
  // 第二天：第一位成交的应是 rotation 所指的户
  invalidateHouseholdBudgets(state);
  const before2 = households.map(h => h.voucherUnits);
  settleVoucherBuybackDay(state, CONTENT);
  const sold2 = households.map((h, i) => before2[i] - h.voucherUnits > 0);
  const first2 = sold2.indexOf(true);
  assert.equal(first2, (last1 + 1) % households.length);
});

test("粮券收购：选择器只读，不改 state", () => {
  const state = bankState();
  simulation.setVoucherBuyback(state, { enabled: true });
  settleVoucherBuybackDay(state, CONTENT);
  const snapshot = JSON.stringify(state);
  const view = selectVoucherBuyback(state, CONTENT);
  assert.equal(view.enabled, true);
  assert.equal(view.bankReady, true);
  assert.ok(view.dailyWheatJin === 50000);
  const dashboard = selectDashboard(state, CONTENT, { panel: "policy" });
  assert.ok(dashboard.voucherBuyback, "政策面板带粮券收购视图");
  assert.equal(dashboard.voucherBuyback.day.households, state.voucherBuyback.day.households || 0);
  assert.equal(JSON.stringify(state), snapshot);
});

test("粮券收购：旧档没有字段时读档补默认值", () => {
  const state = bankState();
  const raw = JSON.parse(JSON.stringify(state));
  delete raw.policy.voucherBuyback;
  delete raw.voucherBuyback;
  const loaded = migrateSave(raw, CONTENT);
  assert.deepEqual(loaded.policy.voucherBuyback, { enabled: false, dailyWheatJin: 50000, wheatPerVoucher: 1 });
  assert.deepEqual(readVoucherBuybackPolicy(loaded), { enabled: false, dailyWheatJin: 50000, wheatPerVoucher: 1 });
  assert.deepEqual(validateState(loaded, CONTENT).errors, []);
});

test("粮券收购：1320 户日结步骤开销很小（冷缓存最坏情况）", () => {
  const state = bankState();
  simulation.setVoucherBuyback(state, { enabled: true });
  for (const household of householdList(state)) setHouseholdVoucherUnits(state, household, 40000 * V);
  assert.equal(householdList(state).length >= 1300, true);
  const samples = [];
  for (let k = 0; k < 5; k += 1) {
    invalidateHouseholdBudgets(state);
    const t = performance.now();
    settleVoucherBuybackDay(state, CONTENT);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const median = samples[2];
  // 整天的日结耗时约 50—100 毫秒；这里只做宽松上限，防止退化成全户支付循环。
  assert.ok(median < 30, `粮券收购步骤中位耗时 ${median.toFixed(2)} 毫秒`);
});
