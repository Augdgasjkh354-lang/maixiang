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
import { prepareShopsForDay, shopClerkCount, shopMerchantCount } from "../src/systems/shops.js";
import { pendingWages } from "../src/systems/employer.js";
import { currentPaymentComposition, maximumPayableValueUnits, settleMonetaryPayment } from "../src/economy/payment.js";

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
// 镇库印制粮券，镇里有钱付批发货款。盐的批发售价压到 10（外镇收购价约 14.7，够 10% 利润）。
// 产业链（chain: true）：南部盐矿资源点上的盐场（10 名盐工，每人每日产 5 斤盐），盐统购入批发市场，贸易行有持续货源。
function addSaltChain(state) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => row.feature === "salt_mine" && !used.has(row.id));
  assert.ok(plot, "需要盐矿资源点");
  state.buildings.push({
    id: "sw1", typeId: "saltworks", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  simulation.setEmployment(state, "sw1::salt_workers", 10);
}

function tradeFixture(seed, { clerks = 10, pool = 300, houses = 1, chain = false } = {}) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "ftrade", "foreign_trade_house");
  addBuilding(state, "wm1", "wholesale_market");
  addBuilding(state, "tc1", "trade_center");
  simulation.setEmployment(state, "ftrade::trade_staff", 8);
  simulation.setEmployment(state, "wm1::wholesale_workers", 3);
  if (chain) addSaltChain(state);
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
  // 本例只测民镇一镇：两镇都能做时预算按配额分给两镇（见"两镇分配"用例）。
  ensureOutsideTowns(state, CONTENT).wangzhen.tradeClosed = true;
  const town = ensureOutsideTowns(state, CONTENT).minzhen;
  const beforeStock = town.stocks.salt;
  const beforeWheat = town.wheatStockJin;
  const beforeTownWheat = state.accounts.town.wheat;
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
  assert.ok(state.accounts.town.wheat > beforeTownWheat, "外镇付的小麦进镇库");
  // 镇库付货款给贸易行（出口收来的小麦），运费收进镇库：净额 = 运费 - 货款（券池不足时补发只会让镇库更多）。
  assert.ok(voucherBalance(state, "town") - beforeTownVouchers + row.revenueVoucherUnits >= row.freightVoucherUnits - 1, "运费进了镇库（扣掉付给贸易行的货款后）");
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

test("利润率不到 10% 不做：外镇收购价 14.73，批发售价 14.2 时利润约 3%，不出口", () => {
  const { state, shop } = tradeFixture(9106);
  assert.equal(simulation.configureWholesalePrice(state, "salt", 14.2).ok, true);
  settleTradingHouses(state, CONTENT);
  assert.equal(lastRow(shop).trades, 0);
  assert.equal(lastRow(shop).usedJin, 0);
  assert.equal(state.wholesaleMarket.inventory.salt, 5000 * I, "市场存货不动");
});

test("进口：店里有小麦、批发收购价够高时，向外镇买面粉，按收购价卖回批发市场", () => {
  const { state, shop } = tradeFixture(9107);
  // 只测进口：盐不做出口（否则同一天外镇付的小麦会混进来）。面粉：外镇售价约 2.0 斤/斤，批发收购价 2.6 → 利润够 10%。
  // 盐的外镇收购价约 14.7，批发售价 15 时利润为负，不出口（只测进口）。
  assert.equal(simulation.configureWholesalePrice(state, "salt", 15).ok, true);
  assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 2.6).ok, true);
  const town = ensureOutsideTowns(state, CONTENT).minzhen;
  const beforeFlour = town.stocks.flour;
  const beforeWheat = town.wheatStockJin;
  const beforeMarket = state.wholesaleMarket.inventory.flour || 0;
  const beforeTownWheat = state.accounts.town.wheat;
  const beforeShopVouchers = shop.cashVoucherUnits;

  settleTradingHouses(state, CONTENT);
  const row = lastRow(shop);
  const bought = row.importJin.flour;
  assert.ok(bought > 0, "应当进口面粉");
  assert.ok(bought <= 20 + 0.01, "没有销量历史时进口封顶 20 斤");
  assert.ok(Math.abs(town.stocks.flour - (beforeFlour - bought)) < 0.02, "外镇面粉减少");
  assert.ok(town.wheatStockJin > beforeWheat, "外镇收到小麦");
  assert.ok(state.accounts.town.wheat < beforeTownWheat, "镇库小麦付给外镇");
  assert.equal(state.wholesaleMarket.inventory.flour, beforeMarket + Math.round(bought * I), "面粉入批发市场");
  assert.ok(shop.cashVoucherUnits > beforeShopVouchers, "批发市场付粮券给店里");
  assert.ok(row.profitVoucherUnits > 0, "进口有利润");
  valid(state, "进口后");
});

