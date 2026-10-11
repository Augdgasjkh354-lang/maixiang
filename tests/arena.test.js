// 巨型斗兽场（金银消费第四期）：建造需求（木 100 万、单级、不做所有制转换）、门票与政策命令、座位（场务 × 40，封顶 2000）、
// 抓兽（min(猎手 × 10, 目标, 空位)）、喂养（10 斤/只，储备线，饿死按比例）、搏斗与野味（入市、备货天数闸门、损耗）、
// 押注守恒（居民 + 镇库粮券不变，抽成 = 押注 × 抽成率）、押注不超过剩余预算一半、兴奋度与出席意愿、降级、无斗兽场逐位不变、
// 旧档补齐、野味进肉的主食链、集市与综合商店上架、拆除撤店、校验。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { isIndustryType } from "../src/content/buildings.js";
import { householdList, isActiveHousehold } from "../src/systems/households.js";
import { voucherBalance, issueTownVouchers } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { arenaAttendanceFactor, arenaExcitement, arenaPolicy, arenaShopOf, settleArenaDay, setArenaPolicy, syncArena, windUpArena } from "../src/systems/arena.js";
import { recordShopServiceSale, serviceShopCapacityUses, stallItemIds } from "../src/systems/shops.js";
import { townWheatSaleReserveUnits, ensureWholesaleMarket } from "../src/systems/wholesale-market.js";
import { tradeMarginTarget } from "../src/systems/trading-houses.js";
import { serviceUnitPrice } from "../src/systems/services.js";
import { selectArena } from "../src/selectors/arena.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const GAME = "wild_game";

function valid(state, label = "") {
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, `${label} ${v.errors.join("；")}`);
}

function addBuilding(state, typeId, id, { level = 1 } = {}) {
  const plot = state.plots.find(row => !row.feature && !state.buildings.some(b => b.plotId === row.id));
  state.buildings.push({ id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return state.buildings.find(row => row.id === id);
}

// 斗兽场世界：一座斗兽场（猎手 10、场务 50），开场存栏 1000，镇库小麦充足（口粮储备线以上 1 万斤）。
function arenaWorld(seed = 91, { hunters = 10, staff = 50, market = true } = {}) {
  const state = simulation.createInitialState({ seed });
  if (market) addBuilding(state, "wholesale_market", "market-1");
  addBuilding(state, "arena", "arena-1");
  simulation.setEmployment(state, "arena-1::hunters", hunters);
  simulation.setEmployment(state, "arena-1::arena_staff", staff);
  syncArena(state, CONTENT);
  state.accounts.town.wheat = townWheatSaleReserveUnits(state, CONTENT) + 10000 * I;
  return state;
}

function setWheatAboveReserve(state, jin) {
  state.accounts.town.wheat = townWheatSaleReserveUnits(state, CONTENT) + Math.round(jin * I);
}

function shopOf(state) {
  return arenaShopOf(state);
}

// ---------------------------------------------------------------- 配置与建造

test("斗兽场建筑：木材 100 万斤、单级（无升级）、一座、镇营，不是产业（不做所有制转换）", () => {
  const def = CONTENT.buildings.arena;
  assert.equal(def.materialRequirements.find(row => row.itemId === "wood")?.quantity, 1000000);
  assert.equal(def.upgrade, undefined);
  assert.equal(def.maxInstances, 1);
  assert.equal(isIndustryType(CONTENT, "arena"), false);
  assert.deepEqual(def.jobs.map(job => job.id), ["hunters", "arena_staff"]);
  assert.equal(def.jobs.find(job => job.id === "hunters").slots, 40);
  assert.equal(def.jobs.find(job => job.id === "arena_staff").slots, 60);
  assert.ok(def.construction.workDays > 0 && def.construction.recommendedWorkers > 0);
});

test("门票默认 1 粮券，可调；抽成默认 10%（0—30），政策命令校验范围与未知项", () => {
  const state = arenaWorld();
  assert.equal(serviceUnitPrice(state, "arena", CONTENT), 1);
  assert.equal(simulation.configureServicePrice(state, "arena", 2.5).ok, true);
  assert.equal(serviceUnitPrice(state, "arena", CONTENT), 2.5);
  assert.equal(arenaPolicy(state, CONTENT).rakePercent, 10);
  assert.equal(setArenaPolicy(state, { rakePercent: 31 }, CONTENT).ok, false);
  assert.equal(setArenaPolicy(state, { dailyFights: -1 }, CONTENT).ok, false);
  assert.equal(setArenaPolicy(state, { nonsense: 1 }, CONTENT).ok, false);
  const ok = simulation.setArenaPolicy(state, { rakePercent: 12.34, dailyFights: 50 });
  assert.equal(ok.ok, true);
  assert.equal(state.policy.arena.rakePercent, 12.3);
  assert.equal(state.policy.arena.dailyFights, 50);
  assert.equal(state.policy.arena.dailyCaptureTarget, 100);
  valid(state, "政策");
});

// ---------------------------------------------------------------- 座位

test("座位 = 在岗场务 × 40，封顶每日 2000；没有场务则为 0", () => {
  const state = arenaWorld(91, { staff: 0 });
  const shop = shopOf(state);
  assert.equal(serviceShopCapacityUses(state, shop, CONTENT), 0);
  simulation.setEmployment(state, "arena-1::arena_staff", 10);
  assert.equal(serviceShopCapacityUses(state, shop, CONTENT), 400);
  simulation.setEmployment(state, "arena-1::arena_staff", 50);
  assert.equal(serviceShopCapacityUses(state, shop, CONTENT), 2000);
  simulation.setEmployment(state, "arena-1::arena_staff", 60);
  assert.equal(serviceShopCapacityUses(state, shop, CONTENT), 2000);
  valid(state, "座位");
});

// ---------------------------------------------------------------- 抓兽、喂养、搏斗

test("抓兽 = min(猎手 × 10, 每日抓兽目标, 存栏空位)", () => {
  // 猎手 10 人 → 100 只能力，目标 100，空位充足：抓 100
  let state = arenaWorld(91, { hunters: 10 });
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.captured, 100);
  // 猎手 3 人 → 30 只
  state = arenaWorld(91, { hunters: 3 });
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.captured, 30);
  // 目标 20 → 20
  state = arenaWorld(91, { hunters: 10 });
  simulation.setArenaPolicy(state, { dailyCaptureTarget: 20 });
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.captured, 20);
  // 存栏 1995、上限 2000 → 空位 5
  state = arenaWorld(91, { hunters: 10 });
  state.arena.beasts = 1995;
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.captured, 5);
  valid(state, "抓兽");
});

