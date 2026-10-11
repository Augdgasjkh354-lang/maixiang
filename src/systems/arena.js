// 巨型斗兽场（金银消费第四期）。
//
// 建筑 arena（镇营、单级、一座）内置一个镇营观赛店（店型 arena，shop.arena 标记；店员 = 场务岗位，见 shops.js 的 openArenaShop）。
// - 猎手（hunters）每人每日抓 capturePerHunterDay 只兽，实际 = min(猎手产能, 政策抓兽目标, 存栏空位)。
// - 存栏兽每天吃 feedPerBeastDayJin 斤小麦，从镇库买（留口粮储备线，同养牛场的饲料口径）；喂不饱的兽按比例饿死，饿死的不产野味。
// - 搏斗：每日 min(政策搏斗数, 存栏) 只兽上场，每只产 gamePerBeastJin 斤野味，统购入批发市场；超过备货天数的野味不入库，记损耗。
// - 观众：票价由服务框架定价（configureServicePrice，默认 1 券）；出席的家庭当日按户押注（押注额 = 基础押注 × excitement × 张数，
//   不超过买完票后剩余预算的一半，预算已扣口粮储备）。搏斗有比赛才押注。押注总额 S：抽成 S × rake 归镇库，其余按随机选出的赢家分配
//   （按押注额 × 随机系数）。每户一天一笔净结算（settleBets），付款走正常支付（手头粮券不够可以以粮换券）。
// - 账：票房、抽成、饲料成本记在斗兽场店（镇营店，收入直接进镇库，饲料为店的成本）；押注与奖金记在 state.arena 三段账。
// 出席意愿：arenaAttendanceFactor（存栏满额 1.0 时无影响，excitement 每偏离 1 摆动 attendanceSwing）。服务框架见 systems/services.js。

import { currencyScale } from "../economy/currency.js";
import { householdOwner } from "../economy/accounts.js";
import { ensureBook, bookAdd } from "../economy/books.js";
import { currentPaymentComposition, settleMonetaryPayment } from "../economy/payment.js";
import { atomicInventoryTransaction } from "../economy/inventory.js";
import { nextRandom } from "../core/random.js";
import { isActiveHousehold, reserveWheatFullPaymentOptions } from "./households.js";
import { jobKeyForBuilding, readJobCount } from "../selectors/labor.js";
import { addBookValue, applyProfit, openArenaShop, serviceShopCapacityUses } from "./shops.js";
import {
  depositProductionTaxToWholesale, hasWholesaleMarket, townOutputMarketRoomUnits, townWheatSaleReserveUnits
} from "./wholesale-market.js";

export const ARENA_TYPE_ID = "arena";
export const ARENA_SERVICE_ID = "arena";
export const ARENA_HUNTER_ROLE = "hunters";
export const ARENA_STAFF_ROLE = "arena_staff";
const GAME_ITEM_ID = "wild_game";

const POLICY_LABELS = Object.freeze({
  dailyCaptureTarget: "每日抓兽数",
  dailyFights: "每日搏斗数",
  rakePercent: "押注抽成",
  beastCapacity: "存栏上限"
});

export function blankArenaPeriod() {
  return {
    capturedBeasts: 0, starvedBeasts: 0, fights: 0,
    feedJin: 0, feedVoucherUnits: 0,
    gameUnits: 0, gameDepositedUnits: 0, gameSpoiledUnits: 0,
    ticketVoucherUnits: 0, rakeVoucherUnits: 0, betVoucherUnits: 0, payoutVoucherUnits: 0,
    bettors: 0, winners: 0, attendance: 0
  };
}

export function ensureArena(state) {
  state.arena ||= { beasts: 0, beastCarry: 0, opened: false, day: {}, year: {}, cumulative: {} };
  const arena = state.arena;
  arena.beasts = Math.max(0, Math.floor(Number(arena.beasts) || 0));
  arena.beastCarry = Math.min(1, Math.max(0, Number(arena.beastCarry) || 0));
  arena.opened = Boolean(arena.opened);
  ensureBook(arena, blankArenaPeriod);
  return arena;
}

export function resetArenaDay(state) {
  if (state.arena) state.arena.day = blankArenaPeriod();
}

export function resetArenaYear(state) {
  if (state.arena) state.arena.year = blankArenaPeriod();
}

// 政策：state.policy.arena 缺项时用默认值（content.rules.arena.defaults）。
export function arenaPolicy(state, content) {
  const defaults = content.rules.arena.defaults;
  const raw = state.policy?.arena || {};
  const read = key => (Number.isFinite(raw[key]) ? raw[key] : defaults[key]);
  return {
    dailyCaptureTarget: read("dailyCaptureTarget"),
    dailyFights: read("dailyFights"),
    rakePercent: read("rakePercent"),
    beastCapacity: read("beastCapacity")
  };
}

