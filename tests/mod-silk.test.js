import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { assembleContent } from "../src/content/assemble.js";
import { CORE_CONTENT } from "../src/content/index.js";
import { createInitialState } from "../src/core/state.js";
import { validateState } from "../src/core/validation.js";
import { CORE_DAILY_STEPS, runDay } from "../src/systems/daily.js";
import { householdList, householdPopulation, isActiveHousehold, setJobCount, householdIdleWorkers, syncResidentAggregates } from "../src/systems/households.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { openShop } from "../src/systems/shops.js";
import { buyGoodsForResidents } from "../src/systems/goods-demand.js";
import { invalidateHouseholdBudgets } from "../src/systems/household-budget.js";
import { voucherWealthForAffluence } from "./budget-fixture.js";
import { issueTownVouchers, transferVouchers, voucherBalance } from "../src/economy/currency.js";
import { assembleDailySteps, modArt, selectModViews, validateMods, defineMod } from "../src/mods/api.js";
import { tradeWithOutsideTown } from "../src/systems/outside-town.js";
import { privateJobKeyForBuilding } from "../src/selectors/labor.js";
import silkContent from "../src/mods/silk/content.js";
import silkMod from "../src/mods/silk/mod.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const content = assembleContent(CORE_CONTENT, [silkContent]);
const steps = assembleDailySteps(CORE_DAILY_STEPS, [silkMod]);

// 在空地上建一座建筑（跳过施工，只作夹具）。
function addBuilding(state, id, typeId, plotIndex, ownership = { townLevels: 1, privateLevels: 0, listedLevels: 0 }, extra = {}) {
  const plot = state.plots.filter(row => !row.feature)[plotIndex];
  assert.ok(plot, `缺少空地 ${plotIndex}`);
  state.buildings.push({ id, typeId, level: 1, ownership, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }, ...extra });
  return id;
}

// 桑园世界：批发市场（统购出入口）+ 桑园 + 派 workers 名桑农。
function silkWorld(seed, workers = 10) {
  const state = createInitialState({ content, seed });
  addBuilding(state, "wm-1", "wholesale_market", 2);
  setJobCount(state, "wm-1::wholesale_workers", 3, content);
  addBuilding(state, "mg-1", "mulberry_garden", 0);
  setJobCount(state, "mg-1::mulberry_farmers", workers, content);
  return { state, garden: "mg-1" };
}

