import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { exportState, importState } from "../src/persistence/storage.js";
import {
  householdList, householdIdleWorkers, householdWorkingAge, isActiveHousehold,
  setHouseholdJobCount, releaseExcessHouseholdEmployment, syncResidentAggregates
} from "../src/systems/households.js";
import { settleEscheat } from "../src/systems/redistribution.js";
import {
  prepareShopsForDay, settleShopTaxAndDistribution, transferShopOwnership, shopClerkCount
} from "../src/systems/shops.js";
import { ensureVillaState, selectVillaVacancies, settleVillaPurchases } from "../src/systems/villas.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;
const I = CONTENT.precision.inventoryUnitsPerJin;
const merchantKey = shopId => `shop:${shopId}:merchant`;
const clerkKey = shopId => `shop:${shopId}:clerk`;

function valid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

function addBuilding(state, id, typeId) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => !row.feature && !used.has(row.id));
  assert.ok(plot, "需要空地");
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return id;
}

// 商业街、贸易中心、养殖基地、别墅群各一座（1 级）。
function town(seed) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "cs1", "commercial_street");
  addBuilding(state, "tc1", "trade_center");
  addBuilding(state, "lb1", "livestock_base");
  addBuilding(state, "vc1", "villa_complex");
  // 先启动粮券阶段（grantResidentVouchers 同时完成启动），再由镇库印钞，供店铺周转金转账。
  grantResidentVouchers(state, 1000);
  issueTownVouchers(state, 200000 * V, CONTENT, "测试：镇库周转");
  return state;
}

// 有劳动力、还有空闲的家庭（按编号顺序取前 count 户，排除已选的）。
function idleHouseholds(state, count, exclude = []) {
  const rows = householdList(state).filter(household => isActiveHousehold(household)
    && householdWorkingAge(household) > 0 && householdIdleWorkers(household) > 0 && !exclude.includes(household.id));
  assert.ok(rows.length >= count, "测试需要足够的有劳动力家庭");
  return rows.slice(0, count);
}

function openShop(state, buildingId, typeId, owner, funds = 2000) {
  grantResidentVouchers(state, funds, CONTENT, owner.id);
  const opened = simulation.openResidentShop(state, buildingId, typeId, owner.id);
  assert.equal(opened.ok, true, opened.reason);
  return state.shops[opened.shopId];
}

// 整户去世：人口同步从年龄段 cohort 扣除（validateState 要求家庭与 cohort 一致），职务按年终结算的办法释放。
const BAND_OF_AGE = {
  children: age => age < 18,
  workers: age => age >= 18 && age < 65,
  elders: age => age >= 65
};
function kill(state, household) {
  for (const band of Object.keys(BAND_OF_AGE)) {
    let left = household.ageBands?.[band] || 0;
    for (const cohort of state.cohorts) {
      if (left <= 0) break;
      if (!BAND_OF_AGE[band](cohort.age)) continue;
      const take = Math.min(left, cohort.m + cohort.f);
      const fromF = Math.min(cohort.f, take);
      cohort.f -= fromF;
      cohort.m -= take - fromF;
      left -= take;
      cohort.marriedF = Math.min(cohort.marriedF, cohort.f);
      cohort.marriedM = Math.min(cohort.marriedM, cohort.m);
    }
    assert.equal(left, 0, "cohort 人口足够扣除");
  }
  household.ageBands = { children: 0, workers: 0, elders: 0 };
  releaseExcessHouseholdEmployment(state);
}

function hasEvent(state, text) {
  return state.events.some(event => String(event.text).includes(text));
}

function memoryStorage() {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    key: index => [...store.keys()][index] ?? null,
    get length() { return store.size; }
  };
}

