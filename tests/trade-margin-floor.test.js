import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { householdIdleWorkers, householdList } from "../src/systems/households.js";
import { settleTradingHouses } from "../src/systems/trading-houses.js";
import { ensureOutsideTowns, unitPrice, goodOf, outsideTownProfile } from "../src/systems/outside-town.js";
import { freightVoucherPerJin, trunkFreightRate, dockFreightRate } from "../src/systems/logistics.js";
import { policyTradeMarginPercent, tradeMarginFloorPercent } from "../src/economy/margin-policy.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function valid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

function freePlot(state) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => !row.feature && !used.has(row.id));
  assert.ok(plot, "需要空地");
  return plot;
}

function addBuilding(state, id, typeId) {
  const plot = freePlot(state);
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return id;
}

// 与 trade-tariff-staffing.test.js 的 tradeFixture 同口径：外贸房在岗、批发市场、贸易中心 1 级开一家贸易行。
// 盐批发价 10（出口利润约 46%）；木材默认无存货（不做木材，免得它抢走同一份预算与运力），需要时测试里自己放货。
// 池子默认 300 斤。
function tradeFixture(seed, { clerks = 10, pool = 300 } = {}) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "ftrade", "foreign_trade_house");
  addBuilding(state, "wm1", "wholesale_market");
  addBuilding(state, "tc1", "trade_center");
  simulation.setEmployment(state, "ftrade::trade_staff", 8);
  simulation.setEmployment(state, "wm1::wholesale_workers", 3);
  grantResidentVouchers(state, 300000);
  issueTownVouchers(state, 50000 * V, CONTENT, "测试：镇库付货款");
  assert.equal(simulation.configureWholesalePrice(state, "salt", 10).ok, true);
  assert.equal(simulation.configureWholesalePrice(state, "wood", 16).ok, true);
  state.wholesaleMarket.inventory.salt = 5000 * I;
  state.wholesaleMarket.inventory.wood = 0;
  state.wholesaleMarket.inventory.flour = 0;
  state.logistics.poolJin = pool;
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, "tc1", "trading_house", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, clerks).ok, true);
  transferVouchers(state, "town", `shop:${opened.shopId}`, 20000 * V, CONTENT, "test", "测试：贸易行周转金");
  // 只做民镇一镇，避免两镇分配预算干扰断言。
  ensureOutsideTowns(state, CONTENT).wangzhen.tradeClosed = true;
  return { state, shop: state.shops[opened.shopId] };
}

function lastRow(shop) {
  return shop.tradeLog.at(-1);
}

// 民镇某商品的卖价 / 买价（斤小麦 = 券，与 trading-houses 的排序口径一致）。
function minzhenPrices(state, itemId) {
  const town = ensureOutsideTowns(state, CONTENT).minzhen;
  const good = goodOf(outsideTownProfile(CONTENT, "minzhen"), itemId);
  return { sell: unitPrice(town, good, "sell"), buy: unitPrice(town, good, "buy") };
}

test("旧档烘焙的贸易行门槛（出口 20、进口 25，无 tradeMarginSet）读入后有效门槛是 5 / 5", () => {
  const { state } = tradeFixture(9301);
  state.policy.tradeMarginPercent = 20;
  state.policy.tradeImportMarginPercent = 25;
  delete state.policy.tradeMarginSet;
  assert.equal(policyTradeMarginPercent(state, CONTENT, "export"), 5);
  assert.equal(policyTradeMarginPercent(state, CONTENT, "import"), 5);
  valid(state, "旧烘焙值");
});

test("旧烘焙值的行为：盐的利润率约 10%，旧门槛 20% 会挡住、有效门槛 5% 应放行", () => {
  const { state, shop } = tradeFixture(9302, { pool: 300 });
  // 盐批发价 13.3 → 出口利润率约 10%（卖价 14.73、成本 13.38）。
  assert.equal(simulation.configureWholesalePrice(state, "salt", 13.3).ok, true);
  delete state.policy.tradeMarginSet;
  state.policy.tradeMarginPercent = 20;
  settleTradingHouses(state, CONTENT);
  assert.ok((lastRow(shop).exportJin.salt || 0) > 0, "旧烘焙 20 不应挡住 10% 利润的出口");
  valid(state, "旧烘焙放行");
});

