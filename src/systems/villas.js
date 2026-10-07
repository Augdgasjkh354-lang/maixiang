import { currencyScale, voucherBalance } from "../economy/currency.js";
import { currentPaymentComposition, settleMonetaryPayment } from "../economy/payment.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import {
  householdConvertibleWheatUnits, householdList, householdPopulation,
  isActiveHousehold, syncResidentAggregates
} from "./households.js";

// 别墅群系统：富人购房（购房款全额进入镇库）、年度房产税（1月1日征收）。
// 购房款经统一支付层 household -> town 流转，不破坏粮券发行恒等式。

export const VILLAS_PER_COMPLEX = 20;
export const DEFAULT_VILLA_PRICE_WHEAT_JIN = 10000;
export const DEFAULT_VILLA_TAX_RATE_PERCENT = 0.5;

export function ensureVillaState(state) {
  state.villas ||= { sold: [], taxArrearsValueUnits: {}, stats: {} };
  const villas = state.villas;
  if (!Array.isArray(villas.sold)) villas.sold = [];
  villas.taxArrearsValueUnits ||= {};
  villas.stats ||= {};
  villas.stats.soldTotal ||= 0;
  villas.stats.revenueValueUnits ||= 0;
  villas.stats.taxCollectedValueUnits ||= 0;
  villas.stats.taxArrearsValueUnits ||= 0;
  return villas;
}

export function villaPolicy(state, content) {
  state.policy ||= {};
  const policy = state.policy.villa ||= {};
  policy.priceWheatJin ??= DEFAULT_VILLA_PRICE_WHEAT_JIN;
  policy.taxRatePercent ??= DEFAULT_VILLA_TAX_RATE_PERCENT;
  return policy;
}

// 家庭流动资产（小麦等值单位）：粮券 + 超出基本口粮储备的可折算小麦。
function householdLiquidValueUnits(state, household, content) {
  const vouchers = voucherBalance(state, `household:${household.id}`);
  const wheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
  return vouchers + voucherUnitsForWheatUnits(wheatUnits, content, "floor");
}

function villaComplexes(state) {
  return (state.buildings || []).filter(building => building.typeId === "villa_complex");
}

function soldVillaKeys(villas) {
  const keys = new Set();
  for (const row of villas.sold) keys.add(row.instanceId + ":" + row.villaIndex);
  return keys;
}

export function selectVillaVacancies(state) {
  const villas = ensureVillaState(state);
  const soldKeys = soldVillaKeys(villas);
  const vacant = [];
  for (const complex of villaComplexes(state)) {
    for (let index = 0; index < VILLAS_PER_COMPLEX; index++) {
      if (!soldKeys.has(complex.id + ":" + index)) vacant.push({ instanceId: complex.id, villaIndex: index });
    }
  }
  return vacant;
}

export function selectVillaStats(state, content) {
  const villas = ensureVillaState(state);
  const policy = villaPolicy(state, content);
  const scale = currencyScale(content);
  const complexes = villaComplexes(state);
  const vacant = selectVillaVacancies(state).length;
  const sold = villas.sold.length;
  return {
    complexes: complexes.length,
    capacity: complexes.length * VILLAS_PER_COMPLEX,
    sold,
    vacant,
    priceWheatJin: policy.priceWheatJin,
    taxRatePercent: policy.taxRatePercent,
    revenueWheatJin: (villas.stats.revenueValueUnits || 0) / scale,
    taxCollectedWheatJin: (villas.stats.taxCollectedValueUnits || 0) / scale,
    taxArrearsWheatJin: Object.values(villas.taxArrearsValueUnits || {}).reduce((sum, value) => sum + (value || 0), 0) / scale
  };
}

