import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount } from "../src/systems/households.js";
import { processBuilding } from "../src/systems/production.js";
import { accrueIndustryExperience } from "../src/systems/productivity.js";
import { recipeCapacity } from "../src/selectors/production.js";
import { refreshOperatingPlan } from "../src/economy/operating-plan.js";
import {
  EXPERIENCE_BONUS_MAX, EXPERIENCE_SCALE_WORKER_DAYS, experienceBonus, laborBatches, levelBonus, productivityFactor
} from "../src/economy/productivity.js";

// 测试辅助：直接在地块上放一座建成的建筑（跳过开工流程，与 ownership-tax.test.js 同口径）。
function addBuilding(state, typeId, id, { level = 1, townLevels = level, privateLevels = 0, listedLevels = 0, plotId = null } = {}) {
  const plot = plotId
    ? state.plots.find(row => row.id === plotId)
    : state.plots.find(row => !row.feature && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `缺少地块 ${plotId || "空地"}`);
  const building = {
    id, typeId, level, ownership: { townLevels, privateLevels, listedLevels }, plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: 1, day: 1 }
  };
  state.buildings.push(building);
  return building;
}

test("等级加成与熟练度加成按公式计算；零工日无加成；熟练度单调递增且不超过上限", () => {
  const state = simulation.createInitialState({ seed: 7101 });
  assert.equal(levelBonus(1), 1);
  assert.ok(Math.abs(levelBonus(3) - 1.2) < 1e-12);
  assert.equal(experienceBonus(state, "saltworks"), 1, "没有累计工日时熟练度加成为 0");

  const days = [0, 1000, 20000, 100000, 1e6];
  const bonuses = days.map(workerDays => {
    state.industryExperience = { saltworks: workerDays };
    return experienceBonus(state, "saltworks");
  });
  for (let i = 1; i < bonuses.length; i++) assert.ok(bonuses[i] > bonuses[i - 1], "熟练度应随工日严格递增");
  for (const value of bonuses) assert.ok(value <= 1 + EXPERIENCE_BONUS_MAX && value >= 1);
  // 数学上恒小于 1.5，但千万工日时 e^(-500) 已低于双精度，浮点结果恰为 1.5；这里只断言不越界。
  assert.ok(bonuses.at(-1) <= 1.5 && bonuses.at(-1) > 1.49, "千万工日已逼近但不超过 +50%");

  const expected = 1 + EXPERIENCE_BONUS_MAX * (1 - Math.exp(-20000 / EXPERIENCE_SCALE_WORKER_DAYS));
  state.industryExperience = { saltworks: 20000 };
  assert.ok(Math.abs(experienceBonus(state, "saltworks") - expected) < 1e-12);
  assert.ok(Math.abs(productivityFactor(state, "saltworks", 3) - 1.2 * expected) < 1e-12, "生产率系数 = 等级 × 熟练度");
  assert.equal(experienceBonus(state, "winery"), 1, "熟练度按产业分别累计");
});

test("三级建筑每个工人的批次 = 人数 × 基准 × 1.2 × 熟练度，取整", () => {
  const state = simulation.createInitialState({ seed: 7102 });
  addBuilding(state, "saltworks", "salt-l3", { level: 3, plotId: "forest-salt-01" });
  const workers = 10;
  setJobCount(state, "salt-l3::salt_workers", workers, CONTENT);
  state.industryExperience = { saltworks: 20000 };

  const bonus = experienceBonus(state, "saltworks");
  const building = state.buildings.find(row => row.id === "salt-l3");
  const result = processBuilding(state, building, CONTENT);
  assert.equal(result.batches, Math.floor(workers * 1 * 1.2 * bonus + 1e-9), "取整后的批次数");
  assert.equal(result.batches, 15, "10 人 × 1.2 × 1.316 ≈ 15.8 → 15 批");
  assert.equal(laborBatches(state, "saltworks", 3, workers, 1).batches, 15);
});

test("一个 2 级盐场工人连做 10 天得 11 批：不足一批的零头跨日累计", () => {
  const state = simulation.createInitialState({ seed: 7103 });
  addBuilding(state, "saltworks", "salt-l2", { level: 2, plotId: "forest-salt-01" });
  setJobCount(state, "salt-l2::salt_workers", 1, CONTENT);
  const building = state.buildings.find(row => row.id === "salt-l2");

  let total = 0;
  const daily = [];
  for (let day = 0; day < 10; day++) {
    const result = processBuilding(state, building, CONTENT);
    daily.push(result.batches);
    total += result.batches;
  }
  assert.equal(total, 11, `每天 1.1 批，10 天应为 11 批，实际每日 ${daily.join(",")}`);
  assert.ok(daily.slice(0, 9).every(batches => batches === 1), "前 9 天每天 1 批，零头留到下一天");
  assert.equal(daily[9], 2, "第 10 天累计零头凑满一批");
});

