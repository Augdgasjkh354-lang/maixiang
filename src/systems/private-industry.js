import { accountQeqUnits, atomicInventoryTransaction, quantityToUnits, qeqUnitsForInventoryUnits } from "../economy/inventory.js";
import { recordEvent } from "../economy/ledger.js";
import { privateJobKeyForBuilding, readJobCount, selectJobRows } from "../selectors/labor.js";
import { setPrivateWorkers } from "./employment.js";
import { addTownCostBasis } from "../economy/business.js";
import { currencyScale } from "../economy/currency.js";
import { plannedBatchesForProducer, plannedWorkersForProducer } from "../economy/operating-plan.js";
import { currentUnitPrice } from "../economy/prices.js";
import { buyWholesaleForOwner } from "./wholesale-market.js";
import { householdConvertibleWheatUnits, householdFoodQeqUnits, householdList, householdReserveQeqUnits, syncResidentAggregates, jobAssignments, isActiveHousehold, creditHouseholdInventory } from "./households.js";

import { accrueWageClaims, attributeLegacyUnattributedWageClaims, claimTotal, payMonetaryWageClaimsFromPayers } from "./wage-claims.js";
const SELLABLE = new Set(["mill", "bakery", "lumberyard", "saltworks"]);

function targetBatches(state, building) {
  return plannedBatchesForProducer(state, `private:${building.id}`);
}

function productionAvailableUnits(state, household, itemId, content) {
  const stock = Math.max(0, household.inventory?.[itemId] || 0);
  const item = content.items[itemId];
  if (!item?.edible) return stock;
  const reserve = qeqReserveForOwner(state, household.id, content);
  const food = householdFoodQeqUnits(state, household, content);
  const perUnit = qeqUnitsForInventoryUnits(item, 1, content);
  if (perUnit <= 0) return stock;
  return Math.max(0, Math.min(stock, Math.floor((food - reserve) / perUnit)));
}

function purchaseUnitsNeededForProduction(state, household, itemId, wantedUnits, content) {
  const stock = Math.max(0, household.inventory?.[itemId] || 0);
  const item = content.items[itemId];
  const directShortage = Math.max(0, wantedUnits - stock);
  if (!item?.edible) return directShortage;

  // Edible raw materials share the household food reserve. Buying only the recipe
  // quantity can still leave every newly bought unit protected as household food.
  // Buy enough to preserve the reserve *and* leave the planned recipe input usable.
  const reserve = qeqReserveForOwner(state, household.id, content);
  const food = householdFoodQeqUnits(state, household, content);
  const perUnit = qeqUnitsForInventoryUnits(item, 1, content);
  if (perUnit <= 0) return directShortage;
  const qeqShortageUnits = Math.max(0, Math.ceil((reserve + wantedUnits * perUnit - food) / perUnit));
  return Math.max(directShortage, qeqShortageUnits);
}

function buyMissingPrivateInputs(state, household, definition, recipe, batches, content) {
  const purchases = [];
  const shortages = [];
  for (const input of recipe.inputs || []) {
    const perBatch = quantityToUnits(input.quantity, content);
    const wantedUnits = perBatch * batches;
    let availableUnits = productionAvailableUnits(state, household, input.itemId, content);
    const missingUnits = purchaseUnitsNeededForProduction(state, household, input.itemId, wantedUnits, content);
    if (missingUnits > 0) {
      const purchase = buyWholesaleForOwner(
        state, `household:${household.id}`, input.itemId, missingUnits, content,
        `${household.name}为经营${definition.name}从批发市场采购${content.items[input.itemId]?.name || input.itemId}`
      );
      if (purchase.boughtUnits > 0) creditHouseholdInventory(state, household.id, input.itemId, purchase.boughtUnits, content);
      purchases.push({ itemId: input.itemId, requestedUnits: missingUnits, purchasedUnits: purchase.boughtUnits || 0, paidVoucherUnits: purchase.paidVoucherUnits || 0, reason: purchase.reason, sellerRows: purchase.sellerRows || [] });
      availableUnits = productionAvailableUnits(state, household, input.itemId, content);
      if (availableUnits < wantedUnits) shortages.push({
        itemId: input.itemId, missingUnits: wantedUnits - availableUnits, reason: purchase.reason
      });
    }
  }
  return { purchases, shortages };
}


