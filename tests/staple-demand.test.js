import test from "node:test";
import { householdPopulation, syncResidentAggregates } from "../src/systems/households.js";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { addInventory, itemQeqUnitsPerInventoryUnit, quantityToUnits } from "../src/economy/inventory.js";
import { buyStaplesForResidents, stapleDemandShares, breadDemandShare } from "../src/systems/market.js";
import { buyRepairWoodForResidents } from "../src/systems/housing.js";
import { householdList, setJobCount } from "../src/systems/households.js";
import { grantResidentVouchers, setResidentInventoryJin } from "./helpers-v16.js";

const SCALE = CONTENT.precision.inventoryUnitsPerJin;
// 每日修缮木材：户数 × 7.3 斤/户年 ÷ 365（开局户数随人口，660 户时为 13.2 斤/日，整除无结转）。
function woodDayUnits(state) {
  return Math.round(householdList(state).length * CONTENT.rules.houseRepairWoodJinPerHouseholdYear * SCALE / CONTENT.rules.daysPerYear);
}

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

function residentPeople(state) {
  return Object.values(state.households.byId).reduce((sum, h) => sum + householdPopulation(h), 0);
}

test("主食：宽裕人家把口粮换成面粉、面包（标准比例 × 宽裕度，最多 1.5 倍），穷户吃自家小麦", () => {
  const population = 250;
  const rich = withGeneralStore(voucherState(), { wheat: 3000 * SCALE, flour: 3000 * SCALE, bread: 3000 * SCALE });
  grantResidentVouchers(rich, 10000000, CONTENT);
  clearStaples(rich);
  const need = residentPeople(rich) * CONTENT.rules.foodPerPersonDay;
  const rows = buyStaplesForResidents(rich, population, CONTENT).staples.rows;
  const byId = Object.fromEntries(rows.map(row => [row.itemId, row]));
  // 很富：宽裕度封顶，面粉、面包各 0.2 × 1.5 = 0.3。
  assert.ok(Math.abs(byId.bread.targetQeqJin - need * 0.3) < 1, `面包目标 ${byId.bread.targetQeqJin}`);
  assert.ok(Math.abs(byId.flour.targetQeqJin - need * 0.3) < 1, `面粉目标 ${byId.flour.targetQeqJin}`);
  for (const row of rows) assert.ok(row.purchasedJin > 0, `${row.itemId} 应当发生购买`);
  assert.equal(itemQeqUnitsPerInventoryUnit(CONTENT.items.bread, CONTENT), 5);

  const poor = withGeneralStore(voucherState(), { wheat: 3000 * SCALE, flour: 3000 * SCALE, bread: 3000 * SCALE });
  for (const household of Object.values(poor.households.byId)) household.voucherUnits = 0;
  syncResidentAggregates(poor, CONTENT);
  clearStaples(poor);
  const poorRows = Object.fromEntries(buyStaplesForResidents(poor, population, CONTENT).staples.rows.map(row => [row.itemId, row]));
  assert.equal(poorRows.bread.targetQeqJin, 0, "没有家底的人家不买面包");
  assert.equal(poorRows.flour.targetQeqJin, 0, "没有家底的人家不买面粉");
  assert.ok(Math.abs(poorRows.wheat.targetQeqJin - need) < 1, "口粮全由小麦承担");
});

test("主食替代：买不到面包改买面粉；已有库存扣减当日购买量", () => {
  const population = 250;
  const noBread = withGeneralStore(voucherState(), { wheat: 3000 * SCALE, flour: 3000 * SCALE });
  grantResidentVouchers(noBread, 10000000, CONTENT);
  clearStaples(noBread);
  const rows = Object.fromEntries(buyStaplesForResidents(noBread, population, CONTENT).staples.rows.map(row => [row.itemId, row]));
  assert.equal(rows.bread.purchasedJin, 0);
  const need = residentPeople(noBread) * CONTENT.rules.foodPerPersonDay;
  assert.ok(rows.flour.targetQeqJin > need * 0.55, `面包缺口转给面粉，面粉目标 ${rows.flour.targetQeqJin}`);
  assert.ok(rows.flour.purchasedJin > 0);

  // 已有面粉多于目标：不再买面粉。
  const stocked = withGeneralStore(voucherState(), { flour: 3000 * SCALE, bread: 3000 * SCALE });
  grantResidentVouchers(stocked, 10000000, CONTENT);
  clearStaples(stocked);
  setResidentInventoryJin(stocked, "flour", residentPeople(stocked) * CONTENT.rules.foodPerPersonDay, CONTENT);
  const flour = buyStaplesForResidents(stocked, population, CONTENT).staples.rows.find(row => row.itemId === "flour");
  assert.equal(flour.purchasedJin, 0);
  assert.match(flour.limitReason, /已满足今日目标/);
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
  // 660 户每日买 13.2 斤，连买 6 日共约 80 斤：木材行库存要够（默认 10 万单位 ≈ 33 斤不够）。
  const state = withWoodCompany(voucherState(), 1000000);
  // 660 户每户一行修缮消耗流水，默认 ledgerLimit（500）会截掉尾部，这里放宽以便核对流水合计。
  const wide = { ...CONTENT, rules: { ...CONTENT.rules, ledgerLimit: 100000 } };
  grantResidentVouchers(state, 1000000, CONTENT);
  assert.equal(state.accounts.residents.wood, 0);
  const WOOD_DAY_UNITS = woodDayUnits(state);

  const result = buyRepairWoodForResidents(state, wide);

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
    const daily = buyRepairWoodForResidents(state, wide);
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
  const WOOD_DAY_UNITS = woodDayUnits(state);

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
