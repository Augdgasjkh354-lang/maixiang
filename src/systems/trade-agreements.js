import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { addInventory, quantityToUnits, unitsToQuantity } from "../economy/inventory.js";
import { takeWholesaleInventoryForExport, hasWholesaleMarket } from "./wholesale-market.js";
import {
  addOutsideTownStock, buildingOperational, buildingStaffOnDuty, ensureOutsideTown, readOutsideTown, recomputePrices,
  tradeTariffRate, OUTSIDE_TOWN_NAME, RELATIONS_TRUSTED, RELATIONS_DISTRUST, AGREEMENTS_PER_STAFF
} from "./outside-town.js";

// 长期贸易协定（民镇）：外贸房签约 -> 每年定额、每月交付 1/12，价格签约时锁定。
// 只从批发市场扣货；我方违约赔年货值 10% + 关系分降；连续 3 次违约对方自动解约。

export const AGREEMENT_ITEM_IDS = Object.freeze(["salt", "wood", "flour", "bread"]);
export const AGREEMENT_MIN_YEARS = 1;
export const AGREEMENT_MAX_YEARS = 5;
// AGREEMENTS_PER_STAFF 见 outside-town.js（两边共用，避免漂移）。
export const AGREEMENT_BREACH_PENALTY_RATE = 0.1;
export const AGREEMENT_BREACH_RELATIONS_LOSS = 5;
export const AGREEMENT_BREACH_LIMIT = 3;
export const AGREEMENT_PARTNER_BREACH_RELATIONS_LOSS = 3;
export const RELATIONS_TRUSTED_PRICE_FACTOR = 0.95;
export const RELATIONS_TRUSTED_PENALTY_FACTOR = 0.5;

const MAX_ANNUAL_JIN = 5000000;

export function ensureTradeAgreements(state) {
  if (!Array.isArray(state.tradeAgreements)) state.tradeAgreements = [];
  return state.tradeAgreements;
}

// 只读版本：供 selector/UI 使用，不回写游戏状态；脏数据时返回空数组不抛错。
export function readTradeAgreements(state) {
  const rows = Array.isArray(state.tradeAgreements) ? state.tradeAgreements : [];
  return rows.filter(row => row && typeof row === "object").map(row => ({ ...row }));
}

// 月度交付判定：每月只结算一次（按每月天数把一年切 12 段，段首交付）。
// 用 state 上的 lastSettleMonthKey 记账，避免同一个月重复交付。
function isMonthlySettlementDue(state, content) {
  const daysPerMonth = Math.max(1, Math.floor((content.rules.daysPerYear || 365) / 12));
  const day = Math.max(1, state.day || 1);
  // 一年 12 段：第 361—365 天归入第 12 段，避免一年交付 13 次。
  const monthIndex = Math.min(11, Math.floor((day - 1) / daysPerMonth));
  const monthKey = `${state.year}:${monthIndex}`;
  if (state.tradeAgreementMonthKey === monthKey) return false;
  state.tradeAgreementMonthKey = monthKey;
  return true;
}

function nextAgreementId(state) {
  const rows = ensureTradeAgreements(state);
  let serial = rows.length + 1;
  while (rows.some(row => row.id === `ta-${state.year}-${serial}`)) serial += 1;
  return `ta-${state.year}-${serial}`;
}

function agreementPrice(state, itemId, relations) {
  const ot = ensureOutsideTown(state);
  recomputePrices(state);
  const base = ot.buyPrices[itemId];
  if (!Number.isFinite(base) || base <= 0) return null;
  const factor = relations >= RELATIONS_TRUSTED ? RELATIONS_TRUSTED_PRICE_FACTOR : 1;
  return Math.round(base * factor * 100) / 100;
}

