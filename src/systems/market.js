import { itemQeqUnitsPerInventoryUnit } from "../economy/inventory.js";
import { bookAddAll } from "../economy/books.js";
import { purchaseItemForResidents } from "./consumer-market.js";
import { currentUnitPrice } from "../economy/prices.js";
import { householdList, householdPopulation, isActiveHousehold } from "./households.js";
import { householdAffluence } from "./household-budget.js";

export function breadDemandShare(price, content) {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const base = content.rules.breadBasePriceWheatPerJin;
  return Math.max(0, Math.min(
    content.rules.breadTargetShareMaximum,
    content.rules.breadTargetShareAtBasePrice * Math.pow(base / price, content.rules.breadPriceElasticity)
  ));
}

// 主食需求份额：优先读取可调规则，缺省时回落到小麦/面粉/面包三项固定比例。
export function stapleDemandShares(content) {
  const rule = content.rules.stapleDemandShares;
  return {
    wheat: rule?.wheat ?? 0.6,
    flour: rule?.flour ?? 0.2,
    bread: rule?.bread ?? 0.2
  };
}

// 肉当主食：口粮当量里肉的占比，随宽裕度上升，宽裕度 fullAffluence 时达到 maxShare（rules.meatStaple）。
export function meatStapleShare(affluence, content) {
  const rule = content.rules.meatStaple;
  if (!rule || !(affluence > 0)) return 0;
  const fullAffluence = rule.fullAffluence ?? 3;
  const ratio = Math.min(1, affluence / Math.max(1e-9, fullAffluence));
  return Math.max(0, Math.min(rule.maxShare ?? 0.75, (rule.maxShare ?? 0.75) * Math.pow(ratio, rule.exponent ?? 2.5)));
}

// 吃肉习惯：按近 habitDays（90）天平均宽裕度（指数平滑）定吃多少肉，秋收前后余粮起落时饮食慢慢变，不跟着当天的家底跳。
// 每天买主食时更新一次，存在 household.meatHabit；没有记录（新户、旧存档）时从当天宽裕度起步。
export function updateMeatHabit(household, affluence, content) {
  const days = Math.max(1, content.rules.meatStaple?.habitDays ?? 90);
  const prior = Number.isFinite(household.meatHabit) ? household.meatHabit : affluence;
  household.meatHabit = Math.round((prior + (affluence - prior) / days) * 10000) / 10000;
  return household.meatHabit;
}

function meatWeights(content) {
  const weights = content.rules.meatStaple?.weights || {};
  const rows = Object.entries(weights).filter(([itemId, weight]) => content.items[itemId]?.edible && weight > 0);
  const total = rows.reduce((sum, [, weight]) => sum + weight, 0);
  return total > 0 ? rows.map(([itemId, weight]) => [itemId, weight / total]) : [];
}

