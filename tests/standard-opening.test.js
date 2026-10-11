import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { addInventory } from "../src/economy/inventory.js";
import { educationBonus, experienceBonus, levelBonus, productivityFactor } from "../src/economy/productivity.js";
import { selectUpgradePreview } from "../src/systems/building-development.js";
import { defaultTotalShares } from "../src/systems/ipo.js";
import { nearbyDivisibleShareCounts, resolveListingTerms } from "../src/systems/stock-exchange.js";
import { setJobCount } from "../src/systems/households.js";
import { dailyCapacityBySource, dockFreightRate, freightBuildingView, freightVoucherPerJin, selectLogisticsView, trunkFreightRate } from "../src/systems/logistics.js";
import { migrateSave } from "../src/persistence/migrations.js";

const RULES = CONTENT.rules;
const EXPECTED = [
  { typeId: "lumberyard", plotId: "forest-logging-01", level: 10 },
  { typeId: "saltworks", plotId: "forest-salt-01", level: 10 },
  { typeId: "dock", plotId: "riverside-01", level: 10 },
  // 煤矿、铁矿开局各 1 级（见 rules.INITIAL.standardOpeningBuildings）。
  { typeId: "coal_mine", plotId: "forest-coal-01", level: 1 },
  { typeId: "iron_mine", plotId: "forest-iron-01", level: 1 }
];

