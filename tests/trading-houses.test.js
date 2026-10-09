import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers, voucherBalance } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { DAILY_STEPS } from "../src/systems/daily.js";
import { householdIdleWorkers, householdList } from "../src/systems/households.js";
import { settleTradingHouses, localAvgSoldJin } from "../src/systems/trading-houses.js";
import { ensureOutsideTowns } from "../src/systems/outside-town.js";
import { selectTradeHouseView } from "../src/selectors/trade-houses.js";
import { migrateSave } from "../src/persistence/migrations.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const RULES = CONTENT.rules;
const POOL_JIN = 300; // tradeFixture 默认运力池
const SHARE_JIN = POOL_JIN * RULES.tradeHouseCapacityShare; // 单店独占时的运力份额（斤）

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

// 外贸房（在岗，提供基础运力 300 斤/日，贸易行分到 rules.tradeHouseCapacityShare）、批发市场、贸易中心（1 级，2 个铺位）。
// 镇库印制粮券，镇里有钱付批发货款。盐的批发售价压到 10（外镇收购价约 12.25，够 10% 利润）。
function tradeFixture(seed, { clerks = 10, pool = 300, houses = 1 } = {}) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "ftrade", "foreign_trade_house");
  addBuilding(state, "wm1", "wholesale_market");
  addBuilding(state, "tc1", "trade_center");
  simulation.setEmployment(state, "ftrade::trade_staff", 8);
  simulation.setEmployment(state, "wm1::wholesale_workers", 3);
  grantResidentVouchers(state, 300000);
  issueTownVouchers(state, 50000 * V, CONTENT, "测试：镇库付货款");
  assert.equal(simulation.configureWholesalePrice(state, "salt", 10).ok, true);
  state.wholesaleMarket.inventory.salt = 5000 * I;
  state.logistics.poolJin = pool;
  const shopIds = [];
  const clerkList = Array.isArray(clerks) ? clerks : Array.from({ length: houses }, () => clerks);
  // 660 户时每户只有几百粮券，店主要付启动资金 + 生活储备：为每家贸易行指定一户有空闲劳力的店主并给足粮券。
  for (let i = 0; i < houses; i++) {
    // 每次现找：前一家店雇的店员会占用空闲劳力。
    const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
    assert.ok(owner, "需要一户有空闲劳力的店主");
    assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
    const opened = simulation.openResidentShop(state, "tc1", "trading_house", owner.id);
    assert.equal(opened.ok, true, opened.reason);
    // 刚雇的店员 30 天内不能解雇，所以店员数在开店时就定好。
    assert.equal(simulation.configureShopClerks(state, opened.shopId, clerkList[i]).ok, true);
    transferVouchers(state, "town", `shop:${opened.shopId}`, 20000 * V, CONTENT, "test", "测试：贸易行周转金");
    shopIds.push(opened.shopId);
  }
  return { state, shopIds, shop: state.shops[shopIds[0]] };
}

// 批发市场近 7 日销量（斤）：快照成与 wholesaleAvgSoldUnits 同样的结构。
function setMarketSales(state, itemId, jinPerDay) {
  state.wholesaleMarket.history = Array.from({ length: 7 }, (_, i) => ({
    year: 1, day: i, inventory: {}, sold: { [itemId]: jinPerDay * I }, unmet: {}, townConsumed: {}, price: {}
  }));
}

function lastRow(shop) {
  return shop.tradeLog.at(-1);
}

test("贸易中心：只能开在贸易中心，每级 2 个铺位；商业街开不了贸易行", () => {
  const { state } = tradeFixture(9101, { houses: 0 });
  addBuilding(state, "street", "commercial_street");
  const wrongHost = simulation.openResidentShop(state, "street", "trading_house");
  assert.equal(wrongHost.ok, false);
  assert.match(wrongHost.reason, /贸易中心/);
  // 660 户时店主需指定并给足粮券（自动选店主只会挑到粮券最厚的一户，这里逐户指定）。
  const openWithOwner = () => {
    const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
    assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
    return simulation.openResidentShop(state, "tc1", "trading_house", owner.id);
  };
  assert.equal(openWithOwner().ok, true);
  assert.equal(openWithOwner().ok, true);
  const third = openWithOwner();
  assert.equal(third.ok, false);
  assert.match(third.reason, /贸易中心没有空位/);
  valid(state, "开店后");
});