// 单项主食按"每户缺口"购买：每户目标口粮当量减去自家已有的，缺多少买多少。
function buyStapleItem(state, content, itemId, familyTargetQeq) {
  const price = currentUnitPrice(state, itemId, content);
  const item = content.items[itemId];
  const perUnitQeq = itemQeqUnitsPerInventoryUnit(item, content);
  const householdNeedsUnits = {};
  let targetQeq = 0;
  let targetUnits = 0;
  for (const [householdId, qeq] of familyTargetQeq) {
    targetQeq += qeq;
    const household = state.households?.byId?.[householdId];
    const hasQeq = Math.floor((household?.inventory?.[itemId] || 0) * perUnitQeq);
    const units = perUnitQeq > 0 ? Math.max(0, Math.floor((qeq - hasQeq) / perUnitQeq)) : 0;
    if (units > 0) { householdNeedsUnits[householdId] = units; targetUnits += units; }
  }
  const townBefore = state.accounts.town[itemId] || 0;
  const result = targetUnits > 0
    ? purchaseItemForResidents(state, itemId, targetUnits, price, content, `居民以粮券购买${item?.name || itemId}`, { householdNeedsUnits })
    : { purchasedUnits: 0, paidVoucherUnits: 0, sellerRows: [], reason: null };
  // 买完后每户还差多少（口粮当量），留给下一种主食替代。
  const shortfallQeq = new Map();
  for (const [householdId, qeq] of familyTargetQeq) {
    const household = state.households?.byId?.[householdId];
    const has = Math.floor((household?.inventory?.[itemId] || 0) * perUnitQeq);
    if (qeq > has) shortfallQeq.set(householdId, qeq - has);
  }
  return {
    itemId,
    targetQeq,
    targetQeqJin: targetQeq / content.precision.qeqUnitsPerJin,
    targetUnits,
    price,
    purchasedUnits: result.purchasedUnits,
    purchasedJin: result.purchasedUnits / content.precision.inventoryUnitsPerJin,
    paidVoucherUnits: result.paidVoucherUnits,
    paidVoucher: result.paidVoucherUnits / content.precision.currencyUnitsPerVoucher,
    townStockBeforeJin: townBefore / content.precision.inventoryUnitsPerJin,
    sellerRows: result.sellerRows,
    shortfallQeq,
    limitReason: targetUnits <= 0 ? `居民自有${item?.name || itemId}已满足今日目标` : result.reason
  };
}

