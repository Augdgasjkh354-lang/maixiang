// 养牛场与耕牛（金银消费第三期）：养牛场的配置与开设、小牛养成与出栏、直供农民、耕牛目标持有（亩数 ÷ 50）、
// 折旧（寿命 6 年）、维护费（按日付给养牛场）、无养牛场时欠养与效力下降、亩产公式（600 + 农具 + 牛）、无牛时逐位一致、账平。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { householdList, isActiveHousehold, syncResidentAggregates } from "../src/systems/households.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "../tests/helpers-v16.js";
import { wearDurableGoods, buyDurableGoodsForHouseholds } from "../src/systems/durable-goods.js";
import { payOxMaintenanceDay, produceCattle, ensureCattle } from "../src/systems/cattle.js";
import { oxEfficiency, selectFarmland, farmTotalOutputJin } from "../src/selectors/farmland.js";
import { durableTargetContext, durableTargetPieces, selectDurableCoverage } from "../src/selectors/durable-goods.js";
import { putStock } from "../src/economy/trade.js";
import { herdHeads } from "../src/systems/cattle-herd.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const OX = "ox";
const TOOL = "iron_farm_tool";
const DAYS = CONTENT.rules.daysPerYear;
const OX_CFG = CONTENT.rules.durableGoods[OX];

function valid(state, label = "") {
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, `${label} ${v.errors.join("；")}`);
}

function farmers(state) {
  return householdList(state).filter(isActiveHousehold).filter(h => (h.jobs?.farmers || 0) > 0);
}

// 每户耕牛（或农具）库存设为目标的 fraction 比例（头数 = 目标 × fraction，库存单位取整）。
function holdFraction(state, itemId, fraction) {
  const cfg = CONTENT.rules.durableGoods[itemId];
  const ctx = durableTargetContext(state, CONTENT, cfg);
  for (const household of farmers(state)) {
    const target = durableTargetPieces(household, cfg, ctx);
    household.inventory[itemId] = Math.round(target * fraction * I);
  }
  syncResidentAggregates(state, CONTENT);
}

// 养牛场世界：空白开局 + 木材 + 批发市场（饲料）+ 商业街 + 养殖基地，养牛场由业主注资 300,000 券。
function cattleWorld(seed, { cattle = true } = {}) {
  const state = simulation.createInitialState({ seed });
  state.accounts.town.wood += 50000 * I;
  const freePlot = (feature = null) => state.plots.find(p => (feature ? p.feature === feature : !p.feature)
    && !state.buildings.some(b => b.plotId === p.id));
  const add = (typeId, level = 2, feature = null) => {
    const p = freePlot(feature);
    const id = `${typeId}-${state.buildings.length}`;
    state.buildings.push({ id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: p.id, x: p.x, y: p.y, materialInvestments: [], completed: { year: 1, day: 1 } });
    return id;
  };
  const staff = (id, n) => simulation.setEmployment(state, `${id}::${CONTENT.buildings[state.buildings.find(b => b.id === id).typeId].jobs[0].id}`, n);
  add("bank", 1);
  staff(add("wholesale_market", 2), 4);
  const street = add("commercial_street", 3);
  const base = add("livestock_base", 2);
  grantResidentVouchers(state, 200000);
  let shopId = null;
  if (cattle) {
    const opened = simulation.openResidentShop(state, base, "cattle_farm");
    assert.equal(opened.ok, true, opened.reason);
    shopId = opened.shopId;
    issueTownVouchers(state, 300000 * V, CONTENT, "测试：养牛场注资");
    transferVouchers(state, "town", `shop:${shopId}`, 300000 * V, CONTENT, "测试：养牛场注资", "测试：养牛场注资");
  }
  return { state, shopId, street, base };
}

// ---------------------------------------------------------------- 配置

test("养牛场配置：kind farm，产品耕牛，小牛养 360 天出栏，饲料小麦每头每日 5 斤；开在养殖基地", () => {
  const def = CONTENT.rules.shopTypes.cattle_farm;
  assert.equal(def.kind, "farm");
  assert.equal(def.hostBuildingTypeId, "livestock_base");
  assert.equal(def.productItemId, OX);
  assert.equal(def.feedItemId, "wheat");
  assert.equal(def.herd.growthDays, 360);
  assert.equal(def.herd.feedPerCalfDayJin, 5);
  assert.equal(CONTENT.rules.shopTypes.general.itemIds.includes(OX), false, "综合商店不卖耕牛");
});

