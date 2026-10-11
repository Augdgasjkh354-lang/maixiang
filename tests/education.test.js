import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { householdList, householdIdleWorkers, isActiveHousehold } from "../src/systems/households.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { accrueEducationDay } from "../src/systems/productivity.js";
import { harvest } from "../src/systems/agriculture.js";
import { educationBonus, laborBatches, productivityFactor } from "../src/economy/productivity.js";
import { theoreticalFullSaleProfitPerWorker } from "../src/economy/prices.js";
import { selectHarvestForecast } from "../src/selectors/agriculture.js";
import { migrateSave } from "../src/persistence/migrations.js";

// 一满 360 天 × 每年 1% 的加成封顶 30%：封顶所需办学天数 = 0.3 × 360 ÷ 0.01 = 10800。
const CAP_SCHOOL_DAYS = 10800;
const DAYS_PER_YEAR = CONTENT.rules.daysPerYear;

function addStreet(state, id, level = 2) {
  const def = CONTENT.buildings.commercial_street;
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, "需要一块空地建商业街");
  const building = { id, typeId: "commercial_street", level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: state.day + 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

// 建一座学堂（商业街上的服务店），雇 clerks 名店员；clerks = 0 时没有教员，接待能力为 0。
function schoolWorld(seed, clerks = 2) {
  const state = simulation.createInitialState({ seed });
  const street = addStreet(state, `edu-street-${seed}`);
  const owner = householdList(state).find(h => isActiveHousehold(h) && householdIdleWorkers(h) > 0);
  assert.ok(owner, "需要空闲劳力家庭当店主");
  const opened = simulation.openResidentShop(state, street.id, "school", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const school = state.shops[opened.shopId];
  if (clerks > 0) assert.equal(simulation.configureShopClerks(state, school.id, clerks).ok, true);
  return { state, school };
}

function setSchoolDays(state, days) {
  state.education = { schoolDays: days };
}

test("没有学堂时办学天数不增，教育加成恒为 1", () => {
  const state = simulation.createInitialState({ seed: 8101 });
  assert.deepEqual(state.education, { schoolDays: 0 }, "新开局的累计办学天数为 0");
  for (let day = 0; day < 5; day += 1) simulation.advanceDay(state);
  assert.equal(state.education.schoolDays, 0);
  assert.equal(educationBonus(state), 1);
});

test("没有教员（学堂无店员）时，学堂不接待学生，办学天数不计", () => {
  const { state } = schoolWorld(8102, 0);
  for (let day = 0; day < 5; day += 1) {
    simulation.advanceDay(state);
    assert.equal(state.services.day.servedUses.school || 0, 0, "没有教员时学堂不接待");
  }
  assert.equal(state.education.schoolDays, 0);
  assert.equal(educationBonus(state), 1);
});

test("学堂有教员且接待学生的天数累计；每天按实际接待与否计数", () => {
  const { state } = schoolWorld(8103, 2);
  let servedDays = 0;
  for (let day = 0; day < 12; day += 1) {
    simulation.advanceDay(state);
    if ((state.services.day.servedUses.school || 0) > 0) servedDays += 1;
  }
  assert.ok(servedDays > 0, "有教员的学堂应当接待到学生");
  assert.equal(state.education.schoolDays, servedDays, "办学天数 = 实际接待学生的天数");
  assert.ok(Math.abs(educationBonus(state) - (1 + 0.01 * servedDays / DAYS_PER_YEAR)) < 1e-12);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));
});

test("accrueEducationDay：只有学堂当日接待了学生才加一天；其他服务或零接待不计", () => {
  const state = simulation.createInitialState({ seed: 8104 });
  state.services.day.servedUses = { tea: 3, haircut: 2 };
  accrueEducationDay(state);
  assert.equal(state.education.schoolDays, 0, "只接待茶馆、理发时不算办学");
  state.services.day.servedUses = { school: 0 };
  accrueEducationDay(state);
  assert.equal(state.education.schoolDays, 0, "接待为 0 不算办学");
  state.services.day.servedUses = { school: 1, tea: 1 };
  accrueEducationDay(state);
  assert.equal(state.education.schoolDays, 1);
  state.services.day.servedUses = { school: 4 };
  accrueEducationDay(state);
  assert.equal(state.education.schoolDays, 2, "当日接待人数多不重复累计，每天至多 1 天");
});

test("教育加成：满 360 天为 1.01；封顶 +30%，办学再久也不超过 1.3", () => {
  const state = simulation.createInitialState({ seed: 8105 });
  setSchoolDays(state, DAYS_PER_YEAR);
  assert.ok(Math.abs(educationBonus(state) - 1.01) < 1e-12, "满 1 年 +1%");
  setSchoolDays(state, CAP_SCHOOL_DAYS);
  assert.equal(educationBonus(state), 1.3, "办满 30 年封顶 +30%");
  setSchoolDays(state, CAP_SCHOOL_DAYS * 5);
  assert.equal(educationBonus(state), 1.3, "超过上限不再加成");
});

