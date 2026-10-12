// 贸易行公平分摊与招人（docs/TRADE.md「贸易中心与贸易行」）：
//   - 同一候选（外镇×商品×方向）的池子在各行之间按剩余店员预算比例拆分，不是第一行先吃光；
//   - 一行没吃满（资金、利润限制）的额度回流给其他行；
//   - 只有一间贸易行时与改前一致（一轮、单次成交）；
//   - 招人每 tradeHouseHireIntervalDays 天评估一次，目标 = ⌈min(近 7 日可做上限, 运力份额) ÷ 300⌉，一次不超过 max(2, ⌈现有 × 50%⌉)；
//   - 闸门备货 180 天（wild_game 不再单独覆盖，bread 仍为 30）。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers, voucherBalance } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { householdIdleWorkers, householdList } from "../src/systems/households.js";
import { settleTradingHouses } from "../src/systems/trading-houses.js";
import { prepareShopsForDay, shopClerkCount, shopMerchantCount } from "../src/systems/shops.js";
import { townOutputTargetUnits } from "../src/systems/wholesale-market.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const RULES = CONTENT.rules;

function valid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
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

// 外贸房（基础运力 300 斤/日，贸易行分 80%）、批发市场、贸易中心（2 级，4 个铺位）；盐批发售价 10，可出口。
// clerks：每家贸易行的店员数（开店时定好）；surplusJin：批发市场盐超出保本线（200 斤）的余量。
function tradeFixture(seed, { clerks = [5, 5], surplusJin = 5000, pool = 300 } = {}) {
  const state = simulation.createInitialState({ seed });
  addBuilding(state, "ftrade", "foreign_trade_house");
  addBuilding(state, "wm1", "wholesale_market");
  addBuilding(state, "tc1", "trade_center", 2);
  simulation.setEmployment(state, "ftrade::trade_staff", 8);
  simulation.setEmployment(state, "wm1::wholesale_workers", 3);
  grantResidentVouchers(state, 300000);
  issueTownVouchers(state, 50000 * V, CONTENT, "测试：镇库付货款");
  assert.equal(simulation.configureWholesalePrice(state, "salt", 10).ok, true);
  state.wholesaleMarket.inventory.salt = (200 + surplusJin) * I;
  state.logistics.poolJin = pool;
  const shopIds = [];
  for (let i = 0; i < clerks.length; i++) {
    // 每次现找有空闲劳力的店主：前一家店雇的店员会占用空闲劳力。
    const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
    assert.ok(owner, "需要一户有空闲劳力的店主");
    assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
    const opened = simulation.openResidentShop(state, "tc1", "trading_house", owner.id);
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(simulation.configureShopClerks(state, opened.shopId, clerks[i]).ok, true);
    transferVouchers(state, "town", `shop:${opened.shopId}`, 20000 * V, CONTENT, "test", "测试：贸易行周转金");
    shopIds.push(opened.shopId);
  }
  return { state, shopIds };
}

const lastRow = shop => shop.tradeLog.at(-1);
const exportedJin = row => Object.values(row.exportJin || {}).reduce((sum, jin) => sum + jin, 0);

test("两间贸易行同时做同一种货：每间都有成交，成交量大致与店员预算（人数）成比例", () => {
  // 批发超保本线的盐只有 150 斤，比两间店的预算合计更紧：必须拆分，不能第一间吃光。
  const { state, shopIds } = tradeFixture(9501, { clerks: [6, 3], surplusJin: 150 });
  settleTradingHouses(state, CONTENT);
  const [big, small] = shopIds.map(id => lastRow(state.shops[id]));
  assert.ok(big.trades > 0 && small.trades > 0, `两间都要有成交：${big.trades} / ${small.trades}`);
  const bigJin = exportedJin(big);
  const smallJin = exportedJin(small);
  assert.ok(Math.abs(bigJin + smallJin - 150) < 0.5, `合计用满可出口余量 150 斤，实际 ${bigJin + smallJin}`);
  // 预算按 staff（店员 + 店主）× 300 与份额取小：7 人与 4 人，比例约 1.75。
  const ratio = bigJin / smallJin;
  assert.ok(ratio > 1.3 && ratio < 2.2, `成交比例 ${ratio.toFixed(2)} 应大致与人数比 7:4 相符`);
  valid(state, "两行分摊后");
});