function assertValid(state, label) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label}: ${check.errors?.join("；")}`);
}

// 直接落成一座建筑（跳过施工，只用于设定夹具）。
function addBuilding(state, id, typeId, plotId, level = 1) {
  const plot = state.plots.find(row => row.id === plotId);
  state.buildings.push({
    id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return state.buildings.at(-1);
}

function advanceUntilProjectsDone(state, limit = 600) {
  for (let i = 0; i < limit && state.projects.length; i += 1) simulation.advanceDay(state);
  assert.equal(state.projects.length, 0, "upgrade project should finish within the day limit");
}

// ---------------------------------------------------------------- 标准开局 / 空白开局

test("标准开局：伐木场、盐场、码头各一栋（10 级），煤矿、铁矿各一栋（1 级）；地块正确，镇营所有，validateState 通过", () => {
  const state = simulation.createInitialState({ seed: 9101, opening: "standard" });
  assert.equal(state.buildings.length, EXPECTED.length, "开局五栋");
  for (const expected of EXPECTED) {
    const rows = state.buildings.filter(row => row.typeId === expected.typeId);
    assert.equal(rows.length, 1, `${expected.typeId} 只有一栋`);
    const [building] = rows;
    assert.equal(building.plotId, expected.plotId, `${expected.typeId} 地块`);
    assert.equal(building.level, expected.level, `${expected.typeId} ${expected.level} 级`);
    assert.deepEqual(building.ownership, { townLevels: expected.level, privateLevels: 0, listedLevels: 0 });
    assert.deepEqual(building.completed, { year: 1, day: 1 }, "completed 为开局日");
  }
  assert.equal(state.nextInstanceNumber, EXPECTED.length + 1, "实例编号接着开局的往后");
  assertValid(state, "标准开局");
});

test("标准开局：不派工（岗位全部为空），开局文字提示派人", () => {
  const state = simulation.createInitialState({ seed: 9102, opening: "standard" });
  const typeOf = new Map(state.buildings.map(row => [row.id, row.typeId]));
  const rows = simulation.selectJobRows(state).rows.filter(row => row.buildingId && typeOf.has(row.buildingId));
  assert.ok(rows.length >= EXPECTED.length, "开局建筑都有岗位行");
  for (const row of rows) assert.equal(row.count, 0, `${row.key} 不派工`);
  assert.equal(state.logistics.poolJin, 0, "没有码头工就没有运力");
  assert.match(state.events[0].text, /伐木场、盐场、码头、煤矿、铁矿已建好.*就业面板设人数/);
});

test("空白开局是默认：不放任何建筑；显式 opening: blank 与默认一致；未知开局报错", () => {
  const blank = simulation.createInitialState({ seed: 9103 });
  assert.equal(blank.buildings.length, 0);
  assert.equal(blank.nextInstanceNumber, 1);
  assert.equal(blank.events[0].text.includes("已建好"), false, "空白开局不带建造提示");
  const explicit = simulation.createInitialState({ seed: 9103, opening: "blank" });
  assert.equal(JSON.stringify(explicit), JSON.stringify(blank), "显式 blank 与默认逐位一致");
  assert.throws(() => simulation.createInitialState({ seed: 9103, opening: "nope" }), /未知开局/);
  assertValid(blank, "空白开局");
});

test("标准开局的三栋占地：该地块不能再建；同类建筑数量上限把开局那一栋算进去", () => {
  const state = simulation.createInitialState({ seed: 9104, opening: "standard" });
  const taken = simulation.buildAt(state, "lumberyard", "forest-logging-01");
  assert.equal(taken.ok, false);
  assert.match(taken.reason, /已经有建筑/);
  const takenDock = simulation.buildAt(state, "dock", "riverside-01");
  assert.equal(takenDock.ok, false);

  // 码头上限 4 座：开局一座 + 再落三座（河岸 02–04）后，第 5 座（即使有空地）被拒，原因是数量上限。
  addBuilding(state, "dock-x2", "dock", "riverside-02");
  addBuilding(state, "dock-x3", "dock", "riverside-03");
  addBuilding(state, "dock-x4", "dock", "riverside-04");
  assert.equal(CONTENT.buildings.dock.maxInstances, 4);
  const capped = simulation.buildAt(state, "dock", "riverside-02");
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /可建数量/);
});

test("旧档读入不新增建筑：空白存档与标准开局存档读回后建筑数量不变", () => {
  const blank = simulation.createInitialState({ seed: 9105 });
  const migratedBlank = migrateSave(JSON.parse(JSON.stringify(blank)), CONTENT);
  assert.equal(migratedBlank.buildings.length, 0, "旧空白档不被底板补上三栋");

  const standard = simulation.createInitialState({ seed: 9106, opening: "standard" });
  const migratedStandard = migrateSave(JSON.parse(JSON.stringify(standard)), CONTENT);
  assert.equal(migratedStandard.buildings.length, EXPECTED.length, "标准档读回建筑数不变，不翻倍");
  assert.equal(migratedStandard.nextInstanceNumber, standard.nextInstanceNumber);
  assertValid(migratedStandard, "标准档读回");
});

// ---------------------------------------------------------------- 50 级上限

test("伐木场、盐场最高 50 级，其他建筑仍是 10 级", () => {
  assert.equal(CONTENT.rules.buildingMaxLevel, 10);
  assert.equal(CONTENT.buildings.lumberyard.upgrade.maxLevel, 50);
  assert.equal(CONTENT.buildings.saltworks.upgrade.maxLevel, 50);
  assert.equal(CONTENT.buildings.dock.upgrade.maxLevel, 10);
  assert.equal(CONTENT.buildings.mill.upgrade.maxLevel, 10);
});

test("升级预览：伐木场、盐场在 11–49 级都可升，工期与材料沿用定义；50 级不可升", () => {
  const state = simulation.createInitialState({ seed: 9107, opening: "standard" });
  const lumber = state.buildings.find(row => row.typeId === "lumberyard");
  for (const level of [11, 20, 35, 49]) {
    lumber.level = level;
    lumber.ownership = { townLevels: level, privateLevels: 0, listedLevels: 0 };
    const preview = selectUpgradePreview(state, lumber.id, CONTENT);
    assert.equal(preview.available, true, `${level} 级可升`);
    assert.equal(preview.nextLevel, level + 1);
    assert.equal(preview.maxLevel, 50, "升级面板显示最高 50 级");
    assert.equal(preview.workDays, CONTENT.buildings.lumberyard.upgrade.workDays, "工期沿用定义");
    assert.equal(preview.materials[0].itemId, "wood");
    assert.equal(preview.materials[0].required, 100, "每级木材沿用定义");
  }
  lumber.level = 50;
  lumber.ownership = { townLevels: 50, privateLevels: 0, listedLevels: 0 };
  const capped = selectUpgradePreview(state, lumber.id, CONTENT);
  assert.equal(capped.available, false);
  assert.match(capped.reason, /最高等级/);

  const salt = state.buildings.find(row => row.typeId === "saltworks");
  salt.level = 30;
  salt.ownership = { townLevels: 30, privateLevels: 0, listedLevels: 0 };
  assert.equal(selectUpgradePreview(state, salt.id, CONTENT).available, true, "盐场 30 级可升");
});

test("升级命令：伐木场从 10 级升到 11 级（真实开工、建筑工施工、完工），之后 51 级的状态校验不过", () => {
  const state = simulation.createInitialState({ seed: 9108, opening: "standard" });
  const lumber = state.buildings.find(row => row.typeId === "lumberyard");
  addInventory(state, "town", "wood", 100, "test lumber upgrade", "test", CONTENT);
  const started = simulation.upgradeBuilding(state, lumber.id);
  assert.equal(started.ok, true, started.reason);
  advanceUntilProjectsDone(state);
  assert.equal(lumber.level, 11);
  assertValid(state, "伐木场 11 级");

  lumber.level = 51;
  lumber.ownership = { townLevels: 51, privateLevels: 0, listedLevels: 0 };
  const check = simulation.validateState(state);
  assert.equal(check.valid, false, "51 级超过上限");
  assert.ok(check.errors.some(text => /建筑等级无效/.test(text)));
});

test("岗位数随等级线性增长：伐木场每级 20 个岗位，盐场每级 10 个", () => {
  const state = simulation.createInitialState({ seed: 9109, opening: "standard" });
  const lumber = state.buildings.find(row => row.typeId === "lumberyard");
  const salt = state.buildings.find(row => row.typeId === "saltworks");
  lumber.level = 30; lumber.ownership = { townLevels: 30, privateLevels: 0, listedLevels: 0 };
  salt.level = 40; salt.ownership = { townLevels: 40, privateLevels: 0, listedLevels: 0 };
  const rows = simulation.selectJobRows(state).rows;
  assert.equal(rows.find(row => row.key === `${lumber.id}::lumberjacks`).capacity, 20 * 30);
  assert.equal(rows.find(row => row.key === `${salt.id}::salt_workers`).capacity, 10 * 40);
  assert.equal(rows.find(row => row.key === `${state.buildings.find(row => row.typeId === "dock").id}::dockers`).capacity, 20 * 10);
});

test("上市：11–50 级的 2520 股不整除时，resolveListingTerms 给出能被级数整除的可选总股本；整除的级数直接通过", () => {
  const state = simulation.createInitialState({ seed: 9110, opening: "standard" });
  for (let levels = 1; levels <= 50; levels += 1) {
    const nearby = nearbyDivisibleShareCounts(levels, 2520);
    assert.ok(nearby.length >= 1, `${levels} 级有可选值`);
    assert.ok(nearby.every(total => Number.isInteger(total) && total > 0 && total % levels === 0), `${levels} 级可选值都能整除`);
    assert.equal(defaultTotalShares(levels) % levels, 0, `${levels} 级默认总股本整除`);
    const terms = resolveListingTerms(state, {
      buildingId: "building-1", levels, ticker: "001", totalShares: 2520, offerPercent: 49, priceVoucherPerShare: 1
    }, CONTENT);
    if (2520 % levels === 0) {
      assert.equal(terms.ok, true, `${levels} 级 2520 股整除，直接通过`);
    } else {
      assert.equal(terms.ok, false, `${levels} 级 2520 股不整除`);
      assert.match(terms.reason, /整除/);
      assert.ok(Array.isArray(terms.nearby) && terms.nearby.length >= 1, "给出可选值");
      assert.ok(terms.nearby.every(total => total % levels === 0), "可选值都整除");
    }
    const defaulted = resolveListingTerms(state, {
      buildingId: "building-1", levels, ticker: "001", offerPercent: 49, priceVoucherPerShare: 1
    }, CONTENT);
    assert.equal(defaulted.ok, true, `${levels} 级不填总股本也能上市`);
    assert.equal(defaulted.totalShares % levels, 0);
  }
});

// ---------------------------------------------------------------- 码头 / 物流中心：等级、熟练、教育加成

// 同样在岗人数下，码头（或物流中心）的日运力。
function capacityWith({ typeId = "dock", level = 1, workers = 10, experienceDays = 0, schoolDays = 0 } = {}) {
  const state = simulation.createInitialState({ seed: 9120 });
  const plotId = typeId === "dock" ? "riverside-01" : "village-01";
  const building = addBuilding(state, "freight-1", typeId, plotId, level);
  setJobCount(state, `${building.id}::${typeId === "dock" ? "dockers" : "porters"}`, workers, CONTENT);
  if (experienceDays) state.industryExperience = { [typeId]: experienceDays };
  if (schoolDays) state.education = { schoolDays };
  return { state, building };
}

test("码头运力随等级：同样 10 人在岗，10 级 / 1 级 = 等级加成之比（1.9 倍）", () => {
  const low = capacityWith({ level: 1 });
  const high = capacityWith({ level: 10 });
  assert.equal(dailyCapacityBySource(low.state, CONTENT).dock, 10 * RULES.dockJinPerWorker, "1 级无加成 = 基础运力");
  const ratio = dailyCapacityBySource(high.state, CONTENT).dock / dailyCapacityBySource(low.state, CONTENT).dock;
  assert.ok(Math.abs(ratio - levelBonus(10) / levelBonus(1)) < 1e-9, `比值 ${ratio}`);
  assert.ok(Math.abs(ratio - 1.9) < 1e-9);
});

test("物流中心运力随等级：每栋按自己的等级算", () => {
  const { state } = capacityWith({ typeId: "logistics_center", level: 5, workers: 8 });
  const expected = 8 * RULES.logisticsJinPerWorker * levelBonus(5);
  assert.ok(Math.abs(dailyCapacityBySource(state, CONTENT).logisticsCenter - expected) < 1e-9);
});

test("熟练度加成：累计工日越多，同样在岗的码头运力越高，与生产率系数一致", () => {
  const base = capacityWith({ level: 10 });
  const warm = capacityWith({ level: 10, experienceDays: 20000 });
  const bonus = experienceBonus(warm.state, "dock");
  assert.ok(bonus > 1.2, "2 万工日约 +31%");
  const cold = dailyCapacityBySource(base.state, CONTENT).dock;
  const hot = dailyCapacityBySource(warm.state, CONTENT).dock;
  assert.ok(Math.abs(hot - cold * bonus / experienceBonus(base.state, "dock")) < 1e-9, "熟练度按同一公式乘进运力");
  assert.ok(Math.abs(hot - 10 * RULES.dockJinPerWorker * productivityFactor(warm.state, "dock", 10)) < 1e-9);
});

test("教育加成：办满一年（360 天）全镇 +1%，乘进码头运力", () => {
  const plain = capacityWith({ level: 1 });
  const schooled = capacityWith({ level: 1, schoolDays: 360 });
  assert.ok(Math.abs(educationBonus(schooled.state) - 1.01) < 1e-12);
  const ratio = dailyCapacityBySource(schooled.state, CONTENT).dock / dailyCapacityBySource(plain.state, CONTENT).dock;
  assert.ok(Math.abs(ratio - 1.01) < 1e-9, `比值 ${ratio}`);
});

test("没有任何加成（1 级、0 工日、0 办学日）：运力与运费与改前逐位一致", () => {
  const state = simulation.createInitialState({ seed: 9121 });
  addBuilding(state, "dock-plain", "dock", "riverside-01", 1);
  addBuilding(state, "porter-plain", "logistics_center", "village-01", 1);
  setJobCount(state, "dock-plain::dockers", 5, CONTENT);
  setJobCount(state, "porter-plain::porters", 3, CONTENT);
  assert.deepEqual(dailyCapacityBySource(state, CONTENT), {
    foreignTradeHouse: 0, logisticsCenter: 3 * RULES.logisticsJinPerWorker, dock: 5 * RULES.dockJinPerWorker
  });
  const trunkJin = 3 * RULES.logisticsJinPerWorker;
  const dockJin = 5 * RULES.dockJinPerWorker;
  const expected = (trunkJin * trunkFreightRate(CONTENT) + dockJin * dockFreightRate(CONTENT)) / (trunkJin + dockJin);
  assert.equal(freightVoucherPerJin(state, CONTENT), expected, "运费按基础运力加权，与改前公式逐位相同");
});

test("运费不随等级、熟练度、教育加成变化：同样在岗，10 级 + 熟练 + 办学的码头运费与 1 级时相同", () => {
  const low = capacityWith({ level: 1 });
  const high = capacityWith({ level: 10, experienceDays: 20000, schoolDays: 360 });
  assert.equal(freightVoucherPerJin(high.state, CONTENT), freightVoucherPerJin(low.state, CONTENT), "运费不随生产率变");
  assert.equal(freightVoucherPerJin(high.state, CONTENT), dockFreightRate(CONTENT), "只有码头时运费就是码头的基础人力成本");
  // 运力确实变了，运费没变。
  assert.ok(dailyCapacityBySource(high.state, CONTENT).dock > dailyCapacityBySource(low.state, CONTENT).dock);
});

test("人均运力展示：selectLogisticsView 与单座建筑视图给出等级、熟练、教育加成后的每人日运力", () => {
  const { state, building } = capacityWith({ level: 10, workers: 10, experienceDays: 20000, schoolDays: 360 });
  const view = selectLogisticsView(state, CONTENT);
  const factor = productivityFactor(state, "dock", 10);
  assert.ok(Math.abs(view.productivity.dock.productivityFactor - Math.round(factor * 100) / 100) < 1e-9);
  assert.ok(Math.abs(view.productivity.dock.perWorkerJin - Math.round(RULES.dockJinPerWorker * factor * 100) / 100) < 1e-9);
  assert.equal(view.productivity.dock.perWorkerBaseJin, RULES.dockJinPerWorker);
  assert.equal(view.productivity.dock.levelBonusPercent, 90, "10 级 +90%");
  assert.equal(view.productivity.logisticsCenter.perWorkerBaseJin, RULES.logisticsJinPerWorker);
  // 没有物流中心：按 1 级、无熟练加成；教育加成是全镇的，这里办学满一年仍是 ×1.01。
  assert.equal(view.productivity.logisticsCenter.productivityFactor, Math.round(productivityFactor(state, "logistics_center", 1) * 100) / 100);
  assert.equal(view.productivity.logisticsCenter.productivityFactor, 1.01);
  assert.equal(view.freightVoucherPerJin, dockFreightRate(CONTENT), "运费口径仍是基础运力");

  const single = freightBuildingView(state, CONTENT, building);
  assert.equal(single.productivityFactor, Math.round(factor * 100) / 100);
  assert.equal(single.perWorkerBaseJin, RULES.dockJinPerWorker);
  assert.equal(freightBuildingView(state, CONTENT, { typeId: "mill", level: 1 }), null, "非运力建筑没有人均运力");
});

test("日结：码头在岗的工日计入熟练度（与产业同口径），运力池按含加成的日运力补充", () => {
  const { state } = capacityWith({ level: 10, workers: 10 });
  const daily = dailyCapacityBySource(state, CONTENT).dock;
  assert.ok(Math.abs(daily - 10 * RULES.dockJinPerWorker * 1.9) < 1e-9, "1 天前的日运力已含等级加成");
  simulation.advanceDay(state);
  assert.equal(state.industryExperience.dock, 10, "一天 10 人 = 10 工日");
  assert.ok(Math.abs(state.logistics.history.at(-1).capacityJin - daily) < 1e-9, "历史行记录当日运力（含加成）");
  assertValid(state, "码头日结后");
});
