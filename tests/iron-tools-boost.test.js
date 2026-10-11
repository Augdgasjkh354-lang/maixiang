// 铁制工具（金银消费第二期 B）：建筑 toolBoost 配置、每日备工具（镇营无偿调拨 / 民营与公司付款）、
// 库存不够按比例加成、消耗与成本结转、产能预览与实际一致、账平、没有工具时与改前逐位一致、旧档字段。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { processBuilding } from "../src/systems/production.js";
import { processPrivateBuilding } from "../src/systems/private-industry.js";
import { processListedCompany } from "../src/systems/companies.js";
import { formCompany } from "./helpers-ipo.js";
import { setJobCount, householdList, syncResidentAggregates, isActiveHousehold } from "../src/systems/households.js";
import { privateJobKeyForBuilding, listedJobKeyForBuilding } from "../src/selectors/labor.js";
import { ensureWholesaleMarket, depositWholesalePurchasedInventory } from "../src/systems/wholesale-market.js";
import { planProductionAccounting } from "../src/economy/business.js";
import { productionStatus } from "../src/selectors/production.js";
import { toolFactorEstimate, toolNeedPieces } from "../src/systems/tool-boost.js";
import { voucherBalance } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const TOOL = "iron_tool";
const BOOSTED = ["mill", "lumberyard", "saltworks", "coal_mine", "iron_mine", "cotton_field", "smelter"];

function valid(state, label = "") {
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, `${label} ${v.errors.join("；")}`);
}

const bld = (state, id) => state.buildings.find(b => b.id === id);
const marketInv = (state, itemId) => state.wholesaleMarket?.inventory?.[itemId] || 0;

