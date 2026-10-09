import { currentUnitPrice } from "./prices.js";
import { laborBatches, productivityFactor } from "./productivity.js";
import { voucherBalance } from "./currency.js";
import { maximumFullyPayableValueUnits, maximumPayableValueUnits } from "./payment.js";
import { populationStats, readJobCount, jobKeyForBuilding, privateJobKeyForBuilding, listedJobKeyForBuilding } from "../selectors/labor.js";
import { townOutputGate } from "../selectors/production.js";
import { householdConvertibleWheatUnits, householdList, isActiveHousehold } from "../systems/households.js";
import { targetBatchCap } from "../systems/production.js";
import { industryTypeIds } from "../content/buildings.js";
import { priceFactorOf, retailFloorOf } from "./price-adjust.js";


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
  if (!productId || (def.itemIds && !def.itemIds.includes(productId))) return null;
  const wholesale = currentUnitPrice(state, productId, content);
  if (def.kind === "stall") return stallTradePrices(state, def, content, productId, wholesale);
  const markup = def.id === "general" ? Math.max(0, content.rules.generalStoreMarkupPercent ?? 20) / 100 : Math.max(0, def.markupPercent ?? 0) / 100;
  let retail = wholesale * (1 + markup);
  if (def.id === "general" && shop) {
    const explicit = Number(shop.pricing?.retailPriceVoucherPerUnit?.[productId]);
    let base;
    if (Number.isFinite(explicit) && explicit > 0) base = explicit;
    else base = wholesale * (1 + shopTargetMarginPercentFor(shop, content) / 100);
    // 物价会动：库存系数作用在基准价上（见 economy/price-adjust.js）。
    // 售价下限不低于进货价（用户拍板的定价约束）；只有清库存（库存够卖超过 clearanceStockDays）时才可降到进货价 × minFactor。
    const floor = retailFloorOf(shop.pricing, productId, wholesale, content.rules.priceAdjust);
    retail = Math.max(floor, base * priceFactorOf(shop.pricing, productId));
  }
  return { ...def, itemId: productId, retailVoucherPerUnit: retail, wholesaleVoucherPerUnit: wholesale };
}

// 集市：进价 = 批发价减特价补贴；售价跟镇上最便宜的综合商店看齐（stallUndercutPercent 默认 0，同价时居民轮流在两边买），没有商店时按批发价加成，且不低于进价。
function stallTradePrices(state, def, content, productId, wholesale) {
  const tiers = content.rules.stallWholesaleDiscountTiers || [0];
  const tier = Math.max(0, Math.min(tiers.length - 1, Math.floor(state.policy?.stallDiscountTier || 0)));
  const cost = Math.max(wholesale * 0.1, wholesale - (tiers[tier] || 0));
  const storePrices = Object.values(state.shops || {})
    .filter(shop => shop.status === "open" && shop.typeId === "general")
    .map(shop => shopTradePrices(state, "general", content, productId, shop)?.retailVoucherPerUnit)
    .filter(price => price > 0);
  const reference = storePrices.length
    ? Math.min(...storePrices) * (1 - Math.max(0, content.rules.stallUndercutPercent ?? 3) / 100)
    : wholesale * (1 + Math.max(0, def.markupPercent ?? 10) / 100);
  return { ...def, itemId: productId, retailVoucherPerUnit: Math.max(cost, reference), wholesaleVoucherPerUnit: cost, listWholesaleVoucherPerUnit: wholesale };
}

// 内联版本，避免 operating-plan 反向 import 整个 shop-pricing 模块造成循环依赖。
function shopTargetMarginPercentFor(shop, content) {
  if (shop?.pricing?.promotion) return Math.max(0, Number(content.rules.generalStorePromotionTargetPercent ?? 5));
  const value = Number(shop?.pricing?.targetMarginPercent);
  if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  return Math.max(0, content.rules.generalStoreMarkupPercent ?? 20);
}