test("喂养：每只兽每日 10 斤小麦，只从镇库超过储备线的部分买；喂不饱按比例饿死，饿死的不产野味", () => {
  const state = arenaWorld();
  simulation.setArenaPolicy(state, { dailyCaptureTarget: 0 });
  setWheatAboveReserve(state, 100);
  const wheatBefore = state.accounts.town.wheat;
  settleArenaDay(state, CONTENT);
  const today = state.arena.today;
  // 需要 1000 只 × 10 斤 = 10000 斤，只能喂 100 斤 → 喂饱 1%，饿死 990 只，剩 10 只上场
  assert.equal(wheatBefore - state.accounts.town.wheat, 100 * I);
  assert.equal(today.feedFraction, 0.01);
  assert.equal(today.starved, 990);
  assert.equal(today.fights, 10);
  assert.equal(today.gameDepositedUnits + today.gameSpoiledUnits, 10 * 10 * I);
  assert.equal(state.arena.beasts, 0);
  valid(state, "喂不饱");
});

test("喂饱时全部存栏吃满 10 斤；储备线以内不动", () => {
  const state = arenaWorld();
  simulation.setArenaPolicy(state, { dailyCaptureTarget: 0, dailyFights: 0 });
  state.accounts.town.wheat = townWheatSaleReserveUnits(state, CONTENT) + 20000 * I;
  const before = state.accounts.town.wheat;
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.feedFraction, 1);
  assert.equal(state.arena.today.starved, 0);
  assert.equal(before - state.accounts.town.wheat, 10000 * I);
  // 只有储备线以内的小麦：一斤都不买，兽全部饿死
  state.accounts.town.wheat = townWheatSaleReserveUnits(state, CONTENT);
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.feedFraction, 0);
  assert.equal(state.arena.beasts, 0);
  valid(state, "喂饱");
});

