import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers, voucherBalance, validateCurrencyInvariant } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { settleTradingHouses, tradeTariffRate } from "../src/systems/trading-houses.js";
import { prepareShopsForDay, shopClerkCount } from "../src/systems/shops.js";
import { householdIdleWorkers, householdList } from "../src/systems/households.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const RULES = CONTENT.rules;
const POOL_JIN = 300;
const SHARE_JIN = POOL_JIN * RULES.tradeHouseCapacityShare;

function valid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
  const currency = validateCurrencyInvariant(state, CONTENT);
  assert.equal(currency.valid, true, `${label} 货币：${(currency.errors || []).join("；")}`);
}

function addBuilding(state, id, typeId) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => !row.feature && !used.has(row.id));
  assert.ok(plot, "需要空地");
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return id;
}

// 同 trading-houses.test.js 的 fixture：外贸房（基础运力 300 斤/日）、批发市场、贸易中心；盐批发售价 10。
function tradeFixture(seed, { clerks = 10, pool = POOL_JIN } = {}) {
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
  // 660 户时自动选店主只会挑到粮券最厚的一户，这里指定一户有空闲劳力的店主并给足粮券（启动资金 + 生活储备）。
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, "tc1", "trading_house", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, clerks).ok, true);
  transferVouchers(state, "town", `shop:${opened.shopId}`, 20000 * V, CONTENT, "test", "测试：贸易行周转金");
  return { state, shop: state.shops[opened.shopId] };
}

function lastRow(shop) {
  return shop.tradeLog.at(-1);
}

// 出口的盐价：压低到 9，才能在 10% 出口关税后仍过 10% 利润门槛（外镇收购约 12.25）。
function cheapSalt(state) {
  assert.equal(simulation.configureWholesalePrice(state, "salt", 9).ok, true);
}

test("关税为 0（默认）时与原行为一致：无关税记账，利润 = 卖价 − 成本 − 运费", () => {
  const { state, shop } = tradeFixture(9201);
  assert.equal(tradeTariffRate(state, "export"), 0);
  assert.equal(tradeTariffRate(state, "import"), 0);
  settleTradingHouses(state, CONTENT);
  const row = lastRow(shop);
  assert.equal(row.tariffVoucherUnits, 0);
  assert.equal(state.tradeTariffs?.cumulativeVoucherUnits || 0, 0);
  assert.equal(row.profitVoucherUnits, row.revenueVoucherUnits - row.cogsVoucherUnits - row.freightVoucherUnits);
  valid(state, "零关税");
});

test("出口关税 10%：镇库多收的券 = 外镇货款 × 10%（容许 1 单位取整），店利润相应减少，状态合法", () => {
  // 对照组：无关税。
  const plain = tradeFixture(9202);
  cheapSalt(plain.state);
  const townBeforePlain = voucherBalance(plain.state, "town");
  settleTradingHouses(plain.state, CONTENT);
  const plainRow = lastRow(plain.shop);
  assert.ok(plainRow.trades > 0, "对照组应当出口");

  // 实验组：出口关税 10%。
  const taxed = tradeFixture(9202);
  cheapSalt(taxed.state);
  assert.equal(simulation.setTradeTariff(taxed.state, { exportPercent: 10 }).ok, true);
  const townBeforeTaxed = voucherBalance(taxed.state, "town");
  settleTradingHouses(taxed.state, CONTENT);
  const row = lastRow(taxed.shop);
  assert.equal(row.exportJin.salt, plainRow.exportJin.salt, "关税不改变成交量（利润够）");
  assert.ok(row.tariffVoucherUnits > 0, "应当收到关税");
  assert.ok(Math.abs(row.tariffVoucherUnits - row.revenueVoucherUnits * 0.1) <= 1 + 1e-6,
    `关税 ${row.tariffVoucherUnits} 应约为外镇货款 ${row.revenueVoucherUnits} 的 10%`);
  assert.equal(taxed.state.tradeTariffs.cumulativeVoucherUnits, row.tariffVoucherUnits, "累计关税");
  assert.equal(taxed.state.tradeTariffs.byYear[taxed.state.year], row.tariffVoucherUnits, "本年关税");
  assert.equal(taxed.shop.accounts.day.tariffVoucherUnits, row.tariffVoucherUnits, "店账本记关税");
  // 店利润减少 = 关税（其他项不变）。
  assert.ok(Math.abs((plainRow.profitVoucherUnits - row.profitVoucherUnits) - row.tariffVoucherUnits) <= 1 + 1e-6,
    "店利润减少约等于关税");
  // 镇库多收的钱：关税进镇库（与对照组相比多出的部分）。
  const extraTown = (voucherBalance(taxed.state, "town") - townBeforeTaxed) - (voucherBalance(plain.state, "town") - townBeforePlain);
  assert.ok(Math.abs(extraTown - row.tariffVoucherUnits) <= 1 + 1e-6, `镇库多收 ${extraTown}，关税 ${row.tariffVoucherUnits}`);
  valid(taxed.state, "出口关税后");
});

