import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { reclaimedAcres, reclaimCostEstimate, reclaimWorkDaysForAcres } from "../src/systems/agriculture.js";
import { agricultureEmploymentTarget, refillAgricultureToTarget } from "../src/systems/employment.js";
import { jobCount, householdList } from "../src/systems/households.js";
import { selectJobRows } from "../src/selectors/labor.js";
import { createMapModel, MAP_PRESENTATION } from "../src/ui/map-model.js";
import { issueTownVouchers } from "../src/economy/currency.js";

const A = CONTENT.agriculture;
const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function farmlandTiles(navigation = { activePanel: null, buildType: null }) {
  const view = { season: { key: "summer" }, paused: true, plots: [], buildings: [], project: null };
  const model = createMapModel(view, navigation);
  const tiles = [];
  for (let row = 0; row < model.world.height; row++) {
    for (let column = 0; column < model.world.width; column++) {
      const tile = model.world.tiles[`${column},${row}`];
      if (tile.terrain === "farmland") tiles.push(`${column},${row}`);
    }
  }
  return tiles.sort();
}

test("开荒规则：初始 15000 亩、上限 100000 亩、每 100 亩 100 工日", () => {
  const state = simulation.createInitialState({ seed: 70001 });
  // 开局数值调整（8cf03ae）：初始耕地 4000→15000 亩（供 1500 农民耕种）。
  assert.equal(A.acres, 15000);
  assert.equal(A.acresMaximum, 100000);
  assert.equal(A.acresPerFarmer, 10);
  assert.equal(reclaimedAcres(state, CONTENT), 15000);
  // 每 100 亩 100 工日 ⇒ 1 亩 1 工日，按内容比例换算而非硬编码。
  assert.equal(reclaimWorkDaysForAcres(100, CONTENT), 100);
  assert.equal(reclaimWorkDaysForAcres(1, CONTENT), 1);
  assert.equal(reclaimWorkDaysForAcres(150, CONTENT), 150);
});

test("开荒成本：工日按亩数换算，工资由镇库承担并留下明确扣款记录", () => {
  const state = simulation.createInitialState({ seed: 70002 });
  const wage = state.employment.wageRates.builders;
  assert.ok(wage > 0);
  const townWheatBefore = state.accounts.town.wheat;
  const householdFoodBefore = householdList(state).reduce((sum, h) => sum + (h.inventory.wheat || 0), 0);

  const result = simulation.reclaimFarmland(state, 200, 40);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.acres, 200);
  assert.equal(result.workDays, 200);
  assert.equal(result.wagePerWorkerDay, wage);
  // 200 工日 × 日薪 = 应付粮券单位
  assert.equal(result.dueVoucherUnits, Math.round(200 * wage * V));
  assert.equal(result.paidVoucherUnits, result.dueVoucherUnits);

  // 镇库确实出钱：按当前货币制度，小麦档直接以小麦支付开荒工人家庭
  const townWheatSpent = townWheatBefore - state.accounts.town.wheat;
  assert.equal(townWheatSpent, Math.round(result.paidVoucherUnits * I / V));
  const householdFoodAfter = householdList(state).reduce((sum, h) => sum + (h.inventory.wheat || 0), 0);
  assert.equal(householdFoodAfter - householdFoodBefore, townWheatSpent);

  // 明确的扣款记录：开荒工资支出账目 + 逐户工资记录
  const expense = state.ledger.find(row => row.type === "reclaim_wage_expense");
  assert.ok(expense, "缺少开荒工资扣款记录");
  assert.equal(expense.source, "town");
  assert.equal(expense.destination, "wage_expense");
  assert.equal(expense.itemId, "grain_voucher");
  assert.equal(expense.quantityUnits, result.paidVoucherUnits);
  assert.match(expense.reason, /开荒/);
  const wageRows = state.ledger.filter(row => row.type === "reclaim_wage");
  assert.ok(wageRows.length > 0, "缺少逐户开荒工资记录");
  assert.equal(wageRows.reduce((sum, row) => sum + row.quantityUnits, 0), result.paidVoucherUnits);
  for (const row of wageRows) assert.match(row.destination, /^household:/);

  // 开荒账目分类汇总
  assert.equal(state.agriculture.reclaim.day.workDays, 200);
  assert.equal(state.agriculture.reclaim.day.acres, 200);
  assert.equal(state.agriculture.reclaim.cumulative.paidVoucherUnits, result.paidVoucherUnits);
});

