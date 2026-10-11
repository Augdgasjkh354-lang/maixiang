// 贵金属 mod：银条（民镇，年产 5000 斤）、金条（王镇，年产 500 斤），只能用小麦向外镇买，也可卖回外镇。
import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT, createInitialState, simulation } from "../src/engine.js";
import { CORE_DAILY_STEPS, runDay } from "../src/systems/daily.js";
import { setJobCount } from "../src/systems/households.js";
import { validateState } from "../src/core/validation.js";
import { quantityToUnits } from "../src/economy/inventory.js";
import { advanceOutsideTownDay, currentPrice, ensureOutsideTowns, settleOutsideTownYear } from "../src/systems/outside-town.js";
import { mergeOntoBase } from "../src/persistence/save-compat.js";
import { townWheatReserveUnits } from "../src/selectors/production.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const SILVER = "silver_bar";
const GOLD = "gold_bar";
const MIN = "minzhen";
const WANG = "wangzhen";

// 在空地上建外贸房并派 2 人值守（外贸只能在岗时进行）。运力池给足，交易量不受运力限制。
function tradingState(seed = 6101) {
  const state = createInitialState({ seed });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({
    id: "ftrade", typeId: "foreign_trade_house", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  setJobCount(state, "ftrade::trade_staff", 2, CONTENT);
  state.logistics.poolJin = 1000000;
  // 镇库小麦远高于口粮储备线，付款不会被储备线拦住。
  state.accounts.town.wheat = 5000000 * I;
  return state;
}

const units = jin => Math.round((jin + Number.EPSILON) * I);

test("内容：银条、金条是非批发、非货架的贵金属，开局价与库存正确", () => {
  for (const id of [SILVER, GOLD]) {
    const item = CONTENT.items[id];
    assert.equal(item.category, "valuable");
    assert.equal(item.edible, false);
    assert.ok(!item.wholesale && !item.retail && !item.storeOnly && !item.optionalRetail, `${id} 不带流通标记`);
  }
  assert.equal(CONTENT.outsideTowns[MIN].goods[SILVER].basePrice, 1000);
  assert.equal(CONTENT.outsideTowns[WANG].goods[GOLD].basePrice, 10000);
  assert.equal(CONTENT.outsideTowns[MIN].goods[GOLD], undefined, "民镇不产金");
  assert.equal(CONTENT.outsideTowns[WANG].goods[SILVER], undefined, "王镇不产银");

  const state = createInitialState({ seed: 6102 });
  assert.equal(state.outsideTowns[MIN].stocks[SILVER], 5000, "银条开局库存一年产量");
  assert.equal(state.outsideTowns[WANG].stocks[GOLD], 500, "金条开局库存一年产量");
  assert.equal(state.outsideTowns[MIN].mines[SILVER].annualOutputJin, 5000);
  assert.equal(state.outsideTowns[WANG].mines[GOLD].annualOutputJin, 500);
  assert.equal(currentPrice(state, CONTENT, MIN, SILVER, "buy"), 1000, "银条开局买价 1000 斤小麦/斤");
  assert.equal(currentPrice(state, CONTENT, WANG, GOLD, "buy"), 10000, "金条开局买价 10000 斤小麦/斤");
  assert.ok(currentPrice(state, CONTENT, MIN, SILVER, "sell") < 1000, "卖回价低于买价");
  assert.deepEqual(validateState(state, CONTENT).errors, [], "开局状态合法");
});

test("年产量逐年增长 5%（取整，至少 +1）：银 5000→5250→5513，金 500→525→551", () => {
  const state = createInitialState({ seed: 6103 });
  const silver = [];
  const gold = [];
  for (let year = 2; year <= 4; year += 1) {
    state.year = year;
    settleOutsideTownYear(state, CONTENT);
    silver.push(state.outsideTowns[MIN].mines[SILVER].annualOutputJin);
    gold.push(state.outsideTowns[WANG].mines[GOLD].annualOutputJin);
  }
  assert.deepEqual(silver, [5250, 5513, 5789]);
  assert.deepEqual(gold, [525, 551, 579]);
  // 同一年重复结算不得重复增长。
  settleOutsideTownYear(state, CONTENT);
  assert.equal(state.outsideTowns[MIN].mines[SILVER].annualOutputJin, 5789);
});

test("年产量至少 +1：小基数的增长取整不会停滞", () => {
  const state = createInitialState({ seed: 6104 });
  state.outsideTowns[WANG].mines[GOLD].annualOutputJin = 10;
  state.year = 2;
  settleOutsideTownYear(state, CONTENT);
  assert.equal(state.outsideTowns[WANG].mines[GOLD].annualOutputJin, 11, "round(10.5)=11 也满足至少 +1");
  state.outsideTowns[WANG].mines[GOLD].annualOutputJin = 1;
  state.year = 3;
  settleOutsideTownYear(state, CONTENT);
  assert.equal(state.outsideTowns[WANG].mines[GOLD].annualOutputJin, 2, "round(1.05)=1，靠 +1 增长");
});

test("每日入库一天的产量，库存封顶为当年产量 × 3 年", () => {
  const state = createInitialState({ seed: 6105 });
  const before = state.outsideTowns[MIN].stocks[SILVER];
  for (let day = 0; day < 10; day += 1) advanceOutsideTownDay(state, CONTENT);
  const added = state.outsideTowns[MIN].stocks[SILVER] - before;
  assert.ok(Math.abs(added - 10 * 5000 / 360) < 0.01, `10 天入库 ${added}`);
  assert.ok(Math.abs(state.outsideTowns[WANG].stocks[GOLD] - (500 + 10 * 500 / 360)) < 0.01, "金条同样按日入库");

  state.outsideTowns[MIN].stocks[SILVER] = 15000;
  advanceOutsideTownDay(state, CONTENT);
  assert.equal(state.outsideTowns[MIN].stocks[SILVER], 15000, "达到上限后不再入库，也不损耗");
  state.outsideTowns[MIN].stocks[SILVER] = 14999;
  advanceOutsideTownDay(state, CONTENT);
  assert.ok(Math.abs(state.outsideTowns[MIN].stocks[SILVER] - 15000) < 0.01, "只补到上限");
});

test("买价在基准价 ±20% 内随库存摆动，买入总比卖回贵", () => {
  const state = createInitialState({ seed: 6106 });
  const town = state.outsideTowns[MIN];
  town.stocks[SILVER] = 0;
  assert.equal(currentPrice(state, CONTENT, MIN, SILVER, "buy"), 1200, "无库存时买价封顶 +20%");
  town.stocks[SILVER] = 3 * 5000;
  assert.equal(currentPrice(state, CONTENT, MIN, SILVER, "buy"), 800, "库存 3 年产量时买价封底 -20%");
  town.stocks[SILVER] = 5000;
  const buy = currentPrice(state, CONTENT, MIN, SILVER, "buy");
  const sell = currentPrice(state, CONTENT, MIN, SILVER, "sell");
  assert.ok(sell < buy, "外镇收购价低于出售价");
  assert.ok(Math.abs((buy - sell) / buy - 0.14) < 1e-6, "价差取关系分对应的 14%（关系 60）");
});

test("只能用小麦买：镇库小麦不足（或只剩口粮储备）时拒绝，银条不动", () => {
  const state = tradingState(6107);
  state.accounts.town.wheat = 0;
  const silverBefore = state.outsideTowns[MIN].stocks[SILVER];
  const res = simulation.tradeWithOutsideTown(state, "buy", SILVER, 1, MIN);
  assert.equal(res.ok, false);
  assert.match(res.reason, /付不起/);
  assert.equal(state.accounts.town[SILVER] || 0, 0);
  assert.equal(state.outsideTowns[MIN].stocks[SILVER], silverBefore);

  // 数量过小（不足 0.01 斤）与库存不足给不同的原因。
  const tiny = simulation.tradeWithOutsideTown(state, "buy", SILVER, 0.001, MIN);
  assert.equal(tiny.ok, false);
  assert.match(tiny.reason, /数量过小/);
  state.outsideTowns[MIN].stocks[SILVER] = 0;
  const empty = simulation.tradeWithOutsideTown(state, "buy", SILVER, 1, MIN);
  assert.match(empty.reason, /库存不足/);
  state.outsideTowns[MIN].stocks[SILVER] = 5000;
  // 镇库小麦刚好等于口粮储备线：一斤也付不起。
  state.accounts.town.wheat = townWheatReserveUnits(state, CONTENT);
  const reserved = simulation.tradeWithOutsideTown(state, "buy", SILVER, 0.01, MIN);
  assert.equal(reserved.ok, false, "储备线以内的小麦不能拿去买银");
});

test("买入：镇库小麦减少、银条增加、外镇库存与收到的小麦对账", () => {
  const state = tradingState(6108);
  const wheatTown0 = state.accounts.town.wheat;
  const wheatOut0 = state.outsideTowns[MIN].wheatStockJin;
  const silverOut0 = state.outsideTowns[MIN].stocks[SILVER];
  const res = simulation.tradeWithOutsideTown(state, "buy", SILVER, 10, MIN);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.quantityJin, 10);
  // 按价计的货款 ≈ 10 斤 × 1000（库存略减，单价小幅上浮）。
  assert.ok(res.valueJin > 10000 && res.valueJin < 10100, `货款 ${res.valueJin}`);
  assert.equal(state.accounts.town.wheat, wheatTown0 - quantityToUnits(res.valueJin, CONTENT));
  assert.equal(state.accounts.town[SILVER], 10 * I, "银条进镇库库存");
  assert.ok(Math.abs(state.outsideTowns[MIN].wheatStockJin - (wheatOut0 + res.valueJin)) < 0.01, "外镇小麦增加货款");
  assert.ok(Math.abs(state.outsideTowns[MIN].stocks[SILVER] - (silverOut0 - 10)) < 1e-9, "外镇银条减少");
  // 总量守恒：银条（外镇 + 我方）不变；小麦（镇库 + 外镇）不变（允许 1 单位取整误差）。
  const silverTotal = state.outsideTowns[MIN].stocks[SILVER] + state.accounts.town[SILVER] / I;
  assert.ok(Math.abs(silverTotal - silverOut0) < 1e-6, "银条总量守恒");
  const wheatTotal = state.accounts.town.wheat / I + state.outsideTowns[MIN].wheatStockJin;
  assert.ok(Math.abs(wheatTotal - (wheatTown0 / I + wheatOut0)) < 2 / I, "小麦总量守恒");
  assert.deepEqual(validateState(state, CONTENT).errors, []);
});

test("买入再卖回：买价高于卖价，来回一趟亏价差", () => {
  const state = tradingState(6109);
  const buy = simulation.tradeWithOutsideTown(state, "buy", GOLD, 2, WANG);
  assert.equal(buy.ok, true, buy.reason);
  assert.equal(state.accounts.town[GOLD], 2 * I);
  const sell = simulation.tradeWithOutsideTown(state, "sell", GOLD, 2, WANG);
  assert.equal(sell.ok, true, sell.reason);
  assert.equal(state.accounts.town[GOLD] || 0, 0, "金条卖回后镇库没有");
  assert.ok(sell.valueJin < buy.valueJin, `卖回 ${sell.valueJin} 应少于买入 ${buy.valueJin}`);
  assert.ok(buy.valueJin - sell.valueJin > 0.1 * buy.valueJin * 0.5, "亏损约等于价差");
  assert.deepEqual(validateState(state, CONTENT).errors, []);
});

test("外镇收的银条按其收购价付小麦（允许卖回）", () => {
  const state = tradingState(6110);
  simulation.tradeWithOutsideTown(state, "buy", SILVER, 5, MIN);
  const wheatBefore = state.accounts.town.wheat;
  const res = simulation.tradeWithOutsideTown(state, "sell", SILVER, 5, MIN);
  assert.equal(res.ok, true, res.reason);
  assert.equal(state.accounts.town.wheat, wheatBefore + quantityToUnits(res.valueJin, CONTENT));
  assert.equal(state.accounts.town[SILVER] || 0, 0);
});

test("贸易行与批发市场不碰银金：不进出口、不进批发库存", () => {
  const state = tradingState(6111);
  state.accounts.town[SILVER] = 1000 * I;
  for (let day = 0; day < 60; day += 1) runDay(state, CONTENT, CORE_DAILY_STEPS);
  assert.equal(state.accounts.town[SILVER], 1000 * I, "镇库银条没有被贸易行卖出");
  assert.ok(Math.abs(state.outsideTowns[MIN].stocks[SILVER] - (5000 + 60 * 5000 / 360)) < 0.01, "外镇银条只有自产入库，没有被贸易行买走");
  assert.equal(state.wholesaleMarket?.inventory?.[SILVER] || 0, 0);
  assert.equal(state.wholesaleMarket?.inventory?.[GOLD] || 0, 0);
});

test("长期协定不能签银金（长协只限批发市场商品）", () => {
  const state = tradingState(6112);
  const res = simulation.signTradeAgreement(state, { itemId: SILVER, annualJin: 100, years: 1, townId: MIN });
  assert.equal(res.ok, false);
  assert.match(res.reason, /批发市场/);
  assert.equal(state.tradeAgreements?.length || 0, 0);
});

test("外贸面板的长协品类不含银金", async () => {
  const { renderOutsideTown } = await import("../src/ui/panel-outside-town.js");
  const state = tradingState(6113);
  const view = simulation.selectDashboard(state, { panel: "business", outsideTownId: MIN });
  const html = renderOutsideTown(view);
  assert.equal(html.includes(`value="${SILVER}"`), false, "银条不进长协品类下拉");
  assert.ok(html.includes(`<option value="salt">`), "盐仍是长协品类");
  const goods = view.outsideTown.goods.find(good => good.itemId === SILVER);
  assert.equal(goods.sellsToUs, true);
  assert.equal(goods.wholesale, false);
});

test("校验：矿产年产量或库存为负时报错，镇库银条非法时报错", () => {
  const state = createInitialState({ seed: 6114 });
  state.outsideTowns[MIN].mines[SILVER].annualOutputJin = -1;
  const errors = validateState(state, CONTENT).errors;
  assert.ok(errors.some(text => text.includes("[precious_metals]") && text.includes("年产量无效")), errors.join("|"));
  state.outsideTowns[MIN].mines[SILVER].annualOutputJin = 5000;
  state.outsideTowns[WANG].stocks[GOLD] = Number.NaN;
  assert.ok(validateState(state, CONTENT).errors.some(text => text.includes("库存无效")));
  state.outsideTowns[WANG].stocks[GOLD] = 500;
  state.accounts.town[SILVER] = -5;
  assert.ok(validateState(state, CONTENT).errors.some(text => text.includes("镇库银条数量无效")));
});

test("旧档（无 mines 与银金库存）读入后补出", () => {
  const base = createInitialState({ seed: 6115 });
  const saved = JSON.parse(JSON.stringify(base));
  delete saved.outsideTowns[MIN].mines;
  delete saved.outsideTowns[MIN].stocks[SILVER];
  delete saved.outsideTowns[WANG].mines;
  delete saved.outsideTowns[WANG].stocks[GOLD];
  delete saved.accounts.town[SILVER];
  const merged = mergeOntoBase(createInitialState({ seed: 6115 }), saved);
  assert.equal(merged.outsideTowns[MIN].mines[SILVER].annualOutputJin, 5000);
  assert.equal(merged.outsideTowns[WANG].stocks[GOLD], 500);

  const bare = JSON.parse(JSON.stringify(base));
  delete bare.outsideTowns[MIN].mines;
  delete bare.outsideTowns[MIN].stocks[SILVER];
  ensureOutsideTowns(bare, CONTENT);
  assert.equal(bare.outsideTowns[MIN].mines[SILVER].annualOutputJin, 5000);
  assert.equal(bare.outsideTowns[MIN].stocks[SILVER], 5000);
});

test("跑 90 天：无异常、状态合法、银金库存有限", () => {
  const state = tradingState(6116);
  state.accounts.town[SILVER] = 200 * I;
  state.accounts.town[GOLD] = 20 * I;
  for (let day = 0; day < 90; day += 1) {
    runDay(state, CONTENT, CORE_DAILY_STEPS);
    if (day === 30) {
      assert.equal(simulation.tradeWithOutsideTown(state, "buy", GOLD, 1, WANG).ok, true);
    }
  }
  assert.deepEqual(validateState(state, CONTENT).errors, []);
  for (const town of [MIN, WANG]) {
    for (const id of [SILVER, GOLD]) {
      const stock = state.outsideTowns[town].stocks[id];
      if (stock !== undefined) assert.ok(Number.isFinite(stock) && stock >= 0, `${town}.${id} 有限非负`);
    }
  }
  assert.ok(state.outsideTowns[MIN].mines[SILVER].annualOutputJin === 5000, "一年内不增产");
});