test("搏斗产野味 10 斤/只，统购入批发市场；超过备货天数的野味不入库，记损耗", () => {
  const state = arenaWorld();
  setWheatAboveReserve(state, 20000);
  settleArenaDay(state, CONTENT);
  const today = state.arena.today;
  // 没有销量历史：镇营产出的入库上限为最低备货量 200 斤，其余损耗
  assert.equal(today.fights, 100);
  assert.equal(today.gameDepositedUnits, 200 * I);
  assert.equal(today.gameSpoiledUnits, 800 * I);
  assert.equal(state.wholesaleMarket.inventory[GAME], 200 * I);
  // 市场已满：再搏斗一天全部损耗
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.gameDepositedUnits, 0);
  assert.equal(state.wholesaleMarket.inventory[GAME], 200 * I);
  valid(state, "野味");
});

test("没有批发市场：野味全部损耗，不入库", () => {
  const state = arenaWorld(91, { market: false });
  setWheatAboveReserve(state, 20000);
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.gameDepositedUnits, 0);
  assert.equal(state.arena.today.gameSpoiledUnits, 1000 * I);
  valid(state, "无市场");
});

// ---------------------------------------------------------------- 押注

// 押注测试：关掉抓兽（存栏保持 1000，兴奋度 1.0，每户 2 张票 = 4 券）。
function bettingWorld(seed = 91) {
  const state = arenaWorld(seed);
  simulation.setArenaPolicy(state, { dailyCaptureTarget: 0 });
  setWheatAboveReserve(state, 20000);
  state.services.day ||= {};
  state.services.day.wagerAttendees ||= {};
  return state;
}

function fundHouseholds(state, count, voucherEach) {
  const ids = householdList(state).filter(isActiveHousehold).slice(0, count).map(h => h.id);
  for (const id of ids) grantResidentVouchers(state, voucherEach, CONTENT, id);
  return ids;
}

test("押注守恒：居民粮券减少量 = 镇库增加的押注，奖金 + 抽成 = 押注，抽成 = 押注 × 抽成率", () => {
  const state = bettingWorld();
  const ids = fundHouseholds(state, 30, 1000);
  const shop = shopOf(state);
  shop.accounts.day.serviceUses.arena = 60;
  state.services.day.wagerAttendees.arena = Object.fromEntries(ids.map(id => [id, { tickets: 2, budgetLeftUnits: 10 ** 12 }]));
  const sum = () => ids.reduce((total, id) => total + voucherBalance(state, `household:${id}`), 0);
  const residentsBefore = sum();
  const townBefore = voucherBalance(state, "town");
  settleArenaDay(state, CONTENT);
  const bet = state.arena.today.betUnits;
  const payout = state.arena.today.payoutUnits;
  const rake = state.arena.today.rakeUnits;
  // 每户 2 张票 × 基础押注 2 券 × 兴奋度 1.0 = 4 券；30 户共 120 券；抽成 10% = 12 券
  assert.equal(bet, 30 * 4 * V);
  assert.equal(rake, bet * 10 / 100);
  assert.equal(payout + rake, bet);
  assert.equal(sum() - residentsBefore, payout - bet);
  assert.equal(voucherBalance(state, "town") - townBefore, bet - payout);
  assert.equal((sum() - residentsBefore) + (voucherBalance(state, "town") - townBefore), 0);
  valid(state, "押注");
});

test("押注不超过买票后剩余预算的一半", () => {
  const state = bettingWorld();
  const [id] = fundHouseholds(state, 1, 1000);
  shopOf(state).accounts.day.serviceUses.arena = 1;
  state.services.day.wagerAttendees.arena = { [id]: { tickets: 1, budgetLeftUnits: 3 } };
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.betUnits, 1);
  valid(state, "预算一半");
});

test("兴奋度 = 存栏 ÷ 1000，夹在 0.5—1.5；出席意愿 = 1 + 0.2 × (兴奋度 − 1)，没兽为 0", () => {
  assert.equal(arenaExcitement(500, CONTENT.rules.arena), 0.5);
  assert.equal(arenaExcitement(1000, CONTENT.rules.arena), 1);
  assert.equal(arenaExcitement(3000, CONTENT.rules.arena), 1.5);
  const state = arenaWorld();
  assert.equal(arenaAttendanceFactor(state, CONTENT), 1);
  state.arena.beasts = 1500;
  assert.ok(Math.abs(arenaAttendanceFactor(state, CONTENT) - 1.1) < 1e-9);
  state.arena.beasts = 500;
  assert.ok(Math.abs(arenaAttendanceFactor(state, CONTENT) - 0.9) < 1e-9);
  state.arena.beasts = 0;
  assert.equal(arenaAttendanceFactor(state, CONTENT), 0);
});

