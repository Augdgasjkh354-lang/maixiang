import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { addInventory } from "../src/economy/inventory.js";
import { setJobCount } from "../src/systems/households.js";
import { readJobCount } from "../src/selectors/labor.js";
import { setProjectWorkers } from "../src/systems/construction.js";
import { exportState, parseSaveFile } from "../src/persistence/storage.js";


function stock(state, wood = 100000) {
  addInventory(state, "town", "wood", wood, "并行建造测试材料", "test", CONTENT);
  return state;
}

function projectById(state, instanceId) {
  return state.projects.find(row => row.instanceId === instanceId);
}

function firstFreePlot(state, exclude = []) {
  return state.plots.find(plot => !plot.feature &&
    !state.buildings.some(b => b.plotId === plot.id) &&
    !state.projects.some(p => p.plotId === plot.id) &&
    !exclude.includes(plot.id));
}

test("可同时开工多个工程（不同地块），互不拒绝", () => {
  const state = stock(simulation.createInitialState({ seed: 41001 }));
  const mill = simulation.buildAt(state, "mill", "east");
  const bakery = simulation.buildAt(state, "bakery", "south");
  const townHall = simulation.buildAt(state, "town_hall", "village-01");
  assert.equal(mill.ok, true, mill.reason);
  assert.equal(bakery.ok, true, bakery.reason);
  assert.equal(townHall.ok, true, townHall.reason);
  assert.equal(state.projects.length, 3);
  assert.deepEqual(state.projects.map(p => p.plotId).sort(), ["east", "south", "village-01"]);
  // 每个工程独立记录投入人数
  for (const project of state.projects) assert.ok(project.workers > 0);
  assert.equal(readJobCount(state, "builders"),
    state.projects.reduce((sum, p) => sum + p.workers, 0));
  assert.equal(simulation.validateState(state).valid, true);
});

test("多工程按各自人数同步推进，完工时间符合 workRequired/workers", () => {
  const state = stock(simulation.createInitialState({ seed: 41002 }));
  // 面包房 400 工日、磨坊 480 工日；分别投入 10 人和 12 人。
  const bakery = simulation.buildAt(state, "bakery", "east", { workers: 10 });
  const mill = simulation.buildAt(state, "mill", "south", { workers: 12 });
  assert.equal(bakery.workers, 10);
  assert.equal(mill.workers, 12);

  simulation.advanceDay(state);
  const bakeryProject = projectById(state, bakery.instanceId);
  const millProject = projectById(state, mill.instanceId);
  // 每日各按自己的人数推进，互不干扰
  assert.equal(bakeryProject.workDone, 10);
  assert.equal(millProject.workDone, 12);

  const bakeryDays = Math.ceil(CONTENT.buildings.bakery.construction.workDays / 10);
  const millDays = Math.ceil(CONTENT.buildings.mill.construction.workDays / 12);
  assert.equal(bakeryDays, 40);
  assert.equal(millDays, 40);
  // 再推进 39 天：两者都应在第 40 天完工
  simulation.advanceDays(state, 39);
  assert.equal(state.projects.length, 0);
  assert.ok(state.buildings.some(b => b.id === bakery.instanceId));
  assert.ok(state.buildings.some(b => b.id === mill.instanceId));

  // 换一组不同速度：投入人数不同则完工日不同
  const state2 = stock(simulation.createInitialState({ seed: 41003 }));
  const slow = simulation.buildAt(state2, "bakery", "east", { workers: 4 });
  const fast = simulation.buildAt(state2, "lumberyard", "forest-logging-01", { workers: 10 });
  simulation.advanceDays(state2, 40);
  // 伐木场 200 工日 / 10 人 = 20 天，应已完工；面包房 400/4 = 100 天，仍在建
  assert.equal(slow.ok && fast.ok, true);
  assert.equal(state2.buildings.some(b => b.id === fast.instanceId), true);
  assert.equal(state2.projects.some(p => p.instanceId === slow.instanceId), true);
  assert.equal(state2.projects.length, 1);
});

