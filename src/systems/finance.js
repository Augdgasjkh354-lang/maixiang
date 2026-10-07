import { transferFoodQeq } from "../economy/inventory.js";
import { redeemVouchersForWheat } from "../economy/currency.js";
import { wheatUnitsForVoucherUnits } from "../economy/money-units.js";
import { recordEvent } from "../economy/ledger.js";
import { householdFoodQeqUnits, householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { householdFoodDays, recordHouseholdInKind } from "./household-life.js";

function dailyNeedQeq(household, content) {
  return householdPopulation(household) * content.rules.foodPerPersonDay * content.precision.qeqUnitsPerJin;
}

function targetFoodQeq(household, days, content) {
  return dailyNeedQeq(household, content) * days;
}

function wheatUnitsForQeqCeil(qeqUnits, content) {
  const wheatQeqPerUnit = content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin;
  return Math.max(0, Math.ceil(qeqUnits / wheatQeqPerUnit));
}

function redeemHouseholdTowardTarget(state, household, targetQeqUnits, content, reason) {
  const shortageQeq = Math.max(0, targetQeqUnits - householdFoodQeqUnits(state, household, content));
  if (shortageQeq <= 0 || (household.voucherUnits || 0) <= 0 || (state.accounts?.town?.wheat || 0) <= 0) {
    return { redeemedUnits: 0 };
  }
  const wantedUnits = wheatUnitsForQeqCeil(shortageQeq, content);
  // 显式换算券→麦再取 min（之前直接比，靠两边精度都是3000碰巧成立）。
  const voucherWheatUnits = wheatUnitsForVoucherUnits(household.voucherUnits || 0, content, "floor");
  const units = Math.min(wantedUnits, voucherWheatUnits, state.accounts?.town?.wheat || 0);
  if (units <= 0) return { redeemedUnits: 0 };
  const result = redeemVouchersForWheat(state, `household:${household.id}`, units, content, reason);
  return result.ok ? { redeemedUnits: units } : { redeemedUnits: 0 };
}

export function redeemEssentialFoodForHouseholds(state, content) {
  const targetDays = content.rules.householdFoodRedemptionTargetDays || 3;
  let redeemedUnits = 0;
  let households = 0;
  for (const household of householdList(state)) {
    const result = redeemHouseholdTowardTarget(
      state,
      household,
      targetFoodQeq(household, targetDays, content),
      content,
      "家庭口粮不足，按1券兑1斤小麦正常兑付"
    );
    if (result.redeemedUnits > 0) {
      redeemedUnits += result.redeemedUnits;
      households += 1;
    }
  }
  return { redeemedUnits, households };
}

function urgentHouseholds(state, content) {
  return householdList(state).filter(isActiveHousehold).map(household => ({ household, foodDays: householdFoodDays(state, household, content) }))
    .sort((a, b) => a.foodDays - b.foodDays || a.household.id.localeCompare(b.household.id));
}

function prepareReliefHouseholds(state, content) {
  const triggerDays = content.rules.automaticReliefTriggerDays || 7;
  const targetDays = content.rules.automaticReliefTargetDays || 14;
  const candidates = urgentHouseholds(state, content).filter(row => row.foodDays < triggerDays);
  const eligible = [];
  let redeemedUnits = 0;
  let redeemedHouseholds = 0;

  for (const row of candidates) {
    const household = row.household;
    const targetQeqUnits = targetFoodQeq(household, targetDays, content);
    const redemption = redeemHouseholdTowardTarget(
      state,
      household,
      targetQeqUnits,
      content,
      "救济资格核算：家庭先用自身粮券按1券兑1斤小麦补足口粮"
    );
    if (redemption.redeemedUnits > 0) {
      redeemedUnits += redemption.redeemedUnits;
      redeemedHouseholds += 1;
    }
    const currentFoodQeqUnits = householdFoodQeqUnits(state, household, content);
    const needQeqUnits = Math.max(0, targetQeqUnits - currentFoodQeqUnits);
    if (needQeqUnits > 0) {
      eligible.push({
        household,
        foodDays: householdFoodDays(state, household, content),
        needQeqUnits,
        targetQeqUnits
      });
    }
  }

  eligible.sort((a, b) => a.foodDays - b.foodDays || a.household.id.localeCompare(b.household.id));
  return { candidates, eligible, redeemedUnits, redeemedHouseholds, targetDays };
}

function relieveEligibleHouseholds(state, eligible, limitQeqUnits, content, reason) {
  const totalNeedQeqUnits = eligible.reduce((sum, row) => sum + row.needQeqUnits, 0);
  const targetQeqUnits = Math.min(Math.max(0, limitQeqUnits), totalNeedQeqUnits);
  let left = targetQeqUnits;
  let moved = 0;
  const rows = [];

  for (const row of eligible) {
    if (left <= 0) break;
    const currentNeed = Math.max(0, row.targetQeqUnits - householdFoodQeqUnits(state, row.household, content));
    const request = Math.min(left, currentNeed);
    if (request <= 0) continue;
    const result = transferFoodQeq(state, "town", `household:${row.household.id}`, request, reason, "relief", content, { allowPartial: true });
    if (result.movedQeqUnits > 0) {
      recordHouseholdInKind(state, row.household.id, "reliefQeqUnits", result.movedQeqUnits, content);
      recordHouseholdInKind(state, row.household.id, "inKindIncomeQeqUnits", result.movedQeqUnits, content);
      rows.push({ householdId: row.household.id, qeqUnits: result.movedQeqUnits });
      moved += result.movedQeqUnits;
      left -= result.movedQeqUnits;
    }
    if (!result.movedQeqUnits) break;
  }

  syncResidentAggregates(state, content);
  return { movedQeqUnits: moved, missingQeqUnits: Math.max(0, targetQeqUnits - moved), rows };
}

export function payManualRelief(state, amountJin, content) {
  const qeqUnits = Math.max(0, Math.round(amountJin * content.precision.qeqUnitsPerJin));
  if (qeqUnits <= 0) return { movedQeqUnits: 0, missingQeqUnits: 0, rows: [], redeemedWheatUnits: 0, eligibleHouseholds: 0, servedHouseholds: 0, unmetHouseholds: 0 };
  const prepared = prepareReliefHouseholds(state, content);
  const result = relieveEligibleHouseholds(state, prepared.eligible, qeqUnits, content, "镇长手动救济：家庭先自费兑付，再按口粮紧迫度补足缺口");
  const summary = {
    ...result,
    redeemedWheatUnits: prepared.redeemedUnits,
    eligibleHouseholds: prepared.eligible.length,
    servedHouseholds: result.rows.length,
    unmetHouseholds: prepared.eligible.filter(row => householdFoodQeqUnits(state, row.household, content) < row.targetQeqUnits).length
  };
  if (result.movedQeqUnits > 0) recordEvent(state, "镇长按家庭口粮缺口拨出 " + Math.round(result.movedQeqUnits / content.precision.qeqUnitsPerJin).toLocaleString("zh-CN") + "斤口粮。", content, { day: state.day + 1 });
  return summary;
}

export function setAutomaticRelief(state, enabled) { state.autoRelief = Boolean(enabled); return state.autoRelief; }

export function applyAutomaticRelief(state, population, content) {
  if (!state.autoRelief || population <= 0) {
    const essentialRedemption = redeemEssentialFoodForHouseholds(state, content);
    state.relief ||= {};
    state.relief.lastDay = { redeemedWheatUnits: essentialRedemption.redeemedUnits, eligibleHouseholds: 0, servedHouseholds: 0, movedQeqUnits: 0, missingQeqUnits: 0, unmetHouseholds: 0 };
    return state.relief.lastDay;
  }

  const prepared = prepareReliefHouseholds(state, content);
  const totalNeedQeqUnits = prepared.eligible.reduce((sum, row) => sum + row.needQeqUnits, 0);
  const result = relieveEligibleHouseholds(state, prepared.eligible, totalNeedQeqUnits, content, "自动救济：家庭先自费兑付，再按口粮缺口和紧迫程度拨付");
  state.relief ||= {};
  state.relief.lastDay = {
    ...result,
    redeemedWheatUnits: prepared.redeemedUnits,
    eligibleHouseholds: prepared.eligible.length,
    servedHouseholds: result.rows.length,
    unmetHouseholds: prepared.eligible.filter(row => householdFoodQeqUnits(state, row.household, content) < row.targetQeqUnits).length
  };
  if (result.movedQeqUnits > 0) recordEvent(state, "镇库按家庭缺粮紧迫度拨出 " + Math.round(result.movedQeqUnits / content.precision.qeqUnitsPerJin).toLocaleString("zh-CN") + "斤口粮。", content, {
    day: state.day + 1, mergeKey: "auto-relief", mergeWindowDays: 30, amount: result.movedQeqUnits,
    mergedText: (count, amount) => `近30日镇库自动救济累计拨出 ${Math.round(amount / content.precision.qeqUnitsPerJin).toLocaleString("zh-CN")}斤口粮（${count}次）。`
  });
  return state.relief.lastDay;
}
