import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount } from "../src/systems/households.js";
import { refreshOperatingPlan } from "../src/economy/operating-plan.js";
import { grantResidentVouchers } from "./helpers-v16.js";

// 运营计划稳定性：市面库存口径、备货缺口分期补齐、用工每周期限速与死区。
// 口径同 ownership-tax.test.js：直接在空地放一座建成的建筑，跳过开工流程。

const I = CONTENT.precision.inventoryUnitsPerJin;
const PER_BATCH = CONTENT.recipes[CONTENT.buildings.saltworks.recipeId].outputs[0].quantity * I;
const TARGET_DAYS = CONTENT.rules.producerInventoryTargetDays;
const CORRECTION_DAYS = CONTENT.rules.operatingStockCorrectionDays;

function addBuilding(state, typeId, id, { level = 1, townLevels = level, privateLevels = 0 } = {}) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) &&
    !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `缺少地块 ${typeId}`);
  state.buildings.push({ id, typeId, level, ownership: { townLevels, privateLevels, listedLevels: 0 }, plotId: plot.id,
    x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
}

// 镇上有批发市场（市面现货只看它）、私营盐场 2 户、居民有钱且当日盐需求 demandJin。
function saltState({ demandJin = 30, wholesaleSaltJin = 0, townSaltJin = 0, privateLevels = 2, seed = 7201 } = {}) {
  const state = simulation.createInitialState({ seed });
  grantResidentVouchers(state, 300000, CONTENT);
  addBuilding(state, "wholesale_market", "stab-wholesale", { level: 1, townLevels: 1 });
  addBuilding(state, "saltworks", "stab-salt", { level: 1, townLevels: 0, privateLevels });
  state.salt.todayDemandUnits = Math.round(demandJin * I);
  if (wholesaleSaltJin) state.wholesaleMarket.inventory.salt = Math.round(wholesaleSaltJin * I);
  if (townSaltJin) state.accounts.town.salt = Math.round(townSaltJin * I);
  return state;
}

function planRow(state, id = "stab-salt") {
  refreshOperatingPlan(state, CONTENT, true);
  return state.market.operatingPlan.rows[`private:${id}`];
}

test("运营计划：镇库存的税实物盐不压低私营盐场计划（有批发市场时只看市面现货）", () => {
  const base = planRow(saltState());
  assert.ok(base.plannedBatches > 0, "基线必须有生产计划，否则比较没有意义");
  const withTownSalt = planRow(saltState({ townSaltJin: 5000 }));
  assert.equal(withTownSalt.plannedBatches, base.plannedBatches, "镇库税实物盐不属于市面现货，计划批次应不变");
  assert.equal(withTownSalt.marketStockUnits, base.marketStockUnits, "市面库存口径不应读到镇库");
});

test("运营计划：批发市场里的同种产品现货会减少计划批次", () => {
  const base = planRow(saltState());
  const stocked = planRow(saltState({ wholesaleSaltJin: 100 }));
  assert.equal(stocked.marketStockUnits, 100 * I, "批发市场库存计入市面现货");
  assert.ok(stocked.plannedBatches > 0 && stocked.plannedBatches < base.plannedBatches,
    `现货 100 斤应减产：${stocked.plannedBatches} vs ${base.plannedBatches}`);
});

test("运营计划：积压时减产按备货缺口的 1/5 分期补齐，不会一次砍到零", () => {
  // 日需求 30 斤、备货 2 天：目标 = 需求 + (30×2 − 现货) / 5。现货 150 斤时缺口 −90 斤，只摊 −18 斤。
  const state = saltState({ demandJin: 30, wholesaleSaltJin: 150 });
  const row = planRow(state);
  const demand = state.market.operatingPlan.demand.saltworks;
  assert.equal(CORRECTION_DAYS, 5, "本测试按 operatingStockCorrectionDays = 5 写算式");
  assert.equal(demand.demandUnits, 30 * I);
  assert.equal(demand.stockUnits, 150 * I);
  const expected = demand.demandUnits + Math.round((Math.round(demand.demandUnits * TARGET_DAYS) - demand.stockUnits) / CORRECTION_DAYS);
  assert.equal(demand.targetUnits, expected, "目标 = 需求 + 备货缺口 / operatingStockCorrectionDays");
  assert.equal(demand.targetUnits, 12 * I, "30 + (60 − 150)/5 = 12 斤");
  assert.equal(row.plannedBatches, Math.ceil(demand.targetUnits / PER_BATCH), "计划批次 = 目标 / 每批产量（向上取整）");
  assert.ok(row.plannedBatches > 0, "积压但有需求时不能立刻停产");
  assert.ok(demand.targetUnits > demand.demandUnits - demand.stockUnits / TARGET_DAYS,
    "若一次补齐缺口，目标应为 0；分期后仍大于 0");
});

test("运营计划：用工每周期最多招 2 人、裁 1 人；10% 以内的差额不折腾", () => {
  // 日需求 100 斤：目标 = 100 + (200 − 现货) / 5。现货 225 斤 → 目标 95 斤 → 19 批 → 需 19 人。
  const want = (workers, stockJin) => {
    const state = saltState({ demandJin: 100, wholesaleSaltJin: stockJin });
    setJobCount(state, "stab-salt::salt_workers::private", workers, CONTENT);
    return planRow(state);
  };

  // 现有 20 人，需 19 人：差 1，≤ floor(20×10%)=2，死区内不动。
  assert.equal(want(20, 225).desiredWorkers, 20, "20 人、需 19 人：死区内维持 20");

  // 现有 20 人，需 17 人：差 3 超过死区，但裁人每周期最多 1 人 → 19。
  assert.equal(want(20, 275).desiredWorkers, 19, "裁人每周期最多 1 人");

  // 现有 5 人，需 20 人以上：招人每周期最多 2 人 → 7。
  assert.equal(want(5, 0).desiredWorkers, 7, "招人每周期最多 2 人");

  // 现有 18 人，需 19 人：floor(18×10%)=1，差 1 在死区内，维持 18。
  assert.equal(want(18, 225).desiredWorkers, 18, "18 人、需 19 人：死区内维持 18");
});