// 政策命令：校验类型与范围（范围在 content.rules.arena.ranges），抽成保留一位小数，其余取整数。
export function setArenaPolicy(state, patch = {}, content) {
  const ranges = content.rules.arena.ranges;
  const next = {};
  for (const key of Object.keys(patch || {})) {
    if (!(key in ranges)) return { ok: false, reason: `斗兽场没有「${key}」这项政策` };
    if (patch[key] === undefined) continue;
    const [min, max] = ranges[key];
    const value = typeof patch[key] === "string" && patch[key].trim() === "" ? NaN : Number(patch[key]);
    if (!Number.isFinite(value) || value < min || value > max) return { ok: false, reason: `${POLICY_LABELS[key] || key}须为${min}—${max}之间的有限数` };
    next[key] = key === "rakePercent" ? Math.round(value * 10) / 10 : Math.round(value);
  }
  state.policy ||= {};
  state.policy.arena = { ...arenaPolicy(state, content), ...next };
  return { ok: true, value: { ...state.policy.arena } };
}

export function arenaBuilding(state) {
  return (state.buildings || []).find(building => building.typeId === ARENA_TYPE_ID) || null;
}

export function arenaShopOf(state) {
  return Object.values(state.shops || {}).find(shop => shop.arena && shop.status !== "closed" && shop.status !== "liquidating") || null;
}

export function arenaHunterCount(state, building) {
  return building ? readJobCount(state, jobKeyForBuilding(building.id, ARENA_HUNTER_ROLE)) : 0;
}

export function arenaStaffCount(state, building) {
  return building ? readJobCount(state, jobKeyForBuilding(building.id, ARENA_STAFF_ROLE)) : 0;
}

// 兴奋度：存栏 ÷ beastsPerExcitement，夹在 excitementMin—excitementMax。
export function arenaExcitement(beasts, cfg) {
  return Math.min(cfg.excitementMax, Math.max(cfg.excitementMin, beasts / cfg.beastsPerExcitement));
}

// 出席意愿修正（服务框架的 demandModifier）：没有兽就没有比赛，不累计需求；否则 1 + swing × (excitement − 1)。
export function arenaAttendanceFactor(state, content) {
  const beasts = state.arena?.beasts || 0;
  if (!(beasts > 0)) return 0;
  const cfg = content.rules.arena;
  return 1 + cfg.attendanceSwing * (arenaExcitement(beasts, cfg) - 1);
}

// 每日同步（日结 arenaSync 步，在店铺准备之前）：有斗兽场建筑就有观赛店，首日放入开场存栏；
// 没有建筑（拆除）则撤店、清零存栏。
export function syncArena(state, content) {
  const arena = ensureArena(state);
  const building = arenaBuilding(state);
  if (!building) {
    if (arena.opened || arena.beasts || arenaShopOf(state)) windUpArena(state);
    return null;
  }
  if (!arena.opened) {
    arena.beasts = content.rules.arena.openingBeasts;
    arena.beastCarry = 0;
    arena.opened = true;
  }
  return arenaShopOf(state) || openArenaShop(state, building, content);
}

// 拆除：撤掉观赛店，存栏清零（兽不计入任何资产）。
export function windUpArena(state) {
  for (const shop of Object.values(state.shops || {})) if (shop.arena) delete state.shops[shop.id];
  if (state.arena) {
    state.arena.beasts = 0;
    state.arena.beastCarry = 0;
    state.arena.opened = false;
  }
}

// 抓兽：min(猎手 × capturePerHunterDay, 每日抓兽目标, 存栏空位)。
function captureBeasts(state, arena, building, policy, cfg) {
  const hunters = arenaHunterCount(state, building);
  const space = Math.max(0, policy.beastCapacity - arena.beasts);
  const captured = Math.max(0, Math.min(hunters * cfg.capturePerHunterDay, policy.dailyCaptureTarget, space));
  arena.beasts += captured;
  bookAdd(arena, "capturedBeasts", captured);
  return captured;
}

// 喂养：每只兽每日 feedPerBeastDayJin 斤小麦，从镇库买（留口粮储备线，买到的当日消耗）。返回喂饱比例与成本（券）。
function feedBeasts(state, arena, content) {
  const cfg = content.rules.arena;
  const scale = content.precision.inventoryUnitsPerJin;
  const need = Math.ceil(arena.beasts * cfg.feedPerBeastDayJin * scale);
  if (need <= 0) return { fraction: 1, takenUnits: 0, costVoucherUnits: 0 };
  const reserve = townWheatSaleReserveUnits(state, content);
  const available = Math.max(0, (state.accounts?.town?.wheat || 0) - reserve);
  const wanted = Math.min(available, need);
  let taken = 0;
  if (wanted > 0) {
    const result = atomicInventoryTransaction(state, {
      inputs: [{ owner: "town", itemId: "wheat", quantityUnits: wanted, type: "arena_feed", destination: "arena_beasts" }],
      outputs: []
    }, content);
    if (result.ok) taken = wanted;
  }
  const wheatPrice = content.rules.marketPricesVoucherPerUnit?.wheat ?? 1;
  const cost = Math.round(taken / scale * wheatPrice * currencyScale(content));
  return { fraction: taken / need, takenUnits: taken, costVoucherUnits: cost };
}