test("别墅：整户失效后别墅回到空置，欠税免除，日结别墅销售再卖出", () => {
  const state = town(7101);
  const [owner, buyer] = idleHouseholds(state, 2);
  const villas = ensureVillaState(state);
  villas.sold.push({ householdId: owner.id, instanceId: "vc1", villaIndex: 0, priceValueUnits: 1000 * V, priceWheatJin: 1000, year: 1, day: 1 });
  owner.villaAssets = [{ instanceId: "vc1", villaIndex: 0, priceValueUnits: 1000 * V, priceWheatJin: 1000 }];
  villas.taxArrearsValueUnits[owner.id] = 50 * V;
  const isVacant = () => selectVillaVacancies(state, CONTENT).some(row => row.instanceId === "vc1" && row.villaIndex === 0);
  assert.equal(isVacant(), false, "售出的别墅不是空置");

  kill(state, owner);
  const result = settleEscheat(state, CONTENT);
  assert.ok(result, "别墅也算需要归公的家产");
  assert.equal(villas.sold.some(row => row.householdId === owner.id), false, "售出记录已撤销");
  assert.equal(owner.villaAssets.length, 0);
  assert.equal(villas.taxArrearsValueUnits[owner.id], undefined, "死户欠税免除");
  assert.equal(isVacant(), true, "别墅重新空置");
  assert.equal(state.redistribution.year.escheatVillas, 1);
  assert.ok(hasEvent(state, "别墅1栋空置待售"));
  valid(state, "别墅归公后");

  // 再卖：给一户足够的钱（其余家户的家底远低于它），别墅价压到 100 券。
  simulation.setVillaPolicy(state, { priceWheatJin: 100 });
  grantResidentVouchers(state, 100000, CONTENT, buyer.id);
  const sale = settleVillaPurchases(state, CONTENT);
  assert.ok(sale.sold >= 1, "空置别墅可以再卖");
  const resold = villas.sold.find(row => row.instanceId === "vc1" && row.villaIndex === 0);
  assert.ok(resold, "vc1 第 1 栋被再次售出");
  assert.equal(resold.householdId, buyer.id);
  assert.equal(isVacant(), false);
  valid(state, "别墅再卖后");
});

test("商店：业主失效，商人接手；现金、库存、员工原样保留，继续营业，利润改付给新业主", () => {
  const state = town(7102);
  const [owner, merchant, clerk] = idleHouseholds(state, 3);
  const shop = openShop(state, "cs1", "general", owner);
  const id = shop.id;
  assert.equal(setHouseholdJobCount(state, merchant.id, merchantKey(id), 1, CONTENT).ok, true);
  assert.equal(setHouseholdJobCount(state, clerk.id, clerkKey(id), 1, CONTENT).ok, true);
  transferVouchers(state, "town", `shop:${id}`, 50000 * V, CONTENT, "test", "测试：店铺周转金");
  shop.inventory.flour = 50 * I;
  assert.ok(shop.cashVoucherUnits >= 50000 * V, "店铺周转金到账");
  const before = { cash: shop.cashVoucherUnits, flour: shop.inventory.flour, clerks: shopClerkCount(state, shop) };
  const deadName = owner.name;

  kill(state, owner);
  settleEscheat(state, CONTENT);

  assert.equal(shop.ownerHouseholdId, merchant.id, "商人接手");
  assert.equal(shop.status, "open", "店铺没有关门");
  assert.equal(shop.cashVoucherUnits, before.cash, "现金原样");
  assert.equal(shop.inventory.flour, before.flour, "库存原样");
  assert.equal(shopClerkCount(state, shop), before.clerks, "店员原样");
  assert.equal(merchant.jobs[merchantKey(id)], 1, "新业主在本店任商人");
  assert.equal(clerk.jobs[clerkKey(id)], 1, "店员不受影响");
  assert.equal((owner.shopIds || []).includes(id), false);
  assert.ok((merchant.shopIds || []).includes(id));
  assert.ok(hasEvent(state, `${deadName}无人继承，其开的综合商店由${merchant.name}（原商人）接手。`), "记下事件");

  // 利润分配：按 ownerHouseholdId 付给新业主（死户不得钱）。
  const deadBefore = owner.voucherUnits;
  const merchantBefore = merchant.voucherUnits;
  shop.settlement.profitVoucherUnits = 200 * V;
  shop.retainedEarningsVoucherUnits = 200 * V;
  const settled = settleShopTaxAndDistribution(state, shop, CONTENT, true);
  assert.ok(settled.distributedVoucherUnits > 0, "有利润可分");
  assert.ok(merchant.voucherUnits > merchantBefore, "利润付给新业主");
  assert.equal(owner.voucherUnits, deadBefore, "死户不再收钱");
  valid(state, "商人接手后");
});