test("耕牛物品：不可食用，不上批发市场与零售货架，单位头；耐用品按亩数 ÷ 50 持有，寿命 6 年，由养牛场直卖", () => {
  const item = CONTENT.items[OX];
  assert.equal(item.unit, "头");
  assert.equal(item.edible, false);
  assert.equal(item.wholesale, undefined);
  assert.equal(item.retail, undefined);
  assert.equal(OX_CFG.targetBy, "acres");
  assert.equal(OX_CFG.lifeYears, 6);
  assert.equal(OX_CFG.seller, "farm");
  assert.equal(CONTENT.agriculture.oxAcres, 50);
  assert.equal(CONTENT.agriculture.oxYieldBonusPerAcre, 200);
  assert.equal(CONTENT.rules.oxMaintenancePerOxYearVoucher, 1800, "年 1800 券 = 每日 5 券（360 天游戏年）");
  assert.equal(CONTENT.rules.oxFeedPerOxDayJin, 5, "每头耕牛每日 5 斤小麦");
});

test("养牛场可以在养殖基地里开设；没有养殖基地时不能开", () => {
  const { state, shopId } = cattleWorld(9101);
  const shop = state.shops[shopId];
  assert.equal(shop.status, "open");
  assert.equal(shop.typeId, "cattle_farm");
  assert.equal(simulation.validateState(state).valid, true);
});

// ---------------------------------------------------------------- 目标持有与折旧

test("耕牛目标持有：全镇 = 亩数 ÷ 50（3 万亩 600 头），按户的农民人数摊分；无农民时目标为 0", () => {
  const state = simulation.createInitialState({ seed: 9102 });
  const ctx = durableTargetContext(state, CONTENT, OX_CFG);
  let total = 0;
  for (const household of householdList(state).filter(isActiveHousehold)) total += durableTargetPieces(household, OX_CFG, ctx);
  assert.ok(Math.abs(total - 600) < 1e-6, `全镇目标 ${total} 应为 600`);
  const coverage = selectDurableCoverage(state, CONTENT, OX);
  assert.equal(coverage.targetPieces > 0, true);
  assert.ok(Math.abs(coverage.annualReplacementPieces - 100) < 1e-6, "年更新 = 目标 ÷ 6 年 = 100 头");
  const empty = simulation.createInitialState({ seed: 9103 });
  for (const household of householdList(empty)) household.jobs = {};
  assert.equal(durableTargetPieces(householdList(empty)[0], OX_CFG, durableTargetContext(empty, CONTENT, OX_CFG)), 0);
});

test("耕牛寿命 6 年：每日按户折旧，一年后约剩 e^(−1/6)（平均寿命 = 寿命年数）", () => {
  const state = simulation.createInitialState({ seed: 9104 });
  const household = farmers(state)[0];
  household.inventory[OX] = 100 * I;
  syncResidentAggregates(state, CONTENT);
  for (let day = 0; day < DAYS; day += 1) wearDurableGoods(state, CONTENT);
  const ratio = household.inventory[OX] / (100 * I);
  assert.ok(Math.abs(ratio - Math.exp(-1 / 6)) < 0.01, `折旧后比例 ${ratio}`);
  valid(state, "折旧");
});

// ---------------------------------------------------------------- 养成与出栏

test("养牛场：小牛每日吃饲料（5 斤/头），养满 360 天出栏成耕牛，入养牛场库存并带成本基础", () => {
  const { state, shopId } = cattleWorld(9105);
  const farm = state.shops[shopId];
  putStock(farm, "wheat", 50 * 5 * I * 3, 0);       // 测试注入 3 天饲料（小麦）
  farm.herd = [{ count: 4, fedDays: 0, costUnits: 0 }];
  const before = farm.inventory.wheat;
  produceCattle(state, farm, CONTENT);
  assert.equal(before - farm.inventory.wheat, 4 * 5 * I, "4 头小牛吃 20 斤小麦");
  assert.equal(farm.herd[0].fedDays, 1, "吃饱一天");
  farm.herd = [{ count: 3, fedDays: 359.5, costUnits: 900 }];
  produceCattle(state, farm, CONTENT);
  assert.equal(farm.herd.length, 0, "出栏后小牛群清空");
  assert.equal(farm.inventory[OX], 3 * I, "3 头耕牛入库");
  assert.ok(farm.inventoryCostVoucherUnits[OX] > 0, "耕牛带成本基础");
  valid(state, "出栏");
});

test("养牛场：饲料不够时按比例少喂，小牛少长（不凭空饲养）", () => {
  const { state, shopId } = cattleWorld(9106);
  const farm = state.shops[shopId];
  farm.herd = [{ count: 10, fedDays: 0, costUnits: 0 }];
  farm.inventory.wheat = 0;
  produceCattle(state, farm, CONTENT);
  assert.equal(farm.herd[0].fedDays, 0, "没有饲料就不长");
  valid(state, "缺饲料");
});

