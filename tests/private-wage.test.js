// 民营工资：参照价（townWageRate / privateWageRate）、民营实发、选择器行、定期调薪、换主人清除。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { addInventory } from "../src/economy/inventory.js";
import { currencyScale } from "../src/economy/currency.js";
import { householdList, isActiveHousehold } from "../src/systems/households.js";
import { transferBuildingOwnership } from "../src/systems/ownership.js";
import { townWageRate, privateWageRate, wageControlFactor } from "../src/systems/payroll.js";
import { payPrivateIndustryWages } from "../src/systems/private-industry.js";
import { adjustPrivateWage } from "../src/systems/private-wage.js";
import { ensureWageControl } from "../src/systems/payroll.js";
import { readJobCount, selectJobRows } from "../src/selectors/labor.js";

const SCALE = CONTENT.precision.inventoryUnitsPerJin;
const scale = currencyScale(CONTENT);

function freePlot(state, feature = null) {
  return state.plots.find(row => (feature ? row.feature === feature : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
}

// 直接放一栋镇营建筑（不经施工）。
function addTownBuilding(state, typeId, id) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = freePlot(state, required);
  assert.ok(plot, `缺少地块 ${typeId}`);
  const building = { id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    materialInvestments: [], plotId: plot.id, x: plot.x, y: plot.y, completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  return building;
}

function activeHousehold(state, index = 0) {
  return householdList(state).filter(isActiveHousehold)[index];
}

// 把一栋建筑转给一户并返回其民营岗位行（招人用）。
function makePrivate(state, building, householdId) {
  transferBuildingOwnership(state, building, { kind: "household", id: householdId }, CONTENT);
  return selectJobRows(state, CONTENT).rows.find(row => row.buildingId === building.id && row.scope === "private");
}

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

// 把日结序号设为 serial（year/day 合法）。
function setSerial(state, serial) {
  const days = CONTENT.rules.daysPerYear || 365;
  state.year = Math.floor((serial - 1) / days) + 1;
  state.day = ((serial - 1) % days) + 1;
}

function millJob() {
  return CONTENT.buildings.mill.jobs[0];
}

test("industry wage control x2 lifts a freshly privatised mill's rate to townWageRate, and payroll accrues it", () => {
  const state = simulation.createInitialState();
  ensureWageControl(state).industry = 2;
  const job = millJob();
  const mill = addTownBuilding(state, "mill", "test-mill");
  const owner = activeHousehold(state);
  const row = makePrivate(state, mill, owner.id);
  assert.ok(row, "民营行存在");

  const base = CONTENT.buildings.mill.jobs[0].wagePerWorkerDay;
  assert.equal(wageControlFactor(state, job.id), 2);
  const town = townWageRate(state, job.id, CONTENT);
  assert.equal(town, (state.employment.wageRates?.[job.id] ?? base) * 2);
  assert.equal(privateWageRate(state, mill, job, CONTENT), town, "没调过的民营建筑取镇营同岗位实际日薪");
  assert.equal(mill.privateWage, undefined, "没有业主设定时不写 privateWage");

  // 民营岗位由经营计划自动安排（不能手动 setEmployment），跑几天让日结派工。
  for (let day = 0; day < 3; day++) simulation.advanceDay(state);
  const workers = readJobCount(state, row.key);
  assert.ok(workers > 0, "日结后民营磨坊应有在岗工人");
  const paid = payPrivateIndustryWages(state, CONTENT).find(item => item.buildingId === mill.id);
  assert.ok(paid, "民营建筑参与实发");
  assert.equal(paid.workers, workers);
  assert.equal(paid.dueVoucherUnits, Math.round(workers * town * scale));
  assertValid(state, "industry x2");
});

test("selectJobRows: town rows carry base x control factor, private rows carry privateWageRate", () => {
  const state = simulation.createInitialState();
  ensureWageControl(state).industry = 1.5;
  const town = addTownBuilding(state, "mill", "town-mill");
  
  const priv = addTownBuilding(state, "lumberyard", "priv-yard");
  const row = makePrivate(state, priv, activeHousehold(state).id);
  const rows = selectJobRows(state, CONTENT).rows;

  const townRow = rows.find(item => item.buildingId === town.id && item.scope === "building");
  assert.ok(townRow, "镇营磨坊行存在");
  const base = state.employment.wageRates?.[townRow.roleId] ?? CONTENT.roles?.[townRow.roleId]?.wagePerWorkerDay
    ?? CONTENT.buildings.mill.jobs[0].wagePerWorkerDay;
  assert.equal(townRow.effectiveWagePerWorkerDay, base * 1.5);

  const privRow = rows.find(item => item.key === row.key);
  assert.ok(privRow, "民营行存在");
  assert.equal(privRow.effectiveWagePerWorkerDay, privateWageRate(state, priv, CONTENT.buildings.lumberyard.jobs[0], CONTENT));
  assert.equal(privRow.wagePerWorkerDay, privRow.effectiveWagePerWorkerDay);
});

test("adjustPrivateWage: arrears cut the wage after the interval, never below the floor", () => {
  const state = simulation.createInitialState();
  const mill = addTownBuilding(state, "mill", "arrears-mill");
  const owner = activeHousehold(state);
  makePrivate(state, mill, owner.id);
  const job = millJob();
  const reference = townWageRate(state, job.id, CONTENT);
  const interval = CONTENT.rules.privateWageAdjustIntervalDays;
  const floor = Math.round(reference * CONTENT.rules.privateWageFloorPercent / 100 * 2) / 2;

  setSerial(state, 1);
  assert.equal(adjustPrivateWage(state, mill, CONTENT), null, "第一次调用只记 lastSerial");
  state.privateEconomy ||= {}; state.privateEconomy.payrollByBuilding ||= {};
  state.privateEconomy.payrollByBuilding[mill.id] = { arrearsVoucherUnits: 5 * scale };

  setSerial(state, 1 + interval - 1);
  assert.equal(adjustPrivateWage(state, mill, CONTENT), null, "间隔内不调");
  assert.equal(mill.privateWage.wagePerWorkerDay ?? null, null, "间隔内不写新工资");

  let last = privateWageRateOf(state, mill, job);
  setSerial(state, 1 + interval);
  const first = adjustPrivateWage(state, mill, CONTENT);
  assert.ok(first, "跨过间隔后调薪");
  assert.ok(first.wage < last, `欠薪应减薪：${last} -> ${first.wage}`);
  assert.ok(first.wage >= floor);
  last = first.wage;

  for (let step = 2; step <= 30; step++) {
    setSerial(state, 1 + interval * step);
    const result = adjustPrivateWage(state, mill, CONTENT);
    assert.ok(result.wage >= floor, `不得低于下限 ${floor}`);
    assert.ok(result.wage <= last, "欠薪期间工资不回升");
    last = result.wage;
  }
  assert.equal(last, floor, "长期欠薪最终停在下限");
  assertValid(state, "arrears");
});

function privateWageRateOf(state, building, job) {
  return privateWageRate(state, building, job, CONTENT);
}

test("adjustPrivateWage: sustained positive profit below target raises the wage; interval holds it", () => {
  const state = simulation.createInitialState();
  const mill = addTownBuilding(state, "mill", "profit-mill");
  makePrivate(state, mill, activeHousehold(state).id);
  const job = millJob();
  const interval = CONTENT.rules.privateWageAdjustIntervalDays;
  const reference = townWageRate(state, job.id, CONTENT);

  setSerial(state, 1);
  adjustPrivateWage(state, mill, CONTENT);
  // 工资压在行情之下，确保有加薪空间。
  mill.privateWage = { wagePerWorkerDay: Math.max(0.5, reference * 0.5), lastSerial: 1 };
  const before = mill.privateWage.wagePerWorkerDay;

  setSerial(state, 1 + interval);
  mill.privateProfitHistory = [{ serial: 1 + interval, profitVoucherUnits: 1000 * scale, workers: 1 }];
  const raised = adjustPrivateWage(state, mill, CONTENT);
  assert.ok(raised, "跨过间隔后调薪");
  assert.ok(raised.wage > before, `正利润且低于行情应加薪：${before} -> ${raised.wage}`);
  assert.ok(raised.wage <= raised.target, "加薪不超过行情目标");

  // 间隔内再次调用不动。
  const wageNow = mill.privateWage.wagePerWorkerDay;
  setSerial(state, 1 + interval + 1);
  assert.equal(adjustPrivateWage(state, mill, CONTENT), null);
  assert.equal(mill.privateWage.wagePerWorkerDay, wageNow);
  assertValid(state, "profit");
});

test("transferring the building clears privateWage (town and another household)", () => {
  const state = simulation.createInitialState();
  const mill = addTownBuilding(state, "mill", "xfer-mill");
  const [first, second] = householdList(state).filter(isActiveHousehold);
  makePrivate(state, mill, first.id);
  mill.privateWage = { wagePerWorkerDay: 7.5, lastSerial: 3, target: 8, diagnosis: "test" };

  transferBuildingOwnership(state, mill, { kind: "household", id: second.id }, CONTENT);
  assert.equal(mill.privateWage, undefined, "转给另一户后清除");

  mill.privateWage = { wagePerWorkerDay: 6, lastSerial: 3 };
  transferBuildingOwnership(state, mill, { kind: "town" }, CONTENT);
  assert.equal(mill.privateWage, undefined, "转回镇营后清除");
  assertValid(state, "transfer");
});

test("60 simulated days with a private mill and a private lumberyard stay valid with finite non-negative wages", () => {
  const state = simulation.createInitialState();
  addInventory(state, "town", "wood", 1200, "test market stock", "test", CONTENT);
  const market = simulation.buildAt(state, "wholesale_market", "village-01");
  assert.equal(market.ok, true, market.reason);
  simulation.advanceDays(state, 60);
  const mill = addTownBuilding(state, "mill", "run-mill");
  const yard = addTownBuilding(state, "lumberyard", "run-yard");
  const h1 = activeHousehold(state, 0), h2 = activeHousehold(state, 1);
  makePrivate(state, mill, h1.id);
  makePrivate(state, yard, h2.id);

  for (let day = 0; day < 60; day++) {
    simulation.advanceDay(state);
    for (const building of [mill, yard]) {
      const rate = privateWageRate(state, building, CONTENT.buildings[building.typeId].jobs[0], CONTENT);
      assert.ok(Number.isFinite(rate) && rate >= 0, `第 ${day + 1} 天民营工资非法：${rate}`);
      const stored = building.privateWage?.wagePerWorkerDay;
      if (stored !== undefined) assert.ok(Number.isFinite(stored) && stored >= 0, `第 ${day + 1} 天业主日薪非法：${stored}`);
    }
    assertValid(state, `day ${day + 1}`);
  }
});