function assertValid(state, label = "") {
  const check = validateState(state, content);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

// 粮券走发行与转账，保证总账守恒。
function useVoucherMoney(state) {
  state.monetaryReform.targetVoucherBps = 10000;
  state.monetaryReform.residentExchangeEnabled = false;
  state.monetaryReform.legacyBankAccess = true;
}

// 宽裕度 m（household-budget 新口径）：把粮券家底设成让可动用预算对应 m 的值，小麦只留够口粮。
function setAffluence(state, household, affluence) {
  useVoucherMoney(state); // 开局即粮券，但夹具没有银行：每次都要开 legacyBankAccess，印券才不会报"需要银行"
  const people = householdPopulation(household);
  const keepDays = content.rules.householdBudget.wealthFoodReserveDays; // 家底只扣这么多天口粮，正好留足口粮、不产生额外家底
  household.inventory.wheat = Math.round(people * content.rules.foodPerPersonDay * keepDays * I);
  household.inventory.flour = 0;
  household.inventory.bread = 0;
  syncResidentAggregates(state, content);
  const target = voucherWealthForAffluence(state, household, affluence, content);
  const owner = `household:${household.id}`;
  const current = voucherBalance(state, owner);
  if (target > current) {
    const need = target - current;
    if (voucherBalance(state, "town") < need) assert.equal(issueTownVouchers(state, need, content, "测试印制").ok, true);
    assert.equal(transferVouchers(state, "town", owner, need, content, "test_income", "测试设定家底").ok, true);
  } else if (target < current) {
    assert.equal(transferVouchers(state, owner, "town", current - target, content, "test_expense", "测试设定家底").ok, true);
  }
  invalidateHouseholdBudgets(state);
}

test("丝绸 mod 内容合并：物品流通标记、桑园（原料产业）、配方、规则、日用品与外镇进口都生效", () => {
  assert.equal(content.items.silk.name, "丝绸");
  assert.equal(content.items.silk.unit, "斤");
  assert.ok(content.items.silk.wholesale && content.items.silk.retail && content.items.silk.storeOnly && content.items.silk.optionalRetail);
  assert.ok(content.rules.shopTypes.general.itemIds.includes("silk"), "丝绸进综合商店货架");
  assert.equal(content.rules.marketPricesVoucherPerUnit.silk, 100);
  assert.equal(content.rules.wholesaleDefaultPurchasePrices.silk, 85);
  assert.equal(content.rules.marketPricesVoucherPerUnit.wine, CONTENT.rules.marketPricesVoucherPerUnit.wine, "核心价格不被覆盖");
  assert.ok(content.rules.householdGoods.silk && content.rules.householdGoods.wine, "丝绸进日用品表");
  assert.equal(content.rules.householdGoods.silk.incomeElasticity, 2.0);
  assert.equal(content.buildings.mulberry_garden.industryTier, 0);
  assert.equal(content.buildings.mulberry_garden.recipeId, "silk_reeling");
  assert.equal(content.recipes.silk_reeling.kind, "gather");
  assert.deepEqual(content.recipes.silk_reeling.inputs, []);
  assert.equal(content.recipes.silk_reeling.outputs[0].itemId, "silk");
  assert.equal(content.recipes.silk_reeling.outputs[0].quantity, 10, "一批 10 斤");
  assert.equal(content.recipes.silk_reeling.batchesPerWorkerDay, 1, "每人每日一批");
  assert.ok(Array.isArray(content.buildings.mulberry_garden.jobs), "桑园有 jobs 数组");
  assert.equal(content.buildings.mulberry_garden.jobs[0].id, "mulberry_farmers");
  assert.ok(content.buildings.mulberry_garden.accountingSector, "自动建产业账本");
  assert.equal(content.outsideTowns.minzhen.goods.silk.sellsToUs, false);
  assert.equal(content.outsideTowns.wangzhen.goods.silk.sellsToUs, false);
  assert.ok(content.outsideTowns.wangzhen.goods.silk.basePrice > content.outsideTowns.minzhen.goods.silk.basePrice, "王镇富，出价高");
});

test("桑农每人每日产 10 斤丝绸；等级提高产量随之提高", () => {
  const level1 = silkWorld(9301);
  const before1 = level1.state.industries.silk?.cumulative?.producedUnits?.silk || 0;
  runDay(level1.state, content, steps);
  const produced1 = (level1.state.industries.silk?.cumulative?.producedUnits?.silk || 0) - before1;
  assert.equal(produced1, 100 * I, `10 名桑农 × 10 斤，一天 100 斤，实际 ${produced1 / I}`);

  const level2 = silkWorld(9302);
  const garden2 = level2.state.buildings.find(row => row.id === level2.garden);
  garden2.level = 2;
  garden2.ownership = { townLevels: 2, privateLevels: 0, listedLevels: 0 };
  runDay(level2.state, content, steps);
  const produced2 = level2.state.industries.silk?.cumulative?.producedUnits?.silk || 0;
  assert.equal(produced2, 110 * I, `二级桑园生产率 +10%，应为 110 斤，实际 ${produced2 / I}`);
  assertValid(level1.state, "一级桑园之后");
  assertValid(level2.state, "二级桑园之后");
});

test("丝绸从桑园进入批发市场；民营桑园同样产丝绸", () => {
  const { state } = silkWorld(9303);
  runDay(state, content, steps);
  assert.equal(state.wholesaleMarket.inventory.silk, 100 * I, "当天产出全部入批发市场库存");

  const priv = createInitialState({ content, seed: 9304 });
  addBuilding(priv, "wm-p", "wholesale_market", 2);
  setJobCount(priv, "wm-p::wholesale_workers", 3, content);
  // 民营桑园的工人由业主的现金决定（privateHireCapByOwnerMoney），业主要有钱才招得满。
  const owner = householdList(priv).find(h => householdIdleWorkers(h) > 0) || householdList(priv)[0];
  useVoucherMoney(priv);
  setAffluence(priv, owner, 2.2);
  addBuilding(priv, "mg-p", "mulberry_garden", 0, { townLevels: 0, privateLevels: 1, listedLevels: 0 }, { privateOwners: [owner.id] });
  setJobCount(priv, privateJobKeyForBuilding("mg-p", "mulberry_farmers"), 10, content);
  // 民营产业按近期实销排产（与其他民营产业同一口径）：先给出近 7 日每天售出 50 斤的记录，民营桑园才会开工。
  priv.market.consumerHistory.silk = Array.from({ length: 7 }, (_, i) => ({ year: 1, day: i + 1, soldUnits: 50 * I }));
  runDay(priv, content, steps);
  // 民营产出不记在镇营产业账上，而是经批发市场收购入库（收购价由镇库付）。
  assert.ok((priv.wholesaleMarket.inventory.silk || 0) > 0, "民营桑园的丝绸经批发市场收购入库");
  assertValid(priv, "民营桑园之后");
});

test("富户在综合商店买丝绸，穷户买不到", () => {
  const state = createInitialState({ content, seed: 9305 });
  const def = content.buildings.commercial_street;
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) && !state.buildings.some(b => b.plotId === row.id));
  const street = { id: "street-silk", typeId: "commercial_street", level: 2, ownership: { townLevels: 2, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } };
  state.buildings.push(street);
  initializeBuildingJobs(state, street, content);
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  const opened = openShop(state, street.id, "general", content, owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  shop.inventory.silk = 2000 * I;
  shop.inventoryCostVoucherUnits.silk = 2000 * 60 * V;

  const others = householdList(state).filter(h => h.id !== owner.id && isActiveHousehold(h));
  const rich = others.filter((_, i) => i % 2 === 0);
  const poor = others.filter((_, i) => i % 2 === 1);
  for (const h of rich) setAffluence(state, h, 2.2);
  for (const h of poor) setAffluence(state, h, 0.2);
  const before = new Map(others.map(h => [h.id, h.inventory.silk || 0]));
  buyGoodsForResidents(state, content);
  const richBought = rich.reduce((sum, h) => sum + ((h.inventory.silk || 0) - before.get(h.id)), 0);
  const poorBought = poor.reduce((sum, h) => sum + ((h.inventory.silk || 0) - before.get(h.id)), 0);
  assert.ok(richBought > 0, `富户应买到丝绸，实际 ${richBought / I} 斤`);
  assert.ok(poorBought * 100 < richBought, `宽裕度 0.2 的穷户几乎不买：穷户 ${poorBought / I} 斤，富户 ${richBought / I} 斤`);
  for (const h of poor) assert.ok((h.inventory.silk || 0) - before.get(h.id) < I, "穷户每户不到 1 斤");
  assertValid(state, "丝绸零售之后");
});

