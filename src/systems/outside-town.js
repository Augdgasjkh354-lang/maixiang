import { nextRandom } from "../core/random.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { addInventory, changeInventory, quantityToUnits, unitsToQuantity } from "../economy/inventory.js";
import { DEFAULT_OUTSIDE_TOWN_ID, OUTSIDE_TOWNS } from "../content/outside-towns.js";
import { hasWholesaleMarket, ensureWholesaleMarket, takeWholesaleInventoryForExport } from "./wholesale-market.js";
import { jobCount } from "./households.js";
import { freightCapacityUnits, freightPoolJin, takeFreightCapacity } from "./logistics.js";

// 外镇：所有外镇共用这一套"库存驱动"算法，每个镇的差别只在 content/outside-towns.js 的档案里。
//
// 每天：每样商品按人口自产、消耗；吃口粮小麦。供应满足率滚动平均 → 繁荣度慢慢靠拢。
// 价格：只看外镇自己的库存。库存低于目标就涨，高于目标就跌：
//   中间价 = 基准价 × clamp((目标库存 / 库存)^0.7, 0.35, 3) × 繁荣度系数
//   外镇收购价（我们卖）= 中间价 × (1 − 价差/2)；外镇出售价（我们买）= 中间价 × (1 + 价差/2)
//   我们卖给它，它库存涨、价格跌；向它买，库存跌、价格涨。买进再卖回只会亏掉价差，没有套利。
//   大单按 20 段逐段计价，越卖越便宜。
// 结算：一律实物小麦。外镇只动用口粮储备以上的小麦付款。
// 每年：秋收入库；元旦抽天气与年事件、按繁荣度和口粮增减人口、开垦新耕地。

const SLICES = 20;
export const RELATIONS_DEFAULT = 60;
export const RELATIONS_MAX = 100;
export const RELATIONS_TRUSTED = 70;
export const RELATIONS_DISTRUST = 40;
export const RELATIONS_BREAKOFF = 20;
const RELATIONS_GAIN_PER_DAY = 0.1;
const RELATIONS_LOSS_PER_DAY = 0.3;
// 每成交 2 万斤小麦的买卖，关系分 +1（单笔最多 +1）。
const RELATIONS_PER_TRADE_JIN = 20000;
// 长协容量：外贸房每人在岗可跟进的长协笔数（trade-agreements.js 共用）。
export const AGREEMENTS_PER_STAFF = 2;
// 外镇愿意卖给我们时，至少给自己留 30 天的量。
const SELL_RESERVE_DAYS = 30;
// 库存超过目标 2 倍的部分每天损耗 2%（陈货、转卖），防止无限囤积。
const STOCK_SPOIL_MULTIPLE = 2;
const SUPPLY_MEMORY = 0.97;

const round2 = value => Math.round(value * 100) / 100;

// ---------------------------------------------------------------- 档案与状态

function profiles(content) {
  return content?.outsideTowns || OUTSIDE_TOWNS;
}

export function outsideTownProfile(content, townId = DEFAULT_OUTSIDE_TOWN_ID) {
  return profiles(content)[townId] || null;
}

function createTown(profile) {
  const stocks = {};
  const supply = { food: 1 };
  for (const [itemId, good] of Object.entries(profile.goods)) {
    stocks[itemId] = good.stock;
    supply[itemId] = 1;
  }
  return {
    id: profile.id,
    population: profile.population,
    landMu: profile.landMu,
    wheatStockJin: profile.wheatStockJin,
    prosperity: profile.prosperity,
    relations: profile.relations,
    stocks,
    supply,
    weather: 1,
    harvestFactor: 1,
    lastHarvestYear: 0,
    event: null,
    tradeClosed: false,
    lastYear: { harvestJin: 0, foodJin: 0, populationChange: 0, landAddedMu: 0 },
    stats: { exportJin: 0, importJin: 0, trades: 0, yearExportJin: 0, yearImportJin: 0 },
    loans: [],
    loanStats: { totalIssuedJin: 0, totalRepaidJin: 0, totalInterestJin: 0, activeLoans: 0 }
  };
}

export function createOutsideTowns(content) {
  const towns = {};
  for (const profile of Object.values(profiles(content))) towns[profile.id] = createTown(profile);
  return towns;
}