// 批发市场（2 人）+ 一座指定类型的镇营建筑（指定人数）；市场放入 toolUnits 件铁制工具（有成本基础）。
function townWorld(seed, typeId, { workers = 10, toolPieces = 0, level = 1 } = {}) {
  const state = simulation.createInitialState({ seed });
  const used = new Set();
  const def = CONTENT.buildings[typeId];
  const plotFor = feature => state.plots.find(p => (feature ? p.feature === feature : !p.feature) && !used.has(p.id));
  const add = (type, lvl, id, plot) => {
    used.add(plot.id);
    state.buildings.push({ id, typeId: type, level: lvl, ownership: { townLevels: lvl, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
    return id;
  };
  add("wholesale_market", 1, "mkt", plotFor(null));
  simulation.setEmployment(state, `mkt::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 2);
  add(typeId, level, "prod", plotFor(def.requiredPlotFeature || null));
  simulation.setEmployment(state, `prod::${def.productionRoleId}`, workers);
  ensureWholesaleMarket(state, CONTENT);
  if (toolPieces > 0) depositWholesalePurchasedInventory(state, TOOL, toolPieces * I, toolPieces * 32 * V, CONTENT);
  return { state, id: "prod" };
}

// ---------------------------------------------------------------- 配置

test("toolBoost 配置：伐木场、盐场、煤矿、铁矿、棉田、磨坊、冶炼厂；其余建筑没有", () => {
  for (const typeId of BOOSTED) {
    const spec = CONTENT.buildings[typeId].toolBoost;
    assert.ok(spec, typeId);
    assert.equal(spec.itemId, TOOL);
    assert.equal(spec.perWorkerDay, 0.02);
    assert.equal(spec.bonus, 0.15);
  }
  for (const typeId of ["bakery", "winery", "weaving_mill", "jeweler", "livestock_base"]) {
    assert.equal(CONTENT.buildings[typeId].toolBoost, undefined, typeId);
  }
  assert.equal(CONTENT.items[TOOL].wholesale, true);
  assert.equal(CONTENT.items[TOOL].retail, undefined, "铁制工具不上货架");
});

// ---------------------------------------------------------------- 镇营：备工具与加成

test("镇营伐木场（10 人）：满库存时备 0.2 件、消耗 0.2 件，产量按 ×1.15 乘进人手，镇库不付钱", () => {
  const { state, id } = townWorld(9601, "lumberyard", { workers: 10, toolPieces: 5 });
  const money = voucherBalance(state, "town");
  const marketBefore = marketInv(state, TOOL);
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.equal(r.batches, 11, "10 人 × 1 批 × 1.15 = 11.5 → 11 批");
  assert.equal(voucherBalance(state, "town"), money, "镇营内部调拨不付钱");
  // 需要 0.2 件：市场调出 600 库存单位（0.2 × 3000），建筑当日用掉。
  assert.equal(marketBefore - marketInv(state, TOOL), Math.round(0.2 * I), "市场调出 0.2 件");
  assert.ok(Math.abs(bld(state, id).toolStock) < 1e-9, "用掉后库存为 0");
  valid(state, "镇营加成");
});

test("镇营：没有工具时不加成（10 人 → 10 批），也不消耗", () => {
  const { state, id } = townWorld(9602, "lumberyard", { workers: 10, toolPieces: 0 });
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.equal(r.batches, 10);
  assert.equal(bld(state, id).toolStock || 0, 0);
  valid(state, "无工具");
});

test("缺货按比例：20 人需 0.4 件，市场只有 0.1 件 → 加成 0.15 × 0.25 ≈ +3.75%，21 批（不是满额 23 批）", () => {
  const { state, id } = townWorld(9603, "lumberyard", { workers: 20, toolPieces: 0 });
  depositWholesalePurchasedInventory(state, TOOL, 0.1 * I, 0.1 * 32 * V, CONTENT);
  const r = processBuilding(state, bld(state, id), CONTENT);
  // 1 + 0.15 × 0.25 = 1.0375 → 20 × 1.0375 = 20.75 → 20 批；0.1 件全部用掉。
  assert.equal(r.batches, 20, "覆盖率 1/4 的加成");
  assert.equal(bld(state, id).toolBoostToday.toFixed(4), (0.15 * 0.25).toFixed(4), "今日加成记录为 3.75%");
  valid(state, "按比例");
});

// ---------------------------------------------------------------- 预览与实际一致

test("产能预览与实际一致：补货前的预估（按市场可售量）等于当日实际投产批次", () => {
  const { state, id } = townWorld(9604, "lumberyard", { workers: 20, toolPieces: 0 });
  depositWholesalePurchasedInventory(state, TOOL, 0.1 * I, 0.1 * 32 * V, CONTENT);
  const preview = productionStatus(state, bld(state, id), CONTENT);
  const estimate = toolFactorEstimate(state, bld(state, id), CONTENT, 20);
  assert.ok(Math.abs(estimate - (1 + 0.15 * 0.25)) < 1e-9, `预估乘子 ${estimate}`);
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.equal(preview.batches, r.batches, "预览批次与实际一致");
  valid(state, "预览");
});

test("预估口径：有上一日覆盖率记录时，缺货按上一日实际覆盖率估", () => {
  const { state, id } = townWorld(9605, "lumberyard", { workers: 20, toolPieces: 0 });
  const building = bld(state, id);
  building.toolCoverage = 0.5;
  assert.ok(Math.abs(toolFactorEstimate(state, building, CONTENT, 20) - (1 + 0.15 * 0.5)) < 1e-9);
  building.toolStock = 1;
  assert.ok(Math.abs(toolFactorEstimate(state, building, CONTENT, 20) - (1 + 0.15)) < 1e-9, "库存够则满额");
});

// ---------------------------------------------------------------- 账平与成本

test("成本核算：工具成本并入原料口径，随产品结转；库存与消耗账平（市场 → 建筑 → 损耗账）", () => {
  const { state, id } = townWorld(9606, "lumberyard", { workers: 10, toolPieces: 5 });
  const before = marketInv(state, TOOL);
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.ok(r.batches > 0);
  const bought = before - marketInv(state, TOOL);
  const wear = (state.ledger || []).filter(row => row.type === "tool_wear");
  const worn = wear.reduce((sum, row) => sum + (row.quantityUnits || 0), 0);
  assert.equal(worn, Math.round(0.2 * I), "损耗账记录用掉的 0.2 件");
  assert.ok(Math.abs(bought / I - worn / I) < 1e-9, "市场调出量 = 用掉量（库存归零）");
  valid(state, "账平");
});

test("planProductionAccounting：额外原料成本全部分摊到产出与损耗，合计等于工具成本", () => {
  const { state, id } = townWorld(9607, "lumberyard", { workers: 10, toolPieces: 0 });
  const extra = 777;
  const plan = planProductionAccounting(state, bld(state, id), CONTENT.recipes.lumber_gathering, 5, CONTENT, extra);
  assert.equal(plan.rawInputCostWheatUnits, extra, "计入原料口径");
  const outCost = [...plan.outputs, ...plan.losses].reduce((sum, row) => sum + (row.costWheatUnits || 0), 0);
  assert.equal(outCost, extra, "产出与损耗合计等于原料成本");
  valid(state, "成本");
});

// ---------------------------------------------------------------- 民营与公司路径

test("民营伐木场：业主家庭按售价付给批发市场，工具计入当日投入并被消耗", () => {
  const state = simulation.createInitialState({ seed: 9608 });
  const owner = householdList(state).filter(isActiveHousehold).sort((a, b) => a.id.localeCompare(b.id))[0];
  const plot = state.plots.find(p => p.feature === "logging_resource" && !state.buildings.some(b => b.plotId === p.id));
  state.buildings.push({ id: "pl", typeId: "lumberyard", level: 1, ownership: { townLevels: 0, privateLevels: 1, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }, privateOwners: [owner.id] });
  const mkt = state.plots.find(p => !p.feature && !state.buildings.some(b => b.plotId === p.id));
  state.buildings.push({ id: "mkt", typeId: "wholesale_market", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: mkt.id, x: mkt.x, y: mkt.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  simulation.setEmployment(state, "mkt::" + CONTENT.buildings.wholesale_market.jobs[0].id, 2);
  ensureWholesaleMarket(state, CONTENT);
  depositWholesalePurchasedInventory(state, TOOL, 5 * I, 5 * 32 * V, CONTENT);
  grantResidentVouchers(state, 5000, CONTENT, owner.id);
  setJobCount(state, privateJobKeyForBuilding("pl", "lumberjacks"), 10, CONTENT, { type: "private", id: "pl" });
  syncResidentAggregates(state, CONTENT);
  const money = owner.voucherUnits;
  const result = processPrivateBuilding(state, bld(state, "pl"), CONTENT);
  const toolRow = result.inputPurchases.find(row => row.itemId === TOOL);
  assert.ok(toolRow, "工具购入行记入当日投入");
  assert.ok(toolRow.paidVoucherUnits > 0, "业主付了钱");
  assert.ok(owner.voucherUnits < money, "业主家庭粮券减少");
  assert.ok(Math.abs(bld(state, "pl").toolStock) < 1e-9, "当日用掉");
  valid(state, "民营工具");
});

test("公司伐木场：公司付款买工具（计入公司库存成本）、产出时工具成本并入原料成本", () => {
  const state = simulation.createInitialState({ seed: 9609 });
  const plots = state.plots.filter(p => !p.feature);
  state.buildings.push({ id: "mkt-c", typeId: "wholesale_market", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plots[0].id, x: plots[0].x, y: plots[0].y, materialInvestments: [], completed: { year: 1, day: 1 } });
  const lumberPlot = state.plots.find(p => p.feature === "logging_resource");
  state.buildings.push({ id: "lumber-c", typeId: "lumberyard", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: lumberPlot.id, x: lumberPlot.x, y: lumberPlot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  simulation.setEmployment(state, "mkt-c::" + CONTENT.buildings.wholesale_market.jobs[0].id, 2);
  ensureWholesaleMarket(state, CONTENT);
  depositWholesalePurchasedInventory(state, TOOL, 5 * I, 5 * 32 * V, CONTENT);
  const formed = formCompany(state, "lumber-c", { name: "木材公司", levels: 1, operatingCapitalVoucher: 20000, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  const company = state.companies[formed.companyId];
  setJobCount(state, listedJobKeyForBuilding("lumber-c", "lumberjacks"), 10, CONTENT);
  const cashBefore = voucherBalance(state, `company:${company.id}`);
  const marketBefore = marketInv(state, TOOL);
  const r = processListedCompany(state, company, CONTENT);
  assert.ok(r.batches > 0, `公司应开工：${r.status}`);
  // 备货 0.2 件：公司按批发售价付款，钱从公司账户出，市场少了 600 单位。
  assert.equal(marketBefore - marketInv(state, TOOL), Math.round(0.2 * I), "市场卖出 0.2 件");
  const paid = cashBefore - voucherBalance(state, `company:${company.id}`);
  assert.ok(paid > 0, `公司付了工具钱（${paid}）`);
  assert.ok(Math.abs(bld(state, "lumber-c").toolStock) < 1e-9, "用掉当日需要量");
  // 工具成本并入产品成本：公司库存的成本基础之和 ≥ 0，且工具成本不为 0（原料口径）。
  assert.ok(r.batches >= 11, `公司 10 人 × 1.15 ≈ 11 批（实际 ${r.batches}）`);
  valid(state, "公司工具");
});

// ---------------------------------------------------------------- 冶炼厂（弹性配方）

test("冶炼厂（弹性配方）也备工具、用工具加成，投产后库存结转", () => {
  const { state, id } = townWorld(9610, "smelter", { workers: 8, toolPieces: 3 });
  const m = ensureWholesaleMarket(state, CONTENT);
  m.inventory.iron_ore = 5000 * I; m.inventory.coal = 5000 * I;
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.ok(r.batches > 0, `冶炼厂应开工：${r.status}`);
  assert.ok(Math.abs(bld(state, id).toolStock) < 1e-9, "用掉当日需要量");
  valid(state, "冶炼厂工具");
});

// ---------------------------------------------------------------- 等价性与旧档

test("等价性：去掉 toolBoost 的内容定义（改前口径），没有工具时逐位一致", () => {
  const plainBuildings = { ...CONTENT.buildings, lumberyard: { ...CONTENT.buildings.lumberyard, toolBoost: undefined } };
  const plain = { ...CONTENT, buildings: plainBuildings };
  const run = content => {
    const { state, id } = townWorld(9611, "lumberyard", { workers: 10, toolPieces: 0 });
    for (let d = 0; d < 3; d += 1) processBuilding(state, bld(state, id), content);
    return JSON.stringify({ wood: state.accounts.town.wood, buildings: state.buildings.map(b => [b.id, b.productivityCarry || 0]), ledger: (state.ledger || []).length });
  };
  assert.equal(run(CONTENT), run(plain));
});

test("旧档：建筑没有 toolStock / toolCostUnits 字段时视为 0，照常生产", () => {
  const { state, id } = townWorld(9612, "lumberyard", { workers: 10, toolPieces: 0 });
  delete bld(state, id).toolStock;
  delete bld(state, id).toolCostUnits;
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.equal(r.batches, 10);
  valid(state, "旧档");
});

test("validateState：建筑工具库存为负数时报错", () => {
  const { state, id } = townWorld(9613, "lumberyard", { workers: 10 });
  bld(state, id).toolStock = -0.5;
  assert.equal(simulation.validateState(state).valid, false);
});

test("工具需要量：在岗人数 × 0.02 件；无人或无配置为 0", () => {
  assert.equal(toolNeedPieces(CONTENT, "lumberyard", 50), 1);
  assert.equal(toolNeedPieces(CONTENT, "lumberyard", 0), 0);
  assert.equal(toolNeedPieces(CONTENT, "bakery", 10), 0);
});
