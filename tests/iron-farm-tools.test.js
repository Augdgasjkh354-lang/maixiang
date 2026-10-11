// 铁制农具（金银消费第二期 A）：耐用品通用机制（目标持有、每日折旧、采购只经综合商店、预算上限、没有商店时落空）、
// 覆盖率与亩产公式（0 / 0.5 / 1 对应 600 / 700 / 800）、秋收收成、旧档与等价性（没有农具时逐位一致）。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { householdList, isActiveHousehold, syncResidentAggregates } from "../src/systems/households.js";
import { harvest } from "../src/systems/agriculture.js";
import { wearDurableGoods, buyDurableGoodsForHouseholds, emptyDurablePeriod } from "../src/systems/durable-goods.js";
import { invalidateHouseholdBudgets, householdBudgets } from "../src/systems/household-budget.js";
import { selectDurableCoverage, durableTargetPieces } from "../src/selectors/durable-goods.js";
import { farmYieldPerAcre } from "../src/selectors/farmland.js";
import { ensureWholesaleMarket, depositWholesalePurchasedInventory } from "../src/systems/wholesale-market.js";
import { stallItemIds } from "../src/systems/shops.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const TOOL = "iron_farm_tool";
const DAYS = CONTENT.rules.daysPerYear;

function valid(state, label = "") {
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, `${label} ${v.errors.join("；")}`);
}

function farmers(state) {
  return householdList(state).filter(isActiveHousehold).filter(h => (h.jobs?.farmers || 0) > 0);
}

// 每户农具库存设为目标的 fraction 比例（件数 = 目标 × fraction，库存单位取整）。
function holdFraction(state, fraction) {
  for (const household of farmers(state)) {
    const target = durableTargetPieces(household, CONTENT.rules.durableGoods[TOOL]);
    household.inventory[TOOL] = Math.round(target * fraction * I);
  }
  syncResidentAggregates(state, CONTENT);
}

