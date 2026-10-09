// 月薪（docs 见 systems/employer.js 文件头）：工资每天计提进本月待发，雇主到了发薪日（镇库 5 号；
// 民营、店铺、公司由 paydays.js 按盈利排 5/10/15/20/25 号）才把上个月及更早的待发转为到期并偿付。
import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { addInventory, transferItem } from "../src/economy/inventory.js";
import { transferVouchers } from "../src/economy/currency.js";
import { householdList, householdIdleWorkers } from "../src/systems/households.js";
import { accrueWages, monthSerial, payWages, pendingWages, wageArrears, dayOfMonth as employerDayOfMonth } from "../src/systems/employer.js";
import { assignPayDays, payDayFor } from "../src/systems/paydays.js";
import { townWageRate } from "../src/systems/payroll.js";
import { shopWage } from "../src/systems/labor-market.js";
import { openResidentShop } from "../src/core/commands.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const SCALE = CONTENT.precision.currencyUnitsPerVoucher;

function dayOfMonth(state) {
  return employerDayOfMonth(state, CONTENT);
}

// 结算下一天；直到"下一天是本月第 n 号"为止，再结算这一天（即第 n 号当天）。
function settleThroughDayOfMonth(state, n) {
  while (dayOfMonth(state) !== n) simulation.advanceDay(state);
  return simulation.advanceDay(state);
}

// 同一雇主工资债簿的只读视图（与 payroll.js 里的 bookFor 同一口径）。
function bookOf(state, key) {
  const payroll = state.payroll;
  return {
    claimsVoucherUnits: payroll.creditorClaims?.[key] || {},
    claimsPayment: payroll.creditorPaymentClaims?.[key] || {},
    pendingByMonth: payroll.creditorPending?.[key] || {}
  };
}

// 待发里严格早于本月的部分（即下一个发薪日会到期的那部分）。
function pendingBeforeThisMonth(state, book) {
  const current = monthSerial(state, CONTENT);
  let total = 0;
  for (const [month, row] of Object.entries(book.pendingByMonth)) {
    if (Number(month) >= current) continue;
    for (const units of Object.values(row || {})) total += Math.max(0, units || 0);
  }
  return total;
}

// 镇库一座磨坊、两名磨坊工（已投产），返回工资债簿的键。
// 建造期镇库有钱（否则建筑工的欠薪会先于磨坊工被偿付，干扰断言）。
function millFixture(seed) {
  const state = legacyVoucherState({ seed });
  addInventory(state, "town", "wood", 600, "测试木材", "test", CONTENT);
  const start = simulation.buildAt(state, "mill", "east");
  assert.ok(start, "需要能建磨坊");
  assert.equal(simulation.issueGrainVouchers(state, "town", 5000).ok, true);
  simulation.advanceDays(state, 40);
  const key = `${start.instanceId}::millers`;
  const hired = simulation.setEmployment(state, key, 2);
  assert.equal(hired.ok, true, hired.reason);
  simulation.setWageRate(state, "millers", 5);
  return { state, key };
}

function builderWagesOpen(state) {
  return Object.keys({ ...state.payroll.creditorPending, ...state.payroll.creditorClaims })
    .filter(key => key.startsWith("builders::"))
    .some(key => pendingWages(bookOf(state, key)) > 0 || wageArrears(bookOf(state, key)) > 0);
}

// 镇库补充 jin 斤小麦并印成等额粮券（与 feature-round 的补钱写法一致）。
function fundTown(state, jin) {
  transferItem(state, "residents", "town", "wheat", jin, "测试补充镇库小麦", CONTENT);
  assert.equal(simulation.issueGrainVouchers(state, "town", jin).ok, true);
}

