import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { jobKeyForBuilding, readJobCount } from "../src/selectors/labor.js";
import { selectConstructionOptions } from "../src/selectors/dashboard.js";
import { setJobCount } from "../src/systems/households.js";
import { DAILY_STEPS } from "../src/systems/daily.js";
import { migrateSave } from "../src/persistence/migrations.js";
import {
  dailyCapacityBySource, dailyCapacityJin, freightVoucherPerJin, selectLogisticsView,
  stepLogistics, takeFreightCapacity, refundFreightCapacity
} from "../src/systems/logistics.js";
import { settleTradeAgreementsMonth } from "../src/systems/trade-agreements.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const RULES = CONTENT.rules;

function freshState(seed) {
  return simulation.createInitialState({ seed });
}

// 第一块没有建筑的空地（普通地块或河岸地块）。
function freePlot(state, feature = null) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => (feature ? row.feature === feature : !row.feature) && !used.has(row.id));
  assert.ok(plot, "需要空地");
  return plot;
}

// 直接落成一座建筑（跳过施工，只用于设定夹具）。
function addBuilding(state, id, typeId, plot) {
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return id;
}

function addTradeHouse(state, staffCount = 2) {
  addBuilding(state, "ftrade", "foreign_trade_house", freePlot(state));
  setJobCount(state, "ftrade::trade_staff", staffCount, CONTENT);
}

// 给某建筑的某岗位派工，返回实际在岗人数。
function staffJob(state, buildingId, jobId, count) {
  const key = jobKeyForBuilding(buildingId, jobId);
  setJobCount(state, key, count, CONTENT);
  return readJobCount(state, key);
}

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

function tradingState(seed, pool) {
  const state = freshState(seed);
  addTradeHouse(state);
  state.logistics.poolJin = pool;
  state.accounts.town.salt = (state.accounts.town.salt || 0) + 50000 * I;
  state.accounts.town.flour = (state.accounts.town.flour || 0) + 50000 * I;
  return state;
}

// 有外贸房与批发市场、签了一年 1200 斤盐的长协（月交 100 斤），运力池设为 pool。
function agreementState(seed, pool) {
  const state = freshState(seed);
  addTradeHouse(state);
  addBuilding(state, "wm1", "wholesale_market", freePlot(state));
  state.wholesaleMarket.inventory.salt = 10000 * I;
  const signed = simulation.signTradeAgreement(state, { itemId: "salt", annualJin: 1200, years: 2 });
  assert.equal(signed.ok, true, signed.reason);
  state.logistics.poolJin = pool;
  return state;
}

test("日运力：外贸房在岗给基础运力，物流中心与码头按在岗人数计，空岗位不算", () => {
  const state = freshState(7301);
  assert.equal(dailyCapacityJin(state, CONTENT), 0, "没有外贸房时没有运力");
  addTradeHouse(state);
  assert.equal(dailyCapacityJin(state, CONTENT), RULES.tradeBaseCapacityJin);
  addBuilding(state, "lc1", "logistics_center", freePlot(state));
  addBuilding(state, "lc2", "logistics_center", freePlot(state));
  assert.equal(staffJob(state, "lc1", "porters", 5), 5);
  addBuilding(state, "dock1", "dock", freePlot(state, "riverside"));
  assert.equal(staffJob(state, "dock1", "dockers", 3), 3);
  assert.deepEqual(dailyCapacityBySource(state, CONTENT), {
    foreignTradeHouse: 300, logisticsCenter: 5 * 60, dock: 3 * 120
  });
  assert.equal(dailyCapacityJin(state, CONTENT), 300 + 300 + 360);
  assertValid(state, "运力建筑派工后");
});

test("外贸房无人值守时没有基础运力", () => {
  const state = freshState(7302);
  addTradeHouse(state, 0);
  assert.equal(dailyCapacityBySource(state, CONTENT).foreignTradeHouse, 0);
  assert.equal(dailyCapacityJin(state, CONTENT), 0);
});

test("运力池：每日补充日运力，最多攒 30 天的量，取用后再补", () => {
  const state = freshState(7303);
  addTradeHouse(state);
  const daily = RULES.tradeBaseCapacityJin;
  const first = stepLogistics(state, CONTENT);
  assert.equal(first.capacityJin, daily);
  assert.equal(state.logistics.poolJin, daily);
  for (let i = 0; i < 40; i++) stepLogistics(state, CONTENT);
  assert.equal(state.logistics.poolJin, daily * RULES.freightPoolMaxDays, "池子封顶 30 天的日运力");
  assert.ok(state.logistics.history.length <= 30, "历史最多 30 行");

  const granted = takeFreightCapacity(state, 1000, CONTENT);
  assert.equal(granted, 1000);
  stepLogistics(state, CONTENT);
  assert.equal(state.logistics.poolJin, daily * RULES.freightPoolMaxDays - 1000 + daily, "取用后下一天只补日运力");
  assert.equal(state.logistics.history.at(-1).usedJin, 1000, "历史行记录当天已用运力");
  assert.equal(state.logistics.usedToday, 0, "每日结算后当日已用量清零");
  assertValid(state, "运力池日结后");
});