test("工日按镇营 + 民营 + 公司三类岗位累计；无人的产业不累计", () => {
  const state = simulation.createInitialState({ seed: 7104 });
  const town = addBuilding(state, "saltworks", "salt-town", { level: 1, townLevels: 1, plotId: "forest-salt-01" });
  const privateSalt = addBuilding(state, "saltworks", "salt-private", { level: 1, townLevels: 0, privateLevels: 1 });
  const listedSalt = addBuilding(state, "saltworks", "salt-listed", { level: 1, townLevels: 0, listedLevels: 1 });
  addBuilding(state, "cotton_field", "cotton-idle", { level: 1, townLevels: 1 });
  setJobCount(state, `${town.id}::salt_workers`, 4, CONTENT);
  setJobCount(state, `${privateSalt.id}::salt_workers::private`, 3, CONTENT);
  setJobCount(state, `${listedSalt.id}::salt_workers::listed`, 2, CONTENT);

  const added = accrueIndustryExperience(state, CONTENT);
  assert.equal(added.saltworks, 4 + 3 + 2, "同一天三类岗位人数相加");
  assert.equal(state.industryExperience.saltworks, 9);
  assert.equal(added.cotton_field, 0, "棉田无人在岗");
  assert.equal(state.industryExperience.cotton_field, undefined, "无人的产业不产生工日记录");
});

test("多日累计：镇营 4 人连续 5 天在岗，工日 = 4 × 5 = 20", () => {
  const state = simulation.createInitialState({ seed: 7108 });
  const town = addBuilding(state, "saltworks", "salt-days", { level: 1, townLevels: 1, plotId: "forest-salt-01" });
  setJobCount(state, `${town.id}::salt_workers`, 4, CONTENT);
  simulation.advanceDays(state, 5);
  assert.equal(state.industryExperience.saltworks, 4 * 5);
  assert.equal(state.industryExperience.cotton_field || 0, 0);
});

test("recipeCapacity 只读：调用前后 state 逐字节一致", () => {
  const state = simulation.createInitialState({ seed: 7105 });
  const building = addBuilding(state, "saltworks", "salt-ro", { level: 2, plotId: "forest-salt-01" });
  setJobCount(state, "salt-ro::salt_workers", 6, CONTENT);
  state.industryExperience = { saltworks: 5000 };
  building.productivityCarry = 0.5;
  const before = JSON.stringify(state);
  const capacity = recipeCapacity(state, building, CONTENT);
  assert.ok(capacity.batches > 0);
  assert.equal(JSON.stringify(state), before, "selector 不得改写 state");
});

test("运营计划：熟练度越高，私营产业行的每人批次越高、计划用工不增加", () => {
  const state = simulation.createInitialState({ seed: 7106 });
  addBuilding(state, "saltworks", "salt-plan", { level: 1, townLevels: 0, privateLevels: 2 });

  state.industryExperience = {};
  refreshOperatingPlan(state, CONTENT, true);
  const cold = { ...state.market.operatingPlan.rows["private:salt-plan"] };
  assert.ok(cold.key, "应生成私营盐场计划行");

  state.industryExperience = { saltworks: 200000 };
  refreshOperatingPlan(state, CONTENT, true);
  const warm = state.market.operatingPlan.rows["private:salt-plan"];
  const ratio = warm.batchesPerWorkerDay / cold.batchesPerWorkerDay;
  assert.ok(Math.abs(ratio - experienceBonus(state, "saltworks")) < 1e-9, `批次系数应按熟练度放大，实际倍数 ${ratio}`);
  assert.ok(warm.desiredWorkers <= cold.desiredWorkers, "同样的需求下，人均产出高时需要的工人不增加");
});

test("一天日结后工日入账、熟练度上升，且状态合法", () => {
  const state = simulation.createInitialState({ seed: 7107 });
  addBuilding(state, "saltworks", "salt-order", { level: 1, plotId: "forest-salt-01" });
  setJobCount(state, "salt-order::salt_workers", 2, CONTENT);
  const before = experienceBonus(state, "saltworks");
  simulation.advanceDay(state);
  assert.equal(state.industryExperience.saltworks, 2);
  assert.ok(experienceBonus(state, "saltworks") > before);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("selectDashboard 只读地暴露产业熟练度与产业建筑的人均产出系数", () => {
  const state = simulation.createInitialState({ seed: 7109 });
  addBuilding(state, "saltworks", "salt-view", { level: 3, plotId: "forest-salt-01" });
  setJobCount(state, "salt-view::salt_workers", 10, CONTENT);
  state.industryExperience = { saltworks: 20000 };
  const before = JSON.stringify(state);
  const view = simulation.selectDashboard(state, {});
  assert.equal(JSON.stringify(state), before, "selectDashboard 不得改写 state");

  const salt = view.productivity.find(row => row.typeId === "saltworks");
  assert.equal(salt.workerDays, 20000);
  assert.equal(salt.maxPercent, 50);
  assert.equal(salt.experiencePercent, 31.6, "熟练 +31.6%（1 位小数）");
  assert.ok(view.productivity.every(row => row.maxPercent === 50));

  const building = view.buildings.find(row => row.id === "salt-view");
  assert.equal(building.levelBonusPercent, 20);
  assert.equal(building.experienceBonusPercent, 31.6);
  assert.equal(building.productivityFactor, 1.58, "1.2 × 1.316 ≈ 1.58");
});
