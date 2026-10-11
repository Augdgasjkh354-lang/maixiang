import { currencyScale } from "../economy/currency.js";
import { createHouseholdPaymentContext, maximumFullyPayableValueUnits, maximumPayableValueUnits } from "../economy/payment.js";
import { householdOwner } from "../economy/accounts.js";
import { householdList, householdPopulation, isActiveHousehold, householdConvertibleWheatUnits, withDeferredHouseholdSync } from "./households.js";
import { ensureHouseholdLife } from "./household-life.js";
import { householdBudgets } from "./household-budget.js";
import { recordShopServiceSale, serviceShopCapacityUses, shopDefinition } from "./shops.js";
import { arenaAttendanceFactor } from "./arena.js";

const DEMAND_SCALE = 1000;

// 服务定义的 demandModifier（按名字引用的需求修正系数，返回数值；1 = 不修正）。
const DEMAND_MODIFIERS = Object.freeze({
  arenaExcitement: (state, content) => arenaAttendanceFactor(state, content)
});

function emptyServiceDay() {
  return { demandedUses: {}, attemptedUses: {}, servedUses: {}, unaffordableUses: {}, capacityUnmetUses: {}, spendingVoucherUnits: 0, wagerAttendees: {} };
}

function ensureServiceState(state) {
  state.services ||= {};
  state.services.demandByHousehold ||= {};
  state.services.carryByHousehold ||= {};
  state.services.pricesVoucherPerUse ||= {};
  state.services.mealsByHousehold ||= {};
  state.services.rotation ||= { households: 0, shops: {}, services: 0 };
  state.services.rotation.shops ||= {};
  state.services.day ||= emptyServiceDay();
  state.services.day.wagerAttendees ||= {};
  state.services.day.attemptedUses ||= {};
  state.services.day.unaffordableUses ||= {};
  state.services.day.capacityUnmetUses ||= {};
  state.services.history ||= [];
  state.services.latentDays = Math.max(0, Math.floor(state.services.latentDays || 0));
  return state.services;
}

function rotated(list, offset) {
  if (!list.length) return list;
  const start = ((offset || 0) % list.length + list.length) % list.length;
  return list.slice(start).concat(list.slice(0, start));
}

// 服务的购买门槛：定义里有 minAffluence（宽裕度下限，如戏园 1.5）则只有达到的家庭会去；没有则人人可去。
function serviceOpenToAffluence(def, affluence) {
  const minimum = Number(def.minAffluence) || 0;
  return minimum <= 0 || affluence >= minimum;
}

function householdAffluenceFor(state, household, content) {
  return householdBudgets(state, content).get(household.id)?.affluence ?? 0;
}

function basisCount(household, def) {
  if (def.basis === "household") return 1;
  if (def.basis === "child") return Math.max(0, household.ageBands?.children || 0);
  return householdPopulation(household);
}

export function serviceUnitPrice(state, serviceId, content) {
  const def = content.rules.serviceTypes?.[serviceId];
  if (!def) return 0;
  const configured = state.services?.pricesVoucherPerUse?.[serviceId];
  return Number.isFinite(configured) && configured >= 0 ? configured : Math.max(0, def.priceVoucher || 0);
}

export function setServiceUnitPrice(state, serviceId, value, content) {
  const def = content.rules.serviceTypes?.[serviceId];
  if (!def) return { ok: false, reason: "服务类型不存在" };
  if (!def.adjustablePrice) return { ok: false, reason: "该服务暂不开放调价" };
  const price = Math.round(Number(value) * 1000) / 1000;
  if (!Number.isFinite(price) || price < 0 || price > 1e6) return { ok: false, reason: "服务价格须为非负有限数值" };
  ensureServiceState(state).pricesVoucherPerUse[serviceId] = price;
  return { ok: true, serviceId, value: price };
}

export function serviceOutstandingUses(state, serviceId) {
  const serviceState = ensureServiceState(state);
  let milli = 0;
  for (const row of Object.values(serviceState.demandByHousehold)) milli += Math.max(0, row?.[serviceId] || 0);
  return milli / DEMAND_SCALE;
}