test("进口：镇库小麦不高于口粮储备线就不做", () => {
  const { state, shop } = tradeFixture(9108);
  assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 2.6).ok, true);
  state.accounts.town.wheat = 0;
  settleTradingHouses(state, CONTENT);
  assert.equal(lastRow(shop).importJin.flour, undefined);
});

test("进口量封顶：市场存量不超过 30 天销量", () => {
  const { state, shop } = tradeFixture(9109);
  // 盐的批发售价抬到 15（外镇收购价约 14.7，利润为负），不让盐出口抢走运力池（出口排序优先，会先用光运力）。
  assert.equal(simulation.configureWholesalePrice(state, "salt", 15).ok, true);
  assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 2.6).ok, true);
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
  assert.equal(loaded.shops[id].cashVoucherUnits, state.shops[id].cashVoucherUnits);
  valid(loaded, "读档后");
});

test("贸易行清算：日结推进，未满 30 天仍清算中，满 30 天仍欠账则核销关门，店内货物返还业主", () => {
  const { state, shop } = tradeFixture(9310, { clerks: 3 });
  const owner = state.households.byId[shop.ownerHouseholdId];
  prepareShopsForDay(state, CONTENT);
  // 现金抽干、货留店里：停业时工资和租金付不出，清算必然留有负债。
  if (shop.cashVoucherUnits > 0) {
    assert.equal(transferVouchers(state, `shop:${shop.id}`, `household:${owner.id}`, shop.cashVoucherUnits, CONTENT,
      "test_drain", "测试抽干贸易行现金").ok, true);
  }
  shop.inventory.salt = 20 * I;
  assert.equal(simulation.closeResidentShop(state, shop.id).ok, true);
  assert.equal(shop.status, "liquidating");
  const debt = () => (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0) + (shop.liabilities.taxVoucherUnits || 0)
    + pendingWages(shop.liabilities);
  assert.ok(debt() > 0, "清算时应有付不出的负债");
  for (let day = 0; day < 30; day += 1) simulation.advanceDay(state);
  assert.equal(shop.status, "liquidating", "未满 30 天应仍在清算中");
  simulation.advanceDay(state);
  assert.equal(shop.status, "closed", "满 30 天仍欠账应核销关门");
  assert.equal(debt(), 0);
  assert.equal(shop.inventory.salt || 0, 0, "店内货物已返还业主");
  valid(state, "贸易行核销关门后");
});