test("商店：没有商人时由店员接手（岗位多者优先），店员少一人", () => {
  const state = town(7103);
  const [owner, clerkA, clerkB] = idleHouseholds(state, 3);
  const shop = openShop(state, "cs1", "general", owner);
  const id = shop.id;
  setHouseholdJobCount(state, clerkA.id, clerkKey(id), 1, CONTENT);
  setHouseholdJobCount(state, clerkB.id, clerkKey(id), 1, CONTENT);
  const clerksBefore = shopClerkCount(state, shop);
  assert.equal(clerksBefore, 2);

  kill(state, owner);
  settleEscheat(state, CONTENT);

  assert.equal(shop.status, "open");
  assert.equal(shop.ownerHouseholdId, clerkA.id, "岗位相同时取余额多者，余额相同取编号小者");
  assert.equal(clerkA.jobs[clerkKey(id)] || 0, 0, "接手的店员离开店员岗位");
  assert.equal(clerkA.jobs[merchantKey(id)], 1, "接手后在本店任商人");
  assert.equal(shopClerkCount(state, shop), clerksBefore - 1, "另一位店员留任");
  assert.equal(clerkB.jobs[clerkKey(id)], 1);
  assert.ok(hasEvent(state, "由" + clerkA.name + "（原店员）接手"));
  valid(state, "店员接手后");
});

test("商店：无商人无店员时由家底最厚的一户接手，且不接手已在同类宿主开店的人", () => {
  const state = town(7104);
  const [owner, richest, second] = idleHouseholds(state, 3);
  const shop = openShop(state, "cs1", "general", owner);
  const otherShop = openShop(state, "cs1", "general", richest);
  assert.equal(otherShop.ownerHouseholdId, richest.id);
  // 最富的一户已在商业街开店：不能再接手；次富的一户接手。
  grantResidentVouchers(state, 1000000, CONTENT, richest.id);
  grantResidentVouchers(state, 500000, CONTENT, second.id);

  kill(state, owner);
  settleEscheat(state, CONTENT);

  assert.equal(shop.ownerHouseholdId, second.id, "跳过已在商业街开店的最富一户");
  assert.equal(shop.status, "open");
  assert.equal(second.jobs[merchantKey(shop.id)], 1);
  assert.ok(hasEvent(state, "（家底最厚的一户）接手"));
  assert.equal(otherShop.ownerHouseholdId, richest.id, "别人的店不受影响");
  valid(state, "家底接手后");
});

test("贸易行与养殖场同样交接给商人", () => {
  const state = town(7105);
  const [tradeOwner, tradeMerchant, farmOwner, farmMerchant] = idleHouseholds(state, 4);
  const trade = openShop(state, "tc1", "trading_house", tradeOwner);
  const farm = openShop(state, "lb1", "chicken_farm", farmOwner);
  setHouseholdJobCount(state, tradeMerchant.id, merchantKey(trade.id), 1, CONTENT);
  setHouseholdJobCount(state, farmMerchant.id, merchantKey(farm.id), 1, CONTENT);

  kill(state, tradeOwner);
  kill(state, farmOwner);
  settleEscheat(state, CONTENT);

  assert.equal(trade.ownerHouseholdId, tradeMerchant.id);
  assert.equal(trade.status, "open");
  assert.equal(farm.ownerHouseholdId, farmMerchant.id);
  assert.equal(farm.status, "open");
  valid(state, "贸易行与养殖场交接后");
});

