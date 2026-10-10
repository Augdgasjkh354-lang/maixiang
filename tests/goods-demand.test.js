import test from "node:test";
import { householdAffluence, householdWealthUnits, invalidateHouseholdBudgets } from "../src/systems/household-budget.js";
import { voucherWealthForAffluence } from "./budget-fixture.js";

import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { householdList, householdPopulation, syncResidentAggregates } from "../src/systems/households.js";
import { accrueGoodsDemand, consumeGoods, goodsComfortPoints, standardDailyUnits } from "../src/systems/goods-demand.js";
import { isIndustryType, industryTypeIds } from "../src/content/buildings.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

test("新产业由建筑定义推导：酒坊、棉田、织坊与原四产业同等可民营/成立公司", () => {
  for (const typeId of ["mill", "bakery", "lumberyard", "saltworks", "winery", "cotton_field", "weaving_mill"]) {
    assert.ok(isIndustryType(CONTENT, typeId), typeId);
  }
  const order = industryTypeIds(CONTENT);
  assert.ok(order.indexOf("cotton_field") < order.indexOf("weaving_mill"), "原料产业排在加工产业前");
  assert.ok(order.indexOf("mill") < order.indexOf("bakery"));
});

test("日用品需求跟家底走：没家底的不买，越宽裕买得越多；用够标准量满额加成，多用边际递减", () => {
  const state = simulation.createInitialState({ seed: 5501 });
  const [poor, normal, rich] = householdList(state);
  for (const h of householdList(state)) h.voucherUnits = 0;
  normal.voucherUnits = voucherWealthForAffluence(state, normal, 1, CONTENT);
  rich.voucherUnits = voucherWealthForAffluence(state, rich, 3, CONTENT);
  for (const h of [poor, normal, rich]) h.inventory.wheat = 0;
  syncResidentAggregates(state, CONTENT);
  invalidateHouseholdBudgets(state);
  assert.equal(householdAffluence(state, poor, CONTENT), 0);
  assert.ok(Math.abs(householdAffluence(state, normal, CONTENT) - 1) < 1e-3, "可动用预算等于参照预算时宽裕度为 1");
  assert.ok(Math.abs(householdAffluence(state, rich, CONTENT) - 3) < 1e-3, "宽裕度 3 的家底（只靠家底）");

  accrueGoodsDemand(state, 0, CONTENT);
  for (const h of [poor, normal, rich]) for (const itemId of Object.keys(CONTENT.rules.householdGoods)) h.inventory[itemId] = 1000 * I;
  consumeGoods(state, CONTENT);
  const cfg = CONTENT.rules.householdGoods.wine;
  const standard = h => standardDailyUnits(householdPopulation(h), cfg, CONTENT);
  assert.equal(poor.life?.day?.wineConsumedUnits || 0, 0, "没家底不喝酒");
  assert.equal(normal.life.day.wineConsumedUnits, Math.floor(standard(normal)));
  assert.ok(Math.abs(rich.life.day.wineConsumedUnits - Math.floor(standard(rich) * Math.pow(3, cfg.incomeElasticity))) <= 1, "富户按 3^弹性 倍消费");

  const max = Object.values(CONTENT.rules.householdGoods).reduce((sum, row) => sum + row.comfortMaximum, 0);
  assert.equal(goodsComfortPoints(state, poor, householdPopulation(poor), poor.life?.day || {}, CONTENT), 0, "没有日用品不加分也不扣分");
  const normalPoints = goodsComfortPoints(state, normal, householdPopulation(normal), normal.life.day, CONTENT);
  assert.ok(normalPoints > max * 0.95 && normalPoints <= max * 1.01, `标准量接近满额，实际${normalPoints}`);
  const richPoints = goodsComfortPoints(state, rich, householdPopulation(rich), rich.life.day, CONTENT);
  assert.ok(richPoints > normalPoints && richPoints <= max * 1.5 + 1e-9, "多用多加，但最多 1.5 倍");
});

test("家底只扣 30 天口粮：存粮只够 30 天口粮的人家没有家底，多出来的小麦才算", () => {
  const state = simulation.createInitialState({ seed: 5503 });
  const h = householdList(state)[0];
  h.voucherUnits = 0;
  const people = householdPopulation(h);
  const keepDays = CONTENT.rules.householdBudget.wealthFoodReserveDays;
  h.inventory.wheat = people * CONTENT.rules.foodPerPersonDay * keepDays * I;
  for (const itemId of ["flour", "bread"]) h.inventory[itemId] = 0;
  assert.equal(householdWealthUnits(state, h, CONTENT), 0);
  h.inventory.wheat += 600 * people * I;
  assert.ok(householdWealthUnits(state, h, CONTENT) > 0, "多出来的小麦才算家底");
});

test("秋收前存粮 300 天口粮的人家有宽裕度，秋收前后宽裕度不跳变", () => {
  const state = simulation.createInitialState({ seed: 5504 });
  const h = householdList(state)[0];
  h.voucherUnits = 0;
  const people = householdPopulation(h);
  h.inventory.wheat = people * CONTENT.rules.foodPerPersonDay * 300 * I;
  for (const itemId of ["flour", "bread"]) h.inventory[itemId] = 0;
  state.day = 200; // 距秋收还有约 74 天
  invalidateHouseholdBudgets(state);
  const before = householdAffluence(state, h, CONTENT);
  assert.ok(before > 0, `秋收前存粮 300 天口粮应有宽裕度，实际 ${before}`);
  state.day = 300; // 已过秋收
  invalidateHouseholdBudgets(state);
  const after = householdAffluence(state, h, CONTENT);
  assert.ok(after > 0);
  const ratio = Math.max(before, after) / Math.min(before, after);
  assert.ok(ratio < 2, `秋收前后宽裕度不应跳变：秋收前 ${before}，秋收后 ${after}`);
});

test("镇营酒坊用镇库小麦酿酒，棉田产棉，织坊用棉织布", () => {
  const state = simulation.createInitialState({ seed: 5502 });
  const plots = state.plots.filter(p => !p.feature);
  ["wholesale_market", "winery", "cotton_field", "weaving_mill"].forEach((typeId, i) => {
    state.buildings.push({ id: `${typeId}-t`, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
      plotId: plots[i].id, x: plots[i].x, y: plots[i].y, materialInvestments: [], completed: { year: 1, day: 1 } });
  });
  simulation.setEmployment(state, "winery-t::brewers", 2);
  simulation.setEmployment(state, "cotton_field-t::cotton_farmers", 4);
  simulation.setEmployment(state, "weaving_mill-t::weavers", 2);
  simulation.setEmployment(state, `wholesale_market-t::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 1);
  simulation.advanceDays(state, 5);
  const stock = itemId => (state.accounts.town[itemId] || 0) + (state.wholesaleMarket?.inventory?.[itemId] || 0);
  assert.ok(stock("wine") > 0, "应产出酒");
  assert.ok(stock("cloth") > 0, "应产出布");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});