test("无买卖：未满 30 天不减员；满 30 天且亏损 → 暂停（岗位释放、业主保留、不清算），暂停期间不计工资与店租", () => {
  const { state, shop } = tradeFixture(9401, { clerks: 3 });
  const ownerId = shop.ownerHouseholdId;
  assert.equal(simulation.configureWholesalePrice(state, "salt", 15).ok, true, "盐利润为负，不做买卖");
  simulation.advanceDays(state, 29);
  assert.equal(shop.status, "open");
  assert.equal(shopClerkCount(state, shop), 3, "没有买卖的头 30 天不逐月减员");
  simulation.advanceDays(state, 1);
  assert.equal(shop.status, "paused", shop.statusReason);
  assert.equal(shopClerkCount(state, shop), 0, "暂停遣散店员");
  assert.equal(shopMerchantCount(state, shop), 0, "非营业店铺不保留商人岗位");
  assert.equal(shop.ownerHouseholdId, ownerId, "业主保留");
  assert.equal(shop.tradePause.clerksBefore, 3);
  assert.equal(shop.tradePause.merchantsBefore, 1);
  valid(state, "暂停当日");

  // 暂停 40 天：不累计工资与店租、不进入清算、不累计坏日子。
  const wageBefore = shop.accounts.cumulative.wageExpenseVoucherUnits || 0;
  const rentBefore = shop.accounts.cumulative.rentExpenseVoucherUnits || 0;
  const debtBefore = (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0) + pendingWages(shop.liabilities);
  simulation.advanceDays(state, 40);
  assert.equal(shop.status, "paused", "暂停期间不清算");
  assert.equal(shop.badDays || 0, 0);
  assert.equal(shop.accounts.cumulative.wageExpenseVoucherUnits || 0, wageBefore, "暂停期间不发新工资");
  assert.equal(shop.accounts.cumulative.rentExpenseVoucherUnits || 0, rentBefore, "暂停期间不计店租");
  const debtAfter = (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0) + pendingWages(shop.liabilities);
  assert.ok(debtAfter <= debtBefore, `暂停期间不产生新的欠薪（${debtBefore} → ${debtAfter}）`);
  valid(state, "暂停 40 天后");
});

test("暂停中的贸易行：每 10 天检查一次，有可做的买卖才恢复营业，并补足暂停前的店员", () => {
  const { state, shop } = tradeFixture(9402, { clerks: 3 });
  assert.equal(simulation.configureWholesalePrice(state, "salt", 15).ok, true);
  simulation.advanceDays(state, 30);
  assert.equal(shop.status, "paused");
  // 暂停后 20 天仍无可做的买卖（盐利润为负）：检查了两次都不恢复。
  simulation.advanceDays(state, 20);
  assert.equal(shop.status, "paused", "无可做的买卖，不恢复");
  // 盐售价降到 10：利润够门槛，下一个检查日（暂停后第 30 天）恢复营业。
  assert.equal(simulation.configureWholesalePrice(state, "salt", 10).ok, true);
  let days = 0;
  while (shop.status === "paused" && days < 25) {
    simulation.advanceDay(state);
    days += 1;
  }
  assert.equal(shop.status, "open", `应当恢复营业：${shop.statusReason}`);
  assert.equal(days % 10, 0, `恢复只在检查日进行，实际第 ${days} 天`);
  assert.equal(shop.tradePause, undefined, "暂停标记已清除");
  assert.equal(shopClerkCount(state, shop), 3, "补足暂停前的店员");
  assert.equal(shopMerchantCount(state, shop), 1, "业主回到商人岗位");
  valid(state, "恢复营业");
  simulation.advanceDay(state);
  assert.ok(lastRow(shop).trades > 0, "恢复后当天就有买卖");
  valid(state, "恢复后");
});

// 零资金的暂停店铺：店里的现金与小麦全部抽走（暂停期间没有新收入）。
function drainTradeHouseCash(state, shop, content) {
  if (shop.cashVoucherUnits > 0) {
    assert.equal(transferVouchers(state, `shop:${shop.id}`, "town", shop.cashVoucherUnits, content, "test_drain", "测试抽干店里现金").ok, true);
  }
  assert.equal(maximumPayableValueUnits(state, `shop:${shop.id}`, content), 0, "店里一分钱都没有");
}

