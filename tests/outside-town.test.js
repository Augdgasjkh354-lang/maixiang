import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { setJobCount } from "../src/systems/households.js";
import {
  advanceOutsideTownDay, currentPrice, ensureOutsideTowns, payableWheatJin, recordTradeStats, settleOutsideTownYear, targetStock
} from "../src/systems/outside-town.js";

test("逐商品统计：两镇不同商品分别累加（斤与货款），年终只重置年度斤数，累计保留，状态合法", () => {
  const state = simulation.createInitialState({ seed: 4421 });
  const towns = ensureOutsideTowns(state, CONTENT);
  const minzhen = towns.minzhen;
  const wangzhen = towns.wangzhen;
  // 民镇：卖两笔盐（40 斤、20 斤，货款 100、50 小麦斤）、买 25 斤面粉（货款 30）；王镇卖 35 斤木材（货款 70）。
  recordTradeStats(minzhen, "sell", 100, "salt", 40);
  recordTradeStats(minzhen, "sell", 50, "salt", 20);
  recordTradeStats(minzhen, "buy", 30, "flour", 25);
  recordTradeStats(wangzhen, "sell", 70, "wood", 35);
  assert.deepEqual(minzhen.stats.byItem.salt, { exportJin: 60, importJin: 0, exportValueJin: 150, importValueJin: 0, yearExportJin: 60, yearImportJin: 0 });
  assert.deepEqual(minzhen.stats.byItem.flour, { exportJin: 0, importJin: 25, exportValueJin: 0, importValueJin: 30, yearExportJin: 0, yearImportJin: 25 });
  assert.equal(wangzhen.stats.byItem.wood.exportJin, 35);
  assert.equal(wangzhen.stats.byItem.salt, undefined, "王镇没卖过盐");
  // 与镇级总统计对账：逐商品货款合计 = 镇级出口/进口货款。
  const sumValue = (town, key) => Object.values(town.stats.byItem).reduce((sum, row) => sum + row[key], 0);
  assert.equal(sumValue(minzhen, "exportValueJin"), minzhen.stats.exportJin);
  assert.equal(sumValue(minzhen, "importValueJin"), minzhen.stats.importJin);
  assert.equal(minzhen.stats.trades, 3, "镇级成交笔数不变");

  // 开局第一年不过年（settleOutsideTownYear 直接返回）：推到第 2 年再过年。
  state.year = 2;
  settleOutsideTownYear(state, CONTENT);
  assert.equal(minzhen.stats.byItem.salt.yearExportJin, 0, "年度斤数年终重置");
  assert.equal(minzhen.stats.byItem.flour.yearImportJin, 0);
  assert.equal(minzhen.stats.byItem.salt.exportJin, 60, "累计斤数保留");
  assert.equal(minzhen.stats.byItem.salt.exportValueJin, 150, "累计货款保留");
  assert.equal(minzhen.stats.byItem.flour.importJin, 25);
  assert.equal(wangzhen.stats.byItem.wood.exportJin, 35);
  assert.equal(wangzhen.stats.byItem.wood.yearExportJin, 0);
  assert.equal(simulation.validateState(state).valid, true, "校验通过");
});

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
  // 测试夹具：运力池给足，交易量不受运力限制（运力本身的测试见 logistics.test.js）。
  state.logistics.poolJin = 1000000;
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
  // 售出后关系分上升，价差收窄 0.01 量级的微调属正常（价差随关系分变化），这里只看库存因子不压价。
  assert.ok(Math.abs(currentPrice(state, CONTENT, "minzhen", "salt", "sell") - before) <= 0.02, "存货不足 3 年，收购价基本不变");
  const yearNeed = town.population * PROFILE.goods.salt.needPerPersonDay * CONTENT.rules.daysPerYear;
  town.stocks.salt = yearNeed * 3.5;
  assert.ok(currentPrice(state, CONTENT, "minzhen", "salt", "sell") < before, "囤够 3 年以上开始压价（同日即时反映库存）");
  town.stocks.salt = 0;
  const calm = currentPrice(state, CONTENT, "minzhen", "salt", "sell");
  town.prosperity = 10;
  // 繁荣度的影响经价格因子逐日靠拢，第二天起体现。
  runDays(state, 1);
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
  runDays(starved, CONTENT.rules.daysPerYear * 5);
  const s = starved.outsideTowns.minzhen;
  assert.ok(s.prosperity < 50, `断供繁荣度应低于50，实际${s.prosperity}`);
  assert.ok(s.population >= PROFILE.population, "人口只增不减");
  assert.equal(s.landMu, PROFILE.landMu + 4 * PROFILE.landGrowthMuPerYear);

  const fed = tradingState(4404);
  const town = fed.outsideTowns.minzhen;
  for (let i = 0; i < CONTENT.rules.daysPerYear * 5; i++) {
    runDays(fed, 1);
    for (const [itemId, profile] of Object.entries(PROFILE.goods)) {
      if (profile.sellsToUs !== false) continue;
      const good = { ...profile, id: itemId };
      town.stocks[itemId] = Math.max(town.stocks[itemId], targetStock(town, good));
    }
  }
  assert.ok(town.prosperity > 80, `供应充足繁荣度应高，实际${town.prosperity}`);
  assert.ok(town.population > PROFILE.population, "供应充足人口应增长");
});

