import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { addInventory, quantityToUnits, unitsToQuantity } from "../economy/inventory.js";
import { DEFAULT_OUTSIDE_TOWN_ID } from "../content/outside-towns.js";
import { takeWholesaleInventoryForExport, hasWholesaleMarket } from "./wholesale-market.js";
import { freightCapacityUnits, takeFreightCapacity } from "./logistics.js";
import {
  AGREEMENTS_PER_STAFF, RELATIONS_DISTRUST, RELATIONS_TRUSTED,
  buildingOperational, buildingStaffOnDuty, changeRelations, currentPrice, deliverToOutsideTown,
  outsideTown, outsideTownProfile, payableWheatJin, readOutsideTown, recordTradeStats
} from "./outside-town.js";

// 长期贸易协定：外贸房签约 → 每年定额、每月交付 1/12，价格按签约时的外镇收购价锁定。
// 只从批发市场取货；我方交不出货算违约（赔年货值 10%、关系分 −5，连续 3 次对方解约）；
// 外镇付不起小麦算对方违约（本月顺延）。交付的货进入外镇库存，照常影响现货价格。
export const AGREEMENT_MIN_YEARS = 1;
export const AGREEMENT_MAX_YEARS = 5;
export const AGREEMENT_BREACH_PENALTY_RATE = 0.1;
export const AGREEMENT_BREACH_RELATIONS_LOSS = 5;
export const AGREEMENT_BREACH_LIMIT = 3;
export const AGREEMENT_PARTNER_BREACH_RELATIONS_LOSS = 3;
export const RELATIONS_TRUSTED_PRICE_FACTOR = 1.05;
export const RELATIONS_TRUSTED_PENALTY_FACTOR = 0.5;

const round2 = value => Math.round(value * 100) / 100;

export function ensureTradeAgreements(state) {
  if (!Array.isArray(state.tradeAgreements)) state.tradeAgreements = [];
  return state.tradeAgreements;
}

export function readTradeAgreements(state) {
  const rows = Array.isArray(state.tradeAgreements) ? state.tradeAgreements : [];
  return rows.filter(row => row && typeof row === "object").map(row => ({ ...row }));
}

// 一年切 12 段（每月一段），每段交付一次。
function isMonthlySettlementDue(state, content) {
  const daysPerMonth = Math.max(1, Math.floor((content.rules.daysPerYear || 365) / 12));
  const monthIndex = Math.min(11, Math.floor((Math.max(1, state.day || 1) - 1) / daysPerMonth));
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

export function signTradeAgreement(state, { itemId, annualJin, years, content, townId = DEFAULT_OUTSIDE_TOWN_ID } = {}) {
  if (!content?.items) return { ok: false, reason: "缺少内容定义" };
  const profile = outsideTownProfile(content, townId);
  const town = outsideTown(state, content, townId);
  if (!profile || !town) return { ok: false, reason: "没有这个外镇" };
  if (town.tradeClosed) return { ok: false, reason: `商路中断，无法与${profile.name}签约` };
  if (!buildingOperational(state, "foreign_trade_house")) return { ok: false, reason: "外贸房无人值守，无法签约" };
  if (!profile.goods[itemId]) return { ok: false, reason: `${profile.name}不收购这种货` };
  const quantity = round2(Number(annualJin));
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, reason: "年供货量必须大于0" };
  const term = Math.floor(Number(years));
  if (!Number.isFinite(term) || term < AGREEMENT_MIN_YEARS || term > AGREEMENT_MAX_YEARS) {
    return { ok: false, reason: `年限须在${AGREEMENT_MIN_YEARS}—${AGREEMENT_MAX_YEARS}年之间` };
  }
  if (town.relations < RELATIONS_DISTRUST) return { ok: false, reason: `${profile.name}不信任你，拒绝签约` };
  const rows = ensureTradeAgreements(state);
  const staff = buildingStaffOnDuty(state, "foreign_trade_house");
  if (rows.filter(row => row.status === "active").length >= staff * AGREEMENTS_PER_STAFF) {
    return { ok: false, reason: `外贸房长协容量已满（在岗${staff}人 × ${AGREEMENTS_PER_STAFF}笔）` };
  }
  const spot = currentPrice(state, content, townId, itemId, "sell");
  if (!(spot > 0)) return { ok: false, reason: "当前价格无效，无法定价" };
  const trusted = town.relations >= RELATIONS_TRUSTED;
  const price = round2(spot * (trusted ? RELATIONS_TRUSTED_PRICE_FACTOR : 1));
  const agreement = {
    id: nextAgreementId(state),
    townId,
    itemId,
    annualJin: quantity,
    yearsTotal: term,
    yearsLeft: term,
    pricePerUnit: price,
    monthlyJin: round2(quantity / 12),
    breachCount: 0,
    status: "active",
    signYear: state.year,
    signDay: state.day
  };
  rows.push(agreement);
  recordEvent(state, `与${profile.name}签订${content.items[itemId]?.name || itemId}长期协定：每年${Math.round(quantity)}，锁定单价${price}${trusted ? "（关系融洽，价×1.05）" : ""}，为期${term}年。`, content);
  return { ok: true, agreement };
}

