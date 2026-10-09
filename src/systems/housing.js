import { currencyScale } from "../economy/currency.js";
import { bookAddAll, PERIODS } from "../economy/books.js";
import { currentPaymentComposition, settleMonetaryPayment } from "../economy/payment.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { currentUnitPrice } from "../economy/prices.js";
import { selectHousing } from "../selectors/housing.js";
import { activeHouseholds, householdConvertibleWheatUnits, householdList, syncResidentAggregates } from "./households.js";
import { purchaseItemForResidents } from "./consumer-market.js";
import { recordHouseholdRentDue, recordHouseholdRentPaid } from "./household-life.js";

export function settleHousingRent(state, housingAtStart, content) {
  const scale = currencyScale(content);
  const perPerson = content.rules.rentPerResidentDayWheatJin || 1;
  const dueRows = (housingAtStart.householdHousing || []).filter(row => row.rentalPeople > 0).map(row => ({ householdId: row.householdId, units: Math.round(row.rentalPeople * perPerson * scale) }));
  const dueUnits = dueRows.reduce((sum, row) => sum + row.units, 0);
  let collectedUnits = 0;
  const previousDefer = Boolean(state._deferHouseholdSync);
  state._deferHouseholdSync = true;
  for (const row of dueRows) {
    const household = state.households?.byId?.[row.householdId];
    if (!household) continue;
    recordHouseholdRentDue(state, household.id, row.units, content);
    const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
    const moved = settleMonetaryPayment(state, `household:${household.id}`, "town", currentPaymentComposition(state, row.units), content,
      "rent_payment", "家庭支付公租房日租金", { requireFull: false, maxWheatUnits });
    const paid = moved.paidValueUnits || 0;
    if (paid > 0) { collectedUnits += paid; recordHouseholdRentPaid(state, household.id, paid, content); }
  }
  state._deferHouseholdSync = previousDefer;
  if (!previousDefer) syncResidentAggregates(state, content);
  const waivedUnits = dueUnits - collectedUnits;
  state.fiscal ||= { day: {}, year: {}, cumulative: {} };
  bookAddAll(state.fiscal, { dueWheatUnits: dueUnits, collectedWheatUnits: collectedUnits, waivedWheatUnits: waivedUnits });
  for (const period of PERIODS.map(key => state.fiscal[key])) {
    period.dueVoucherUnits = period.dueWheatUnits;
    period.collectedVoucherUnits = period.collectedWheatUnits;
    period.waivedVoucherUnits = period.waivedWheatUnits;
  }
  if (waivedUnits > 0) recordLedger(state, { type: "rent_waiver", transactionId: makeTransactionId(state), source: "rent_due", destination: "waived", itemId: "money_value", quantityUnits: waivedUnits, qeqUnits: 0, reason: "实际入住公租房家庭支付不足，本日未收部分减免" }, content);
  state.fiscal.lastRentDay = { occupants: housingAtStart.rentDuePeople, households: dueRows.length,
    dueVoucher: dueUnits / scale, collectedVoucher: collectedUnits / scale, waivedVoucher: waivedUnits / scale,
    dueWheatJin: dueUnits / scale, collectedWheatJin: collectedUnits / scale, waivedWheatJin: waivedUnits / scale };
  return state.fiscal.lastRentDay;
}

export function currentHousing(state, content) { return selectHousing(state, content); }

// 修缮木材日需求：按活跃家庭数 × 每户每年斤数累计，除以 daysPerYear 取整；余数结转到 state.housing.repairWoodCarry（与食盐需求同一做法）。
export function accrueRepairWoodNeed(state, householdCount, content) {
  const perYearUnits = content.rules.houseRepairWoodJinPerHouseholdYear * content.precision.inventoryUnitsPerJin;
  state.housing ||= {};
  const numerator = (state.housing.repairWoodCarry || 0) + householdCount * perYearUnits;
  const targetUnits = Math.floor(numerator / content.rules.daysPerYear);
  state.housing.repairWoodCarry = numerator % content.rules.daysPerYear;
  return targetUnits;
}