test("秋收按耕地×亩产×天气入库，余粮不会无限堆积", () => {
  const state = tradingState(4405);
  const town = state.outsideTowns.minzhen;
  runDays(state, CONTENT.rules.daysPerYear * 12);
  const yearFood = town.population * PROFILE.foodPerPersonDayJin * CONTENT.rules.daysPerYear;
  assert.ok(town.lastYear.harvestJin > 0);
  // 耕地 30000 亩（亩产 300）的秋收远大于口粮，存量会涨到一个由每日 0.1% 损耗决定的上限，不能无限堆积。
  assert.ok(town.wheatStockJin < yearFood * 8, `小麦存量应有上限，实际${town.wheatStockJin}`);
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors.join("；"));
});

test("长协按签约时收购价锁定，每月交付进入外镇库存", () => {
  const state = tradingState(4406);
  const signed = simulation.signTradeAgreement(state, { itemId: "salt", annualJin: 1200, years: 2 });
  assert.equal(signed.ok, true, signed.reason);
  assert.equal(signed.agreement.townId, "minzhen");
  assert.ok(signed.agreement.pricePerUnit > 0);
});

test("初始外镇：人口 6000、耕地 30000 亩；库存与初始小麦按人口放大，人均与原来（3500 人）一致", () => {
  const state = simulation.createInitialState({ seed: 4410 });
  // 原档案（3500 人）的人均初始库存：小麦 3000000，盐 20000，木 8000，面粉 31500，面包 15750。
  const originalPerCapita = { wheat: 3000000 / 3500, salt: 20000 / 3500, wood: 8000 / 3500, flour: 31500 / 3500, bread: 15750 / 3500 };
  for (const id of ["minzhen", "wangzhen"]) {
    const town = state.outsideTowns[id];
    assert.equal(town.population, 6000, `${id} 人口`);
    assert.equal(town.landMu, 30000, `${id} 耕地`);
    assert.ok(Math.abs(town.wheatStockJin / 6000 - originalPerCapita.wheat) < 0.5, `${id} 人均小麦`);
    for (const itemId of ["salt", "wood", "flour", "bread"]) {
      assert.ok(Math.abs(town.stocks[itemId] / 6000 - originalPerCapita[itemId]) < 0.01, `${id} ${itemId} 人均库存`);
    }
  }
  assert.equal(simulation.validateState(state).valid, true);
});

test("外镇事件不再有随机商路中断：关系分正常时年年商路畅通，其他事件照常发生", () => {
  const state = tradingState(4412);
  const seen = new Set();
  for (let year = 2; year <= 300; year += 1) {
    state.year = year;
    settleOutsideTownYear(state, CONTENT);
    for (const town of Object.values(state.outsideTowns)) {
      seen.add(town.event?.type ?? "平年");
      assert.equal(town.tradeClosed, false, "关系分正常（≥20）时商路不断");
    }
  }
  assert.equal(seen.has("商路中断"), false);
  assert.ok(seen.has("蝗灾") || seen.has("丰收"), `其他事件应照常发生：${[...seen].join("、")}`);
});