test("养牛场：直供农民，农户付钱给养牛场、耕牛进户库存，库存与账平", () => {
  const { state, shopId } = cattleWorld(9107);
  const farm = state.shops[shopId];
  putStock(farm, OX, 40 * I, 40 * 1900 * V);
  // 农户的耕牛目标先清零，只用日结里的补置步骤买。
  holdFraction(state, OX, 0);
  const paidBefore = householdList(state).reduce((sum, h) => sum + (h.voucherUnits || 0), 0);
  const result = buyDurableGoodsForHouseholds(state, CONTENT);
  assert.ok(result[OX].purchasedUnits > 0, "农户买到了耕牛");
  assert.equal(40 * I - farm.inventory[OX], result[OX].purchasedUnits, "农场库存减少 = 卖出数量");
  const bought = householdList(state).reduce((sum, h) => sum + (h.inventory[OX] || 0), 0);
  assert.equal(bought, result[OX].purchasedUnits, "户库存 = 买到的数量");
  const paidAfter = householdList(state).reduce((sum, h) => sum + (h.voucherUnits || 0), 0);
  assert.equal(paidBefore - paidAfter, farm.accounts.day.revenueVoucherUnits, "农户付的钱 = 养牛场收入");
  assert.equal(result[OX].paidVoucherUnits, farm.accounts.day.revenueVoucherUnits, "日账与结果一致");
  valid(state, "直供");
});

test("没有耕牛可卖时，农户需求记为未满足，并挂到养牛场的未满足上", () => {
  const { state, shopId } = cattleWorld(9108);
  const farm = state.shops[shopId];
  farm.inventory[OX] = 0;
  const result = buyDurableGoodsForHouseholds(state, CONTENT);
  assert.equal(result[OX].purchasedUnits, 0);
  assert.ok((farm.accounts.day.unmetUnits?.[OX] || 0) > 0, "养牛场记下未满足需求");
  valid(state, "未满足");
});

// ---------------------------------------------------------------- 维护费与欠养

test("维护费与饲料：每户每日按在役耕牛头数付 5 券/头给养牛场；养牛场用这笔钱从镇库买 5 斤/头的小麦，当日吃掉，账平", () => {
  const { state, shopId } = cattleWorld(9109);
  const farm = state.shops[shopId];
  const household = farmers(state)[0];
  household.inventory[OX] = 2 * I;
  syncResidentAggregates(state, CONTENT);
  const townWheatBefore = state.accounts.town.wheat;
  const revenueBefore = farm.accounts.day.revenueVoucherUnits || 0;
  const result = payOxMaintenanceDay(state, CONTENT);
  const due = 2 * 5 * V;
  assert.equal(result.dueVoucherUnits, due, "应付 = 2 头 × 5 券");
  assert.equal(result.paidVoucherUnits, due, "付清");
  assert.equal(farm.accounts.day.revenueVoucherUnits - revenueBefore, due, "养牛场维护费收入");
  const feedUnits = 2 * 5 * I;
  assert.equal(farm.accounts.day.consumedUnits.wheat, feedUnits, "养牛场为 2 头耕牛消耗 10 斤小麦");
  assert.equal(townWheatBefore - state.accounts.town.wheat, feedUnits, "小麦从镇库出库");
  assert.equal(ensureCattle(state).day.feedWheatUnits, feedUnits);
  const cogs = farm.accounts.day.cogsVoucherUnits;
  assert.equal(farm.accounts.day.profitVoucherUnits, due - cogs, "利润 = 维护费 − 小麦成本");
  assert.equal(household.oxGapDays || 0, 0, "付清且喂饱，欠养清零");
  assert.equal(ensureCattle(state).day.unfedHouseholds, 0);
  valid(state, "维护费与饲料");
});

test("小麦喂不上（镇库口粮储备线以内买不到）：耕牛户欠养累计，效力随天数下降", () => {
  const { state, shopId } = cattleWorld(9116);
  const farm = state.shops[shopId];
  const household = farmers(state)[0];
  household.inventory[OX] = I;
  syncResidentAggregates(state, CONTENT);
  state.accounts.town.wheat = 1000;   // 远低于 60 天口粮储备线，批发市场不卖
  payOxMaintenanceDay(state, CONTENT);
  assert.equal(household.oxGapDays, 1, "维护费付了，但没喂饱：欠养 +1");
  assert.equal(farm.accounts.day.consumedUnits?.wheat || 0, 0, "没买到小麦就不消耗");
  assert.equal(ensureCattle(state).day.feedWheatUnits, 0);
  for (let day = 0; day < 40; day += 1) payOxMaintenanceDay(state, CONTENT);
  assert.ok(oxEfficiency(household, CONTENT) < 1, "欠养超过宽限天数后效力下降");
  valid(state, "喂不上");
});