test("票款付给镇库并记为 arena_ticket 账；店账记收入", () => {
  const state = arenaWorld();
  const [id] = fundHouseholds(state, 1, 100);
  const townBefore = voucherBalance(state, "town");
  const household = voucherBalance(state, `household:${id}`);
  const result = recordShopServiceSale(state, shopOf(state).id, id, "arena", CONTENT, { ledgerType: "arena_ticket" });
  assert.equal(result.ok, true, result.reason);
  assert.equal(voucherBalance(state, "town") - townBefore, V);
  assert.equal(household - voucherBalance(state, `household:${id}`), V);
  assert.ok(state.ledger.some(row => row.type === "arena_ticket"));
  valid(state, "票款");
});

// ---------------------------------------------------------------- 降级与旧档

test("没有猎手、没有场务、没有小麦都不报错（降级）", () => {
  let state = arenaWorld(91, { hunters: 0 });
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.captured, 0);
  valid(state, "无猎手");

  state = arenaWorld(91, { staff: 0 });
  simulation.advanceDay(state);
  assert.equal(shopOf(state).statusReason, "无场务");
  valid(state, "无场务");

  state = arenaWorld();
  state.accounts.town.wheat = 0;
  settleArenaDay(state, CONTENT);
  assert.equal(state.arena.today.feedFraction, 0);
  assert.equal(state.arena.beasts, 0);
  valid(state, "无小麦");
});

test("没有斗兽场的世界：需求表没有 arena 键，野味不进肉的分配", () => {
  const state = simulation.createInitialState({ seed: 91 });
  for (let day = 0; day < 3; day += 1) simulation.advanceDay(state);
  for (const row of Object.values(state.services.demandByHousehold)) assert.equal("arena" in row, false);
  for (const row of Object.values(state.services.carryByHousehold)) assert.equal("arena" in row, false);
  assert.equal(state.arena.opened, false);
  assert.equal(state.arena.beasts, 0);
  assert.equal(state.market.staplesLastDay.rows.some(row => row.itemId === GAME), false);
  valid(state, "无斗兽场");
});

test("旧档没有 state.arena / policy.arena：读档补齐默认值，日结正常", () => {
  const state = simulation.createInitialState({ seed: 91 });
  delete state.arena;
  delete state.policy.arena;
  simulation.advanceDay(state);
  assert.equal(arenaPolicy(state, CONTENT).dailyFights, 100);
  assert.equal(state.arena.beasts, 0);
  valid(state, "旧档");
});

test("校验：存栏与政策越界时报错", () => {
  const state = arenaWorld();
  state.arena.beasts = -1;
  assert.equal(simulation.validateState(state).valid, false);
  state.arena.beasts = 5;
  state.policy.arena.rakePercent = 99;
  assert.equal(simulation.validateState(state).valid, false);
  state.policy.arena.rakePercent = 10;
  valid(state, "恢复");
});

// ---------------------------------------------------------------- 野味：上架、主食链、拆除、界面

test("野味：综合商店与集市上架（与肉同一规则），不向养殖场进货；肉的口粮当量 1 斤 = 2 斤", () => {
  assert.equal(CONTENT.items[GAME].qeq.numerator, 2);
  assert.equal(CONTENT.items[GAME].qeq.denominator, 1);
  assert.equal(CONTENT.items[GAME].livestock, undefined);
  assert.ok(CONTENT.rules.shopTypes.general.itemIds.includes(GAME));
  assert.ok(stallItemIds(CONTENT).includes(GAME));
  assert.equal(CONTENT.rules.wholesaleDefaultSalePrices[GAME], 6.6);
  assert.equal(CONTENT.rules.wholesaleDefaultPurchasePrices[GAME], 5);
});

test("野味进肉的主食链：批发市场有货时参与肉的分配，没有货时不参与", () => {
  const state = simulation.createInitialState({ seed: 91 });
  simulation.advanceDay(state);
  assert.equal(state.market.staplesLastDay.rows.some(row => row.itemId === GAME), false);
  ensureWholesaleMarket(state, CONTENT);
  state.wholesaleMarket.inventory[GAME] = 50 * I;
  simulation.advanceDay(state);
  const row = state.market.staplesLastDay.rows.find(item => item.itemId === GAME);
  assert.ok(row, "有货时野味应参与肉的分配");
  assert.ok(row.targetShare > 0);
  valid(state, "主食链");
});

