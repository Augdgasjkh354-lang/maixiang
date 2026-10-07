// 邻里互助（移植自用户 0.1.11 优化）。
//
// 每天结算时、自动救济之前运行：
// - 受助方：自有口粮 < neighborAidTriggerDays（3）天，且用粮券也买不到 1 天口粮
//   （粮券数与镇库小麦取小）的家庭，按缺口补到 neighborAidTargetDays（7）天。
// - 援助方：自有口粮 > neighborAidDonorMinDays（60）天的富户，拿出超出 60 天
//   部分的 neighborAidDonorShare（10%）接济邻里。
// - 撮合：最缺粮的先受助，预算最多的富户先出；户对户转账（kind "neighbor_aid"）。
// 与自动救济的关系：邻里互助先行（民间互助，3 天触发），自动救济（镇库，
// automaticReliefTriggerDays=7 天触发）随后补剩余缺口。两者触发线不同，不重复。
//
// 数据记在 state.neighborAid = { year, cumulative, lastDay }，
// lastDay = { needyHouseholds, helpedHouseholds, donorHouseholds, movedQeqUnits, pairs }。

import { recordEvent } from "../economy/ledger.js";
import { transferFoodQeq } from "../economy/inventory.js";
import {
  householdFoodQeqUnits,
  householdList,
  householdPopulation,
  isActiveHousehold,
  syncResidentAggregates,
} from "./households.js";
import { recordHouseholdInKind } from "./household-life.js";

function emptyPeriod() {
  return { aidEvents: 0, helpedHouseholds: 0, movedQeqUnits: 0 };
}

export function ensureNeighborAid(state) {
  state.neighborAid ||= {};
  state.neighborAid.year ||= emptyPeriod();
  state.neighborAid.cumulative ||= emptyPeriod();
  state.neighborAid.lastDay ||= {
    needyHouseholds: 0,
    helpedHouseholds: 0,
    donorHouseholds: 0,
    movedQeqUnits: 0,
    pairs: [],
  };
  return state.neighborAid;
}

export function resetNeighborAidYear(state) {
  ensureNeighborAid(state).year = emptyPeriod();
}

function dailyNeedQeq(household, content) {
  return (
    householdPopulation(household) *
    content.rules.foodPerPersonDay *
    content.precision.qeqUnitsPerJin
  );
}

export function settleNeighborAid(state, content) {
  const store = ensureNeighborAid(state);
  const rules = content.rules;
  const triggerDays = rules.neighborAidTriggerDays ?? 3;
  const targetDays = rules.neighborAidTargetDays ?? 7;
  const donorMinDays = rules.neighborAidDonorMinDays ?? 60;
  const donorShare = rules.neighborAidDonorShare ?? 0.1;
  const qeqPerInventoryUnit =
    content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin;
  const townWheat = state.accounts?.town?.wheat || 0;

  const needy = [];
  const donors = [];
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const dayNeed = dailyNeedQeq(household, content);
    if (dayNeed <= 0) continue;
    const stock = householdFoodQeqUnits(state, household, content);
    if (stock < dayNeed * triggerDays) {
      // 粮券可兑付额（受镇库小麦库存限制）连 1 天口粮都买不到，才算真缺粮。
      if (Math.min(household.voucherUnits || 0, townWheat) * qeqPerInventoryUnit < dayNeed) {
        needy.push({
          household,
          need: Math.ceil(dayNeed * targetDays - stock),
          days: stock / dayNeed,
        });
      }
    } else if (stock > dayNeed * donorMinDays) {
      const budget = Math.floor((stock - dayNeed * donorMinDays) * donorShare);
      if (budget > 0) donors.push({ household, budget });
    }
  }
  needy.sort((a, b) => a.days - b.days || a.household.id.localeCompare(b.household.id));
  donors.sort((a, b) => b.budget - a.budget || a.household.id.localeCompare(b.household.id));

  const pairs = [];
  const helped = new Set();
  const donorIds = new Set();
  let moved = 0;
  let donorIdx = 0;
  for (const row of needy) {
    let need = row.need;
    while (need > 0 && donorIdx < donors.length) {
      const donor = donors[donorIdx];
      const request = Math.min(need, donor.budget);
      const got =
        transferFoodQeq(
          state,
          `household:${donor.household.id}`,
          `household:${row.household.id}`,
          request,
          `邻里互助：${donor.household.name}接济${row.household.name}口粮`,
          "neighbor_aid",
          content,
          { allowPartial: true }
        ).movedQeqUnits || 0;
      donor.budget -= got;
      if (got > 0) {
        need -= got;
        moved += got;
        helped.add(row.household.id);
        donorIds.add(donor.household.id);
        recordHouseholdInKind(state, row.household.id, "inKindIncomeQeqUnits", got, content);
        recordHouseholdInKind(state, row.household.id, "neighborAidReceivedQeqUnits", got, content);
        recordHouseholdInKind(state, donor.household.id, "neighborAidGivenQeqUnits", got, content);
        pairs.push({ donorId: donor.household.id, receiverId: row.household.id, qeqUnits: got });
      }
      if (donor.budget <= 0 || got <= 0) donorIdx += 1;
    }
    if (donorIdx >= donors.length) break;
  }
  if (moved > 0) syncResidentAggregates(state, content);

  store.lastDay = {
    needyHouseholds: needy.length,
    helpedHouseholds: helped.size,
    donorHouseholds: donorIds.size,
    movedQeqUnits: moved,
    pairs: pairs.slice(0, 20),
  };
  for (const period of [store.year, store.cumulative]) {
    period.aidEvents += pairs.length;
    period.helpedHouseholds += helped.size;
    period.movedQeqUnits += moved;
  }
  if (moved > 0) {
    const jin = Math.round(moved / content.precision.qeqUnitsPerJin);
    const first = pairs[0];
    const donorName = state.households.byId[first.donorId]?.name || "富户";
    const receiverName = state.households.byId[first.receiverId]?.name || "邻家";
    const receiverText = helped.size > 1 ? `${receiverName}等${helped.size}户` : receiverName;
    const donorText = donorIds.size > 1 ? `${donorName}等${donorIds.size}户` : donorName;
    recordEvent(
      state,
      `${donorText}接济了断粮的${receiverText}，共${jin.toLocaleString("zh-CN")}斤口粮。`,
      content,
      {
        day: state.day + 1,
        mergeKey: "neighbor-aid",
        mergeWindowDays: 30,
        amount: jin,
        mergedText: (times, total) =>
          `近来邻里互助 ${times} 次，富户共接济缺粮人家 ${total.toLocaleString("zh-CN")}斤口粮（最近一次：${donorText}接济${receiverText}）。`,
      }
    );
  }
  return store.lastDay;
}