test("出口：批发存货有余量、利润率够 10% 时卖给外镇，运费付镇库，外镇库存与小麦变化同手动外贸", () => {
  const { state, shop } = tradeFixture(9102);
  const town = ensureOutsideTowns(state, CONTENT).minzhen;
  const beforeStock = town.stocks.salt;
  const beforeWheat = town.wheatStockJin;
  const beforeStats = { trades: town.stats.trades, exportJin: town.stats.exportJin };
  const beforeMarket = state.wholesaleMarket.inventory.salt;
  const beforeTownVouchers = voucherBalance(state, "town");
  const beforeRelations = town.relations;

  settleTradingHouses(state, CONTENT);
  const row = lastRow(shop);
  const sold = row.exportJin.salt;
  assert.ok(sold > 0, "应当出口盐");
  assert.ok(Math.abs(sold - SHARE_JIN) < 0.02, `运力份额 = 日运力 300 × tradeHouseCapacityShare，单店独占：${sold}`);
  assert.equal(row.usedJin, sold);
  assert.equal(row.trades, 1);

  // 外镇：库存涨、小麦降、统计与关系照常记。
  assert.ok(Math.abs(town.stocks.salt - (beforeStock + sold)) < 0.02, "外镇盐库存增加");
  assert.ok(town.wheatStockJin < beforeWheat, "外镇付小麦");
  assert.equal(town.stats.trades, beforeStats.trades + 1);
  assert.ok(town.stats.exportJin > beforeStats.exportJin, "记入出口统计");
  assert.ok(town.relations >= beforeRelations, "成交不降关系");

  // 批发市场：盐出库，售价 10 元/斤。
  assert.equal(state.wholesaleMarket.inventory.salt, beforeMarket - sold * I);
  // 小麦进店：收入 = 外镇付的小麦；成本 = 批发售价；运费 = 斤数 × 0.06 券。
  const revenue = row.revenueVoucherUnits / V;
  assert.ok(revenue > sold * 12, "外镇收购价约 12.25 斤/斤");
  assert.equal(row.cogsVoucherUnits, sold * 10 * V, "成本按批发售价");
  assert.equal(row.freightVoucherUnits, Math.ceil(sold * RULES.freightVoucherPerJin * V - 1e-9), "运费按 0.06 券/斤付镇库");
  assert.ok(row.profitVoucherUnits > 0, "有利润");
  assert.ok(shop.cashWheatUnits > 0, "收到的小麦存在贸易行账上");
  assert.ok(voucherBalance(state, "town") > beforeTownVouchers, "运费进了镇库");
  valid(state, "出口后");
});

test("批发存货不到 10 天销量时不出口，超出部分才出口", () => {
  // 日销 100 斤，存货 500 斤（5 天）：不出口。
  const short = tradeFixture(9103);
  setMarketSales(short.state, "salt", 100);
  short.state.wholesaleMarket.inventory.salt = 500 * I;
  settleTradingHouses(short.state, CONTENT);
  assert.equal(Object.keys(lastRow(short.shop).exportJin).length, 0, "存货只够 5 天，不出口");
  assert.equal(lastRow(short.shop).trades, 0);

  // 存货 1500 斤（15 天）：只出超出 10 天（1000 斤）的 500 斤，且不超过运力份额（300 × tradeHouseCapacityShare）。
  const enough = tradeFixture(9104);
  setMarketSales(enough.state, "salt", 100);
  enough.state.wholesaleMarket.inventory.salt = 1500 * I;
  settleTradingHouses(enough.state, CONTENT);
  const sold = lastRow(enough.shop).exportJin.salt;
  assert.ok(Math.abs(sold - Math.min(500, SHARE_JIN)) < 0.02, `应出 min(500, 份额) 斤，实际 ${sold}`);
  assert.ok(enough.state.wholesaleMarket.inventory.salt / I >= 1000 - 0.01, "市场至少留下 10 天销量");
  valid(enough.state, "保本地供应");
});

test("本镇销量扣掉贸易行自己的出口进货：保本线按本镇真实需求算，出口不会自我抑制", () => {
  const { state, shop } = tradeFixture(9105);
  // 批发售出 250 斤/日，其中 150 斤是贸易行每天买走出口的，本镇真实需求 100 斤/日。
  setMarketSales(state, "salt", 250);
  shop.tradeLog = Array.from({ length: 7 }, (_, i) => ({ serial: i + 1, exportJin: { salt: 150 }, importJin: {} }));
  assert.ok(Math.abs(localAvgSoldJin(state, CONTENT, "salt") - 100) < 0.01);
  // 没有销量历史时本镇需求为 0。
  state.wholesaleMarket.history = [];
  assert.equal(localAvgSoldJin(state, CONTENT, "salt"), 0);
});