test("拆除斗兽场：撤掉观赛店、存栏清零", () => {
  const state = arenaWorld();
  state.arena.beasts = 500;
  windUpArena(state);
  assert.equal(arenaShopOf(state), null);
  assert.equal(state.arena.beasts, 0);
  assert.equal(state.arena.opened, false);
  valid(state, "拆除");
});

test("界面数据：斗兽场视图只读，金额换算成粮券、野味换算成斤", () => {
  const state = arenaWorld();
  setWheatAboveReserve(state, 20000);
  settleArenaDay(state, CONTENT);
  const before = JSON.stringify(state.arena);
  const view = selectArena(state, CONTENT);
  assert.equal(JSON.stringify(state.arena), before);
  assert.equal(view.built, true);
  assert.equal(view.beasts, state.arena.beasts);
  assert.equal(view.seats, 2000);
  assert.equal(view.ticketVoucher, 1);
  assert.ok(Math.abs(view.today.feedVoucher - state.arena.today.feedVoucherUnits / V) < 1e-9);
});

// ---------------------------------------------------------------- 第四期修正：野味份额再分配、外镇需求、贸易行出口门槛

test("门控肉（野味）有货但买不到时，份额先分给其他肉（鸡鸭鹅猪），而不是先改吃面粉", () => {
  // 两个同样的世界：一个镇库有野味（门控肉开放），一个没有。门控肉买不到（店里没有），其余肉的目标应多出野味的份额。
  const off = simulation.createInitialState({ seed: 91 });
  simulation.advanceDay(off);
  const on = simulation.createInitialState({ seed: 91 });
  on.accounts.town.wild_game = 500 * I;
  simulation.advanceDay(on);
  const rowsOff = off.market.staplesLastDay.rows;
  const rowsOn = on.market.staplesLastDay.rows;
  const wild = rowsOn.find(row => row.itemId === GAME);
  assert.ok(wild, "有货时野味参与分配");
  assert.equal(wild.purchasedJin, 0, "店里没有野味，买不到");
  const meatOf = rows => ["chicken", "duck", "goose", "pork"].reduce((sum, id) => sum + (rows.find(row => row.itemId === id)?.targetQeqJin || 0), 0);
  const flourOf = rows => rows.find(row => row.itemId === "flour")?.targetQeqJin || 0;
  const meatOff = meatOf(rowsOff);
  // 肉的总目标基本不变（野味的份额整体转给其他肉，只差取整），面粉不因为野味买不到而增加。
  assert.ok(Math.abs(meatOf(rowsOn) - meatOff) <= 0.01 * meatOff, `肉总目标应基本不变：${meatOf(rowsOn)} vs ${meatOff}`);
  assert.ok(flourOf(rowsOn) <= flourOf(rowsOff) * 1.001 + 1e-9, "面粉不应因野味买不到而增加");
  valid(on, "再分配");
});

test("外镇的野味需求按需激活：我们的批发市场第一次有野味之后才参与消耗与繁荣度", () => {
  const state = simulation.createInitialState({ seed: 91 });
  simulation.advanceDay(state);
  const town = state.outsideTowns.minzhen;
  assert.equal(town.activeGoods?.wild_game, undefined, "没有野味时不激活");
  assert.ok(CONTENT.outsideTowns.minzhen.goods.wild_game, "档案里有野味需求");
  ensureWholesaleMarket(state, CONTENT);
  state.wholesaleMarket.inventory.wild_game = 100 * I;
  simulation.advanceDay(state);
  assert.equal(state.outsideTowns.minzhen.activeGoods.wild_game, true);
  assert.equal(state.outsideTowns.wangzhen.activeGoods.wild_game, true);
  valid(state, "外镇激活");
});

test("贸易行野味出口门槛为 5%（商品级），盐仍按全局门槛", () => {
  const state = simulation.createInitialState({ seed: 91 });
  assert.equal(CONTENT.rules.tradeHouseMarginPercentByItem.wild_game, 5);
  const wildTarget = tradeMarginTarget(state, CONTENT, "export", GAME);
  assert.ok(Math.abs(wildTarget - 1.05) < 1e-9, `野味门槛 1.05，实际 ${wildTarget}`);
  const saltTarget = tradeMarginTarget(state, CONTENT, "export", "salt");
  assert.ok(Math.abs(saltTarget - tradeMarginTarget(state, CONTENT, "export")) < 1e-9);
});