export function arrangePrivateWorkers(state, content) {
  const rows = selectJobRows(state, content);
  let idle = rows.idle;
  const buildings = state.buildings.filter(row => SELLABLE.has(row.typeId) && (row.ownership?.privateLevels || 0) > 0)
    .sort((a, b) => ["bakery", "saltworks", "mill", "lumberyard"].indexOf(a.typeId) - ["bakery", "saltworks", "mill", "lumberyard"].indexOf(b.typeId) || a.id.localeCompare(b.id));
  for (const building of buildings) {
    const definition = content.buildings[building.typeId];
    const role = definition.jobs[0];
    const key = privateJobKeyForBuilding(building.id, role.id);
    const cap = role.slots * building.ownership.privateLevels;
    const plannedWorkers = plannedWorkersForProducer(state, `private:${building.id}`);
    const desired = Math.min(cap, plannedWorkers == null ? readJobCount(state, key) : plannedWorkers);
    const current = readJobCount(state, key);
    const next = Math.min(desired, current + idle);
    setPrivateWorkers(state, building.id, role.id, next, content);
    // 按实际招聘数扣减闲置（之前按请求值扣，招聘失败时多扣了）。
    const actual = readJobCount(state, key);
    idle -= Math.max(0, actual - current);
  }
}

function qeqReserveForOwner(state, ownerHouseholdId, content) {
  const household = state.households?.byId?.[ownerHouseholdId];
  return household ? householdReserveQeqUnits(state, household, content, content.rules.breadBasicReserveDays || 30) : 0;
}

function privateOwners(building, state) {
  const levels = Math.max(0, building.ownership?.privateLevels || 0);
  building.privateOwners ||= [];
  while (building.privateOwners.length < levels) {
    const candidates = householdList(state).filter(isActiveHousehold).sort((a, b) => a.id.localeCompare(b.id));
    const fallback = candidates[building.privateOwners.length % Math.max(1, candidates.length)];
    if (!fallback) break;
    building.privateOwners.push(fallback.id);
  }
  if (building.privateOwners.length > levels) building.privateOwners.length = levels;
  return building.privateOwners.slice();
}

function ownerCapacity(state, building, content) {
  const definition = content.buildings[building.typeId];
  const job = definition.jobs[0];
  const workers = readJobCount(state, privateJobKeyForBuilding(building.id, job.id));
  return { workers, batches: workers * content.recipes[definition.recipeId].batchesPerWorkerDay };
}

export function payPrivateIndustryWages(state, content) {
  state.privateEconomy ||= {}; state.privateEconomy.payrollByBuilding ||= {};
  const results = []; const scale = currencyScale(content);
  for (const building of state.buildings.filter(row => SELLABLE.has(row.typeId) && (row.ownership?.privateLevels || 0) > 0)) {
    const definition = content.buildings[building.typeId]; const job = definition?.jobs?.[0]; if (!job) continue;
    const key = privateJobKeyForBuilding(building.id, job.id); const workers = readJobCount(state, key);
    const rate = state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 5; const due = Math.round(workers * rate * scale);
    const payroll = state.privateEconomy.payrollByBuilding[building.id] ||= { arrearsVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0, cumulativePaidVoucherUnits: 0, claimsVoucherUnits: {} };
    const assignments = jobAssignments(state, key); accrueWageClaims(state, payroll, assignments, due, content);
    payroll.legacyUnattributedArrearsVoucherUnits ??= Math.max(0, (payroll.arrearsVoucherUnits || 0) - claimTotal(payroll));
    if (payroll.legacyUnattributedArrearsVoucherUnits > 0) {
      const attributed = attributeLegacyUnattributedWageClaims(state, payroll, payroll.legacyUnattributedArrearsVoucherUnits, assignments);
      payroll.legacyUnattributedArrearsVoucherUnits = Math.max(0, payroll.legacyUnattributedArrearsVoucherUnits - attributed.attributed);
    }
    payroll.arrearsVoucherUnits = claimTotal(payroll) + (payroll.legacyUnattributedArrearsVoucherUnits || 0); payroll.cumulativeAccruedVoucherUnits += due;
    const owners = privateOwners(building, state); const ownerLevels = new Map(); for (const householdId of owners) ownerLevels.set(householdId, (ownerLevels.get(householdId) || 0) + 1);
    // 过滤已消亡家庭，避免付款方失效导致欠薪永久挂账（之前不校验）。
    const liveOwners = [...ownerLevels.keys()].filter(ownerId => isActiveHousehold(state, ownerId));
    const payers = liveOwners.map(ownerId => ({
      id: `household:${ownerId}`,
      maxWheatUnits: householdConvertibleWheatUnits(state, state.households.byId[ownerId], content, content.rules.householdFoodReserveDays ?? 30)
    }));
    const previousDefer = Boolean(state._deferHouseholdSync); state._deferHouseholdSync = true;
    const paidResult = payMonetaryWageClaimsFromPayers(state, payroll, payers, content, "private_wage_payment",
      `${definition.name}民营业主偿付具体债权家庭工资`);
    state._deferHouseholdSync = previousDefer; if (!previousDefer) syncResidentAggregates(state, content);
    payroll.arrearsVoucherUnits = claimTotal(payroll) + (payroll.legacyUnattributedArrearsVoucherUnits || 0); payroll.cumulativePaidVoucherUnits += paidResult.paid;
    results.push({ buildingId: building.id, workers, dueVoucherUnits: due, paidVoucherUnits: paidResult.paid, arrearsVoucherUnits: payroll.arrearsVoucherUnits });
  }
  return results;
}