test("零资金暂停的贸易行：业主有钱 → 下一个检查日补资并恢复营业，恢复不要求店里原来有钱", () => {
  const { state, shop } = tradeFixture(9404, { clerks: 3 });
  const owner = state.households.byId[shop.ownerHouseholdId];
  assert.equal(simulation.configureWholesalePrice(state, "salt", 15).ok, true);
  simulation.advanceDays(state, 30);
  assert.equal(shop.status, "paused", "无买卖且亏损，先暂停");
  drainTradeHouseCash(state, shop, CONTENT);
  assert.equal(grantResidentVouchers(state, 50000, CONTENT, owner.id).ok, true, "业主有钱");
  assert.equal(simulation.configureWholesalePrice(state, "salt", 10).ok, true, "出现可做的买卖");
  let days = 0;
  while (shop.status === "paused" && days < 25) {
    simulation.advanceDay(state);
    days += 1;
  }
  assert.equal(shop.status, "open", `应当恢复营业：${shop.statusReason}`);
  assert.equal(days % 10, 0, `只在检查日恢复，实际第 ${days} 天`);
  assert.ok(maximumPayableValueUnits(state, `shop:${shop.id}`, CONTENT) > 0, "业主补足了营运资金");
  assert.ok(state.events.some(event => event.text.includes("业主补资")), "事件写明业主补资");
  valid(state, "零资金恢复后");
});

test("零资金暂停的贸易行：业主也没钱 → 保持暂停、不清算、不欠薪增长", () => {
  const { state, shop } = tradeFixture(9405, { clerks: 3 });
  const owner = state.households.byId[shop.ownerHouseholdId];
  assert.equal(simulation.configureWholesalePrice(state, "salt", 15).ok, true);
  simulation.advanceDays(state, 30);
  assert.equal(shop.status, "paused");
  drainTradeHouseCash(state, shop, CONTENT);
  // 业主身无分文：粮券全部交给镇库，口粮小麦清空（测试夹具）。
  const ownerKey = `household:${owner.id}`;
  // 把业主能付的全部付给镇库（含存款取回与以粮换券，账走正规支付流程）。
  owner.inventory.wheat = 0;
  const ownerPayable = maximumPayableValueUnits(state, ownerKey, CONTENT);
  if (ownerPayable > 0) {
    settleMonetaryPayment(state, ownerKey, "town", currentPaymentComposition(state, ownerPayable), CONTENT, "test_drain", "测试业主身无分文", { requireFull: false });
  }
  assert.equal(maximumPayableValueUnits(state, ownerKey, CONTENT), 0, "业主付不起任何补资");
  assert.equal(simulation.configureWholesalePrice(state, "salt", 10).ok, true, "有可做的买卖，但没钱补资");
  const wageBefore = shop.accounts.cumulative.wageExpenseVoucherUnits || 0;
  simulation.advanceDays(state, 40);
  assert.equal(shop.status, "paused", "业主付不起，保持暂停");
  assert.notEqual(shop.status, "liquidating", "不进入清算");
  assert.equal(shop.badDays || 0, 0);
  assert.equal(shop.accounts.cumulative.wageExpenseVoucherUnits || 0, wageBefore, "暂停期间不发工资");
  assert.equal(shop.ownerHouseholdId, owner.id, "业主保留");
  valid(state, "业主没钱保持暂停");
});

test("两镇分配：两镇都能做时，当日预算按配额分给两镇，两镇都有成交，合计仍用满预算", () => {
  const { state, shop } = tradeFixture(9120);
  const towns = ensureOutsideTowns(state, CONTENT);
  settleTradingHouses(state, CONTENT);
  assert.ok(towns.minzhen.stats.trades > 0, "民镇有成交");
  assert.ok(towns.wangzhen.stats.trades > 0, "王镇有成交（不被利润率高的一镇独占）");
  const sold = lastRow(shop).exportJin.salt;
  assert.ok(Math.abs(sold - SHARE_JIN) < 0.02, `两镇合计仍用满运力份额 ${sold}`);
  valid(state, "两镇分配后");
});

