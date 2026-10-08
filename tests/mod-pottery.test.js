import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { assembleContent } from "../src/content/assemble.js";
import { CORE_CONTENT } from "../src/content/index.js";
import { createInitialState } from "../src/core/state.js";
import { validateState } from "../src/core/validation.js";
import { CORE_DAILY_STEPS, runDay } from "../src/systems/daily.js";
import { setJobCount } from "../src/systems/households.js";
import { assembleDailySteps, modArt, selectModViews, validateMods, defineMod } from "../src/mods/api.js";
import potteryContent from "../src/mods/pottery/content.js";
import potteryMod from "../src/mods/pottery/mod.js";

const I = CONTENT.precision.inventoryUnitsPerJin;

// 在空地上建一座建筑（与 tests/productivity.test.js 的 addBuilding 一致）。
function addBuilding(state, typeId, id, plotIndex) {
  const plot = state.plots.filter(row => !row.feature)[plotIndex];
  assert.ok(plot, `缺少空地 ${plotIndex}`);
  state.buildings.push({ id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return id;
}

// 陶器 + 批发市场 + 陶土坑 + 陶窑 的开局场景。批发市场必须先建成，否则所有原料领用都报"尚未建成批发市场"。
function potteryWorld(seed) {
  const content = assembleContent(CORE_CONTENT, [potteryContent]);
  const state = createInitialState({ content, seed });
  addBuilding(state, "wholesale_market", "wm-1", 2);
  setJobCount(state, "wm-1::wholesale_workers", 3, content);
  addBuilding(state, "clay_pit", "clay-1", 0);
  addBuilding(state, "kiln", "kiln-1", 1);
  setJobCount(state, "clay-1::clay_diggers", 6, content);
  setJobCount(state, "kiln-1::kiln_workers", 4, content);
  const steps = assembleDailySteps(CORE_DAILY_STEPS, [potteryMod]);
  return { content, state, steps };
}

test("陶器 mod 内容合并：物品流通标记、两座建筑、配方、规则与外镇商品都生效", () => {
  const content = assembleContent(CORE_CONTENT, [potteryContent]);
  assert.equal(content.items.clay.wholesale, true);
  assert.ok(!content.items.clay.retail, "陶土不上商店货架");
  assert.ok(content.items.pottery.storeOnly && content.items.pottery.optionalRetail);
  assert.ok(content.rules.shopTypes.general.itemIds.includes("pottery"), "陶器进综合商店");
  assert.ok(!content.rules.shopTypes.general.itemIds.includes("clay"));
  assert.equal(content.rules.marketPricesVoucherPerUnit.pottery, 8);
  assert.equal(content.rules.marketPricesVoucherPerUnit.clay, 1.5);
  assert.equal(content.rules.marketPricesVoucherPerUnit.wine, CONTENT.rules.marketPricesVoucherPerUnit.wine, "核心价格不被覆盖");
  assert.ok(content.rules.householdGoods.pottery && content.rules.householdGoods.cloth, "日用品逐键合并");
  assert.equal(content.buildings.clay_pit.industryTier, 0);
  assert.equal(content.buildings.kiln.industryTier, 1);
  assert.notEqual(content.buildings.clay_pit.accountingSector, content.buildings.kiln.accountingSector);
  for (const id of ["clay_pit", "kiln"]) assert.ok(Array.isArray(content.buildings[id].jobs), `${id} 有 jobs 数组`);
  assert.deepEqual(content.recipes.kiln_firing.inputs.map(row => row.itemId).sort(), ["clay", "wood"]);
  assert.equal(content.outsideTowns.minzhen.goods.pottery.sellsToUs, false);
  assert.equal(content.outsideTowns.wangzhen.goods.pottery.sellsToUs, false);
});

test("陶土坑每日采出陶土，产量按人手计", () => {
  const { content, state, steps } = potteryWorld(9101);
  assert.ok(state.industries.clay && state.industries.pottery, "两个产业账本自动建立");
  for (let day = 0; day < 3; day++) runDay(state, content, steps);
  const clayProduced = state.industries.clay?.cumulative?.producedUnits?.clay || 0;
  assert.ok(clayProduced >= 3 * 6 * 3 * I * 0.9, `6 人每日挖 3 斤，3 天约 54 斤，实际 ${clayProduced / I}`);
  assert.equal(validateState(state, content).valid, true, validateState(state, content).errors?.join("；"));
});

test("陶窑以陶土加木柴烧出陶器，配方比例准确", () => {
  const { content, state, steps } = potteryWorld(9102);
  // 只验证配方：停掉陶土坑，直接在批发市场备货。
  setJobCount(state, "clay-1::clay_diggers", 0, content);
  state.wholesaleMarket.inventory.clay = 400 * I;
  state.wholesaleMarket.inventory.wood = 50 * I;
  for (let day = 0; day < 3; day++) runDay(state, content, steps);
  const potteryProduced = state.industries.pottery?.cumulative?.producedUnits?.pottery || 0;
  assert.ok(potteryProduced > 0, `陶窑应烧出陶器，实际 ${potteryProduced}`);
  // 配方：4 斤陶土 + 1 斤木柴 → 4 件陶器。
  const clayUsed = 400 * I - state.wholesaleMarket.inventory.clay;
  assert.ok(clayUsed > 0 && clayUsed === potteryProduced, `陶土消耗与陶器产出符合 4:4 配方（陶土 ${clayUsed}，陶器 ${potteryProduced}）`);
  assert.equal(validateState(state, content).valid, true, validateState(state, content).errors?.join("；"));
});

test("陶土从陶土坑流入批发市场、再到陶窑", () => {
  const { content, state, steps } = potteryWorld(9103);
  state.wholesaleMarket.inventory.wood = 50 * I;
  for (let day = 0; day < 3; day++) runDay(state, content, steps);
  assert.ok((state.wholesaleMarket.inventory.clay || 0) > 0, "陶土坑产出的陶土应进入批发市场");
  assert.ok((state.industries.pottery?.cumulative?.producedUnits?.pottery || 0) > 0, "陶窑应烧出陶器");
});

test("陶器 mod 视图反映陶窑数与陶器库存；美术输出 SVG 片段", () => {
  const content = assembleContent(CORE_CONTENT, [potteryContent]);
  const state = createInitialState({ content, seed: 9104 });
  addBuilding(state, "kiln", "kiln-view", 0);
  state.wholesaleMarket.inventory.pottery = 42 * I;

  const view = selectModViews(state, content, [potteryMod]).pottery;
  assert.equal(view.kilnCount, 1);
  assert.equal(view.potteryStockPieces, 42);
  assert.equal(potteryMod.ui.economySection.title, "陶器");
  const html = potteryMod.ui.economySection.render(view, view);
  assert.ok(html.includes("1 座") && html.includes("42 件"), "经济卡片显示陶窑数与库存");

  for (const typeId of ["kiln", "clay_pit"]) {
    const svg = modArt([potteryMod], typeId)({ level: 1, status: "complete" });
    assert.equal(typeof svg, "string");
    assert.ok(svg.startsWith("<g") && svg.endsWith("</g>"), `${typeId} 美术是 SVG 片段`);
    assert.ok(svg.includes("<path"), `${typeId} 含图形元素`);
    assert.ok(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-85 -100 170 180">${svg}</svg>`.includes("<g"), `${typeId} 可嵌入 svg`);
  }
});

test("陶器 mod 的校验钩子无错误，mod 定义可被框架接受", () => {
  const content = assembleContent(CORE_CONTENT, [potteryContent]);
  const state = createInitialState({ content, seed: 9105 });
  assert.deepEqual(validateMods(state, content, [potteryMod]), []);
  assert.equal(defineMod(potteryMod).id, "pottery");
});