export function ensureOutsideTowns(state, content) {
  state.outsideTowns ||= createOutsideTowns(content);
  for (const profile of Object.values(profiles(content))) state.outsideTowns[profile.id] ||= createTown(profile);
  return state.outsideTowns;
}

export function outsideTown(state, content, townId = DEFAULT_OUTSIDE_TOWN_ID) {
  return ensureOutsideTowns(state, content)[townId] || null;
}

// 只读：selector 用，不回写。
export function readOutsideTown(state, content, townId = DEFAULT_OUTSIDE_TOWN_ID) {
  const profile = outsideTownProfile(content, townId);
  return state.outsideTowns?.[townId] || (profile ? createTown(profile) : null);
}

// ---------------------------------------------------------------- 定价

function dailyNeed(town, good) {
  return town.population * good.needPerPersonDay;
}

export function targetStock(town, good) {
  return dailyNeed(town, good) * good.targetDays;
}

function prosperityFactor(town) {
  return 0.8 + Math.max(0, Math.min(100, town.prosperity)) / 100 * 0.4;
}

function spreadRate(town) {
  return 0.2 - Math.max(0, Math.min(100, town.relations)) / 100 * 0.1;
}

// 外镇要进口的东西（盐、木材、布、酒）：存货不到 3 年用量都按正常价收，囤够 3 年以上才开始压价；
// 繁荣度越低（越缺东西、越着急）越愿意出高价，繁荣度 100 按基准价，繁荣度 0 出到 1.8 倍。
// 外镇自产外卖的东西（面粉、面包）照旧按库存比目标定价。
export const IMPORT_DISCOUNT_AFTER_YEARS = 3;

function stockYears(town, good, stock) {
  const yearNeed = dailyNeed(town, good) * 365;
  return yearNeed > 0 ? Math.max(0, stock) / yearNeed : Infinity;
}

function importUrgency(town) {
  return 1 + (1 - Math.max(0, Math.min(100, town.prosperity)) / 100) * 0.8;
}

function midPrice(town, good, stock) {
  if (!good.sellsToUs) {
    const years = stockYears(town, good, stock);
    const glut = years <= IMPORT_DISCOUNT_AFTER_YEARS ? 1 : Math.max(0.4, 1 - 0.2 * (years - IMPORT_DISCOUNT_AFTER_YEARS));
    return good.basePrice * glut * importUrgency(town);
  }
  const target = targetStock(town, good);
  const scarcity = target > 0 ? (target / Math.max(stock, target * 0.05)) ** 0.7 : 1;
  return good.basePrice * Math.max(0.35, Math.min(3, scarcity)) * prosperityFactor(town);
}

// direction: "sell" = 我们卖给外镇（外镇收购价），"buy" = 我们向外镇买。
export function unitPrice(town, good, direction, stock = null) {
  const mid = midPrice(town, good, stock ?? town.stocks[good.id] ?? 0);
  const half = spreadRate(town) / 2;
  return direction === "sell" ? mid * (1 - half) : mid * (1 + half);
}

export function goodOf(profile, itemId) {
  const good = profile.goods[itemId];
  return good ? { ...good, id: itemId } : null;
}

// 逐段计价：返回这批货总共值多少斤小麦。
export function quoteValue(town, good, direction, quantity) {
  let stock = town.stocks[good.id] || 0;
  const step = quantity / SLICES;
  let value = 0;
  for (let i = 0; i < SLICES; i++) {
    const after = direction === "sell" ? stock + step : stock - step;
    value += step * unitPrice(town, good, direction, (stock + after) / 2);
    stock = after;
  }
  return value;
}

// 外镇能拿出来付款的小麦：口粮储备以上的部分。
export function payableWheatJin(town, profile) {
  const reserve = town.population * profile.foodPerPersonDayJin * profile.foodReserveDays;
  return Math.max(0, town.wheatStockJin - reserve);
}

export function sellableStock(town, good) {
  if (!good.sellsToUs) return 0;
  return Math.max(0, (town.stocks[good.id] || 0) - dailyNeed(town, good) * SELL_RESERVE_DAYS);
}

