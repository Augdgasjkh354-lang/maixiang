import { purchaseItemForResidents } from "./consumer-market.js";
import { parseOwner } from "../economy/accounts.js";
import { bookAddAll } from "../economy/books.js";
import { currentUnitPrice } from "../economy/prices.js";
import { householdList, householdPopulation, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { recordHouseholdInKind } from "./household-life.js";
import { makeTransactionId, recordLedger } from "../economy/ledger.js";

function maxPassing(limit, predicate) {
  let low = 0;
  let high = Math.max(0, Math.floor(limit));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (predicate(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function accrueSaltNeed(state, population, content) {
  const perYearUnits = content.rules.saltAnnualDemandJinPerPerson *
    content.precision.inventoryUnitsPerJin;
  const numerator = (state.salt.demandCarry || 0) + population * perYearUnits;
  const demandUnits = Math.floor(numerator / content.rules.daysPerYear);
  state.salt.demandCarry = numerator % content.rules.daysPerYear;
  state.salt.todayDemandUnits = demandUnits;
  state.salt.todaySatisfiedUnits = 0;
  state.salt.day = { demandUnits, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 };
  return demandUnits;
}

export function buySaltForResidents(state, content) {
  const demandUnits = state.salt.todayDemandUnits || 0;
  const households = householdList(state).filter(isActiveHousehold);
  const totalPeople = households.reduce((sum, household) => sum + householdPopulation(household), 0) || 1;
  const shoppingDays = Math.max(1, Math.floor(content.rules.householdGoodsShoppingDays ?? 5));
  let assignedDemand = 0;
  const householdNeedsUnits = {};
  const shortageUnits = households.reduce((sum, household, index) => {
    const familyDemand = index === households.length - 1
      ? demandUnits - assignedDemand
      : Math.floor(demandUnits * householdPopulation(household) / totalPeople);
    assignedDemand += familyDemand;
    // 赶集：家里的盐够今天用就不买；不够时一次买够 householdGoodsShoppingDays 天。
    const stock = household.inventory?.salt || 0;
    const shortage = stock >= familyDemand ? 0 : Math.max(0, familyDemand * shoppingDays - stock);
    householdNeedsUnits[household.id] = shortage;
    return sum + shortage;
  }, 0);
  const desiredUnits = households.length ? shortageUnits : Math.max(0, demandUnits - (state.accounts.residents.salt || 0));
  const price = currentUnitPrice(state, "salt", content);
  const result = purchaseItemForResidents(state, "salt", desiredUnits, price, content, "家庭购买当日所需食盐", { householdNeedsUnits });
  // 盐经综合商店零售（generalStoreOnly），镇库不直售；按商店卖家统计销量（之前只统计镇库，恒为0）。
  const shopRows = result.sellerRows.filter(row => parseOwner(row.seller).kind === "shop");
  const shopSold = shopRows.reduce((sum, row) => sum + row.quantityUnits, 0);
  const shopRevenue = shopRows.reduce((sum, row) => sum + row.paidVoucherUnits, 0);
  if (shopSold > 0) {
    bookAddAll(state.industries.salt, { soldUnits: shopSold, revenueWheatUnits: shopRevenue });
  }
  state.salt.day.purchasedUnits = result.purchasedUnits;
  // paidWheatUnits 存的是券单位（1券=1斤麦等值），字段名历史遗留，UI按小麦等值显示无误。
  state.salt.day.paidWheatUnits = result.paidVoucherUnits;
  for (const period of [state.salt.year, state.salt.lifetime]) {
    period.purchasedUnits = (period.purchasedUnits || 0) + result.purchasedUnits;
    period.paidWheatUnits = (period.paidWheatUnits || 0) + result.paidVoucherUnits;
  }
  state.salt.market = {
    targetUnits: desiredUnits,
    purchasedUnits: result.purchasedUnits,
    paidVoucherUnits: result.paidVoucherUnits,
    paidWheatUnits: result.paidVoucherUnits,
    priceVoucherPerJin: price,
    priceWheatPerJin: price,
    sellerRows: result.sellerRows,
    limitReason: desiredUnits <= 0 ? "家庭现有食盐已够今日使用" : result.reason
  };
  return state.salt.market;
}

function populationForSalt(state) {
  return state.cohorts.reduce((sum, row) => sum + row.m + row.f, 0);
}

export function consumeDailySalt(state, content) {
  const demandUnits = state.salt.todayDemandUnits || 0;
  const households = householdList(state).filter(isActiveHousehold);
  const totalPeople = households.reduce((sum, household) => sum + householdPopulation(household), 0) || 1;
  let assignedDemand = 0;
  let satisfiedUnits = 0;
  if (households.length) {
    for (let index = 0; index < households.length; index += 1) {
      const household = households[index];
      const familyDemand = index === households.length - 1
        ? demandUnits - assignedDemand
        : Math.floor(demandUnits * householdPopulation(household) / totalPeople);
      assignedDemand += familyDemand;
      const consumed = Math.min(household.inventory?.salt || 0, Math.max(0, familyDemand));
      if (consumed <= 0) continue;
      household.inventory.salt -= consumed;
      satisfiedUnits += consumed;
      recordHouseholdInKind(state, household.id, "saltConsumedUnits", consumed, content);
    }
    syncResidentAggregates(state, content);
    if (satisfiedUnits > 0) recordLedger(state, {
      type: "salt_consume", transactionId: makeTransactionId(state), source: "households", destination: "consumption",
      itemId: "salt", quantityUnits: satisfiedUnits, qeqUnits: 0, reason: "家庭每日食盐消费"
    }, content);
  } else {
    const available = state.accounts.residents.salt || 0;
    satisfiedUnits = Math.min(available, demandUnits);
    state.accounts.residents.salt -= satisfiedUnits;
  }
  state.salt.todaySatisfiedUnits = satisfiedUnits;
  state.salt.day.satisfiedUnits = satisfiedUnits;
  for (const period of [state.salt.year, state.salt.lifetime]) {
    period.demandUnits = (period.demandUnits || 0) + demandUnits;
    period.satisfiedUnits = (period.satisfiedUnits || 0) + satisfiedUnits;
  }
  state.salt.history.push({ demandUnits, satisfiedUnits });
  if (state.salt.history.length > content.rules.saltGraceDays) {
    state.salt.history.splice(0, state.salt.history.length - content.rules.saltGraceDays);
  }
  return { demandUnits, satisfiedUnits, missingUnits: demandUnits - satisfiedUnits };
}

export function selectSaltCoverage(state, content) {
  const history = state.salt?.history || [];
  const demand = history.reduce((sum, row) => sum + row.demandUnits, 0);
  const satisfied = history.reduce((sum, row) => sum + row.satisfiedUnits, 0);
  return {
    coverage: demand > 0 ? satisfied / demand : 1,
    demandUnits: demand,
    satisfiedUnits: satisfied,
    grace: (state.salt?.graceDaysElapsed || 0) < (content?.rules?.saltGraceDays || 30),
    daysObserved: history.length
  };
}

export function finishSaltGraceDay(state, content) {
  if (state.salt.graceDaysElapsed < content.rules.saltGraceDays) {
    state.salt.graceDaysElapsed += 1;
  }
}
