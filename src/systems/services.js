import { currencyScale } from "../economy/currency.js";
import { createPaymentCapabilityContext, maximumFullyPayableValueUnits, maximumPayableValueUnits } from "../economy/payment.js";
import { householdList, householdPopulation, isActiveHousehold, householdConvertibleWheatUnits } from "./households.js";
import { ensureHouseholdLife, householdRecentTotals } from "./household-life.js";
import { recordShopServiceSale, serviceShopCapacityUses, shopDefinition } from "./shops.js";

const DEMAND_SCALE = 1000;

function ensureServiceState(state) {
  state.services ||= {};
  state.services.demandByHousehold ||= {};
  state.services.carryByHousehold ||= {};
  state.services.pricesVoucherPerUse ||= {};
  state.services.mealsByHousehold ||= {};
  state.services.rotation ||= { households: 0, shops: {}, services: 0 };
  state.services.rotation.shops ||= {};
  state.services.day ||= { demandedUses: {}, attemptedUses: {}, servedUses: {}, unaffordableUses: {}, capacityUnmetUses: {}, spendingVoucherUnits: 0 };
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
  serviceState.day = { demandedUses: {}, attemptedUses: {}, servedUses: {}, unaffordableUses: {}, capacityUnmetUses: {}, spendingVoucherUnits: 0 };
  serviceState.mealsByHousehold = {};
  const defs = content.rules.serviceTypes || {};
  const hasServiceCapacity = Object.values(state.shops || {}).some(shop => {
    if (["closed", "liquidating"].includes(shop.status)) return false;
    return Boolean(shopDefinition(content, shop.typeId)?.serviceId);
  });
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
  for (const household of householdList(state).filter(isActiveHousehold)) {
    activeIds.add(household.id);
    const demand = serviceState.demandByHousehold[household.id] ||= {};
    const carry = serviceState.carryByHousehold[household.id] ||= {};
    for (const def of Object.values(defs)) {
      const basis = basisCount(household, def);
      const denominator = Math.max(1, def.cycleDays);
      const numerator = Math.max(0, carry[def.id] || 0) + basis * DEMAND_SCALE * elapsedDays;
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

function householdDailyServiceBudget(state, household, content) {
  const scale = currencyScale(content);
  const recent = householdRecentTotals(household, 7, content);
  const days = Math.max(1, recent.days || 1);
  const disposablePerDay = Math.max(0, ((recent.incomeVoucherUnits || 0) - (recent.lifeExpenseVoucherUnits || 0)) / days);
  const todayDisposable = Math.max(0, (ensureHouseholdLife(household, content).day.incomeVoucherUnits || 0) - (ensureHouseholdLife(household, content).day.lifeExpenseVoucherUnits || 0));
  const surplus = Math.max(disposablePerDay, todayDisposable);
  const share = Math.max(0, Math.min(100, content.rules.serviceBudgetSharePercent || 35)) / 100;
  const policyBudget = Math.floor(surplus * share);
  if (policyBudget <= 0) return 0;
  const owner = `household:${household.id}`;
  const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
  const paymentContext = createPaymentCapabilityContext(state, owner, content, { maxWheatUnits });
  // Keep the historical unbounded upper bound; only the repeated bounded quote search reuses derived capability data.
  const payable = maximumFullyPayableValueUnits(state, owner,
    maximumPayableValueUnits(state, owner, content), content, { maxWheatUnits, paymentContext });
  return Math.max(0, Math.min(policyBudget, payable, Number.MAX_SAFE_INTEGER));
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
  const serviceState = ensureServiceState(state);
  const defs = Object.values(content.rules.serviceTypes || {});
  if (!defs.length) return { servedUses: {}, spendingVoucherUnits: 0 };
  const householdsBase = householdList(state).filter(isActiveHousehold);
  if (!householdsBase.length) return { servedUses: {}, spendingVoucherUnits: 0 };
  const budgets = new Map(householdsBase.map(h => [h.id, householdDailyServiceBudget(state, h, content)]));
  const households = rotated(householdsBase, serviceState.rotation.households || 0);
  const services = rotated(defs, serviceState.rotation.services || 0);
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
      let due = Math.floor(outstandingMilli(state, household.id, def.id) / DEMAND_SCALE);
      if (due <= 0) continue;
      const dailyNeed = Math.min(due, Math.max(1, basisCount(household, def)));
      serviceState.day.attemptedUses[def.id] = (serviceState.day.attemptedUses[def.id] || 0) + dailyNeed;
      const sensitivity = Math.max(0.25, Number(def.incomeSensitivity) || 1);
      const budget = budgets.get(household.id) || 0;
      // 高收入敏感服务（茶馆）需要更宽裕的预算，基础服务更容易被购买。
      const effectivePrice = Math.ceil(price * sensitivity);
      const affordableUses = Math.floor(budget / Math.max(price, effectivePrice));
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
        const result = recordShopServiceSale(state, selected.shop.id, household.id, def.id, content);
        if (!result.ok) {
          serviceState.day.unaffordableUses[def.id] = (serviceState.day.unaffordableUses[def.id] || 0) + wanted;
          break;
        }
        state.services.demandByHousehold[household.id][def.id] = Math.max(0,
          state.services.demandByHousehold[household.id][def.id] - DEMAND_SCALE);
        budgets.set(household.id, Math.max(0, (budgets.get(household.id) || 0) - result.paidValueUnits));
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
  serviceState.rotation.services = (serviceState.rotation.services || 0) + 1;
  serviceState.day.spendingVoucherUnits = totalSpent;
  serviceState.history.push({ year: state.year, day: state.day + 1, demandedUses: { ...serviceState.day.demandedUses }, attemptedUses: { ...serviceState.day.attemptedUses }, servedUses: { ...serviceState.day.servedUses }, unaffordableUses: { ...serviceState.day.unaffordableUses }, capacityUnmetUses: { ...serviceState.day.capacityUnmetUses }, spendingVoucherUnits: totalSpent });
  const limit = Math.max(14, (content.rules.operatingObservationDays || 7) * 4);
  if (serviceState.history.length > limit) serviceState.history.splice(0, serviceState.history.length - limit);
  return { servedUses: { ...serviceState.day.servedUses }, unaffordableUses: { ...serviceState.day.unaffordableUses }, capacityUnmetUses: { ...serviceState.day.capacityUnmetUses }, spendingVoucherUnits: totalSpent };
}

export { DEMAND_SCALE as SERVICE_DEMAND_SCALE };