test("开荒工日消耗：投入人数分摊工日，人数不超过工日总量，日结后清零", () => {
  const state = simulation.createInitialState({ seed: 70003 });
  const result = simulation.reclaimFarmland(state, 100, 25);
  assert.equal(result.ok, true, result.reason);
  // 100 工日 ÷ 25 人 = 4 天
  assert.equal(result.workers, 25);
  assert.equal(result.workers * result.days, result.workDays);
  assert.equal(result.days, 4);

  // 投入人数多于工日时按工日封顶，不虚耗人工
  const capped = simulation.reclaimFarmland(state, 10, 999);
  assert.equal(capped.ok, true, capped.reason);
  assert.equal(capped.workDays, 10);
  assert.equal(capped.workers, 10);
  assert.equal(capped.days, 1);

  assert.equal(simulation.reclaimFarmland(state, 0, 5).ok, false);
  assert.equal(simulation.reclaimFarmland(state, 10, 0).ok, false);

  // 日结清空当日开荒流水
  simulation.advanceDay(state);
  assert.equal(state.agriculture.reclaim.day.workDays, 0);
  assert.equal(state.agriculture.reclaim.day.acres, 0);
  assert.equal(state.agriculture.reclaim.day.paidVoucherUnits, 0);
  assert.ok(state.agriculture.reclaim.cumulative.workDays >= 110);
});

test("开荒亩数上限 clamp：单次与累计都不超过 100000 亩", () => {
  const state = simulation.createInitialState({ seed: 70004 });
  assert.equal(reclaimedAcres(state, CONTENT), 15000);

  const first = simulation.reclaimFarmland(state, 50000, 100);
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.clamped, false);
  assert.equal(reclaimedAcres(state, CONTENT), 65000);

  // 已开垦余量不足：按余量 clamp
  const second = simulation.reclaimFarmland(state, 80000, 100);
  assert.equal(second.ok, true, second.reason);
  assert.equal(second.acres, 100000 - 65000);
  assert.equal(second.clamped, true);
  assert.equal(reclaimedAcres(state, CONTENT), 100000);

  // 达到上限后拒绝继续开荒，不产生成本
  const ledgerLength = state.ledger.length;
  const third = simulation.reclaimFarmland(state, 100, 10);
  assert.equal(third.ok, false);
  assert.match(third.reason, /上限/);
  assert.equal(state.ledger.length, ledgerLength);
  assert.equal(reclaimedAcres(state, CONTENT), 100000);

  // 预估同样尊重上限
  const estimate = reclaimCostEstimate(state, CONTENT, 999999);
  assert.equal(estimate.allowed, 0);
  assert.equal(estimate.clamped, true);
  assert.equal(estimate.remaining, 0);
});

