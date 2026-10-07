import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { addInventory, itemQeqUnitsPerInventoryUnit, quantityToUnits } from "../src/economy/inventory.js";
import { buyStaplesForResidents, stapleDemandShares, breadDemandShare } from "../src/systems/market.js";
import { buyRepairWoodForResidents } from "../src/systems/housing.js";
import { householdList, setJobCount } from "../src/systems/households.js";
import { grantResidentVouchers, setResidentInventoryJin } from "./helpers-v16.js";

const SCALE = CONTENT.precision.inventoryUnitsPerJin;
// 每日修缮木材：规则按“木材单位”计，断言一律用库存精度单位。
const WOOD_DAY_UNITS = quantityToUnits(CONTENT.rules.houseRepairWoodUnitsPerDay, CONTENT);

// 居民购买面粉、面包只允许在综合商店成交，这里搭一间有充足伙计的综合商店。
function voucherState() {
  const state = simulation.createInitialState();
  state.monetaryReform = {
    stage: "voucher", targetVoucherBps: 10000, residentExchangeEnabled: true, legacyBankAccess: true,
    started: null, completed: { legacy: true }, paymentHistory: [], voucherShortfallByKey: {}
  };
  return state;
}

function withGeneralStore(state, stock = {}) {
  const owner = householdList(state)[0];
  state.shops = {
    "shop-test": {
      id: "shop-test", name: "测试综合商店", buildingId: "street-test", typeId: "general",
      primaryItemId: "wheat", itemId: "wheat", itemIds: ["wheat", "flour", "bread", "salt"],
      ownerHouseholdId: owner.id, cashVoucherUnits: 0, cashWheatUnits: 0,
      inventory: { wheat: 0, flour: 0, bread: 0, salt: 0, wood: 0, ...stock },
      inventoryCostVoucherUnits: {}, status: "open", statusReason: "准备营业",
      accounts: { day: { soldUnits: {} }, year: { soldUnits: {} }, cumulative: { soldUnits: {} } },
      liabilities: {}, settlement: {}, retainedEarningsVoucherUnits: 0
    }
  };
  owner.jobs ||= {};
  owner.jobs["shop:shop-test:merchant"] = 1;
  // 伙计决定综合商店的日销售容量，容量不足会掩盖真实的居民需求。
  setJobCount(state, "shop:shop-test:clerk", 40, CONTENT);
  return state;
}

function clearStaples(state) {
  for (const itemId of ["wheat", "flour", "bread"]) setResidentInventoryJin(state, itemId, 0, CONTENT);
}

test("居民主食需求按固定份额拆分，小麦、面粉、面包都会购买", () => {
  assert.deepEqual(stapleDemandShares(CONTENT), { wheat: 0.6, flour: 0.2, bread: 0.2 });
  assert.equal(CONTENT.rules.stapleDemandShares.wheat + CONTENT.rules.stapleDemandShares.flour
    + CONTENT.rules.stapleDemandShares.bread, 1);

  const state = withGeneralStore(voucherState(), {
    wheat: 3000 * SCALE, flour: 3000 * SCALE, bread: 3000 * SCALE
  });
  grantResidentVouchers(state, 10000000, CONTENT);
  clearStaples(state);

  const population = 250;
  const result = buyStaplesForResidents(state, population, CONTENT);
  const rows = result.staples.rows;

  // 三项份额都发起了购买，并且都真实成交。
  assert.deepEqual(rows.map(row => row.itemId), ["wheat", "flour", "bread"]);
  assert.deepEqual(rows.map(row => row.targetShare), [0.6, 0.2, 0.2]);
  for (const row of rows) assert.ok(row.purchasedJin > 0, `${row.itemId} 应当发生购买`);

  // 目标口粮当量严格按份额拆分。
  const dailyNeedJin = population * CONTENT.rules.foodPerPersonDay;
  assert.equal(rows[0].targetQeqJin, dailyNeedJin * 0.6);
  assert.equal(rows[1].targetQeqJin, dailyNeedJin * 0.2);
  assert.equal(rows[2].targetQeqJin, dailyNeedJin * 0.2);

  // 面包口粮当量为 5/6，因此成交的物理斤数比口粮当量多。
  // （户数增加后逐户取整累积微小误差，用近似比较）
  assert.ok(Math.abs(rows[2].purchasedJin - rows[2].targetQeqJin / (5 / 6)) < 0.1,
    `面包购买量应接近理论值，实际${rows[2].purchasedJin}`);
  assert.equal(itemQeqUnitsPerInventoryUnit(CONTENT.items.bread, CONTENT), 5);
  assert.equal(itemQeqUnitsPerInventoryUnit(CONTENT.items.wheat, CONTENT), 6);

  // 居民库存里确实增加了这三种主食。
  assert.ok(state.accounts.residents.wheat > 0);
  assert.ok(state.accounts.residents.flour > 0);
  assert.ok(state.accounts.residents.bread > 0);
});

