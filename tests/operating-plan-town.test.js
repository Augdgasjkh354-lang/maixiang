import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount } from "../src/systems/households.js";
import { refreshOperatingPlan } from "../src/economy/operating-plan.js";
import { jobKeyForBuilding } from "../src/selectors/labor.js";
import { townWheatReserveUnits } from "../src/selectors/production.js";
import { grantResidentVouchers } from "./helpers-v16.js";

// 运营计划与镇营产业：镇营作坊不派工，但它的投入需求与产出要计入计划的上下游口径（审计问题 5）。
// (B) 私营磨坊 + 镇营面包房：面包房的面粉需求要传给磨坊，磨坊不能因为"没人要面粉"停产。
// (C) 镇营磨坊 + 私营面包房：磨坊的面粉产出要算作面包房的原料来源，面包房不能因为"没有面粉"计划零批。

const I = CONTENT.precision.inventoryUnitsPerJin;

function addBuilding(state, typeId, id, { level = 1, townLevels = level, privateLevels = 0 } = {}) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) &&
    !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `缺少地块 ${typeId}`);
  state.buildings.push({ id, typeId, level, ownership: { townLevels, privateLevels, listedLevels: 0 }, plotId: plot.id,
    x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
}

// 批发市场 + 居民有钱（有面包需求）+ 镇库有足量小麦（磨坊用）。私营业主的计划视为已过试营业期，免得试营业的 1 批干扰比较。
function baseState({ seed }) {
  const state = simulation.createInitialState({ seed });
  assert.equal(grantResidentVouchers(state, 300000, CONTENT).ok, true);
  addBuilding(state, "wholesale_market", "town-market", { level: 1, townLevels: 1 });
  state.accounts.town.wheat += (townWheatReserveUnits(state, CONTENT) + 20000 * I);
  return state;
}

function matureSince(state, buildingId) {
  state.privateEconomy.plans[buildingId] = { ageDays: 30 };
}

function planFor(state, key) {
  refreshOperatingPlan(state, CONTENT, true);
  return state.market.operatingPlan.rows[key];
}

test("镇营面包房不进计划的派工行，但私营磨坊能看到它的面粉需求", () => {
  const state = baseState({ seed: 8101 });
  addBuilding(state, "mill", "private-mill", { level: 1, townLevels: 0, privateLevels: 1 });
  addBuilding(state, "bakery", "town-bakery", { level: 1, townLevels: 1 });
  setJobCount(state, jobKeyForBuilding("town-bakery", "bakers"), 10, CONTENT);
  matureSince(state, "private-mill");

  const plan = refreshOperatingPlan(state, CONTENT, true);
  assert.equal(plan.rows["private:private-mill"] !== undefined, true, "私营磨坊有计划行");
  assert.equal(Object.keys(plan.rows).some(key => key.includes("town-bakery")), false, "镇营面包房不进派工计划");
  assert.ok(plan.demand.bakery.townBatches > 0, "镇营面包房有预计批次");

  const mill = plan.rows["private:private-mill"];
  assert.ok(plan.demand.mill.demandUnits > 0, "面包房的面粉需求传给磨坊");
  assert.ok(mill.plannedBatches > 0, "磨坊因下游面粉需求继续开工");
  assert.ok(mill.desiredWorkers > 0, "磨坊保留人手");
});

test("镇营面包房没有人手时不产生面粉需求（需求随镇营实际投产口径）", () => {
  const state = baseState({ seed: 8102 });
  addBuilding(state, "mill", "private-mill", { level: 1, townLevels: 0, privateLevels: 1 });
  addBuilding(state, "bakery", "town-bakery", { level: 1, townLevels: 1 });
  matureSince(state, "private-mill");
  const plan = refreshOperatingPlan(state, CONTENT, true);
  assert.equal(plan.demand.bakery.townBatches, 0, "无人手的镇营面包房预计产量为零");
  assert.equal(plan.demand.mill.demandUnits, 0, "无需求时磨坊没有面粉需求");
  assert.equal(plan.rows["private:private-mill"].plannedBatches, 0, "无需求时磨坊不计划批次");
});

test("镇营磨坊的面粉产出计入私营面包房的原料来源，面包房能计划批次", () => {
  const state = baseState({ seed: 8103 });
  addBuilding(state, "mill", "town-mill", { level: 1, townLevels: 1 });
  setJobCount(state, jobKeyForBuilding("town-mill", "millers"), 6, CONTENT);
  addBuilding(state, "bakery", "private-bakery", { level: 1, townLevels: 0, privateLevels: 1 });
  matureSince(state, "private-bakery");

  const plan = refreshOperatingPlan(state, CONTENT, true);
  assert.ok(plan.demand.mill.townBatches > 0, "镇营磨坊有预计批次");
  assert.ok(plan.plannedOutputUnits.flour > 0, "镇营磨坊的面粉产出计入下游可用的原料");
  assert.equal(Object.keys(plan.rows).some(key => key.includes("town-mill")), false, "镇营磨坊不进派工计划");
  const bakery = plan.rows["private:private-bakery"];
  assert.ok(bakery.plannedBatches > 0, "私营面包房有计划批次");
});

test("镇营磨坊无人手时，私营面包房仍因没有面粉来源而零批（对照组）", () => {
  const state = baseState({ seed: 8104 });
  addBuilding(state, "mill", "town-mill", { level: 1, townLevels: 1 });
  addBuilding(state, "bakery", "private-bakery", { level: 1, townLevels: 0, privateLevels: 1 });
  matureSince(state, "private-bakery");
  const plan = refreshOperatingPlan(state, CONTENT, true);
  assert.equal(plan.plannedOutputUnits.flour || 0, 0);
  assert.equal(plan.rows["private:private-bakery"].plannedBatches, 0);
});