test("运力扣减与回滚：扣不超过池子余量，回滚把斤数还回池子", () => {
  const state = freshState(7312);
  state.logistics.poolJin = 50;
  assert.equal(takeFreightCapacity(state, 80, CONTENT), 50, "只批准池子里有的 50 斤");
  assert.equal(state.logistics.poolJin, 0);
  refundFreightCapacity(state, 30);
  assert.equal(state.logistics.poolJin, 30);
  assert.equal(state.logistics.usedToday, 20);
});

test("日结流水线：logistics 排在用工之后、所有贸易步骤之前", () => {
  const ids = DAILY_STEPS.map(step => step.id);
  const at = id => ids.indexOf(id);
  assert.ok(at("logistics") > at("staffing"));
  assert.ok(at("logistics") < at("trade"));
  assert.ok(at("logistics") < at("saltTrade"));
  assert.ok(at("logistics") < at("tradeAgreementMonth"));
  assert.ok(at("logistics") < at("outsideTownDay"));
});

test("镇长手动外贸受运力限制：池子空了拒绝并给出原因，有余量只做到余量", () => {
  const empty = tradingState(7304, 0);
  const refused = simulation.tradeWithOutsideTown(empty, "sell", "salt", 100);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "运力不足：今天最多还能运0斤");

  const limited = tradingState(7305, 50);
  const sold = simulation.tradeWithOutsideTown(limited, "sell", "salt", 100);
  assert.equal(sold.ok, true, sold.reason);
  assert.ok(sold.quantityJin <= 50 + 1e-9, `只能运池子里的 50 斤，实际 ${sold.quantityJin}`);
  assert.ok(Math.abs(limited.logistics.poolJin - (50 - sold.quantityJin)) < 1e-6, "成交斤数从池子扣");
  assertValid(limited, "出口之后");

  const bought = tradingState(7306, 40);
  const imported = simulation.tradeWithOutsideTown(bought, "buy", "flour", 500);
  assert.equal(imported.ok, true, imported.reason);
  assert.ok(imported.quantityJin <= 40 + 1e-9, `进口也要占运力，实际 ${imported.quantityJin}`);
  assert.ok(Math.abs(bought.logistics.poolJin - (40 - imported.quantityJin)) < 1e-6);
  assertValid(bought, "进口之后");
});

test("外贸失败时不扣运力", () => {
  const state = tradingState(7307, 50);
  state.accounts.town.salt = 0;
  const result = simulation.tradeWithOutsideTown(state, "sell", "salt", 20);
  assert.equal(result.ok, false);
  assert.equal(state.logistics.poolJin, 50);
  assert.equal(state.logistics.usedToday, 0);
});

test("长期协定交付受运力限制：能运的照常交付，余下按违约处理并写明运力不足", () => {
  const state = agreementState(7308, 40);
  const result = settleTradeAgreementsMonth(state, CONTENT);
  const agreement = state.tradeAgreements[0];
  assert.equal(result.delivered, 1, "能运的 40 斤照常交付");
  assert.equal(result.breached, 1, "余下 60 斤按违约处理");
  assert.ok(Math.abs(agreement.totalDeliveredJin - 40) < 0.01, `交付 40 斤，实际 ${agreement.totalDeliveredJin}`);
  assert.equal(agreement.breachCount, 1);
  assert.ok(state.events.some(event => event.text.includes("运力不足")), "事件文字写明运力不足");
  assert.ok(state.logistics.poolJin < 1e-6, "运力全部用完");
  assertValid(state, "运力不足的月交付后");
});

test("长期协定运力充足时全额交付，不违约，运力按交付量扣", () => {
  const state = agreementState(7309, 1000);
  const result = settleTradeAgreementsMonth(state, CONTENT);
  const agreement = state.tradeAgreements[0];
  assert.equal(result.delivered, 1);
  assert.equal(result.breached, 0);
  assert.equal(agreement.breachCount, 0);
  assert.ok(Math.abs(agreement.totalDeliveredJin - 100) < 0.01);
  assert.ok(Math.abs(state.logistics.poolJin - 900) < 1e-6, "扣掉本月 100 斤");
  assertValid(state, "全额交付后");
});