test("玩家用 setMarginPolicy 设成 20 后（tradeMarginSet=true）有效门槛就是 20，不被当成旧值", () => {
  const { state, shop } = tradeFixture(9303, { pool: 300 });
  assert.equal(simulation.configureWholesalePrice(state, "salt", 13.3).ok, true);
  const set = simulation.setMarginPolicy(state, { tradeMarginPercent: 20 });
  assert.equal(set.ok, true, set.reason);
  assert.equal(state.policy.tradeMarginSet, true);
  assert.equal(policyTradeMarginPercent(state, CONTENT, "export"), 20);
  settleTradingHouses(state, CONTENT);
  assert.equal(lastRow(shop).exportJin.salt || 0, 0, "玩家设的 20% 门槛挡住 10% 利润的出口");
  valid(state, "玩家设 20");
});

test("玩家设成进口 25（tradeMarginSet=true）时有效门槛为 25，不因为与旧烘焙值相同而被忽略", () => {
  const { state } = tradeFixture(9304);
  const set = simulation.setMarginPolicy(state, { tradeImportMarginPercent: 25 });
  assert.equal(set.ok, true, set.reason);
  assert.equal(policyTradeMarginPercent(state, CONTENT, "import"), 25);
  valid(state, "玩家设进口 25");
});

test("setMarginPolicy 拒绝低于 5% 的贸易行门槛（出口 / 进口），不写入；5% 本身放行；综合商店不受此下限", () => {
  const { state } = tradeFixture(9305);
  assert.equal(tradeMarginFloorPercent(CONTENT), 5);
  const before = JSON.stringify(state.policy);
  for (const patch of [{ tradeMarginPercent: 4.9 }, { tradeMarginPercent: 0 }, { tradeImportMarginPercent: 3 }]) {
    const result = simulation.setMarginPolicy(state, patch);
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.match(result.reason, /下限\s*5%/);
  }
  assert.equal(JSON.stringify(state.policy), before, "被拒绝的设定不得写入政策");
  assert.equal(simulation.setMarginPolicy(state, { tradeMarginPercent: 5 }).ok, true);
  assert.equal(policyTradeMarginPercent(state, CONTENT, "export"), 5);
  assert.equal(simulation.setMarginPolicy(state, { shopMarginPercent: 3 }).ok, true, "综合商店利润率不受贸易行下限约束");
  valid(state, "下限");
});

test("排序按每斤净赚：利润率低但每斤赚得多的木材，排在利润率高但每斤赚得少的盐前面（运力只够一条时做前者）", () => {
  const { state, shop } = tradeFixture(9306, { pool: 40 });
  state.wholesaleMarket.inventory.wood = 5000 * I;
  // 盐：卖 14.73、买 10 + 运费 0.083 → 利润率 46%，每斤净赚 4.65。
  // 木材：卖 22.10、买 16 + 运费 0.083 → 利润率 37%，每斤净赚 6.01。
  const salt = minzhenPrices(state, "salt");
  const wood = minzhenPrices(state, "wood");
  const ratio = (sell, cost) => sell / (cost + freightVoucherPerJin(state, CONTENT)) - 1;
  const perJin = (sell, cost) => sell - (cost + freightVoucherPerJin(state, CONTENT));
  assert.ok(ratio(salt.sell, 10) > ratio(wood.sell, 16), "盐利润率应高于木材");
  assert.ok(perJin(wood.sell, 16) > perJin(salt.sell, 10), "木材每斤净赚应高于盐");
  settleTradingHouses(state, CONTENT);
  const row = lastRow(shop);
  assert.ok((row.exportJin.wood || 0) > 0, "木材每斤赚得多，应当先做");
  assert.equal(row.exportJin.salt || 0, 0, "运力已用完，盐不应再出口");
  assert.ok(Math.abs(row.exportJin.wood - 40) < 0.02, `木材应吃满 40 斤运力池，实际 ${row.exportJin.wood}`);
  valid(state, "排序");
});

