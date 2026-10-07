import { nextRandom } from "../core/random.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { addInventory, changeInventory, quantityToUnits, unitsToQuantity } from "../economy/inventory.js";
import { hasWholesaleMarket, readWholesaleMarket, ensureWholesaleMarket, takeWholesaleInventoryForExport } from "./wholesale-market.js";
import { jobKeyForBuilding, readJobCount } from "../selectors/labor.js";

// 民镇（原「四地主镇」）：纯贸易伙伴，不做完整模拟，只用动态算法维持基础数值。
// 民镇议事会执政的农业小镇：1万亩、1000劳动力，主产小麦，有面粉店/面包店；
// 盐、木材零自产、按人按年消耗，完全依赖我方贸易；贸易以小麦斤计价：
// 本镇可卖面粉/面包/盐/木材，可买面粉/面包。
// 结算走实物小麦（镇小麦库存 <-> 外镇小麦库存），不印新券，不破坏货币恒等式。

export const OUTSIDE_TOWN_NAME = "民镇";
export const OUTSIDE_TOWN_LEGACY_NAME = "四地主镇";
export const OUTSIDE_RULERS = ["民镇议事会"];
export const OUTSIDE_RULERS_LEGACY = ["陈", "王", "李", "赵"];
export const TRADE_SELL_ITEMS = ["flour", "bread", "salt", "wood"];
export const TRADE_BUY_ITEMS = ["flour", "bread"];
// 民镇每年每人的盐、木材需求（零自产，全靠我方贸易供给）。
export const SALT_JIN_PER_PERSON_YEAR = 10;
export const WOOD_UNITS_PER_PERSON_YEAR = 4;
export const DEFAULT_SALT_STOCK_JIN = 20000;
export const DEFAULT_WOOD_STOCK_UNITS = 8000;
// 库存软上限：超出部分每年减半，防止无限囤积。
export const SALT_STOCK_SOFT_CAP_JIN = 70000;
export const WOOD_STOCK_SOFT_CAP_UNITS = 28000;
// 警戒线：库存低于 90 天消耗时，该物资收购价 ×1.5。
export const SUPPLY_WARNING_DAYS = 90;
export const SUPPLY_WARNING_PRICE_FACTOR = 1.5;
// 囤积程度决定收购价：库存/年需求 为 0 时 1.8 倍，1 年 1.3 倍，2 年 0.8 倍，3 年以上 0.5 倍。
export const STOCK_PRICE_FACTOR_MAX = 1.8;
export const STOCK_PRICE_FACTOR_MIN = 0.5;
export const MAX_TRADE_JIN_PER_ORDER = 100000;
export const PRICE_ELASTICITY = 1.0;
export const MEMORY_DECAY_PER_DAY = 0.995;
export const DEFAULT_TRADE_TARIFF_PERCENT = 5;
export const MAX_TRADE_TARIFF_PERCENT = 30;
export const RELATIONS_DEFAULT = 60;
export const RELATIONS_MAX = 100;
export const RELATIONS_TRUSTED = 70;
export const RELATIONS_DISTRUST = 40;
export const RELATIONS_BREAKOFF = 20;
export const RELATIONS_GAIN_PER_DAY = 0.2;
export const RELATIONS_LOSS_PER_DAY = 0.5;
// 长协容量：外贸房每人在岗可跟进的长协笔数（trade-agreements.js 共用）。
export const AGREEMENTS_PER_STAFF = 2;

// 民镇收购价（我们卖出）：小麦斤/单位。盐、木材零自产，实际价格由库存比驱动。
// 小麦不做贸易商品（镇库直管的战略物资），只做结算货币；缺粮时走小麦贷款。
// 基准价按我方成本+合理利润：木材成本5→9，盐成本1→4，面粉成本1.33→2，面包成本1.16→1.8。
const BASE_BUY_PRICE = { flour: 2.2, bread: 2, salt: 4, wood: 9 };
// 民镇售价（我们买入）
const BASE_SELL_PRICE = { flour: 1.55, bread: 1.9 };
const YIELD_PER_MU_JIN = 600;
const FOOD_PER_PERSON_DAY_JIN = 2;

// 民镇年需求（按实际人口折算，不是写死 3500）。
export function outsideTownAnnualSaltJin(ot) {
  return Math.max(0, (ot?.population || 0) * SALT_JIN_PER_PERSON_YEAR);
}
export function outsideTownAnnualWoodUnits(ot) {
  return Math.max(0, (ot?.population || 0) * WOOD_UNITS_PER_PERSON_YEAR);
}
// 90 天警戒线（盐斤 / 木材单位）。
export function outsideTownSaltWarningJin(ot) {
  return outsideTownAnnualSaltJin(ot) * SUPPLY_WARNING_DAYS / 365;
}
export function outsideTownWoodWarningUnits(ot) {
  return outsideTownAnnualWoodUnits(ot) * SUPPLY_WARNING_DAYS / 365;
}