// 我们卖 quantity 时外镇最多付得起多少：二分出货款不超过可付小麦的数量。
export function affordableSellQuantity(town, profile, good, quantity) {
  const budget = payableWheatJin(town, profile);
  if (quoteValue(town, good, "sell", quantity) <= budget) return quantity;
  let low = 0;
  let high = quantity;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    if (quoteValue(town, good, "sell", mid) <= budget) low = mid; else high = mid;
  }
  return Math.floor(low * 100) / 100;
}

// 签长协、界面展示用的当前单价。
export function currentPrice(state, content, townId, itemId, direction) {
  const town = readOutsideTown(state, content, townId);
  const profile = outsideTownProfile(content, townId);
  const good = profile && goodOf(profile, itemId);
  return town && good ? round2(unitPrice(town, good, direction)) : null;
}

// ---------------------------------------------------------------- 外贸房

export function buildingOperational(state, typeId) {
  return buildingStaffOnDuty(state, typeId) >= 1;
}

export function buildingStaffOnDuty(state, typeId) {
  const building = (state.buildings || []).find(row => row.typeId === typeId);
  return building ? jobCount(state, `${building.id}::trade_staff`) : 0;
}

export function changeRelations(town, delta) {
  town.relations = Math.max(0, Math.min(RELATIONS_MAX, round2(town.relations + delta)));
}

// 外镇收货：长协交付也走这里。
export function deliverToOutsideTown(town, itemId, quantity) {
  if (quantity > 0 && town.stocks[itemId] !== undefined) town.stocks[itemId] = round2(town.stocks[itemId] + quantity);
}

function recordTradeStats(town, direction, valueJin) {
  if (direction === "sell") {
    town.stats.exportJin = round2(town.stats.exportJin + valueJin);
    town.stats.yearExportJin = round2(town.stats.yearExportJin + valueJin);
  } else {
    town.stats.importJin = round2(town.stats.importJin + valueJin);
    town.stats.yearImportJin = round2(town.stats.yearImportJin + valueJin);
  }
  town.stats.trades += 1;
  changeRelations(town, Math.min(1, valueJin / RELATIONS_PER_TRADE_JIN));
}

export { recordTradeStats };

// ---------------------------------------------------------------- 每日

export function advanceOutsideTownDay(state, content) {
  const towns = ensureOutsideTowns(state, content);
  const staffed = buildingOperational(state, "foreign_trade_house");
  const rows = {};
  for (const town of Object.values(towns)) {
    const profile = outsideTownProfile(content, town.id);
    if (!profile) continue;
    let score = 0;
    let weightUsed = 0;
    for (const [itemId, base] of Object.entries(profile.goods)) {
      const good = { ...base, id: itemId };
      const need = dailyNeed(town, good);
      let stock = (town.stocks[itemId] || 0) + town.population * good.producePerPersonDay;
      const used = Math.min(stock, need);
      stock -= used;
      // 自产品超过目标 2 倍、进口品超过 5 年用量的部分才开始损耗。
      const cap = good.sellsToUs ? targetStock(town, good) * STOCK_SPOIL_MULTIPLE : need * 365 * 5;
      if (stock > cap) stock -= (stock - cap) * 0.02;
      town.stocks[itemId] = round2(stock);
      const satisfied = need > 0 ? used / need : 1;
      town.supply[itemId] = Math.round(((town.supply[itemId] ?? 1) * SUPPLY_MEMORY + satisfied * (1 - SUPPLY_MEMORY)) * 1e4) / 1e4;
      score += good.supplyWeight * town.supply[itemId];
      weightUsed += good.supplyWeight;
    }
    const foodNeed = town.population * profile.foodPerPersonDayJin;
    const eaten = Math.min(town.wheatStockJin, foodNeed);
    town.wheatStockJin = round2(town.wheatStockJin - eaten);
    town.supply.food = Math.round(((town.supply.food ?? 1) * SUPPLY_MEMORY + (foodNeed > 0 ? eaten / foodNeed : 1) * (1 - SUPPLY_MEMORY)) * 1e4) / 1e4;
    score += Math.max(0, 1 - weightUsed) * town.supply.food;
    // 存粮超过一年口粮的部分每天损耗 0.1%（约一年三成：霉变、酿酒、转卖），防止小麦无限堆积。
    const wheatCap = foodNeed * 365;
    if (town.wheatStockJin > wheatCap) town.wheatStockJin = round2(town.wheatStockJin - (town.wheatStockJin - wheatCap) * 0.001);
    // 繁荣度向"供应满足率 × 100"靠拢（约百日走完一半）：样样不缺是 100，只有口粮没有盐木只有 45 左右。
    const target = 100 * score;
    town.prosperity = round2(town.prosperity + (target - town.prosperity) * 0.01);
    changeRelations(town, staffed ? RELATIONS_GAIN_PER_DAY : -RELATIONS_LOSS_PER_DAY);
    // 秋收：与本镇同日入库。
    if (state.day === content.rules.growingDays && town.lastHarvestYear !== state.year) {
      const harvest = town.landMu * profile.yieldPerMuJin * town.weather * town.harvestFactor;
      town.wheatStockJin = round2(town.wheatStockJin + harvest);
      town.lastHarvestYear = state.year;
      town.lastYear.harvestJin = Math.round(harvest);
      recordEvent(state, `${profile.name}秋收入库${Math.round(harvest).toLocaleString("zh-CN")}斤小麦。`, content);
    }
    rows[town.id] = { prosperity: town.prosperity, relations: town.relations };
  }
  return rows;
}

