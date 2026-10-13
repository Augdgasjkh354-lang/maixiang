import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { addTownCostBasis } from "../src/economy/business.js";
import { prepareShopsForDay } from "../src/systems/shops.js";

const I = CONTENT.precision.inventoryUnitsPerJin;

// 两条商业街各开一家镇营综合商店，批发市场有一批面粉。规则：镇营店每日每种商品最多拿进货前批发库存的 supplyShareMax（0.5），
// 多家镇营店合计也不能超过这个份额（余下留给私营店）。
function twoTownStoresState(seed, flourJin = 20000) {
  const state = simulation.createInitialState({ seed });
  grantResidentVouchers(state, 300000, CONTENT);
  simulation.issueGrainVouchers(state, "town", 200000);
  const freePlot = feature => state.plots.find(p => (feature ? p.feature === feature : !p.feature) && !state.buildings.some(b => b.plotId === p.id));
  const place = (id, typeId) => {
    const plot = freePlot(CONTENT.buildings[typeId].requiredPlotFeature || null);
    assert.ok(plot, `no plot for ${typeId}`);
    state.buildings.push({ id, typeId, level: 3, ownership: { townLevels: 3, privateLevels: 0, listedLevels: 0 },
      plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  };
  place("wholesale_market", "wholesale_market");
  place("commercial_street", "commercial_street");
  place("commercial_street_b", "commercial_street");
  simulation.setEmployment(state, `wholesale_market::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  state.accounts.town.flour += flourJin * I;
  addTownCostBasis(state, "flour", flourJin * 1000);
  const moved = simulation.releaseWholesale(state, "flour", flourJin, CONTENT);
  assert.ok(moved.ok, moved.reason);
  const ids = [];
  for (const streetId of ["commercial_street", "commercial_street_b"]) {
    const opened = simulation.openTownShop(state, streetId);
    assert.ok(opened.ok, opened.reason);
    const set = simulation.configureShopClerks(state, opened.shopId, 20);
    assert.ok(set.ok, set.reason);
    ids.push(opened.shopId);
  }
  return { state, ids };
}

// 缺陷：两家镇营店按顺序进货，每家都按"当时"的批发库存取 50%，合计可以超过 50%（第二家拿到剩下的一半）。
test("多家镇营店同日进货合计不超过批发库存的供货份额", () => {
  const flourJin = 4000;
  const { state, ids } = twoTownStoresState(9201, flourJin);
  const before = state.wholesaleMarket.inventory.flour;
  assert.ok(before >= flourJin * I * 0.99, `开局面粉应在批发市场，实际 ${before}`);
  prepareShopsForDay(state, CONTENT);
  const taken = ids.reduce((sum, id) => sum + (state.shops[id].inventory.flour || 0), 0);
  const share = CONTENT.rules.townShop?.supplyShareMax ?? 0.5;
  assert.ok(taken > 0, "镇营店应当进到货");
  assert.ok(taken <= Math.floor(before * share) + 1, `合计 ${taken} 超过份额 ${Math.floor(before * share)}（批发前库存 ${before}）`);
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
});
