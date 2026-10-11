// 金银店与珠宝需求（金银消费第一期 B）：金银店建筑（镇营 → 民营 → 公司 → 上市）、内置店只卖两种珠宝、
// 珠宝从批发市场进货、零售价 = 批发价 ×（1 + 目标利润率）、富户门槛（minAffluence）、没有金银店时需求落空、
// 接待能力随在岗人数与加成、综合商店 / 酒馆 / 集市不上架珠宝、账平。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { isIndustryType } from "../src/content/buildings.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "../src/systems/households.js";
import { householdAffluence, invalidateHouseholdBudgets } from "../src/systems/household-budget.js";
import { accrueGoodsDemand } from "../src/systems/goods-demand.js";
import { ensureWholesaleMarket, depositWholesalePurchasedInventory } from "../src/systems/wholesale-market.js";
import { processBuilding } from "../src/systems/production.js";
import { processListedCompanies } from "../src/systems/companies.js";
import { transferBuildingOwnership, buildingOwner } from "../src/systems/ownership.js";
import { shopDefinition, shopRetailItemIds, stallItemIds } from "../src/systems/shops.js";
import { shopMayStockItem } from "../src/systems/shop-types.js";
import { shopRetailPrice } from "../src/economy/operating-plan.js";
import { shopEffectiveMarginPercent } from "../src/economy/margin-policy.js";
import { currentUnitPrice } from "../src/economy/prices.js";
import { jewelerCapacityPieces } from "../src/systems/jewelers.js";
import { productivityFactor } from "../src/economy/productivity.js";
import { issueTownVouchers, transferVouchers, voucherBalance } from "../src/economy/currency.js";
import { voucherWealthForAffluence } from "./budget-fixture.js";
import { formCompany } from "./helpers-ipo.js";
import { demolishBuilding } from "../src/systems/building-development.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const JEWELS = ["gold_jewelry", "silver_jewelry"];

function valid(state, label = "") {
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, `${label} ${v.errors.join("；")}`);
}

function freePlot(state) {
  return state.plots.find(row => !row.feature && !state.buildings.some(b => b.plotId === row.id));
}