// 综合商店（商业街）+ 批发市场：商店进货需要批发市场里有货。
function storeWorld(seed) {
  const state = simulation.createInitialState({ seed });
  const used = new Set(state.buildings.map(b => b.plotId));
  const add = (typeId, id, level = 1) => {
    const def = CONTENT.buildings[typeId];
    const plot = state.plots.find(p => (!def.requiredPlotFeature || p.feature === def.requiredPlotFeature) && !used.has(p.id) && !p.feature);
    used.add(plot.id);
    state.buildings.push({ id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
    return id;
  };
  const market = add("wholesale_market", "mkt");
  simulation.setEmployment(state, `${market}::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  const street = add("commercial_street", "street", 2);
  const opened = simulation.openResidentShop(state, street, "general");
  assert.equal(opened.ok, true, opened.reason);
  simulation.configureShopClerks(state, opened.shopId, 10);
  ensureWholesaleMarket(state, CONTENT);
  return { state, shopId: opened.shopId };
}

// ---------------------------------------------------------------- 配置与商品清单

test("耐用品配置：铁制农具按农民目标持有 1 件/人、寿命 5 年；只经综合商店上架", () => {
  const cfg = CONTENT.rules.durableGoods[TOOL];
  assert.equal(cfg.holderJobId, "farmers");
  assert.equal(cfg.perFarmer, 1);
  assert.equal(cfg.lifeYears, 5);
  assert.equal(CONTENT.rules.durableSpendCapShare, 0.5);
  const item = CONTENT.items[TOOL];
  assert.equal(item.storeOnly, true);
  assert.equal(item.retail, true);
  assert.equal(item.optionalRetail, true);
  assert.equal(item.retailShopTypeIds, undefined, "综合商店货架不限店型");
  assert.equal(stallItemIds(CONTENT).includes(TOOL), false, "集市不卖农具");
  assert.equal(CONTENT.rules.shopTypes.tavern.itemIds.includes(TOOL), false, "酒馆不卖农具");
  assert.equal(CONTENT.rules.shopTypes.general.itemIds.includes(TOOL), true, "综合商店的货架包含农具");
  assert.equal(CONTENT.rules.shopTypes.jewelry.itemIds.includes(TOOL), false, "金银店不卖农具");
});

// ---------------------------------------------------------------- 覆盖率与亩产

test("覆盖率与亩产：无农具 600 斤 / 亩；半数 700；全员 800（封顶）", () => {
  const state = simulation.createInitialState({ seed: 8101 });
  holdFraction(state, 0);
  assert.equal(selectDurableCoverage(state, CONTENT, TOOL).coverage, 0);
  assert.equal(farmYieldPerAcre(state, CONTENT), 600);

  holdFraction(state, 0.5);
  const half = selectDurableCoverage(state, CONTENT, TOOL);
  assert.ok(Math.abs(half.coverage - 0.5) < 1e-3, `覆盖率 ${half.coverage}`);
  assert.ok(Math.abs(farmYieldPerAcre(state, CONTENT) - 700) < 0.5, "亩产 700");

  holdFraction(state, 1);
  assert.equal(selectDurableCoverage(state, CONTENT, TOOL).coverage, 1);
  assert.equal(farmYieldPerAcre(state, CONTENT), 800);

  // 超配的农具不计入覆盖率（封顶 1），亩产仍是 800。
  holdFraction(state, 2);
  assert.equal(selectDurableCoverage(state, CONTENT, TOOL).coverage, 1);
  assert.equal(farmYieldPerAcre(state, CONTENT), 800);
  valid(state, "覆盖率");
});

test("秋收收成：全员有农具时收成为无农具的 800/600 倍；无农具时与基础产量逐位一致", () => {
  const harvestAt = fraction => {
    const state = simulation.createInitialState({ seed: 8102 });
    holdFraction(state, fraction);
    const acres = state.agriculture.reclaimedAcres;
    const capacity = Math.floor(acres / CONTENT.agriculture.acresPerFarmer);
    state.agriculture.workUnits = capacity * CONTENT.rules.growingDays; // 满员出工，出工比例 1
    state.agriculture.lastHarvestYear = 0;
    state.education = { schoolDays: 0 };
    const result = harvest(state, CONTENT);
    return { total: result.total, acres, state };
  };
  const none = harvestAt(0);
  const full = harvestAt(1);
  assert.equal(none.total, none.acres * 600, "无农具：亩数 × 600 斤（harvest 结果单位为斤）");
  assert.ok(Math.abs(full.total / none.total - 800 / 600) < 1e-9, `全员农具 ÷ 无农具 = ${full.total / none.total}`);
  valid(none.state, "无农具秋收");
  valid(full.state, "全员农具秋收");
});

// ---------------------------------------------------------------- 折旧

test("每日折旧：每件每日损耗 1/(寿命×一年天数)，按户汇总；一年后约剩 (1−1/1800)^360", () => {
  const state = simulation.createInitialState({ seed: 8103 });
  const household = farmers(state)[0];
  for (const h of householdList(state)) if (h.id !== household.id) h.inventory[TOOL] = 0;
  household.inventory[TOOL] = 10 * I;
  syncResidentAggregates(state, CONTENT);
  const before = household.inventory[TOOL];
  const once = wearDurableGoods(state, CONTENT);
  assert.ok(once[TOOL].wornUnits >= 0);
  // 一天损耗约 1/1800 件 = 10 × 3000 / 1800 ≈ 16.7 个库存单位。
  const worn = before - household.inventory[TOOL];
  assert.ok(worn >= 16 && worn <= 17, `一日损耗 ${worn} 单位`);
  for (let d = 1; d < DAYS; d += 1) wearDurableGoods(state, CONTENT);
  const remain = household.inventory[TOOL] / before;
  const expected = Math.pow(1 - 1 / (5 * DAYS), DAYS);
  assert.ok(Math.abs(remain - expected) < 0.01, `一年后剩 ${remain.toFixed(4)}，应约 ${expected.toFixed(4)}`);
  valid(state, "折旧");
});

test("折旧只遍历持有农具的户：没人持有时不写账、不改库存", () => {
  const state = simulation.createInitialState({ seed: 8104 });
  for (const h of householdList(state)) h.inventory[TOOL] = 0;
  syncResidentAggregates(state, CONTENT);
  wearDurableGoods(state, CONTENT);
  assert.equal(state.durableGoods.day.wornUnits?.[TOOL] || 0, 0);
});

// ---------------------------------------------------------------- 采购

test("采购只经综合商店：没有综合商店时，即使镇库有农具也买不到，需求记为未满足", () => {
  const state = simulation.createInitialState({ seed: 8105 });
  ensureWholesaleMarket(state, CONTENT);
  depositWholesalePurchasedInventory(state, TOOL, 5000 * I, 5000 * 120 * V, CONTENT);
  state.accounts.town[TOOL] = 500 * I;
  for (const h of householdList(state)) h.inventory[TOOL] = 0;
  syncResidentAggregates(state, CONTENT);
  const result = buyDurableGoodsForHouseholds(state, CONTENT);
  assert.equal(result[TOOL].purchasedUnits, 0, "没有商店不卖");
  assert.ok(result[TOOL].unmetUnits > 0, "需求落空");
  assert.ok(state.durableGoods.day.unmetUnits[TOOL] > 0);
  assert.equal(state.accounts.town[TOOL], 500 * I, "镇库农具没动");
  valid(state, "无商店");
});

test("采购：综合商店有货时农民家庭补齐，付款进店铺，每户当日买入不超过可花预算的一半", () => {
  const { state, shopId } = storeWorld(8106);
  depositWholesalePurchasedInventory(state, TOOL, 3000 * I, 3000 * 120 * V, CONTENT);
  // 店里先有货（进货口径另有测试覆盖）：农具只从店里卖。
  const shop = state.shops[shopId];
  shop.inventory = shop.inventory || {};
  shop.inventory[TOOL] = 300 * I;
  invalidateHouseholdBudgets(state);
  const budgets = householdBudgets(state, CONTENT);
  const before = new Map(farmers(state).map(h => [h.id, h.inventory[TOOL] || 0]));
  const result = buyDurableGoodsForHouseholds(state, CONTENT);
  assert.ok(result[TOOL].purchasedUnits > 0, "有货就能买到");
  assert.ok(shop.inventory[TOOL] < 300 * I, "货从店里卖出");
  for (const h of farmers(state)) {
    const gained = (h.inventory[TOOL] || 0) - (before.get(h.id) || 0);
    const cap = (budgets.get(h.id)?.dailySpendUnits || 0) * CONTENT.rules.durableSpendCapShare;
    const price = state.wholesaleMarket.pricesVoucherPerUnit?.[TOOL] || CONTENT.rules.marketPricesVoucherPerUnit[TOOL];
    const maxUnits = Math.floor(cap * I / (price * V)) + 1;
    assert.ok(gained <= maxUnits, `户 ${h.id} 买入 ${gained} 单位，上限约 ${maxUnits}`);
  }
  valid(state, "综合商店采购");
});

// ---------------------------------------------------------------- 等价性、旧档与账平

test("等价性：不持农具的世界，秋收后的经济字段与改前一致（哈希见 CHANGELOG 与探针）", () => {
  const state = simulation.createInitialState({ seed: 917309, opening: "standard" });
  for (let i = 0; i < 300; i += 1) simulation.advanceDay(state);
  // 没有农具与工具：覆盖率恒为 0，亩产恒为 600，秋收收成 = 亩数 × 600 × 出工比例 × 教育加成（这里教育为 1）。
  assert.equal(farmYieldPerAcre(state, CONTENT), 600);
  assert.equal(selectDurableCoverage(state, CONTENT, TOOL).heldPieces, 0);
  assert.equal(state.agriculture.lastHarvestYear, 1, "第一年秋收已结算");
  // 改前（HEAD）同一开局第一年秋收总量为 18,000,000 斤（3 万亩 × 600）；满员出工，教育加成为 1。
  const total = state.agriculture.taxHistory.at(-1).totalUnits / I;
  assert.equal(total, 18000000, "秋收总量与改前一致");
  valid(state, "等价性");
});

test("旧档：没有耐用品字段（durableGoods、家户磨损余数）时照常推进，validateState 通过", () => {
  const state = simulation.createInitialState({ seed: 8107 });
  delete state.durableGoods;
  for (const h of householdList(state)) delete h.durableWearCarry;
  for (let i = 0; i < 3; i += 1) simulation.advanceDay(state);
  valid(state, "旧档推进");
  assert.ok(state.durableGoods, "新字段由系统补齐");
  assert.deepEqual(Object.keys(emptyDurablePeriod()).sort(), ["demandUnits", "paidVoucherUnits", "purchasedUnits", "unmetUnits", "wornUnits"]);
});

test("validateState：农具库存为负数时报错", () => {
  const state = simulation.createInitialState({ seed: 8108 });
  const household = farmers(state)[0];
  household.inventory[TOOL] = -1;
  assert.equal(simulation.validateState(state).valid, false);
});