test("逐镇逐商品统计：贸易行出口的盐按镇记入 byItem，两镇合计等于本店出口斤数", () => {
  const { state, shop } = tradeFixture(9125);
  const towns = ensureOutsideTowns(state, CONTENT);
  settleTradingHouses(state, CONTENT);
  const row = lastRow(shop);
  assert.ok(row.exportJin.salt > 0, "出口了盐");
  const saltJin = ["minzhen", "wangzhen"].reduce((sum, id) => sum + (towns[id].stats.byItem?.salt?.exportJin || 0), 0);
  assert.ok(Math.abs(saltJin - row.exportJin.salt) < 0.02, `两镇盐出口斤数 ${saltJin} = 店内出口 ${row.exportJin.salt}`);
  const minzhenRow = towns.minzhen.stats.byItem?.salt;
  assert.ok(minzhenRow && minzhenRow.exportJin > 0, "民镇有盐出口记录");
  assert.equal(minzhenRow.yearExportJin, minzhenRow.exportJin, "首年内年度与累计相同");
  assert.equal(minzhenRow.importJin, 0, "没有进口");
  valid(state, "逐商品统计后");
});

test("当日可做上限 capJin：人手预算卡住时大于成交量；货源用完时等于成交量", () => {
  // 0 名店员（只有店主商人 300 斤）、运力池 1000：人手预算卡住，收市后仍有可做的出口。
  const staffBound = tradeFixture(9121, { clerks: 0, pool: 1000 });
  settleTradingHouses(staffBound.state, CONTENT);
  const bound = lastRow(staffBound.shop);
  assert.ok(Math.abs(bound.usedJin - bound.budgetJin) < 0.02, `人手预算用满：成交 ${bound.usedJin} = 预算 ${bound.budgetJin}`);
  assert.ok(bound.capJin > bound.usedJin + 100, `可做上限应明显大于成交量：${bound.capJin} > ${bound.usedJin}`);

  // 批发存货只超出保本线 50 斤：货源用完，上限就是成交量。
  const goodsBound = tradeFixture(9122);
  goodsBound.state.wholesaleMarket.inventory.salt = 250 * I;
  settleTradingHouses(goodsBound.state, CONTENT);
  const goods = lastRow(goodsBound.shop);
  assert.ok(goods.usedJin > 0, "应出超出保本线的 50 斤");
  assert.ok(Math.abs(goods.capJin - goods.usedJin) < 1, `货源用完：上限 ${goods.capJin} ≈ 成交 ${goods.usedJin}`);
  valid(goodsBound.state, "上限记录后");
});

test("货源受限但人手充足（批发存货用完）：店员数保持，不因利用率低而减员", () => {
  // 10 名店员，批发存货只超出保本线 50 斤：每天只成交 50 斤，人手预算远没用完，但货源已用完，店员不减。
  const { state, shop } = tradeFixture(9123, { clerks: 10 });
  state.wholesaleMarket.inventory.salt = 250 * I;
  for (let day = 0; day < 40; day++) {
    // 每天补回 50 斤超出保本线的货（模拟批发入库），确保每天都是"货源刚好够卖"。
    state.wholesaleMarket.inventory.salt = 250 * I;
    simulation.advanceDays(state, 1);
  }
  assert.equal(shopClerkCount(state, shop), 10, `货源受限，店员保持，诊断：${shop.plan.staffingDiagnosis}`);
  assert.ok(lastRow(shop).usedJin < RULES.tradeHouseJinPerClerk * 10 * 0.5, "成交远低于人手预算");
  valid(state, "货源受限店员保持");
});

test("[slow] 3 年产业链夹具（盐场供盐）：店员数不跌到 0（不低于 min(2, 初始配置)），每 30 天账平", () => {
  const { state, shop } = tradeFixture(9124, { clerks: 10, chain: true });
  let minClerks = Infinity;
  for (let day = 1; day <= 3 * (RULES.daysPerYear || 360); day++) {
    simulation.advanceDays(state, 1);
    minClerks = Math.min(minClerks, shopClerkCount(state, shop));
    if (day % 30 === 0) valid(state, `第 ${day} 天`);
  }
  assert.equal(shop.plan.initialClerks, 10, "初始配置记为开店时的 10 人");
  assert.ok(minClerks >= 2, `店员数不跌破下限 min(2, 10) = 2，最低 ${minClerks}`);
  assert.ok(shop.tradeLog.some(row => row.usedJin > 0), "仍在做买卖");
});
