import { itemQeqUnitsPerInventoryUnit, planFoodTransfer, qeqUnitsToJin } from "../economy/inventory.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { recordHouseholdInKind } from "./household-life.js";

function foodPriority(content) {
  return Object.values(content.items)
    .filter(item => item.edible && item.qeq)
    .sort((a, b) => (a.transferPriority || 0) - (b.transferPriority || 0));
}

// Daily consumption may take one extra indivisible inventory unit when the household has
// enough food-QEQ in total but exact QEQ cannot be represented by whole inventory units.
// Transfer/relief semantics remain in planFoodTransfer and are intentionally unchanged.
export function planDailyFoodConsumption(account, demandQeqUnits, content) {
  const plan = planFoodTransfer(account, demandQeqUnits, content, true);
  const baseMoves = plan.moves.map(move => ({ ...move, roundingExcessQeqUnits: 0 }));
  if (plan.remainingQeqUnits <= 0) return { ...plan, moves: baseMoves, roundingExcessQeqUnits: 0 };

  let availableQeqUnits = 0;
  for (const item of foodPriority(content)) {
    const perUnit = itemQeqUnitsPerInventoryUnit(item, content);
    availableQeqUnits += Math.max(0, Math.floor(account[item.id] || 0)) * perUnit;
  }
  if (availableQeqUnits < plan.requestedQeqUnits) {
    return { ...plan, moves: baseMoves, roundingExcessQeqUnits: 0 };
  }

  const usedByItem = Object.fromEntries(baseMoves.map(move => [move.itemId, (move.quantityUnits || 0)]));
  for (const item of foodPriority(content)) {
    const available = Math.max(0, Math.floor(account[item.id] || 0));
    const used = usedByItem[item.id] || 0;
    if (available <= used) continue;
    const perUnit = itemQeqUnitsPerInventoryUnit(item, content);
    const extraQeqUnits = perUnit;
    const roundingExcessQeqUnits = extraQeqUnits - plan.remainingQeqUnits;
    if (roundingExcessQeqUnits < 0) continue;
    return {
      requestedQeqUnits: plan.requestedQeqUnits,
      movedQeqUnits: plan.movedQeqUnits + extraQeqUnits,
      remainingQeqUnits: 0,
      roundingExcessQeqUnits,
      moves: [...baseMoves, {
        itemId: item.id,
        quantityUnits: 1,
        qeqUnits: extraQeqUnits,
        roundingExcessQeqUnits
      }]
    };
  }
  return { ...plan, moves: baseMoves, roundingExcessQeqUnits: 0 };
}

function shortageText(qeqUnits, content) {
  const jin = qeqUnitsToJin(qeqUnits, content);
  if (jin > 0 && jin < 0.01) return "不足0.01斤";
  return jin.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + "斤";
}

export function consumeDailyRations(state, population, content) {
  const households = householdList(state);
  const aggregate = new Map();
  let consumedQeqUnits = 0;
  let missingQeqUnits = 0;
  let roundingExcessQeqUnits = 0;
  for (const household of households) {
    const meals = Math.min(householdPopulation(household), Math.max(0, state.services?.mealsByHousehold?.[household.id] || 0));
    const demandPeople = Math.max(0, householdPopulation(household) - meals);
    const demand = demandPeople * content.rules.foodPerPersonDay * content.precision.qeqUnitsPerJin;
    const plan = planDailyFoodConsumption(household.inventory, demand, content);
    consumedQeqUnits += plan.movedQeqUnits;
    missingQeqUnits += plan.remainingQeqUnits;
    roundingExcessQeqUnits += plan.roundingExcessQeqUnits || 0;
    recordHouseholdInKind(state, household.id, "foodConsumedQeqUnits", plan.movedQeqUnits, content);
    let breadQeq = 0;
    for (const move of plan.moves) if (move.itemId === "bread") breadQeq += move.qeqUnits;
    recordHouseholdInKind(state, household.id, "breadConsumedQeqUnits", breadQeq, content);
    let meatQeq = 0;
    for (const move of plan.moves) if (content.items[move.itemId]?.livestock) meatQeq += move.qeqUnits;
    if (meatQeq > 0) recordHouseholdInKind(state, household.id, "meatConsumedQeqUnits", meatQeq, content);
    for (const move of plan.moves) {
      household.inventory[move.itemId] -= move.quantityUnits;
      const row = aggregate.get(move.itemId) || { itemId: move.itemId, quantityUnits: 0, qeqUnits: 0, roundingExcessQeqUnits: 0 };
      row.quantityUnits += move.quantityUnits;
      row.qeqUnits += move.qeqUnits;
      row.roundingExcessQeqUnits += move.roundingExcessQeqUnits || 0;
      aggregate.set(move.itemId, row);
    }
  }
  syncResidentAggregates(state, content);
  const transactionId = makeTransactionId(state);
  const moves = [...aggregate.values()];
  for (const move of moves) {
    recordLedger(state, {
      type: "consume", transactionId, source: "residents", destination: "consumed",
      itemId: move.itemId, quantityUnits: move.quantityUnits, qeqUnits: move.qeqUnits,
      roundingExcessQeqUnits: move.roundingExcessQeqUnits || 0,
      reason: "居民每日口粮"
    }, content);
  }
  state.yearTotals.consumptionQeq = (state.yearTotals.consumptionQeq || 0) + consumedQeqUnits;
  state.shortageQeq = missingQeqUnits;
  if (missingQeqUnits > 0) {
    recordEvent(state,
      "居民口粮短缺 " + shortageText(missingQeqUnits, content) + "，需拨粮或调整供应。",
      content, { day: state.day + 1 });
  }
  return { consumedQeqUnits, missingQeqUnits, roundingExcessQeqUnits, moves };
}