export function processPrivateBuilding(state, building, content) {
  const definition = content.buildings[building.typeId];
  const recipe = content.recipes[definition.recipeId];
  const { workers, batches: capacity } = ownerCapacity(state, building, content);
  const target = targetBatches(state, building);
  const planned = Math.min(capacity, target == null ? capacity : target);
  if (workers <= 0 || planned <= 0) return { buildingId: building.id, status: workers <= 0 ? "no_workers" : "no_demand", batches: 0 };
  const owners = privateOwners(building, state);
  if (!owners.length) return { buildingId: building.id, status: "no_owner", batches: 0, reason: "缺少家庭所有者" };
  const ownerLevels = new Map();
  for (const id of owners) ownerLevels.set(id, (ownerLevels.get(id) || 0) + 1);
  let batchesLeft = planned;
  let completed = 0;
  const taxRows = [];
  const transactionIds = [];
  const inputPurchases = [];
  const inputShortages = [];
  const ownerEntries = [...ownerLevels.entries()];
  for (let index = 0; index < ownerEntries.length; index += 1) {
    const [ownerHouseholdId, levels] = ownerEntries[index];
    const household = state.households?.byId?.[ownerHouseholdId];
    if (!household) continue;
    let ownerPlanned = index === ownerEntries.length - 1 ? batchesLeft : Math.floor(planned * levels / owners.length);
    ownerPlanned = Math.min(ownerPlanned, batchesLeft);
    if (ownerPlanned <= 0) continue;
    const supply = buyMissingPrivateInputs(state, household, definition, recipe, ownerPlanned, content);
    for (const row of supply.purchases) inputPurchases.push({ ownerHouseholdId, ...row });
    for (const row of supply.shortages) inputShortages.push({ ownerHouseholdId, ...row });
    let batches = ownerPlanned;
    for (const input of recipe.inputs) {
      const perBatch = quantityToUnits(input.quantity, content);
      batches = Math.min(batches, Math.floor(productionAvailableUnits(state, household, input.itemId, content) / perBatch));
    }
    if (batches <= 0) continue;
    const taxPercent = state.policy.privateProductionTaxPercent[building.typeId] ?? content.rules.privateProductionTaxDefaultPercent ?? 10;
    const outputs = [];
    const localTaxRows = [];
    const carryAfter = {};
    for (const output of recipe.outputs) {
      const totalUnits = quantityToUnits(output.quantity * batches, content);
      const carryKey = `${building.typeId}|${building.id}|${ownerHouseholdId}|${output.itemId}`;
      const carry = state.privateEconomy.taxRemainders[carryKey] || 0;
      const numerator = totalUnits * Math.round(taxPercent * 100) + carry;
      const taxUnits = Math.floor(numerator / 10000);
      carryAfter[carryKey] = numerator % 10000;
      const residentUnits = totalUnits - taxUnits;
      if (residentUnits > 0) outputs.push({ owner: `household:${ownerHouseholdId}`, itemId: output.itemId, quantityUnits: residentUnits, type: "private_production_output", source: "private_production" });
      if (taxUnits > 0) outputs.push({ owner: "town", itemId: output.itemId, quantityUnits: taxUnits, type: "private_production_tax", source: "private_production", destination: "town" });
      localTaxRows.push({ itemId: output.itemId, totalUnits, taxUnits, residentUnits, ownerHouseholdId, carryKey });
    }
    const inputs = recipe.inputs.map(input => ({ owner: `household:${ownerHouseholdId}`, itemId: input.itemId, quantityUnits: quantityToUnits(input.quantity * batches, content) }));
    const losses = recipe.losses.map(loss => ({ owner: `household:${ownerHouseholdId}`, itemId: loss.itemId, quantityUnits: quantityToUnits(loss.quantity * batches, content) }));
    const transaction = atomicInventoryTransaction(state, {
      inputs, outputs, losses, protectedOwner: `household:${ownerHouseholdId}`, minEndingQeqUnits: qeqReserveForOwner(state, ownerHouseholdId, content),
      inputType: "private_process_input", inputDestination: "private_processing",
      outputType: "private_production_output", outputSource: "private_production",
      reason: `${household.name}经营${definition.name}：${recipe.name}`, lossReason: recipe.name + "民营加工损耗"
    }, content);
    if (!transaction.ok) continue;
    for (const [key, value] of Object.entries(carryAfter)) state.privateEconomy.taxRemainders[key] = value;
    for (const row of localTaxRows) {
      const unitCost = content.items[row.itemId]?.openingCostWheatPerJin ?? 0;
      addTownCostBasis(state, row.itemId, Math.round(row.taxUnits * unitCost));
      taxRows.push(row);
    }
    const periodRows = [state.privateEconomy.day, state.privateEconomy.year, state.privateEconomy.cumulative];
    for (const row of localTaxRows) for (const period of periodRows) {
      period.producedUnits[row.itemId] = (period.producedUnits[row.itemId] || 0) + row.totalUnits;
      period.taxedUnits[row.itemId] = (period.taxedUnits[row.itemId] || 0) + row.taxUnits;
      period.outputUnits[row.itemId] = (period.outputUnits[row.itemId] || 0) + row.residentUnits;
    }
    for (const input of inputs) for (const period of periodRows) period.inputUnits[input.itemId] = (period.inputUnits[input.itemId] || 0) + input.quantityUnits;
    transactionIds.push(transaction.transactionId);
    completed += batches;
    batchesLeft -= batches;
  }
  syncResidentAggregates(state, content);
  if (completed <= 0) {
    const first = inputShortages[0];
    const itemName = first ? (content.items[first.itemId]?.name || first.itemId) : "原料";
    return { buildingId: building.id, status: "no_materials", batches: 0,
      reason: first ? `缺${itemName}：${first.reason}` : "经营家庭没有可用于生产的原料", inputPurchases, inputShortages };
  }
  const periodRows = [state.privateEconomy.day, state.privateEconomy.year, state.privateEconomy.cumulative];
  const internalLaborCostWheatUnits = Math.round(workers * (state.employment.wageRates[definition.productionRoleId] || 0) * content.precision.inventoryUnitsPerJin);
  for (const period of periodRows) period.internalLaborCostWheatUnits += internalLaborCostWheatUnits;
  const arrears = state.privateEconomy?.payrollByBuilding?.[building.id]?.arrearsVoucherUnits || 0;
  const firstShortage = inputShortages[0];
  const shortageReason = firstShortage ? `缺${content.items[firstShortage.itemId]?.name || firstShortage.itemId}：${firstShortage.reason}` : null;
  return { buildingId: building.id, status: arrears > 0 ? "wage_arrears" : completed < planned ? "limited_materials" : (planned < capacity ? "limited_demand" : "ready"),
    reason: completed < planned ? shortageReason : null, workers, batches: completed, plannedBatches: planned, transactionIds, taxRows, inputPurchases, inputShortages, wageArrearsVoucherUnits: arrears };
}

export function processPrivateIndustries(state, content) {
  const rows = [];
  const ordered = state.buildings.slice().sort((a, b) => ["mill", "bakery", "saltworks", "lumberyard"].indexOf(a.typeId) - ["mill", "bakery", "saltworks", "lumberyard"].indexOf(b.typeId));
  for (const building of ordered) {
    if (!SELLABLE.has(building.typeId) || !(building.ownership?.privateLevels || 0)) continue;
    rows.push(processPrivateBuilding(state, building, content));
  }
  state.privateEconomy.lastDay = rows;
  return rows;
}

export function resetPrivateDaily(state) {
  state.privateEconomy.day = { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 };
  state.privateEconomy.rightSales.dayWheatUnits = 0;
}

export function resetPrivateYear(state) {
  state.privateEconomy.year = { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 };
  state.privateEconomy.rightSales.yearWheatUnits = 0;
}