// 主食：口粮默认吃自家小麦；家里越宽裕（household-budget 的宽裕度），越多换成肉、面粉、面包
// （肉的占比见 meatStapleShare；其余口粮里面粉面包 = 标准比例 × 宽裕度，最多 stapleUpgradeMax 倍）。
// 先买肉，没买到的算回其余口粮按面粉面包比例吃；再买面包，没买到的改买面粉；还不够的买小麦。
export function buyStaplesForResidents(state, population, content) {
  const shares = stapleDemandShares(content);
  const maxUpgrade = content.rules.householdBudget?.stapleUpgradeMax ?? 1.5;
  const dailyQeqPerPerson = content.rules.foodPerPersonDay * content.precision.qeqUnitsPerJin;
  const meats = meatWeights(content);
  const plan = { bread: new Map(), flour: new Map(), wheat: new Map() };
  const meatPlan = new Map(meats.map(([itemId]) => [itemId, new Map()]));
  const rows = [];
  const active = householdList(state).filter(isActiveHousehold);
  const meatTarget = new Map();
  for (const household of active) {
    const need = householdPopulation(household) * dailyQeqPerPerson;
    const affluence = householdAffluence(state, household, content);
    const meatTotal = meats.length ? Math.floor(need * meatStapleShare(updateMeatHabit(household, affluence, content), content)) : 0;
    let meat = 0;
    for (const [itemId, weight] of meats) {
      const qeq = Math.floor(meatTotal * weight);
      if (qeq > 0) { meatPlan.get(itemId).set(household.id, qeq); meat += qeq; }
    }
    meatTarget.set(household.id, meat);
  }
  // 先买肉；没买到的部分算回其余口粮，按面粉面包的正常比例吃（没肉的镇子不会因此少吃面包）。
  const meatShort = new Map();
  for (const [itemId] of meats) {
    const row = buyStapleItem(state, content, itemId, meatPlan.get(itemId));
    rows.push(row);
    for (const [id, qeq] of row.shortfallQeq) meatShort.set(id, (meatShort.get(id) || 0) + qeq);
  }
  let upgradeShareSum = 0;
  let people = 0;
  for (const household of active) {
    const need = householdPopulation(household) * dailyQeqPerPerson;
    const upgrade = Math.min(maxUpgrade, householdAffluence(state, household, content));
    const meat = Math.max(0, (meatTarget.get(household.id) || 0) - (meatShort.get(household.id) || 0));
    const rest = need - meat;
    const bread = Math.min(rest, Math.floor(rest * shares.bread * upgrade));
    const flour = Math.min(rest - bread, Math.floor(rest * shares.flour * upgrade));
    plan.bread.set(household.id, bread);
    plan.flour.set(household.id, flour);
    plan.wheat.set(household.id, rest - bread - flour);
    upgradeShareSum += (meat + bread + flour) / Math.max(1, need) * householdPopulation(household);
    people += householdPopulation(household);
  }
  const breadRow = buyStapleItem(state, content, "bread", plan.bread);
  rows.push(breadRow);
  for (const [id, qeq] of breadRow.shortfallQeq) plan.flour.set(id, (plan.flour.get(id) || 0) + qeq);
  const flourRow = buyStapleItem(state, content, "flour", plan.flour);
  rows.push(flourRow);
  for (const [id, qeq] of flourRow.shortfallQeq) plan.wheat.set(id, (plan.wheat.get(id) || 0) + qeq);
  rows.push(buyStapleItem(state, content, "wheat", plan.wheat));
  const order = ["wheat", "flour", "bread", ...meats.map(([itemId]) => itemId)];
  rows.sort((a, b) => order.indexOf(a.itemId) - order.indexOf(b.itemId));
  const totalQeq = rows.reduce((sum, row) => sum + row.targetQeq, 0) || 1;
  for (const row of rows) row.targetShare = row.targetQeq / totalQeq;
  state.market.upgradeShare = upgradeShareSum / Math.max(1, people);
  const bread = rows.find(row => row.itemId === "bread");
  const purchasedBreadUnits = bread.purchasedUnits;
  // 面包为 generalStoreOnly，镇库不直售；以下镇库面包记账恒为0，保留作兼容（死代码）。
  const townBreadSold = bread.sellerRows.filter(row => row.seller === "town").reduce((sum, row) => sum + row.quantityUnits, 0);
  const townBreadRevenue = bread.sellerRows.filter(row => row.seller === "town").reduce((sum, row) => sum + row.paidVoucherUnits, 0);
  const townBreadCogs = bread.sellerRows.filter(row => row.seller === "town")
    .reduce((sum, row) => sum + (row.sellerCostVoucherUnits || 0), 0);
  if (townBreadSold > 0) {
    bookAddAll(state.business, { soldBreadUnits: townBreadSold, revenueWheatUnits: townBreadRevenue, breadCogsWheatUnits: townBreadCogs });
  }

  state.market.staplesLastDay = {
    shares,
    rows: rows.map(row => ({
      itemId: row.itemId, targetShare: row.targetShare, targetQeqJin: row.targetQeqJin,
      purchasedJin: row.purchasedJin, paidVoucher: row.paidVoucher, limitReason: row.limitReason
    })),
    purchasedJin: Object.fromEntries(rows.map(row => [row.itemId, row.purchasedJin])),
    paidVoucher: Object.fromEntries(rows.map(row => [row.itemId, row.paidVoucher])),
    sellerRows: rows.flatMap(row => row.sellerRows)
  };
  // 兼容旧读数：lastDay 继续以面包为主体，但份额改为固定的主食拆分份额。
  state.market.lastDay = {
    targetShare: bread.targetShare,
    targetBreadQeqJin: bread.targetQeqJin,
    purchasedBreadJin: bread.purchasedJin,
    paidVoucher: bread.paidVoucher,
    paidWheatJin: bread.paidVoucher, // 券值（1券=1斤麦等值），字段名历史遗留，含义为小麦等值
    townStockBeforeJin: bread.townStockBeforeJin,
    sellerRows: bread.sellerRows,
    limitReason: bread.limitReason,
    staples: state.market.staplesLastDay
  };
  return state.market.lastDay;
}

// 旧调用兼容：等价于按下单日面包固定份额购买，其余主食由 buyStaplesForResidents 负责。
export function buyBreadForResidents(state, population, content) {
  return buyStaplesForResidents(state, population, content);
}