function returnToMarket(state, itemId, units) {
  const market = state.wholesaleMarket;
  if (units > 0 && market?.inventory) market.inventory[itemId] = (market.inventory[itemId] || 0) + units;
}

// 违约金从镇库小麦扣，不够就扣光。
function payBreachPenalty(state, town, amountJin, content, reason) {
  const townWheat = Math.max(0, state.accounts?.town?.wheat || 0);
  const payUnits = Math.min(townWheat, Math.floor(amountJin * content.precision.inventoryUnitsPerJin));
  if (payUnits <= 0) return { paidJin: 0, shortfallJin: round2(amountJin) };
  state.accounts.town.wheat = townWheat - payUnits;
  const paidJin = unitsToQuantity(payUnits, content);
  town.wheatStockJin = round2(town.wheatStockJin + paidJin);
  recordLedger(state, {
    type: "trade_agreement_penalty", transactionId: makeTransactionId(state), source: "town", destination: "outside_town",
    itemId: "wheat", quantityUnits: payUnits, qeqUnits: 0, reason
  }, content);
  return { paidJin, shortfallJin: round2(Math.max(0, amountJin - paidJin)) };
}

function penaltyFor(agreement, town) {
  const rate = AGREEMENT_BREACH_PENALTY_RATE * (town.relations >= RELATIONS_TRUSTED ? RELATIONS_TRUSTED_PENALTY_FACTOR : 1);
  return round2(agreement.annualJin * agreement.pricePerUnit * rate);
}

// 违约一次：从镇库扣赔偿（不够就记欠）、关系分下降、违约次数 +1；连续违约到上限就单方面解约。
// 库存不足和运力不足都走这里，只是事件文字不同。
function breachAgreement(state, agreement, town, profile, content, { itemName, ledgerReason, eventLead }) {
  const paid = payBreachPenalty(state, town, penaltyFor(agreement, town), content, ledgerReason);
  agreement.breachCount = (agreement.breachCount || 0) + 1;
  changeRelations(town, -AGREEMENT_BREACH_RELATIONS_LOSS);
  const owedText = paid.shortfallJin > 0 ? `，镇库小麦不足，尚欠${Math.round(paid.shortfallJin)}斤` : "";
  recordEvent(state, `${eventLead}，向${profile.name}赔付小麦${Math.round(paid.paidJin)}斤${owedText}。`, content);
  if (agreement.breachCount < AGREEMENT_BREACH_LIMIT) return { terminated: false };
  agreement.status = "terminated";
  agreement.terminatedYear = state.year;
  agreement.terminatedDay = state.day;
  recordEvent(state, `${profile.name}连续${AGREEMENT_BREACH_LIMIT}个月未收到${itemName}，单方面解约。`, content);
  return { terminated: true };
}

export function settleTradeAgreementsMonth(state, content) {
  const rows = ensureTradeAgreements(state);
  const result = { delivered: 0, breached: 0, partnerBreached: 0, terminated: 0, revenueJin: 0, settled: false };
  if (!rows.length || !isMonthlySettlementDue(state, content)) return result;
  result.settled = true;
  for (const agreement of rows) {
    if (agreement.status !== "active") continue;
    const townId = agreement.townId || DEFAULT_OUTSIDE_TOWN_ID;
    const profile = outsideTownProfile(content, townId);
    const town = outsideTown(state, content, townId);
    if (!profile || !town || town.tradeClosed) continue;
    const itemName = content.items[agreement.itemId]?.name || agreement.itemId;
    const wantUnits = quantityToUnits(agreement.monthlyJin, content);
    // 运力：本月能运出的量不超过运力池余量（运力不够的部分在下面按违约处理）。
    const askUnits = Math.min(wantUnits, freightCapacityUnits(state, content));
    const takenUnits = hasWholesaleMarket(state) && askUnits > 0 ? (takeWholesaleInventoryForExport(state, agreement.itemId, askUnits, content)?.units || 0) : 0;
    if (takenUnits < askUnits) {
      // 库存不足：整月交付取消，按违约处理（与运力无关）。
      returnToMarket(state, agreement.itemId, takenUnits);
      const breach = breachAgreement(state, agreement, town, profile, content, {
        itemName,
        ledgerReason: `长期协定违约赔偿（${itemName}，欠${unitsToQuantity(wantUnits - takenUnits, content)}）`,
        eventLead: `长期协定未按期交付${itemName}`
      });
      result.breached += 1;
      if (breach.terminated) result.terminated += 1;
      continue;
    }
    const actualJin = unitsToQuantity(takenUnits, content);
    const orderJin = round2(actualJin * agreement.pricePerUnit);
    if (payableWheatJin(town, profile) < orderJin) {
      returnToMarket(state, agreement.itemId, takenUnits);
      changeRelations(town, -AGREEMENT_PARTNER_BREACH_RELATIONS_LOSS);
      result.partnerBreached += 1;
      recordEvent(state, `${profile.name}余粮不足，本月长期协定未能付款，交付顺延。`, content);
      continue;
    }
    if (takenUnits > 0) {
      town.wheatStockJin = round2(town.wheatStockJin - orderJin);
      addInventory(state, "town", "wheat", orderJin, `对${profile.name}长期协定交付${itemName}所得`, "trade_export", content);
      deliverToOutsideTown(town, agreement.itemId, actualJin);
      recordTradeStats(town, "sell", orderJin);
      takeFreightCapacity(state, actualJin, content);
      agreement.totalDeliveredJin = round2((agreement.totalDeliveredJin || 0) + actualJin);
      result.delivered += 1;
      result.revenueJin = round2(result.revenueJin + orderJin);
    }
    if (takenUnits < wantUnits) {
      // 运力不够：能运的已经运出，余下的按违约处理（赔偿、关系分、违约次数，与库存不足相同）。
      const shortJin = unitsToQuantity(wantUnits - takenUnits, content);
      const breach = breachAgreement(state, agreement, town, profile, content, {
        itemName,
        ledgerReason: `长期协定违约赔偿（${itemName}，运力不足欠${shortJin}）`,
        eventLead: `长期协定运力不足，${itemName}本月只运出${Math.round(actualJin)}斤（欠${Math.round(shortJin)}斤）`
      });
      result.breached += 1;
      if (breach.terminated) result.terminated += 1;
      continue;
    }
    agreement.breachCount = 0;
  }
  return result;
}