test("一间资金为零的行：它的份额回流给另一间，合计仍用满可出口余量", () => {
  const { state, shopIds } = tradeFixture(9502, { clerks: [6, 3], surplusJin: 150 });
  const poor = state.shops[shopIds[1]];
  // 把小店的周转金全部抽回镇库：它付不起货款，plan 为空。
  const cash = voucherBalance(state, `shop:${poor.id}`);
  assert.ok(cash > 0, "小店起初有周转金");
  transferVouchers(state, `shop:${poor.id}`, "town", cash, CONTENT, "test", "测试：抽空小店资金");
  settleTradingHouses(state, CONTENT);
  const big = lastRow(state.shops[shopIds[0]]);
  const small = lastRow(poor);
  assert.equal(small.trades, 0, "没钱的小店不成交");
  assert.ok(Math.abs(exportedJin(big) - 150) < 0.5, `余额回流给大店，成交 ${exportedJin(big)} 斤`);
  valid(state, "资金不足回流");
});

test("只有一间贸易行时：一轮单次成交，成交量等于 min(预算, 可出口余量)（与改前一致）", () => {
  const { state, shopIds } = tradeFixture(9503, { clerks: [5], surplusJin: 5000 });
  const shop = state.shops[shopIds[0]];
  settleTradingHouses(state, CONTENT);
  const row = lastRow(shop);
  // 店员 5 + 店主 1 = 6 人 × 300 = 1800 斤；份额 = 300 × 80% = 240 斤（单店独占）；运力池 300 斤。
  assert.ok(Math.abs(exportedJin(row) - Math.min(6 * RULES.tradeHouseJinPerClerk, 300 * RULES.tradeHouseCapacityShare)) < 0.02,
    `单店成交 ${exportedJin(row)} 应等于份额 240 斤`);
  valid(state, "单店");
});

test("同一天多次结算的确定性：同样的两店夹具结果逐位相同（轮转起点只由状态决定）", () => {
  const run = () => {
    const { state, shopIds } = tradeFixture(9504, { clerks: [6, 3], surplusJin: 150 });
    settleTradingHouses(state, CONTENT);
    return shopIds.map(id => [exportedJin(lastRow(state.shops[id])), lastRow(state.shops[id]).profitVoucherUnits]);
  };
  assert.deepEqual(run(), run());
});

