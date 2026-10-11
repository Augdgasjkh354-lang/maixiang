// 粮券收购：镇库用自己的小麦向居民收购粮券（政策页“粮券收购”卡，银行面板之外的一个开关）。
//
// 性质：只是小麦与粮券在镇库和居民之间换手，不销毁小麦，也不改变粮券总量（issuedUnits 不变）。
//   镇库收到的粮券进入镇库券池（currency.balances.town），与以粮换券、镇库付款用的是同一个池子；
//   池子变大只是让以粮换券的封顶变大，不是重复计数：粮券总量守恒（validateCurrencyInvariant 照常通过）。
//   居民吃掉自家小麦才是真消耗；多出来的小麦堆在居民家里，家底把超出 30 天口粮的小麦算作财富。
//
// 每户每日的卖出量：
//   留存线 = max(宽裕度预算的日开销 × 30, 30 天口粮钱)；口粮钱按 1 券 / 斤 计（与 currency.js 的换券口径一致）。
//   超额 = max(0, 手头粮券 − 留存线)；愿意卖出 = 超额 × voucherBuybackSellShare（默认 0.2）。
//   只遍历有超额粮券的户（先按口粮钱做一步廉价筛选，再查宽裕度预算，后者当天缓存）。
// 当日总量受三重上限：政策的每日小麦上限、镇库可卖小麦（已留够口粮储备，townSellableWheatUnits）、各户愿意卖出额。
// 户序按户号排，从上次停下的户接着轮转（rotation），达到上限时后面的户不会总被排在前面的户挤掉。
//
// 成交：每户一次原子交换，先扣后给：居民粮券先进镇库券池，镇库小麦再进居民库存；预检通过后才动账，
// 所以任一步不会留下半笔（小麦入库检查失败时整户不动）。
// 账：账本类型 voucher_buyback（经日结账本批次合并）；三段记账在 state.voucherBuyback（day/year/cumulative：
// voucherUnits 收购粮券、wheatUnits 付出小麦、households 成交户数）。
import { currencyScale } from "../economy/currency.js";
import { hasCompletedBank } from "../economy/payment.js";
import { applyTownCostRemoval, quoteTownCostRemoval } from "../economy/business.js";
import { recordLedger } from "../economy/ledger.js";
import { bookAdd } from "../economy/books.js";
import { townSellableWheatUnits } from "../economy/foreign-wheat.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { applyResidentAggregateDelta, hasHouseholds, householdList, householdPopulation, isActiveHousehold } from "./households.js";
import { recordHouseholdAssetExchange } from "./household-life.js";
import { householdBudgets } from "./household-budget.js";

export const VOUCHER_BUYBACK_DEFAULTS = Object.freeze({ enabled: false, dailyWheatJin: 50000, wheatPerVoucher: 1 });
export const VOUCHER_BUYBACK_MAX_DAILY_WHEAT_JIN = 1000000000;
export const VOUCHER_BUYBACK_RATIO_MIN = 0.5;
export const VOUCHER_BUYBACK_RATIO_MAX = 2;
export const VOUCHER_BUYBACK_BANK_REASON = "需要银行才能收购粮券：请先建成银行";

// 只读：政策的规范化副本（旧档没有字段时用默认值，不写 state）。
export function readVoucherBuybackPolicy(state) {
  const raw = state.policy?.voucherBuyback || {};
  return {
    enabled: raw.enabled === true,
    dailyWheatJin: Number.isFinite(raw.dailyWheatJin) && raw.dailyWheatJin >= 0 ? raw.dailyWheatJin : VOUCHER_BUYBACK_DEFAULTS.dailyWheatJin,
    wheatPerVoucher: Number.isFinite(raw.wheatPerVoucher)
      ? Math.min(VOUCHER_BUYBACK_RATIO_MAX, Math.max(VOUCHER_BUYBACK_RATIO_MIN, raw.wheatPerVoucher))
      : VOUCHER_BUYBACK_DEFAULTS.wheatPerVoucher
  };
}

// 闸门（只读，不像 payment.js 的 hasBankAccess 那样会补建 monetaryReform）：已建成银行或兼容银行入口。
export function voucherBuybackBankReady(state) {
  return hasCompletedBank(state) || Boolean(state.monetaryReform?.legacyBankAccess);
}

export function ensureVoucherBuybackState(state) {
  state.voucherBuyback ||= { rotation: 0, day: {}, year: {}, cumulative: {} };
  const book = state.voucherBuyback;
  book.rotation ||= 0;
  book.day ||= {};
  book.year ||= {};
  book.cumulative ||= {};
  return book;
}

