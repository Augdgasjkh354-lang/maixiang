import { purchaseItemForResidents } from "./consumer-market.js";
import { currentUnitPrice } from "../economy/prices.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { recordHouseholdInKind } from "./household-life.js";

// 日用品（酒、布等）：配置在 rules.householdGoods。
// 每天按人口算出全镇需求；手头宽裕（人均现金达到门槛）的家庭才去综合商店买，买在主食和盐之后。
// 用掉的量换成舒心值加成（满足需求得满分），买不到不扣分——这是生活改善，不是新的生存压力。

function goodsConfig(content) {
  return content.rules.householdGoods || {};
}

export function ensureGoodsDemand(state) {
  state.goodsDemand ||= { carry: {}, todayDemandUnits: {}, day: {}, year: {} };
  for (const key of ["carry", "todayDemandUnits", "day", "year"]) state.goodsDemand[key] ||= {};
  return state.goodsDemand;
}

function emptyPeriod(content) {
  const keys = Object.keys(goodsConfig(content));
  return {
    demandUnits: Object.fromEntries(keys.map(id => [id, 0])),
    purchasedUnits: Object.fromEntries(keys.map(id => [id, 0])),
    paidVoucherUnits: Object.fromEntries(keys.map(id => [id, 0])),
    consumedUnits: Object.fromEntries(keys.map(id => [id, 0]))
  };
}

function addPeriods(state, key, itemId, units) {
  for (const period of [state.goodsDemand.day, state.goodsDemand.year]) {
    period[key] ||= {};
    period[key][itemId] = (period[key][itemId] || 0) + units;
  }
}

// 开日：算出当日需求（按年人均量折日，零头结转）。
export function accrueGoodsDemand(state, population, content) {
  const goods = ensureGoodsDemand(state);
  goods.day = emptyPeriod(content);
  if (state.day === 0 || !goods.year.demandUnits) goods.year = emptyPeriod(content);
  for (const [itemId, cfg] of Object.entries(goodsConfig(content))) {
    const numerator = (goods.carry[itemId] || 0) + population * cfg.annualPerPerson * content.precision.inventoryUnitsPerJin;
    const units = Math.floor(numerator / content.rules.daysPerYear);
    goods.carry[itemId] = numerator % content.rules.daysPerYear;
    goods.todayDemandUnits[itemId] = units;
    addPeriods(state, "demandUnits", itemId, units);
  }
  return goods.todayDemandUnits;
}

// 每户当日应得的份额（按人口分）。
function householdShares(households, totalUnits) {
  const people = households.reduce((sum, household) => sum + householdPopulation(household), 0) || 1;
  let assigned = 0;
  return households.map((household, index) => {
    const units = index === households.length - 1 ? totalUnits - assigned : Math.floor(totalUnits * householdPopulation(household) / people);
    assigned += units;
    return { household, units };
  });
}

export function buyGoodsForResidents(state, content) {
  const goods = ensureGoodsDemand(state);
  const households = householdList(state).filter(isActiveHousehold);
  const results = {};
  for (const [itemId, cfg] of Object.entries(goodsConfig(content))) {
    const demand = goods.todayDemandUnits[itemId] || 0;
    const needs = {};
    let desired = 0;
    const minCash = (cfg.minCashVoucherPerCapita || 0) * content.precision.currencyUnitsPerVoucher;
    for (const { household, units } of householdShares(households, demand)) {
      const cashPerCapita = (household.voucherUnits || 0) / Math.max(1, householdPopulation(household));
      if (cashPerCapita < minCash) continue;
      const shortage = Math.max(0, units - (household.inventory?.[itemId] || 0));
      if (shortage <= 0) continue;
      needs[household.id] = shortage;
      desired += shortage;
    }
    if (desired <= 0) { results[itemId] = { purchasedUnits: 0, reason: "无人需要或买得起" }; continue; }
    const result = purchaseItemForResidents(state, itemId, desired, currentUnitPrice(state, itemId, content), content,
      `家庭购买${content.items[itemId]?.name || itemId}`, { householdNeedsUnits: needs });
    addPeriods(state, "purchasedUnits", itemId, result.purchasedUnits || 0);
    addPeriods(state, "paidVoucherUnits", itemId, result.paidVoucherUnits || 0);
    results[itemId] = { purchasedUnits: result.purchasedUnits || 0, paidVoucherUnits: result.paidVoucherUnits || 0, reason: result.reason };
  }
  return results;
}

// 用掉当日份额，记到家庭生活账（<item>ConsumedUnits），供舒心值计算。
export function consumeGoods(state, content) {
  const goods = ensureGoodsDemand(state);
  const households = householdList(state).filter(isActiveHousehold);
  const results = {};
  for (const itemId of Object.keys(goodsConfig(content))) {
    let consumed = 0;
    for (const { household, units } of householdShares(households, goods.todayDemandUnits[itemId] || 0)) {
      const used = Math.min(household.inventory?.[itemId] || 0, Math.max(0, units));
      if (used <= 0) continue;
      household.inventory[itemId] -= used;
      consumed += used;
      recordHouseholdInKind(state, household.id, `${itemId}ConsumedUnits`, used, content);
    }
    addPeriods(state, "consumedUnits", itemId, consumed);
    results[itemId] = consumed;
  }
  if (households.length) syncResidentAggregates(state, content);
  return results;
}

// 舒心值加成：每样日用品按"当日用量 / 当日应得量"给分，满额得 comfortMaximum。
export function goodsComfortPoints(state, household, people, dayBook, content) {
  let points = 0;
  for (const [itemId, cfg] of Object.entries(goodsConfig(content))) {
    const need = people * cfg.annualPerPerson * content.precision.inventoryUnitsPerJin / content.rules.daysPerYear;
    const used = dayBook?.[`${itemId}ConsumedUnits`] || 0;
    points += (cfg.comfortMaximum || 0) * Math.max(0, Math.min(1, need > 0 ? used / need : 0));
  }
  return points;
}