test("镇营工人月薪：每天计提进本月待发，5 号前不付；5 号付清上月全部待发，付后无欠薪", () => {
  const { state, key } = millFixture(11);
  // 推进到某月 1 号：此前各月的工资已计提，本月刚开始。
  while (dayOfMonth(state) !== 1) simulation.advanceDay(state);
  const book = () => bookOf(state, key);
  // 1—4 号：每天计提（待发增加），镇库不付这个工种的钱，也没有欠薪。
  for (let day = 1; day <= 4; day += 1) {
    const pendingBefore = pendingWages(book());
    simulation.advanceDay(state);
    const row = state.payroll.lastDay.workers.find(item => item.payrollKey === key);
    assert.ok(row, `${day} 号应有工资行`);
    assert.ok(row.expectedVoucher > 0, `${day} 号应计提工资`);
    assert.equal(row.currentPaidVoucher, 0, `${day} 号未到发薪日不付`);
    assert.ok(pendingWages(book()) > pendingBefore, `${day} 号工资应进本月待发`);
    assert.equal(wageArrears(book()), 0, `${day} 号不形成欠薪`);
  }
  // 上个月留下的待发（5 号前一直挂着）。
  const owedFromLastMonth = pendingBeforeThisMonth(state, book());
  assert.ok(owedFromLastMonth > 0, "上个月应有待发工资等待 5 号");
  // 5 号：上个月及以前的待发全部到期并付清；本月 1—5 号的待发仍在待发里。
  settleThroughDayOfMonth(state, 5);
  const row = state.payroll.lastDay.workers.find(item => item.payrollKey === key);
  assert.equal(row.currentPaidVoucher * SCALE, owedFromLastMonth, "5 号付清上月全部待发");
  assert.equal(wageArrears(book()), 0, "付后无欠薪");
  assert.equal(pendingBeforeThisMonth(state, book()), 0, "上月待发已转为到期并付清");
  assert.ok(pendingWages(book()) > 0, "本月 1—5 号的工资仍在待发");
});

test("镇库没钱时 5 号形成欠薪，之后有钱逐日补付直至清零", () => {
  const { state, key } = millFixture(12);
  // 建造工的工资要等建成后的发薪日结清，否则镇库清空后他们的欠薪会先于磨坊工被偿付。
  for (let i = 0; i < 120 && builderWagesOpen(state); i += 1) simulation.advanceDay(state);
  assert.equal(builderWagesOpen(state), false, "建造工工资应已结清");
  // 关闭自动救济，否则镇库一有钱就先被救济花掉，无法验证工资的补付。
  simulation.toggleAutomaticRelief(state, false);
  // 清空镇库粮券：镇库没钱。
  assert.equal(transferVouchers(state, "town", "residents", state.currency.balances.town, CONTENT, "test_drain", "测试：镇库没钱").ok, true);
  assert.equal(state.currency.balances.town, 0);
  const book = () => bookOf(state, key);
  while (dayOfMonth(state) !== 1) simulation.advanceDay(state);
  // 1—4 号镇库一直没钱，但工资只是计提，不是欠薪。
  settleThroughDayOfMonth(state, 4);
  assert.equal(wageArrears(book()), 0, "未到发薪日不算欠薪");
  // 5 号到期却付不出：全部形成欠薪（到期未付），之后才是真正的欠薪。
  const owed = pendingBeforeThisMonth(state, book());
  settleThroughDayOfMonth(state, 5);
  assert.equal(state.payroll.lastDay.workers.find(item => item.payrollKey === key).currentPaidVoucher, 0);
  assert.equal(wageArrears(book()), owed, "5 号付不出的部分形成欠薪");
  assert.ok(owed > 0);
  // 6 号起镇库有钱了：先付一半（欠薪按日补付），欠薪减少但未清零。
  const half = Math.floor(owed / SCALE / 2) + 1;
  fundTown(state, half);
  simulation.advanceDay(state);
  const afterHalf = wageArrears(book());
  assert.ok(afterHalf > 0, "钱不够，仍有欠薪");
  assert.ok(afterHalf < owed, "有钱就补付，欠薪减少");
  // 再有钱，欠薪补清。
  fundTown(state, Math.ceil(afterHalf / SCALE) + 5);
  simulation.advanceDay(state);
  assert.equal(wageArrears(book()), 0, "钱够了欠薪补清");
});

