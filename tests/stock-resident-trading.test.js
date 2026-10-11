import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { generateResidentSellOrders, settleDailyShareMarket, settleHouseholdStockBuying, settleStockMarketDay, stepSharePrice, STOCK_MARKET } from "../src/systems/stock-exchange.js";
import { voucherBalance, totalVoucherBalances, shareTick } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { V, assertValid, giveHoldings, listedState, onlyBudget } from "./helpers-stock.js";
import { householdList } from "../src/systems/households.js";

// 居民卖出与换手（docs/STOCK.md）：持股居民每天抽样挂卖单，买方先吃居民卖单、再吃发行池；未成交的卖单当日作废。

test("卖单先于发行池成交：买方先吃居民卖单，剩余预算再买发行池", () => {
  const { state, company } = listedState({ offer: 100, price: 2 });
  const [seller, resident, buyer] = householdList(state);
  giveHoldings(state, company, { [resident.id]: 60 });
  assert.equal(grantResidentVouchers(state, 1000, CONTENT, buyer.id).ok, true);
  onlyBudget(state, buyer.id, 80 * 2 * V);
  const orders = new Map([[company.id, [{ householdId: resident.id, shares: 50, remaining: 50 }]]]);
  const trade = settleHouseholdStockBuying(state, CONTENT, orders);
  assert.equal(trade.shares, 80, "预算买 80 股：50 股来自居民，30 股来自发行池");
  assert.equal(company.householdShares[resident.id], 10, "卖方居民减持 50 股");
  assert.equal(company.householdShares[buyer.id], 80, "买方持 80 股");
  assert.equal(company.townShares, 1000 - 60 - 30, "镇库只卖出发行池的 30 股");
  assert.equal(company.shareSale.offeredShares, 70, "发行池扣减 30 股");
  assert.equal(orders.get(company.id)[0].remaining, 0, "卖单已成交完");
  assert.equal(company.stockMarket.flow, (80 - 50) / 1000, "净流量 = 买入 80 − 卖出意愿 50，按总股本折算");
  assert.equal(seller.shares?.[company.id] || 0, 0, "未持股的户不受影响");
  assertValid(state, "居民卖单成交后");
});

test("卖单未成交作废：不扣股份、不跨日；卖压计入净流量", () => {
  const { state, company } = listedState({ offer: 0, price: 2 });
  const resident = householdList(state)[0];
  giveHoldings(state, company, { [resident.id]: 40 });
  for (const household of householdList(state)) household.stockBuyBudgetVoucherUnits = 0;
  const holdingsBefore = JSON.stringify(company.householdShares);
  const orders = new Map([[company.id, [{ householdId: resident.id, shares: 25, remaining: 25 }]]]);
  assert.equal(settleHouseholdStockBuying(state, CONTENT, orders), null, "没有买家时不成交");
  assert.equal(JSON.stringify(company.householdShares), holdingsBefore, "卖单不预先扣股份");
  assert.equal(company.stockMarket.flow, -25 / 1000, "卖压计入净流量（次日压价）");
  assert.equal(JSON.stringify(state).includes('"remaining"'), false, "卖单不进存档");
  // 第二天的日结重新生成卖单，前一日的卖单不再参与成交。
  settleStockMarketDay(state, CONTENT);
  assert.equal(company.stockMarket.flow, 0, "净流量只用一天");
});

test("成交时校验卖方仍持有：卖单超过持股时只卖实际持股", () => {
  const { state, company } = listedState({ offer: 0, price: 2 });
  const [resident, buyer] = householdList(state);
  giveHoldings(state, company, { [resident.id]: 20 });
  assert.equal(grantResidentVouchers(state, 1000, CONTENT, buyer.id).ok, true);
  onlyBudget(state, buyer.id, 500 * 2 * V);
  const orders = new Map([[company.id, [{ householdId: resident.id, shares: 80, remaining: 80 }]]]);
  const trade = settleHouseholdStockBuying(state, CONTENT, orders);
  assert.equal(trade.shares, 20);
  assert.equal(company.householdShares[resident.id] || 0, 0, "卖方清仓");
  assert.equal(company.householdShares[buyer.id], 20);
  assert.equal(resident.shares[company.id] || 0, 0);
  assertValid(state, "超卖单成交后");
});