// ---------------------------------------------------------------- 每年（元旦）

export function settleOutsideTownYear(state, content) {
  const towns = ensureOutsideTowns(state, content);
  const rows = {};
  // 开局当天不算"过年"：第一年用档案初值。
  if (state.year <= 1) return rows;
  for (const town of Object.values(towns)) {
    const profile = outsideTownProfile(content, town.id);
    if (!profile) continue;
    town.tradeClosed = false;
    town.harvestFactor = 1;
    town.weather = round2(0.75 + nextRandom(state) * 0.5);
    let event = null;
    if (nextRandom(state) < 0.12) {
      const pick = nextRandom(state);
      if (pick < 0.3) {
        event = "蝗灾"; town.harvestFactor = 0.55;
        recordEvent(state, `${profile.name}遭蝗灾，今秋收成将大减。`, content, { day: 1 });
      } else if (pick < 0.6) {
        event = "丰收"; town.harvestFactor = 1.15;
        recordEvent(state, `${profile.name}风调雨顺，今秋有望丰收。`, content, { day: 1 });
      } else if (pick < 0.8) {
        event = "商路中断"; town.tradeClosed = true;
        recordEvent(state, `山匪截断商路，今年无法与${profile.name}贸易。`, content, { day: 1 });
      } else if (town.stocks.salt !== undefined) {
        event = "盐荒"; town.stocks.salt = round2(town.stocks.salt * 0.5);
        recordEvent(state, `${profile.name}盐仓受潮，存盐折半，对盐出价走高。`, content, { day: 1 });
      }
    }
    town.event = event ? { type: event, year: state.year } : null;
    if (town.relations < RELATIONS_BREAKOFF && nextRandom(state) < 0.3) {
      town.tradeClosed = true;
      recordEvent(state, `${profile.name}与我镇关系破裂，商路断绝。`, content, { day: 1 });
    }
    // 人口只增不减：每年 +0.5%（繁荣度 0）到 +3%（繁荣度 100）；口粮不足的年份停止增长。
    const rate = town.supply.food < 0.97 ? 0 : 0.005 + 0.025 * Math.max(0, Math.min(100, town.prosperity)) / 100;
    const before = town.population;
    town.population = Math.round(before * (1 + rate));
    town.lastYear.populationChange = town.population - before;
    town.landMu += profile.landGrowthMuPerYear;
    town.lastYear.landAddedMu = profile.landGrowthMuPerYear;
    town.lastYear.foodJin = Math.round(before * profile.foodPerPersonDayJin * (content.rules.daysPerYear || 365));
    town.stats.yearExportJin = 0;
    town.stats.yearImportJin = 0;
    rows[town.id] = { weather: town.weather, event, population: town.population, landMu: town.landMu };
  }
  return rows;
}

// ---------------------------------------------------------------- 现货贸易