test("进口关税 10%：关税 = 付给外镇的货款 × 10%（容许 1 单位），交镇库，状态合法", () => {
  // 对照组与实验组：面粉批发收购 3.0，盐不出口（售价 12）。镇库多收的券 = 关税（进口的镇库要付市场货款，相减后剩下关税）。
  const run = rate => {
    const { state, shop } = tradeFixture(9203);
    assert.equal(simulation.configureWholesalePrice(state, "salt", 12).ok, true);
    assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 3.0).ok, true);
    if (rate) assert.equal(simulation.setTradeTariff(state, { importPercent: rate }).ok, true);
    shop.cashWheatUnits = 1000 * I;
    const wheatBefore = shop.cashWheatUnits;
    const townBefore = voucherBalance(state, "town");
    settleTradingHouses(state, CONTENT);
    return { state, shop, row: lastRow(shop), wheatPaid: wheatBefore - shop.cashWheatUnits, townGain: voucherBalance(state, "town") - townBefore };
  };
  const plain = run(0);
  const taxed = run(10);
  const row = taxed.row;
  assert.ok(row.importJin.flour > 0, "应当进口面粉");
  assert.equal(row.importJin.flour, plain.row.importJin.flour, "关税不改变成交量（利润够）");
  assert.ok(row.tariffVoucherUnits > 0, "应当收到进口关税");
  assert.ok(Math.abs(row.tariffVoucherUnits - taxed.wheatPaid * 0.1) <= 1 + 1e-6,
    `进口关税 ${row.tariffVoucherUnits}，付给外镇小麦 ${taxed.wheatPaid} 的 10%`);
  assert.equal(taxed.state.tradeTariffs.cumulativeVoucherUnits, row.tariffVoucherUnits);
  const extraTown = taxed.townGain - plain.townGain;
  assert.ok(Math.abs(extraTown - row.tariffVoucherUnits) <= 1 + 1e-6, `镇库多收 ${extraTown}，关税 ${row.tariffVoucherUnits}`);
  valid(taxed.state, "进口关税后");
});

test("关税高到吃掉利润时不做该笔：出口关税 50% 时盐不出口，市场存货不动", () => {
  const { state, shop } = tradeFixture(9204);
  cheapSalt(state);
  assert.equal(simulation.setTradeTariff(state, { exportPercent: 50 }).ok, true);
  settleTradingHouses(state, CONTENT);
  assert.equal(lastRow(shop).trades, 0);
  assert.equal(lastRow(shop).tariffVoucherUnits, 0);
  assert.equal(state.wholesaleMarket.inventory.salt, 5000 * I, "市场存货不动");
  assert.equal(state.tradeTariffs?.cumulativeVoucherUnits || 0, 0, "没成交就没有关税");
  valid(state, "关税过高");
});

test("setTradeTariff 越界拒绝；合法值写入 policy.tradeTariff，上限 tradeTariffMaximumPercent", () => {
  const { state } = tradeFixture(9205);
  const max = RULES.tradeTariffMaximumPercent;
  assert.equal(max, 50);
  assert.equal(simulation.setTradeTariff(state, { exportPercent: max + 1 }).ok, false);
  assert.equal(simulation.setTradeTariff(state, { importPercent: -1 }).ok, false);
  assert.equal(simulation.setTradeTariff(state, { importPercent: "abc" }).ok, false);
  assert.equal(state.policy.tradeTariff?.exportPercent || 0, 0, "越界不改值");
  assert.equal(simulation.setTradeTariff(state, { exportPercent: max, importPercent: 5 }).ok, true);
  assert.equal(state.policy.tradeTariff.exportPercent, max);
  assert.equal(state.policy.tradeTariff.importPercent, 5);
  assert.equal(tradeTariffRate(state, "export"), max / 100);
  valid(state, "合法关税");
});

test("同等利润率时先出口：出口与进口都达标时，运力先给出口", () => {
  // 出口利润率 ≈ 30%（盐 9.37），进口利润率 ≈ 30%（面粉 2.68）：出口排序乘 1.5，先出口，运力用光后进口得 0。
  const { state, shop } = tradeFixture(9206);
  assert.equal(simulation.configureWholesalePrice(state, "salt", 9.37).ok, true);
  assert.equal(simulation.configureWholesalePurchasePrice(state, "flour", 2.68).ok, true);
  shop.cashWheatUnits = 1000 * I;
  settleTradingHouses(state, CONTENT);
  const row = lastRow(shop);
  assert.ok(row.exportJin.salt > 0, "应当先出口盐");
  assert.equal(row.importJin.flour, undefined, "运力已用于出口，不进口");
  valid(state, "同等利润率");
});