export function ensureOutsideTown(state) {
  const ot = state.outsideTown ||= {};
  applyOutsideTownDefaults(ot, ot);
  return ot;
}

// 只读版本：供 selector/UI 使用，不回写游戏状态（0.1.8 selector 纯度要求）。
export function readOutsideTown(state) {
  const ot = {};
  applyOutsideTownDefaults(ot, state.outsideTown || {});
  return ot;
}

function applyOutsideTownDefaults(ot, source) {
  const src = source || {};
  ot.name = ot.name ?? src.name ?? OUTSIDE_TOWN_NAME;
  // 老存档迁移：四地主镇已改名民镇（同上，保留玩家自行改过的名字）。
  if (ot.name === OUTSIDE_TOWN_LEGACY_NAME) ot.name = OUTSIDE_TOWN_NAME;
  ot.rulers = ot.rulers ?? (src.rulers ? [...src.rulers] : [...OUTSIDE_RULERS]);
  // 老存档迁移：四地主已改为民镇议事会。
  if (Array.isArray(ot.rulers) && ot.rulers.length === OUTSIDE_RULERS_LEGACY.length &&
      OUTSIDE_RULERS_LEGACY.every((name, i) => ot.rulers[i] === name)) {
    ot.rulers = [...OUTSIDE_RULERS];
  }
  ot.landMu = ot.landMu ?? src.landMu ?? 10000;
  ot.laborers = ot.laborers ?? src.laborers ?? 1000;
  ot.population = ot.population ?? src.population ?? 3500;
  ot.wheatStockJin = ot.wheatStockJin ?? src.wheatStockJin ?? 3000000;
  // 民镇盐/木材库存（斤 / 单位）：零自产，只有我方出口能增加，每年按人口消耗。
  ot.saltStockJin = ot.saltStockJin ?? src.saltStockJin ?? DEFAULT_SALT_STOCK_JIN;
  ot.woodStockUnits = ot.woodStockUnits ?? src.woodStockUnits ?? DEFAULT_WOOD_STOCK_UNITS;
  ot.saltShortageYears = ot.saltShortageYears ?? src.saltShortageYears ?? 0;
  ot.woodShortageYears = ot.woodShortageYears ?? src.woodShortageYears ?? 0;
  ot.lastYearSaltConsumptionJin = ot.lastYearSaltConsumptionJin ?? src.lastYearSaltConsumptionJin ?? 0;
  ot.lastYearWoodConsumptionUnits = ot.lastYearWoodConsumptionUnits ?? src.lastYearWoodConsumptionUnits ?? 0;
  // 外交关系分（0—100）：外交房有人值守则缓慢回升，无人则下滑；脏数据时回落默认值。
  ot.relations = Number.isFinite(ot.relations) ? ot.relations
    : (Number.isFinite(src.relations) ? src.relations : RELATIONS_DEFAULT);
  ot.prosperity = ot.prosperity ?? src.prosperity ?? 60;
  ot.saltDemand = ot.saltDemand ?? src.saltDemand ?? 1.4;
  ot.woodDemand = ot.woodDemand ?? src.woodDemand ?? 1.3;
  // 注：saltDemand/woodDemand 是旧版固定需求乘数，已不再参与定价（改由库存比驱动）。
  // 保留字段只为存档与视图兼容，不再做均值回归。
  ot.grainDemand = ot.grainDemand ?? src.grainDemand ?? 0.7;
  ot.weather = ot.weather ?? src.weather ?? 1.0;
  ot.event = ot.event ?? src.event ?? null;
  ot.tradeClosed = ot.tradeClosed ?? src.tradeClosed ?? false;
  ot.buyPrices = ot.buyPrices ?? {};
  ot.sellPrices = ot.sellPrices ?? {};
  ot.tradeMemory = ot.tradeMemory ?? {};
  const srcBuy = src.buyPrices || {};
  const srcSell = src.sellPrices || {};
  const srcMemory = src.tradeMemory || {};
  for (const itemId of TRADE_SELL_ITEMS) {
    const buyPrice = ot.buyPrices[itemId] ?? srcBuy[itemId];
    ot.buyPrices[itemId] = Number.isFinite(buyPrice) && buyPrice > 0 ? buyPrice : BASE_BUY_PRICE[itemId];
    const memory = ot.tradeMemory[itemId] ?? srcMemory[itemId];
    ot.tradeMemory[itemId] = Number.isFinite(memory) ? memory : 0;
  }
  for (const itemId of TRADE_BUY_ITEMS) {
    const sellPrice = ot.sellPrices[itemId] ?? srcSell[itemId];
    ot.sellPrices[itemId] = Number.isFinite(sellPrice) && sellPrice > 0 ? sellPrice : BASE_SELL_PRICE[itemId];
  }
  ot.stats = ot.stats ?? {};
  const srcStats = src.stats || {};
  for (const key of ["exportJin", "importJin", "tariffJin", "trades", "yearExportJin", "yearImportJin", "yearTariffJin"]) {
    const value = ot.stats[key] ?? srcStats[key];
    ot.stats[key] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  if (ot.lastYearProductionJin === undefined) ot.lastYearProductionJin = src.lastYearProductionJin || 0;
  if (ot.lastYearConsumptionJin === undefined) ot.lastYearConsumptionJin = src.lastYearConsumptionJin || 0;
  // 小麦贷款：天灾欠收时本镇放贷给民镇，玩家定斤数和利息
  ot.loans = ot.loans ?? (Array.isArray(src.loans) ? src.loans.map(l => ({ ...l })) : []);
  ot.loanStats = ot.loanStats ?? {};
  const srcLoanStats = src.loanStats || {};
  for (const key of ["totalIssuedJin", "totalRepaidJin", "totalInterestJin", "activeLoans"]) {
    const value = ot.loanStats[key] ?? srcLoanStats[key];
    ot.loanStats[key] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return ot;
}

export function tradeTariffRate(state) {
  const value = Number(state.policy?.tradeTariffRate);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_TRADE_TARIFF_PERCENT;
  return Math.min(MAX_TRADE_TARIFF_PERCENT, value);
}

// 盐/木材收购价与民镇库存挂钩（放缓版）：
// 库存为 0 → 1.8 倍（抢购）；1 年库存 → 1.3 倍；2 年 → 0.8 倍；3 年以上 → 0.5 倍（囤满了就不想买了）。
// 旧公式 2.2-ratio 太陡：1 年库存就跌到 1.2 倍，配合贸易记忆能把木材压到成本线以下。
function stockDemandFactor(stock, annualDemand) {
  if (!(annualDemand > 0)) return 1;
  const stockRatio = Math.max(0, stock) / annualDemand;
  return Math.max(STOCK_PRICE_FACTOR_MIN, Math.min(STOCK_PRICE_FACTOR_MAX, 1.8 - stockRatio * 0.5));
}

// 警戒线恐慌加价：库存低于 90 天消耗时该物资收购价 ×1.5。
function shortagePanicFactor(stock, warningLevel) {
  if (!(warningLevel > 0)) return 1;
  return stock < warningLevel ? SUPPLY_WARNING_PRICE_FACTOR : 1;
}

function demandMultiplier(ot, itemId) {
  if (itemId === "salt") {
    return stockDemandFactor(ot.saltStockJin, outsideTownAnnualSaltJin(ot))
      * shortagePanicFactor(ot.saltStockJin, outsideTownSaltWarningJin(ot));
  }
  if (itemId === "wood") {
    return stockDemandFactor(ot.woodStockUnits, outsideTownAnnualWoodUnits(ot))
      * shortagePanicFactor(ot.woodStockUnits, outsideTownWoodWarningUnits(ot));
  }
  return Math.max(0.2, ot.grainDemand);
}

function prosperityFactor(ot) {
  return 0.7 + Math.max(0, Math.min(100, ot.prosperity)) / 100 * 0.6;
}

// 价格反馈（防刷钱核心）：本镇某商品净卖出越多 -> 外镇收购价越低；
// 净买入越多 -> 外镇售价越高。tradeMemory 以"净卖出斤数"为正。
// 反馈有 0.5 下限：卖再多收购价也不低于 5 折，避免把正常贸易压到成本线以下。
export function recomputePrices(state) {
  const ot = ensureOutsideTown(state);
  const prosperity = prosperityFactor(ot);
  for (const itemId of TRADE_SELL_ITEMS) {
    const memory = Math.max(0, ot.tradeMemory[itemId] || 0);
    const feedback = Math.max(0.5, 1 / (1 + PRICE_ELASTICITY * memory / 10000));
    ot.buyPrices[itemId] = clampPrice(BASE_BUY_PRICE[itemId] * demandMultiplier(ot, itemId) * prosperity * feedback);
  }
  for (const itemId of TRADE_BUY_ITEMS) {
    const memory = Math.max(0, -(ot.tradeMemory[itemId] || 0));
    const feedback = 1 + PRICE_ELASTICITY * memory / 10000;
    ot.sellPrices[itemId] = clampPrice(BASE_SELL_PRICE[itemId] * prosperity * feedback);
  }
  return ot;
}

function clampPrice(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(50, Math.max(0.05, Math.round(value * 100) / 100));
}

// 外交房助手（第三步）：该建筑存在且在岗人数 ≥1 才算运转。
export function buildingOperational(state, buildingId) {
  const building = (state.buildings || []).find(row => row.typeId === buildingId);
  if (!building) return false;
  return readJobCount(state, jobKeyForBuilding(building.id, jobStaffRoleId(buildingId))) >= 1;
}

export function buildingIdOfType(state, buildingId) {
  return (state.buildings || []).find(row => row.typeId === buildingId)?.id || null;
}

export function buildingStaffOnDuty(state, buildingId) {
  const id = buildingIdOfType(state, buildingId);
  if (!id) return 0;
  return readJobCount(state, jobKeyForBuilding(id, jobStaffRoleId(buildingId)));
}

// 民镇入库：盐按斤、木材按单位，其余品类民镇自产自足不入账。
export function addOutsideTownStock(ot, itemId, amount) {
  if (!(amount > 0)) return;
  if (itemId === "salt") ot.saltStockJin = Math.round((ot.saltStockJin + amount) * 100) / 100;
  else if (itemId === "wood") ot.woodStockUnits = Math.round((ot.woodStockUnits + amount) * 100) / 100;
}

function jobStaffRoleId(buildingId) {
  return buildingId === "foreign_trade_house" ? "trade_staff" : "diplomacy_staff";
}

// 与民镇比价的辅助：关税后到手净价（用于界面提示与关系分折扣展示）。
export function netOfTariff(price, state) {
  const rate = tradeTariffRate(state);
  return Math.round(price * (1 - rate / 100) * 100) / 100;
}

// 每日：贸易记忆缓慢衰减（价格向基准恢复），外交关系分漂移，重算价格。
export function advanceOutsideTownDay(state, content) {
  const ot = ensureOutsideTown(state);
  for (const itemId of TRADE_SELL_ITEMS) {
    ot.tradeMemory[itemId] = (ot.tradeMemory[itemId] || 0) * MEMORY_DECAY_PER_DAY;
    if (Math.abs(ot.tradeMemory[itemId]) < 0.01) ot.tradeMemory[itemId] = 0;
  }
  // 外交房在岗 ≥1 人：关系分缓慢回升；无人值守：关系分下滑。
  if (buildingOperational(state, "diplomacy_house")) {
    ot.relations = Math.min(RELATIONS_MAX, ot.relations + RELATIONS_GAIN_PER_DAY);
  } else {
    ot.relations = Math.max(0, ot.relations - RELATIONS_LOSS_PER_DAY);
  }
  recomputePrices(state);
  return { tradeClosed: ot.tradeClosed, relations: Math.round(ot.relations * 10) / 10 };
}

// 每年1月1日：天气抽签 -> 年产出/年消费 -> 库存/人口/繁荣度均值回归 -> 低概率年事件。
// 注意：调用方应把本函数放在 settleOneDay 末尾，避免扰动既有系统的随机数流。
export function settleOutsideTownYear(state, content) {
  const ot = ensureOutsideTown(state);
  ot.tradeClosed = false;
  ot.weather = Math.round((0.7 + nextRandom(state) * 0.6) * 100) / 100;
  let eventFactor = 1;
  let eventLabel = null;
  const roll = nextRandom(state);
  if (roll < 0.12) {
    const pick = nextRandom(state);
    if (pick < 0.3) {
      eventFactor = 0.55;
      eventLabel = "蝗灾";
      recordEvent(state, `${OUTSIDE_TOWN_NAME}遭蝗灾，收成大减，粮价看涨。`, content, { day: 1 });
    } else if (pick < 0.6) {
      eventFactor = 1.15;
      eventLabel = "丰收";
      recordEvent(state, `${OUTSIDE_TOWN_NAME}风调雨顺，喜获丰收，粮价走低。`, content, { day: 1 });
    } else if (pick < 0.8) {
      ot.tradeClosed = true;
      eventLabel = "商路中断";
      recordEvent(state, `山匪截断商路，今年无法与${OUTSIDE_TOWN_NAME}贸易。`, content, { day: 1 });
    } else {
      eventLabel = "盐荒";
      // 盐荒：盐仓减半；库存挂钩的价格机制会自动推高出价（与播报"出价高企"一致）。
      ot.saltStockJin = Math.round(ot.saltStockJin * 0.5 * 100) / 100;
      recordEvent(state, `${OUTSIDE_TOWN_NAME}闹盐荒，盐仓见底，对盐出价高企。`, content, { day: 1 });
    }
  }
  ot.event = eventLabel ? { type: eventLabel, year: state.year } : null;
  const production = ot.landMu * YIELD_PER_MU_JIN * ot.weather * eventFactor;
  const consumption = ot.population * FOOD_PER_PERSON_DAY_JIN * (content.rules.daysPerYear || 365);
  ot.wheatStockJin = Math.max(0, Math.round((ot.wheatStockJin + production - consumption) * 100) / 100);
  ot.lastYearProductionJin = Math.round(production);
  ot.lastYearConsumptionJin = Math.round(consumption);
  // 库存软上限：超出部分每年一半外销/酿酒/损耗掉，避免无限累积。
  const STOCK_SOFT_CAP_JIN = 6000000;
  if (ot.wheatStockJin > STOCK_SOFT_CAP_JIN) {
    ot.wheatStockJin = Math.round(STOCK_SOFT_CAP_JIN + (ot.wheatStockJin - STOCK_SOFT_CAP_JIN) * 0.5);
  }
  // 盐/木材年消耗：与小麦同节奏按年扣，零自产——不够就是断供。
  const saltDemandJin = outsideTownAnnualSaltJin(ot);
  const woodDemandUnits = outsideTownAnnualWoodUnits(ot);
  ot.lastYearSaltConsumptionJin = Math.round(saltDemandJin);
  ot.lastYearWoodConsumptionUnits = Math.round(woodDemandUnits);
  ot.saltStockJin = Math.max(0, Math.round((ot.saltStockJin - saltDemandJin) * 100) / 100);
  ot.woodStockUnits = Math.max(0, Math.round((ot.woodStockUnits - woodDemandUnits) * 100) / 100);
  // 软上限：囤积超量部分每年减半。
  if (ot.saltStockJin > SALT_STOCK_SOFT_CAP_JIN) {
    ot.saltStockJin = Math.round(SALT_STOCK_SOFT_CAP_JIN + (ot.saltStockJin - SALT_STOCK_SOFT_CAP_JIN) * 0.5);
  }
  if (ot.woodStockUnits > WOOD_STOCK_SOFT_CAP_UNITS) {
    ot.woodStockUnits = Math.round(WOOD_STOCK_SOFT_CAP_UNITS + (ot.woodStockUnits - WOOD_STOCK_SOFT_CAP_UNITS) * 0.5);
  }
  // 断供惩罚：库存归零（今年一斤没供上）民心动荡。
  ot.saltShortageYears = 0;
  ot.woodShortageYears = 0;
  if (ot.saltStockJin <= 0) {
    ot.saltShortageYears = 1;
    ot.prosperity = Math.round(Math.max(5, ot.prosperity - 15) * 10) / 10;
    recordEvent(state, `${OUTSIDE_TOWN_NAME}断盐，民心动荡。`, content, { day: 1 });
  }
  if (ot.woodStockUnits <= 0) {
    ot.woodShortageYears = 1;
    ot.prosperity = Math.round(Math.max(5, ot.prosperity - 8) * 10) / 10;
    recordEvent(state, `${OUTSIDE_TOWN_NAME}缺木材，修缮停滞。`, content, { day: 1 });
  }
  // 关系分过低：有概率直接断交。
  if (ot.relations < RELATIONS_BREAKOFF && nextRandom(state) < 0.3) {
    ot.tradeClosed = true;
    recordEvent(state, `${OUTSIDE_TOWN_NAME}与我镇关系破裂，商路断绝。`, content, { day: 1 });
  }
  // 人口/繁荣度/需求度均值回归 + 小扰动。
  const jitter = () => (nextRandom(state) - 0.5);
  ot.population = Math.round(Math.max(2500, Math.min(4500,
    ot.population + (3500 - ot.population) * 0.05 + jitter() * 40)));
  const grainBalance = ot.wheatStockJin > 0 ? 2 : -15;
  ot.prosperity = Math.round(Math.max(5, Math.min(100,
    ot.prosperity + (60 - ot.prosperity) * 0.08 + jitter() * 6 + grainBalance)) * 10) / 10;
  ot.grainDemand = Math.round(Math.max(0.3, Math.min(1.2,
    ot.grainDemand + (0.7 - ot.grainDemand) * 0.1 + jitter() * 0.05)) * 100) / 100;
  ot.stats.yearExportJin = 0;
  ot.stats.yearImportJin = 0;
  ot.stats.yearTariffJin = 0;
  recomputePrices(state);
  return {
    weather: ot.weather,
    event: eventLabel,
    productionJin: Math.round(production),
    wheatStockJin: ot.wheatStockJin,
    saltStockJin: ot.saltStockJin,
    woodStockUnits: ot.woodStockUnits,
    saltShortage: ot.saltShortageYears > 0,
    woodShortage: ot.woodShortageYears > 0
  };
}

// 玩家命令：与民镇贸易。direction: "sell"（我们卖出）/ "buy"（我们买入）。
// 以小麦斤计价、实物小麦结算：卖出 -> 民镇小麦库存减少、镇小麦库存增加；买入反之。
export function tradeWithOutsideTown(state, direction, itemId, quantityJin, content) {
  const ot = ensureOutsideTown(state);
  recomputePrices(state);
  if (ot.tradeClosed) return { ok: false, reason: `商路中断，今年无法与${OUTSIDE_TOWN_NAME}贸易` };
  // 关键按键进建筑：外贸房无人值守则现货贸易也做不了。
  if (!buildingOperational(state, "foreign_trade_house")) {
    return { ok: false, reason: "外贸房无人值守，无法开展贸易" };
  }
  if (direction !== "sell" && direction !== "buy") return { ok: false, reason: "贸易方向无效" };
  const sellable = direction === "sell" ? TRADE_SELL_ITEMS : TRADE_BUY_ITEMS;
  if (!sellable.includes(itemId)) {
    return { ok: false, reason: direction === "sell" ? "外镇不收购该商品" : "外镇不出售该商品" };
  }
  const item = content.items[itemId];
  if (!item) return { ok: false, reason: "未知商品" };
  let qty = Number(quantityJin);
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "数量必须大于0" };
  qty = Math.min(qty, MAX_TRADE_JIN_PER_ORDER);
  const price = direction === "sell" ? ot.buyPrices[itemId] : ot.sellPrices[itemId];
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: "价格无效" };
  const transactionId = makeTransactionId(state);

  if (direction === "sell") {
    // 先按外镇小麦库存把数量夹紧（他们没粮就付不起）。
    const affordableQty = Math.floor(ot.wheatStockJin / price * 100) / 100;
    if (affordableQty < 0.01) return { ok: false, reason: `${OUTSIDE_TOWN_NAME}小麦不足，付不起这笔货款` };
    qty = Math.min(qty, affordableQty);
    const qtyUnits = quantityToUnits(qty, content);
    if (qtyUnits <= 0) return { ok: false, reason: "数量过小" };
    // 出口货源（0.2.3 做市商机制）：优先从批发市场库存出货，不足部分从镇库补。
    // 之前只读镇库，批发市场有货也报"镇库存不足"。
    let remainingUnits = qtyUnits;
    let fromMarketUnits = 0;
    if (hasWholesaleMarket(state)) {
      const taken = takeWholesaleInventoryForExport(state, itemId, remainingUnits, content);
      fromMarketUnits = taken.units || 0;
      remainingUnits -= fromMarketUnits;
    }
    if (remainingUnits > 0) {
      const take = changeInventory(state, "town", itemId, -remainingUnits, `对${OUTSIDE_TOWN_NAME}出口${item.name}`, "trade_export", content, transactionId);
      if (!take.ok) {
        // 镇库也不够：把批发市场已扣的回滚，避免货款两空。
        // 注意必须用 ensureWholesaleMarket 拿活对象——readWholesaleMarket 返回的是拷贝，写进去会被丢弃。
        if (fromMarketUnits > 0) {
          const market = ensureWholesaleMarket(state, content);
          market.inventory[itemId] = (market.inventory[itemId] || 0) + fromMarketUnits;
        }
        return { ok: false, reason: "批发市场与镇库存" + item.name + "不足" };
      }
      remainingUnits = 0;
    }
    const actualUnits = qtyUnits - Math.max(0, remainingUnits);
    const actualJin = unitsToQuantity(actualUnits, content);
    const valueJin = Math.round(actualJin * price * 100) / 100;
    ot.wheatStockJin = Math.round(Math.max(0, ot.wheatStockJin - valueJin) * 100) / 100;
    addInventory(state, "town", "wheat", valueJin, `对${OUTSIDE_TOWN_NAME}出口${item.name}所得`, "trade_export", content);
    const tariffJin = Math.round(valueJin * tradeTariffRate(state) / 100 * 100) / 100;
    ot.stats.exportJin = Math.round((ot.stats.exportJin + valueJin) * 100) / 100;
    ot.stats.yearExportJin = Math.round((ot.stats.yearExportJin + valueJin) * 100) / 100;
    ot.stats.tariffJin = Math.round((ot.stats.tariffJin + tariffJin) * 100) / 100;
    ot.stats.yearTariffJin = Math.round((ot.stats.yearTariffJin + tariffJin) * 100) / 100;
    ot.stats.trades += 1;
    ot.tradeMemory[itemId] = (ot.tradeMemory[itemId] || 0) + actualJin;
    // 民镇入库：盐/木材零自产，出口到货即入其库存（统一换算回 斤/单位口径）。
    addOutsideTownStock(ot, itemId, unitsToQuantity(actualUnits, content));
    if (tariffJin > 0) {
      recordLedger(state, {
        type: "trade_tariff", transactionId, source: "trade", destination: "town",
        itemId: "money_value", quantityUnits: quantityToUnits(tariffJin, content), qeqUnits: 0,
        reason: `对${OUTSIDE_TOWN_NAME}出口关税（${tradeTariffRate(state)}%）`
      }, content);
    }
    recomputePrices(state);
    return { ok: true, direction, itemId, quantityJin: actualJin, valueJin, tariffJin, priceWheatPerUnit: price };
  }

  // buy
  const valueJin = Math.round(qty * price * 100) / 100;
  const payUnits = quantityToUnits(valueJin, content);
  const pay = changeInventory(state, "town", "wheat", -payUnits, `从${OUTSIDE_TOWN_NAME}进口${item.name}付款`, "trade_import", content, transactionId);
  if (!pay.ok) return { ok: false, reason: "镇小麦库存不足以支付" };
  const actualPayJin = unitsToQuantity(payUnits, content);
  const actualQtyJin = Math.round(actualPayJin / price * 100) / 100;
  ot.wheatStockJin = Math.round((ot.wheatStockJin + actualPayJin) * 100) / 100;
  addInventory(state, "town", itemId, actualQtyJin, `从${OUTSIDE_TOWN_NAME}进口${item.name}`, "trade_import", content);
  ot.stats.importJin = Math.round((ot.stats.importJin + actualPayJin) * 100) / 100;
  ot.stats.yearImportJin = Math.round((ot.stats.yearImportJin + actualPayJin) * 100) / 100;
  ot.stats.trades += 1;
  ot.tradeMemory[itemId] = (ot.tradeMemory[itemId] || 0) - actualQtyJin;
  recomputePrices(state);
  return { ok: true, direction, itemId, quantityJin: actualQtyJin, valueJin: actualPayJin, tariffJin: 0, priceWheatPerUnit: price };
}

