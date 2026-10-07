import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { householdList, householdPopulation } from "../src/systems/households.js";
import { accrueGoodsDemand, consumeGoods, goodsComfortPoints } from "../src/systems/goods-demand.js";
import { isIndustryType, industryTypeIds } from "../src/content/buildings.js";

const I = CONTENT.precision.inventoryUnitsPerJin;

test("新产业由建筑定义推导：酒坊、棉田、织坊与原四产业同等可民营/成立公司", () => {
  for (const typeId of ["mill", "bakery", "lumberyard", "saltworks", "winery", "cotton_field", "weaving_mill"]) {
    assert.ok(isIndustryType(CONTENT, typeId), typeId);
  }
  const order = industryTypeIds(CONTENT);
  assert.ok(order.indexOf("cotton_field") < order.indexOf("weaving_mill"), "原料产业排在加工产业前");
  assert.ok(order.indexOf("mill") < order.indexOf("bakery"));
});

test("酒、布按人口产生日需求；家里有就用掉并加舒心值，没有不扣分", () => {
  const state = simulation.createInitialState({ seed: 5501 });
  const people = householdList(state).reduce((sum, h) => sum + householdPopulation(h), 0);
  accrueGoodsDemand(state, people, CONTENT);
  const expectedCloth = Math.floor(people * CONTENT.rules.householdGoods.cloth.annualPerPerson * I / CONTENT.rules.daysPerYear);
  assert.equal(state.goodsDemand.todayDemandUnits.cloth, expectedCloth);

  const household = householdList(state)[0];
  const n = householdPopulation(household);
  assert.equal(goodsComfortPoints(state, household, n, {}, CONTENT), 0, "没有酒和布时没有加成，也不扣分");
  household.inventory.cloth = 10 * I;
  household.inventory.wine = 10 * I;
  consumeGoods(state, CONTENT);
  const life = household.life.day;
  assert.ok(life.clothConsumedUnits > 0 && life.wineConsumedUnits > 0);
  const points = goodsComfortPoints(state, household, n, life, CONTENT);
  const max = Object.values(CONTENT.rules.householdGoods).reduce((sum, row) => sum + row.comfortMaximum, 0);
  assert.ok(points > max * 0.9 && points <= max + 1e-9, `满足当日份额应接近满额加成，实际${points}`);
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