test("进口利润 15%（>10%、<25%）不做；同样 15% 的出口则照做", () => {
  // 进口：面粉 2.0×(1+运费) 成本 ≈ 2.06，批发收购 2.37 → 利润 15%，低于进口门槛 25%。
  const imp = tradeFixture(9207);
  assert.equal(simulation.configureWholesalePrice(imp.state, "salt", 12).ok, true);
  assert.equal(simulation.configureWholesalePurchasePrice(imp.state, "flour", 2.37).ok, true);
  imp.shop.cashWheatUnits = 1000 * I;
  settleTradingHouses(imp.state, CONTENT);
  assert.equal(lastRow(imp.shop).importJin.flour, undefined, "15% 利润的进口不做");
  assert.equal(lastRow(imp.shop).trades, 0);

  // 出口：盐外镇收购约 12.25，批发售价 10.6 → 成本 10.66，利润约 15%，过出口门槛 10%，照做。
  const exp = tradeFixture(9207);
  assert.equal(simulation.configureWholesalePrice(exp.state, "salt", 10.6).ok, true);
  settleTradingHouses(exp.state, CONTENT);
  assert.ok(lastRow(exp.shop).exportJin.salt > 0, "同样 15% 利润的出口照做");
  valid(exp.state, "15% 利润");
});

// 贸易行 7 天日志（用于增减店员的诊断）：每天的额度、用量、利润都由调用方给定。
function fakeLog({ used, budget, share, profitVoucher, days = 7 }) {
  return Array.from({ length: days }, (_, i) => ({
    serial: i + 1, staff: 0, shareJin: share, budgetJin: budget, usedJin: used, trades: used > 0 ? 1 : 0,
    exportJin: used > 0 ? { salt: used } : {}, importJin: {}, revenueVoucherUnits: 0, cogsVoucherUnits: 0,
    freightVoucherUnits: 0, tariffVoucherUnits: 0, profitVoucherUnits: profitVoucher * V
  }));
}

// 物流中心让日运力变大（300 + 10 名搬运工 × 60 = 900 斤，份额 720 斤），人手才是额度的瓶颈。
function bigCapacityFixture(seed, clerks) {
  const fixture = tradeFixture(seed, { clerks, pool: 2000 });
  addBuilding(fixture.state, "lc1", "logistics_center");
  simulation.setEmployment(fixture.state, "lc1::porters", 10);
  return fixture;
}

test("自动增员：近 7 天额度用满、卡在人手上、多一人有利可图 → 加 2 人", () => {
  // 店主 + 1 店员 = 2 人 × 300 = 600 斤额度，份额 720 斤；全部用完，每斤利润 0.05 券（一人日增利润 15 券 > 日薪 10）。
  const { state, shop } = bigCapacityFixture(9208, 1);
  const current = shopClerkCount(state, shop);
  assert.equal(current, 1);
  shop.tradeLog = fakeLog({ used: 600, budget: 600, share: 720, profitVoucher: 30 });
  prepareShopsForDay(state, CONTENT);
  assert.equal(shopClerkCount(state, shop), current + 2, `应加 2 人，诊断：${shop.plan.staffingDiagnosis}`);
  assert.equal(shop.plan.staffingDiagnosis, "生意做不完，加人");
  valid(state, "增员后");
});

test("自动减员：近 7 天用不到 40% 额度 → 减一人（店员满 30 天才能解雇）", () => {
  const { state, shop } = bigCapacityFixture(9209, 2);
  const current = shopClerkCount(state, shop);
  assert.equal(current, 2);
  // 店员都雇满 30 天以上。
  shop.staffing.clerkHiredSerials = [-1000, -1000];
  shop.tradeLog = fakeLog({ used: 100, budget: 900, share: 720, profitVoucher: 5 });
  prepareShopsForDay(state, CONTENT);
  assert.equal(shopClerkCount(state, shop), current - 1, `应减 1 人，诊断：${shop.plan.staffingDiagnosis}`);
  valid(state, "减员后");
});

test("自动减员：亏损的贸易行减一人", () => {
  const { state, shop } = bigCapacityFixture(9210, 2);
  const current = shopClerkCount(state, shop);
  shop.staffing.clerkHiredSerials = [-1000, -1000];
  shop.tradeLog = fakeLog({ used: 600, budget: 900, share: 720, profitVoucher: -20 });
  prepareShopsForDay(state, CONTENT);
  assert.equal(shopClerkCount(state, shop), current - 1);
  assert.equal(shop.plan.staffingDiagnosis, "亏损，减人");
});

test("没生意但有现金：连续 40 天不关门（不累计坏日子）", () => {
  const { state, shop } = tradeFixture(9211);
  // 不出口、不进口：盐售价 12（利润不够 10%），不配进口收购价。
  assert.equal(simulation.configureWholesalePrice(state, "salt", 12).ok, true);
  simulation.advanceDays(state, 40);
  assert.equal(shop.status, "open", `店铺状态 ${shop.status}：${shop.statusReason}`);
  assert.equal(shop.badDays || 0, 0, "没有累计坏日子");
  assert.ok(maxTraded(shop) === 0, "这 40 天里没有成交，确认测试前提");
  assert.ok(simulation.validateState(state).valid);
});

function maxTraded(shop) {
  return Math.max(0, ...(shop.tradeLog || []).map(row => row.trades || 0));
}