// 签约：外贸房在岗 ≥1 人才行；在岗人数 ×2 为长协容量上限；关系分 <40 拒签。
export function signTradeAgreement(state, { itemId, annualJin, years, content } = {}) {
  if (!content?.items) return { ok: false, reason: "缺少内容定义" };
  const ot = ensureOutsideTown(state);
  if (ot.tradeClosed) return { ok: false, reason: `商路中断，无法与${OUTSIDE_TOWN_NAME}签约` };
  if (!buildingOperational(state, "foreign_trade_house")) {
    return { ok: false, reason: "外贸房无人值守，无法签约" };
  }
  if (!AGREEMENT_ITEM_IDS.includes(itemId)) {
    return { ok: false, reason: "长协只经营盐、木材、面粉、面包" };
  }
  const quantity = Math.round(Number(annualJin) * 100) / 100;
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, reason: "年供货量必须大于0" };
  if (quantity > MAX_ANNUAL_JIN) return { ok: false, reason: `单笔长协年供货量不超过${MAX_ANNUAL_JIN}` };
  const term = Math.floor(Number(years));
  if (!Number.isFinite(term) || term < AGREEMENT_MIN_YEARS || term > AGREEMENT_MAX_YEARS) {
    return { ok: false, reason: `年限须在${AGREEMENT_MIN_YEARS}—${AGREEMENT_MAX_YEARS}年之间` };
  }
  if (ot.relations < RELATIONS_DISTRUST) {
    return { ok: false, reason: `${OUTSIDE_TOWN_NAME}不信任你，拒绝签约` };
  }
  const rows = ensureTradeAgreements(state);
  const active = rows.filter(row => row.status === "active");
  const capacity = buildingStaffOnDuty(state, "foreign_trade_house") * AGREEMENTS_PER_STAFF;
  if (active.length >= capacity) {
    return { ok: false, reason: `外贸房长协容量已满（在岗${buildingStaffOnDuty(state, "foreign_trade_house")}人 × ${AGREEMENTS_PER_STAFF}笔）` };
  }
  const price = agreementPrice(state, itemId, ot.relations);
  if (!price) return { ok: false, reason: "当前现货价格无效，无法定价" };
  const agreement = {
    id: nextAgreementId(state),
    itemId,
    annualJin: quantity,
    yearsTotal: term,
    yearsLeft: term,
    pricePerUnit: price,
    monthlyJin: Math.round(quantity / 12 * 100) / 100,
    breachCount: 0,
    status: "active",
    signYear: state.year,
    signDay: state.day
  };
  rows.push(agreement);
  const discountText = ot.relations >= RELATIONS_TRUSTED ? "（关系融洽，价×0.95）" : "";
  recordEvent(state, `与${OUTSIDE_TOWN_NAME}签订${content.items[itemId]?.name || itemId}长期协定：每年${Math.round(quantity)}，锁定单价${price}${discountText}，为期${term}年。`, content);
  return { ok: true, agreement };
}

function purchaseMarketUnits(state, itemId, units, content) {
  if (!hasWholesaleMarket(state)) return 0;
  return takeWholesaleInventoryForExport(state, itemId, units, content)?.units || 0;
}

// 违约金：从镇库小麦扣，不够扣就先扣光（延续"能退多少退多少"的处理）。
function payBreachPenalty(state, ot, amountJin, content, reason) {
  const scale = content.precision.inventoryUnitsPerJin;
  const townWheat = Math.max(0, state.accounts?.town?.wheat || 0);
  const payUnits = Math.min(townWheat, Math.floor(amountJin * scale));
  if (payUnits <= 0) return { paidJin: 0, shortfallJin: Math.round(amountJin * 100) / 100 };
  state.accounts.town.wheat = townWheat - payUnits;
  const paidJin = unitsToQuantity(payUnits, content);
  ot.wheatStockJin = Math.round((ot.wheatStockJin + paidJin) * 100) / 100;
  recordLedger(state, {
    type: "trade_agreement_penalty", transactionId: makeTransactionId(state),
    source: "town", destination: "outside_town", itemId: "wheat",
    quantityUnits: payUnits, qeqUnits: 0, reason
  }, content);
  return { paidJin, shortfallJin: Math.round(Math.max(0, amountJin - paidJin) * 100) / 100 };
}