test("外镇王镇、民镇进口丝绸；不卖给我们；外贸需外贸房在岗", () => {
  const state = createInitialState({ content, seed: 9306 });
  const plot = state.plots.filter(row => !row.feature)[1];
  state.buildings.push({ id: "ftrade", typeId: "foreign_trade_house", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  setJobCount(state, "ftrade::trade_staff", 2, content);
  state.logistics.poolJin = 200;
  state.accounts.town.silk = 300 * I;
  const sold = tradeWithOutsideTown(state, "sell", "silk", 20, content, "wangzhen");
  assert.equal(sold.ok, true, sold.reason);
  assert.ok(Math.abs(sold.quantityJin - 20) < 0.01, `应成交 20 斤，实际 ${sold.quantityJin}`);
  assert.equal(state.accounts.town.silk, 280 * I, "镇库丝绸减少");
  const refused = tradeWithOutsideTown(state, "buy", "silk", 5, content, "wangzhen");
  assert.equal(refused.ok, false, "王镇不卖丝绸给我们");
  assertValid(state, "外镇进口之后");
});

test("丝绸 mod 的校验钩子无错误，视图、经济卡片与桑园美术可用", () => {
  const state = createInitialState({ content, seed: 9307 });
  assert.deepEqual(validateMods(state, content, [silkMod]), []);
  assert.equal(defineMod(silkMod).id, "silk");
  addBuilding(state, "mg-view", "mulberry_garden", 0);
  state.wholesaleMarket.inventory.silk = 42 * I;
  const view = selectModViews(state, content, [silkMod]).silk;
  assert.equal(view.gardenCount, 1);
  assert.equal(view.silkStockJin, 42);
  const html = silkMod.ui.economySection.render(view, view);
  assert.ok(html.includes("1 座") && html.includes("42 斤"), "经济卡片显示桑园数与库存");
  for (const level of [1, 3]) {
    const svg = modArt([silkMod], "mulberry_garden")({ level, status: "complete" });
    assert.equal(typeof svg, "string");
    assert.ok(svg.startsWith("<g") && svg.endsWith("</g>"), "桑园美术是 SVG 片段");
    assert.ok(svg.includes("<ellipse") && svg.includes("<path"), "含树冠与小屋");
  }
});