test("利润率不到 10% 不做：外镇收购价 12.25，批发售价 12 时不出口", () => {
  const { state, shop } = tradeFixture(9106);
  assert.equal(simulation.configureWholesalePrice(state, "salt", 12).ok, true);
  settleTradingHouses(state, CONTENT);
  assert.equal(lastRow(shop).trades, 0);
  assert.equal(lastRow(shop).usedJin, 0);
  assert.equal(state.wholesaleMarket.inventory.salt, 5000 * I, "市场存货不动");
});

test("进口：店里有小麦、批发收购价够高时，向外镇买面粉，按收购价卖回批发市场", () => {
  const { state, shop } = tradeFixture(9107);
  // 只测进口：盐不做出口（否则同一天外镇付的小麦会混进来）。面粉：外镇售价约 2.0 斤/斤，批发收购价 2.6 → 利润够 10%。
  assert.equal(simulation.configureWholesalePrice(state, "salt", 12).ok, true);
  assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 2.6).ok, true);
  shop.cashWheatUnits = 1000 * I;
  const town = ensureOutsideTowns(state, CONTENT).minzhen;
  const beforeFlour = town.stocks.flour;
  const beforeWheat = town.wheatStockJin;
  const beforeMarket = state.wholesaleMarket.inventory.flour || 0;
  const beforeShopWheat = shop.cashWheatUnits;
  const beforeShopVouchers = shop.cashVoucherUnits;

  settleTradingHouses(state, CONTENT);
  const row = lastRow(shop);
  const bought = row.importJin.flour;
  assert.ok(bought > 0, "应当进口面粉");
  assert.ok(bought <= 20 + 0.01, "没有销量历史时进口封顶 20 斤");
  assert.ok(Math.abs(town.stocks.flour - (beforeFlour - bought)) < 0.02, "外镇面粉减少");
  assert.ok(town.wheatStockJin > beforeWheat, "外镇收到小麦");
  assert.ok(shop.cashWheatUnits < beforeShopWheat, "店里付出小麦");
  assert.equal(state.wholesaleMarket.inventory.flour, beforeMarket + Math.round(bought * I), "面粉入批发市场");
  assert.ok(shop.cashVoucherUnits > beforeShopVouchers, "批发市场付粮券给店里");
  assert.ok(row.profitVoucherUnits > 0, "进口有利润");
  valid(state, "进口后");
});

test("进口没有小麦就不做", () => {
  const { state, shop } = tradeFixture(9108);
  assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 2.6).ok, true);
  shop.cashWheatUnits = 0;
  settleTradingHouses(state, CONTENT);
  assert.equal(lastRow(shop).importJin.flour, undefined);
});

test("进口量封顶：市场存量不超过 30 天销量", () => {
  const { state, shop } = tradeFixture(9109);
  // 盐的批发售价抬到 12，不让盐出口抢走运力池（出口排序优先，会先用光运力）。
  assert.equal(simulation.configureWholesalePrice(state, "salt", 12).ok, true);
  assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 2.6).ok, true);
  shop.cashWheatUnits = 1000 * I;
  setMarketSales(state, "flour", 10); // 日销 10 斤 → 封顶 300 斤，减去现存 0
  settleTradingHouses(state, CONTENT);
  const bought = lastRow(shop).importJin.flour || 0;
  assert.ok(bought > 0 && bought <= 300 + 0.01, `进口 ${bought} 斤，应不超过 30 天销量`);
});

test("运力池为 0 时不做买卖", () => {
  const { state, shop } = tradeFixture(9110, { pool: 0 });
  settleTradingHouses(state, CONTENT);
  assert.equal(lastRow(shop).trades, 0);
  assert.equal(lastRow(shop).usedJin, 0);
  assert.equal(state.wholesaleMarket.inventory.salt, 5000 * I);
  valid(state, "运力为零");
});

