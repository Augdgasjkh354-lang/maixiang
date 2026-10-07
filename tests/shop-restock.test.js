import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdList, householdIdleWorkers } from "../src/systems/households.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { transferVouchers } from "../src/economy/currency.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

// 历史 bug：综合商店的进货目标只看"过去销量"。断货时实际卖出的量被库存截断，
// 居民真正想买而没买到的面包从不进入口径，于是进货目标被压在低位。
// 例：批发市场突然来了 4000 斤面包，店里却要 6 天才从 120 斤爬到接待上限约 480 斤/日，
// 期间居民想买的面包大量落空，批发市场的面包也一直堆着。
// 修复后：断货的未满足需求计入进货口径，次日即按需求补货。

function setupStore(seed, { producers = false } = {}) {
  const state = simulation.createInitialState({ seed });
  grantResidentVouchers(state, 300000, CONTENT);
  simulation.issueGrainVouchers(state, "town", 200000);
  const freePlot = feature => state.plots.find(p => (feature ? p.feature === feature : !p.feature) && !state.buildings.some(b => b.plotId === p.id));
  const place = (id, typeId, { town = 0, priv = 0 }) => {
    const plot = freePlot(CONTENT.buildings[typeId].requiredPlotFeature || null);
    assert.ok(plot, `no plot for ${typeId}`);
    state.buildings.push({ id, typeId, level: 2, ownership: { townLevels: town, privateLevels: priv, listedLevels: 0 },
      plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
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
  for (let d = 0; d < days; d++) {
    feed(d, state);
    const wholesaleAtOpenJin = (state.wholesaleMarket?.inventory?.bread || 0) / I;
    simulation.advanceDay(state);
    const sold = shop().accounts.cumulative.soldUnits.bread || 0;
    rows.push({ day: d, soldJin: (sold - soldBefore) / I, wholesaleAtOpenJin });
    soldBefore = sold;
  }
  return rows;
}

test("综合商店断货后次日补货：批发市场突然有 4000 斤面包，店铺不再爬坡数日", () => {
  const { state, shopId } = setupStore(91);
  // 第 0-6 日每日只到 60 斤面包（供货不足，店铺断货），第 7 日批发市场一次性到 4000 斤。
  const rows = runDays(state, shopId, 12, (d, s) => {
    if (d < 7) s.wholesaleMarket.inventory.bread = (s.wholesaleMarket.inventory.bread || 0) + 60 * I;
    if (d === 7) s.wholesaleMarket.inventory.bread = (s.wholesaleMarket.inventory.bread || 0) + 4000 * I;
  });
  // 第 7 日到货后，第 8 日（次日）店铺就应按居民需求放量，第 9 日接近接待上限（约 480 斤/日）。
  // 修复前：第 8 日 154 斤、第 9 日 198 斤，之后每日只增 40-70 斤，第 13 日才达到上限。
  assert.ok(rows[8].soldJin >= 300, `day 8 bread sold ${rows[8].soldJin} jin, expected >= 300 (restock should follow the unmet demand next day)`);
  assert.ok(rows[9].soldJin >= 400, `day 9 bread sold ${rows[9].soldJin} jin, expected >= 400`);
  // 批发市场有货时，店内不应出现零销售日。
  for (const row of rows.slice(7)) {
    assert.ok(row.soldJin > 0, `day ${row.day} store sold nothing while wholesale held ${row.wholesaleAtOpenJin} jin`);
  }
});

test("综合商店进货口径修复后，30 日利润不低于修复前基线（S2：私营磨坊+面包房）", () => {
  const { state, shopId } = setupStore(91, { producers: true });
  runDays(state, shopId, 30);
  const shop = state.shops[shopId];
  // 修复前基线（同场景 30 日，修复前代码）：店铺利润 10140 券，面包售出 18199 斤，拒客 7744 人次。
  // 修复后多卖出的面包毛利为正，定价、租金与税规则不变，利润只能持平或更高。
  const profit = shop.accounts.cumulative.profitVoucherUnits / V;
  assert.ok(profit >= 10140 - 1, `store profit ${profit} below pre-fix baseline 10140`);
  assert.equal(shop.status, "open");
  assert.equal(simulation.validateState(state).valid, true);
});