test("主食购买采用净需求：已有库存会扣减当日购买量", () => {
  const population = 250;
  const flourTargetJin = population * CONTENT.rules.foodPerPersonDay * 0.2;

  // 对照组：家中没有面粉，按目标足额购买。
  const full = withGeneralStore(voucherState(), { flour: 3000 * SCALE });
  grantResidentVouchers(full, 10000000, CONTENT);
  setResidentInventoryJin(full, "flour", 0, CONTENT);
  const boughtFull = buyStaplesForResidents(full, population, CONTENT).staples.rows
    .find(row => row.itemId === "flour");
  // （户数增加后逐户取整累积微小误差，用近似比较）
  assert.ok(Math.abs(boughtFull.purchasedJin - flourTargetJin) < 0.1,
    `对照组应足额购买，实际${boughtFull.purchasedJin}，目标${flourTargetJin}`);

  // 实验组：家中已有大部分面粉，只补足差额。
  const partial = withGeneralStore(voucherState(), { flour: 3000 * SCALE });
  grantResidentVouchers(partial, 10000000, CONTENT);
  const heldJin = Math.floor(flourTargetJin * 0.75);
  setResidentInventoryJin(partial, "flour", heldJin, CONTENT);
  const boughtPartial = buyStaplesForResidents(partial, population, CONTENT).staples.rows
    .find(row => row.itemId === "flour");

  assert.ok(boughtPartial.purchasedJin < boughtFull.purchasedJin);
  // （户数增加后逐户取整累积微小误差，用近似比较）
  assert.ok(Math.abs(boughtPartial.purchasedJin - (flourTargetJin - heldJin)) < 0.1,
    `实验组应补足差额，实际${boughtPartial.purchasedJin}，目标${flourTargetJin - heldJin}`);
  assert.ok(Math.abs(partial.accounts.residents.flour / SCALE - flourTargetJin) < 0.1,
    `居民面粉库存应接近目标${flourTargetJin}，实际${partial.accounts.residents.flour / SCALE}`);

  // 已有库存超过目标时完全不买。
  const satisfied = withGeneralStore(voucherState(), { flour: 3000 * SCALE });
  grantResidentVouchers(satisfied, 10000000, CONTENT);
  setResidentInventoryJin(satisfied, "flour", flourTargetJin * 2, CONTENT);
  const boughtNone = buyStaplesForResidents(satisfied, population, CONTENT).staples.rows
    .find(row => row.itemId === "flour");
  assert.equal(boughtNone.purchasedJin, 0);
  assert.match(boughtNone.limitReason, /已满足今日目标/);
});

test("面包需求份额保持弹性函数原样，旧入口按固定份额购买", () => {
  // breadDemandShare 的弹性行为不得改变。
  assert.ok(breadDemandShare(4, CONTENT) < breadDemandShare(2, CONTENT));
  assert.ok(breadDemandShare(1, CONTENT) > breadDemandShare(2, CONTENT));
  assert.ok(breadDemandShare(0.01, CONTENT) <= CONTENT.rules.breadTargetShareMaximum);
  assert.equal(breadDemandShare(2, CONTENT), 0.25);
  assert.equal(breadDemandShare(0, CONTENT), 0);
});

