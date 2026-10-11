// 耐用品（金银消费第二期 A，配置 rules.durableGoods）：目标持有 = 持有者人数 × perFarmer（件），寿命 lifeYears 年线性折旧。
// - 每日折旧（wearDurableGoods）：每件每日损耗 1/(lifeYears × daysPerYear) 件，按户汇总，只遍历持有该物的户；
//   户内不足一个库存单位的损耗记在 household.durableWearCarry 里，下日接着累计（库存只存整数单位）。
// - 每日补货（buyDurableGoodsForHouseholds）：有持有者的户，缺的部分从综合商店买（耐用品只经商店卖）；
//   每户每日买入不超过当日可花预算 × rules.durableSpendCapShare；买不到的记为未满足。排在日用品之前（生产资料优先）。
import { householdList, isActiveHousehold, syncResidentAggregates } from "./households.js";
import { purchaseItemForResidents } from "./consumer-market.js";
import { householdBudgets } from "./household-budget.js";
import { currentUnitPrice } from "../economy/prices.js";
import { currencyScale } from "../economy/currency.js";
import { bookAddMap, ensureBook } from "../economy/books.js";
import { recordLedger, makeTransactionId } from "../economy/ledger.js";
import { durableGoodsConfig, durableTargetPieces } from "../selectors/durable-goods.js";

export function emptyDurablePeriod() {
  return { demandUnits: {}, purchasedUnits: {}, paidVoucherUnits: {}, unmetUnits: {}, wornUnits: {} };
}

export function ensureDurableGoods(state) {
  state.durableGoods ||= {};
  ensureBook(state.durableGoods, emptyDurablePeriod);
  return state.durableGoods;
}

export function resetDurableDay(state) {
  if (state.durableGoods) state.durableGoods.day = emptyDurablePeriod();
}

export function resetDurableYear(state) {
  if (state.durableGoods) state.durableGoods.year = emptyDurablePeriod();
}

export function wearDurableGoods(state, content) {
  ensureDurableGoods(state);
  const scale = content.precision.inventoryUnitsPerJin;
  const results = {};
  for (const itemId of Object.keys(content.rules.durableGoods || {})) {
    const cfg = durableGoodsConfig(content, itemId);
    const rate = cfg.lifeYears > 0 ? 1 / (cfg.lifeYears * content.rules.daysPerYear) : 0;
    let worn = 0;
    for (const household of householdList(state)) {
      const held = Math.max(0, household.inventory?.[itemId] || 0);
      if (held <= 0 || !(rate > 0)) continue;
      const carries = (household.durableWearCarry ||= {});
      const exact = held * rate + (carries[itemId] || 0);
      const lost = Math.min(held, Math.floor(exact + 1e-9));
      carries[itemId] = Math.max(0, exact - lost);
      if (lost <= 0) continue;
      household.inventory[itemId] = held - lost;
      worn += lost;
    }
    if (worn > 0) {
      bookAddMap(state.durableGoods, "wornUnits", itemId, worn);
      recordLedger(state, {
        type: "durable_wear", transactionId: makeTransactionId(state),
        source: "households", destination: "durable_wear", itemId, quantityUnits: worn, qeqUnits: 0,
        reason: `${content.items[itemId]?.name || itemId}自然折旧（寿命 ${cfg.lifeYears} 年）`
      }, content);
      syncResidentAggregates(state, content);
    }
    results[itemId] = { wornUnits: worn, wornPieces: worn / scale };
  }
  return results;
}

export function buyDurableGoodsForHouseholds(state, content) {
  ensureDurableGoods(state);
  const scale = content.precision.inventoryUnitsPerJin;
  const cap = Math.max(0, Number(content.rules.durableSpendCapShare) || 0);
  const budgets = householdBudgets(state, content);
  const results = {};
  for (const itemId of Object.keys(content.rules.durableGoods || {})) {
    const cfg = durableGoodsConfig(content, itemId);
    const price = currentUnitPrice(state, itemId, content);
    const needs = {};
    // 需求 = 各户今日想买的量：缺口，但不超过当日可花预算的 durableSpendCapShare（预算以外的缺口不算需求，留到以后几天买）。
    let desired = 0;
    let gapUnits = 0;
    for (const household of householdList(state).filter(isActiveHousehold)) {
      const targetUnits = Math.round(durableTargetPieces(household, cfg) * scale);
      const gap = targetUnits - Math.max(0, household.inventory?.[itemId] || 0);
      if (gap <= 0) continue;
      gapUnits += gap;
      const dailyVoucher = budgets.get(household.id)?.dailySpendUnits || 0;
      const capUnits = price > 0 ? Math.floor(dailyVoucher * cap * scale / (price * currencyScale(content))) : 0;
      const want = Math.min(gap, capUnits);
      if (want <= 0) continue;
      needs[household.id] = want;
      desired += want;
    }
    if (desired <= 0) { results[itemId] = { purchasedUnits: 0, paidVoucherUnits: 0, unmetUnits: 0, gapUnits, reason: gapUnits > 0 ? "预算不够" : "无人需要" }; continue; }
    const result = purchaseItemForResidents(state, itemId, desired, price, content,
      `家庭购买${content.items[itemId]?.name || itemId}（耐用品补置）`, { householdNeedsUnits: needs });
    const purchased = result.purchasedUnits || 0;
    const paid = result.paidVoucherUnits || 0;
    // 未满足 = 想买但买不到（没有综合商店、店里没货、店铺接待满）。
    bookAddMap(state.durableGoods, "demandUnits", itemId, desired);
    bookAddMap(state.durableGoods, "purchasedUnits", itemId, purchased);
    bookAddMap(state.durableGoods, "paidVoucherUnits", itemId, paid);
    bookAddMap(state.durableGoods, "unmetUnits", itemId, Math.max(0, desired - purchased));
    results[itemId] = { purchasedUnits: purchased, paidVoucherUnits: paid, unmetUnits: Math.max(0, desired - purchased), gapUnits, reason: result.reason || null };
  }
  return results;
}