test("无人可接手：店铺保持暂停并记一次事件，之后每日不重复记", () => {
  const state = town(7106);
  const [owner] = idleHouseholds(state, 1);
  const shop = openShop(state, "cs1", "general", owner);
  // 其余家户全部失效且名下没有家产：镇上没有可以接手的人，只有业主这一户需要归公（事件不被其他户挤掉）。
  for (const household of householdList(state)) {
    if (household.id === owner.id) continue;
    kill(state, household);
    if (household.voucherUnits > 0) transferVouchers(state, `household:${household.id}`, "town", household.voucherUnits, CONTENT, "test", "测试：他户资金清空");
    household.inventory = Object.fromEntries(Object.keys(household.inventory).map(itemId => [itemId, 0]));
    syncResidentAggregates(state, CONTENT);
  }
  kill(state, owner);
  settleEscheat(state, CONTENT);
  assert.equal(shop.ownerHouseholdId, owner.id, "没有接手人，业主不变");
  assert.equal(shop.status, "paused");
  assert.ok(hasEvent(state, `${owner.name}无人继承，其开的综合商店无人接手，店铺暂停。`));
  const count = () => state.events.filter(event => String(event.text).includes("无人接手")).length;
  const once = count();
  prepareShopsForDay(state, CONTENT);
  settleEscheat(state, CONTENT);
  assert.equal(count(), once, "不重复记事件");
  assert.equal(shop.status, "paused");
  valid(state, "无人接手");
});

test("旧档里已暂停的孤儿店：日结店铺步骤里自动交接并恢复营业", () => {
  const state = town(7107);
  const [owner, merchant] = idleHouseholds(state, 2);
  const shop = openShop(state, "cs1", "general", owner);
  setHouseholdJobCount(state, merchant.id, merchantKey(shop.id), 1, CONTENT);
  // 模拟旧档：业主已失效、店铺已暂停，但没有经过年终归公。
  kill(state, owner);
  shop.status = "paused";
  shop.statusReason = "商人缺位，店员已遣散";
  prepareShopsForDay(state, CONTENT);
  assert.equal(shop.ownerHouseholdId, merchant.id);
  assert.equal(shop.status, "open");
  assert.ok(hasEvent(state, `${owner.name}无人继承，其开的综合商店由${merchant.name}（原商人）接手。`));
  valid(state, "孤儿店恢复后");
});

test("直接交接：新业主有空闲劳动力即可上岗；存档往返后业主与别墅记录不变", () => {
  const state = town(7108);
  const [owner, heir] = idleHouseholds(state, 2);
  const shop = openShop(state, "cs1", "general", owner);
  const result = transferShopOwnership(state, shop.id, heir.id, CONTENT);
  assert.equal(result.ok, true, result.reason);
  assert.equal(shop.ownerHouseholdId, heir.id);
  assert.equal(heir.jobs[merchantKey(shop.id)], 1);
  assert.equal(owner.jobs[merchantKey(shop.id)] || 0, 0, "原业主不再在本店任商人");
  valid(state, "直接交接后");

  const villas = ensureVillaState(state);
  villas.sold.push({ householdId: heir.id, instanceId: "vc1", villaIndex: 3, priceValueUnits: 10 * V, priceWheatJin: 10, year: 1, day: 1 });
  const storage = memoryStorage();
  const imported = importState(storage, exportState(state), CONTENT);
  assert.equal(imported.shops[shop.id].ownerHouseholdId, heir.id);
  assert.equal(imported.shops[shop.id].status, "open");
  assert.deepEqual(imported.villas.sold, state.villas.sold);
  assert.deepEqual(imported.redistribution.year, state.redistribution.year);
  valid(imported, "存档往返后");
});