test("排序中出口乘 tradeHouseExportPriority（1.5）：出口每斤净赚 4.65×1.5≈6.97 才压过进口 5.50；进口 7.50 则进口先做", () => {
  // 出口：盐（每斤净赚 4.65）。进口：面粉（买 2.00、运费 0.08，收购价改成 Q+2.09 使每斤净赚为 Q）。
  // 运力池只有 15 斤（面粉进口最多 20 斤库存余量，够它吃满）：谁排前面谁吃满池子。
  const run = (flourPurchase) => {
    const { state, shop } = tradeFixture(9307, { pool: 15 });
    assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", flourPurchase).ok, true);
    settleTradingHouses(state, CONTENT);
    return lastRow(shop);
  };
  const exportFirst = run(5.5 + 2.09);
  assert.ok(Math.abs((exportFirst.exportJin.salt || 0) - 15) < 0.02, `出口 6.97 > 进口 5.50，应先出口盐：${JSON.stringify(exportFirst.exportJin)}`);
  assert.equal(exportFirst.importJin.flour || 0, 0);
  const importFirst = run(7.5 + 2.09);
  assert.ok(Math.abs((importFirst.importJin.flour || 0) - 15) < 0.02, `进口 7.50 > 出口 6.97，应先进口面粉：${JSON.stringify(importFirst.importJin)}`);
  assert.equal(importFirst.exportJin.salt || 0, 0);
});

test("运费 = 人力成本：运费单价等于物流脚夫日薪 ÷ 每人日运力；出口与进口的利润都等于 销售额 − 成本 − 运费 − 关税", () => {
  const { state, shop } = tradeFixture(9308);
  const jobWage = (typeId, jobId) => CONTENT.buildings[typeId].jobs.find(job => job.id === jobId).wagePerWorkerDay;
  assert.equal(trunkFreightRate(CONTENT), jobWage("logistics_center", "porters") / CONTENT.rules.logisticsJinPerWorker);
  assert.equal(dockFreightRate(CONTENT), jobWage("dock", "dockers") / CONTENT.rules.dockJinPerWorker);
  assert.equal(freightVoucherPerJin(state, CONTENT), trunkFreightRate(CONTENT), "无码头时运费按脚夫人力成本");

  // 出口：盐，运费按斤计付给镇库。
  settleTradingHouses(state, CONTENT);
  const exportRow = lastRow(shop);
  const exportJin = exportRow.exportJin.salt;
  assert.ok(exportJin > 0, "应有出口");
  assert.ok(Math.abs(exportRow.freightVoucherUnits - Math.ceil(exportJin * trunkFreightRate(CONTENT) * V - 1e-9)) <= 1, "运费 = 斤数 × 人力成本");
  assert.equal(exportRow.profitVoucherUnits, exportRow.revenueVoucherUnits - exportRow.cogsVoucherUnits - exportRow.freightVoucherUnits - exportRow.tariffVoucherUnits);
  valid(state, "出口运费");

  // 进口：面粉（收购价抬到 7.5 使进口有利可图）。
  const { state: s2, shop: shop2 } = tradeFixture(9309, { pool: 300 });
  assert.equal(simulation.configureWholesalePurchasePrice(s2, "flour", 7.5).ok, true);
  // 盐也会抢预算（每斤净赚更高），这里清空盐存货，只测面粉进口的运费。
  s2.wholesaleMarket.inventory.salt = 0;
  settleTradingHouses(s2, CONTENT);
  const importRow = lastRow(shop2);
  const importJin = importRow.importJin.flour;
  assert.ok(importJin > 0, "应有进口");
  assert.ok(Math.abs(importRow.freightVoucherUnits - Math.ceil(importJin * trunkFreightRate(CONTENT) * V - 1e-9)) <= 1, "进口运费同样按人力成本");
  assert.equal(importRow.profitVoucherUnits, importRow.revenueVoucherUnits - importRow.cogsVoucherUnits - importRow.freightVoucherUnits - importRow.tariffVoucherUnits);
  valid(s2, "进口运费");
});

test("仪表盘政策视图：旧档烘焙的 20/25 显示为有效门槛 5/5，玩家设置过的值如实显示", () => {
  const state = simulation.createInitialState({ seed: 8801 });
  state.policy.tradeMarginPercent = 20;
  state.policy.tradeImportMarginPercent = 25;
  delete state.policy.tradeMarginSet;
  let view = simulation.selectDashboard(state);
  assert.equal(view.policy.tradeMarginPercent, 5);
  assert.equal(view.policy.tradeImportMarginPercent, 5);
  assert.equal(simulation.setMarginPolicy(state, { tradeMarginPercent: 20 }).ok, true);
  view = simulation.selectDashboard(state);
  assert.equal(view.policy.tradeMarginPercent, 20);
  assert.equal(view.policy.tradeImportMarginPercent, 20, "旧档烘焙的进口 25 视为默认 5，低于出口 20，联动抬到 20");
});
