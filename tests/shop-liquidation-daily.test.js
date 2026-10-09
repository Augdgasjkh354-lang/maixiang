import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdIdleWorkers, householdList } from "../src/systems/households.js";
import { prepareShopsForDay, finishShopsDay } from "../src/systems/shops.js";
import { transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;

function valid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
  assert.equal(simulation.validateCurrencyInvariant(state).valid, true, `${label} 货币账不平`);
}

function freePlot(state) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => !row.feature && !used.has(row.id));
  assert.ok(plot, "需要空地");
  return plot;
}

function addBuilding(state, typeId, id) {
  const plot = freePlot(state);
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return id;
}

function shopOwner(state, amount = 3000) {
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.ok(owner, "需要一户有空闲劳力的店主");
  assert.equal(grantResidentVouchers(state, amount, CONTENT, owner.id).ok, true);
  return owner;
}

function debtTotal(shop) {
  return (shop.liabilities.wageVoucherUnits || 0) + (shop.liabilities.rentVoucherUnits || 0)
    + (shop.liabilities.taxVoucherUnits || 0) + Object.values(shop.liabilities.pendingByMonth || {})
      .reduce((sum, row) => sum + Object.values(row || {}).reduce((s, v) => s + (v || 0), 0), 0);
}

// 一家商业街盐店：店主、1 名店员，现金抽干、货留在店里，停业时欠薪和租金付不出，清算必然留有负债。
function liquidatingSaltShop(seed) {
  const state = legacyVoucherState({ seed });
  // 基线清理：换券额度固定为旧默认 2 斤，避免新默认值改变工资与租金口径。
  state.policy.employmentExchangeJin = 2;
  const street = addBuilding(state, "commercial_street", "liq-street");
  const owner = shopOwner(state, 3000);
  const opened = simulation.openResidentShop(state, street, "salt", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(simulation.configureShopClerks(state, opened.shopId, 1).assigned, 1);
  const shop = state.shops[opened.shopId];
  shop.inventory.salt = 55 * I;
  if (shop.cashVoucherUnits > 0) {
    assert.equal(transferVouchers(state, `shop:${shop.id}`, `household:${owner.id}`, shop.cashVoucherUnits, CONTENT,
      "test_drain", "测试抽干店铺现金").ok, true);
  }
  prepareShopsForDay(state, CONTENT);
  assert.equal(simulation.closeResidentShop(state, shop.id).ok, true);
  assert.equal(shop.status, "liquidating");
  assert.ok(debtTotal(shop) > 0, "清算时应有付不出的负债");
  return { state, shop, owner };
}

// 计时口径沿用 closeShop：停业当天的日结记为第 0 天，第 30 天的日结满 30 天即核销。
test("清算中的店铺：日结每天推进，未满 30 天仍清算中，满 30 天仍欠账则核销并关门", () => {
  const { state, shop } = liquidatingSaltShop(120401);
  const debtAtClose = debtTotal(shop);
  for (let day = 1; day <= 30; day += 1) simulation.advanceDay(state);
  assert.equal(shop.status, "liquidating", "未满 30 天应仍在清算中");
  assert.equal(debtTotal(shop) > 0, true, "未满 30 天不应核销负债");
  assert.ok(debtTotal(shop) <= debtAtClose, "负债只能减少或不变，不能凭空增加");
  simulation.advanceDay(state);
  assert.equal(shop.status, "closed", "满 30 天仍欠账应核销关门（不能永久僵死）");
  assert.equal(debtTotal(shop), 0, "核销后负债为 0");
  assert.equal(shop.liabilities.wageVoucherUnits, 0);
  assert.equal(shop.liabilities.rentVoucherUnits, 0);
  assert.equal(shop.liabilities.taxVoucherUnits, 0);
  assert.equal(shop.statusReason, "清算完成，已停业");
  assert.ok(state.events.some(e => /清算\d+天仍资不抵债.*坏账核销/.test(String(e.text)) && String(e.text).includes(shop.name)), "应记录坏账核销事件");
  valid(state, "核销关门后");
  for (let day = 0; day < 5; day += 1) simulation.advanceDay(state);
  assert.equal(shop.status, "closed", "关门后不再变动");
  valid(state, "关门后再推进");
});

test("清算核销关门时，店内剩余货物按 closeShop 规则返还业主", () => {
  const { state, shop, owner } = liquidatingSaltShop(120402);
  const ownerSaltBefore = owner.inventory.salt || 0;
  // 直接跑店铺结账步骤（不经过其他系统的居民消耗），只看店铺自身的推进与返还。
  for (let day = 0; day < 31; day += 1) {
    state.day += 1;
    finishShopsDay(state, CONTENT);
  }
  assert.equal(shop.status, "closed");
  assert.equal(shop.inventory.salt || 0, 0, "店内货物应已返还");
  assert.equal(owner.inventory.salt, ownerSaltBefore + 55 * I, "货物返还业主家庭");
  valid(state, "返还货物后");
});

test("清算中途业主补资还清，正常关门，不再等 30 天核销", () => {
  const { state, shop, owner } = liquidatingSaltShop(120403);
  for (let day = 0; day < 10; day += 1) simulation.advanceDay(state);
  assert.equal(shop.status, "liquidating");
  assert.equal(grantResidentVouchers(state, 100, CONTENT, owner.id).ok, true);
  const ownerSaltBefore = owner.inventory.salt || 0;
  const funded = simulation.fundResidentShopLiquidation(state, shop.id);
  assert.equal(funded.ok, true, funded.reason);
  assert.equal(funded.liquidationPending, false);
  assert.equal(shop.status, "closed");
  assert.equal(debtTotal(shop), 0);
  assert.equal(owner.inventory.salt, ownerSaltBefore + 55 * I, "还清后货物返还业主");
  valid(state, "补资还清后");
  for (let day = 0; day < 31; day += 1) simulation.advanceDay(state);
  assert.equal(shop.status, "closed");
  assert.equal(shop.inventory.salt || 0, 0, "关门后店内货物不再变动");
  valid(state, "关门后长期推进");
});

test("旧档清算店铺没有 liquidatingSinceSerial：从读到的那天起重新计 30 天，不会立刻核销", () => {
  const { state, shop } = liquidatingSaltShop(120404);
  delete shop.liquidatingSinceSerial;
  simulation.advanceDay(state);
  assert.equal(shop.status, "liquidating", "旧档不能因缺少起算日而立即核销");
  assert.equal(Number.isFinite(shop.liquidatingSinceSerial), true, "应补上起算日");
  valid(state, "旧档补起算日后");
});