function numericInput(raw) {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return NaN;
  return Number(raw);
}

// 命令：patch = { enabled?, dailyWheatJin?, wheatPerVoucher? }。开启需要银行；数值须为有限数且非负（比价 0.5—2，一位小数）。
export function setVoucherBuybackPolicy(state, patch = {}, content = null) {
  void content;
  const next = {};
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return { ok: false, reason: "粮券收购开关须为布尔值" };
    if (patch.enabled && !voucherBuybackBankReady(state)) return { ok: false, reason: VOUCHER_BUYBACK_BANK_REASON };
    next.enabled = patch.enabled;
  }
  if (patch.dailyWheatJin !== undefined) {
    const value = numericInput(patch.dailyWheatJin);
    if (!Number.isFinite(value) || value < 0 || value > VOUCHER_BUYBACK_MAX_DAILY_WHEAT_JIN) {
      return { ok: false, reason: "每日收购小麦上限须为非负的有限数（斤）" };
    }
    next.dailyWheatJin = Math.round(value);
  }
  if (patch.wheatPerVoucher !== undefined) {
    const value = numericInput(patch.wheatPerVoucher);
    if (!Number.isFinite(value) || value < VOUCHER_BUYBACK_RATIO_MIN || value > VOUCHER_BUYBACK_RATIO_MAX) {
      return { ok: false, reason: `比价须为${VOUCHER_BUYBACK_RATIO_MIN}—${VOUCHER_BUYBACK_RATIO_MAX}斤小麦/粮券之间的有限数` };
    }
    next.wheatPerVoucher = Math.round(value * 10) / 10;
  }
  state.policy ||= {};
  state.policy.voucherBuyback = { ...readVoucherBuybackPolicy(state), ...next };
  return { ok: true, value: { ...state.policy.voucherBuyback } };
}

// 比价用整数运算：ratioTenths = 比价 × 10（5—20）。小麦单位 = 粮券单位 × ratio × I / V，向下取整。
function wheatForVouchers(voucherUnits, ratioTenths, inventoryScale, currencyUnits) {
  return Number((BigInt(voucherUnits) * BigInt(ratioTenths) * BigInt(inventoryScale)) / (10n * BigInt(currencyUnits)));
}

// 小麦预算内能收的最大粮券单位：最大 v 使 wheatForVouchers(v) ≤ wheatBudget。
function maxVouchersForWheat(wheatBudget, ratioTenths, inventoryScale, currencyUnits) {
  const numerator = (BigInt(wheatBudget) + 1n) * 10n * BigInt(currencyUnits) - 1n;
  return Number(numerator / (BigInt(ratioTenths) * BigInt(inventoryScale)));
}