test("无养牛场：耕牛户每日欠养 +1 天；超过宽限天数后效力按比例下降，付上即恢复", () => {
  const state = simulation.createInitialState({ seed: 9110 });
  grantResidentVouchers(state, 1000);
  const household = farmers(state)[0];
  household.inventory[OX] = I;
  syncResidentAggregates(state, CONTENT);
  payOxMaintenanceDay(state, CONTENT);
  assert.equal(household.oxGapDays, 1, "无养牛场，当日欠养");
  assert.equal(oxEfficiency({ oxGapDays: 30 }, CONTENT), 1, "宽限期内效力不降");
  assert.ok(Math.abs(oxEfficiency({ oxGapDays: 60 }, CONTENT) - (1 - 30 / 360)) < 1e-9, "超过宽限按比例下降");
  assert.equal(oxEfficiency({ oxGapDays: 30 + 360 }, CONTENT), 0, "欠养满一年效力为 0");
  household.oxGapDays = 0;
  assert.equal(oxEfficiency(household, CONTENT), 1, "付上维护费即恢复");
  valid(state, "欠养");
});

test("无耕牛的户：欠养天数清零（卖掉或折旧光后不再欠养）", () => {
  const state = simulation.createInitialState({ seed: 9111 });
  const household = farmers(state)[0];
  household.oxGapDays = 12;
  household.inventory[OX] = 0;
  payOxMaintenanceDay(state, CONTENT);
  assert.equal(household.oxGapDays, 0);
});

// ---------------------------------------------------------------- 亩产公式

test("亩产公式（3 万亩）：600 + 200 × 农具覆盖率 + 200 × 牛耕覆盖率；0 / 0.5 / 1 的组合为 600 / 700 / 800 / 1000", () => {
  const cases = [
    [0, 0, 600], [0.5, 0, 700], [1, 0, 800], [0, 0.5, 700], [0.5, 0.5, 800], [1, 1, 1000]
  ];
  for (const [tool, ox, expected] of cases) {
    const state = simulation.createInitialState({ seed: 9112 });
    holdFraction(state, TOOL, tool);
    holdFraction(state, OX, ox);
    const f = selectFarmland(state, CONTENT);
    const perAcre = f.totalJin / f.acres;
    assert.ok(Math.abs(perAcre - expected) < 1e-6, `农具 ${tool} 牛 ${ox}：亩产 ${perAcre}，应为 ${expected}`);
    assert.ok(Math.abs(f.oxCoverage - ox) < 1e-9, "牛耕覆盖率");
  }
});

test("无牛时逐位一致：亩产 = 亩数 × (600 + 200 × 农具覆盖率)，与第二期相同", () => {
  const state = simulation.createInitialState({ seed: 9113 });
  holdFraction(state, TOOL, 0.37);
  const f = selectFarmland(state, CONTENT);
  const cov = selectDurableCoverage(state, CONTENT, TOOL).coverage;
  assert.equal(f.totalJin, f.acres * (600 + 200 * cov), "逐位一致");
  assert.equal(farmTotalOutputJin(state, CONTENT), f.totalJin);
});

test("耕牛效力下降的户：覆盖率按效力计入，欠养的那一户少算一半", () => {
  const state = simulation.createInitialState({ seed: 9114 });
  holdFraction(state, OX, 1);
  const full = selectFarmland(state, CONTENT).oxAcresCounted / CONTENT.agriculture.oxAcres;
  assert.ok(Math.abs(full - 600) < 1e-6, "满效力时全镇 600 头");
  const half = farmers(state)[0];
  const heads = (half.inventory[OX] || 0) / I;
  half.oxGapDays = 30 + 180;   // 效力 0.5
  const counted = selectFarmland(state, CONTENT).oxAcresCounted / CONTENT.agriculture.oxAcres;
  assert.ok(Math.abs(counted - (600 - heads * 0.5)) < 1e-6, `计入头数 ${counted}`);
  assert.ok(selectFarmland(state, CONTENT).oxInService < 600, "在役头数随效力下降");
});

test("养牛场与耕牛的日结：3 天后账平，耕牛与小牛头数为非负整数", () => {
  const { state, shopId } = cattleWorld(9115);
  const farm = state.shops[shopId];
  farm.herd = [{ count: 2, fedDays: 0, costUnits: 0 }];
  for (let day = 0; day < 3; day += 1) simulation.advanceDay(state);
  valid(state, "三日");
  assert.equal(herdHeads(farm) >= 2, true);
  assert.ok(Number.isInteger(farm.herd[0].count));
  assert.equal(typeof ensureCattle(state).year, "object");
});