// 每月结算：逐条交付。只有批发市场有货才交付；不够就是我方违约。
export function settleTradeAgreementsMonth(state, content) {
  const rows = ensureTradeAgreements(state);
  const ot = ensureOutsideTown(state);
  const result = { delivered: 0, breached: 0, partnerBreached: 0, terminated: 0, tariffJin: 0, revenueJin: 0, settled: false };
  if (!rows.length) return result;
  // 每月只交付一次 1/12；同月重复调用直接跳过。
  if (!isMonthlySettlementDue(state, content)) return result;
  result.settled = true;
  const scale = content.precision.inventoryUnitsPerJin;
  const tariffRate = tradeTariffRate(state);

  for (const agreement of rows) {
    if (agreement.status !== "active") continue;
    if (ot.tradeClosed) continue;
    const item = content.items[agreement.itemId];
    const monthlyJin = agreement.monthlyJin;
    const wantUnits = quantityToUnits(monthlyJin, content);
    const takenUnits = purchaseMarketUnits(state, agreement.itemId, wantUnits, content);

    if (takenUnits < wantUnits) {
      // 批发市场货源不足：先把已扣走的部分货回滚，避免货物凭空消失。
      if (takenUnits > 0) {
        const market = state.wholesaleMarket;
        if (market?.inventory) market.inventory[agreement.itemId] = (market.inventory[agreement.itemId] || 0) + takenUnits;
      }
      // 我方违约，违约金 = 年货值 ×10%（关系融洽减半），能扣多少扣多少。
      const shortUnits = wantUnits - takenUnits;
      const penaltyRate = AGREEMENT_BREACH_PENALTY_RATE
        * (ot.relations >= RELATIONS_TRUSTED ? RELATIONS_TRUSTED_PENALTY_FACTOR : 1);
      const penaltyJin = Math.round(agreement.annualJin * agreement.pricePerUnit * penaltyRate * 100) / 100;
      const paid = payBreachPenalty(state, ot, penaltyJin, content,
        `长期协定违约赔偿（${item?.name || agreement.itemId}，欠${unitsToQuantity(shortUnits, content)}）`);
      agreement.breachCount = (agreement.breachCount || 0) + 1;
      ot.relations = Math.max(0, ot.relations - AGREEMENT_BREACH_RELATIONS_LOSS);
      result.breached += 1;
      const owedText = paid.shortfallJin > 0 ? `，镇库小麦不足，尚欠${Math.round(paid.shortfallJin)}斤` : "";
      recordEvent(state, `长期协定未按期交付${item?.name || agreement.itemId}，向${OUTSIDE_TOWN_NAME}赔付小麦${Math.round(paid.paidJin)}斤${owedText}。`, content);
      if (agreement.breachCount >= AGREEMENT_BREACH_LIMIT) {
        agreement.status = "terminated";
        agreement.terminatedYear = state.year;
        agreement.terminatedDay = state.day;
        result.terminated += 1;
        recordEvent(state, `${OUTSIDE_TOWN_NAME}连续${AGREEMENT_BREACH_LIMIT}个月未收到${item?.name || agreement.itemId}，单方面解约。`, content);
      }
      continue;
    }

    const actualJin = unitsToQuantity(takenUnits, content);
    const orderJin = Math.round(actualJin * agreement.pricePerUnit * 100) / 100;
    // 民镇小麦不足付货款 -> 对方违约：跳过本月交付，关系分 −3，不计我方违约。
    if (ot.wheatStockJin < orderJin) {
      // 把已从批发市场取出的货退回，避免货款两空。
      if (takenUnits > 0) {
        const market = state.wholesaleMarket;
        if (market?.inventory) market.inventory[agreement.itemId] = (market.inventory[agreement.itemId] || 0) + takenUnits;
      }
      ot.relations = Math.max(0, ot.relations - AGREEMENT_PARTNER_BREACH_RELATIONS_LOSS);
      result.partnerBreached += 1;
      recordEvent(state, `${OUTSIDE_TOWN_NAME}小麦不足，本月长期协定未能付款，交付顺延。`, content);
      continue;
    }

    ot.wheatStockJin = Math.round((ot.wheatStockJin - orderJin) * 100) / 100;
    // 镇库小麦 += 货款（实物小麦结算，延续现有贸易逻辑）。
    const proceedsUnits = Math.floor(orderJin * scale);
    if (proceedsUnits > 0) {
      addInventory(state, "town", "wheat", unitsToQuantity(proceedsUnits, content),
        `对${OUTSIDE_TOWN_NAME}长期协定交付${item?.name || agreement.itemId}所得`, "trade_export", content);
    }
    // 民镇入库：盐按斤、木材按单位（统一换算回 斤/单位口径）。
    addOutsideTownStock(ot, agreement.itemId, unitsToQuantity(takenUnits, content));
    // 关税：与现货一致，按出口税率计。
    const tariffJin = Math.round(orderJin * tariffRate / 100 * 100) / 100;
    ot.stats.exportJin = Math.round((ot.stats.exportJin + orderJin) * 100) / 100;
    ot.stats.yearExportJin = Math.round((ot.stats.yearExportJin + orderJin) * 100) / 100;
    ot.stats.tariffJin = Math.round((ot.stats.tariffJin + tariffJin) * 100) / 100;
    ot.stats.yearTariffJin = Math.round((ot.stats.yearTariffJin + tariffJin) * 100) / 100;
    if (tariffJin > 0) {
      recordLedger(state, {
        type: "trade_tariff", transactionId: makeTransactionId(state), source: "trade", destination: "town",
        itemId: "money_value", quantityUnits: quantityToUnits(tariffJin, content), qeqUnits: 0,
        reason: `对${OUTSIDE_TOWN_NAME}长期协定出口关税（${tariffRate}%）`
      }, content);
    }
    // 长协交付量刻意不写 tradeMemory：长协不该触发现货价格反馈。
    agreement.breachCount = 0;
    agreement.deliveredYears = agreement.deliveredYears || 0;
    agreement.totalDeliveredJin = Math.round(((agreement.totalDeliveredJin || 0) + actualJin) * 100) / 100;
    result.delivered += 1;
    result.revenueJin = Math.round((result.revenueJin + orderJin) * 100) / 100;
    result.tariffJin = Math.round((result.tariffJin + tariffJin) * 100) / 100;
  }
  return result;
}