// 政策命令：调整出口关税税率（%）。
export function setTradeTariffRate(state, percent) {
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > MAX_TRADE_TARIFF_PERCENT) {
    return { ok: false, reason: `关税税率须在0—${MAX_TRADE_TARIFF_PERCENT}%之间` };
  }
  state.policy ||= {};
  state.policy.tradeTariffRate = value;
  return { ok: true, tradeTariffRate: value };
}

// 小麦贷款：天灾欠收时本镇放贷给民镇。玩家定斤数和年利率。
// 放贷：镇库小麦 -> 外镇小麦库存；还款：外镇按年结时从小麦库存扣还本付息。
export const MAX_LOAN_JIN = 1000000;
export const MAX_LOAN_RATE_PERCENT = 50;
export function issueWheatLoan(state, principalJin, annualRatePercent, content) {
  const ot = ensureOutsideTown(state);
  const principal = Math.round(Number(principalJin) * 100) / 100;
  const rate = Number(annualRatePercent);
  if (!Number.isFinite(principal) || principal <= 0) return { ok: false, reason: "贷款斤数须大于0" };
  if (principal > MAX_LOAN_JIN) return { ok: false, reason: `单笔贷款不超过${MAX_LOAN_JIN}斤` };
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_LOAN_RATE_PERCENT) {
    return { ok: false, reason: `年利率须在0—${MAX_LOAN_RATE_PERCENT}%之间` };
  }
  const scale = content.precision.inventoryUnitsPerJin;
  const units = Math.floor(principal * scale);
  if (units <= 0) return { ok: false, reason: "贷款斤数过小" };
  const townWheat = Math.max(0, state.accounts?.town?.wheat || 0);
  if (townWheat < units) return { ok: false, reason: "镇库小麦不足，放贷失败" };
  state.accounts.town.wheat = townWheat - units;
  ot.wheatStockJin = Math.round((ot.wheatStockJin + principal) * 100) / 100;
  const loan = {
    id: `loan-${state.year}-${state.day}-${ot.loans.length}`,
    principalJin: principal,
    annualRatePercent: Math.round(rate * 100) / 100,
    outstandingJin: principal,
    accruedInterestJin: 0,
    issueYear: state.year,
    issueDay: state.day,
    status: "active"
  };
  ot.loans.push(loan);
  ot.loanStats.totalIssuedJin = Math.round((ot.loanStats.totalIssuedJin + principal) * 100) / 100;
  ot.loanStats.activeLoans = ot.loans.filter(l => l.status === "active").length;
  const transactionId = makeTransactionId(state);
  recordLedger(state, {
    type: "wheat_loan_issue", transactionId, source: "town", destination: "outside_town",
    itemId: "wheat", quantityUnits: units, qeqUnits: 0,
    reason: `向${OUTSIDE_TOWN_NAME}发放小麦贷款${principal}斤，年利率${loan.annualRatePercent}%`
  }, content);
  recordEvent(state, `向${OUTSIDE_TOWN_NAME}发放小麦贷款${Math.round(principal)}斤（年利率${loan.annualRatePercent}%），解其天灾之急。`, content);
  return { ok: true, loan };
}