test(`成交量受店员数限制：每人每天 ${RULES.tradeHouseJinPerClerk} 斤，只有商人时最多 ${RULES.tradeHouseJinPerClerk} 斤`, () => {
  // 加一座物流中心（10 名搬运工 × logisticsJinPerWorker），让日运力足够大，人手而不是运力份额成为限制。
  const { state, shop } = tradeFixture(9111, { clerks: 0, pool: 1000 });
  addBuilding(state, "lc1", "logistics_center");
  simulation.setEmployment(state, "lc1::porters", 10);
  settleTradingHouses(state, CONTENT);
  assert.equal(lastRow(shop).budgetJin, RULES.tradeHouseJinPerClerk, `一名商人（店主）= ${RULES.tradeHouseJinPerClerk} 斤`);
  assert.ok(lastRow(shop).usedJin <= RULES.tradeHouseJinPerClerk + 0.01);
  assert.equal(lastRow(shop).exportJin.salt, RULES.tradeHouseJinPerClerk);
});

test(`两家贸易行按店员数分运力份额，合计不超过当日运力的 ${RULES.tradeHouseCapacityShare * 100}%`, () => {
  const { state, shopIds } = tradeFixture(9112, { clerks: [10, 0], houses: 2 });
  settleTradingHouses(state, CONTENT);
  const [big, small] = shopIds.map(id => state.shops[id].tradeLog.at(-1));
  assert.ok(Math.abs(big.shareJin - SHARE_JIN * 11 / 12) < 0.02, `大店份额 ${big.shareJin}`);
  assert.ok(Math.abs(small.shareJin - SHARE_JIN / 12) < 0.02, `小店份额 ${small.shareJin}`);
  const used = big.usedJin + small.usedJin;
  assert.ok(used <= SHARE_JIN + 0.02, `合计不超过份额，实际 ${used}`);
});

test("日结流水线：tradeHouses 排在居民服务之后、外镇日结之前", () => {
  const ids = DAILY_STEPS.map(step => step.id);
  const at = id => ids.indexOf(id);
  assert.ok(at("tradeHouses") > at("services"));
  assert.ok(at("tradeHouses") < at("outsideTownDay"));
  assert.ok(at("tradeHouses") < at("shops"), "贸易行的买卖计入当日店铺结账");
});

test("日结：贸易行的租金、利润税与结算照常；每天有日志", () => {
  const { state, shop } = tradeFixture(9113);
  simulation.advanceDays(state, 35);
  assert.ok((shop.accounts.cumulative.rentExpenseVoucherUnits || 0) > 0, "交了店租");
  assert.ok((shop.accounts.cumulative.revenueVoucherUnits || 0) > 0, "有营业收入");
  assert.ok((shop.accounts.cumulative.freightVoucherUnits || 0) > 0, "付了运费");
  assert.ok((shop.accounts.cumulative.taxExpenseVoucherUnits || 0) > 0, "有利润税");
  assert.ok(shop.settlement.lastSettlementDay > 0, "按期结算");
  assert.equal(shop.tradeLog.length, 30, "日志最多 30 天");
  assert.ok(["营业中", "暂无可做的买卖"].includes(shop.statusReason), `状态 ${shop.statusReason}`);
  valid(state, "35 日之后");
});

test("只读视图：贸易行今日与近 7 日的买卖、运费、利润、份额；仪表盘带 tradeHouses", () => {
  const { state, shop } = tradeFixture(9114);
  settleTradingHouses(state, CONTENT);
  const view = selectTradeHouseView(state, CONTENT);
  assert.equal(view.houses.length, 1);
  const house = view.houses[0];
  assert.equal(house.id, shop.id);
  assert.equal(house.today.exportJin[0].itemId, "salt");
  assert.equal(house.today.exportTotalJin, lastRow(shop).exportJin.salt);
  assert.ok(house.today.marginPercent > 10, `实际利润率 ${house.today.marginPercent}`);
  assert.equal(house.today.capacityUsedPercent, 100);
  assert.equal(house.week.days, 1);
  const salt = view.markets.find(row => row.itemId === "salt");
  assert.ok(salt && salt.stockJin > 0);
  const dashboard = simulation.selectDashboard(state, { panel: "business" });
  assert.equal(dashboard.tradeHouses.houses.length, 1);
  assert.equal(dashboard.tradeHouses.houseCount, 1);
});

test("存档往返：贸易行日志、账与库存读回后不变，状态合法", () => {
  const { state } = tradeFixture(9115);
  settleTradingHouses(state, CONTENT);
  const saved = JSON.parse(JSON.stringify(state));
  const loaded = migrateSave(saved, CONTENT);
  const id = Object.keys(state.shops)[0];
  assert.deepEqual(loaded.shops[id].tradeLog, state.shops[id].tradeLog);
  assert.equal(loaded.shops[id].cashWheatUnits, state.shops[id].cashWheatUnits);
  valid(loaded, "读档后");
});