test("某工程完工后其工人回归待业，其他工程不受影响", () => {
  const state = stock(simulation.createInitialState({ seed: 41004 }));
  const quick = simulation.buildAt(state, "lumberyard", "forest-logging-01", { workers: 10 });
  const slow = simulation.buildAt(state, "mill", "east", { workers: 12 });
  assert.equal(quick.ok && slow.ok, true);
  const totalBuilders = readJobCount(state, "builders");
  assert.equal(totalBuilders, 22);
  const idleBefore = simulation.selectJobRows(state).idle;

  // 伐木场 200 工日 / 10 人 = 20 天完工；磨坊 480 / 12 = 40 天
  simulation.advanceDays(state, 20);
  assert.equal(state.buildings.some(b => b.id === quick.instanceId), true, "伐木场应已落成");
  const slowProject = projectById(state, slow.instanceId);
  assert.ok(slowProject, "磨坊应仍在建");
  assert.equal(slowProject.workDone, 12 * 20);
  // 该工程的 10 名工人回归待业，其他工程的人保留
  assert.equal(readJobCount(state, "builders"), 12);
  assert.equal(simulation.selectJobRows(state).idle, idleBefore + 10);
  // 其余工程继续推进
  simulation.advanceDay(state);
  assert.equal(projectById(state, slow.instanceId).workDone, 12 * 21);
  assert.equal(simulation.validateState(state).valid, true);
});

test("同地块第二个工程被拒绝；地块冲突在数组内互斥", () => {
  const state = stock(simulation.createInitialState({ seed: 41005 }));
  const first = simulation.buildAt(state, "mill", "east");
  assert.equal(first.ok, true, first.reason);
  // 同地块再来一个新建工程 → 拒绝
  const sameBuild = simulation.buildAt(state, "bakery", "east");
  assert.equal(sameBuild.ok, false);
  assert.match(sameBuild.reason, /已有工程|已经有建筑/);
  // 同地块的另一个工程也不能因为"不同工程类型"而绕过
  assert.equal(state.projects.filter(p => p.plotId === "east").length, 1);

  // 地块上有建筑时同样拒绝
  const built = stock(simulation.createInitialState({ seed: 41006 }));
  const built0 = simulation.buildAt(built, "mill", "east", { workers: 12 });
  simulation.advanceDays(built, 40);
  assert.equal(built.buildings.some(b => b.id === built0.instanceId), true);
  assert.equal(simulation.buildAt(built, "bakery", "east").ok, false);
});

test("升级工程与新建工程可并行", () => {
  const state = stock(simulation.createInitialState({ seed: 41007 }));
  // 先老老实实造一座磨坊
  const mill = simulation.buildAt(state, "mill", "east", { workers: 12 });
  simulation.advanceDays(state, Math.ceil(CONTENT.buildings.mill.construction.workDays / 12));
  assert.equal(state.projects.length, 0);
  const millBuilding = state.buildings.find(b => b.id === mill.instanceId);
  assert.ok(millBuilding);

  // 升级这座磨坊，同时在另一地块新开工一座面包房
  const upgrade = simulation.upgradeBuilding(state, mill.instanceId, { workers: 6 });
  assert.equal(upgrade.ok, true, upgrade.reason);
  const fresh = simulation.buildAt(state, "bakery", "south", { workers: 8 });
  assert.equal(fresh.ok, true, fresh.reason);
  assert.equal(state.projects.length, 2);
  assert.deepEqual(state.projects.map(p => p.kind).sort(), ["build", "upgrade"]);
  const upgradeProject = state.projects.find(p => p.kind === "upgrade");
  assert.equal(upgradeProject.buildingId, mill.instanceId);
  assert.equal(upgradeProject.workers, 6);
  assert.equal(projectById(state, fresh.instanceId).workers, 8);
  // 升级不占新地块，与新建工程并存
  assert.equal(simulation.validateState(state).valid, true);

  simulation.advanceDay(state);
  assert.equal(projectById(state, upgradeProject.instanceId).workDone, 6);
  assert.equal(projectById(state, fresh.instanceId).workDone, 8);
});

