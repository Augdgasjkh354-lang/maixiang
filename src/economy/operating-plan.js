import { currentUnitPrice } from "./prices.js";
import { voucherBalance } from "./currency.js";
import { maximumFullyPayableValueUnits, maximumPayableValueUnits } from "./payment.js";
import { populationStats, readJobCount, privateJobKeyForBuilding, listedJobKeyForBuilding } from "../selectors/labor.js";
import { householdConvertibleWheatUnits, householdList, isActiveHousehold } from "../systems/households.js";
import { industryTypeIds } from "../content/buildings.js";


function daySerial(state, content) {
  return (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
}

// 店铺交易价：批发价取当前单位价（= 批发市场售价），零售价按店铺定价策略计算。
// 0.2.3：综合商店若启用动态加价（shop.pricing.targetMarginPercent / 促销模式），
// 零售价 = 进货价 × (1 + 目标利润率)，并由 7 天复核写入 pricing.retailPriceVoucherPerUnit；
// 其他小店沿用 generalStoreMarkupPercent 固定加价。shop 可省略（旧调用/摘要只读场景）。
export function shopTradePrices(state, typeId, content, itemId = null, shop = null) {
  const raw = content.rules.shopTypes?.[typeId];
  if (!raw) return null;
  const def = raw.aliasOf ? content.rules.shopTypes?.[raw.aliasOf] : raw;
  if (!def || def.kind === "service") return null;
  const productId = itemId || raw.itemId || def.itemId || def.itemIds?.[0];
  if (!productId || !(def.itemIds || [productId]).includes(productId)) return null;
  const wholesale = currentUnitPrice(state, productId, content);
  const markup = def.id === "general" ? Math.max(0, content.rules.generalStoreMarkupPercent ?? 20) / 100 : 0;
  let retail = wholesale * (1 + markup);
  if (def.id === "general" && shop) {
    const explicit = Number(shop.pricing?.retailPriceVoucherPerUnit?.[productId]);
    if (Number.isFinite(explicit) && explicit > 0) retail = explicit;
    else {
      const target = shopTargetMarginPercentFor(shop, content);
      retail = wholesale * (1 + target / 100);
    }
    // 售价下限不低于进货价（用户拍板的定价约束）。
    retail = Math.max(wholesale, retail);
  }
  return { ...def, itemId: productId, retailVoucherPerUnit: retail, wholesaleVoucherPerUnit: wholesale };
}

// 内联版本，避免 operating-plan 反向 import 整个 shop-pricing 模块造成循环依赖。
function shopTargetMarginPercentFor(shop, content) {
  if (shop?.pricing?.promotion) return Math.max(0, Number(content.rules.generalStorePromotionTargetPercent ?? 5));
  const value = Number(shop?.pricing?.targetMarginPercent);
  if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  return Math.max(0, content.rules.generalStoreMarkupPercent ?? 20);
}

function rollingAverage(rows, key, window) {
  const slice = (rows || []).slice(-Math.max(1, window));
  if (!slice.length) return 0;
  return slice.reduce((sum, row) => sum + Number(row?.[key] || 0), 0) / slice.length;
}

function outputItemForType(typeId, content) {
  const recipe = content.recipes[content.buildings[typeId]?.recipeId];
  return recipe?.outputs?.[0]?.itemId || null;
}

function outputPerBatch(typeId, content) {
  const recipe = content.recipes[content.buildings[typeId]?.recipeId];
  return Math.round((recipe?.outputs?.[0]?.quantity || 0) * content.precision.inventoryUnitsPerJin);
}

function producerMarketStock(state, itemId) {
  let units = state.accounts?.town?.[itemId] || 0;
  for (const company of Object.values(state.companies || {})) units += company.inventory?.[itemId] || 0;
  for (const shop of Object.values(state.shops || {})) if (shop.status === "open") units += shop.inventory?.[itemId] || 0;
  return units;
}

function publicProcurementDeliverableStock(state, itemId) {
  // 镇库库存已从订单未满足量中扣除；这里只统计仍可卖给镇库的市场库存。
  let units = state.accounts?.residents?.[itemId] || 0;
  for (const company of Object.values(state.companies || {})) units += company.inventory?.[itemId] || 0;
  return Math.max(0, units);
}

function recentConsumerSalesUnits(state, itemId, content) {
  const rows = state.market?.consumerHistory?.[itemId] || [];
  return rollingAverage(rows, "soldUnits", content.rules.operatingObservationDays || 7);
}

function residentAffordableUnits(state, itemId, price, content) {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const maxWheatUnits = householdList(state).filter(isActiveHousehold).reduce((sum, household) =>
    sum + householdConvertibleWheatUnits(state, household, content, content.rules.basicCommerceFoodReserveDays ?? 30), 0);
  const limit = maximumPayableValueUnits(state, "residents", content);
  const budget = maximumFullyPayableValueUnits(state, "residents", limit, content, { maxWheatUnits });
  return Math.max(0, Math.floor(budget * content.precision.inventoryUnitsPerJin / (price * content.precision.currencyUnitsPerVoucher)));
}

function breadDailyDemandUnits(state, content) {
  const people = populationStats(state).total;
  const price = currentUnitPrice(state, "bread", content) * (1 + Math.max(0, content.rules.generalStoreMarkupPercent ?? 20) / 100);
  const base = content.rules.breadBasePriceWheatPerJin;
  const share = Math.max(0, Math.min(content.rules.breadTargetShareMaximum,
    content.rules.breadTargetShareAtBasePrice * Math.pow(base / price, content.rules.breadPriceElasticity)));
  const desiredJin = people * content.rules.foodPerPersonDay * share;
  const desiredUnits = Math.round(desiredJin * content.precision.inventoryUnitsPerJin);
  const residentStock = state.accounts?.residents?.bread || 0;
  const shortage = Math.max(0, desiredUnits - residentStock);
  return Math.min(shortage, residentAffordableUnits(state, "bread", price, content));
}

function saltDailyDemandUnits(state, content) {
  const demand = Math.max(0, state.salt?.todayDemandUnits || 0);
  const residentStock = state.accounts?.residents?.salt || 0;
  const shortage = Math.max(0, demand - residentStock);
  const price = currentUnitPrice(state, "salt", content) * (1 + Math.max(0, content.rules.generalStoreMarkupPercent ?? 20) / 100);
  return Math.min(shortage, residentAffordableUnits(state, "salt", price, content));
}

// 酒、布等日用品：当日家庭需求由 goods-demand 系统写入 state.goodsDemand.todayDemandUnits。
function goodsDailyDemandUnits(state, itemId, content) {
  const demand = Math.max(0, state.goodsDemand?.todayDemandUnits?.[itemId] || 0);
  const shortage = Math.max(0, demand - (state.accounts?.residents?.[itemId] || 0));
  const price = currentUnitPrice(state, itemId, content) * (1 + Math.max(0, content.rules.generalStoreMarkupPercent ?? 20) / 100);
  return Math.min(shortage, residentAffordableUnits(state, itemId, price, content));
}

function consumerDemandUnits(state, itemId, content) {
  if (itemId === "bread") return breadDailyDemandUnits(state, content);
  if (itemId === "salt") return saltDailyDemandUnits(state, content);
  if (state.goodsDemand?.todayDemandUnits?.[itemId] !== undefined) return goodsDailyDemandUnits(state, itemId, content);
  return 0;
}

function woodProcurementDemand(state, content) {
  const demand = state.market?.publicProcurementDemand?.wood || null;
  const required = Math.max(0, Math.floor(demand?.requiredUnits ?? demand?.wantedUnits ?? 0));
  const townStock = Math.max(0, state.accounts?.town?.wood || 0);
  const outstanding = Math.max(0, required - townStock);
  const price = currentUnitPrice(state, "wood", content);
  const budget = maximumFullyPayableValueUnits(state, "town", maximumPayableValueUnits(state, "town", content), content);
  const affordable = price > 0 ? Math.max(0, Math.floor(budget * content.precision.inventoryUnitsPerJin / (price * content.precision.currencyUnitsPerVoucher))) : 0;
  const funded = Math.min(outstanding, affordable);
  return { itemId: "wood", demandUnits: funded, outstandingUnits: outstanding, basis: !demand ? "暂无有预算的建设订单" : outstanding <= 0 ? "建设订单已由镇库库存覆盖" : funded <= 0 ? "建设采购预算不足" : funded < outstanding ? "建设采购仅部分有预算" : "有预算的实际建设采购" };
}

function producerRows(state, typeId, content) {
  const rows = [];
  for (const building of state.buildings || []) {
    if (building.typeId !== typeId) continue;
    const definition = content.buildings[typeId];
    const recipe = content.recipes[definition?.recipeId];
    const job = definition?.jobs?.[0];
    if (!recipe || !job) continue;
    const privateLevels = Math.max(0, building.ownership?.privateLevels || 0);
    if (privateLevels > 0) rows.push({
      key: `private:${building.id}`, kind: "private", buildingId: building.id, typeId,
      maxWorkers: job.slots * privateLevels, batchesPerWorkerDay: recipe.batchesPerWorkerDay || 0,
      currentWorkers: readJobCount(state, privateJobKeyForBuilding(building.id, job.id)), ageDays: state.privateEconomy?.plans?.[building.id]?.ageDays || 0
    });
  }
  for (const company of Object.values(state.companies || {})) {
    if (company.typeId !== typeId) continue;
    const definition = content.buildings[typeId];
    const recipe = content.recipes[definition?.recipeId];
    const job = definition?.jobs?.[0];
    if (!recipe || !job) continue;
    rows.push({
      key: `company:${company.id}`, kind: "company", companyId: company.id, buildingId: company.buildingId, typeId,
      maxWorkers: job.slots * company.listedLevels, batchesPerWorkerDay: recipe.batchesPerWorkerDay || 0,
      currentWorkers: readJobCount(state, listedJobKeyForBuilding(company.buildingId, job.id)), ageDays: company.plan?.ageDays || 0
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

function distributeBatches(totalBatches, producers, rotation = 0) {
  const result = Object.fromEntries(producers.map(row => [row.key, 0]));
  if (totalBatches <= 0 || !producers.length) return result;
  const ordered = producers.slice(rotation % producers.length).concat(producers.slice(0, rotation % producers.length));
  let left = Math.max(0, Math.floor(totalBatches));
  let active = ordered.map(row => ({ row, capacity: row.maxWorkers * row.batchesPerWorkerDay }));
  while (left > 0 && active.length) {
    const share = Math.max(1, Math.ceil(left / active.length));
    const next = [];
    let moved = 0;
    for (const entry of active) {
      if (left <= 0) break;
      const used = result[entry.row.key] || 0;
      const available = Math.max(0, entry.capacity - used);
      if (available <= 0) continue;
      const amount = Math.min(available, share, left);
      result[entry.row.key] = used + amount;
      left -= amount;
      moved += amount;
      if (available > amount) next.push(entry);
    }
    if (!moved) break;
    active = next;
  }
  return result;
}

function desiredWorkers(row, batches, state, content) {
  let desired = row.batchesPerWorkerDay > 0 ? Math.ceil(batches / row.batchesPerWorkerDay) : 0;
  if (desired <= 0 && row.ageDays < (content.rules.newBusinessTrialDays || 6)) desired = Math.min(row.maxWorkers, content.rules.newBusinessTrialWorkers || 1);
  if (row.kind === "company") {
    const company = state.companies?.[row.companyId];
    const job = content.buildings[row.typeId]?.jobs?.[0];
    const wage = state.employment?.wageRates?.[job?.id] ?? job?.wagePerWorkerDay ?? 5;
    const scale = content.precision.currencyUnitsPerVoucher;
    const cashWorkers = wage > 0 ? Math.floor(maximumPayableValueUnits(state, `company:${company?.id}`, content) / (wage * scale)) : row.maxWorkers;
    desired = Math.min(desired, Math.max(0, cashWorkers));
  }
  const step = content.rules.operatingWorkerAdjustMaxPerCycle || 2;
  if (desired > row.currentWorkers) desired = Math.min(desired, row.currentWorkers + step);
  if (desired < row.currentWorkers) desired = Math.max(desired, row.currentWorkers - step);
  return Math.max(0, Math.min(row.maxWorkers, desired));
}

// 某产业的生产目标：居民当日需求（含近期实销）+ 下游产业计划要用的原料 + 备货天数 − 市场现货。
// 木材例外：对应一次性公共建设订单，不备货。
function productionTargetForType(state, typeId, content, downstreamUnits) {
  const itemId = outputItemForType(typeId, content);
  if (!itemId) return { itemId, demandUnits: 0, targetUnits: 0, basis: "无产品" };
  if (itemId === "wood") {
    const row = woodProcurementDemand(state, content);
    const stock = publicProcurementDeliverableStock(state, "wood");
    return { ...row, stockUnits: stock, targetUnits: Math.max(0, row.demandUnits - stock) };
  }
  const consumer = Math.max(consumerDemandUnits(state, itemId, content), recentConsumerSalesUnits(state, itemId, content));
  const downstream = Math.max(0, downstreamUnits[itemId] || 0);
  const stock = producerMarketStock(state, itemId);
  const targetDays = content.rules.producerInventoryTargetDays || 2;
  const demandUnits = consumer + downstream;
  const basis = consumer > 0 && downstream > 0 ? "居民需求与下游生产计划"
    : consumer > 0 ? "家庭可支付需求与近期实销"
    : downstream > 0 ? "按下游生产计划形成原料需求" : "暂无需求";
  return { itemId, demandUnits, stockUnits: stock, targetUnits: Math.max(0, demandUnits + Math.round(consumer * targetDays) - stock), basis };
}

export function ensureOperatingPlanState(state) {
  state.market ||= {};
  state.market.operatingPlan ||= { updatedSerial: -1, rotation: {}, rows: {}, demand: {} };
  state.market.consumerHistory ||= { bread: [], salt: [], wood: [] };
  state.privateEconomy ||= {};
  state.privateEconomy.plans ||= {};
  return state.market.operatingPlan;
}

export function refreshOperatingPlan(state, content, force = false) {
  const plan = ensureOperatingPlanState(state);
  const serial = daySerial(state, content);
  const interval = Math.max(1, content.rules.operatingPlanIntervalDays || 3);
  if (!force && plan.updatedSerial >= 0 && serial - plan.updatedSerial < interval) {
    for (const company of Object.values(state.companies || {})) if (company.plan) company.plan.ageDays = (company.plan.ageDays || 0) + 1;
    for (const value of Object.values(state.privateEconomy.plans || {})) value.ageDays = (value.ageDays || 0) + 1;
    return plan;
  }
  plan.updatedSerial = serial;
  plan.rows = {};
  plan.demand = {};
  // 从下游往上游排：先定面包、酒、布的产量，再按它们要用的原料推出面粉、棉花的产量。
  const downstreamUnits = {};
  for (const typeId of industryTypeIds(content).reverse()) {
    const target = productionTargetForType(state, typeId, content, downstreamUnits);
    const perBatch = outputPerBatch(typeId, content);
    let totalBatches = perBatch > 0 ? Math.ceil(target.targetUnits / perBatch) : 0;
    const producers = producerRows(state, typeId, content);
    if (totalBatches <= 0 && producers.some(row => row.ageDays < (content.rules.newBusinessTrialDays || 6))) totalBatches = 1;
    const rotation = plan.rotation[typeId] || 0;
    const batches = distributeBatches(totalBatches, producers, rotation);
    if (producers.length) plan.rotation[typeId] = (rotation + 1) % producers.length;
    for (const row of producers) {
      const desired = desiredWorkers(row, batches[row.key] || 0, state, content);
      const entry = { ...row, plannedBatches: batches[row.key] || 0, desiredWorkers: desired, demandBasis: target.basis,
        demandUnits: target.demandUnits || 0, marketStockUnits: target.stockUnits || 0 };
      plan.rows[row.key] = entry;
      if (row.kind === "company") {
        const company = state.companies[row.companyId];
        company.plan = { ...(company.plan || {}), ...entry, ageDays: (company.plan?.ageDays || 0) + interval, updatedSerial: serial };
      } else {
        const old = state.privateEconomy.plans[row.buildingId] || {};
        state.privateEconomy.plans[row.buildingId] = { ...old, ...entry, ageDays: (old.ageDays || 0) + interval, updatedSerial: serial };
      }
    }
    plan.demand[typeId] = target;
    const plannedBatches = Object.values(batches).reduce((sum, value) => sum + value, 0);
    for (const input of content.recipes[content.buildings[typeId]?.recipeId]?.inputs || []) {
      downstreamUnits[input.itemId] = (downstreamUnits[input.itemId] || 0) + Math.round(plannedBatches * input.quantity * content.precision.inventoryUnitsPerJin);
    }
  }
  return plan;
}

export function plannedBatchesForProducer(state, key) {
  const row = state.market?.operatingPlan?.rows?.[key];
  return row ? Math.max(0, Math.floor(row.plannedBatches || 0)) : null;
}

export function plannedWorkersForProducer(state, key) {
  const row = state.market?.operatingPlan?.rows?.[key];
  return row ? Math.max(0, Math.floor(row.desiredWorkers || 0)) : null;
}

export function recordConsumerDay(state, content) {
  ensureOperatingPlanState(state);
  const limit = Math.max(14, (content.rules.operatingObservationDays || 7) * 4);
  const bread = Math.round((state.market?.lastDay?.purchasedBreadJin || 0) * content.precision.inventoryUnitsPerJin);
  const salt = Math.max(0, state.salt?.todaySatisfiedUnits || state.salt?.day?.purchasedUnits || 0);
  const goods = Object.entries(state.goodsDemand?.day?.purchasedUnits || {});
  for (const [itemId, soldUnits] of [["bread", bread], ["salt", salt], ...goods]) {
    const rows = state.market.consumerHistory[itemId] ||= [];
    rows.push({ year: state.year, day: state.day + 1, soldUnits });
    if (rows.length > limit) rows.splice(0, rows.length - limit);
  }
}

export function recentAverage(rows, key, content) {
  return rollingAverage(rows, key, content.rules.operatingObservationDays || 7);
}
