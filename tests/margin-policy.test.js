// 利润率政策：综合商店全局默认与单店覆盖、改目标平滑过渡、贸易行门槛随政策变化。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { shopTradePrices } from "../src/economy/operating-plan.js";
import { ensureShopPricing, reviewShopPricing, selectShopPricingView, shopTargetMarginPercent } from "../src/systems/shop-pricing.js";
import { glideStepMarginPercent, policyShopMarginPercent, policyTradeMarginPercent, shopConfiguredMarginPercent } from "../src/economy/margin-policy.js";
import { tradeMarginTarget } from "../src/systems/trading-houses.js";
import { selectTradeHouseView } from "../src/selectors/trade-houses.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

// 与 price-adjust.test.js 的 town() 同口径：银行、批发市场、商业街，开一家综合商店（可先设全局政策再开店）。
function town(seed, policyPercent = null) {
  const state = simulation.createInitialState({ seed });
  if (policyPercent !== null) assert.equal(simulation.setMarginPolicy(state, { shopMarginPercent: policyPercent }).ok, true);
  const plots = state.plots.filter(p => !p.feature);
  let n = 0;
  const add = typeId => {
    const p = plots[n++];
    const id = `${typeId}-t`;
    state.buildings.push({ id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: p.id, x: p.x, y: p.y, materialInvestments: [], completed: { year: 1, day: 1 } });
    return id;
  };
  add("bank");
  const market = add("wholesale_market");
  const street = add("commercial_street");
  simulation.setEmployment(state, `${market}::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  grantResidentVouchers(state, 300000);
  const store = simulation.openResidentShop(state, street, "general");
  assert.equal(store.ok, true, store.reason);
  issueTownVouchers(state, 5000 * V, CONTENT, "测试");
  transferVouchers(state, "town", `shop:${store.shopId}`, 5000 * V, CONTENT, "test", "测试商店资金");
  simulation.configureShopClerks(state, store.shopId, 0);
  const shop = state.shops[store.shopId];
  shop.inventory.flour = 0; // 无库存信号，物价系数保持 1，便于只观察利润率的影响
  assert.equal(simulation.configureWholesalePrice(state, "flour", 2).ok, true);
  return { state, shopId: store.shopId, shop };
}

function flourRetail(state, shop) {
  return shopTradePrices(state, "general", CONTENT, "flour", shop).retailVoucherPerUnit;
}

test("利润率政策默认值：综合商店 20%、贸易出口 20%、进口 25%，与 rules 开局默认一致", () => {
  const state = simulation.createInitialState({ seed: 4101 });
  assert.equal(state.policy.shopMarginPercent, 20);
  assert.equal(state.policy.tradeMarginPercent, 20);
  assert.equal(state.policy.tradeImportMarginPercent, 25);
  assert.equal(CONTENT.rules.tradeHouseTargetMarginPercent, 20);
  assert.equal(CONTENT.rules.tradeHouseImportMarginPercent, 25);
  assert.equal(policyShopMarginPercent(state, CONTENT), 20);
  valid(state);
});

test("setMarginPolicy：0—200 有限数，保留一位小数；越界、非数、空串、null 拒绝且不写入", () => {
  const state = simulation.createInitialState({ seed: 4102 });
  for (const bad of [-0.1, 200.1, NaN, Infinity, "abc", "", "  ", null]) {
    const result = simulation.setMarginPolicy(state, { shopMarginPercent: bad });
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
    assert.equal(typeof result.reason, "string");
  }
  assert.equal(state.policy.shopMarginPercent, 20, "拒绝时不改政策");
  assert.equal(simulation.setMarginPolicy(state, { shopMarginPercent: 200 }).ok, true);
  assert.equal(state.policy.shopMarginPercent, 200);
  assert.equal(simulation.setMarginPolicy(state, { shopMarginPercent: 0 }).ok, true);
  assert.equal(simulation.setMarginPolicy(state, { tradeMarginPercent: 12.34 }).value.tradeMarginPercent, 12.3);
  assert.equal(state.policy.tradeMarginPercent, 12.3);
  valid(state);
});

test("新开的综合商店跟随全局默认：开店前设的 40% 直接生效，价格 = 进货价 × 1.4", () => {
  const { state, shop } = town(4103, 40);
  assert.equal(shopTargetMarginPercent(state, shop, CONTENT), 40);
  assert.ok(Math.abs(flourRetail(state, shop) - 2.8) < 1e-9, "2 × 1.4");
  valid(state);
});

test("glideStepMarginPercent：目标每次最多按价格 ±10% 追赶，到达即止", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  close(glideStepMarginPercent(20, 50, 10), 32); // 1.2 × 1.1 = 1.32
  close(glideStepMarginPercent(20, 0, 10), 8); // 1.2 × 0.9 = 1.08
  close(glideStepMarginPercent(0, 50, 10), 10);
  close(glideStepMarginPercent(20, 21, 10), 21);
  close(glideStepMarginPercent(20, 20, 10), 20);
});

test("改全局利润率不跳价：改当场价格不变，之后每次复核价格最多 ±10%，分步追平后清除过渡记录", () => {
  const { state, shop } = town(4104);
  assert.ok(Math.abs(flourRetail(state, shop) - 2.4) < 1e-9, "默认 20%：2 × 1.2");
  assert.equal(simulation.setMarginPolicy(state, { shopMarginPercent: 50 }).ok, true);
  assert.ok(Math.abs(flourRetail(state, shop) - 2.4) < 1e-9, "改目标当场不跳价");
  assert.equal(selectShopPricingView(state, shop, CONTENT).gliding, true);
  let previous = flourRetail(state, shop);
  let steps = 0;
  for (let i = 0; i < 12 && shop.pricing.glidePercent !== undefined; i += 1) {
    assert.equal(reviewShopPricing(state, shop, CONTENT, { force: true }).reviewed, true);
    const now = flourRetail(state, shop);
    assert.ok(now >= previous - 1e-9, `价格不应回落：${previous} → ${now}`);
    assert.ok(now <= previous * 1.1 + 1e-9, `单次涨幅 ≤10%：${previous} → ${now}`);
    previous = now;
    steps += 1;
  }
  assert.ok(steps >= 3, `应分步追上，实际 ${steps} 步`);
  assert.equal(shop.pricing.glidePercent, undefined, "追平后清除过渡记录");
  assert.ok(Math.abs(flourRetail(state, shop) - 3) < 1e-9, "最终 2 × 1.5 = 3");
  assert.equal(selectShopPricingView(state, shop, CONTENT).gliding, false);
  valid(state);
});

test("单店覆盖优先于全局：设过单店的店不随全局变；改回跟随后再随全局", () => {
  const { state, shopId, shop } = town(4105);
  assert.equal(simulation.configureShopTargetMargin(state, shopId, 30).ok, true);
  assert.equal(simulation.setMarginPolicy(state, { shopMarginPercent: 60 }).ok, true);
  for (let i = 0; i < 10; i += 1) reviewShopPricing(state, shop, CONTENT, { force: true });
  assert.equal(shopTargetMarginPercent(state, shop, CONTENT), 30, "单店 30% 不随全局 60% 变");
  let view = selectShopPricingView(state, shop, CONTENT);
  assert.equal(view.followsPolicy, false);
  assert.equal(view.configuredTargetMarginPercent, 30);
  assert.equal(view.policyMarginPercent, 60);

  assert.equal(simulation.configureShopTargetMargin(state, shopId, null).ok, true, "取消单店设置");
  for (let i = 0; i < 12 && shop.pricing.glidePercent !== undefined; i += 1) reviewShopPricing(state, shop, CONTENT, { force: true });
  assert.equal(shopTargetMarginPercent(state, shop, CONTENT), 60, "改回跟随后追上全局 60%");
  view = selectShopPricingView(state, shop, CONTENT);
  assert.equal(view.followsPolicy, true);
  assert.equal(view.configuredTargetMarginPercent, 60);
  valid(state);
});

test("单店目标利润率范围 0—200，越界拒绝", () => {
  const { state, shopId } = town(4106);
  assert.equal(simulation.configureShopTargetMargin(state, shopId, 200).ok, true);
  assert.equal(simulation.configureShopTargetMargin(state, shopId, 201).ok, false);
  assert.equal(simulation.configureShopTargetMargin(state, shopId, -1).ok, false);
});

test("旧档兼容：烘焙的默认 20 视为跟随全局；其他值视为单店设定", () => {
  const { state, shop } = town(4107);
  shop.pricing.targetMarginPercent = 20;
  delete shop.pricing.targetMarginOwn;
  assert.equal(shopConfiguredMarginPercent(state, shop, CONTENT), 20);
  state.policy.shopMarginPercent = 45;
  assert.equal(shopConfiguredMarginPercent(state, shop, CONTENT), 45, "跟随全局");
  shop.pricing.targetMarginPercent = 35;
  delete shop.pricing.targetMarginOwn;
  assert.equal(shopConfiguredMarginPercent(state, shop, CONTENT), 35, "旧档的非默认值是单店设定");
  // 旧存档里 policy 没有利润率字段：回落到开局默认。
  delete state.policy.shopMarginPercent;
  delete shop.pricing.targetMarginPercent;
  assert.equal(policyShopMarginPercent(state, CONTENT), 20);
  ensureShopPricing(shop, CONTENT);
  valid(state);
});

test("贸易行利润门槛随政策变化：出口默认 20%（乘数 1.2），调成 10% 后放宽；进口默认 25%", () => {
  const state = simulation.createInitialState({ seed: 4108 });
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  close(tradeMarginTarget(state, CONTENT, "export"), 1.2);
  close(tradeMarginTarget(state, CONTENT, "import"), 1.25);
  assert.equal(selectTradeHouseView(state, CONTENT).targetMarginPercent, 20);
  assert.equal(simulation.setMarginPolicy(state, { tradeMarginPercent: 10 }).ok, true);
  close(tradeMarginTarget(state, CONTENT, "export"), 1.1);
  assert.equal(selectTradeHouseView(state, CONTENT).targetMarginPercent, 10);
  assert.equal(simulation.setMarginPolicy(state, { tradeImportMarginPercent: 40 }).ok, true);
  close(tradeMarginTarget(state, CONTENT, "import"), 1.4);
  assert.equal(policyTradeMarginPercent(state, CONTENT, "import"), 40);
  assert.equal(selectTradeHouseView(state, CONTENT).importMarginPercent, 40);
  valid(state);
});