// 居民实际面对的综合商店零售价：营业中综合商店里最便宜的一家（与集市参考价同口径）；没有综合商店时按批发价加成。
// 只用于需求测算（主食/盐/日用品的可买量），口径跟随店铺的目标利润率、现售价与物价系数。
function generalStoreReferenceRetail(state, itemId, content) {
  const prices = Object.values(state.shops || {})
    .filter(shop => shop.status === "open" && shop.typeId === "general")
    .map(shop => shopTradePrices(state, "general", content, itemId, shop)?.retailVoucherPerUnit)
    .filter(price => price > 0);
  if (prices.length) return Math.min(...prices);
  return currentUnitPrice(state, itemId, content) * (1 + Math.max(0, content.rules.generalStoreMarkupPercent ?? 20) / 100);
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

// 市面上能卖给下家的现货：批发市场库存（民营产出都卖进这里）+ 公司库存 + 营业中店铺库存。
// 镇库存货（如民营实物税）不在市面上流通，没有批发市场时才算镇库。
function producerMarketStock(state, itemId) {
  const market = state.wholesaleMarket;
  let units = market?.inventory && (state.buildings || []).some(row => row.typeId === "wholesale_market")
    ? (market.inventory[itemId] || 0)
    : (state.accounts?.town?.[itemId] || 0);
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
  const price = generalStoreReferenceRetail(state, "bread", content);
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
  const price = generalStoreReferenceRetail(state, "salt", content);
  return Math.min(shortage, residentAffordableUnits(state, "salt", price, content));
}

// 酒、布等日用品：当日家庭需求由 goods-demand 系统写入 state.goodsDemand.todayDemandUnits。
function goodsDailyDemandUnits(state, itemId, content) {
  const demand = Math.max(0, state.goodsDemand?.todayDemandUnits?.[itemId] || 0);
  const shortage = Math.max(0, demand - (state.accounts?.residents?.[itemId] || 0));
  const price = generalStoreReferenceRetail(state, itemId, content);
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
      maxWorkers: job.slots * privateLevels, batchesPerWorkerDay: (recipe.batchesPerWorkerDay || 0) * productivityFactor(state, typeId, building.level),
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
      maxWorkers: job.slots * company.listedLevels, batchesPerWorkerDay: (recipe.batchesPerWorkerDay || 0) * productivityFactor(state, typeId, state.buildings.find(row => row.id === company.buildingId)?.level || 1),
      currentWorkers: readJobCount(state, listedJobKeyForBuilding(company.buildingId, job.id)), ageDays: company.plan?.ageDays || 0
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

// 镇营产业（ownership.townLevels > 0）不由计划派工：投产靠镇里人手和产出闸门（production.js）。
// 但它的投入需求与产出是真实的，计划要看见：投入计入上游的 downstreamUnits（否则民营磨坊看不到镇营面包房的面粉需求），
// 产出计入 plannedOutputUnits（否则下游民营面包房以为没有面粉）。
// 预计批次 = 在岗人手能做的批次 ∧ 目标日产量封顶 ∧ 镇营产出闸门（市场余量、口粮储备）。
// 不因原料库存封顶：缺料的镇营作坊同样在向上游发出需求。
function townExpectedBatches(state, typeId, content) {
  const definition = content.buildings[typeId];
  const recipe = content.recipes[definition?.recipeId];
  const role = (definition?.jobs || []).find(job => job.id === definition.productionRoleId);
  if (!recipe || !role) return 0;
  let batches = 0;
  for (const building of state.buildings || []) {
    if (building.typeId !== typeId || !(building.ownership?.townLevels > 0)) continue;
    const workers = readJobCount(state, jobKeyForBuilding(building.id, role.id));
    const labor = laborBatches(state, typeId, building.level, workers, recipe.batchesPerWorkerDay, building.productivityCarry).batches;
    const wanted = Math.min(labor, targetBatchCap(building, recipe));
    batches += townOutputGate(state, recipe, wanted, content).batches;
  }
  return batches;
}

// 处理型产业的原料（单位/日）：镇库小麦；其他原料取批发市场库存（没有市场则镇库），
// 加上本产业自有生产者手里的库存（公司库存、民营业主家庭库存），再加上上游本周期的计划日产量。
// 只读：不调用会改 state 的函数（如 privateOwners）。
function inputAvailableUnits(state, typeId, itemId, upstreamOutputUnits) {
  if (itemId === "wheat") return Math.max(0, state.accounts?.town?.wheat || 0) + (upstreamOutputUnits[itemId] || 0);
  const hasMarket = (state.buildings || []).some(row => row.typeId === "wholesale_market");
  let units = hasMarket ? (state.wholesaleMarket?.inventory?.[itemId] || 0) : (state.accounts?.town?.[itemId] || 0);
  for (const company of Object.values(state.companies || {})) if (company.typeId === typeId) units += company.inventory?.[itemId] || 0;
  for (const building of state.buildings || []) {
    if (building.typeId !== typeId || !(building.ownership?.privateLevels > 0)) continue;
    for (const ownerId of new Set(building.privateOwners || [])) units += state.households?.byId?.[ownerId]?.inventory?.[itemId] || 0;
  }
  return Math.max(0, units) + (upstreamOutputUnits[itemId] || 0);
}

// 处理型产业按原料能撑起的最多批次（无原料配方返回 null）。
function inputBatchCap(state, typeId, content, upstreamOutputUnits) {
  const inputs = content.recipes[content.buildings[typeId]?.recipeId]?.inputs || [];
  if (!inputs.length) return null;
  let cap = Infinity;
  for (const input of inputs) {
    const perBatch = input.quantity * content.precision.inventoryUnitsPerJin;
    if (!(perBatch > 0)) continue;
    cap = Math.min(cap, Math.floor(inputAvailableUnits(state, typeId, input.itemId, upstreamOutputUnits) / perBatch));
  }
  return Number.isFinite(cap) ? Math.max(0, cap) : null;
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
  // 招人快、裁人慢；差一两个人（10% 以内）不折腾。
  const step = content.rules.operatingWorkerAdjustMaxPerCycle || 2;
  const deadband = Math.max(0, Math.floor(row.currentWorkers * 0.1));
  if (Math.abs(desired - row.currentWorkers) <= deadband) desired = row.currentWorkers;
  if (desired > row.currentWorkers) desired = Math.min(desired, row.currentWorkers + step);
  if (desired < row.currentWorkers) desired = Math.max(desired, row.currentWorkers - 1);
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
  // 备货缺口分几天补齐，不一次补完：避免一个计划期内多产一倍、下个计划期又停工的来回摆动。
  const correctionDays = Math.max(1, content.rules.operatingStockCorrectionDays || 5);
  const demandUnits = consumer + downstream;
  const basis = consumer > 0 && downstream > 0 ? "居民需求与下游生产计划"
    : consumer > 0 ? "家庭可支付需求与近期实销"
    : downstream > 0 ? "按下游生产计划形成原料需求" : "暂无需求";
  const stockGap = Math.round(consumer * targetDays) - stock;
  return { itemId, demandUnits, stockUnits: stock, targetUnits: Math.max(0, demandUnits + Math.round(stockGap / correctionDays)), basis };
}

export function ensureOperatingPlanState(state) {
  state.market ||= {};
  state.market.operatingPlan ||= { updatedSerial: -1, rotation: {}, rows: {}, demand: {}, plannedOutputUnits: {} };
  state.market.operatingPlan.plannedOutputUnits ||= {};
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
  plan.plannedOutputUnits = {};
  plan.rows = {};
  plan.demand = {};
  const scale = content.precision.inventoryUnitsPerJin;
  const order = industryTypeIds(content);
  const drafts = {};
  // 第一遍，从下游往上游：先定面包、酒、布要多少，再把它们照实需要的原料（不受原料封顶影响）传给磨坊、棉田。
  // 需求不封顶是关键：否则下游缺料少报需求 → 上游少产 → 下游更缺，一路缩到停产。
  const downstreamUnits = {};
  for (const typeId of order.slice().reverse()) {
    const target = productionTargetForType(state, typeId, content, downstreamUnits);
    const perBatch = outputPerBatch(typeId, content);
    let totalBatches = perBatch > 0 ? Math.ceil(target.targetUnits / perBatch) : 0;
    const producers = producerRows(state, typeId, content);
    if (totalBatches <= 0 && producers.some(row => row.ageDays < (content.rules.newBusinessTrialDays || 6))) totalBatches = 1;
    const rotation = plan.rotation[typeId] || 0;
    const townBatches = townExpectedBatches(state, typeId, content);
    const demandBatches = Object.values(distributeBatches(totalBatches, producers, rotation)).reduce((sum, value) => sum + value, 0) + townBatches;
    for (const input of content.recipes[content.buildings[typeId]?.recipeId]?.inputs || []) {
      downstreamUnits[input.itemId] = (downstreamUnits[input.itemId] || 0) + Math.round(demandBatches * input.quantity * scale);
    }
    drafts[typeId] = { target, totalBatches, producers, rotation, townBatches };
  }
  // 第二遍，从上游往下游：上游本周期能真正产出多少（受实际能招到的人限制）+ 现货，决定下游最多做多少批。
  for (const typeId of order) {
    const { target, producers, rotation, townBatches } = drafts[typeId];
    let { totalBatches } = drafts[typeId];
    const inputCap = inputBatchCap(state, typeId, content, plan.plannedOutputUnits);
    if (inputCap !== null && inputCap < totalBatches) {
      totalBatches = inputCap;
      target.basis = `原料不足：${target.basis}`;
    }
    const batches = distributeBatches(totalBatches, producers, rotation);
    if (producers.length) plan.rotation[typeId] = (rotation + 1) % producers.length;
    let effectiveBatches = 0;
    for (const row of producers) {
      const planned = batches[row.key] || 0;
      const desired = desiredWorkers(row, planned, state, content);
      effectiveBatches += Math.min(planned, Math.floor(desired * row.batchesPerWorkerDay));
      const entry = { ...row, plannedBatches: planned, desiredWorkers: desired, demandBasis: target.basis,
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
    plan.demand[typeId] = { ...target, inputLimitedBatches: inputCap, townBatches };
    // 下游能指望的上游日产量：计划批次，但不超过本周期实际能招到的人做得完的量；镇营产出按预计批次计入。
    for (const output of content.recipes[content.buildings[typeId]?.recipeId]?.outputs || []) {
      plan.plannedOutputUnits[output.itemId] = (plan.plannedOutputUnits[output.itemId] || 0) + Math.round((effectiveBatches + townBatches) * output.quantity * scale);
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