// 每年年结时：贷款计息 + 外镇从结余小麦中还款（先息后本）
export function settleWheatLoansYear(state, content) {
  const ot = ensureOutsideTown(state);
  let repaidJin = 0;
  let interestJin = 0;
  for (const loan of ot.loans) {
    if (loan.status !== "active") continue;
    // 计一年利息
    const yearInterest = Math.round(loan.outstandingJin * loan.annualRatePercent / 100 * 100) / 100;
    loan.accruedInterestJin = Math.round((loan.accruedInterestJin + yearInterest) * 100) / 100;
    // 外镇用结余小麦还款：先还利息，再还本金
    const totalDue = Math.round((loan.outstandingJin + loan.accruedInterestJin) * 100) / 100;
    const payable = Math.min(totalDue, Math.max(0, ot.wheatStockJin));
    if (payable > 0) {
      const payInterest = Math.min(loan.accruedInterestJin, payable);
      const payPrincipal = Math.min(loan.outstandingJin, payable - payInterest);
      loan.accruedInterestJin = Math.round((loan.accruedInterestJin - payInterest) * 100) / 100;
      loan.outstandingJin = Math.round((loan.outstandingJin - payPrincipal) * 100) / 100;
      ot.wheatStockJin = Math.round((ot.wheatStockJin - payInterest - payPrincipal) * 100) / 100;
      const townUnits = Math.floor((payInterest + payPrincipal) * content.precision.inventoryUnitsPerJin);
      state.accounts ||= {};
      state.accounts.town ||= {};
      state.accounts.town.wheat = (state.accounts.town.wheat || 0) + townUnits;
      repaidJin = Math.round((repaidJin + payInterest + payPrincipal) * 100) / 100;
      interestJin = Math.round((interestJin + payInterest) * 100) / 100;
      if (loan.outstandingJin <= 0.01 && loan.accruedInterestJin <= 0.01) {
        loan.status = "repaid";
        recordEvent(state, `${OUTSIDE_TOWN_NAME}还清小麦贷款（本金${loan.principalJin}斤）。`, content);
      }
    }
  }
  ot.loanStats.totalRepaidJin = Math.round((ot.loanStats.totalRepaidJin + repaidJin) * 100) / 100;
  ot.loanStats.totalInterestJin = Math.round((ot.loanStats.totalInterestJin + interestJin) * 100) / 100;
  ot.loanStats.activeLoans = ot.loans.filter(l => l.status === "active").length;
  if (repaidJin > 0) {
    recordLedger(state, {
      type: "wheat_loan_repay", transactionId: makeTransactionId(state),
      source: "outside_town", destination: "town", itemId: "wheat",
      quantityUnits: Math.floor(repaidJin * content.precision.inventoryUnitsPerJin), qeqUnits: 0,
      reason: `${OUTSIDE_TOWN_NAME}偿还小麦贷款${Math.round(repaidJin)}斤（含利息${Math.round(interestJin)}斤）`
    }, content);
  }
  return { repaidJin, interestJin };
}