export function settleTradeAgreementsYear(state, content) {
  const expired = [];
  for (const agreement of ensureTradeAgreements(state)) {
    if (agreement.status !== "active") continue;
    agreement.yearsLeft = Math.max(0, (agreement.yearsLeft || 0) - 1);
    if (agreement.yearsLeft <= 0) {
      agreement.status = "expired";
      expired.push(agreement.id);
      const name = outsideTownProfile(content, agreement.townId || DEFAULT_OUTSIDE_TOWN_ID)?.name || "外镇";
      recordEvent(state, `与${name}的${content.items[agreement.itemId]?.name || agreement.itemId}长期协定已到期，可续签。`, content, { day: 1 });
    }
  }
  return { expired };
}

// 主动解约：赔年货值 10%（关系融洽减半），关系分 −5。
export function terminateTradeAgreement(state, id, content) {
  const agreement = ensureTradeAgreements(state).find(row => row.id === id);
  if (!agreement) return { ok: false, reason: "未找到该长期协定" };
  if (agreement.status !== "active") return { ok: false, reason: "该长期协定已结束" };
  const townId = agreement.townId || DEFAULT_OUTSIDE_TOWN_ID;
  const profile = outsideTownProfile(content, townId);
  const town = outsideTown(state, content, townId);
  const penaltyJin = penaltyFor(agreement, town);
  const paid = payBreachPenalty(state, town, penaltyJin, content, `主动解约赔偿（${content.items[agreement.itemId]?.name || agreement.itemId}）`);
  agreement.status = "terminated";
  agreement.terminatedYear = state.year;
  agreement.terminatedDay = state.day;
  changeRelations(town, -AGREEMENT_BREACH_RELATIONS_LOSS);
  const owedText = paid.shortfallJin > 0 ? `，镇库小麦不足，尚欠${Math.round(paid.shortfallJin)}斤` : "";
  recordEvent(state, `主动解除与${profile.name}的长期协定，赔付小麦${Math.round(paid.paidJin)}斤${owedText}。`, content);
  return { ok: true, penaltyJin, paidJin: paid.paidJin, shortfallJin: paid.shortfallJin };
}

export function selectTradeAgreementView(state, content, townId = DEFAULT_OUTSIDE_TOWN_ID) {
  const town = readOutsideTown(state, content, townId);
  const rows = readTradeAgreements(state).filter(row => (row.townId || DEFAULT_OUTSIDE_TOWN_ID) === townId);
  const staff = buildingStaffOnDuty(state, "foreign_trade_house");
  const capacity = staff * AGREEMENTS_PER_STAFF;
  const activeCount = readTradeAgreements(state).filter(row => row.status === "active").length;
  return {
    agreements: rows.map(row => ({ ...row, itemName: content.items[row.itemId]?.name || row.itemId, unit: content.items[row.itemId]?.unit || "斤" })),
    activeCount,
    capacity,
    relations: town ? round2(town.relations) : 0,
    trusted: town ? town.relations >= RELATIONS_TRUSTED : false,
    distrusted: town ? town.relations < RELATIONS_DISTRUST : true,
    operational: staff >= 1,
    staff
  };
}