// 居民每日购买木材用于修缮自有房屋：买入后立即记为修缮消耗。
// 同一轮市场里家庭之间也可能互相转卖木材，因此这里只把“本日买入的木材”从家户账上扣回：
// 目标是把居民木材总量降到买入前水平，且任何家庭最多被扣回自己买入后的净增量，
// 不会动居民原有库存，木材也不会在家户库存里堆积。
export function buyRepairWoodForResidents(state, content) {
  const households = householdList(state);
  // 今日修缮需求（库存精度单位）：随活跃家庭数增长。
  const dailyUnits = accrueRepairWoodNeed(state, activeHouseholds(state).length, content);
  // 赶集：修缮需求逐日累计，每 householdGoodsShoppingDays 天全镇统一采购一次（买不到的不结转，同原规则）。
  state.housing ||= {};
  const shoppingDays = Math.max(1, Math.floor(content.rules.householdGoodsShoppingDays ?? 5));
  state.housing.repairWoodPendingUnits = (state.housing.repairWoodPendingUnits || 0) + dailyUnits;
  if ((state.day || 0) % shoppingDays !== 0) {
    state.housing.lastRepairWoodDay = { targetUnits: 0, pendingUnits: state.housing.repairWoodPendingUnits, purchasedUnits: 0, consumedUnits: 0, paidVoucherUnits: 0, sellerRows: [], reason: "未到采购日" };
    return state.housing.lastRepairWoodDay;
  }
  const targetUnits = state.housing.repairWoodPendingUnits;
  state.housing.repairWoodPendingUnits = 0;
  // 购买前快照各家庭木材库存与居民总量。
  const before = new Map(households.map(household => [household.id, household.inventory?.wood || 0]));
  const beforeTotal = households.reduce((sum, household) => sum + (household.inventory?.wood || 0), 0);
  // 镇库木材是建设储备，居民修缮只从市场余量（企业、商铺）购买；不向别的家庭买——否则户间转卖的
  // 木材会被当成新买入消耗掉，动到居民原有库存（户数多时尤其明显）。
  const result = purchaseItemForResidents(state, "wood", targetUnits, currentUnitPrice(state, "wood", content), content, "居民购买木材修缮房屋", { excludeTownSellers: true, excludeHouseholdSellers: true });
  const afterTotal = households.reduce((sum, household) => sum + (household.inventory?.wood || 0), 0);
  // 需要扣回的修缮消耗：以实际买入量为准（之前用总量净增量，家庭间转卖时总量不变导致买入方木材不被消费）。
  const consumeTarget = Math.max(0, Math.min(targetUnits, result.purchasedUnits || 0));
  let consumedUnits = 0;
  if (consumeTarget > 0) {
    // 按“本日新增量”从多到少扣除，每家最多扣掉自己买入后的净增量。
    const capacity = households.map(household => ({
      householdId: household.id,
      units: Math.max(0, (household.inventory?.wood || 0) - (before.get(household.id) || 0))
    })).filter(row => row.units > 0)
      .sort((a, b) => b.units - a.units || String(a.householdId).localeCompare(String(b.householdId)));
    const rows = [];
    for (const row of capacity) {
      if (consumedUnits >= consumeTarget) break;
      const used = Math.min(row.units, consumeTarget - consumedUnits);
      const household = state.households.byId[row.householdId];
      household.inventory.wood -= used;
      consumedUnits += used;
      rows.push({ householdId: row.householdId, units: used });
    }
    if (consumedUnits > 0) {
      syncResidentAggregates(state, content);
      const transactionId = makeTransactionId(state);
      for (const row of rows) {
        recordLedger(state, {
          type: "house_repair_wood", transactionId,
          source: `household:${row.householdId}`, destination: "consumed", itemId: "wood",
          quantityUnits: row.units, qeqUnits: 0, reason: "房屋修缮消耗木材"
        }, content);
      }
      recordEvent(state, `居民修缮房屋消耗木材${consumedUnits}单位。`, content, {
        mergeKey: "house-repair-wood", mergeWindowDays: 3, amount: consumedUnits,
        mergedText: (count, amount) => `近3日居民修缮房屋累计消耗木材${amount}单位（${count}次）。`
      });
    }
  }
  state.housing ||= {};
  state.housing.lastRepairWoodDay = {
    targetUnits,
    purchasedUnits: result.purchasedUnits,
    consumedUnits,
    paidVoucherUnits: result.paidVoucherUnits,
    sellerRows: result.sellerRows,
    reason: result.reason
  };
  return state.housing.lastRepairWoodDay;
}