test("不传发薪日的 payWages（清算、收回、垫付）立即付清全部待发，包括本月", () => {
  const state = legacyVoucherState({ seed: 13 });
  assert.equal(simulation.issueGrainVouchers(state, "town", 5000).ok, true);
  const household = householdList(state)[0];
  const book = { claimsVoucherUnits: {}, claimsPayment: {}, pendingByMonth: {} };
  // 本月计提 100 券的工资（未到发薪日）。
  accrueWages(state, book, [{ householdId: household.id, count: 1 }], 100 * SCALE, CONTENT);
  assert.equal(pendingWages(book), 100 * SCALE);
  assert.equal(wageArrears(book), 0);
  const before = state.households.byId[household.id].voucherUnits;
  const result = payWages(state, book, "town", CONTENT, "test_wage_payment", "测试立即偿付");
  assert.equal(result.paid, 100 * SCALE, "不传 payDay 时本月待发也立即到期并付清");
  assert.equal(pendingWages(book), 0);
  assert.equal(wageArrears(book), 0);
  assert.equal(state.households.byId[household.id].voucherUnits - before, 100 * SCALE);
});

test("辞退：入职不满 30 天拒绝；满 30 天辞退成功，家庭收到 30 天日薪补偿，镇库少同样的钱", () => {
  const { state, key } = millFixture(14);
  // 刚入职：不满 30 天，不能辞退。
  const rejected = simulation.setEmployment(state, key, 1);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /入职不满30天/);
  assert.equal(rejected.assigned, 2, "被拒绝时人数不变");
  // 满 30 天（直接推进日历，避免其间的日结干扰补偿断言）。
  state.day += CONTENT.rules.dismissalMinTenureDays;
  const dailyJin = townWageRate(state, "millers", CONTENT);
  assert.equal(dailyJin, 5);
  const expectedSeverance = dailyJin * CONTENT.rules.severanceWageDays * SCALE;
  const townBefore = state.currency.balances.town;
  const dismissedHousehold = householdList(state).find(household => household.jobs?.[key] > 0);
  const householdBefore = state.households.byId[dismissedHousehold.id].voucherUnits;
  const result = simulation.setEmployment(state, key, 1);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.dismissed, 1);
  assert.equal(result.severanceVoucherUnits, expectedSeverance, "补偿 = 30 天日薪");
  assert.equal(state.currency.balances.town, townBefore - expectedSeverance, "镇库少付同样的钱");
  assert.equal(state.households.byId[dismissedHousehold.id].voucherUnits - householdBefore, expectedSeverance, "被辞退者的家庭收到补偿");
  const severanceRows = state.ledger.filter(row => row.type === "severance_payment");
  assert.equal(severanceRows.reduce((sum, row) => sum + row.quantityUnits, 0), expectedSeverance);
  assert.equal(severanceRows.every(row => row.source === "town"), true);
});