// 年结：剩余年限 −1，到期转 expired；关系分过低有断交概率已在 outside-town 里处理。
export function settleTradeAgreementsYear(state, content) {
  const rows = ensureTradeAgreements(state);
  const expired = [];
  for (const agreement of rows) {
    if (agreement.status !== "active") continue;
    agreement.yearsLeft = Math.max(0, (agreement.yearsLeft || 0) - 1);
    if (agreement.yearsLeft <= 0) {
      agreement.status = "expired";
      expired.push(agreement.id);
      recordEvent(state, `与${OUTSIDE_TOWN_NAME}的${content.items[agreement.itemId]?.name || agreement.itemId}长期协定已到期，可续签。`, content, { day: 1 });
    }
  }
  return { expired };
}

// 主动解约：收 10% 年货值违约金（关系融洽减半）。
export function terminateTradeAgreement(state, id, content) {
  const rows = ensureTradeAgreements(state);
  const agreement = rows.find(row => row.id === id);
  if (!agreement) return { ok: false, reason: "未找到该长期协定" };
  if (agreement.status !== "active") return { ok: false, reason: "该长期协定已结束" };
  const ot = ensureOutsideTown(state);
  const penaltyRate = AGREEMENT_BREACH_PENALTY_RATE
    * (ot.relations >= RELATIONS_TRUSTED ? RELATIONS_TRUSTED_PENALTY_FACTOR : 1);
  const penaltyJin = Math.round(agreement.annualJin * agreement.pricePerUnit * penaltyRate * 100) / 100;
  const paid = payBreachPenalty(state, ot, penaltyJin, content,
    `主动解约赔偿（${content.items[agreement.itemId]?.name || agreement.itemId}）`);
  agreement.status = "terminated";
  agreement.terminatedYear = state.year;
  agreement.terminatedDay = state.day;
  ot.relations = Math.max(0, ot.relations - AGREEMENT_BREACH_RELATIONS_LOSS);
  const owedText = paid.shortfallJin > 0 ? `，镇库小麦不足，尚欠${Math.round(paid.shortfallJin)}斤` : "";
  recordEvent(state, `主动解除与${OUTSIDE_TOWN_NAME}的长期协定，赔付小麦${Math.round(paid.paidJin)}斤${owedText}。`, content);
  return { ok: true, penaltyJin, paidJin: paid.paidJin, shortfallJin: paid.shortfallJin };
}

// 供 UI 读取的长协视图（只读，不回写游戏状态）。
export function selectTradeAgreementView(state, content) {
  const ot = readOutsideTown(state);
  const rows = readTradeAgreements(state);
  const capacity = buildingStaffOnDuty(state, "foreign_trade_house") * AGREEMENTS_PER_STAFF;
  return {
    agreements: rows.map(row => ({
      ...row,
      itemName: content.items[row.itemId]?.name || row.itemId,
      unit: content.items[row.itemId]?.unit || "斤"
    })),
    activeCount: rows.filter(row => row.status === "active").length,
    capacity,
    capacityUsedPercent: capacity > 0 ? Math.min(100, Math.round(rows.filter(r => r.status === "active").length / capacity * 100)) : 0,
    relations: Math.round(ot.relations * 10) / 10,
    trusted: ot.relations >= RELATIONS_TRUSTED,
    distrusted: ot.relations < RELATIONS_DISTRUST,
    operational: buildingOperational(state, "foreign_trade_house"),
    staff: buildingStaffOnDuty(state, "foreign_trade_house")
  };
}
