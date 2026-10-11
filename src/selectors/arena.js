// 斗兽场界面数据（只读，金银消费第四期）：不写 state。金额换算成粮券，实物换算成斤。
import { arenaAttendanceFactor, arenaBuilding, arenaExcitement, arenaHunterCount, arenaPolicy, arenaShopOf, arenaStaffCount } from "../systems/arena.js";
import { serviceShopCapacityUses } from "../systems/shops.js";

const MONEY_FIELDS = ["feedVoucherUnits", "ticketVoucherUnits", "rakeVoucherUnits", "betVoucherUnits", "payoutVoucherUnits"];
const JIN_UNIT_FIELDS = ["gameUnits", "gameDepositedUnits", "gameSpoiledUnits"];

// 账本（三段记账的一段）→ 界面口径：金额为粮券，野味为斤（feedJin 本身已是斤）。
function bookView(book, content) {
  if (!book) return null;
  const money = content.precision.currencyUnitsPerVoucher;
  const scale = content.precision.inventoryUnitsPerJin;
  const row = { ...book };
  for (const key of MONEY_FIELDS) row[key.replace(/Units$/, "")] = (book[key] || 0) / money;
  for (const key of JIN_UNIT_FIELDS) row[key.replace(/Units$/, "Jin")] = (book[key] || 0) / scale;
  return row;
}

export function selectArena(state, content) {
  const building = arenaBuilding(state);
  const arena = state.arena || {};
  const cfg = content.rules.arena;
  const policy = arenaPolicy(state, content);
  const money = content.precision.currencyUnitsPerVoucher;
  const base = {
    built: Boolean(building),
    buildingId: building?.id || null,
    beasts: arena.beasts || 0,
    excitement: arenaExcitement(arena.beasts || 0, cfg),
    attendanceFactor: arenaAttendanceFactor(state, content),
    policy,
    ticketVoucher: state.services?.pricesVoucherPerUse?.arena ?? content.rules.serviceTypes.arena.priceVoucher,
    feedPerDayJin: (arena.beasts || 0) * cfg.feedPerBeastDayJin,
    feedJinPerBeastDay: cfg.feedPerBeastDayJin,
    gamePerBeastJin: cfg.gamePerBeastJin,
    hunters: building ? arenaHunterCount(state, building) : 0,
    staff: building ? arenaStaffCount(state, building) : 0,
    maxSeats: cfg.maxSeats,
    today: arena.today ? { ...arena.today, betVoucher: (arena.today.betUnits || 0) / money, payoutVoucher: (arena.today.payoutUnits || 0) / money,
      rakeVoucher: (arena.today.rakeUnits || 0) / money, ticketVoucher: (arena.today.ticketUnits || 0) / money,
      feedVoucher: (arena.today.feedVoucherUnits || 0) / money } : null,
    year: bookView(arena.year, content),
    cumulative: bookView(arena.cumulative, content)
  };
  const shop = arenaShopOf(state);
  if (!shop) return { ...base, seats: 0, shopStatus: null, shopStatusReason: building ? "待开张" : "", shopProfitDayVoucher: 0, shopProfitYearVoucher: 0 };
  return {
    ...base,
    seats: serviceShopCapacityUses(state, shop, content),
    shopStatus: shop.status,
    shopStatusReason: shop.statusReason || "",
    shopProfitDayVoucher: (shop.accounts?.day?.profitVoucherUnits || 0) / money,
    shopProfitYearVoucher: (shop.accounts?.year?.profitVoucherUnits || 0) / money
  };
}