// 饿死：喂不饱的比例 × 存栏，余数累计（beastCarry）；饿死的兽不上场、不产野味。
function starveBeasts(arena, fraction) {
  const exact = arena.beasts * (1 - fraction) + arena.beastCarry;
  let starved = Math.floor(exact + 1e-9);
  arena.beastCarry = Math.max(0, exact - starved);
  starved = Math.min(starved, arena.beasts);
  arena.beasts -= starved;
  bookAdd(arena, "starvedBeasts", starved);
  return starved;
}

// 野味统购入批发市场：有市场时不超过备货天数的余量入库（镇营产出闸门 townOutputMarketRoomUnits），超出的记损耗；没有市场则全部损耗。
function depositGame(state, units, content) {
  if (!(units > 0)) return { intake: 0, spoiled: 0 };
  let intake = 0;
  if (hasWholesaleMarket(state)) {
    const room = Math.max(0, Math.floor(townOutputMarketRoomUnits(state, GAME_ITEM_ID, content)));
    intake = Math.min(units, room);
    if (intake > 0) {
      const result = depositProductionTaxToWholesale(state, GAME_ITEM_ID, intake, 0, content,
        { source: "arena", reason: "斗兽场野味统购入市（内部无偿）" });
      if (!result.ok) intake = 0;
    }
  }
  return { intake, spoiled: units - intake };
}

