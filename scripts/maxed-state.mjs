// 满级测试存档的生成函数：createMaxedState()。
// 用途：测试界面与功能（不用于数值校准）。产物见 scripts/make-maxed-save.mjs。
//
// 放在 scripts/ 而不是 src/testing/：bundle-single.mjs 会把 src/**/*.js 全部打进 index.html，测试代码不该进发布包。
//
// 做法（全部走现有命令与内部入口，不手搓 state）：
// 1. createInitialState() 拿开局；镇库按定义加木材（建造与升级用量 × 1.2）、小麦（印券底）、以及每种商品各一批。
// 2. 按 content.buildings 遍历每一种建筑（含 mod 建筑）：每种建一栋，用 buildAt 动工，再用 upgradeBuilding 逐级升到 upgrade.maxLevel。
//    每一波（一个游戏日）所有能开工的工程并行推进。
// 3. 时间快进：一个工程的施工天数（workRequired）动辄上千天，这里把每个在建工程的 workDone 直接设到“差一天完工”，
//    再推进一天让引擎自己的完工逻辑落成。完工、建筑升级、岗位回收都是引擎原路径，只是跳过了等待天数。
// 4. 全部完工后按岗位容量填满工人（setEmployment，人口不够则按人口分）。
// 5. 再推进 3 天日结并校验。
//
// 未覆盖：每种建筑只建一栋（maxInstances 可达 12 的建筑不会全部建满）；商业街/贸易中心/养殖基地/时代广场的店铺不开；
// 社保基金默认不开（options.socialSecurity 可开）。

import { createSimulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { addInventory } from "../src/economy/inventory.js";

const STOCK_EACH_ITEM_JIN = 20000;
const STOCK_WHEAT_JIN = 2000000;
const MATERIAL_MARGIN = 1.2;
const MAX_WAVES = 200;

function addNeed(need, requirements, times) {
  for (const row of requirements || []) {
    need[row.itemId] = (need[row.itemId] || 0) + row.quantity * times;
  }
}

// 与 systems/construction.js 的选址规则一致：资源地块、河岸地块只给指定建筑，其余空地给普通建筑。
function pickPlot(state, definition, used) {
  const allowed = new Set(definition.allowedPlotFeatures || []);
  return state.plots.find(plot => {
    if (used.has(plot.id)) return false;
    if (definition.requiredPlotFeature) return plot.feature === definition.requiredPlotFeature;
    if (!plot.feature) return true;
    return allowed.has(plot.feature);
  }) || null;
}

function assertOk(result, what) {
  if (!result || result.ok !== true) throw new Error(`满级存档生成失败（${what}）：${result?.reason || "未知原因"}`);
  return result;
}

function stockTown(state, simulation) {
  const content = simulation.content;
  const need = { wood: 0 };
  for (const definition of Object.values(content.buildings)) {
    addNeed(need, definition.materialRequirements, 1);
    if (definition.upgrade) addNeed(need, definition.upgrade.materialRequirements, definition.upgrade.maxLevel - 1);
  }
  for (const [itemId, jin] of Object.entries(need)) {
    const amount = Math.ceil(jin * MATERIAL_MARGIN);
    if (amount > 0) assertOk(addInventory(state, "town", itemId, amount, "满级存档：建造与升级材料", "test", content), `木材 ${itemId}`);
  }
  assertOk(addInventory(state, "town", "wheat", STOCK_WHEAT_JIN, "满级存档：小麦底仓（印券用）", "test", content), "小麦");
  for (const itemId of Object.keys(content.items)) {
    if (itemId === "wheat") continue;
    assertOk(addInventory(state, "town", itemId, STOCK_EACH_ITEM_JIN, "满级存档：商品库存", "test", content), `商品 ${itemId}`);
  }
}

// 每一波：没在建的建筑开工或升级一级；在建的工程快进到差一天完工，再推进一天。
function buildAllToMaxLevel(state, simulation, chains) {
  const content = simulation.content;
  for (let wave = 0; wave < MAX_WAVES; wave += 1) {
    const pending = chains.filter(chain => {
      const building = chain.instanceId ? state.buildings.find(row => row.id === chain.instanceId) : null;
      const level = building ? building.level : 0;
      return level < chain.maxLevel;
    });
    if (!pending.length) return wave;

    for (const chain of pending) {
      if (state.projects.some(project => project.plotId === chain.plotId)) continue;
      const definition = content.buildings[chain.typeId];
      const building = chain.instanceId ? state.buildings.find(row => row.id === chain.instanceId) : null;
      if (!building) {
        const result = simulation.buildAt(state, chain.typeId, chain.plotId, { workers: Math.max(1, definition.construction.recommendedWorkers || 1) });
        if (result.ok) chain.instanceId = result.instanceId;
        else if (!/人|劳力|工/.test(result.reason || "")) assertOk(result, `动工 ${chain.typeId}`);
      } else {
        simulation.upgradeBuilding(state, building.id);
      }
    }

    // 开工时劳力不够的工程（0 人）会一直卡住，每波把人补到建议人数。
    for (const project of state.projects) {
      const want = project.recommendedWorkers || 1;
      if ((project.workers || 0) < want) simulation.setProjectWorkers(state, project.instanceId, want);
    }
    // 时间快进：只改在建工程的进度计数，完工由引擎的 advanceConstruction 结算。
    for (const project of state.projects) {
      const workers = Math.max(0, Math.floor(project.workers || 0));
      if (workers > 0) project.workDone = Math.max(0, project.workRequired - workers);
    }
    simulation.advanceDay(state);
  }
  throw new Error(`满级存档生成超过 ${MAX_WAVES} 波仍未完工，请检查建筑工人与材料`);
}

// 先把农民让出来，建筑岗位按优先级排满，剩余劳力再回到农田（开局农民默认占满全镇劳力）。
function fillJobs(state, simulation) {
  const farmerRoleId = simulation.content.agriculture.farmerRoleId;
  simulation.setEmployment(state, farmerRoleId, 0);
  const rows = simulation.selectJobRows(state).rows
    .filter(row => row.scope === "building")
    .slice()
    .sort((a, b) => (a.releasePriority || 0) - (b.releasePriority || 0));
  for (const row of rows) {
    if (row.capacity > 0) simulation.setEmployment(state, row.key, row.capacity);
  }
  simulation.setEmployment(state, farmerRoleId, Number.MAX_SAFE_INTEGER);
}

// 返回满级测试状态（已通过 validateState，并已推进 3 天日结）。
export function createMaxedState(options = {}) {
  const simulation = createSimulation(options.content || CONTENT);
  const content = simulation.content;
  const state = simulation.createInitialState();

  stockTown(state, simulation);

  const used = new Set();
  const chains = [];
  for (const definition of Object.values(content.buildings)) {
    const plot = pickPlot(state, definition, used);
    if (!plot) throw new Error(`满级存档生成失败：没有可用地块给 ${definition.id}`);
    used.add(plot.id);
    chains.push({
      typeId: definition.id,
      plotId: plot.id,
      instanceId: null,
      maxLevel: definition.upgrade ? definition.upgrade.maxLevel : 1
    });
  }
  buildAllToMaxLevel(state, simulation, chains);

  fillJobs(state, simulation);

  assertOk(simulation.issueGrainVouchers(state, "town", 500000), "镇库加印粮券");
  if (options.socialSecurity) assertOk(simulation.setSocialSecurityPolicy(state, { enabled: true }), "开启社保");

  const check = simulation.validateState(state);
  if (!check.valid) throw new Error("满级存档校验失败：" + check.errors.slice(0, 5).join("；"));
  simulation.advanceDays(state, 3);
  const after = simulation.validateState(state);
  if (!after.valid) throw new Error("满级存档推进 3 天后校验失败：" + after.errors.slice(0, 5).join("；"));
  return state;
}