test("居民卖出的印花税由卖方付给镇库，买方付全额，总量守恒", () => {
  const { state, company } = listedState({ offer: 0, price: 2 });
  const [resident, buyer] = householdList(state);
  giveHoldings(state, company, { [resident.id]: 30 });
  assert.equal(grantResidentVouchers(state, 1000, CONTENT, buyer.id).ok, true);
  onlyBudget(state, buyer.id, 1000 * 2 * V);
  const orders = new Map([[company.id, [{ householdId: resident.id, shares: 30, remaining: 30 }]]]);
  const cost = 30 * company.sharePriceVoucherUnits;
  const duty = Math.round(cost * CONTENT.rules.stampDutyDefaultPercent / 100);
  const sellerBefore = voucherBalance(state, `household:${resident.id}`);
  const townBefore = voucherBalance(state, "town");
  const totalBefore = totalVoucherBalances(state);
  const trade = settleHouseholdStockBuying(state, CONTENT, orders);
  assert.equal(trade.stampDutyVoucherUnits, duty);
  assert.equal(voucherBalance(state, `household:${resident.id}`) - sellerBefore, cost - duty);
  assert.equal(voucherBalance(state, "town") - townBefore, duty);
  assert.equal(totalVoucherBalances(state), totalBefore, "粮券总量守恒");
  assertValid(state, "居民卖出后");
});

test("抽样：生成卖单只改随机数，不动持股；无持股时不消耗随机数", () => {
  const empty = listedState({ offer: 0, price: 2 });
  const rngBefore = empty.state.rng.state;
  const none = generateResidentSellOrders(empty.state, CONTENT);
  assert.equal(none.size, 0);
  assert.equal(empty.state.rng.state, rngBefore, "无持股不消耗随机数");

  const { state, company } = listedState({ offer: 0, price: 2 });
  const holders = householdList(state).slice(0, 800);
  giveHoldings(state, company, Object.fromEntries(holders.map(h => [h.id, 1])));
  for (const household of holders) assert.equal(grantResidentVouchers(state, 100000, CONTENT, household.id).ok, true);
  const holdingsBefore = JSON.stringify([company.householdShares, company.townShares, company.residentShares]);
  let sold = 0;
  for (let day = 0; day < 200; day += 1) {
    const orders = generateResidentSellOrders(state, CONTENT);
    for (const rows of orders.values()) sold += rows.reduce((sum, row) => sum + row.shares, 0);
  }
  assert.equal(JSON.stringify([company.householdShares, company.townShares, company.residentShares]), holdingsBefore, "生成卖单不改持股");
  // 800 户、基础换手 0.5%/天、满现金、常态行情：期望约 800 × 0.005 × 200 = 800 股。
  assert.ok(sold >= 550 && sold <= 1100, `卖单股数 ${sold} 应接近期望 800`);
  assertValid(state, "抽样后");
});

test("价格方向：净流量为正推高次日股价，为负压低；同一随机数下对比", () => {
  const content = CONTENT;
  const tick = shareTick(content);
  const price = 1000 * tick;
  const draws = () => ({ uniform: () => 0.9999, gauss: () => 0 });
  const up = { regime: "normal", daysLeft: 0, drift: 0, momentum: 0, anchorUnits: price, flow: 0.05 };
  const down = { regime: "normal", daysLeft: 0, drift: 0, momentum: 0, anchorUnits: price, flow: -0.05 };
  const flat = { regime: "normal", daysLeft: 0, drift: 0, momentum: 0, anchorUnits: price, flow: 0 };
  const priceUp = stepSharePrice(price, price, up, 0, draws(), content);
  const priceDown = stepSharePrice(price, price, down, 0, draws(), content);
  const priceFlat = stepSharePrice(price, price, flat, 0, draws(), content);
  assert.ok(priceUp > priceFlat, "买盘推价");
  assert.ok(priceDown < priceFlat, "卖压压价");
  assert.equal(priceUp, Math.round(price * (1 + STOCK_MARKET.flowImpact * 0.05) / tick) * tick, "涨幅 = flowImpact × 净流量");
  // 净流量被上限钳制。
  const huge = { ...up, flow: 5 };
  assert.equal(stepSharePrice(price, price, huge, 0, draws(), content), stepSharePrice(price, price, { ...up, flow: STOCK_MARKET.flowCap }, 0, draws(), content));
});

test("同种子可复现：两次相同的操作得到完全相同的结果", () => {
  const run = () => {
    const { state, company } = listedState({ offer: 200, price: 2, seed: 777 });
    const holders = householdList(state).slice(0, 60);
    giveHoldings(state, company, Object.fromEntries(holders.map(h => [h.id, 3])));
    for (let day = 0; day < 25; day += 1) {
      for (const household of holders) household.stockBuyBudgetVoucherUnits = 40 * V;
      settleStockMarketDay(state, CONTENT);
      settleDailyShareMarket(state, CONTENT);
      state.day = (state.day + 1) % 360;
    }
    return JSON.stringify({ rng: state.rng, companies: state.companies, households: state.households.byId, stampDuty: state.stampDuty });
  };
  assert.equal(run(), run());
});

test("没有交易所时日结股市不做任何事", () => {
  const { state } = listedState({ offer: 0, price: 2 });
  state.buildings = state.buildings.filter(row => row.typeId !== "stock_exchange");
  state.stockExchange = { legacyAccess: false, rotation: 0 };
  const rng = state.rng.state;
  assert.equal(settleDailyShareMarket(state, CONTENT), null);
  assert.equal(state.rng.state, rng);
});
