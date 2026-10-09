import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { householdList, syncResidentAggregates, withDeferredHouseholdSync } from "../src/systems/households.js";
import { accountQeqUnits, changeInventory, transferFoodQeq } from "../src/economy/inventory.js";

// 居民库存镜像（accounts.residents）增量维护：多次随机转移后必须与逐户余额之和一致，
// 且不依赖任何当天缓存（重算一遍镜像与备份逐字段相同）。

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

function assertMirrorMatchesHouseholds(state) {
  const households = householdList(state);
  for (const itemId of Object.keys(CONTENT.items)) {
    const sum = households.reduce((total, household) => total + (household.inventory?.[itemId] || 0), 0);
    assert.equal(state.accounts.residents[itemId], sum, `居民镜像 ${itemId} 与逐户之和不一致`);
  }
  const voucherSum = households.reduce((total, household) => total + (household.voucherUnits || 0), 0);
  assert.equal(state.currency.balances.residents, voucherSum, "居民粮券镜像与逐户之和不一致");
}

// 备份一份副本，整表重算镜像后与原状态逐字段比较：证明增量结果没有偏离，也没有依赖缓存。
function assertMirrorEqualsFreshRecompute(state) {
  const copy = JSON.parse(JSON.stringify(state));
  syncResidentAggregates(copy, CONTENT);
  assert.equal(JSON.stringify(state.accounts.residents), JSON.stringify(copy.accounts.residents));
  assert.equal(JSON.stringify(state.currency.balances.residents), JSON.stringify(copy.currency.balances.residents));
}

test("resident inventory mirror tracks per-household sums through random transfers", () => {
  const state = simulation.createInitialState({ seed: 8101 });
  valid(state);
  assertMirrorMatchesHouseholds(state);

  const rand = lcg(20260901);
  const households = householdList(state);
  const edibleItems = Object.keys(CONTENT.items).filter(id => CONTENT.items[id].edible && CONTENT.items[id].qeq);
  const pickItem = () => edibleItems[Math.floor(rand() * edibleItems.length)];
  const pickHousehold = () => `household:${households[Math.floor(rand() * households.length)].id}`;
  const owners = ["residents", "town", "town", pickHousehold];
  const pickOwner = () => {
    const choice = owners[Math.floor(rand() * owners.length)];
    return typeof choice === "function" ? choice() : choice;
  };

  for (let step = 0; step < 300; step += 1) {
    const from = pickOwner();
    let to = pickOwner();
    if (to === from) to = from === "residents" ? "town" : "residents";
    const roll = rand();
    if (roll < 0.6) {
      // 口粮当量转移（先扣后给；residents 与户库存的增量都经过这里）
      transferFoodQeq(state, from, to, Math.floor(rand() * 4000) * CONTENT.precision.qeqUnitsPerJin / 100, "随机转移", "test", CONTENT, { allowPartial: true });
    } else {
      // 直接改某账户某物品库存（正负都有，不足时返回失败且不改状态）
      const delta = Math.floor(rand() * 400) - (rand() < 0.5 ? 0 : 200);
      if (delta !== 0) changeInventory(state, from, pickItem(), delta, "随机变动", "test", CONTENT);
    }
    if (step % 25 === 24) {
      assertMirrorMatchesHouseholds(state);
      valid(state);
    }
  }

  assertMirrorMatchesHouseholds(state);
  assertMirrorEqualsFreshRecompute(state);
  valid(state);
});

test("resident mirror is rebuilt when a key is missing and during deferred household sync", () => {
  const state = simulation.createInitialState({ seed: 8102 });
  const itemId = "wheat";
  // 镜像缺键：读取时整表补齐，结果与逐户之和一致。
  delete state.accounts.residents[itemId];
  accountQeqUnits(state, "residents", CONTENT);
  assert.equal(Number.isInteger(state.accounts.residents[itemId]), true);
  assertMirrorMatchesHouseholds(state);

  // 延迟同步期间外部直接改户库存：读居民账必须看到改动（延迟期间整表重算）。
  const target = householdList(state)[0];
  withDeferredHouseholdSync(state, CONTENT, () => {
    target.inventory[itemId] = (target.inventory[itemId] || 0) + 1234;
    accountQeqUnits(state, "residents", CONTENT);
    const sum = householdList(state).reduce((total, household) => total + (household.inventory?.[itemId] || 0), 0);
    assert.equal(state.accounts.residents[itemId], sum);
  });
  assertMirrorMatchesHouseholds(state);
  valid(state);
});
