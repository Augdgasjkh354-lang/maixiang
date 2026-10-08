import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT, createInitialState } from "../src/engine.js";
import { assembleContent } from "../src/content/assemble.js";
import { CORE_CONTENT } from "../src/content/index.js";
import { assembleDailySteps, bindModCommands, selectModViews, validateMods, modArt, modComfortPoints, defineMod } from "../src/mods/api.js";
import { CORE_DAILY_STEPS, runDay } from "../src/systems/daily.js";
import { setJobCount } from "../src/systems/households.js";
import { renderBuildingArt } from "../src/ui/building-art.js";
import templateContent from "../src/mods/_template/content.js";
import templateMod from "../src/mods/_template/mod.js";

const I = CONTENT.precision.inventoryUnitsPerJin;


test("mod 内容合并：物品、建筑、规则逐键合并、商店货架和外镇商品自动跟上", () => {
  const content = assembleContent(CORE_CONTENT, [templateContent]);
  assert.ok(content.items.tea_leaf && content.buildings.tea_garden && content.recipes.tea_picking);
  assert.equal(content.rules.marketPricesVoucherPerUnit.tea_leaf, 6);
  assert.equal(content.rules.marketPricesVoucherPerUnit.salt, CONTENT.rules.marketPricesVoucherPerUnit.salt, "核心价格不被覆盖");
  assert.ok(content.rules.householdGoods.tea_leaf && content.rules.householdGoods.cloth);
  assert.ok(content.rules.shopTypes.general.itemIds.includes("tea_leaf"));
  assert.ok(content.outsideTowns.minzhen.goods.tea_leaf && content.outsideTowns.minzhen.goods.salt);
  assert.deepEqual(content.modStates._template, { pickedTotalUnits: 0 });
});

test("mod 定义与核心重名时报错，指出是哪个 mod", () => {
  assert.throws(() => assembleContent(CORE_CONTENT, [{ id: "bad", items: { salt: {} } }]), /bad.*salt/);
  assert.throws(() => assembleContent(CORE_CONTENT, [{ id: "bad2", outsideTownGoods: { nowhere: {} } }]), /nowhere/);
});

test("mod 每日步骤插在指定核心步骤之后；找不到位置时报错", () => {
  const steps = assembleDailySteps(CORE_DAILY_STEPS, [templateMod]);
  const ids = steps.map(step => step.id);
  assert.equal(ids[ids.indexOf("industryExperience") + 1], "_template:tally");
  assert.throws(() => assembleDailySteps(CORE_DAILY_STEPS, [defineMod({ id: "x", dailySteps: [{ id: "s", after: "nope", run() {} }] })]), /nope/);
});

test("模板 mod 端到端：开局有 mod 状态，茶园采茶、每日步骤记账、命令、视图、校验、美术都生效", () => {
  const content = assembleContent(CORE_CONTENT, [templateContent]);
  const state = createInitialState({ content, seed: 7701 });
  assert.deepEqual(state.mods._template, { pickedTotalUnits: 0 });
  assert.ok(state.industries.tea, "新产业账本自动建立");
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({ id: "tea-1", typeId: "tea_garden", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  setJobCount(state, "tea-1::tea_pickers", 5, content);
  const steps = assembleDailySteps(CORE_DAILY_STEPS, [templateMod]);
  for (let i = 0; i < 3; i++) runDay(state, content, steps);
  assert.ok(state.mods._template.pickedTotalUnits >= 30 * I, `3 天 5 人至少 30 斤，实际 ${state.mods._template.pickedTotalUnits / I}`);

  const commands = bindModCommands([templateMod], content);
  assert.equal(commands._template.reset(state).ok, true);
  assert.equal(state.mods._template.pickedTotalUnits, 0);
  assert.equal(selectModViews(state, content, [templateMod])._template.pickedJin, 0);
  state.mods._template.pickedTotalUnits = -1;
  assert.deepEqual(validateMods(state, content, [templateMod]), ["[_template] 累计采茶量无效"]);
  assert.ok(modArt([templateMod], "tea_garden")().includes("<g>"));
  assert.equal(modComfortPoints(state, null, 1, {}, content, [templateMod]), 0);
});

test("不含 mod 的核心内容照常开局：mods 状态为空，建筑美术回落到核心", () => {
  const state = createInitialState({ content: assembleContent(CORE_CONTENT, []) });
  assert.deepEqual(state.mods, {});
  assert.ok(renderBuildingArt("mill", { level: 1 }).length > 0);
});

test("加 mod 之前的旧存档能读：补出 mod 状态、外镇新商品库存、批发市场新商品", async () => {
  const { migrateSave } = await import("../src/persistence/migrations.js");
  const { simulation } = await import("../src/engine.js");
  const coreOnly = assembleContent(CORE_CONTENT, []);
  const old = JSON.parse(JSON.stringify(createInitialState({ content: coreOnly, seed: 7 })));
  delete old.mods;
  const loaded = migrateSave(old, CONTENT);
  for (const modContent of Object.values(CONTENT.modStates || {})) assert.ok(modContent);
  for (const id of Object.keys(CONTENT.modStates || {})) assert.ok(loaded.mods[id], `补出 mods.${id}`);
  for (const [townId, profile] of Object.entries(CONTENT.outsideTowns)) {
    for (const itemId of Object.keys(profile.goods)) assert.ok(Number.isFinite(loaded.outsideTowns[townId].stocks[itemId]), `${townId}.${itemId}`);
  }
  for (let i = 0; i < 5; i++) simulation.advanceDay(loaded);
  assert.equal(simulation.validateState(loaded).valid, true, simulation.validateState(loaded).errors.join("；"));
});