export function accrueServiceDemand(state, content) {
  const serviceState = ensureServiceState(state);
  serviceState.day = emptyServiceDay();
  serviceState.mealsByHousehold = {};
  const defs = content.rules.serviceTypes || {};
  // 营业中的服务店按服务编号登记（requiresShop 的服务只在有店时累计需求）。
  const openServiceIds = new Set();
  for (const shop of Object.values(state.shops || {})) {
    if (["closed", "liquidating"].includes(shop.status)) continue;
    const serviceId = shopDefinition(content, shop.typeId)?.serviceId;
    if (serviceId) openServiceIds.add(serviceId);
  }
  const hasServiceCapacity = openServiceIds.size > 0;
  // 没有任何服务店时只累计“潜在经过天数”，避免在多年无商业街模拟中每天扫描全部家庭。
  // 首家服务店出现时一次性按当前家庭规模补记，并受最大两周期上限约束。
  if (!hasServiceCapacity) {
    const maxRelevantDays = Math.max(1, ...Object.values(defs).map(def => Math.max(1, def.cycleDays || 1) * Math.max(1, content.rules.serviceDemandMaximumCycles || 2)));
    serviceState.latentDays = Math.min(maxRelevantDays, serviceState.latentDays + 1);
    return serviceState.day.demandedUses;
  }
  const elapsedDays = Math.max(1, 1 + serviceState.latentDays);
  serviceState.latentDays = 0;
  const activeIds = new Set();
  const defList = Object.values(defs);
  // 需求修正系数按服务算一次（全镇同一个值）；没有修正的服务为 1。
  const factorOf = new Map(defList.map(def => [def.id, def.demandModifier ? (DEMAND_MODIFIERS[def.demandModifier]?.(state, content) ?? 1) : 1]));
  for (const household of householdList(state).filter(isActiveHousehold)) {
    activeIds.add(household.id);
    const demand = serviceState.demandByHousehold[household.id] ||= {};
    const carry = serviceState.carryByHousehold[household.id] ||= {};
    const affluence = householdAffluenceFor(state, household, content);
    for (const def of defList) {
      // 需要店但全镇没有营业的店（如斗兽场）：不累计需求，也不留旧账（不写表，没有斗兽场的世界表与之前逐位一致）。
      if (def.requiresShop && !openServiceIds.has(def.id)) {
        if (demand[def.id]) demand[def.id] = 0;
        if (carry[def.id]) carry[def.id] = 0;
        continue;
      }
      // 不够门槛的家庭不产生这项需求（清零，不留旧账）。
      if (!serviceOpenToAffluence(def, affluence)) {
        demand[def.id] = 0;
        carry[def.id] = 0;
        continue;
      }
      const basis = basisCount(household, def);
      const denominator = Math.max(1, def.cycleDays);
      const basisDemand = basis * DEMAND_SCALE * elapsedDays;
      const factor = factorOf.get(def.id);
      const numerator = Math.max(0, carry[def.id] || 0) + (factor === 1 ? basisDemand : Math.round(basisDemand * factor));
      const add = Math.floor(numerator / denominator);
      carry[def.id] = numerator % denominator;
      const cap = basis * DEMAND_SCALE * Math.max(1, content.rules.serviceDemandMaximumCycles || 2);
      const before = Math.max(0, demand[def.id] || 0);
      demand[def.id] = Math.min(cap, before + add);
      serviceState.day.demandedUses[def.id] = (serviceState.day.demandedUses[def.id] || 0) + add / DEMAND_SCALE;
    }
  }
  for (const [householdId, row] of Object.entries(serviceState.demandByHousehold)) {
    if (activeIds.has(householdId)) continue;
    for (const serviceId of Object.keys(row || {})) row[serviceId] = 0;
  }
  return serviceState.day.demandedUses;
}

