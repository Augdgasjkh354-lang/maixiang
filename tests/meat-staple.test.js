import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers, setResidentInventoryJin } from "./helpers-v16.js";
import { householdList, householdPopulation, householdIdleWorkers, setJobCount } from "../src/systems/households.js";
import { buyStaplesForResidents, meatStapleShare, updateMeatHabit } from "../src/systems/market.js";
import { planDailyFoodConsumption } from "../src/systems/consumption.js";
import { buyWholesaleForOwner, ensureWholesaleMarket } from "../src/systems/wholesale-market.js";
import { stallItemIds } from "../src/systems/shops.js";
import { shopTradePrices } from "../src/economy/operating-plan.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const Q = CONTENT.precision.qeqUnitsPerJin;
const MEATS = ["chicken", "duck", "goose", "pork"];
const MEAT_WEIGHT_TOTAL = 4 + 3 + 2 + 8;

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

// 与 livestock-stalls.test.js 同一建镇写法：银行、批发市场、商业街、养殖基地、时代广场。
function town(seed, { square = true, store: withStore = true } = {}) {
  const state = simulation.createInitialState({ seed });
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
  const base = add("livestock_base");
  const plaza = square ? add("times_square") : null;
  simulation.setEmployment(state, `${market}::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  assert.equal(simulation.startCurrencyReform(state).ok, true);
  grantResidentVouchers(state, 300000);
  if (!withStore) return { state, street, base, plaza, storeId: null };
  const store = simulation.openResidentShop(state, street, "general");
  assert.equal(store.ok, true, store.reason);
  issueTownVouchers(state, 5000 * V, CONTENT, "测试");
  transferVouchers(state, "town", `shop:${store.shopId}`, 5000 * V, CONTENT, "test", "测试商店资金");
  simulation.configureShopClerks(state, store.shopId, 10);
  return { state, street, base, plaza, storeId: store.shopId };
}

// 主食单元测试夹具：粮券阶段、一间综合商店（可选带肉）、居民库存清空。
function voucherState() {
  const state = simulation.createInitialState();
  state.monetaryReform = {
    stage: "voucher", targetVoucherBps: 10000, residentExchangeEnabled: true, legacyBankAccess: true,
    started: null, completed: { legacy: true }, paymentHistory: [], voucherShortfallByKey: {}
  };
  return state;
}

function withGeneralStore(state, stock = {}) {
  const owner = householdList(state)[0];
  state.shops = {
    "shop-test": {
      id: "shop-test", name: "测试综合商店", buildingId: "street-test", typeId: "general",
      primaryItemId: "wheat", itemId: "wheat", itemIds: ["wheat", "flour", "bread", "salt", ...MEATS],
      ownerHouseholdId: owner.id, cashVoucherUnits: 0, cashWheatUnits: 0,
      inventory: { wheat: 0, flour: 0, bread: 0, salt: 0, wood: 0, chicken: 0, duck: 0, goose: 0, pork: 0, ...stock },
      inventoryCostVoucherUnits: {}, status: "open", statusReason: "准备营业",
      accounts: { day: { soldUnits: {} }, year: { soldUnits: {} }, cumulative: { soldUnits: {} } },
      liabilities: {}, settlement: {}, retainedEarningsVoucherUnits: 0
    }
  };
  owner.jobs ||= {};
  owner.jobs["shop:shop-test:merchant"] = 1;
  setJobCount(state, "shop:shop-test:clerk", 40, CONTENT);
  return state;
}

function clearStaples(state) {
  for (const itemId of ["wheat", "flour", "bread", ...MEATS]) setResidentInventoryJin(state, itemId, 0, CONTENT);
}

function people(state) {
  return Object.values(state.households.byId).reduce((sum, h) => sum + householdPopulation(h), 0);
}

function rowsOf(state, population = 250) {
  return Object.fromEntries(buyStaplesForResidents(state, population, CONTENT).staples.rows.map(row => [row.itemId, row]));
}

test("宽裕度 1/2/3 时肉占口粮约 5%/27%/75%，宽裕度 0 时没有肉", () => {
  assert.ok(Math.abs(meatStapleShare(1, CONTENT) - 0.05) < 0.005, `宽裕度 1: ${meatStapleShare(1, CONTENT)}`);
  assert.ok(Math.abs(meatStapleShare(2, CONTENT) - 0.27) < 0.005, `宽裕度 2: ${meatStapleShare(2, CONTENT)}`);
  assert.ok(Math.abs(meatStapleShare(3, CONTENT) - 0.75) < 1e-9, `宽裕度 3: ${meatStapleShare(3, CONTENT)}`);
  assert.equal(meatStapleShare(0, CONTENT), 0);
  // 封顶：宽裕度超过 maxAffluence 也只有 maxShare。
  assert.ok(Math.abs(meatStapleShare(10, CONTENT) - CONTENT.rules.meatStaple.maxShare) < 1e-9);
});

test("宽裕人家买主食先买肉（按鸡鸭鹅猪权重分），有肉时面粉只买标准部分", () => {
  const population = 250;
  const state = withGeneralStore(voucherState(), { wheat: 3000 * I, flour: 3000 * I, bread: 3000 * I, pork: 3000 * I, chicken: 3000 * I, duck: 3000 * I, goose: 3000 * I });
  grantResidentVouchers(state, 10000000, CONTENT);
  clearStaples(state);
  const need = people(state) * CONTENT.rules.foodPerPersonDay;
  const rows = rowsOf(state, population);
  const meatTarget = MEATS.reduce((sum, itemId) => sum + rows[itemId].targetQeqJin, 0);
  assert.ok(Math.abs(meatTarget - need * 0.75) < 2, `肉目标 ${meatTarget} 应为口粮 75%`);
  // 猪的权重最大（8/17），先买到，购买量按 2 斤口粮 = 1 斤肉折算。
  assert.ok(Math.abs(rows.pork.targetQeqJin / meatTarget - 8 / MEAT_WEIGHT_TOTAL) < 0.001, "猪肉按权重 8 分到");
  for (const itemId of MEATS) assert.ok(rows[itemId].purchasedJin > 0, `${itemId} 应买到`);
  // 肉都买到了，就不再有缺口转面粉：面粉目标只剩标准部分（约 0.075 × 口粮）。
  assert.ok(rows.flour.targetQeqJin < need * 0.1, `面粉目标 ${rows.flour.targetQeqJin} 不应含肉的缺口`);
});

test("没有肉（无养殖场、无卖家）时，没买到的肉算回其余口粮，面粉面包按正常比例买", () => {
  const state = withGeneralStore(voucherState(), { wheat: 3000 * I, flour: 3000 * I, bread: 3000 * I });
  grantResidentVouchers(state, 10000000, CONTENT);
  clearStaples(state);
  const need = people(state) * CONTENT.rules.foodPerPersonDay;
  const rows = rowsOf(state);
  for (const itemId of MEATS) assert.equal(rows[itemId].purchasedJin, 0, `${itemId} 无卖家不应购买`);
  const meatTarget = MEATS.reduce((sum, itemId) => sum + rows[itemId].targetQeqJin, 0);
  assert.ok(meatTarget > need * 0.5, `宽裕人家肉目标 ${meatTarget} 应占口粮大头`);
  // 宽裕度封顶：面包、面粉各按全部口粮的 0.2 × 1.5，与没有肉这一项时一样。
  assert.ok(Math.abs(rows.bread.targetQeqJin - need * 0.3) < 1, `面包目标 ${rows.bread.targetQeqJin}`);
  assert.ok(Math.abs(rows.flour.targetQeqJin - need * 0.3) < 1, `面粉目标 ${rows.flour.targetQeqJin}`);
  assert.ok(rows.bread.purchasedJin > 0 && rows.flour.purchasedJin > 0, "面粉面包有库存，应买到");
  assert.ok(rows.wheat.targetQeqJin > 0, "其余口粮买小麦");
});

test("家里有肉时每日口粮先吃肉，1 斤肉抵 2 斤口粮", () => {
  const demand = 2 * Q; // 2 斤口粮（qeq 单位）
  const plan = planDailyFoodConsumption({ pork: 1 * I, wheat: 10 * I }, demand, CONTENT);
  const pork = plan.moves.find(move => move.itemId === "pork");
  const wheat = plan.moves.find(move => move.itemId === "wheat");
  assert.ok(pork, "应吃猪肉");
  assert.equal(pork.quantityUnits, 1 * I, "吃掉 1 斤猪肉");
  assert.equal(pork.qeqUnits, 2 * Q, "1 斤猪肉抵 2 斤口粮");
  assert.ok(!wheat || wheat.quantityUnits === 0, "肉够了就不动小麦");
  assert.equal(plan.remainingQeqUnits, 0, "口粮已满足");
  // 肉不够时肉先吃完，剩下的才吃小麦。
  const short = planDailyFoodConsumption({ pork: 0.5 * I, wheat: 10 * I }, demand, CONTENT);
  const eatenPork = short.moves.find(move => move.itemId === "pork");
  assert.equal(eatenPork.quantityUnits, 0.5 * I, "肉先吃完");
  assert.ok(short.moves.some(move => move.itemId === "wheat" && move.qeqUnits > 0), "剩下的吃小麦");
});

test("吃肉习惯平滑：宽裕度从 3 突降到 0.2，一天内 meatHabit 只下降约 1/90 的差", () => {
  const household = { id: "h-habit", inventory: {} };
  assert.equal(updateMeatHabit(household, 3, CONTENT), 3, "没有记录时从当天宽裕度起步");
  const before = household.meatHabit;
  const after = updateMeatHabit(household, 0.2, CONTENT);
  const days = CONTENT.rules.meatStaple.habitDays;
  assert.ok(Math.abs((before - after) - (3 - 0.2) / days) < 0.001, `一天降幅 ${before - after}，应约为 ${(3 - 0.2) / days}`);
  assert.ok(after > 2.9 && after < 3, `习惯仍接近 3，实际 ${after}`);
  // 习惯缓慢变化，肉份额随之缓慢变化（仍远高于仅看当天宽裕度的 0.2 对应份额）。
  assert.ok(meatStapleShare(after, CONTENT) > meatStapleShare(0.2, CONTENT));
});

test("集市也卖肉：没有综合商店时，肉直接从养殖场进集市并卖出", () => {
  const { state, base } = town(6201, { store: false });
  state.wholesaleMarket.inventory.wine = 50000 * I;
  state.wholesaleMarket.inventory.cloth = 500 * I;
  assert.equal(simulation.setStallKeeperLimit(state, 6).ok, true);
  const farm = simulation.openResidentShop(state, base, "pig_farm").shopId;
  simulation.advanceDays(state, 40);
  const market = Object.values(state.shops).find(s => s.typeId === "stall" && s.collective);
  assert.ok(market, "有集体集市");
  assert.ok((market.accounts.cumulative.purchasedUnits?.pork || 0) > 0, "集市从养殖场进了猪肉");
  assert.ok((market.accounts.cumulative.soldUnits?.pork || 0) > 0, "集市卖出了猪肉");
  // 养殖场卖出的肉全部进了集市（本场景只有集市一个买家）。
  assert.equal(state.shops[farm].accounts.cumulative.storeSoldUnits?.pork, market.accounts.cumulative.purchasedUnits.pork, "养殖场出货 = 集市进货");
  valid(state);
});

test("集市商品是四种肉加日用品（不卖面粉面包盐），猪肉售价与综合商店相同", () => {
  const { state, base, storeId } = town(6202, { square: true });
  simulation.openResidentShop(state, base, "pig_farm");
  simulation.advanceDays(state, 2);
  const items = stallItemIds(CONTENT);
  for (const itemId of MEATS) assert.ok(items.includes(itemId), `集市应卖${itemId}`);
  for (const itemId of ["flour", "bread", "salt"]) assert.ok(!items.includes(itemId), `集市不卖${itemId}`);
  const market = Object.values(state.shops).find(s => s.typeId === "stall" && s.collective);
  const stallPrice = shopTradePrices(state, "stall", CONTENT, "pork", market).retailVoucherPerUnit;
  const storePrice = shopTradePrices(state, "general", CONTENT, "pork", state.shops[storeId]).retailVoucherPerUnit;
  assert.ok(Math.abs(stallPrice - storePrice) < 1e-9, `集市猪肉价 ${stallPrice} 应等于商店价 ${storePrice}`);
  valid(state);
});

test("批发市场卖小麦给非镇营买方时，镇库小麦不低于 60 天全镇口粮", () => {
  const { state } = town(6202, { square: false });
  const reserveUnits = Math.round(people(state) * CONTENT.rules.foodPerPersonDay * CONTENT.rules.townWheatSaleReserveDays * I);
  // 镇库存量只比底线多 5000 斤；买方要 10 万斤，只能买到 5000 斤。
  state.accounts.town.wheat = reserveUnits + 5000 * I;
  assert.ok(ensureWholesaleMarket(state, CONTENT), "有批发市场");
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 500000, CONTENT, owner.id).ok, true);
  const result = buyWholesaleForOwner(state, `household:${owner.id}`, "wheat", 100000 * I, CONTENT, "测试：养殖场饲料");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.boughtUnits, 5000 * I, "只卖出底线以上的 5000 斤");
  assert.ok(state.accounts.town.wheat >= reserveUnits, `镇库小麦 ${state.accounts.town.wheat} 不应低于底线 ${reserveUnits}`);
  valid(state);
});