// 每日结算：按流动资产从高到低，让买得起的富裕家庭依次购入空置别墅（一户一栋）。
export function settleVillaPurchases(state, content) {
  const villas = ensureVillaState(state);
  const policy = villaPolicy(state, content);
  const scale = currencyScale(content);
  const priceUnits = Math.round(Math.max(0, Number(policy.priceWheatJin) || 0) * scale);
  if (priceUnits <= 0) return { sold: 0, reason: "别墅定价无效" };
  const vacant = selectVillaVacancies(state);
  if (!vacant.length) return { sold: 0 };
  const owners = new Set(villas.sold.map(row => row.householdId));
  // 生活困难线以下的部分不计入可动用购房资金，避免掏空穷人。
  const minimumPerCapita = content.rules.householdLiving?.difficultPerCapitaVoucher ?? 30;
  const candidates = householdList(state)
    .filter(household => isActiveHousehold(household) && !owners.has(household.id))
    .map(household => {
      const reserve = Math.round(householdPopulation(household) * minimumPerCapita * scale);
      const liquid = householdLiquidValueUnits(state, household, content);
      return { household, liquid, affordable: liquid - reserve };
    })
    .filter(row => row.affordable >= priceUnits)
    .sort((a, b) => b.liquid - a.liquid || String(a.household.id).localeCompare(String(b.household.id)));
  if (!candidates.length) return { sold: 0 };
  let sold = 0;
  let revenue = 0;
  for (const villa of vacant) {
    const candidate = candidates[sold];
    if (!candidate) break;
    const household = state.households?.byId?.[candidate.household.id];
    if (!household || owners.has(household.id)) continue;
    // 成交前复核一次购买力（同一日多人购房时资产已变动）。
    const minimum = content.rules.householdLiving?.difficultPerCapitaVoucher ?? 30;
    const reserve = Math.round(householdPopulation(household) * minimum * scale);
    if (householdLiquidValueUnits(state, household, content) - reserve < priceUnits) continue;
    const exchange = settleMonetaryPayment(state, `household:${household.id}`, "town",
      currentPaymentComposition(state, priceUnits), content,
      "villa_purchase", `${household.name}购买别墅（第${villa.villaIndex + 1}栋）；购房款全额进入镇库`,
      {
        requireFull: true,
        maxWheatUnits: householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30)
      });
    if (!exchange.ok) continue;
    villas.sold.push({
      householdId: household.id,
      instanceId: villa.instanceId,
      villaIndex: villa.villaIndex,
      priceValueUnits: priceUnits,
      priceWheatJin: policy.priceWheatJin,
      year: state.year, day: state.day + 1
    });
    owners.add(household.id);
    household.villaAssets = [...(household.villaAssets || []), {
      instanceId: villa.instanceId, villaIndex: villa.villaIndex,
      priceValueUnits: priceUnits, priceWheatJin: policy.priceWheatJin
    }];
    sold++;
    revenue += priceUnits;
    recordEvent(state, `${household.name}以${Number(policy.priceWheatJin).toLocaleString("zh-CN")}小麦等值购入别墅一栋，购房款已进入镇库。`, content, { day: state.day + 1 });
  }
  if (sold > 0) {
    villas.stats.soldTotal += sold;
    villas.stats.revenueValueUnits += revenue;
    const transactionId = makeTransactionId(state);
    recordLedger(state, {
      type: "villa_sale_revenue", transactionId, source: "residents", destination: "town",
      itemId: "money_value", quantityUnits: revenue, qeqUnits: 0,
      reason: `本日售出别墅${sold}栋，购房款全额进入镇库`
    }, content);
    syncResidentAggregates(state, content);
  }
  return { sold, revenueValueUnits: revenue };
}

// 每年1月1日：按 房价×税率 向别墅业主征收房产税；不足部分记欠税账，下次补扣。
export function settleVillaPropertyTax(state, content) {
  const villas = ensureVillaState(state);
  const policy = villaPolicy(state, content);
  const scale = currencyScale(content);
  if (!villas.sold.length) return { due: 0, collected: 0, arrears: 0 };
  const rate = Math.max(0, Number(policy.taxRatePercent) || 0) / 100;
  const taxPerVilla = Math.round(Math.max(0, Number(policy.priceWheatJin) || 0) * rate * scale);
  if (taxPerVilla <= 0 && Object.keys(villas.taxArrearsValueUnits).length === 0) {
    return { due: 0, collected: 0, arrears: 0 };
  }
  // 按户汇总：当年税 + 历史欠税。
  const dueByHousehold = new Map();
  for (const row of villas.sold) {
    dueByHousehold.set(row.householdId, (dueByHousehold.get(row.householdId) || 0) + taxPerVilla);
  }
  for (const [householdId, arrears] of Object.entries(villas.taxArrearsValueUnits || {})) {
    if (arrears > 0) dueByHousehold.set(householdId, (dueByHousehold.get(householdId) || 0) + arrears);
  }
  let collected = 0;
  let due = 0;
  const newArrears = {};
  for (const [householdId, amount] of dueByHousehold) {
    if (amount <= 0) continue;
    due += amount;
    const household = state.households?.byId?.[householdId];
    if (!household) { newArrears[householdId] = amount; continue; }
    const result = settleMonetaryPayment(state, `household:${householdId}`, "town",
      currentPaymentComposition(state, amount), content,
      "villa_property_tax", `${household.name}缴纳别墅房产税；不足部分记欠税`,
      {
        requireFull: false,
        maxWheatUnits: householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30)
      });
    const paid = result.paidValueUnits || 0;
    collected += paid;
    const remaining = amount - paid;
    if (remaining > 0) newArrears[householdId] = remaining;
  }
  villas.taxArrearsValueUnits = newArrears;
  villas.stats.taxCollectedValueUnits += collected;
  if (collected > 0) {
    const transactionId = makeTransactionId(state);
    recordLedger(state, {
      type: "villa_property_tax", transactionId, source: "residents", destination: "town",
      itemId: "money_value", quantityUnits: collected, qeqUnits: 0,
      reason: `年初征收别墅房产税，实收${collected}小麦等值单位`
    }, content);
  }
  const arrearsTotal = Object.values(newArrears).reduce((sum, value) => sum + value, 0);
  if (arrearsTotal > 0) recordEvent(state, `别墅房产税尚有${Math.round(arrearsTotal / scale).toLocaleString("zh-CN")}小麦等值未收足，已记欠税账。`, content, { day: 1 });
  syncResidentAggregates(state, content);
  return { dueValueUnits: due, collectedValueUnits: collected, arrearsValueUnits: arrearsTotal };
}

// 政策命令：调整别墅定价 / 税率。
export function setVillaPolicy(state, patch) {
  const policy = state.policy.villa ||= {};
  if (patch.priceWheatJin !== undefined) {
    const value = Number(patch.priceWheatJin);
    if (!Number.isFinite(value) || value < 0) return { ok: false, reason: "别墅定价无效" };
    policy.priceWheatJin = value;
  }
  if (patch.taxRatePercent !== undefined) {
    const value = Number(patch.taxRatePercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, reason: "房产税率须在0—100%之间" };
    policy.taxRatePercent = value;
  }
  return { ok: true, policy: { ...policy } };
}