test("招人：机会大时每 3 天评估一次，分步加到目标人数，一次不超过 max(2, ⌈现有 × 50%⌉)，不超过 20 人", () => {
  // 店员 2 + 店主 1 = 3 人；可做上限 3000 斤，份额 2000 斤 → 目标 ⌈2000 ÷ 300⌉ = 7 人（店员 6）。
  const { state, shopIds } = tradeFixture(9505, { clerks: [2], surplusJin: 0 });
  const shop = state.shops[shopIds[0]];
  const every = RULES.tradeHouseHireIntervalDays;
  assert.equal(every, 3);
  const fakeRow = { serial: 1, staff: 3, shareJin: 2000, budgetJin: 900, usedJin: 900, capJin: 3000, trades: 3,
    exportJin: { salt: 900 }, importJin: {}, revenueVoucherUnits: 0, cogsVoucherUnits: 0, freightVoucherUnits: 0, tariffVoucherUnits: 0, profitVoucherUnits: 30 * V };
  const reviewOnce = () => {
    shop.tradeLog = Array.from({ length: 7 }, (_, i) => ({ ...fakeRow, serial: i + 1 }));
    prepareShopsForDay(state, CONTENT);
    return shopClerkCount(state, shop);
  };
  // 开张期（开店后 openingPeriodDays 天内）每天审核，这里把店开在很久以前，才能测 3 天一次的节奏。
  state.day += 60;
  shop.openedYear = 1;
  shop.openedDay = 1;
  // 开店后第一次审核立即进行（plan.lastAdjustedSerial 未设），先用观察期不足的空日志消耗掉它。
  prepareShopsForDay(state, CONTENT);
  while (state.day % every !== 0) state.day += 1;
  const counts = [];
  let prev = shopClerkCount(state, shop);
  assert.equal(prev, 2);
  for (let step = 0; step < 6; step += 1) {
    // 评估间隔之外的日子不动人。
    state.day += 1;
    shop.tradeLog = Array.from({ length: 7 }, (_, i) => ({ ...fakeRow, serial: i + 1 }));
    prepareShopsForDay(state, CONTENT);
    assert.equal(shopClerkCount(state, shop), prev, "非评估日不加人");
    state.day += every - 1;
    const now = reviewOnce();
    counts.push(now);
    const allowed = Math.max(2, Math.ceil(prev * 0.5));
    assert.ok(now - prev <= allowed, `一次最多加 ${allowed} 人，实际 ${now - prev}`);
    prev = now;
  }
  assert.deepEqual(counts.slice(0, 2), [4, 6], `2→4→6 逐次加到目标，实际 ${counts}`);
  assert.equal(counts.at(-1), 6, "目标 7 人 = 店员 6 + 店主兼商人 1，到了就停");
  valid(state, "分步招人");
});

test("招人：目标封顶 20 人（店员上限）", () => {
  const { state, shopIds } = tradeFixture(9506, { clerks: [2], surplusJin: 0 });
  const shop = state.shops[shopIds[0]];
  state.day += 60;
  shop.openedYear = 1;
  shop.openedDay = 1;
  prepareShopsForDay(state, CONTENT);
  const fakeRow = { serial: 1, staff: 3, shareJin: 99999, budgetJin: 900, usedJin: 900, capJin: 99999, trades: 3,
    exportJin: { salt: 900 }, importJin: {}, revenueVoucherUnits: 0, cogsVoucherUnits: 0, freightVoucherUnits: 0, tariffVoucherUnits: 0, profitVoucherUnits: 30 * V };
  for (let step = 0; step < 30; step += 1) {
    while (state.day % RULES.tradeHouseHireIntervalDays !== 0) state.day += 1;
    shop.tradeLog = Array.from({ length: 7 }, (_, i) => ({ ...fakeRow, serial: i + 1 }));
    prepareShopsForDay(state, CONTENT);
    shop.staffing.clerkHiredSerials = [];
    state.day += RULES.tradeHouseHireIntervalDays;
  }
  assert.ok(shopClerkCount(state, shop) <= 20, `店员不超过 20，实际 ${shopClerkCount(state, shop)}`);
  assert.equal(shopClerkCount(state, shop), 20, "机会够大时加到 20 人封顶");
  valid(state, "封顶");
});

test("招人：预算已到运力份额 → 加人无用，不加", () => {
  const { state, shopIds } = tradeFixture(9507, { clerks: [2], surplusJin: 0 });
  const shop = state.shops[shopIds[0]];
  while (state.day % RULES.tradeHouseHireIntervalDays !== 0) state.day += 1;
  const current = shopClerkCount(state, shop);
  shop.tradeLog = Array.from({ length: 7 }, (_, i) => ({ serial: i + 1, staff: 3, shareJin: 720, budgetJin: 720, usedJin: 720, capJin: 3000,
    trades: 2, exportJin: { salt: 720 }, importJin: {}, revenueVoucherUnits: 0, cogsVoucherUnits: 0, freightVoucherUnits: 0, tariffVoucherUnits: 0, profitVoucherUnits: 30 * V }));
  prepareShopsForDay(state, CONTENT);
  assert.equal(shopClerkCount(state, shop), current);
  assert.equal(shop.plan.staffingDiagnosis, "运力份额已满，加人无用");
});