test("laborBatches / productivityFactor 乘上教育加成：磨坊 1 名工人、教育 1.3 时批次按公式取整", () => {
  const state = simulation.createInitialState({ seed: 8106 });
  const mill = CONTENT.buildings.mill;
  const batchesPerWorkerDay = CONTENT.recipes[mill.recipeId].batchesPerWorkerDay;
  const base = laborBatches(state, "mill", 1, 3, batchesPerWorkerDay).batches;
  assert.equal(base, Math.floor(3 * batchesPerWorkerDay), "无学堂时 3 人的批次与原公式一致");

  setSchoolDays(state, CAP_SCHOOL_DAYS);
  assert.equal(productivityFactor(state, "mill", 1), 1.3, "只有教育加成时生产率系数 = 1.3");
  const exact = 3 * batchesPerWorkerDay * 1.3;
  assert.equal(laborBatches(state, "mill", 1, 3, batchesPerWorkerDay).batches, Math.floor(exact + 1e-9));
  assert.ok(Math.abs(laborBatches(state, "mill", 1, 3, batchesPerWorkerDay).exact - exact) < 1e-9);

  // 等级与教育相乘：3 级 = 1.2，再乘 1.3。
  assert.ok(Math.abs(productivityFactor(state, "mill", 3) - 1.2 * 1.3) < 1e-12);
});

test("民营/公司/镇营共用的生产率系数：theoreticalFullSaleProfitPerWorker 的批次与教育加成一致", () => {
  const plain = simulation.createInitialState({ seed: 8107 });
  const schooled = simulation.createInitialState({ seed: 8107 });
  setSchoolDays(schooled, CAP_SCHOOL_DAYS);
  const before = theoreticalFullSaleProfitPerWorker(plain, "mill", CONTENT);
  const after = theoreticalFullSaleProfitPerWorker(schooled, "mill", CONTENT);
  assert.ok(before && after, "磨坊应有估值行");
  assert.ok(Math.abs(after.batchesPerWorkerDay / before.batchesPerWorkerDay - 1.3) < 1e-9, "估值批次按教育加成放大");
});

test("收成随教育加成放大（出工满额时收成 = 满额 × 教育加成）", () => {
  const plain = simulation.createInitialState({ seed: 8108 });
  const schooled = simulation.createInitialState({ seed: 8108 });
  setSchoolDays(schooled, CAP_SCHOOL_DAYS);
  for (const state of [plain, schooled]) {
    const acres = state.agriculture.reclaimedAcres;
    const capacity = Math.floor(acres / CONTENT.agriculture.acresPerFarmer);
    state.agriculture.workUnits = capacity * CONTENT.rules.growingDays;
  }
  const forecastPlain = selectHarvestForecast(plain, CONTENT);
  const forecastSchool = selectHarvestForecast(schooled, CONTENT);
  assert.ok(forecastPlain > 0, "满额出工应有收成预测");
  assert.ok(Math.abs(forecastSchool / forecastPlain - 1.3) < 1e-3, `预测收成应乘 1.3，实际倍数 ${forecastSchool / forecastPlain}`);

  const harvestPlain = harvest(plain, CONTENT);
  const harvestSchool = harvest(schooled, CONTENT);
  assert.ok(harvestPlain.total > 0 && harvestSchool.total > 0);
  assert.ok(Math.abs(harvestSchool.total / harvestPlain.total - 1.3) < 1e-3, `秋收应乘 1.3，实际倍数 ${harvestSchool.total / harvestPlain.total}`);
});

test("selectDashboard.education 只读暴露办学年数、加成与上限，并带到产业建筑的人均产出", () => {
  const state = simulation.createInitialState({ seed: 8109 });
  setSchoolDays(state, 720);
  const addSalt = () => {
    const def = CONTENT.buildings.saltworks;
    const plot = state.plots.find(row => row.feature === def.requiredPlotFeature && !state.buildings.some(b => b.plotId === row.id));
    assert.ok(plot, "需要盐场地块");
    state.buildings.push({ id: "edu-salt", typeId: "saltworks", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
      plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  };
  addSalt();
  const before = JSON.stringify(state);
  const view = simulation.selectDashboard(state, {});
  assert.equal(JSON.stringify(state), before, "selectDashboard 不得改写 state");
  assert.equal(view.education.schoolYears, 2);
  assert.equal(view.education.bonusPercent, 2);
  assert.equal(view.education.maxPercent, 30);
  assert.equal(view.education.perYearPercent, 1);
  const building = view.buildings.find(row => row.id === "edu-salt");
  assert.equal(building.educationBonusPercent, 2);
  assert.equal(building.productivityFactor, 1.02, "无熟练、1 级：生产率系数 = 教育 1.02");
});

test("validateState：办学天数须为非负有限数；缺失按 0 处理", () => {
  const state = simulation.createInitialState({ seed: 8110 });
  assert.equal(simulation.validateState(state).valid, true);
  setSchoolDays(state, -1);
  assert.equal(simulation.validateState(state).valid, false);
  setSchoolDays(state, Number.NaN);
  assert.equal(simulation.validateState(state).valid, false);
  setSchoolDays(state, Number.POSITIVE_INFINITY);
  assert.equal(simulation.validateState(state).valid, false);
  setSchoolDays(state, 360);
  assert.equal(simulation.validateState(state).valid, true);
});

test("旧档（无 education 字段）读入后由新开局底板补齐为 0", () => {
  const state = simulation.createInitialState({ seed: 8111 });
  delete state.education;
  const loaded = migrateSave(JSON.parse(JSON.stringify(state)), CONTENT);
  assert.deepEqual(loaded.education, { schoolDays: 0 });
  assert.equal(educationBonus(loaded), 1);
  assert.equal(simulation.validateState(loaded).valid, true, simulation.validateState(loaded).errors?.join("；"));
});