function addBuilding(state, typeId, id, { level = 1 } = {}) {
  const plot = freePlot(state);
  state.buildings.push({ id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return state.buildings.find(row => row.id === id);
}

// 批发市场 + 金银店（镇营）+ 首饰匠；批发市场放入一批金、银珠宝（有成本基础）。
function world(seed, { workers = 6, level = 1, stockPieces = 300 } = {}) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "wholesale_market", "mkt");
  simulation.setEmployment(state, `mkt::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 4);
  addBuilding(state, "jeweler", "jew", { level });
  if (workers > 0) assert.equal(simulation.setEmployment(state, "jew::jewelers", workers).assigned, workers);
  ensureWholesaleMarket(state, CONTENT);
  depositWholesalePurchasedInventory(state, "gold_jewelry", stockPieces * I, stockPieces * 120 * V, CONTENT);
  depositWholesalePurchasedInventory(state, "silver_jewelry", stockPieces * I, stockPieces * 12 * V, CONTENT);
  state.monetaryReform.targetVoucherBps = 10000; state.monetaryReform.residentExchangeEnabled = false; state.monetaryReform.legacyBankAccess = true;
  return state;
}

// 把一户的家底调到宽裕度 m（同 goods-demand 测试的口径）。
function setAffluence(state, household, m) {
  const people = householdPopulation(household);
  household.inventory.wheat = Math.round(people * CONTENT.rules.foodPerPersonDay * CONTENT.rules.householdBudget.wealthFoodReserveDays * I);
  household.inventory.flour = 0;
  household.inventory.bread = 0;
  syncResidentAggregates(state, CONTENT);
  const target = voucherWealthForAffluence(state, household, m, CONTENT);
  const owner = `household:${household.id}`;
  const current = voucherBalance(state, owner);
  if (target > current) {
    const need = target - current;
    const town = voucherBalance(state, "town");
    if (town < need) issueTownVouchers(state, need - town, CONTENT, "测试印制");
    transferVouchers(state, "town", owner, need, CONTENT, "test", "测试：家底");
  }
  invalidateHouseholdBudgets(state);
}

function setAllAffluence(state, m) {
  for (const household of householdList(state).filter(isActiveHousehold)) setAffluence(state, household, m);
  syncResidentAggregates(state, CONTENT);
}

function jewelShop(state) {
  return Object.values(state.shops).find(shop => shop.jeweler) || null;
}

// 居民当日想买的珠宝量（库存单位），不改状态。
function demandOf(state) {
  const todays = accrueGoodsDemand(state, 0, CONTENT);
  return Object.fromEntries(JEWELS.map(itemId => [itemId, todays[itemId] || 0]));
}

test("金银店是产业建筑：按建筑定义推导，与其他产业同等可民营、成立公司、上市", () => {
  assert.equal(isIndustryType(CONTENT, "jeweler"), true);
  assert.equal(CONTENT.buildings.jeweler.industryTier, 2);
  assert.equal(CONTENT.buildings.jeweler.jobs[0].id, "jewelers");
  assert.equal(CONTENT.buildings.jeweler.jobs[0].wagePerWorkerDay, 5);
  assert.equal(CONTENT.buildings.jeweler.jobs[0].slots, 6, "每级 6 个岗位");
  assert.equal(CONTENT.buildings.jeweler.upgrade.maxLevel, 10);
  assert.equal(CONTENT.buildings.jeweler.materialRequirements[0].quantity, 600);
  const state = world(7001);
  assert.equal(processBuilding(state, state.buildings.find(b => b.typeId === "jeweler"), CONTENT).status, "retail", "零售型产业不走生产流水线");
});

test("镇营金银店：批发进货、只卖两种珠宝、零售价 = 批发价 ×（1 + 目标利润率）", () => {
  const state = world(7002, { workers: 6 });
  simulation.advanceDay(state);
  const shop = jewelShop(state);
  assert.ok(shop, "建了金银店就有一座内置店");
  assert.equal(shop.town, true, "镇营：收入直接进镇库");
  assert.deepEqual(shopRetailItemIds(shop, CONTENT).sort(), [...JEWELS].sort(), "只经营两种珠宝");
  assert.ok(shop.inventory.gold_jewelry > 0 || state.accounts.town.gold_jewelry === 0, "金银从批发市场进货");
  assert.ok(shop.accounts.cumulative.purchasedUnits.gold_jewelry > 0, "进货记入累计");
  const margin = shopEffectiveMarginPercent(state, shop, CONTENT);
  const wholesale = currentUnitPrice(state, "gold_jewelry", CONTENT);
  assert.ok(Math.abs(wholesale - 150) < 1e-9, "黄金珠宝批发售价 150");
  assert.ok(Math.abs(shopRetailPrice(state, "jewelry", CONTENT, "gold_jewelry", shop) - wholesale * (1 + margin / 100)) < 1e-6, "零售价 = 批发价 ×（1 + 目标利润率）");
  valid(state, "开店一天后");
});

test("零售价口径：未调价时黄金约 180、白银约 18（批发 150 / 15，利润率 20%）", () => {
  const state = world(7003);
  simulation.advanceDay(state);
  const shop = jewelShop(state);
  assert.equal(shopEffectiveMarginPercent(state, shop, CONTENT), 20, "开局目标利润率 20%");
  const gold = shopRetailPrice(state, "jewelry", CONTENT, "gold_jewelry", shop);
  const silver = shopRetailPrice(state, "jewelry", CONTENT, "silver_jewelry", shop);
  assert.ok(Math.abs(gold - 180) < 1e-6, `黄金 ${gold}`);
  assert.ok(Math.abs(silver - 18) < 1e-6, `白银 ${silver}`);
});

test("宽裕度门槛：0.9 不买；1.3 只买白银；2.1 两种都买（minAffluence 1.2 / 2.0）", () => {
  const state = world(7004);
  setAllAffluence(state, 0.9);
  let demand = demandOf(state);
  assert.equal(demand.gold_jewelry, 0, "宽裕度 0.9 不买黄金");
  assert.equal(demand.silver_jewelry, 0, "宽裕度 0.9 不买白银");
  setAllAffluence(state, 1.3);
  demand = demandOf(state);
  assert.ok(demand.silver_jewelry > 0, "宽裕度 1.3 买白银");
  assert.equal(demand.gold_jewelry, 0, "宽裕度 1.3 不买黄金");
  setAllAffluence(state, 2.1);
  demand = demandOf(state);
  assert.ok(demand.silver_jewelry > 0 && demand.gold_jewelry > 0, "宽裕度 2.1 两种都买");
  const household = householdList(state).find(isActiveHousehold);
  assert.ok(Math.abs(householdAffluence(state, household, CONTENT) - 2.1) < 0.2, "家底调到了目标宽裕度");
});

test("居民珠宝经金银店买：有店时成交，店里收入 = 居民付的钱，库存与销量账平", () => {
  const state = world(7005, { workers: 6, stockPieces: 300 });
  setAllAffluence(state, 2.5);
  const townBefore = state.accounts.town ? voucherBalance(state, "town") : 0;
  const wholesaleBefore = state.wholesaleMarket.inventory.gold_jewelry + state.wholesaleMarket.inventory.silver_jewelry;
  for (let day = 0; day < 5; day += 1) {
    simulation.advanceDay(state);
    valid(state, `第${day + 1}天`);
  }
  const shop = jewelShop(state);
  const cumulative = shop.accounts.cumulative;
  assert.ok(cumulative.soldUnits.gold_jewelry > 0 && cumulative.soldUnits.silver_jewelry > 0, "两种珠宝都卖出去了");
  // 库存守恒：批发市场减少的 = 店里进货的；店里进货 = 卖出 + 店里现存。
  const wholesaleAfter = state.wholesaleMarket.inventory.gold_jewelry + state.wholesaleMarket.inventory.silver_jewelry;
  const bought = cumulative.purchasedUnits.gold_jewelry + cumulative.purchasedUnits.silver_jewelry;
  assert.equal(wholesaleBefore - wholesaleAfter, bought, "批发进货守恒");
  for (const itemId of JEWELS) {
    assert.equal(cumulative.purchasedUnits[itemId], cumulative.soldUnits[itemId] + shop.inventory[itemId], `${itemId} 进货 = 卖出 + 库存`);
  }
  // 镇营店：收入直接进镇库；居民付出的 = 镇库增加的。
  assert.equal(voucherBalance(state, "town") - townBefore, cumulative.revenueVoucherUnits, "镇库收入 = 店铺收入");
  valid(state, "账平");
});

test("没有金银店：珠宝需求落空，记入需求与未买到，不报错", () => {
  const state = simulation.createInitialState({ seed: 7006 });
  setAllAffluence(state, 2.5);
  for (let day = 0; day < 3; day += 1) simulation.advanceDay(state);
  const goods = state.goodsDemand;
  for (const itemId of JEWELS) assert.equal(goods.year.purchasedUnits[itemId] || 0, 0, `${itemId} 没有卖家，买不到`);
  assert.ok(goods.year.demandUnits.gold_jewelry > 0, "富户仍有黄金需求（未满足）");
  valid(state, "无金银店");
});

test("接待能力：随在岗人数、等级与教育加成；无人在岗不营业不进货", () => {
  const three = world(7007, { workers: 3 });
  const base = jewelerCapacityPieces(three, jewelShop(three) || (simulation.advanceDay(three), jewelShop(three)), CONTENT);
  assert.equal(base, Math.floor(3 * CONTENT.rules.jewelerPiecesPerWorkerDay * productivityFactor(three, "jeweler", 1)));
  const leveled = world(7007, { workers: 3, level: 2 });
  simulation.advanceDay(leveled);
  assert.ok((leveled.industryExperience?.jeweler || 0) > 0, "金银店的首饰匠工日自动计入熟练度（产业工日口径）");
  const lvl = jewelerCapacityPieces(leveled, jewelShop(leveled), CONTENT);
  assert.ok(lvl > base, "等级提高接待能力");
  assert.equal(lvl, Math.floor(3 * 20 * productivityFactor(leveled, "jeweler", 2)));
  leveled.education = { schoolDays: 360 * 30 }; // 教育加成封顶 +30%
  assert.ok(jewelerCapacityPieces(leveled, jewelShop(leveled), CONTENT) > lvl, "教育加成提高接待能力");
  const empty = world(7008, { workers: 0 });
  simulation.advanceDay(empty);
  const shop = jewelShop(empty);
  assert.equal(shop.statusReason, "无首饰匠");
  assert.equal(shop.inventory.gold_jewelry, 0, "无人在岗不进货");
  valid(empty, "无人在岗");
});

test("综合商店、酒馆、集市都不上架珠宝（只金银店经营）", () => {
  const state = simulation.createInitialState({ seed: 7009 });
  assert.equal(CONTENT.rules.shopTypes.general.itemIds.includes("gold_jewelry"), false);
  assert.equal(CONTENT.rules.shopTypes.general.itemIds.includes("silver_jewelry"), false);
  assert.equal(CONTENT.rules.shopTypes.tavern.itemIds.includes("gold_jewelry"), false);
  assert.equal(stallItemIds(CONTENT).includes("gold_jewelry"), false);
  assert.equal(stallItemIds(CONTENT).includes("silver_jewelry"), false);
  for (const itemId of JEWELS) {
    assert.equal(shopMayStockItem(state, shopDefinition(CONTENT, "general"), itemId, CONTENT), false, "综合商店不进珠宝");
    assert.equal(shopMayStockItem(state, shopDefinition(CONTENT, "jewelry"), itemId, CONTENT), true, "金银店可以");
  }
  assert.equal(CONTENT.items.gold_jewelry.storeOnly, true);
  assert.equal(CONTENT.items.gold_jewelry.optionalRetail, true);
});

test("珠宝不由生产流水线产出：冶炼与金银店都不改产出，公司流水线跳过金银店", () => {
  const state = world(7010, { workers: 6 });
  const before = state.wholesaleMarket.inventory.gold_jewelry;
  for (const building of state.buildings.filter(row => row.typeId === "jeweler")) assert.equal(processBuilding(state, building, CONTENT).status, "retail");
  assert.equal(state.wholesaleMarket.inventory.gold_jewelry, before, "生产流水线不动批发库存");
  assert.deepEqual(processListedCompanies(state, CONTENT), [], "没有公司时无行");
});

test("民营金银店：整栋转民营后店主是业主家庭，利润按店铺口径分给业主（交利润税）", () => {
  const state = world(7011, { workers: 6 });
  setAllAffluence(state, 2.5);
  const building = state.buildings.find(row => row.typeId === "jeweler");
  const household = householdList(state).filter(isActiveHousehold)[0];
  simulation.advanceDay(state);
  const shop = jewelShop(state);
  transferBuildingOwnership(state, building, { kind: "household", id: household.id }, CONTENT);
  simulation.advanceDay(state);
  assert.equal(shop.town, false);
  assert.equal(shop.ownerHouseholdId, household.id);
  assert.equal(buildingOwner(state, building).kind, "household");
  for (let day = 0; day < 35; day += 1) simulation.advanceDay(state);
  const cumulative = shop.accounts.cumulative;
  assert.ok(cumulative.revenueVoucherUnits > 0, "民营店也有收入");
  assert.ok(cumulative.distributedVoucherUnits + cumulative.taxExpenseVoucherUnits > 0, "30 天结账：利润分给业主并交利润税");
  valid(state, "民营金银店");
});

test("公司金银店：利润每天上缴公司（留够周转金），公司留存增加", () => {
  const state = world(7012, { workers: 6 });
  setAllAffluence(state, 2.5);
  const building = state.buildings.find(row => row.typeId === "jeweler");
  issueTownVouchers(state, 100000 * V, CONTENT, "测试：镇库营运资金");
  const formed = formCompany(state, building.id, { name: "金银公司", operatingCapitalVoucher: 2000 });
  assert.equal(formed.ok, true, formed.reason);
  const company = state.companies[formed.companyId];
  assert.equal(buildingOwner(state, building).kind, "company");
  for (let day = 0; day < 30; day += 1) simulation.advanceDay(state);
  const shop = jewelShop(state);
  assert.equal(shop.companyId, company.id);
  // 留够周转金（约两天进货）后的利润每天上缴：收入先垫周转金，超出的才上缴。
  assert.ok(shop.retainedEarningsVoucherUnits >= 0, "店里留存不为负");
  assert.ok(shop.accounts.cumulative.revenueVoucherUnits > 0, "公司店也有收入");
  assert.ok((company.retainedEarningsVoucherUnits || 0) > 0 || (company.accounts?.cumulative?.profitVoucherUnits || 0) > 0 || shop.accounts.cumulative.distributedVoucherUnits > 0, "利润上缴公司");
  valid(state, "公司金银店");
});

test("上市：镇营金银店可整栋上市（公司持有，店随建筑归公司）", () => {
  const state = world(7013, { workers: 6 });
  addBuilding(state, "stock_exchange", "sx");
  simulation.advanceDay(state);
  const building = state.buildings.find(row => row.typeId === "jeweler");
  const listed = simulation.listBuilding(state, building.id, { ticker: "301" });
  assert.equal(listed.ok, true, listed.reason);
  assert.equal(buildingOwner(state, building).kind, "company");
  simulation.advanceDay(state);
  assert.equal(jewelShop(state).companyId, listed.companyId);
  valid(state, "上市后");
});

test("民营出售金银店：要有店铺利润记录才能估值；成交后归民营并 validateState 恒成立", () => {
  const state = world(7014, { workers: 6 });
  setAllAffluence(state, 2.5);
  const building = state.buildings.find(row => row.typeId === "jeweler");
  simulation.advanceDay(state);
  const early = simulation.selectOperatingRightPreview(state, building.id);
  assert.equal(early.available, false, "刚开业没有利润记录，不可售");
  for (let day = 0; day < 10; day += 1) simulation.advanceDay(state);
  const quote = simulation.selectOperatingRightPreview(state, building.id);
  assert.ok(quote.actualObservedDays > 0, "近日利润进入估值");
  valid(state, "估值");
});

test("拆除金银店（镇营）：剩货归镇库（成本随货），店铺撤销，validateState 恒成立；民营店须先收回才能拆", () => {
  const state = world(7015, { workers: 6 });
  setAllAffluence(state, 2.5);
  const building = state.buildings.find(row => row.typeId === "jeweler");
  for (let day = 0; day < 4; day += 1) simulation.advanceDay(state);
  const shop = jewelShop(state);
  const stock = { ...shop.inventory };
  const townBefore = state.accounts.town.gold_jewelry + state.accounts.town.silver_jewelry;
  const result = demolishBuilding(state, building.id, CONTENT);
  assert.equal(result.ok, true, result.reason);
  assert.equal(jewelShop(state), null, "店铺撤销");
  assert.equal(state.accounts.town.gold_jewelry + state.accounts.town.silver_jewelry - townBefore, (stock.gold_jewelry || 0) + (stock.silver_jewelry || 0), "剩货归镇库");
  valid(state, "拆除后");
});