// 一户的一次原子交换（先扣后给）。预检全部通过才动账；返回 { ok, reason? }。
function swapWithHousehold(state, household, voucherUnits, wheatUnits, content) {
  const haveVouchers = household.voucherUnits || 0;
  if (haveVouchers < voucherUnits) return { ok: false, reason: "家庭粮券不足" };
  const haveWheat = household.inventory?.wheat || 0;
  if (!Number.isSafeInteger(haveWheat + wheatUnits)) return { ok: false, reason: "家庭小麦超过安全范围" };
  const townVouchers = state.currency.balances.town || 0;
  if (!Number.isSafeInteger(townVouchers + voucherUnits)) return { ok: false, reason: "镇库粮券超过安全范围" };
  const townWheat = state.accounts.town.wheat || 0;
  if (townWheat < wheatUnits) return { ok: false, reason: "镇库小麦不足" };
  let quote;
  try {
    quote = quoteTownCostRemoval(state, "wheat", wheatUnits, content);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  // 1) 居民粮券进镇库券池。
  household.voucherUnits = haveVouchers - voucherUnits;
  state.currency.balances.town = townVouchers + voucherUnits;
  // 2) 镇库小麦给居民（成本随货转移）；小麦入户库存检查已在预检完成，这里不会再失败。
  household.inventory.wheat = haveWheat + wheatUnits;
  applyTownCostRemoval(state, quote);
  state.accounts.town.wheat = townWheat - wheatUnits;
  applyResidentAggregateDelta(state, content, -voucherUnits, "wheat", wheatUnits);
  return { ok: true };
}

// 日结步骤：每天一次。失败只记在本步（返回 ok:false），不影响其他步骤。
export function settleVoucherBuybackDay(state, content) {
  const book = ensureVoucherBuybackState(state);
  if (state.day === 0) book.year = {};
  book.day = {};
  book.lastError = null;
  const policy = readVoucherBuybackPolicy(state);
  if (!policy.enabled || !voucherBuybackBankReady(state)) return null;
  try {
    return runVoucherBuybackDay(state, content, policy, book);
  } catch (error) {
    book.lastError = String(error?.message || error);
    return { ok: false, reason: book.lastError };
  }
}

function runVoucherBuybackDay(state, content, policy, book) {
  const result = { ok: true, voucherUnits: 0, wheatUnits: 0, households: 0, wheatCapUnits: 0 };
  if (!hasHouseholds(state)) return result;
  const households = householdList(state);
  const count = households.length;
  if (!count) return result;
  const inventoryScale = content.precision.inventoryUnitsPerJin;
  const currencyUnits = currencyScale(content);
  const ratioTenths = Math.round(policy.wheatPerVoucher * 10);
  const share = Math.min(1, Math.max(0, content.rules.voucherBuybackSellShare ?? 0.2));
  const retentionDays = content.rules.voucherBuybackRetentionDays ?? 30;
  // 口粮钱（券单位，1 券 / 斤）：人口 × 每人每日口粮 × 天数。普通数运算即可（人口很小，远在安全整数内），热路径上不用 BigInt。
  const foodWheatUnitsPerPersonDay = content.rules.foodPerPersonDay * inventoryScale * retentionDays;
  // 日上限：政策的每日小麦上限与镇库可卖小麦（已留口粮储备）取小者。
  let wheatBudget = Math.min(Math.floor(policy.dailyWheatJin * inventoryScale), townSellableWheatUnits(state, content));
  result.wheatCapUnits = Math.max(0, wheatBudget);
  if (wheatBudget <= 0) return result;

  let budgets = null;
  const start = (state.voucherBuyback.rotation || 0) % count;
  let visited = 0;
  for (let i = 0; i < count && wheatBudget > 0; i += 1) {
    const household = households[(start + i) % count];
    visited = i + 1;
    if (!isActiveHousehold(household)) continue;
    const held = household.voucherUnits || 0;
    if (held <= 0) continue;
    // 口粮钱廉价筛选：手头粮券不超过 30 天口粮钱的户直接跳过，不查宽裕度预算。
    const foodMoneyUnits = Math.ceil(householdPopulation(household) * foodWheatUnitsPerPersonDay * currencyUnits / inventoryScale);
    if (held <= foodMoneyUnits) continue;
    budgets ||= householdBudgets(state, content);
    const row = budgets.get(household.id);
    if (!row) continue;
    const retention = Math.max(row.dailySpendUnits * retentionDays, foodMoneyUnits);
    const surplus = held - retention;
    if (surplus <= 0) continue;
    const maxByWheat = maxVouchersForWheat(wheatBudget, ratioTenths, inventoryScale, currencyUnits);
    const voucherUnits = Math.min(Math.floor(surplus * share), maxByWheat);
    if (voucherUnits <= 0) continue;
    const wheatUnits = wheatForVouchers(voucherUnits, ratioTenths, inventoryScale, currencyUnits);
    if (wheatUnits <= 0) continue;
    const swap = swapWithHousehold(state, household, voucherUnits, wheatUnits, content);
    if (!swap.ok) continue;
    wheatBudget -= wheatUnits;
    result.voucherUnits += voucherUnits;
    result.wheatUnits += wheatUnits;
    result.households += 1;
    recordHouseholdAssetExchange(state, [{ householdId: household.id, units: voucherUnits }], voucherUnits, content);
  }
  // 从本户之后接着轮转：没有达到上限时 visited 为户数，rotation 不变。
  state.voucherBuyback.rotation = (start + visited) % count;

  if (result.households > 0) {
    recordLedger(state, { type: "voucher_buyback", source: "residents", destination: "town", itemId: "grain_voucher",
      quantityUnits: result.voucherUnits, qeqUnits: 0, reason: "镇库用小麦收购居民粮券" }, content);
    recordLedger(state, { type: "voucher_buyback", source: "town", destination: "residents", itemId: "wheat",
      quantityUnits: result.wheatUnits, qeqUnits: result.wheatUnits * content.precision.qeqUnitsPerJin / inventoryScale,
      reason: "镇库用小麦收购居民粮券；小麦进居民库存" }, content);
    bookAdd(book, "voucherUnits", result.voucherUnits);
    bookAdd(book, "wheatUnits", result.wheatUnits);
    bookAdd(book, "households", result.households);
  }
  return result;
}
