import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdList, householdIdleWorkers, jobCount } from "../src/systems/households.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { transferVouchers } from "../src/economy/currency.js";
import { addTownCostBasis } from "../src/economy/business.js";
import { shopDailyCustomerCapacity, shopsForStreet, succeedOrphanShops, closeShop, shopSummaries, prepareShopsForDay } from "../src/systems/shops.js";
import { socialEmployerForJobKey } from "../src/systems/social-security.js";
import { payDayFor } from "../src/systems/paydays.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const CAP_PER_STAFF = CONTENT.rules.generalStoreCustomersPerStaff || 20;
const CAP_MAX = CONTENT.rules.generalStoreMaxDailyCustomers || 1000;

// 镇子：批发市场 + 商业街（各 2 级）；市场里有镇库调拨入市的面粉。可选再开一家私营综合店。
function townState(seed, { flourJin = 5000, privateStore = false } = {}) {
  const state = simulation.createInitialState({ seed });
  grantResidentVouchers(state, 300000, CONTENT);
  simulation.issueGrainVouchers(state, "town", 200000);
  const freePlot = feature => state.plots.find(p => (feature ? p.feature === feature : !p.feature) && !state.buildings.some(b => b.plotId === p.id));
  const place = (id, typeId) => {
    const plot = freePlot(CONTENT.buildings[typeId].requiredPlotFeature || null);
    assert.ok(plot, `no plot for ${typeId}`);
    state.buildings.push({ id, typeId, level: 2, ownership: { townLevels: 2, privateLevels: 0, listedLevels: 0 },
      plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  };
  place("wholesale_market", "wholesale_market");
  place("commercial_street", "commercial_street");
  simulation.setEmployment(state, `wholesale_market::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 3);
  if (flourJin > 0) {
    state.accounts.town.flour += flourJin * I;
    // 给镇库面粉一笔成本基础（否则开局库存没有成本，成本守恒的断言没有意义）。
    addTownCostBasis(state, "flour", flourJin * 1000);
    const moved = simulation.releaseWholesale(state, "flour", flourJin, CONTENT);
    assert.ok(moved.ok, moved.reason);
  }
  const street = state.buildings.find(b => b.id === "commercial_street");
  let privateShopId = null;
  if (privateStore) {
    const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
    const opened = simulation.openResidentShop(state, street.id, "general", owner.id);
    assert.ok(opened.ok, opened.reason);
    privateShopId = opened.shopId;
    state.shops[privateShopId].openedDay -= CONTENT.rules.openingPeriodDays + 1;
    simulation.configureShopClerks(state, privateShopId, 3);
    transferVouchers(state, "town", `shop:${privateShopId}`, 20000 * V, CONTENT, "t", "t");
  }
  const opened = simulation.openTownShop(state, street.id);
  assert.ok(opened.ok, opened.reason);
  const shopId = opened.shopId;
  const set = simulation.configureShopClerks(state, shopId, 20);
  assert.ok(set.ok, set.reason);
  return { state, shopId, privateShopId, street };
}

// 检查最近的粮券流水与账本：没有镇库→镇库的付款，镇营店也没有自己的粮券流水（它没有钱包）。
function assertNoTownToTownPayments(state, shopId, label) {
  const bad = (state.currency?.ledger || []).filter(row => row.from === "town" && row.to === "town");
  assert.equal(bad.length, 0, `${label}：粮券流水出现镇库→镇库付款 ${bad.length} 笔`);
  const badLedger = (state.ledger || []).filter(row => row.source === "town" && row.destination === "town");
  assert.equal(badLedger.length, 0, `${label}：账本出现镇库→镇库记录 ${badLedger.length} 笔`);
  const ownAccount = (state.currency?.ledger || []).filter(row => row.from === `shop:${shopId}` || row.to === `shop:${shopId}`);
  assert.equal(ownAccount.length, 0, `${label}：镇营店出现了自己的粮券流水`);
}

test("openTownShop：没有批发市场不能开；开出后无业主、不付开店资金、占商业街店位", () => {
  const state = simulation.createInitialState({ seed: 91 });
  grantResidentVouchers(state, 300000, CONTENT);
  const plot = state.plots.find(p => !p.feature);
  state.buildings.push({ id: "commercial_street", typeId: "commercial_street", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  const denied = simulation.openTownShop(state, "commercial_street");
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /批发市场/);

  const { state: built, shopId, street } = townState(91, { flourJin: 0 });
  const shop = built.shops[shopId];
  assert.equal(shop.town, true);
  assert.equal(shop.ownerHouseholdId, null);
  assert.equal(shop.typeId, "general");
  assert.equal(shop.status, "open");
  assert.equal(shop.initialCapital.valueUnits, 0, "没有开店启动资金");
  assert.equal(shop.cashVoucherUnits, 0);
  assert.ok(shopsForStreet(built, street.id).some(row => row.id === shopId), "占用商业街店位");
  assert.equal(jobCount(built, `shop:${shopId}:merchant`), 0, "镇营店没有商人岗位");
  const validation = simulation.validateState(built);
  assert.equal(validation.valid, true, validation.errors.join("；"));
});

test("镇营店付款路由：第一天零售收入直接进镇库；40 天内全程没有镇库→镇库付款", () => {
  const { state, shopId } = townState(92, { flourJin: 5000 });
  simulation.advanceDay(state);
  const firstDayRetail = state.currency.ledger.filter(row => row.type === "shop_retail_sale" && row.to === "town");
  assert.ok(firstDayRetail.length > 0, "零售收入应付给镇库");
  assert.equal(state.currency.ledger.filter(row => row.type === "shop_retail_sale" && row.to === `shop:${shopId}`).length, 0, "零售收入不付给镇营店自己");
  assertNoTownToTownPayments(state, shopId, "第1天");
  for (let d = 1; d < 40; d++) {
    simulation.advanceDay(state);
    assertNoTownToTownPayments(state, shopId, `第${d + 1}天`);
  }
  const shop = state.shops[shopId];
  assert.ok((shop.accounts.cumulative.revenueVoucherUnits || 0) > 0, "镇营店应有零售收入");
  assert.equal(shop.cashVoucherUnits, 0, "镇营店没有自己的钱");
  assert.equal(shop.cashWheatUnits, 0);
  // 镇营店不交店租、不交利润税，不分红；利润每日上缴（留存额清零）。
  assert.equal(shop.liabilities.rentVoucherUnits, 0);
  assert.equal(shop.liabilities.taxVoucherUnits, 0);
  assert.equal(shop.accounts.cumulative.taxExpenseVoucherUnits || 0, 0);
  assert.equal(shop.accounts.cumulative.rentExpenseVoucherUnits || 0, 0);
  assert.equal(shop.accounts.cumulative.distributedVoucherUnits || 0, 0);
  assert.equal(shop.retainedEarningsVoucherUnits, 0);
  const validation = simulation.validateState(state);
  assert.equal(validation.valid, true, validation.errors.join("；"));
});

test("镇营店进货：批发市场 → 镇库 → 店，只搬货不付钱，市场记录镇营需求", () => {
  const { state, shopId } = townState(93, { flourJin: 3000 });
  const marketFlourBefore = state.wholesaleMarket.inventory.flour;
  const marketSalesBefore = state.wholesaleMarket.cumulative.salesVoucherUnits || 0;
  const townFlourBefore = state.accounts.town.flour;
  const basisTotal = state.wholesaleMarket.inventoryCostVoucherUnits.flour + state.business.inventoryCostWheatUnits.town.flour;
  simulation.advanceDay(state);
  const shop = state.shops[shopId];
  const bought = shop.accounts.cumulative.purchasedUnits?.flour || 0;
  assert.ok(bought > 0, "第一天应当进了面粉");
  assert.equal(marketFlourBefore - state.wholesaleMarket.inventory.flour, bought, "市场库存减少的量 = 店进货量（镇库只是中转，不留存）");
  assert.equal(state.accounts.town.flour, townFlourBefore, "镇库面粉数量不变（镇库只是中转）");
  assert.equal(state.wholesaleMarket.cumulative.salesVoucherUnits || 0, marketSalesBefore, "市场没有卖出，也没有收钱");
  assert.equal(shop.accounts.cumulative.purchaseVoucherUnits || 0, 0, "进货成本是内部价，不计入采购现金账");
  // 成本基础守恒：市场 + 镇库 + 店 + 已售成本 = 初始成本（只有面粉有成本）。
  const basisNow = state.wholesaleMarket.inventoryCostVoucherUnits.flour + state.business.inventoryCostWheatUnits.town.flour
    + (shop.inventoryCostVoucherUnits.flour || 0) + (shop.accounts.cumulative.cogsVoucherUnits || 0);
  assert.equal(basisNow, basisTotal, "成本基础随货转移，不凭空增减");
  assert.ok((state.wholesaleMarket.cumulative.townConsumedUnits.flour || 0) >= bought, "批发市场记录镇营店的领用需求");
  assertNoTownToTownPayments(state, shopId, "进货");
});

test("镇营店进货优先于私营店：进货顺序里镇营店排第一", () => {
  const { state, shopId, privateShopId } = townState(94, { flourJin: 0, privateStore: true });
  const order = prepareShopsForDay(state, CONTENT).map(row => row.shopId);
  assert.equal(order[0], shopId, "镇营店最先进货");
  assert.ok(order.includes(privateShopId), "私营店同样参与进货");
});

test("员工由玩家设定、自动审核不覆盖；接待能力 = min(上限, 20 × 店员)", () => {
  const { state, shopId } = townState(95, { flourJin: 5000 });
  for (let d = 0; d < 40; d++) simulation.advanceDay(state);
  assert.equal(jobCount(state, `shop:${shopId}:clerk`), 20, "店员保持 20 人");
  assert.equal(state.shops[shopId].plan?.targetClerks, undefined, "镇营店不走自动审核");
  assert.equal(shopDailyCustomerCapacity(state, state.shops[shopId], CONTENT), Math.min(CAP_MAX, 20 * CAP_PER_STAFF));
  const set15 = simulation.configureShopClerks(state, shopId, 15);
  assert.ok(set15.ok, set15.reason);
  assert.equal(shopDailyCustomerCapacity(state, state.shops[shopId], CONTENT), Math.min(CAP_MAX, 15 * CAP_PER_STAFF));
  const max = CONTENT.rules.generalStoreMaxClerks || 50;
  const setMax = simulation.configureShopClerks(state, shopId, max + 10);
  assert.ok(setMax.ok, setMax.reason);
  assert.equal(jobCount(state, `shop:${shopId}:clerk`), max, "店员上限沿用 generalStoreMaxClerks");
  assert.equal(shopDailyCustomerCapacity(state, state.shops[shopId], CONTENT), Math.min(CAP_MAX, max * CAP_PER_STAFF));
  const merchants = simulation.configureShopMerchants(state, shopId, 1);
  assert.equal(merchants.ok, false);
  assert.match(merchants.reason, /镇营店/);
});

test("镇营店不参与 30 天亏损自动关店：没有货、没有销量也不关（由玩家关）", () => {
  const { state, shopId } = townState(96, { flourJin: 0 });
  for (let d = 0; d < 40; d++) simulation.advanceDay(state);
  const shop = state.shops[shopId];
  assert.equal(shop.status, "open");
  assert.equal(shop.badDays || 0, 0);
});

test("社保雇主：镇营店的店员雇主是镇库", () => {
  const { state, shopId } = townState(97, { flourJin: 5000 });
  simulation.advanceDay(state);
  const info = socialEmployerForJobKey(state, householdList(state)[0].id, `shop:${shopId}:clerk`);
  assert.equal(info.employer, "town");
  assert.equal(info.self, false);
});

test("业主接手与校验：镇营店不参与业主更替，校验通过", () => {
  const { state, shopId } = townState(98, { flourJin: 5000 });
  for (let d = 0; d < 3; d++) simulation.advanceDay(state);
  const rows = succeedOrphanShops(state, CONTENT);
  assert.equal(rows.some(row => row.shopId === shopId), false, "镇营店不参与业主接手");
  assert.equal(state.shops[shopId].ownerHouseholdId, null);
  assert.equal(state.shops[shopId].status, "open");
  const validation = simulation.validateState(state);
  assert.equal(validation.valid, true, validation.errors.join("；"));
});

test("发薪日与汇总：镇营店工资发薪日为镇库 5 号，不进私营店排名；汇总标记为镇营", () => {
  const { state, shopId } = townState(99, { flourJin: 5000 });
  simulation.advanceDay(state);
  assert.equal(payDayFor(state, "town"), 5);
  assert.equal(state.payroll?.payDays?.[`shop:${shopId}`], undefined, "镇营店不进发薪日排名");
  const row = shopSummaries(state, CONTENT).find(item => item.id === shopId);
  assert.equal(row.town, true);
  assert.equal(row.ownerName, "镇库");
  assert.equal(row.cashValue, 0);
  assert.equal(row.ownerHouseholdId, null);
});

test("镇营店停业：库存归镇库、店员释放、不进清算，校验通过；停业后不再进货", () => {
  const { state, shopId } = townState(100, { flourJin: 5000 });
  for (let d = 0; d < 5; d++) simulation.advanceDay(state);
  const shop = state.shops[shopId];
  const flourInShop = shop.inventory.flour || 0;
  const townFlourBefore = state.accounts.town.flour || 0;
  const result = closeShop(state, shopId, CONTENT, false);
  assert.equal(result.ok, true);
  assert.equal(result.liquidationPending, false);
  assert.equal(state.shops[shopId].status, "closed");
  assert.equal(shop.inventory.flour, 0);
  assert.equal(state.accounts.town.flour, townFlourBefore + flourInShop, "库存归镇库");
  assert.equal(jobCount(state, `shop:${shopId}:clerk`), 0, "店员释放");
  const validation = simulation.validateState(state);
  assert.equal(validation.valid, true, validation.errors.join("；"));
  const boughtBefore = shop.accounts.cumulative.purchasedUnits?.flour || 0;
  simulation.advanceDay(state);
  assert.equal(shop.accounts.cumulative.purchasedUnits?.flour || 0, boughtBefore, "停业后不再进货");
});

test("供货份额上限：镇营店每日每种商品进货不超过批发市场可售量的 supplyShareMax，余下留给私营店", () => {
  const { state, shopId, privateShopId } = townState(102, { flourJin: 3000, privateStore: true });
  const before = state.wholesaleMarket.inventory.flour;
  const cap = Math.floor(before * (CONTENT.rules.townShop.supplyShareMax));
  const shop = state.shops[shopId];
  const procured = prepareShopsForDay(state, CONTENT);
  assert.equal(procured[0].shopId, shopId, "镇营店仍最先进货");
  const bought = shop.accounts.day.purchasedUnits?.flour || 0;
  assert.ok(bought > 0 && bought <= cap, `镇营店进货 ${bought} 应在上限 ${cap} 内`);
  assert.ok(state.shops[privateShopId], "私营店仍在");
  assert.ok((state.shops[privateShopId].accounts.day.purchasedUnits?.flour || 0) > 0, "剩余货源留给私营店");
});

test("每条商业街镇营店数量上限（maxPerStreet）：超出时开店失败并给出提示，停业后可再开", () => {
  const { state, shopId, street } = townState(103, { flourJin: 0 });
  const second = simulation.openTownShop(state, street.id);
  assert.equal(second.ok, false);
  assert.match(second.reason, new RegExp(`最多${CONTENT.rules.townShop.maxPerStreet}家`));
  closeShop(state, shopId, CONTENT, false);
  const third = simulation.openTownShop(state, street.id);
  assert.equal(third.ok, true, "停业的不占名额");
});

test("镇营店开店结果不含家庭投入（界面提示用 town 标记）", () => {
  const { state, street } = townState(104, { flourJin: 0 });
  const again = simulation.openTownShop(state, street.id);
  assert.equal(again.ok, false);
  const { state: fresh, shopId } = townState(105, { flourJin: 0 });
  assert.equal(fresh.shops[shopId].initialCapital.valueUnits, 0);
});

test("定价成本口径：镇营店动态定价的成本按批发售价计（账上 COGS 仍是内部成本基础）", () => {
  const { state, shopId } = townState(106, { flourJin: 5000 });
  for (let d = 0; d < 8; d++) simulation.advanceDay(state);
  const shop = state.shops[shopId];
  const row = shopSummaries(state, CONTENT).find(r => r.id === shopId).pricing.rows.find(x => x.itemId === "flour");
  assert.ok(row && row.soldJin7d > 0, "7 天窗口内有面粉销量");
  // 窗口成本 / 窗口销量 ≈ 当前批发售价（按同一口径，允许 ±2% 的日内价格波动）。
  const perJinCost = row.cogsJin7d / row.soldJin7d;
  const wholesale = row.wholesaleVoucherPerUnit;
  assert.ok(Math.abs(perJinCost / wholesale - 1) < 0.02, `定价成本 ${perJinCost} 应接近批发价 ${wholesale}`);
});