test("招人：资金不够一个月工资 → 不加人", () => {
  const { state, shopIds } = tradeFixture(9508, { clerks: [2], surplusJin: 0 });
  const shop = state.shops[shopIds[0]];
  const cash = voucherBalance(state, `shop:${shop.id}`);
  transferVouchers(state, `shop:${shop.id}`, "town", cash, CONTENT, "test", "测试：抽空店铺资金");
  while (state.day % RULES.tradeHouseHireIntervalDays !== 0) state.day += 1;
  const current = shopClerkCount(state, shop);
  shop.tradeLog = Array.from({ length: 7 }, (_, i) => ({ serial: i + 1, staff: 3, shareJin: 2000, budgetJin: 900, usedJin: 900, capJin: 3000,
    trades: 3, exportJin: { salt: 900 }, importJin: {}, revenueVoucherUnits: 0, cogsVoucherUnits: 0, freightVoucherUnits: 0, tariffVoucherUnits: 0, profitVoucherUnits: 30 * V }));
  prepareShopsForDay(state, CONTENT);
  assert.equal(shopClerkCount(state, shop), current, `资金不足不加，诊断：${shop.plan.staffingDiagnosis}`);
  assert.equal(shop.plan.staffingDiagnosis, "生意做不完，资金不足暂不加人");
});

test("减员：亏损时仍只减一人，不低于下限 min(2, 初始配置)", () => {
  const { state, shopIds } = tradeFixture(9509, { clerks: [4], surplusJin: 0 });
  const shop = state.shops[shopIds[0]];
  shop.staffing.clerkHiredSerials = [-1000, -1000, -1000, -1000];
  while (state.day % RULES.tradeHouseHireIntervalDays !== 0) state.day += 1;
  const current = shopClerkCount(state, shop);
  shop.tradeLog = Array.from({ length: 7 }, (_, i) => ({ serial: i + 1, staff: 5, shareJin: 900, budgetJin: 1500, usedJin: 300, capJin: 300,
    trades: 1, exportJin: { salt: 300 }, importJin: {}, revenueVoucherUnits: 0, cogsVoucherUnits: 0, freightVoucherUnits: 0, tariffVoucherUnits: 0, profitVoucherUnits: -20 * V }));
  prepareShopsForDay(state, CONTENT);
  assert.equal(shopClerkCount(state, shop), current - 1, "亏损减一人");
  valid(state, "亏损减员");
});

test("闸门备货 180 天：目标库存按 180 天销量；wild_game 不再单独覆盖，bread 仍为 30 天", () => {
  const state = simulation.createInitialState({ seed: 9510 });
  state.wholesaleMarket ||= { inventory: {}, history: [] };
  const sold = { wild_game: 10 * I, flour: 10 * I, bread: 10 * I };
  state.wholesaleMarket.history = Array.from({ length: 7 }, (_, i) => ({ year: 1, day: i, inventory: {}, sold, unmet: {}, townConsumed: {}, price: {} }));
  assert.equal(RULES.townOutputStockDays, 180);
  assert.equal(RULES.townOutputStockDaysByItem.wild_game, undefined, "野味不再单独覆盖");
  assert.equal(townOutputTargetUnits(state, "wild_game", CONTENT), 10 * I * 180, "野味目标 = 日销 × 180");
  assert.equal(townOutputTargetUnits(state, "flour", CONTENT), 10 * I * 180, "面粉目标 = 日销 × 180");
  assert.equal(townOutputTargetUnits(state, "bread", CONTENT), 10 * I * 30, "面包仍按 30 天");
});