test("价格因子逐日靠拢：单日相对变动不超过 priceEasePerDay，不低于 minBuyPriceFactor，并能走到下限", () => {
  const state = tradingState(4413);
  const town = state.outsideTowns.minzhen;
  const { priceEasePerDay: ease, minBuyPriceFactor: floor } = CONTENT.rules.outsideTrade;
  assert.equal(ease, 0.01);
  assert.equal(floor, 0.9);
  const importIds = ["salt", "wood", "wine", "cloth"];
  // 进口品存货堆到 10 年用量、繁荣度拉满：目标因子（库存因子 0.4 × 紧迫系数 1）远低于下限，因子应逐日下降并停在下限。
  town.prosperity = 100;
  let prev = Object.fromEntries(importIds.map(id => [id, town.priceFactor[id]]));
  const initialSalt = prev.salt;
  const trajectory = [];
  // 参照库存也平滑追随（1%/天），要约 300 天才追上 10 年用量，之后因子再慢慢降到下限。
  for (let day = 0; day < 420; day += 1) {
    for (const itemId of importIds) {
      town.stocks[itemId] = town.population * PROFILE.goods[itemId].needPerPersonDay * 360 * 10;
    }
    runDays(state, 1);
    for (const itemId of importIds) {
      const now = town.priceFactor[itemId];
      assert.ok(Math.abs(now / prev[itemId] - 1) <= ease + 1e-6, `${itemId} 第${day + 1}天变动 ${now / prev[itemId] - 1}`);
      assert.ok(now >= floor - 1e-9, `${itemId} 因子 ${now} 不得低于下限`);
      prev[itemId] = now;
    }
    trajectory.push(prev.salt);
  }
  assert.ok(trajectory[0] < initialSalt && trajectory[0] > floor, "第一天就开始下降，但不会一步到底");
  assert.ok(Math.abs(trajectory.at(-1) - floor) < 1e-6, `最终停在下限 ${floor}，实际 ${trajectory.at(-1)}`);
});

test("大单逐段计价：一次卖出与分两次卖出得到的小麦几乎一样，同日第二笔不会回到原价", () => {
  const yearNeed = PROFILE.goods.salt.needPerPersonDay * CONTENT.rules.daysPerYear * PROFILE.population;
  const setup = () => {
    const state = tradingState(4414);
    const town = state.outsideTowns.minzhen;
    town.stocks.salt = yearNeed * 3.5; // 3.5 年用量：库存因子 0.9，买卖明显影响价格（又不触及 0.9 的价格下限）
    return { state, town };
  };
  const one = setup();
  const whole = simulation.tradeWithOutsideTown(one.state, "sell", "salt", 20000);
  assert.equal(whole.ok, true, whole.reason);
  const split = setup();
  const first = simulation.tradeWithOutsideTown(split.state, "sell", "salt", 10000);
  const second = simulation.tradeWithOutsideTown(split.state, "sell", "salt", 10000);
  assert.equal(first.ok && second.ok, true);
  assert.ok(Math.abs(first.valueJin + second.valueJin - whole.valueJin) / whole.valueJin < 0.005, "分批与一次卖出总价相近（不能靠分批占便宜）");
  assert.ok(second.priceWheatPerUnit < first.priceWheatPerUnit, "同日第二笔价格更低（库存已涨）");
});

test("库存冲击当天即时反映，次日不回弹：价格因子与参照库存平滑收敛，价格不来回跳", () => {
  const state = tradingState(4415);
  const town = state.outsideTowns.minzhen;
  const yearNeed = town.population * PROFILE.goods.salt.needPerPersonDay * CONTENT.rules.daysPerYear;
  const before = currentPrice(state, CONTENT, "minzhen", "salt", "sell");
  town.stocks.salt = yearNeed * 4; // 库存因子 0.8，不触及价格下限
  const shocked = currentPrice(state, CONTENT, "minzhen", "salt", "sell");
  assert.ok(shocked < before * 0.9, `同日即时反映库存（${before} → ${shocked}）`);
  runDays(state, 1);
  const next = currentPrice(state, CONTENT, "minzhen", "salt", "sell");
  assert.ok(next <= shocked * 1.02, `次日不应回弹（${shocked} → ${next}）`);
});
