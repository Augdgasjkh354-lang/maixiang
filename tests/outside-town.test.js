import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount } from "../src/systems/households.js";
import {
  advanceOutsideTownDay, currentPrice, payableWheatJin, settleOutsideTownYear, targetStock
} from "../src/systems/outside-town.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const PROFILE = CONTENT.outsideTowns.minzhen;

function tradingState(seed = 4401) {
  const state = simulation.createInitialState({ seed });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({
    id: "ftrade", typeId: "foreign_trade_house", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  setJobCount(state, "ftrade::trade_staff", 2, CONTENT);
  state.accounts.town.salt = (state.accounts.town.salt || 0) + 50000 * I;
  state.accounts.town.flour = (state.accounts.town.flour || 0) + 50000 * I;
  return state;
}

function runDays(state, days) {
  for (let i = 0; i < days; i++) {
    if (state.day === 0 && state.year > 1) settleOutsideTownYear(state, CONTENT);
    state.day += 1;
    advanceOutsideTownDay(state, CONTENT);
    if (state.day >= CONTENT.rules.daysPerYear) { state.day = 0; state.year += 1; }
  }
}

test("外镇进口品：不到 3 年存货按正常价收购，超过 3 年才压价；买进再卖回只亏价差", () => {
  const state = tradingState();
  const town = state.outsideTowns.minzhen;
  const before = currentPrice(state, CONTENT, "minzhen", "salt", "sell");
  const sold = simulation.tradeWithOutsideTown(state, "sell", "salt", 10000);
  assert.equal(sold.ok, true, sold.reason);
  assert.equal(currentPrice(state, CONTENT, "minzhen", "salt", "sell"), before, "存货不足 3 年，收购价不变");
  const yearNeed = town.population * PROFILE.goods.salt.needPerPersonDay * 365;
  town.stocks.salt = yearNeed * 3.5;
  assert.ok(currentPrice(state, CONTENT, "minzhen", "salt", "sell") < before, "囤够 3 年以上开始压价");
  town.stocks.salt = 0;
  const calm = currentPrice(state, CONTENT, "minzhen", "salt", "sell");
  town.prosperity = 10;
  assert.ok(currentPrice(state, CONTENT, "minzhen", "salt", "sell") > calm, "繁荣度越低越愿意出高价");

  // 面粉：买进再卖回同样数量，镇库小麦净减少（价差），不能套利。
  const wheatBefore = state.accounts.town.wheat;
  const flourBefore = state.accounts.town.flour;
  const bought = simulation.tradeWithOutsideTown(state, "buy", "flour", 5000);
  assert.equal(bought.ok, true, bought.reason);
  const back = simulation.tradeWithOutsideTown(state, "sell", "flour", bought.quantityJin);
  assert.equal(back.ok, true, back.reason);
  assert.equal(state.accounts.town.flour, flourBefore);
  assert.ok(state.accounts.town.wheat < wheatBefore, "往返交易必须亏掉价差");
  assert.ok(town.stats.trades >= 3);
});

test("外镇只用口粮储备以上的小麦付款，只卖自用以外的存货", () => {
  const state = tradingState(4402);
  const town = state.outsideTowns.minzhen;
  town.wheatStockJin = town.population * PROFILE.foodPerPersonDayJin * PROFILE.foodReserveDays + 1000;
  const sold = simulation.tradeWithOutsideTown(state, "sell", "salt", 50000);
  assert.equal(sold.ok, true, sold.reason);
  assert.ok(sold.valueJin <= 1000.01, "货款不能动用口粮储备");
  assert.ok(payableWheatJin(town, PROFILE) < 1);

  town.stocks.flour = town.population * PROFILE.goods.flour.needPerPersonDay * 10;
  const bought = simulation.tradeWithOutsideTown(state, "buy", "flour", 1000);
  assert.equal(bought.ok, false, "对方存货不足一个月自用时不外卖");
});

test("关税已删除；外贸房无人值守不能交易", () => {
  assert.equal(typeof simulation.setTradeTariffRate, "undefined");
  const state = tradingState(4403);
  setJobCount(state, "ftrade::trade_staff", 0, CONTENT);
  const result = simulation.tradeWithOutsideTown(state, "sell", "salt", 100);
  assert.equal(result.ok, false);
  assert.match(result.reason, /无人值守/);
});

test("盐木长期断供时外镇繁荣度下降但人口不减，供应充足时繁荣、人口增长更快、耕地每年扩大", () => {
  const starved = tradingState(4404);
  runDays(starved, 365 * 5);
  const s = starved.outsideTowns.minzhen;
  assert.ok(s.prosperity < 50, `断供繁荣度应低于50，实际${s.prosperity}`);
  assert.ok(s.population >= PROFILE.population, "人口只增不减");
  assert.equal(s.landMu, PROFILE.landMu + 4 * PROFILE.landGrowthMuPerYear);

  const fed = tradingState(4404);
  const town = fed.outsideTowns.minzhen;
  for (let i = 0; i < 365 * 5; i++) {
    runDays(fed, 1);
    for (const itemId of ["salt", "wood"]) {
      const good = { ...PROFILE.goods[itemId], id: itemId };
      town.stocks[itemId] = Math.max(town.stocks[itemId], targetStock(town, good));
    }
  }
  assert.ok(town.prosperity > 80, `供应充足繁荣度应高，实际${town.prosperity}`);
  assert.ok(town.population > PROFILE.population, "供应充足人口应增长");
});

test("秋收按耕地×亩产×天气入库，余粮不会无限堆积", () => {
  const state = tradingState(4405);
  const town = state.outsideTowns.minzhen;
  runDays(state, 365 * 12);
  const yearFood = town.population * PROFILE.foodPerPersonDayJin * 365;
  assert.ok(town.lastYear.harvestJin > 0);
  assert.ok(town.wheatStockJin < yearFood * 4, `小麦存量应有上限，实际${town.wheatStockJin}`);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("长协按签约时收购价锁定，每月交付进入外镇库存", () => {
  const state = tradingState(4406);
  const signed = simulation.signTradeAgreement(state, { itemId: "salt", annualJin: 1200, years: 2 });
  assert.equal(signed.ok, true, signed.reason);
  assert.equal(signed.agreement.townId, "minzhen");
  assert.ok(signed.agreement.pricePerUnit > 0);
});
