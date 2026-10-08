import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT, createInitialState } from "../src/engine.js";
import { assembleContent } from "../src/content/assemble.js";
import { CORE_CONTENT } from "../src/content/index.js";
import { assembleDailySteps, bindModCommands, selectModViews, validateMods } from "../src/mods/api.js";
import { CORE_DAILY_STEPS, runDay } from "../src/systems/daily.js";
import { setJobCount } from "../src/systems/households.js";
import { validateState } from "../src/core/validation.js";
import teaContent from "../src/mods/tea/content.js";
import teaMod from "../src/mods/tea/mod.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const content = assembleContent(CORE_CONTENT, [teaContent]);
const steps = assembleDailySteps(CORE_DAILY_STEPS, [teaMod]);

// 在一块空地上建成一座茶园，并派 workers 人采茶。
function addTeaGarden(state, workers) {
  const plot = state.plots.find(row => !row.feature);
  const id = `tea-${state.buildings.length + 1}`;
  state.buildings.push({ id, typeId: "tea_garden", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  setJobCount(state, `${id}::tea_pickers`, workers, content);
  return id;
}

function addForeignTradeHouse(state, staff) {
  const plot = state.plots.filter(row => !row.feature)[1];
  const id = "trade-house-1";
  state.buildings.push({ id, typeId: "foreign_trade_house", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  setJobCount(state, `${id}::trade_staff`, staff, content);
}

test("茶叶内容合并：物品、茶园建筑、规则、外镇收茶价（王镇高两成）", () => {
  assert.equal(content.items.tea_leaf.name, "茶叶");
  assert.equal(content.buildings.tea_garden.industryTier, 0);
  assert.equal(content.recipes.tea_picking.kind, "gather");
  assert.equal(content.rules.marketPricesVoucherPerUnit.salt, CONTENT.rules.marketPricesVoucherPerUnit.salt, "核心价格不被覆盖");
  assert.ok(content.rules.householdGoods.tea_leaf && content.rules.householdGoods.wine);
  assert.ok(content.rules.shopTypes.general.itemIds.includes("tea_leaf"));
  const minzhenPrice = content.outsideTowns.minzhen.goods.tea_leaf.basePrice;
  const wangzhenPrice = content.outsideTowns.wangzhen.goods.tea_leaf.basePrice;
  assert.ok(Math.abs(wangzhenPrice / minzhenPrice - 1.2) < 1e-9, "王镇比民镇高两成");
  assert.equal(content.outsideTowns.minzhen.goods.tea_leaf.sellsToUs, false);
  assert.deepEqual(content.modStates.tea.gardens, {});
});

test("开局有茶叶 mod 状态，茶园产业账本自动建立", () => {
  const state = createInitialState({ content, seed: 9101 });
  assert.deepEqual(state.mods.tea, { producedUnits: 0, marketSoldUnits: 0, townSoldUnits: 0, todayProducedUnits: 0, gardens: {} });
  assert.ok(state.industries.tea, "accountingSector tea 建账");
});

test("茶园采茶：每日产茶、按园计数、统计卡片与视图一致，状态合法", () => {
  const state = createInitialState({ content, seed: 9102 });
  const gardenId = addTeaGarden(state, 5);
  for (let i = 0; i < 3; i += 1) runDay(state, content, steps);

  const mine = state.mods.tea;
  const producedJin = mine.producedUnits / I;
  assert.ok(producedJin >= 30, `3 天 5 人至少 30 斤，实际 ${producedJin}`);
  assert.equal(mine.gardens[gardenId], mine.producedUnits, "只有一座茶园，按园计数应与总产量相等");
  assert.ok(mine.todayProducedUnits > 0, "今日产量已记");
  assert.equal(state.buildings.find(row => row.id === gardenId).typeId, "tea_garden");

  const view = selectModViews(state, content, [teaMod]).tea;
  assert.ok(Math.abs(view.producedJin - producedJin) < 1e-9);
  assert.ok(Math.abs(view.gardens[gardenId] - producedJin) < 1e-9);
  assert.equal(view.towns.length, 2);
  assert.deepEqual(validateState(state, content).errors, [], "validateState 通过");
  assert.deepEqual(validateMods(state, content, [teaMod]), []);
});

test("无人采茶则不产茶；未派工的茶园不计产量", () => {
  const state = createInitialState({ content, seed: 9103 });
  addTeaGarden(state, 0);
  for (let i = 0; i < 2; i += 1) runDay(state, content, steps);
  assert.equal(state.mods.tea.producedUnits, 0);
  assert.deepEqual(validateState(state, content).errors, []);
});

test("validate：负数或 NaN 计数返回中文错误", () => {
  const state = createInitialState({ content, seed: 9106 });
  assert.deepEqual(validateMods(state, content, [teaMod]), []);
  state.mods.tea.producedUnits = -1;
  state.mods.tea.marketSoldUnits = Number.NaN;
  state.mods.tea.gardens["tea-1"] = -5;
  const errors = validateMods(state, content, [teaMod]);
  assert.ok(errors.includes("[tea] 累计产量无效（-1）"), errors.join("\n"));
  assert.ok(errors.some(error => error.includes("商店售出无效")), errors.join("\n"));
  assert.ok(errors.some(error => error.includes("茶园 tea-1 的累计产量无效")), errors.join("\n"));
});

test("茶园美术：返回 SVG 片段，随等级增加采茶排数", () => {
  const level1 = teaMod.art.tea_garden({ level: 1 });
  const level3 = teaMod.art.tea_garden({ level: 3 });
  for (const svg of [level1, level3]) {
    assert.equal(typeof svg, "string");
    assert.ok(svg.startsWith("<g>"), "以 <g> 开头");
    assert.ok(svg.endsWith("</g>"), "以 </g> 结尾");
    assert.ok(svg.includes("<ellipse") && svg.includes("<path"), "包含茶树与小棚");
    const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-85 -100 170 180">${svg}</svg>`;
    assert.ok(wrapped.startsWith("<svg"));
    assert.equal((wrapped.match(/<g[ >]/g) || []).length, (wrapped.match(/<\/g>/g) || []).length, "标签配对");
  }
  assert.ok(level3.split("<ellipse").length > level1.split("<ellipse").length, "三级以上多一排茶树");
});

test("经营卡片与建筑卡片渲染为 HTML，不报错", () => {
  const state = createInitialState({ content, seed: 9107 });
  addTeaGarden(state, 4);
  runDay(state, content, steps);
  const view = selectModViews(state, content, [teaMod]).tea;
  const card = teaMod.ui.economySection.render({}, view);
  assert.match(card, /今日产量/);
  assert.match(card, /王镇茶叶库存/);
  const building = teaMod.ui.buildingSections.tea_garden({}, { id: "tea-1", level: 2 }, view);
  assert.match(building, /茶园等级/);
});

test("每日统计：市场当日售茶、今日产出按园累加，直接调用步骤函数验证口径", () => {
  const state = createInitialState({ content, seed: 9108 });
  const tally = teaMod.dailySteps.find(step => step.id === "tally").run;
  state.wholesaleMarket = { day: { soldUnits: { tea_leaf: 4 * I } } };
  const day = { production: [
    { buildingId: "tea-1", status: "target_capped", batches: 2, outputUnits: { tea_leaf: 2 * I } },
    { buildingId: "tea-2", status: "limited_materials", batches: 1, outputUnits: { tea_leaf: 1 * I } },
    { buildingId: "lumber-1", status: "ok", batches: 1, outputUnits: { wood: 1 * I } }
  ] };
  tally(state, content, day);
  assert.equal(state.mods.tea.todayProducedUnits, 3 * I);
  assert.equal(state.mods.tea.producedUnits, 3 * I);
  assert.equal(state.mods.tea.gardens["tea-1"], 2 * I);
  assert.equal(state.mods.tea.marketSoldUnits, 4 * I);
  // 第二天：今日产量重算，累计继续加。
  tally(state, content, { production: [] });
  assert.equal(state.mods.tea.todayProducedUnits, 0);
  assert.equal(state.mods.tea.producedUnits, 3 * I);
  assert.equal(state.mods.tea.gardens["tea-2"], 1 * I);
  assert.deepEqual(validateState(state, content).errors, []);
});
