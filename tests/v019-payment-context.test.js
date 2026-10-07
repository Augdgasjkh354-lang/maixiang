import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import {
  createPaymentCapabilityContext,
  currentPaymentComposition,
  maximumFullyPayableValueUnits,
  maximumPayableValueUnits,
  quoteMonetaryPayment,
  quotePaymentValueUnitsWithContext,
  settleMonetaryPayment
} from "../src/economy/payment.js";
import { transferVouchers } from "../src/economy/currency.js";
import {
  householdConvertibleWheatUnits,
  householdIdleWorkers,
  householdList,
  syncResidentAggregates
} from "../src/systems/households.js";
import { purchaseItemForResidents } from "../src/systems/consumer-market.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function paymentState(stage, targetVoucherBps, seed = 19001) {
  const state = simulation.createInitialState({ seed });
  state.monetaryReform = {
    stage,
    targetVoucherBps,
    residentExchangeEnabled: stage !== "wheat",
    legacyBankAccess: true,
    started: stage === "wheat" ? null : { year: 1, day: 1 },
    completed: stage === "voucher" ? { year: 1, day: 1 } : null,
    paymentHistory: [],
    voucherShortfallByKey: {}
  };
  if (stage !== "wheat") {
    assert.equal(simulation.issueGrainVouchers(state, "town", 2000).ok, true);
    const household = householdList(state).find(row => householdIdleWorkers(row) > 0);
    assert.ok(household);
    assert.equal(transferVouchers(state, "town", `household:${household.id}`, 25 * V, CONTENT, "test_seed", "测试资金").ok, true);
    return { state, household };
  }
  return { state, household: householdList(state).find(row => householdIdleWorkers(row) > 0) };
}

function legacyMaximumFullyPayable(state, owner, limitValueUnits, options) {
  let low = 0;
  let high = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(limitValueUnits) || 0)));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const quote = quoteMonetaryPayment(state, owner, currentPaymentComposition(state, mid), CONTENT, options);
    if (quote.full) low = mid;
    else high = mid - 1;
  }
  return low;
}

test("0.1.9 支付能力上下文在小麦、混合、全粮券阶段与逐次报价完全一致", () => {
  for (const [stage, bps] of [["wheat", 0], ["transition", 5000], ["voucher", 10000]]) {
    const { state, household } = paymentState(stage, bps, 19010 + bps);
    const owner = `household:${household.id}`;
    const maxWheatUnits = householdConvertibleWheatUnits(state, household, CONTENT, CONTENT.rules.householdFoodReserveDays ?? 30);
    const options = { maxWheatUnits };
    const context = createPaymentCapabilityContext(state, owner, CONTENT, options);
    for (const value of [0, 1, V - 1, V, 7 * V, 25 * V, 80 * V + 17]) {
      const oldQuote = quoteMonetaryPayment(state, owner, currentPaymentComposition(state, value), CONTENT, options);
      const cachedQuote = quotePaymentValueUnitsWithContext(context, value);
      assert.deepEqual(cachedQuote, oldQuote, `${stage} value=${value}`);
    }
  }
});

test("0.1.9 二分搜索只复用搜索期间不变能力，最大可付整数结果不变", () => {
  for (const [stage, bps] of [["wheat", 0], ["transition", 3000], ["voucher", 10000]]) {
    const { state, household } = paymentState(stage, bps, 19100 + bps);
    const owner = `household:${household.id}`;
    const maxWheatUnits = Math.floor(householdConvertibleWheatUnits(state, household, CONTENT, 30) / 3);
    const options = { maxWheatUnits };
    const limit = maximumPayableValueUnits(state, owner, CONTENT);
    const expected = legacyMaximumFullyPayable(state, owner, limit, options);
    const context = createPaymentCapabilityContext(state, owner, CONTENT, options);
    const actual = maximumFullyPayableValueUnits(state, owner, limit, CONTENT, { ...options, paymentContext: context });
    assert.equal(actual, expected, stage);
  }
});

test("0.1.9 能力上下文不进入state，真实成交仍按成交时余额重新核对", () => {
  const { state, household } = paymentState("voucher", 10000, 19201);
  state.monetaryReform.residentExchangeEnabled = false;
  const owner = `household:${household.id}`;
  const before = JSON.stringify(state);
  const context = createPaymentCapabilityContext(state, owner, CONTENT, { maxWheatUnits: 0 });
  assert.equal(JSON.stringify(state), before);
  assert.equal(quotePaymentValueUnitsWithContext(context, 20 * V).full, true);
  assert.equal(transferVouchers(state, owner, "town", 25 * V, CONTENT, "test_drain", "测试抽走余额").ok, true);
  const settled = settleMonetaryPayment(state, owner, "town", currentPaymentComposition(state, 20 * V), CONTENT,
    "test_payment", "测试真实成交复核", { requireFull: true, maxWheatUnits: 0 });
  assert.equal(settled.ok, false, "实际成交不得使用失效的旧上下文");
});

test("0.1.9 同一家庭在同一市场轮次先收款再付款时仍按最新状态报价", () => {
  // 基线清理：面包/面粉/盐只能经综合商店零售（consumer-market.js generalStoreOnly），住户不可直售；
  // 本测试验证的是"同轮次内报价跟随最新状态"，改用住户可直售的木材，定价逻辑不变。
  const state = simulation.createInitialState({ seed: 19301 });
  const households = householdList(state).filter(row => householdIdleWorkers(row) > 0).slice(0, 2);
  assert.equal(households.length, 2);
  const [a, b] = households;
  a.inventory.wood = 10 * I;
  b.inventory.wood = 10 * I;
  syncResidentAggregates(state, CONTENT);
  const before = {
    aWheat: a.inventory.wheat,
    bWheat: b.inventory.wheat,
    aWood: a.inventory.wood,
    bWood: b.inventory.wood
  };
  const result = purchaseItemForResidents(state, "wood", 20 * I, 2, CONTENT, "双向家庭交易", {
    householdNeedsUnits: { [a.id]: 10 * I, [b.id]: 10 * I }
  });
  assert.equal(result.purchasedUnits, 20 * I);
  assert.equal(result.sellerRows.length, 2);
  assert.deepEqual(result.sellerRows.map(row => row.seller), [`household:${a.id}`, `household:${b.id}`]);
  assert.equal(a.inventory.wood, before.aWood);
  assert.equal(b.inventory.wood, before.bWood);
  assert.equal(a.inventory.wheat, before.aWheat);
  assert.equal(b.inventory.wheat, before.bWheat);
});