test("店铺减店员是辞退：满 30 天的店员被辞退时，店铺付 30 天店员日薪补偿", () => {
  const state = legacyVoucherState({ seed: 15 });
  assert.equal(simulation.issueGrainVouchers(state, "town", 200000).ok, true);
  const freePlot = feature => state.plots.find(plot => (feature ? plot.feature === feature : !plot.feature) && !state.buildings.some(building => building.plotId === plot.id));
  const placeBuilding = (id, typeId) => {
    const definition = CONTENT.buildings[typeId];
    const plot = freePlot(definition.requiredPlotFeature || null);
    assert.ok(plot, `需要地块建 ${typeId}`);
    state.buildings.push({ id, typeId, level: 2, ownership: { townLevels: 2, privateLevels: 0, listedLevels: 0 },
      plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  };
  placeBuilding("wm-shop", "wholesale_market");
  placeBuilding("street-shop", "commercial_street");
  const owner = householdList(state).find(household => householdIdleWorkers(household) > 0);
  grantResidentVouchers(state, 5000, CONTENT, owner.id);
  const opened = openResidentShop(state, "street-shop", "general", owner.id, CONTENT);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  // 店铺先注资，保证补偿能全额付出（付不出的部分会记成店铺欠薪，本测试不测这一点）。
  assert.equal(transferVouchers(state, "town", `shop:${shop.id}`, 5000 * SCALE, CONTENT, "test_shop_capital", "测试店铺注资").ok, true);
  assert.equal(simulation.configureShopClerks(state, shop.id, 2).assigned, 2);
  // 店员满 30 天（同一店铺的店员入职日期早于此，不再受保护）。
  state.day += CONTENT.rules.shopMinimumEmploymentDays;
  const clerkRate = shopWage(state, shop, CONTENT);
  const expectedSeverance = clerkRate * CONTENT.rules.severanceWageDays * SCALE;
  const shopCashBefore = shop.cashVoucherUnits;
  const result = simulation.configureShopClerks(state, shop.id, 1);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.assigned, 1);
  assert.equal(result.severanceVoucherUnits, expectedSeverance, "店铺补偿 = 30 天店员日薪");
  const severanceRows = state.ledger.filter(row => row.type === "severance_payment" && row.source === `shop:${shop.id}`);
  assert.equal(severanceRows.reduce((sum, row) => sum + row.quantityUnits, 0), expectedSeverance, "补偿由店铺付出");
  assert.equal(shop.cashVoucherUnits, shopCashBefore - expectedSeverance, "店铺现金减少同样的补偿");
});

test("发薪日：盈利高的雇主发薪日更早，镇库固定 5 号", () => {
  const state = legacyVoucherState({ seed: 16 });
  assert.equal(simulation.issueGrainVouchers(state, "town", 200000).ok, true);
  const freePlot = feature => state.plots.find(plot => (feature ? plot.feature === feature : !plot.feature) && !state.buildings.some(building => building.plotId === plot.id));
  const placeBuilding = (id, typeId) => {
    const plot = freePlot(CONTENT.buildings[typeId].requiredPlotFeature || null);
    assert.ok(plot, `需要地块建 ${typeId}`);
    state.buildings.push({ id, typeId, level: 2, ownership: { townLevels: 2, privateLevels: 0, listedLevels: 0 },
      plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  };
  placeBuilding("pay-market", "wholesale_market");
  placeBuilding("pay-street", "commercial_street");
  const owners = householdList(state).filter(household => householdIdleWorkers(household) > 0).slice(0, 2);
  assert.equal(owners.length, 2, "需要两户有空闲劳力的家庭");
  const shops = owners.map(owner => {
    grantResidentVouchers(state, 5000, CONTENT, owner.id);
    const opened = openResidentShop(state, "pay-street", "general", owner.id, CONTENT);
    assert.equal(opened.ok, true, opened.reason);
    return state.shops[opened.shopId];
  });
  const [rich, poor] = shops;
  const history = profit => Array.from({ length: CONTENT.rules.operatingObservationDays }, (_, serial) => ({
    serial, customerCount: 0, rejectedCustomerCount: 0, soldUnits: 0, profitVoucherUnits: profit
  }));
  rich.history = history(50 * SCALE);
  poor.history = history(-5 * SCALE);
  // 发薪日表每月 1 号（或还没定过时）排一次。
  delete state.payroll?.payDays;
  state.day = 0;
  const payDays = assignPayDays(state, CONTENT);
  assert.ok(payDays, "应排出发薪日");
  assert.equal(payDayFor(state, "town"), 5);
  assert.equal(payDayFor(state, `shop:${rich.id}`), 5, "盈利最高的店铺第一档 5 号");
  assert.ok(payDayFor(state, `shop:${poor.id}`) > payDayFor(state, `shop:${rich.id}`), "亏损的店铺发薪日更晚");
  assert.equal(payDayFor(state, `shop:${poor.id}`), 25, "不赚钱的雇主默认 25 号");
});