// 镇库木材是建设储备，居民修缮只能从企业等市场余量购买；这里挂一家木材企业供货。
function withWoodCompany(state, units = 100000) {
  state.companies = {
    "company-wood": {
      id: "company-wood", name: "测试木材行",
      inventory: { wood: units }, inventoryCostVoucherUnits: {},
      books: { settings: { salePricesVoucherPerUnit: {} } }
    }
  };
  return state;
}

test("修缮木材买入后即记为消耗，不在居民库存里堆积", () => {
  const state = withWoodCompany(voucherState());
  grantResidentVouchers(state, 1000000, CONTENT);
  assert.equal(state.accounts.residents.wood, 0);

  const result = buyRepairWoodForResidents(state, CONTENT);

  assert.equal(result.targetUnits, WOOD_DAY_UNITS);
  assert.equal(result.purchasedUnits, WOOD_DAY_UNITS);
  assert.equal(result.consumedUnits, WOOD_DAY_UNITS);
  // 买多少就消耗多少：居民木材库存归零，没有净增。
  assert.equal(state.accounts.residents.wood, 0);
  assert.equal(householdList(state).reduce((sum, household) => sum + (household.inventory.wood || 0), 0), 0);

  // 记了一笔房屋修缮消耗的账。
  const entries = state.ledger.filter(row => row.type === "house_repair_wood");
  assert.equal(entries.reduce((sum, row) => sum + row.quantityUnits, 0), WOOD_DAY_UNITS);
  assert.ok(entries.every(row => row.itemId === "wood"));

  // 连续多日购买也不会让居民木材库存单调增长。
  for (let day = 0; day < 5; day += 1) {
    const daily = buyRepairWoodForResidents(state, CONTENT);
    assert.equal(daily.purchasedUnits, WOOD_DAY_UNITS);
    assert.equal(daily.consumedUnits, WOOD_DAY_UNITS);
    assert.equal(state.accounts.residents.wood, 0);
  }
});

test("居民原有木材库存不会被修缮消耗动用", () => {
  const state = withWoodCompany(voucherState());
  grantResidentVouchers(state, 1000000, CONTENT);
  // 只有第一户持有原有木材；其余家庭从零开始买入，因此市场里没有居民卖家。
  const [holder] = householdList(state);
  const existingUnits = 7 * CONTENT.precision.inventoryUnitsPerJin;
  holder.inventory.wood = existingUnits;

  const result = buyRepairWoodForResidents(state, CONTENT);

  assert.equal(result.purchasedUnits, WOOD_DAY_UNITS);
  assert.equal(result.consumedUnits, WOOD_DAY_UNITS);
  // 原有库存原样保留，消耗只针对本日买入的部分。
  assert.ok(holder.inventory.wood >= existingUnits);
  assert.equal(state.accounts.residents.wood, existingUnits);
});

test("市场没有木材库存时不产生虚假消耗", () => {
  const state = voucherState();
  setResidentInventoryJin(state, "wood", 7, CONTENT);
  const before = state.accounts.residents.wood;
  const result = buyRepairWoodForResidents(state, CONTENT);
  assert.equal(result.purchasedUnits, 0);
  assert.equal(result.consumedUnits, 0);
  assert.equal(state.accounts.residents.wood, before);
  assert.equal(state.ledger.filter(row => row.type === "house_repair_wood").length, 0);
});

test("镇库木材属于建设储备，居民修缮不向镇库购买", () => {
  const state = voucherState();
  addInventory(state, "town", "wood", 5000, "测试建设储备", "test_adjustment", CONTENT);
  grantResidentVouchers(state, 1000000, CONTENT);
  const townWoodBefore = state.accounts.town.wood;

  const result = buyRepairWoodForResidents(state, CONTENT);

  assert.equal(result.purchasedUnits, 0);
  assert.equal(state.accounts.town.wood, townWoodBefore, "镇库木材不得被居民修缮需求挤占");
});
