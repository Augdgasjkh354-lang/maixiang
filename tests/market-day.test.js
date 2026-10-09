import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { buyRepairWoodForResidents } from "../src/systems/housing.js";
import { buyGoodsForResidents, accrueGoodsDemand } from "../src/systems/goods-demand.js";
import { householdList, isActiveHousehold } from "../src/systems/households.js";

const DAYS = CONTENT.rules.householdGoodsShoppingDays;

test("赶集：修房木材逐日累计，每 householdGoodsShoppingDays 天才统一采购一次", () => {
  const state = simulation.createInitialState({ seed: 7101 });
  let pendingBefore = 0;
  for (let day = 1; day < DAYS; day += 1) {
    state.day = day;
    const row = buyRepairWoodForResidents(state, CONTENT);
    assert.equal(row.reason, "未到采购日");
    assert.equal(row.purchasedUnits, 0);
    assert.ok(state.housing.repairWoodPendingUnits >= pendingBefore, "需求逐日累计");
    pendingBefore = state.housing.repairWoodPendingUnits;
  }
  state.day = DAYS;
  const row = buyRepairWoodForResidents(state, CONTENT);
  assert.ok(row.targetUnits >= pendingBefore, "采购日按累计量采购");
  assert.equal(state.housing.repairWoodPendingUnits, 0, "采购日清空累计（买不到的不结转）");
});

test("赶集：日用品存货够当天用就不上街；不够时一次补到 householdGoodsShoppingDays 天", () => {
  const state = simulation.createInitialState({ seed: 7102 });
  accrueGoodsDemand(state, 0, CONTENT);
  const itemId = Object.keys(CONTENT.rules.householdGoods)[0];
  // 没有任何卖家：只看各户想买的量（purchaseItemForResidents 会报"没有卖家"，不改状态）。
  const households = householdList(state).filter(isActiveHousehold);
  const stocked = households[0];
  stocked.inventory[itemId] = 10 ** 9; // 存货充足
  const before = JSON.stringify(stocked.inventory);
  buyGoodsForResidents(state, CONTENT);
  assert.equal(JSON.stringify(stocked.inventory), before, "存货够用的人家不买");
});