// 供 UI/面板读取的视图数据（只读，不回写游戏状态）。
export function selectOutsideTownView(state, content) {
  const ot = readOutsideTown(state);
  const scale = content.precision.inventoryUnitsPerJin;
  const townStock = {};
  for (const itemId of TRADE_SELL_ITEMS) {
    townStock[itemId] = Math.round(((state.accounts?.town?.[itemId] || 0) / scale) * 100) / 100;
  }
  const annualSaltJin = outsideTownAnnualSaltJin(ot);
  const annualWoodUnits = outsideTownAnnualWoodUnits(ot);
  const saltWarningJin = outsideTownSaltWarningJin(ot);
  const woodWarningUnits = outsideTownWoodWarningUnits(ot);
  return {
    name: ot.name,
    rulers: ot.rulers,
    landMu: ot.landMu,
    laborers: ot.laborers,
    population: Math.round(ot.population),
    wheatStockJin: Math.round(ot.wheatStockJin),
    prosperity: Math.round(ot.prosperity * 10) / 10,
    weather: ot.weather,
    event: ot.event,
    tradeClosed: ot.tradeClosed,
    saltDemand: ot.saltDemand,
    woodDemand: ot.woodDemand,
    buyPrices: { ...ot.buyPrices },
    sellPrices: { ...ot.sellPrices },
    townStock,
    townWheatJin: Math.round(((state.accounts?.town?.wheat || 0) / scale) * 100) / 100,
    tariffRate: tradeTariffRate(state),
    stats: { ...ot.stats },
    lastYearProductionJin: ot.lastYearProductionJin || 0,
    lastYearConsumptionJin: ot.lastYearConsumptionJin || 0,
    loans: (ot.loans || []).map(l => ({ ...l })),
    loanStats: { ...ot.loanStats },
    // 民镇盐/木材库存与年消耗（第三步面板与长协都要用）。
    saltStockJin: Math.round(ot.saltStockJin),
    woodStockUnits: Math.round(ot.woodStockUnits),
    annualSaltJin: Math.round(annualSaltJin),
    annualWoodUnits: Math.round(annualWoodUnits),
    saltWarningJin: Math.round(saltWarningJin),
    woodWarningUnits: Math.round(woodWarningUnits),
    saltWarning: ot.saltStockJin < saltWarningJin,
    woodWarning: ot.woodStockUnits < woodWarningUnits,
    lastYearSaltConsumptionJin: ot.lastYearSaltConsumptionJin || 0,
    lastYearWoodConsumptionUnits: ot.lastYearWoodConsumptionUnits || 0,
    relations: Math.round(ot.relations * 10) / 10,
    foreignTradeOperational: buildingOperational(state, "foreign_trade_house"),
    foreignTradeStaff: buildingStaffOnDuty(state, "foreign_trade_house"),
    foreignTradeCapacity: buildingStaffOnDuty(state, "foreign_trade_house") * AGREEMENTS_PER_STAFF,
    diplomacyOperational: buildingOperational(state, "diplomacy_house"),
    diplomacyStaff: buildingStaffOnDuty(state, "diplomacy_house")
  };
}