// 玩家命令：direction "sell" 我们卖出 / "buy" 我们买入。实物小麦结算。
export function tradeWithOutsideTown(state, direction, itemId, quantityJin, content, townId = DEFAULT_OUTSIDE_TOWN_ID) {
  const profile = outsideTownProfile(content, townId);
  const town = outsideTown(state, content, townId);
  if (!profile || !town) return { ok: false, reason: "没有这个外镇" };
  if (town.tradeClosed) return { ok: false, reason: `商路中断，今年无法与${profile.name}贸易` };
  if (!buildingOperational(state, "foreign_trade_house")) return { ok: false, reason: "外贸房无人值守，无法开展贸易" };
  if (direction !== "sell" && direction !== "buy") return { ok: false, reason: "贸易方向无效" };
  const good = goodOf(profile, itemId);
  const item = content.items[itemId];
  if (!good || !item) return { ok: false, reason: `${profile.name}不做这种买卖` };
  if (direction === "buy" && !good.sellsToUs) return { ok: false, reason: `${profile.name}不出售${item.name}` };
  let qty = Number(quantityJin);
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "数量必须大于0" };
  // 运力：货物（进出口都算）从运力池扣斤数；池子不够就只做到池子剩下的量，池子空了直接拒绝。
  if (freightPoolJin(state) < 0.01) return { ok: false, reason: `运力不足：今天最多还能运${Math.floor(freightPoolJin(state) * 100) / 100}斤` };
  const freightUnits = freightCapacityUnits(state, content);
  const transactionId = makeTransactionId(state);

  if (direction === "sell") {
    qty = affordableSellQuantity(town, profile, good, qty);
    if (qty < 0.01) return { ok: false, reason: `${profile.name}口粮储备以外的小麦不够，付不起这笔货款` };
    const qtyUnits = Math.min(quantityToUnits(qty, content), freightUnits);
    if (qtyUnits <= 0) return { ok: false, reason: "数量过小" };
    // 货源：先批发市场，不足再镇库；镇库也不够就把市场已出的货退回。
    let fromMarketUnits = 0;
    if (hasWholesaleMarket(state)) fromMarketUnits = takeWholesaleInventoryForExport(state, itemId, qtyUnits, content).units || 0;
    const remainingUnits = qtyUnits - fromMarketUnits;
    if (remainingUnits > 0) {
      const take = changeInventory(state, "town", itemId, -remainingUnits, `对${profile.name}出口${item.name}`, "trade_export", content, transactionId);
      if (!take.ok) {
        if (fromMarketUnits > 0) {
          const market = ensureWholesaleMarket(state, content);
          market.inventory[itemId] = (market.inventory[itemId] || 0) + fromMarketUnits;
        }
        return { ok: false, reason: `批发市场与镇库的${item.name}不足` };
      }
    }
    const actualJin = unitsToQuantity(qtyUnits, content);
    // 货已经能发出（之后不再有可能失败的步骤）才扣运力。
    takeFreightCapacity(state, actualJin, content);
    const valueJin = round2(quoteValue(town, good, "sell", actualJin));
    town.wheatStockJin = round2(Math.max(0, town.wheatStockJin - valueJin));
    deliverToOutsideTown(town, itemId, actualJin);
    addInventory(state, "town", "wheat", valueJin, `对${profile.name}出口${item.name}所得`, "trade_export", content);
    recordTradeStats(town, "sell", valueJin);
    return { ok: true, direction, itemId, quantityJin: actualJin, valueJin, priceWheatPerUnit: round2(valueJin / actualJin) };
  }

  qty = Math.min(qty, Math.floor(sellableStock(town, good) * 100) / 100, freightUnits / content.precision.inventoryUnitsPerJin);
  if (qty < 0.01) return { ok: false, reason: `${profile.name}的${item.name}只够自用，暂不外卖` };
  const valueJin = round2(quoteValue(town, good, "buy", qty));
  const payUnits = quantityToUnits(valueJin, content);
  const pay = changeInventory(state, "town", "wheat", -payUnits, `从${profile.name}进口${item.name}付款`, "trade_import", content, transactionId);
  if (!pay.ok) return { ok: false, reason: "镇库小麦不足以支付" };
  // 付款已成功，之后不再失败：这时才扣运力。
  takeFreightCapacity(state, qty, content);
  town.wheatStockJin = round2(town.wheatStockJin + valueJin);
  town.stocks[itemId] = round2(town.stocks[itemId] - qty);
  addInventory(state, "town", itemId, qty, `从${profile.name}进口${item.name}`, "trade_import", content);
  recordTradeStats(town, "buy", valueJin);
  return { ok: true, direction, itemId, quantityJin: qty, valueJin, priceWheatPerUnit: round2(valueJin / qty) };
}

