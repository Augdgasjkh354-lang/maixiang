import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT, simulation } from "../src/engine.js";
import { householdList, householdPopulation } from "../src/systems/households.js";
import { householdIdleWorkers, isActiveHousehold } from "../src/systems/households.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { accrueServiceDemand, processServiceDemand } from "../src/systems/services.js";
import { prepareShopsForDay, finishShopsDay, resetShopDaily } from "../src/systems/shops.js";
import { householdAffluence, invalidateHouseholdBudgets } from "../src/systems/household-budget.js";
import { voucherWealthForAffluence } from "./budget-fixture.js";
import { ensureHouseholdLife } from "../src/systems/household-life.js";
import { issueTownVouchers, transferVouchers, voucherBalance } from "../src/economy/currency.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const THEATER_MIN = CONTENT.rules.theaterMinAffluence;

// 商业街：与 tests/v016-agriculture-services.test.js 的 addStreet 一致（按定义的地块要求找空地）。
function addStreet(state, id = "street-theater", level = 2) {
  const def = CONTENT.buildings.commercial_street;
  const plot = state.plots.find(row => (!def.requiredPlotFeature || row.feature === def.requiredPlotFeature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, "需要一块空地建商业街");
  const building = { id, typeId: "commercial_street", level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: state.day + 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function idleHouseholds(state, count) {
  const rows = householdList(state).filter(h => householdIdleWorkers(h) > 0);
  assert.ok(rows.length >= count, `需要 ${count} 户有空闲劳力的家庭`);
  return rows.slice(0, count);
}

// 把一户的宽裕度设成 affluence：小麦只留够口粮（无余粮），粮券按 宽裕度² × 参照人均家底 × 人口 给出。
// 宽裕度 m 由可动用预算比值决定（household-budget 新口径），家底由 voucherWealthForAffluence 反算。
// 粮券必须走发行与转账，否则总账不守恒（validateState 会报错）。
function useVoucherMoney(state) {
  if (state.monetaryReform?.stage === "voucher") return;
  state.monetaryReform.stage = "voucher";
  state.monetaryReform.targetVoucherBps = 10000;
  state.monetaryReform.residentExchangeEnabled = false;
  state.monetaryReform.legacyBankAccess = true;
}

function setAffluence(state, household, affluence) {
  useVoucherMoney(state);
  const people = householdPopulation(household);
  const keepDays = CONTENT.rules.householdBudget.wealthFoodReserveDays; // 家底只扣这么多天口粮，正好留足口粮、不产生额外家底
  household.inventory.wheat = Math.round(people * CONTENT.rules.foodPerPersonDay * keepDays * I);
  household.inventory.flour = 0;
  household.inventory.bread = 0;
  const target = voucherWealthForAffluence(state, household, affluence, CONTENT);
  const owner = `household:${household.id}`;
  const current = voucherBalance(state, owner);
  if (target > current) {
    const need = target - current;
    if (voucherBalance(state, "town") < need) {
      const issued = issueTownVouchers(state, need - voucherBalance(state, "town"), CONTENT, "测试印制");
      assert.equal(issued.ok, true, issued.reason);
    }
    const moved = transferVouchers(state, "town", owner, need, CONTENT, "test_income", "测试设定家底");
    assert.equal(moved.ok, true, moved.reason);
  } else if (target < current) {
    const moved = transferVouchers(state, owner, "town", current - target, CONTENT, "test_expense", "测试设定家底");
    assert.equal(moved.ok, true, moved.reason);
  }
  invalidateHouseholdBudgets(state);
}

// 每天的服务结算，与日结 services 步骤相同的口径（需求累计 → 开店准备 → 成交 → 店铺结账）。
function serviceDay(state) {
  resetShopDaily(state, CONTENT);
  accrueServiceDemand(state, CONTENT);
  prepareShopsForDay(state, CONTENT);
  const result = processServiceDemand(state, CONTENT);
  finishShopsDay(state, CONTENT, false);
  state.day += 1;
  return result;
}

// 开一座戏园，店主用第一户空闲劳力家庭；其余家庭分成富户（宽裕度 2.2）与穷户（0.4）各一半。
function theaterWorld(seed) {
  const state = simulation.createInitialState({ seed });
  const street = addStreet(state, `street-${seed}`);
  const [owner] = idleHouseholds(state, 1);
  const opened = simulation.openResidentShop(state, street.id, "theater", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  const buyers = householdList(state).filter(h => h.id !== owner.id && isActiveHousehold(h));
  const rich = buyers.filter((_, i) => i % 2 === 0);
  const poor = buyers.filter((_, i) => i % 2 === 1);
  return { state, street, owner, shop, rich, poor };
}

test("戏园内容：服务参数符合定位（票价高、接待能力低、舒心值高、收入敏感、富户门槛 1.5）", () => {
  const theater = CONTENT.rules.serviceTypes.theater;
  const tea = CONTENT.rules.serviceTypes.tea;
  assert.equal(theater.name, "戏园");
  assert.equal(theater.basis, "person");
  assert.equal(theater.minAffluence, THEATER_MIN);
  assert.equal(CONTENT.rules.theaterMinAffluence, 1.5);
  assert.ok(theater.priceVoucher > tea.priceVoucher, "票价高于茶馆");
  assert.ok(theater.clerkCapacity < tea.clerkCapacity, "每个店员接待的客人少于茶馆（人工密集）");
  assert.ok(theater.merchantCapacity < tea.merchantCapacity);
  assert.ok(theater.comfort > tea.comfort, "舒心值高于茶馆");
  assert.ok(theater.incomeSensitivity > tea.incomeSensitivity, "收入弹性高于茶馆");
  assert.equal(CONTENT.rules.shopTypes.theater.kind, "service");
  assert.equal(CONTENT.rules.shopTypes.theater.serviceId, "theater");
  assert.equal(tea.minAffluence, undefined, "其他服务没有门槛");
});

test("戏园开在商业街上；开在其他建筑上被拒绝", () => {
  const state = simulation.createInitialState({ seed: 7101 });
  const street = addStreet(state, "street-open");
  const [owner] = idleHouseholds(state, 1);
  const bad = simulation.openResidentShop(state, street.id.replace("street", "missing"), "theater", owner.id);
  assert.equal(bad.ok, false);
  const opened = simulation.openResidentShop(state, street.id, "theater", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  assert.equal(shop.typeId, "theater");
  assert.equal(shop.serviceId, "theater");
  assert.equal(shop.status, "open");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));

  const plain = simulation.createInitialState({ seed: 7102 });
  const someone = idleHouseholds(plain, 1)[0];
  const noStreet = simulation.openResidentShop(plain, "no-such-building", "theater", someone.id);
  assert.equal(noStreet.ok, false, "没有商业街就不能开戏园");
});

test("门槛：宽裕度低于 1.5 的家庭没有戏园需求，达到的家庭才有", () => {
  const { state, rich, poor } = theaterWorld(7201);
  for (const h of rich) setAffluence(state, h, 2.2);
  for (const h of poor) setAffluence(state, h, 0.4);
  const justBelow = rich[0], justAbove = rich[1];
  setAffluence(state, justBelow, 1.4);
  setAffluence(state, justAbove, 1.6);
  invalidateHouseholdBudgets(state);
  assert.ok(householdAffluence(state, justBelow, CONTENT) < THEATER_MIN);
  assert.ok(householdAffluence(state, justAbove, CONTENT) >= THEATER_MIN);
  accrueServiceDemand(state, CONTENT);
  const demand = state.services.demandByHousehold;
  assert.equal(demand[justBelow.id].theater, 0, "宽裕度 1.4 不去戏园");
  assert.ok(demand[justAbove.id].theater > 0, "宽裕度 1.6 去戏园");
  for (const h of poor) assert.equal(demand[h.id].theater, 0, "穷户无戏园需求");
});

test("只有富户去戏园：穷户从不成交，富户成交并计入营收与舒心值", () => {
  const { state, shop, rich, poor } = theaterWorld(7202);
  for (const h of [...rich, ...poor]) ensureHouseholdLife(h, CONTENT).day = {};
  let served = 0;
  for (let day = 0; day < 20; day += 1) {
    // 660 户每户约 5 人：日家底预算 ≈ 0.35 × 宽裕度² × 人口，一张票 15 粮券，宽裕度 2.2 的小户付不起整张票，取封顶 3。
    for (const h of rich) setAffluence(state, h, 3);
    for (const h of poor) setAffluence(state, h, 0.4);
    const result = serviceDay(state);
    served += result.servedUses?.theater || 0;
    for (const h of poor) {
      assert.equal(state.services.demandByHousehold[h.id].theater, 0, "穷户需求始终为零");
      assert.equal(ensureHouseholdLife(h, CONTENT).day.serviceComfortPoints || 0, 0, "穷户不加舒心值");
    }
  }
  assert.ok(served > 0, "富户应当去戏园");
  const cumulative = shop.accounts.cumulative;
  assert.equal(cumulative.serviceUses.theater, served, "店铺接待次数与成交次数一致");
  assert.equal(cumulative.revenueVoucherUnits, served * CONTENT.rules.serviceTypes.theater.priceVoucher * V, "营收 = 成交次数 × 票价");
  const richComfort = rich.map(h => ensureHouseholdLife(h, CONTENT).day.serviceComfortPoints || 0);
  assert.ok(richComfort.some(points => points > 0), "富户有舒心值加成");
  assert.ok(richComfort.every(points => points <= CONTENT.rules.serviceComfortDailyMaximum), "舒心值受日上限约束");
  assert.equal(simulation.validateState(state).valid, true, simulation.validateState(state).errors?.join("；"));
});

test("富户变穷后，原有的戏园需求清零，不再去", () => {
  const { state, rich } = theaterWorld(7203);
  const [target] = rich;
  setAffluence(state, target, 2.2);
  accrueServiceDemand(state, CONTENT);
  assert.ok(state.services.demandByHousehold[target.id].theater > 0);
  setAffluence(state, target, 0.5);
  accrueServiceDemand(state, CONTENT);
  assert.equal(state.services.demandByHousehold[target.id].theater, 0, "宽裕度跌破门槛后需求清零");
});