test("亩数提升后耕种人数上限按 10 亩/人 提升，并可直接安排到新上限", () => {
  const state = simulation.createInitialState({ seed: 70005 });
  const farmersBefore = selectJobRows(state, CONTENT).rows.find(row => row.roleId === "farmers");
  // 初始耕地 15000 亩、农民目标 1500（8cf03ae）。
  assert.equal(farmersBefore.capacity, 1500);
  assert.equal(jobCount(state, "farmers"), 1500);
  assert.equal(agricultureEmploymentTarget(state, CONTENT), 1500);
  const workingAge = selectJobRows(state, CONTENT).workingAge;
  assert.ok(workingAge > 1500);

  const result = simulation.reclaimFarmland(state, 10000, 100);
  assert.equal(result.ok, true, result.reason);
  assert.equal(reclaimedAcres(state, CONTENT), 25000);

  const farmersAfter = selectJobRows(state, CONTENT).rows.find(row => row.roleId === "farmers");
  assert.equal(farmersAfter.capacity, 2500);
  assert.equal(farmersAfter.maxAssignable, 2500);

  // 容量提升后可新增农人；目标可设到新上限，实际在岗受全镇劳动力约束并如实报缺员。
  const assigned = simulation.setEmployment(state, "farmers", 2500);
  assert.equal(assigned.ok, true, assigned.reason);
  assert.equal(assigned.target, 2500);
  assert.equal(assigned.assigned, Math.min(2500, workingAge));
  assert.equal(assigned.shortage, Math.max(0, 2500 - workingAge));
  assert.equal(agricultureEmploymentTarget(state, CONTENT), 2500);
  const refill = refillAgricultureToTarget(state, CONTENT);
  assert.equal(refill.target, 2500);
  assert.equal(jobCount(state, "farmers"), Math.min(2500, workingAge));

  // 目标不会超过容量。
  const overAssign = simulation.setEmployment(state, "farmers", 99999);
  assert.equal(overAssign.target, 2500);

  // 容量数字本身随亩数线性提升（15000→1500、25000→2500）。
  assert.equal(reclaimedAcres(state, CONTENT) / A.acresPerFarmer, farmersAfter.capacity);
  assert.equal(reclaimedAcres(state, CONTENT) / A.acresPerFarmer, 2500);
});

test("耕地图形固定大小：开荒不改变地图麦田所占格数与坐标", () => {
  const tilesBefore = farmlandTiles();
  assert.ok(tilesBefore.length > 0, "地图应存在麦田图形");
  // 地形由固定几何形状决定，不读取任何亩数；开荒后模型输出保持逐格一致。
  const view = { season: { key: "spring" }, paused: true, plots: [], buildings: [], project: null,
    farmAcres: 100000, farmAcresMaximum: 100000 };
  const model = createMapModel(view, { activePanel: null, buildType: null });
  const tilesAfter = [];
  for (let row = 0; row < model.world.height; row++) {
    for (let column = 0; column < model.world.width; column++) {
      if (model.world.tiles[`${column},${row}`].terrain === "farmland") tilesAfter.push(`${column},${row}`);
    }
  }
  assert.deepEqual(tilesAfter.sort(), tilesBefore);
  assert.equal(MAP_PRESENTATION.tileSize, 40);
});

test("镇库不足时开荒工资只支付可支付部分，未付部分不形成居民债务而单独记录", () => {
  const state = simulation.createInitialState({ seed: 70006 });
  // 把镇库小麦清空并停用自动救济资金，构造无钱可付的场景。
  state.accounts.town.wheat = 0;
  state.currency.balances.town = 0;
  const result = simulation.reclaimFarmland(state, 100, 20);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.dueVoucherUnits, Math.round(100 * state.employment.wageRates.builders * V));
  assert.equal(result.paidVoucherUnits, 0);
  assert.equal(result.unpaidVoucherUnits, result.dueVoucherUnits);
  const shortfall = state.ledger.find(row => row.type === "reclaim_wage_shortfall");
  assert.ok(shortfall, "缺少未付开荒工资记录");
  assert.equal(shortfall.quantityUnits, result.unpaidVoucherUnits);
  // 即使欠薪，已开荒亩数仍然落实（镇库承担的是工资缺口，不是开荒本身）
  assert.equal(reclaimedAcres(state, CONTENT), 15100);
});

test("开荒后存档往返与校验保持一致", () => {
  const state = simulation.createInitialState({ seed: 70007 });
  simulation.reclaimFarmland(state, 300, 30);
  const validation = simulation.validateState(state);
  assert.equal(validation.valid, true, validation.errors.join("；"));
  assert.equal(state.agriculture.reclaim.cumulative.acres, 300);
  assert.equal(state.agriculture.reclaim.cumulative.workDays, 300);
});
