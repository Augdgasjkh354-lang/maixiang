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

// 主食：口粮默认吃自家小麦；家里越宽裕（household-budget 的宽裕度），越多换成面粉、面包
// （标准比例 × 宽裕度，最多 stapleUpgradeMax 倍）。先买面包，没买到的改买面粉，还不够的买小麦。
export function buyStaplesForResidents(state, population, content) {
  const shares = stapleDemandShares(content);
  const maxUpgrade = content.rules.householdBudget?.stapleUpgradeMax ?? 1.5;
  const dailyQeqPerPerson = content.rules.foodPerPersonDay * content.precision.qeqUnitsPerJin;
  const plan = { bread: new Map(), flour: new Map(), wheat: new Map() };
  let upgradeShareSum = 0;
  let people = 0;
  for (const household of householdList(state).filter(isActiveHousehold)) {
    const need = householdPopulation(household) * dailyQeqPerPerson;
    const upgrade = Math.min(maxUpgrade, householdAffluence(state, household, content));
    const bread = Math.min(need, Math.floor(need * shares.bread * upgrade));
    const flour = Math.min(need - bread, Math.floor(need * shares.flour * upgrade));
    plan.bread.set(household.id, bread);
    plan.flour.set(household.id, flour);
    plan.wheat.set(household.id, need - bread - flour);
    upgradeShareSum += (bread + flour) / Math.max(1, need) * householdPopulation(household);
    people += householdPopulation(household);
  }
  const rows = [];
  const breadRow = buyStapleItem(state, content, "bread", plan.bread);
  rows.push(breadRow);
  for (const [id, qeq] of breadRow.shortfallQeq) plan.flour.set(id, (plan.flour.get(id) || 0) + qeq);
  const flourRow = buyStapleItem(state, content, "flour", plan.flour);
  rows.push(flourRow);
  for (const [id, qeq] of flourRow.shortfallQeq) plan.wheat.set(id, (plan.wheat.get(id) || 0) + qeq);
  rows.push(buyStapleItem(state, content, "wheat", plan.wheat));
  rows.sort((a, b) => ["wheat", "flour", "bread"].indexOf(a.itemId) - ["wheat", "flour", "bread"].indexOf(b.itemId));
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