test("运费：按日运力加权，物流中心与外贸房为 0.06，码头为 0.03；没有运力时取 0.06", () => {
  const empty = freshState(7310);
  assert.equal(freightVoucherPerJin(empty, CONTENT), RULES.freightVoucherPerJin, "没有运力取基础运费");

  const dockOnly = freshState(7311);
  addBuilding(dockOnly, "dock1", "dock", freePlot(dockOnly, "riverside"));
  staffJob(dockOnly, "dock1", "dockers", 2);
  assert.ok(Math.abs(freightVoucherPerJin(dockOnly, CONTENT) - RULES.dockFreightVoucherPerJin) < 1e-9, "只有码头时取码头运费");

  const trunkOnly = freshState(7312);
  addTradeHouse(trunkOnly);
  addBuilding(trunkOnly, "lc1", "logistics_center", freePlot(trunkOnly));
  staffJob(trunkOnly, "lc1", "porters", 5);
  assert.equal(freightVoucherPerJin(trunkOnly, CONTENT), RULES.freightVoucherPerJin, "外贸房与物流中心取基础运费");

  const mixed = freshState(7313);
  addTradeHouse(mixed);
  addBuilding(mixed, "dock1", "dock", freePlot(mixed, "riverside"));
  staffJob(mixed, "dock1", "dockers", 1);
  const expected = (300 * RULES.freightVoucherPerJin + 120 * RULES.dockFreightVoucherPerJin) / 420;
  assert.ok(Math.abs(freightVoucherPerJin(mixed, CONTENT) - expected) < 1e-9, "按日运力加权");
});

test("河岸地块：只能建码头和外贸房，其他建筑被拒并给出原因", () => {
  const state = freshState(7314);
  state.accounts.town.wood = (state.accounts.town.wood || 0) + 10000 * I;

  const millOnRiver = simulation.buildAt(state, "mill", "riverside-01");
  assert.equal(millOnRiver.ok, false);
  assert.equal(millOnRiver.reason, "河岸地块只能建码头或外贸房");

  const logisticsOnRiver = simulation.buildAt(state, "logistics_center", "riverside-01");
  assert.equal(logisticsOnRiver.ok, false);
  assert.equal(logisticsOnRiver.reason, "河岸地块只能建码头或外贸房");

  const dockOffRiver = simulation.buildAt(state, "dock", "village-01");
  assert.equal(dockOffRiver.ok, false);
  assert.equal(dockOffRiver.reason, "码头只能建在河岸地块");

  const dock = simulation.buildAt(state, "dock", "riverside-01");
  assert.equal(dock.ok, true, dock.reason);
  const tradeHouse = simulation.buildAt(state, "foreign_trade_house", "riverside-02");
  assert.equal(tradeHouse.ok, true, tradeHouse.reason);
});

test("建造选址：码头只列河岸地块，外贸房在普通空地外多列河岸地块，其他建筑不列河岸", () => {
  const state = freshState(7315);
  const options = new Map(selectConstructionOptions(state, CONTENT).map(row => [row.id, row]));
  const riverside = ["riverside-01", "riverside-02", "riverside-03", "riverside-04"];
  assert.deepEqual([...options.get("dock").allowedPlotIds].sort(), riverside);
  assert.ok(options.get("foreign_trade_house").allowedPlotIds.includes("riverside-01"));
  assert.ok(options.get("foreign_trade_house").allowedPlotIds.includes("village-01"));
  assert.equal(options.get("mill").allowedPlotIds.some(id => id.startsWith("riverside-")), false);
  assert.equal(options.get("logistics_center").allowedPlotIds.some(id => id.startsWith("riverside-")), false);
});

test("运力状态存档往返不丢；坏数据被校验拦下；选择器只读", () => {
  const state = freshState(7316);
  addTradeHouse(state);
  stepLogistics(state, CONTENT);
  takeFreightCapacity(state, 120, CONTENT);
  const loaded = migrateSave(JSON.parse(JSON.stringify(state)), CONTENT);
  assert.equal(loaded.logistics.poolJin, state.logistics.poolJin);
  assert.equal(loaded.logistics.usedToday, 120);
  assert.deepEqual(loaded.logistics.history, state.logistics.history);
  assertValid(loaded, "读档后");

  const before = JSON.stringify(state);
  const view = selectLogisticsView(state, CONTENT);
  assert.equal(JSON.stringify(state), before, "选择器不写 state");
  assert.equal(view.poolJin, state.logistics.poolJin);
  assert.equal(view.dailyCapacityJin, RULES.tradeBaseCapacityJin);
  assert.equal(view.capacityBySource.foreignTradeHouse, RULES.tradeBaseCapacityJin);
  assert.equal(simulation.selectDashboard(state).logistics.dailyCapacityJin, RULES.tradeBaseCapacityJin);

  const broken = structuredClone(state);
  broken.logistics.poolJin = Number.NaN;
  const check = simulation.validateState(broken);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(text => text.includes("运力账户无效")), check.errors.join("；"));
});