// 服务预算看可动用预算（household-budget：收入预期 + 家底 × usableWealthShare，摊到一年 360 天，× 服务占比），
// 不再看最近 7 天收入——农民的收入是一年一次的秋收，按周收入算会让他们永远"没钱"。
function householdDailyServiceBudget(state, household, content) {
  const budget = householdBudgets(state, content).get(household.id)?.serviceBudgetUnits || 0;
  if (budget <= 0) return 0;
  const owner = householdOwner(household.id);
  const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
  // maxWheatUnits 正是默认口粮天数下的可换小麦，带不带这个上限算出的支付能力完全相同，所以两处共用同一个上下文。
  const paymentContext = createHouseholdPaymentContext(state, household, content, maxWheatUnits, maxWheatUnits);
  const payable = maximumFullyPayableValueUnits(state, owner,
    maximumPayableValueUnits(state, owner, content, { paymentContext }), content, { maxWheatUnits, paymentContext });
  return Math.max(0, Math.min(budget, payable, Number.MAX_SAFE_INTEGER));
}

function serviceShops(state, serviceId, content) {
  return Object.values(state.shops || {})
    .filter(shop => shop.status === "open" && shopDefinition(content, shop.typeId)?.serviceId === serviceId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function outstandingMilli(state, householdId, serviceId) {
  return Math.max(0, state.services?.demandByHousehold?.[householdId]?.[serviceId] || 0);
}

function addComfort(household, amount, content) {
  const life = ensureHouseholdLife(household, content);
  const max = Math.max(0, content.rules.serviceComfortDailyMaximum || 3);
  life.day.serviceComfortPoints = Math.min(max, Math.max(0, life.day.serviceComfortPoints || 0) + Math.max(0, amount || 0));
}

export function processServiceDemand(state, content) {
  return withDeferredHouseholdSync(state, content, () => processServiceDemandNow(state, content));
}

function processServiceDemandNow(state, content) {
  const serviceState = ensureServiceState(state);
  const defs = Object.values(content.rules.serviceTypes || {});
  if (!defs.length) return { servedUses: {}, spendingVoucherUnits: 0 };
  const householdsBase = householdList(state).filter(isActiveHousehold);
  if (!householdsBase.length) return { servedUses: {}, spendingVoucherUnits: 0 };
  // 服务预算要试算付款能力（较贵）：只在这户今天第一次真要买服务时才算。
  const budgets = new Map();
  const budgetOf = household => {
    if (!budgets.has(household.id)) budgets.set(household.id, householdDailyServiceBudget(state, household, content));
    return budgets.get(household.id);
  };
  const households = rotated(householdsBase, serviceState.rotation.households || 0);
  // 家庭服务预算按“基础优先”分配：收入敏感度低的服务先满足，贫困家庭先保住基础服务、先砍高档消遣；
  // 固定顺序取代原来的每日轮换（轮换会让靠后的服务隔天饿死，日履约忽高忽低）。
  const services = [...defs].sort((x, y) => (Number(x.incomeSensitivity) || 1) - (Number(y.incomeSensitivity) || 1) || x.id.localeCompare(y.id));
  let totalSpent = 0;

  for (const def of services) {
    let shops = serviceShops(state, def.id, content);
    if (!shops.length) continue;
    shops = rotated(shops, serviceState.rotation.shops[def.id] || 0);
    const usedByShop = new Map(shops.map(shop => [shop.id, shop.accounts?.day?.serviceUses?.[def.id] || 0]));
    const price = Math.round(Math.max(0, serviceUnitPrice(state, def.id, content)) * currencyScale(content));
    if (price <= 0) continue;
    let shopCursor = 0;
    for (const household of households) {
      if (!serviceOpenToAffluence(def, householdAffluenceFor(state, household, content))) continue;
      let due = Math.floor(outstandingMilli(state, household.id, def.id) / DEMAND_SCALE);
      if (due <= 0) continue;
      const dailyNeed = Math.min(due, Math.max(1, basisCount(household, def)));
      serviceState.day.attemptedUses[def.id] = (serviceState.day.attemptedUses[def.id] || 0) + dailyNeed;
      const sensitivity = Math.max(0.25, Number(def.incomeSensitivity) || 1);
      const budget = budgetOf(household) || 0;
      // 高收入敏感服务（茶馆、戏园）要预算够“票价 × 敏感度”才肯去（门槛）；过了门槛按实际票价买，剩余预算不再作废。
      const gatePrice = Math.ceil(price * sensitivity);
      const affordableUses = budget >= Math.max(price, gatePrice) ? Math.floor(budget / price) : 0;
      let wanted = Math.min(dailyNeed, Math.max(0, affordableUses));
      serviceState.day.unaffordableUses[def.id] = (serviceState.day.unaffordableUses[def.id] || 0) + Math.max(0, dailyNeed - wanted);
      while (wanted > 0) {
        let selected = null;
        for (let offset = 0; offset < shops.length; offset += 1) {
          const index = (shopCursor + offset) % shops.length;
          const shop = shops[index];
          const used = usedByShop.get(shop.id) || 0;
          if (used < serviceShopCapacityUses(state, shop, content)) {
            selected = { shop, index };
            break;
          }
        }
        if (!selected) {
          serviceState.day.capacityUnmetUses[def.id] = (serviceState.day.capacityUnmetUses[def.id] || 0) + wanted;
          break;
        }
        const result = recordShopServiceSale(state, selected.shop.id, household.id, def.id, content, { ledgerType: def.ledgerType });
        if (!result.ok) {
          serviceState.day.unaffordableUses[def.id] = (serviceState.day.unaffordableUses[def.id] || 0) + wanted;
          break;
        }
        state.services.demandByHousehold[household.id][def.id] = Math.max(0,
          state.services.demandByHousehold[household.id][def.id] - DEMAND_SCALE);
        budgets.set(household.id, Math.max(0, (budgets.get(household.id) || 0) - result.paidValueUnits));
        // 出席名单（押注用）：按户记张数与买完票后的剩余预算。
        if (def.wagerable) {
          const row = (serviceState.day.wagerAttendees[def.id] ||= {});
          const entry = row[household.id] ||= { tickets: 0, budgetLeftUnits: 0 };
          entry.tickets += 1;
          entry.budgetLeftUnits = budgets.get(household.id) || 0;
        }
        usedByShop.set(selected.shop.id, (usedByShop.get(selected.shop.id) || 0) + 1);
        serviceState.day.servedUses[def.id] = (serviceState.day.servedUses[def.id] || 0) + 1;
        totalSpent += result.paidValueUnits;
        addComfort(household, def.comfort, content);
        if (def.mealReplacement) serviceState.mealsByHousehold[household.id] = (serviceState.mealsByHousehold[household.id] || 0) + 1;
        shopCursor = (selected.index + 1) % shops.length;
        wanted -= 1;
      }
    }
    if ((serviceState.day.servedUses[def.id] || 0) > 0) serviceState.rotation.shops[def.id] = (serviceState.rotation.shops[def.id] || 0) + 1;
  }
  serviceState.rotation.households = (serviceState.rotation.households || 0) + 1;
  serviceState.day.spendingVoucherUnits = totalSpent;
  serviceState.history.push({ year: state.year, day: state.day + 1, demandedUses: { ...serviceState.day.demandedUses }, attemptedUses: { ...serviceState.day.attemptedUses }, servedUses: { ...serviceState.day.servedUses }, unaffordableUses: { ...serviceState.day.unaffordableUses }, capacityUnmetUses: { ...serviceState.day.capacityUnmetUses }, spendingVoucherUnits: totalSpent });
  const limit = Math.max(14, (content.rules.operatingObservationDays || 7) * 4);
  if (serviceState.history.length > limit) serviceState.history.splice(0, serviceState.history.length - limit);
  return { servedUses: { ...serviceState.day.servedUses }, unaffordableUses: { ...serviceState.day.unaffordableUses }, capacityUnmetUses: { ...serviceState.day.capacityUnmetUses }, spendingVoucherUnits: totalSpent };
}

export { DEMAND_SCALE as SERVICE_DEMAND_SCALE };
