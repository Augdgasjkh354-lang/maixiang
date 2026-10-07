import { qeqUnitsForInventoryUnits } from "./inventory.js";

function ensureBusiness(state) {
  if (!state.business) state.business = { inventoryCostWheatUnits: { town: {} }, buildings: {}, day: {}, year: {}, cumulative: {} };
  if (!state.business.inventoryCostWheatUnits) state.business.inventoryCostWheatUnits = { town: {} };
  if (!state.business.inventoryCostWheatUnits.town) state.business.inventoryCostWheatUnits.town = {};
  if (!state.business.buildings) state.business.buildings = {};
  return state.business;
}

function counter(group, key) {
  if (!group.producedUnits) group.producedUnits = {};
  group.producedUnits[key] = (group.producedUnits[key] || 0);
}

function inventoryUnitCost(state, itemId, content) {
  const business = ensureBusiness(state);
  if (business.inventoryCostWheatUnits.town[itemId] === undefined) {
    const item = content.items[itemId];
    const units = state.accounts.town[itemId] || 0;
    const rate = Number.isFinite(item?.openingCostWheatPerJin) ? item.openingCostWheatPerJin : 0;
    business.inventoryCostWheatUnits.town[itemId] = Math.round(units * rate);
  }
  return business.inventoryCostWheatUnits.town[itemId];
}

export function quoteTownCostRemoval(state, itemId, quantityUnits, content) {
  const available = state.accounts.town[itemId] || 0;
  const basis = inventoryUnitCost(state, itemId, content);
  if (!Number.isSafeInteger(quantityUnits) || quantityUnits < 0 || quantityUnits > available) {
    throw new RangeError("成本核算数量超出镇库库存：" + itemId);
  }
  const costWheatUnits = quantityUnits === available
    ? basis
    : (available === 0 ? 0 : Math.floor(basis * quantityUnits / available));
  return { itemId, quantityUnits, costWheatUnits, remainingCostWheatUnits: basis - costWheatUnits };
}

export function applyTownCostRemoval(state, quote) {
  ensureBusiness(state).inventoryCostWheatUnits.town[quote.itemId] = quote.remainingCostWheatUnits;
  return quote.costWheatUnits;
}

export function removeTownInventoryWithCost(state, itemId, quantityUnits, content) {
  const quote = quoteTownCostRemoval(state, itemId, quantityUnits, content);
  state.accounts.town[itemId] -= quantityUnits;
  applyTownCostRemoval(state, quote);
  return quote;
}

export function addTownCostBasis(state, itemId, costWheatUnits) {
  if (!Number.isSafeInteger(costWheatUnits) || costWheatUnits < 0) throw new TypeError("成本必须为非负整数");
  const business = ensureBusiness(state);
  business.inventoryCostWheatUnits.town[itemId] =
    (business.inventoryCostWheatUnits.town[itemId] || 0) + costWheatUnits;
}

function splitCost(totalCost, rows) {
  const weightTotal = rows.reduce((sum, row) => sum + row.weight, 0);
  if (totalCost <= 0 || weightTotal <= 0) return rows.map(() => 0);
  let assigned = 0;
  return rows.map(function (row, index) {
    if (index === rows.length - 1) return totalCost - assigned;
    const part = Math.floor(totalCost * row.weight / weightTotal);
    assigned += part;
    return part;
  });
}

