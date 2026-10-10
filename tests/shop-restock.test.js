import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdList, householdIdleWorkers, jobCount } from "../src/systems/households.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { transferVouchers } from "../src/economy/currency.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

// 历史 bug：综合商店的进货目标只看"过去销量"。断货时实际卖出的量被库存截断，
// 居民真正想买而没买到的面包从不进入口径，于是进货目标被压在低位。
// 例：批发市场突然来了 4000 斤面包，店里却要 6 天才从 120 斤爬到接待上限约 480 斤/日，
// 期间居民想买的面包大量落空，批发市场的面包也一直堆着。
// 修复后：断货的未满足需求计入进货口径，次日即按需求补货。

// settledStore：店铺开张期已过（开张期每天招人，店员数会逐日变化；本用例只测进货口径，店员数要固定）。
function setupStore(seed, { producers = false, settledStore = false } = {}) {
  const state = simulation.createInitialState({ seed });
  grantResidentVouchers(state, 300000, CONTENT);
  simulation.issueGrainVouchers(state, "town", 200000);
  const freePlot = feature => state.plots.find(p => (feature ? p.feature === feature : !p.feature) && !state.buildings.some(b => b.plotId === p.id));
  const place = (id, typeId, { town = 0, priv = 0 }) => {
    const plot = freePlot(CONTENT.buildings[typeId].requiredPlotFeature || null);
    assert.ok(plot, `no plot for ${typeId}`);
    // 民营建筑须记录民营开张日（ownership.js 卖给民营时写入）：新开张的民营每天可招够人。
    const privateSince = priv > 0 ? { year: 1, day: 0 } : undefined;
    state.buildings.push({ id, typeId, level: 2, ownership: { townLevels: town, privateLevels: priv, listedLevels: 0 },
      plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }, privateSince });
  };
  place("wholesale_market", "wholesale_market", { town: 2 });
  place("commercial_street", "commercial_street", { town: 2 });
  if (producers) {
    place("mill-priv", "mill", { priv: 2 });
    place("bakery-priv", "bakery", { priv: 2 });
  }
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  const street = state.buildings.find(b => b.id === "commercial_street");
  const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
  assert.ok(opened.ok, opened.reason);
  if (settledStore) state.shops[opened.shopId].openedDay -= CONTENT.rules.openingPeriodDays + 1;
  simulation.configureShopClerks(state, opened.shopId, 3);
  transferVouchers(state, "town", `shop:${opened.shopId}`, 20000 * V, CONTENT, "t", "t");
  simulation.setEmployment(state, `wholesale_market::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  return { state, shopId: opened.shopId };
}

// 逐日推进，记录店内面包当日销量（斤）与当日开盘时批发市场面包库存（斤）。
// feed(day, state) 可在每日开始前向批发市场注入面包（模拟供货节奏）。
function runDays(state, shopId, days, feed = () => {}) {
  const shop = () => state.shops[shopId];
  const rows = [];
  let soldBefore = 0;
  let customersBefore = 0;
  for (let d = 0; d < days; d++) {
    feed(d, state);
    const wholesaleAtOpenJin = (state.wholesaleMarket?.inventory?.bread || 0) / I;
    simulation.advanceDay(state);
    const sold = shop().accounts.cumulative.soldUnits.bread || 0;
    const customers = shop().accounts.cumulative.customerCount || 0;
    rows.push({ day: d, soldJin: (sold - soldBefore) / I, wholesaleAtOpenJin, customers: customers - customersBefore });
    soldBefore = sold;
    customersBefore = customers;
  }
  return rows;
}

test("综合商店断货后次日补货：批发市场突然有 4000 斤面包，店铺不再爬坡数日", () => {
  const { state, shopId } = setupStore(91, { settledStore: true });
  // 第 0-6 日每日只到 60 斤面包（供货不足，店铺断货），第 7 日批发市场一次性到 4000 斤。
  const rows = runDays(state, shopId, 12, (d, s) => {
    if (d < 7) s.wholesaleMarket.inventory.bread = (s.wholesaleMarket.inventory.bread || 0) + 60 * I;
    if (d === 7) s.wholesaleMarket.inventory.bread = (s.wholesaleMarket.inventory.bread || 0) + 4000 * I;
  });
  // 店员 + 店主商人（店铺已过开张期，人数只在月初审核时变动，12 日内不变），每人每日接待 generalStoreCustomersPerStaff 户（客流按户计）。
  // 到货当天店铺就满客流上限、次日不变，不再逐日爬坡。
  const staff = jobCount(state, `shop:${shopId}:clerk`) + jobCount(state, `shop:${shopId}:merchant`);
  const customerCap = staff * CONTENT.rules.generalStoreCustomersPerStaff;
  assert.equal(rows[7].customers, customerCap, `day 7 customers ${rows[7].customers}, expected cap ${customerCap} on restock day`);
  assert.equal(rows[8].customers, customerCap, `day 8 customers ${rows[8].customers}, expected cap ${customerCap} the day after restock`);
  assert.ok(rows[7].soldJin > 0, "day 7 store should sell on the restock day");
  assert.ok(rows[7].soldJin >= 0.9 * rows[8].soldJin, `day 7 sold ${rows[7].soldJin} jin, should not ramp up to day 8 (${rows[8].soldJin} jin)`);
  // 批发市场开门时有货的日子，店内不应出现零销售。
  for (const row of rows.slice(7)) {
    if (row.wholesaleAtOpenJin > 0) assert.ok(row.soldJin > 0, `day ${row.day} store sold nothing while wholesale held ${row.wholesaleAtOpenJin} jin`);
  }
});

test("综合商店进货口径修复后，30 日利润不低于修复前基线（S2：私营磨坊+面包房）", () => {
  const { state, shopId } = setupStore(91, { producers: true });
  runDays(state, shopId, 30);
  const shop = state.shops[shopId];
  // 基线：原修复前 10140 券（旧宽裕度口径）。宽裕度重做后居民头几天花得慢，同一场景 30 日利润为 9916，下限重标为 9900。
  // 本场景没有肉卖家，没买到的肉算回面粉面包，利润不受肉份额影响。
  const profit = shop.accounts.cumulative.profitVoucherUnits / V;
  assert.ok(profit >= 9900, `store profit ${profit} below re-baselined floor 9900`);
  assert.equal(shop.status, "open");
  assert.equal(simulation.validateState(state).valid, true);
});