// ---------------------------------------------------------------- 小麦贷款

export const MAX_LOAN_RATE_PERCENT = 50;

export function issueWheatLoan(state, principalJin, annualRatePercent, content, townId = DEFAULT_OUTSIDE_TOWN_ID) {
  const profile = outsideTownProfile(content, townId);
  const town = outsideTown(state, content, townId);
  if (!profile || !town) return { ok: false, reason: "没有这个外镇" };
  const principal = round2(Number(principalJin));
  const rate = Number(annualRatePercent);
  if (!Number.isFinite(principal) || principal <= 0) return { ok: false, reason: "贷款斤数须大于0" };
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_LOAN_RATE_PERCENT) return { ok: false, reason: `年利率须在0—${MAX_LOAN_RATE_PERCENT}%之间` };
  const units = Math.floor(principal * content.precision.inventoryUnitsPerJin);
  if (units <= 0) return { ok: false, reason: "贷款斤数过小" };
  const townWheat = Math.max(0, state.accounts?.town?.wheat || 0);
  if (townWheat < units) return { ok: false, reason: "镇库小麦不足，放贷失败" };
  state.accounts.town.wheat = townWheat - units;
  town.wheatStockJin = round2(town.wheatStockJin + principal);
  const loan = {
    id: `loan-${state.year}-${state.day}-${town.loans.length}`,
    principalJin: principal,
    annualRatePercent: round2(rate),
    outstandingJin: principal,
    accruedInterestJin: 0,
    issueYear: state.year,
    issueDay: state.day,
    status: "active"
  };
  town.loans.push(loan);
  town.loanStats.totalIssuedJin = round2(town.loanStats.totalIssuedJin + principal);
  town.loanStats.activeLoans = town.loans.filter(row => row.status === "active").length;
  changeRelations(town, Math.min(5, principal / 50000));
  recordLedger(state, {
    type: "wheat_loan_issue", transactionId: makeTransactionId(state), source: "town", destination: "outside_town",
    itemId: "wheat", quantityUnits: units, qeqUnits: 0,
    reason: `向${profile.name}发放小麦贷款${principal}斤，年利率${loan.annualRatePercent}%`
  }, content);
  recordEvent(state, `向${profile.name}发放小麦贷款${Math.round(principal)}斤（年利率${loan.annualRatePercent}%）。`, content);
  return { ok: true, loan };
}

// 元旦：计一年利息，外镇用口粮储备以外的小麦先息后本偿还。
export function settleWheatLoansYear(state, content) {
  const towns = ensureOutsideTowns(state, content);
  let repaidJin = 0;
  let interestJin = 0;
  for (const town of Object.values(towns)) {
    const profile = outsideTownProfile(content, town.id);
    if (!profile) continue;
    let townRepaid = 0;
    let townInterest = 0;
    for (const loan of town.loans) {
      if (loan.status !== "active") continue;
      loan.accruedInterestJin = round2(loan.accruedInterestJin + loan.outstandingJin * loan.annualRatePercent / 100);
      const payable = Math.min(loan.outstandingJin + loan.accruedInterestJin, payableWheatJin(town, profile));
      if (payable <= 0) continue;
      const payInterest = Math.min(loan.accruedInterestJin, payable);
      const payPrincipal = Math.min(loan.outstandingJin, payable - payInterest);
      loan.accruedInterestJin = round2(loan.accruedInterestJin - payInterest);
      loan.outstandingJin = round2(loan.outstandingJin - payPrincipal);
      town.wheatStockJin = round2(town.wheatStockJin - payInterest - payPrincipal);
      state.accounts.town.wheat = (state.accounts.town.wheat || 0) + Math.floor((payInterest + payPrincipal) * content.precision.inventoryUnitsPerJin);
      townRepaid += payInterest + payPrincipal;
      townInterest += payInterest;
      if (loan.outstandingJin <= 0.01 && loan.accruedInterestJin <= 0.01) {
        loan.status = "repaid";
        changeRelations(town, 3);
        recordEvent(state, `${profile.name}还清小麦贷款（本金${loan.principalJin}斤）。`, content);
      }
    }
    town.loanStats.totalRepaidJin = round2(town.loanStats.totalRepaidJin + townRepaid);
    town.loanStats.totalInterestJin = round2(town.loanStats.totalInterestJin + townInterest);
    town.loanStats.activeLoans = town.loans.filter(row => row.status === "active").length;
    if (townRepaid > 0) {
      recordLedger(state, {
        type: "wheat_loan_repay", transactionId: makeTransactionId(state), source: "outside_town", destination: "town",
        itemId: "wheat", quantityUnits: Math.floor(townRepaid * content.precision.inventoryUnitsPerJin), qeqUnits: 0,
        reason: `${profile.name}偿还小麦贷款${Math.round(townRepaid)}斤（含利息${Math.round(townInterest)}斤）`
      }, content);
    }
    repaidJin += townRepaid;
    interestJin += townInterest;
  }
  return { repaidJin: round2(repaidJin), interestJin: round2(interestJin) };
}

