import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { manageStalls } from "../src/systems/stalls.js";
import { jobCount, setJobCount } from "../src/systems/households.js";
import { shopHostSlots } from "../src/systems/shops.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const PER_KEEPER_JIN = CONTENT.rules.shopTypes.stall.perKeeperSalesJin;

// 只搭一座带时代广场的镇子，直接调用 manageStalls，不跑日结。
function stallCase({ seed, keepers, soldJin = 0, profitVouchers = 0, limit = 1000, content = CONTENT }) {
  const state = simulation.createInitialState({ seed });
  const plot = state.plots.find(p => !p.feature);
  state.buildings.push({ id: "square-t", typeId: "times_square", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  const square = state.buildings.find(b => b.typeId === "times_square");
  state.policy.stallKeeperLimit = limit;
  manageStalls(state, content); // 第一次只负责开集体摊位
  const shop = Object.values(state.shops).find(s => s.collective && s.typeId === "stall" && s.status !== "closed");
  assert.ok(shop, "应开出集体摊位");
  const key = `shop:${shop.id}:merchant`;
  setJobCount(state, key, keepers, content, { type: "shop", id: shop.id });
  shop.history = Array.from({ length: 7 }, (_, i) => ({ serial: i + 1, soldUnits: soldJin * I, profitVoucherUnits: profitVouchers * V }));
  shop.plan ||= {};
  delete shop.plan.keeperAdjustedSerial; // 让本次调整立即生效
  const before = jobCount(state, key);
  manageStalls(state, content);
  const after = jobCount(state, key);
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
  return { state, square, shop, before, after };
}

test("利润高（人均远超目标）：人数增加，但单次不超过 20%", () => {
  const r = stallCase({ seed: 7101, keepers: 20, profitVouchers: 1000 });
  assert.equal(r.before, 20);
  assert.ok(r.after > 20, `应增员，实际 ${r.after}`);
  assert.ok(r.after <= 24, `单次增幅不超过 20%（上限 24），实际 ${r.after}`);
});

test("销量高、利润薄：人数由销量决定，利用率约 0.85", () => {
  // 10 人满载销售：所需人手 = ceil(10 / 0.85) = 12；利润 25 券/日只对应 1 人，不影响结果。
  const soldJin = 10 * PER_KEEPER_JIN;
  const r = stallCase({ seed: 7102, keepers: 10, soldJin, profitVouchers: 25 });
  assert.equal(r.after, 12, `应按销量升到 12 人，实际 ${r.after}`);
  const utilization = soldJin / (r.after * PER_KEEPER_JIN);
  assert.ok(Math.abs(utilization - 0.85) < 0.05, `利用率应约 0.85，实际 ${utilization.toFixed(3)}`);
});

test("亏损：减员 20%", () => {
  const r = stallCase({ seed: 7103, keepers: 10, profitVouchers: -50 });
  assert.equal(r.after, 8, `亏损应从 10 减到 8，实际 ${r.after}`);
});

test("偏差在 15% 以内不调；超出则调", () => {
  // 20 人：利润 611 券/日 → 目标 ceil 22（+10%），639 → 23（+15%），都不动。
  for (const profitVouchers of [611, 639]) {
    const r = stallCase({ seed: 7104 + profitVouchers, keepers: 20, profitVouchers });
    assert.equal(r.after, 20, `利润 ${profitVouchers} 券/日时偏差在 15% 内，不应调整，实际 ${r.after}`);
  }
  // 667 券/日 → 目标 24（+20%），超出 15%，调到 24。
  const moved = stallCase({ seed: 7120, keepers: 20, profitVouchers: 667 });
  assert.equal(moved.after, 24, `偏差超过 15% 应调整，实际 ${moved.after}`);
});

test("人数不超过允许摆摊人数，也不超过摊位数 × 2", () => {
  const limited = stallCase({ seed: 7130, keepers: 20, profitVouchers: 1000, limit: 22 });
  assert.equal(limited.after, 22, `允许人数 22 为上限，实际 ${limited.after}`);

  const probe = stallCase({ seed: 7131, keepers: 2, profitVouchers: 0 });
  const slotCap = shopHostSlots(probe.square, CONTENT) * 2;
  assert.ok(slotCap > 0, "时代广场应有摊位");
  const full = stallCase({ seed: 7132, keepers: slotCap, profitVouchers: 100000 });
  assert.ok(full.after <= slotCap, `不得超过摊位数×2（${slotCap}），实际 ${full.after}`);
  assert.equal(full.after, slotCap, "利润极高时应顶到摊位上限");
});

test("rules.stallTargetIncomeVoucher 缺省时回退 25 券", () => {
  // 20 人、利润 611 券/日：目标 25 券 → 22 人（+10%，不动）；若目标是 50 券 → 11 人，会减员到 16。
  const { stallTargetIncomeVoucher: _omit, ...rulesWithout } = CONTENT.rules;
  const noKey = { ...CONTENT, rules: rulesWithout };
  const fallback = stallCase({ seed: 7140, keepers: 20, profitVouchers: 611, content: noKey });
  assert.equal(fallback.after, 20, `缺省时应按 25 券判断，实际 ${fallback.after}`);

  const explicit50 = { ...CONTENT, rules: { ...CONTENT.rules, stallTargetIncomeVoucher: 50 } };
  const moved = stallCase({ seed: 7141, keepers: 20, profitVouchers: 611, content: explicit50 });
  assert.equal(moved.after, 16, `显式设为 50 券时应按 50 券判断，实际 ${moved.after}`);
});