test("劳力不足时开工人数受约束，调整人数遵守待业余量", () => {
  const state = stock(simulation.createInitialState({ seed: 41009 }), 100000);
  setJobCount(state, "farmers", 0, CONTENT);
  const labor = simulation.selectJobRows(state);
  const available = labor.idle;
  assert.ok(available > 30);
  // 全镇可动用劳力就是这 available 人；请求远超供给的人数，只能招到可用上限。
  const started = simulation.buildAt(state, "mill", "east", { workers: available + 1000 });
  assert.equal(started.ok, true, started.reason);
  const project = projectById(state, started.instanceId);
  assert.equal(started.assignedBuilders, project.workers);
  assert.equal(project.workers, available, "开工人数应受全镇可用劳力上限约束");
  assert.equal(simulation.selectJobRows(state).idle, 0);

  // 第二个工程：此时已无剩余劳力，只能拿到 0 人
  const second = simulation.buildAt(state, "bakery", "south", { workers: 10 });
  assert.equal(second.ok, true, second.reason);
  const secondProject = projectById(state, second.instanceId);
  assert.equal(secondProject.workers, 0, "没有剩余劳力时新工程只能等待用工");
  assert.equal(readJobCount(state, "builders"), available, "总营造工不因新工程而虚增");

  // 把第一个工程减到 5 人，释放其余劳力回归待业
  const lowered = setProjectWorkers(state, project.instanceId, 5, CONTENT);
  assert.equal(lowered.ok, true, lowered.reason);
  assert.equal(project.workers, 5);
  assert.equal(simulation.selectJobRows(state).idle, available - 5);

  // 第二个工程现在最多能招到这些待业者
  const raised = setProjectWorkers(state, second.instanceId, 99999, CONTENT);
  assert.equal(raised.ok, true, raised.reason);
  assert.equal(secondProject.workers, available - 5);
  assert.equal(simulation.selectJobRows(state).idle, 0);

  // 减到 0：全部回归待业；不能低于 0
  assert.equal(setProjectWorkers(state, second.instanceId, -5, CONTENT).assigned, 0);
  assert.equal(simulation.selectJobRows(state).idle, available - 5);
  assert.equal(simulation.validateState(state).valid, true);
});

test("并行工程的建筑工工资按各自投入人数与相同日薪结算", () => {
  const state = stock(simulation.createInitialState({ seed: 41010 }));
  const wage = state.employment.wageRates.builders;
  const first = simulation.buildAt(state, "bakery", "east", { workers: 10 });
  const second = simulation.buildAt(state, "mill", "south", { workers: 12 });
  assert.equal(first.ok && second.ok, true);
  simulation.advanceDay(state);
  const payroll = state.payroll.lastDay;
  const builderRows = payroll.workers.filter(row => row.key === "builders");
  // 每个工程一条工资行，人数与各自投入一致，日薪沿用同一标准
  assert.equal(builderRows.length, 2);
  assert.deepEqual(builderRows.map(row => row.count).sort((a, b) => a - b), [10, 12]);
  for (const row of builderRows) assert.equal(row.dailyRateVoucher, wage);
  const totalCount = builderRows.reduce((sum, row) => sum + row.count, 0);
  assert.equal(totalCount, 22);
  assert.equal(payroll.expectedWheatJin, 22 * wage);
});

test("并行工程各自保留材料隔离记录，完工后按各自工程结算", () => {
  const state = stock(simulation.createInitialState({ seed: 41011 }), 100000);
  const first = simulation.buildAt(state, "mill", "east", { workers: 12 });
  const second = simulation.buildAt(state, "bakery", "south", { workers: 10 });
  assert.equal(first.ok && second.ok, true);
  // 每个工程只记录自己的材料消耗，互不混账
  const firstProject = projectById(state, first.instanceId);
  const secondProject = projectById(state, second.instanceId);
  assert.ok(firstProject.materialsConsumed.length > 0);
  assert.ok(secondProject.materialsConsumed.length > 0);
  const firstTransaction = firstProject.materialsConsumed[0].transactionId;
  const secondTransaction = secondProject.materialsConsumed[0].transactionId;
  assert.notEqual(firstTransaction, secondTransaction);
  assert.equal(simulation.validateState(state).valid, true);
});