export function planProductionAccounting(state, building, recipe, batches, content) {
  const removals = [];
  let totalInputCost = 0;
  let rawInputCostWheatUnits = 0;
  for (const input of recipe.inputs) {
    const quantityUnits = Math.round(input.quantity * batches * content.precision.inventoryUnitsPerJin);
    const quote = quoteTownCostRemoval(state, input.itemId, quantityUnits, content);
    removals.push(quote);
    totalInputCost += quote.costWheatUnits;
    if ((recipe.accountingRawInputs || []).includes(input.itemId)) {
      rawInputCostWheatUnits += quote.costWheatUnits;
    }
  }
  const outputs = recipe.outputs.map(function (row) {
    const quantityUnits = Math.round(row.quantity * batches * content.precision.inventoryUnitsPerJin);
    return {
      itemId: row.itemId,
      quantityUnits,
      weight: qeqUnitsForInventoryUnits(content.items[row.itemId], quantityUnits, content)
    };
  });
  const losses = recipe.losses.map(function (row) {
    const quantityUnits = Math.round(row.quantity * batches * content.precision.inventoryUnitsPerJin);
    return {
      itemId: row.itemId,
      quantityUnits,
      weight: qeqUnitsForInventoryUnits(content.items[row.itemId], quantityUnits, content)
    };
  });
  const targets = [...outputs, ...losses];
  if (targets.reduce((sum, row) => sum + row.weight, 0) === 0) {
    for (const row of targets) row.weight = row.quantityUnits;
  }
  const costs = splitCost(totalInputCost, targets);
  let processingLossWheatUnits = 0;
  outputs.forEach(function (row, index) {
    row.costWheatUnits = costs[index] || 0;
  });
  losses.forEach(function (row, index) {
    row.costWheatUnits = costs[outputs.length + index] || 0;
    processingLossWheatUnits += row.costWheatUnits;
  });
  const definition = content.buildings[building.typeId];
  return {
    buildingId: building.id,
    sector: definition?.accountingSector || "bread",
    removals, outputs, losses, processingLossWheatUnits, rawInputCostWheatUnits
  };
}

export function commitProductionAccounting(state, plan) {
  const business = ensureBusiness(state);
  const industry = plan.sector === "bread"
    ? null
    : (state.industries?.[plan.sector] || null);
  for (const quote of plan.removals) applyTownCostRemoval(state, quote);
  for (const row of plan.outputs) {
    business.inventoryCostWheatUnits.town[row.itemId] =
      (business.inventoryCostWheatUnits.town[row.itemId] || 0) + row.costWheatUnits;
    const groups = industry
      ? [industry.day, industry.year, industry.cumulative]
      : [business.day, business.year, business.cumulative];
    for (const group of groups) {
      counter(group, row.itemId);
      group.producedUnits[row.itemId] += row.quantityUnits;
    }
    const record = business.buildings[plan.buildingId] ||
      (business.buildings[plan.buildingId] = { todayOutputUnits: {}, yearOutputUnits: {}, lifetimeOutputUnits: {} });
    for (const target of [record.todayOutputUnits, record.yearOutputUnits, record.lifetimeOutputUnits]) {
      target[row.itemId] = (target[row.itemId] || 0) + row.quantityUnits;
    }
  }
  if (!industry) {
    for (const group of [business.day, business.year, business.cumulative]) {
      group.processingLossWheatUnits = (group.processingLossWheatUnits || 0) + plan.processingLossWheatUnits;
      group.rawInputCostWheatUnits = (group.rawInputCostWheatUnits || 0) + plan.rawInputCostWheatUnits;
    }
  }
  return plan;
}

export function tradeAccounting(state, { breadUnits, wheatUnits, breadCostWheatUnits, breadCostQuote }, content) {
  const business = ensureBusiness(state);
  const quote = breadCostQuote || quoteTownCostRemoval(state, "bread", breadUnits, content);
  if (quote.costWheatUnits !== breadCostWheatUnits) throw new Error("面包库存成本在交易中发生变化");
  applyTownCostRemoval(state, quote);
  addTownCostBasis(state, "wheat", wheatUnits);
  for (const group of [business.day, business.year, business.cumulative]) {
    group.soldBreadUnits = (group.soldBreadUnits || 0) + breadUnits;
    group.revenueWheatUnits = (group.revenueWheatUnits || 0) + wheatUnits;
    group.breadCogsWheatUnits = (group.breadCogsWheatUnits || 0) + breadCostWheatUnits;
  }
  return quote;
}

export function addWageExpense(state, kind, wheatUnits, sector = "bread") {
  if (kind !== "construction" && sector !== "bread") {
    const industry = state.industries?.[sector];
    if (!industry) return;
    for (const group of [industry.day, industry.year, industry.cumulative]) {
      group.operatingWagesWheatUnits = (group.operatingWagesWheatUnits || 0) + wheatUnits;
    }
    return;
  }
  const business = ensureBusiness(state);
  const key = kind === "construction" ? "constructionWagesWheatUnits" : "operatingWagesWheatUnits";
  for (const group of [business.day, business.year, business.cumulative]) {
    group[key] = (group[key] || 0) + wheatUnits;
  }
}