// 押注（按户，一户一天一笔净结算）：押注额 = 基础押注 × excitement × 张数，不超过买票后剩余预算的一半。
// 预算已扣掉口粮储备（systems/services.js 的服务预算），净付款走正常支付（手头粮券不够可以以粮换券，同买票）。
// 押注总额 S 进镇库；抽成 S × rake 留在镇库；其余按随机选出的赢家（约 winnerShare）按押注额 × 随机系数分配。
// 每户只做一笔净结算（赢的 − 输的）：净付款的户先付（付给镇库），净收款的户后收（镇库付出）；镇库付出不超过已收到的押注。
// 返回：bet = 押注总额（名义）、payout = 实际付出的奖金、rake = bet − payout（镇库留下的抽成，付不出的奖金也留在这里）。
function settleBets(state, content, excitement, policy) {
  const cfg = content.rules.arena;
  const money = currencyScale(content);
  const rows = (state.services?.day?.wagerAttendees?.[ARENA_SERVICE_ID]) || {};
  const stakePerTicket = Math.round(cfg.baseStakeVoucher * excitement * money);
  const bettors = [];
  for (const householdId of Object.keys(rows).sort()) {
    const household = state.households?.byId?.[householdId];
    if (!household || !isActiveHousehold(household)) continue;
    const { tickets, budgetLeftUnits } = rows[householdId];
    const bet = Math.min(stakePerTicket * tickets, Math.floor(Math.max(0, budgetLeftUnits) / 2));
    if (bet <= 0) continue;
    bettors.push({ householdId, owner: householdOwner(householdId), name: household.name, bet, reserve: reserveWheatFullPaymentOptions(state, household, content, content.rules.basicCommerceFoodReserveDays ?? 30) });
  }
  const pool = bettors.reduce((sum, row) => sum + row.bet, 0);
  if (pool <= 0) return { bettors: 0, winners: 0, betUnits: 0, payoutUnits: 0, rakeUnits: 0 };
  const rake = Math.round(pool * policy.rakePercent / 100);
  const payoutPool = pool - rake;
  let winners = bettors.filter(() => nextRandom(state) < cfg.winnerShare);
  if (!winners.length) winners = [bettors.reduce((best, row) => (row.bet > best.bet ? row : best))];
  const weights = winners.map(row => row.bet * (0.5 + nextRandom(state)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const gains = new Map(winners.map((row, index) => [row.householdId, Math.floor(payoutPool * weights[index] / totalWeight)]));
  gains.set(winners[0].householdId, gains.get(winners[0].householdId) + payoutPool - [...gains.values()].reduce((sum, amount) => sum + amount, 0));
  // 净额 = 赢的 − 押注；先收（净付款的户），收到多少才付多少（付不出的那几户不影响镇库）。
  const net = bettors.map(row => ({ ...row, net: (gains.get(row.householdId) || 0) - row.bet }));
  let cash = 0;
  let retained = 0;
  for (const row of net.filter(item => item.net < 0)) {
    const payment = settleMonetaryPayment(state, row.owner, "town", currentPaymentComposition(state, -row.net), content,
      "arena_bet", `${row.name}斗兽押注净付`, { requireFull: true, ...row.reserve });
    if (payment.ok) { cash += -row.net; retained += -row.net; }
  }
  for (const row of net.filter(item => item.net > 0)) {
    const amount = Math.min(row.net, cash);
    if (amount <= 0) continue;
    const payment = settleMonetaryPayment(state, "town", row.owner, currentPaymentComposition(state, amount), content,
      "arena_payout", `${row.name}斗兽押注中奖`, { requireFull: true });
    if (payment.ok) { cash -= amount; retained -= amount; }
  }
  // 镇库从押注者手里实际留下的钱 = 抽成（全部付清时等于 押注 × 抽成率）；其余是返还押注者的奖金。
  return { bettors: bettors.length, winners: winners.length, betUnits: pool, payoutUnits: pool - retained, rakeUnits: retained };
}

// 日结（arena 步，在服务之后）：抓兽 → 喂养 → 饿死 → 兴奋度 → 搏斗 → 野味入市 → 押注结算 → 店账。
export function settleArenaDay(state, content) {
  const arena = ensureArena(state);
  const building = arenaBuilding(state);
  const shop = arenaShopOf(state);
  if (!building || !shop) {
    arena.today = null;
    return null;
  }
  const cfg = content.rules.arena;
  const policy = arenaPolicy(state, content);
  const scale = content.precision.inventoryUnitsPerJin;
  const captured = captureBeasts(state, arena, building, policy, cfg);
  const feed = feedBeasts(state, arena, content);
  if (feed.takenUnits > 0) {
    bookAdd(arena, "feedJin", feed.takenUnits / scale);
    bookAdd(arena, "feedVoucherUnits", feed.costVoucherUnits);
    addBookValue(shop, "cogsVoucherUnits", feed.costVoucherUnits);
    applyProfit(shop, -feed.costVoucherUnits);
  }
  const starved = starveBeasts(arena, feed.fraction);
  const excitement = arenaExcitement(arena.beasts, cfg);
  const fights = Math.min(policy.dailyFights, arena.beasts);
  arena.beasts -= fights;
  bookAdd(arena, "fights", fights);
  const gameUnits = fights * cfg.gamePerBeastJin * scale;
  const game = depositGame(state, gameUnits, content);
  bookAdd(arena, "gameUnits", gameUnits);
  bookAdd(arena, "gameDepositedUnits", game.intake);
  bookAdd(arena, "gameSpoiledUnits", game.spoiled);
  // 票房：服务框架已把票款付给镇库并记在店账（收入）；这里按当日店账收入记票房。
  const ticketUnits = shop.accounts?.day?.revenueVoucherUnits || 0;
  const attendance = shop.accounts?.day?.serviceUses?.[ARENA_SERVICE_ID] || 0;
  const bets = fights > 0 && attendance > 0 ? settleBets(state, content, excitement, policy)
    : { bettors: 0, winners: 0, betUnits: 0, payoutUnits: 0, rakeUnits: 0 };
  if (bets.rakeUnits > 0) {
    addBookValue(shop, "revenueVoucherUnits", bets.rakeUnits);
    applyProfit(shop, bets.rakeUnits);
  }
  bookAdd(arena, "ticketVoucherUnits", ticketUnits);
  bookAdd(arena, "rakeVoucherUnits", bets.rakeUnits);
  bookAdd(arena, "betVoucherUnits", bets.betUnits);
  bookAdd(arena, "payoutVoucherUnits", bets.payoutUnits);
  bookAdd(arena, "bettors", bets.bettors);
  bookAdd(arena, "winners", bets.winners);
  bookAdd(arena, "attendance", attendance);
  arena.today = {
    hunters: arenaHunterCount(state, building),
    staff: arenaStaffCount(state, building),
    captured, starved, fights, bettors: bets.bettors,
    excitement: Math.round(excitement * 1000) / 1000,
    feedFraction: Math.round(feed.fraction * 1000) / 1000,
    seats: serviceShopCapacityUses(state, shop, content),
    attendance,
    stock: arena.beasts,
    gameUnits,
    gameDepositedUnits: game.intake,
    gameSpoiledUnits: game.spoiled,
    betUnits: bets.betUnits,
    payoutUnits: bets.payoutUnits,
    rakeUnits: bets.rakeUnits,
    ticketUnits,
    feedJin: feed.takenUnits / scale,
    feedVoucherUnits: feed.costVoucherUnits,
    capacityBeasts: policy.beastCapacity
  };
  return arena.today;
}