// ---------------------------------------------------------------- 视图

export function selectOutsideTownView(state, content, townId = DEFAULT_OUTSIDE_TOWN_ID) {
  const profile = outsideTownProfile(content, townId);
  const town = readOutsideTown(state, content, townId);
  if (!profile || !town) return null;
  const scale = content.precision.inventoryUnitsPerJin;
  const foodPerDay = town.population * profile.foodPerPersonDayJin;
  const goods = Object.entries(profile.goods).map(([itemId, base]) => {
    const good = { ...base, id: itemId };
    const need = dailyNeed(town, good);
    const stock = town.stocks[itemId] || 0;
    return {
      itemId,
      name: content.items[itemId]?.name || itemId,
      unit: content.items[itemId]?.unit || "斤",
      stock: Math.round(stock),
      stockDays: need > 0 ? Math.round(stock / need) : null,
      targetDays: good.targetDays,
      dailyNeed: round2(need),
      dailyProduce: round2(town.population * good.producePerPersonDay),
      supply: Math.round((town.supply[itemId] ?? 1) * 100),
      sellPrice: round2(unitPrice(town, good, "sell")),
      buyPrice: good.sellsToUs ? round2(unitPrice(town, good, "buy")) : null,
      sellable: Math.floor(sellableStock(town, good)),
      sellsToUs: good.sellsToUs,
      // 我镇可出口的存货：批发市场 + 镇库（出口先取批发市场）。
      ourStock: round2(((state.accounts?.town?.[itemId] || 0) + (state.wholesaleMarket?.inventory?.[itemId] || 0)) / scale)
    };
  });
  const staff = buildingStaffOnDuty(state, "foreign_trade_house");
  return {
    id: town.id,
    name: profile.name,
    rulers: [...profile.rulers],
    description: profile.description,
    population: town.population,
    landMu: town.landMu,
    landGrowthMuPerYear: profile.landGrowthMuPerYear,
    prosperity: round2(town.prosperity),
    relations: round2(town.relations),
    spreadPercent: round2(spreadRate(town) * 100),
    wheatStockJin: Math.round(town.wheatStockJin),
    wheatDays: foodPerDay > 0 ? Math.round(town.wheatStockJin / foodPerDay) : null,
    payableWheatJin: Math.round(payableWheatJin(town, profile)),
    foodSupply: Math.round((town.supply.food ?? 1) * 100),
    weather: town.weather,
    event: town.event,
    tradeClosed: town.tradeClosed,
    lastYear: { ...town.lastYear },
    stats: { ...town.stats },
    goods,
    townWheatJin: round2((state.accounts?.town?.wheat || 0) / scale),
    loans: town.loans.map(row => ({ ...row })),
    loanStats: { ...town.loanStats },
    foreignTradeOperational: staff >= 1,
    foreignTradeStaff: staff,
    foreignTradeCapacity: staff * AGREEMENTS_PER_STAFF
  };
}
