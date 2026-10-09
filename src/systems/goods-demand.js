import { purchaseItemForResidents } from "./consumer-market.js";
import { currentUnitPrice } from "../economy/prices.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { recordHouseholdInKind } from "./household-life.js";
import { householdAffluence } from "./household-budget.js";

// 日用品（酒、布、肉等）：配置在 rules.householdGoods。
// 每户当天想要的量 = 人口 × 年人均标准量 / 一年天数 × 宽裕度^收入弹性（宽裕度见 household-budget.js：
// 正常人家 1 倍，穷户接近 0，富户最多数倍）。买在主食和盐之后；用了加舒心值，超过标准量的部分边际递减；
// 买不到不扣分——这是生活改善，不是新的生存压力。
// 赶集：家里存货不够今天用时才去买，一次买够 householdGoodsShoppingDays（5）天的量；平时从存货里用。
// 买得起的人家自然约 5 天采购一次，各户错开，每天上街的户数约为五分之一（日结快很多）。

function goodsConfig(content) {
  return content.rules.householdGoods || {};
}

const targetsCache = new WeakMap();

export function ensureGoodsDemand(state) {
  state.goodsDemand ||= { todayDemandUnits: {}, day: {}, year: {} };
  for (const key of ["todayDemandUnits", "day", "year"]) state.goodsDemand[key] ||= {};
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

// 某户某样日用品的标准日量（宽裕度 1 时的量，库存单位）。
export function standardDailyUnits(people, cfg, content) {
  return people * cfg.annualPerPerson * content.precision.inventoryUnitsPerJin / content.rules.daysPerYear;
}

function householdTargets(state, content) {
  const targets = new Map();
  for (const household of householdList(state).filter(isActiveHousehold)) {
    const people = householdPopulation(household);
    const m = householdAffluence(state, household, content);
    const row = {};
    for (const [itemId, cfg] of Object.entries(goodsConfig(content))) {
      row[itemId] = Math.floor(standardDailyUnits(people, cfg, content) * Math.pow(m, cfg.incomeElasticity ?? 1));
    }
    targets.set(household.id, row);
  }
  return targets;
}

// 开日：按每户宽裕度算出当日想要的量（当天缓存，不进存档），全镇合计写进 todayDemandUnits 供排产参考。
export function accrueGoodsDemand(state, population, content) {
  const goods = ensureGoodsDemand(state);
  goods.day = emptyPeriod(content);
  if (state.day === 0 || !goods.year.demandUnits) goods.year = emptyPeriod(content);
  const targets = householdTargets(state, content);
  targetsCache.set(state, targets);
  for (const itemId of Object.keys(goodsConfig(content))) {
    let units = 0;
    for (const row of targets.values()) units += row[itemId] || 0;
    goods.todayDemandUnits[itemId] = units;
    addPeriods(state, "demandUnits", itemId, units);
  }
  return goods.todayDemandUnits;
}

function todaysTargets(state, content) {
  return targetsCache.get(state) || householdTargets(state, content);
}

export function buyGoodsForResidents(state, content) {
  ensureGoodsDemand(state);
  const targets = todaysTargets(state, content);
  const households = householdList(state).filter(isActiveHousehold);
  const shoppingDays = Math.max(1, Math.floor(content.rules.householdGoodsShoppingDays ?? 5));
  const results = {};
  for (const itemId of Object.keys(goodsConfig(content))) {
    const needs = {};
    let desired = 0;
    for (const household of households) {
      const daily = targets.get(household.id)?.[itemId] || 0;
      const stock = household.inventory?.[itemId] || 0;
      // 存货够今天用就不上街；不够时补到 shoppingDays 天的量。
      const shortage = stock >= daily ? 0 : Math.max(0, daily * shoppingDays - stock);
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

// 用掉当日想要的量（家里有多少用多少），记到家庭生活账（<item>ConsumedUnits），供舒心值计算。
export function consumeGoods(state, content) {
  ensureGoodsDemand(state);
  const targets = todaysTargets(state, content);
  const households = householdList(state).filter(isActiveHousehold);
  const results = {};
  for (const itemId of Object.keys(goodsConfig(content))) {
    let consumed = 0;
    for (const household of households) {
      const used = Math.min(household.inventory?.[itemId] || 0, Math.max(0, targets.get(household.id)?.[itemId] || 0));
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

// 舒心值：每样日用品按"当日用量 / 标准量"给分，用到标准量得 comfortMaximum，
// 再多边际递减（log2(1+比例)），最多 1.5 倍。
export function goodsComfortPoints(state, household, people, dayBook, content) {
  let points = 0;
  for (const [itemId, cfg] of Object.entries(goodsConfig(content))) {
    const need = standardDailyUnits(people, cfg, content);
    const used = dayBook?.[`${itemId}ConsumedUnits`] || 0;
    if (need <= 0 || used <= 0) continue;
    points += (cfg.comfortMaximum || 0) * Math.min(1.5, Math.log2(1 + used / need));
  }
  return points;
}
