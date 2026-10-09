import { currencyLedgerBatch, makeTransactionId, recordLedger } from "./ledger.js";
import { householdIdOf, isHouseholdOwner, parseOwner, paymentWheatSlot, readSlot, voucherSlot } from "./accounts.js";

// 公司与店铺持有独立的现金小麦，可在银行与粮券互换。
function holdsCashWheat(owner) {
  const kind = parseOwner(owner).kind;
  return kind === "company" || kind === "shop";
}
import { addTownCostBasis, applyTownCostRemoval, quoteTownCostRemoval } from "./business.js";
import {
  hasHouseholds, householdList, residentVoucherUnits, syncResidentAggregates,
  takeResidentVouchers, distributeResidentVouchers, householdConvertibleWheatUnits,
  householdExchangeAllowanceUnits, consumeHouseholdExchangeAllowance,
  maximumResidentExchangeWheatUnits
} from "../systems/households.js";
import { recordHouseholdAssetExchange, recordHouseholdVoucherTransfer } from "../systems/household-life.js";
import { voucherUnitsForWheatUnits, wheatUnitsForVoucherUnits } from "./money-units.js";

export function currencyScale(content) {
  return content.precision.currencyUnitsPerVoucher || content.precision.inventoryUnitsPerJin;
}

// 股价一档 = 0.01 粮券；所有股价都是一档的整数倍，最低一档。
export function shareTick(content) {
  return Math.max(1, Math.round(currencyScale(content) / 100));
}
export function roundToShareTick(units, content) {
  const tick = shareTick(content);
  return Math.max(tick, Math.round((Number(units) || 0) / tick) * tick);
}

export function ensureCurrencyState(state) {
  state.currency ||= {
    reserveWheatUnits: 0,
    reserveWheatCostVoucherUnits: 0,
    reserveModel: "town-inventory-v1",
    issuedUnits: 0,
    balances: { town: 0, residents: 0 },
    issuedCumulativeUnits: 0,
    exchangedCumulativeUnits: 0,
    redeemedCumulativeUnits: 0,
    guidancePending: true,
    ledger: []
  };
  state.currency.balances ||= { town: 0, residents: 0 };
  state.currency.balances.town ||= 0;
  state.currency.balances.residents ||= 0;
  state.currency.reserveWheatUnits ||= 0;
  state.currency.reserveWheatCostVoucherUnits ||= 0;
  state.currency.reserveModel ||= "town-inventory-v1";
  state.currency.issuedUnits ||= 0;
  state.currency.issuedCumulativeUnits ||= 0;
  state.currency.exchangedCumulativeUnits ||= 0;
  state.currency.redeemedCumulativeUnits ||= 0;
  if (!Array.isArray(state.currency.ledger)) state.currency.ledger = [];
  return state.currency;
}

export function voucherBalance(state, owner) {
  ensureCurrencyState(state);
  if (owner === "residents" && hasHouseholds(state)) return residentVoucherUnits(state);
  const { kind, id } = parseOwner(owner);
  if (!kind) throw new Error("未知粮券账户：" + owner);
  // 家庭直接读（最常见，省去建 slot 对象）；与 readSlot(voucherSlot(...)) 同口径。
  if (kind === "household") return state.households?.byId?.[id]?.voucherUnits || 0;
  return readSlot(voucherSlot(state, owner));
}

function setVoucherBalance(state, owner, value, content = null) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("粮券余额无效");
  ensureCurrencyState(state);
  if (owner === "residents" && hasHouseholds(state)) throw new Error("居民汇总粮券账户为只读；应落到具体家庭");
  const slot = voucherSlot(state, owner);
  if (!slot) throw new Error("粮券账户不存在：" + owner);
  slot.holder[slot.key] = value;
  if (isHouseholdOwner(owner) && content) syncResidentAggregates(state, content);
}

function currencyLedger(state, row, content) {
  // 日结批次中：同类型、同账户对的粮券流水合并成一行，批次结束时写入（见 ledger.js withLedgerBatch）。
  const batch = currencyLedgerBatch(state);
  if (batch) {
    const key = `${row.type}|${row.owner ?? ""}|${row.from ?? ""}|${row.to ?? ""}`;
    const merged = batch.get(key);
    if (merged) {
      merged.row.voucherUnits = (merged.row.voucherUnits || 0) + (row.voucherUnits || 0);
      if (row.wheatUnits) merged.row.wheatUnits = (merged.row.wheatUnits || 0) + row.wheatUnits;
      merged.row.count += 1;
    } else {
      const entry = { row: { ...row, count: 1 } };
      entry.flush = () => writeCurrencyLedgerRow(state, entry.row, content);
      batch.set(key, entry);
    }
    return row;
  }
  return writeCurrencyLedgerRow(state, row, content);
}

function writeCurrencyLedgerRow(state, row, content) {
  const currency = ensureCurrencyState(state);
  const record = { id: currency.ledger.length + 1, year: state.year,
    day: Math.max(1, Math.min(content.rules.daysPerYear, state.day + 1)), ...row };
  currency.ledger.push(record);
  const limit = content.rules.currencyLedgerLimit || 1500;
  // 平时每次只多出 1 条：shift 比 splice(0, n) 快得多，结果相同。
  while (currency.ledger.length > limit) currency.ledger.shift();
  return record;
}

export function totalVoucherBalances(state) {
  const currency = ensureCurrencyState(state);
  let total = currency.balances.town || 0;
  total += hasHouseholds(state) ? residentVoucherUnits(state) : (currency.balances.residents || 0);
  for (const company of Object.values(state.companies || {})) total += company.cashVoucherUnits || 0;
  for (const shop of Object.values(state.shops || {})) total += shop.cashVoucherUnits || 0;
  total += state.socialSecurity?.cashVoucherUnits || 0;
  // 银行现金是粮券总账的一部分（金融扩展二期）；deposits 台账只是归属明细，不重复计入。
  total += state.bank?.cashVoucherUnits || 0;
  return total;
}

export function validateCurrencyInvariant(state, content = null) {
  const currency = ensureCurrencyState(state);
  const balances = totalVoucherBalances(state);
  return {
    valid: Number.isSafeInteger(currency.issuedUnits) && currency.issuedUnits >= 0 && balances === currency.issuedUnits,
    balances, issuedUnits: currency.issuedUnits,
    reserveWheatUnits: 0, expectedIssuedUnits: currency.issuedUnits
  };
}

function takeHouseholdWheatForExchange(state, household, wheatUnits, content, reason, enforceQuota = true) {
  if ((household.inventory?.wheat || 0) < wheatUnits) return { ok: false, reason: "可用小麦不足" };
  const convertible = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
  if (wheatUnits > convertible) return { ok: false, reason: "还需保留家庭基本口粮" };
  if (enforceQuota && wheatUnits > householdExchangeAllowanceUnits(state, household.id, content)) return { ok: false, reason: "今日就业换券额度不足" };
  if (enforceQuota && !consumeHouseholdExchangeAllowance(state, household.id, wheatUnits, content)) return { ok: false, reason: "今日就业换券额度不足" };
  const voucherUnits = voucherUnitsForWheatUnits(wheatUnits, content, "floor");
  if (voucherUnits <= 0 || wheatUnitsForVoucherUnits(voucherUnits, content, "ceil") !== wheatUnits) return { ok: false, reason: "该数量无法按当前整数精度1:1换券" };
  household.inventory.wheat -= wheatUnits;
  return { ok: true, householdId: household.id, wheatUnits, voucherUnits, reason };
}

function currencyAccessCheck(state, owner) {
  void owner;
  const reform = state.monetaryReform || { stage: "wheat", legacyBankAccess: false };
  const bank = Boolean(reform.legacyBankAccess || (state.buildings || []).some(row => row.typeId === "bank"));
  if (reform.stage === "wheat") return { ok: false, reason: "货币改革尚未启动" };
  if (!bank) return { ok: false, reason: "需要银行才能发行或换券" };
  return { ok: true };
}

export function issueTownVouchers(state, voucherUnits, content, reason = "镇库印制粮券") {
  if (!Number.isSafeInteger(voucherUnits) || voucherUnits <= 0) return { ok: false, reason: "发行数量必须大于0" };
  const access = currencyAccessCheck(state, "town");
  if (!access.ok) return access;
  const currency = ensureCurrencyState(state);
  const nextTown = voucherBalance(state, "town") + voucherUnits;
  const nextIssued = currency.issuedUnits + voucherUnits;
  if (!Number.isSafeInteger(nextTown) || !Number.isSafeInteger(nextIssued)) return { ok: false, reason: "数值超过安全范围" };
  setVoucherBalance(state, "town", nextTown, content);
  currency.issuedUnits = nextIssued;
  currency.issuedCumulativeUnits += voucherUnits;
  currency.guidancePending = false;
  const transactionId = makeTransactionId(state);
  currencyLedger(state, { type: "mint", transactionId, owner: "town", voucherUnits, reason }, content);
  recordLedger(state, { type: "voucher_issue", transactionId, source: "currency_issuer", destination: "town",
    itemId: "grain_voucher", quantityUnits: voucherUnits, qeqUnits: 0, reason }, content);
  return { ok: true, transactionId, wheatUnits: 0, voucherUnits };
}

export function issueVouchersFromWheat(state, owner, wheatUnits, content, reason = "交出小麦换取镇库粮券") {
  if (!Number.isSafeInteger(wheatUnits) || wheatUnits <= 0) return { ok: false, reason: "换券小麦必须大于0" };
  if (owner === "town") return { ok: false, reason: "镇库发行粮券不消耗小麦，请使用印制发行" };
  const access = currencyAccessCheck(state, owner);
  if (!access.ok) return access;
  const voucherUnits = voucherUnitsForWheatUnits(wheatUnits, content, "floor");
  if (voucherUnits <= 0 || wheatUnitsForVoucherUnits(voucherUnits, content, "ceil") !== wheatUnits) return { ok: false, reason: "该数量无法按当前整数精度换券" };
  const currency = ensureCurrencyState(state);
  if (voucherBalance(state, "town") < voucherUnits) return { ok: false, reason: "镇库已发行粮券余额不足，请先印制粮券" };
  if (!Number.isSafeInteger((state.accounts?.town?.wheat || 0) + wheatUnits)) return { ok: false, reason: "数值超过安全范围" };

  let householdRows = null;
  if (hasHouseholds(state) && owner === "residents") {
    let left = wheatUnits;
    householdRows = [];
    const candidates = householdList(state).slice().sort((a, b) =>
      Math.min(householdConvertibleWheatUnits(state, b, content), householdExchangeAllowanceUnits(state, b.id, content)) -
      Math.min(householdConvertibleWheatUnits(state, a, content), householdExchangeAllowanceUnits(state, a.id, content)));
    for (const household of candidates) {
      if (left <= 0) break;
      const available = Math.min(householdConvertibleWheatUnits(state, household, content), householdExchangeAllowanceUnits(state, household.id, content));
      const amount = Math.min(left, available);
      if (amount <= 0) continue;
      const result = takeHouseholdWheatForExchange(state, household, amount, content, reason, true);
      if (!result.ok) continue;
      householdRows.push({ householdId: household.id, wheatUnits: amount, units: result.voucherUnits });
      left -= amount;
    }
    if (left > 0) {
      for (const row of householdRows) {
        const household = state.households.byId[row.householdId];
        household.inventory.wheat += row.wheatUnits;
        const ex = state.households.exchange;
        ex.usedByHousehold[row.householdId] = Math.max(0, (ex.usedByHousehold[row.householdId] || 0) - row.wheatUnits);
      }
      syncResidentAggregates(state, content);
      return { ok: false, reason: "家庭可用小麦或今日就业换券额度不足" };
    }
    for (const row of householdRows) state.households.byId[row.householdId].voucherUnits = (state.households.byId[row.householdId].voucherUnits || 0) + row.units;
    syncResidentAggregates(state, content);
  } else if (isHouseholdOwner(owner)) {
    const household = state.households?.byId?.[householdIdOf(owner)];
    if (!household) return { ok: false, reason: "家庭不存在" };
    const result = takeHouseholdWheatForExchange(state, household, wheatUnits, content, reason, true);
    if (!result.ok) return result;
    household.voucherUnits = (household.voucherUnits || 0) + voucherUnits;
    householdRows = [{ householdId: household.id, wheatUnits, units: voucherUnits }];
    syncResidentAggregates(state, content);
  } else if (holdsCashWheat(owner)) {
    const slot = paymentWheatSlot(state, owner);
    if (readSlot(slot) < wheatUnits) return { ok: false, reason: "可用小麦不足" };
    slot.holder[slot.key] -= wheatUnits;
    setVoucherBalance(state, owner, voucherBalance(state, owner) + voucherUnits, content);
  } else {
    return { ok: false, reason: "该账户不能通过银行换券" };
  }

  setVoucherBalance(state, "town", voucherBalance(state, "town") - voucherUnits, content);
  state.accounts.town.wheat = (state.accounts.town.wheat || 0) + wheatUnits;
  addTownCostBasis(state, "wheat", voucherUnits);
  currency.reserveWheatUnits = 0;
  currency.reserveWheatCostVoucherUnits = 0;
  currency.reserveModel = "town-inventory-v1";
  currency.exchangedCumulativeUnits = (currency.exchangedCumulativeUnits || 0) + voucherUnits;
  const transactionId = makeTransactionId(state);
  currencyLedger(state, { type: "exchange", transactionId, owner, wheatUnits, voucherUnits, householdRows, reason }, content);
  recordHouseholdAssetExchange(state, householdRows, voucherUnits, content);
  recordLedger(state, { type: "voucher_exchange", transactionId, source: owner, destination: "town",
    itemId: "wheat", quantityUnits: wheatUnits,
    qeqUnits: wheatUnits * content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin,
    reason: reason + "；小麦进入镇库，粮券由镇库现有余额支付" }, content);
  return { ok: true, transactionId, wheatUnits, voucherUnits, householdRows };
}

// 粮券兑小麦：居民、店铺等用券向镇库换小麦，券交回镇库券池（镇库卖粮收券），全体粮券总量不变；
// 只有镇库自己兑（owner === "town"）才是注销，发行量减少。
export function redeemVouchersForWheat(state, owner, voucherUnits, content, reason = "粮券兑回小麦") {
  if (!Number.isSafeInteger(voucherUnits) || voucherUnits <= 0) return { ok: false, reason: "兑换数量必须大于0" };
  const supportedOwner = ["town", "residents", "household"].includes(parseOwner(owner).kind) || holdsCashWheat(owner);
  if (!supportedOwner) return { ok: false, reason: "该账户不能直接兑回小麦" };
  const currency = ensureCurrencyState(state);
  const wheatUnits = wheatUnitsForVoucherUnits(voucherUnits, content, "floor");
  if (wheatUnits <= 0 || voucherUnitsForWheatUnits(wheatUnits, content, "floor") !== voucherUnits) return { ok: false, reason: "该数量无法按当前整数精度兑回" };
  if (voucherBalance(state, owner) < voucherUnits) return { ok: false, reason: "粮券余额不足" };
  if (owner === "town" && currency.issuedUnits < voucherUnits) return { ok: false, reason: "未注销发行量不足" };
  if (owner !== "town" && (state.accounts?.town?.wheat || 0) < wheatUnits) return { ok: false, reason: "镇库可用小麦不足" };

  let householdRows = null;
  // 先扣券后扣麦：若扣券失败，镇库小麦不受影响（之前先扣麦，扣券失败会导致小麦凭空消失）。
  if (hasHouseholds(state) && owner === "residents") {
    const taken = takeResidentVouchers(state, voucherUnits, content);
    if (!taken.ok) return taken;
    householdRows = taken.rows.map(row => ({ ...row, wheatUnits: wheatUnitsForVoucherUnits(row.units, content, "floor") }));
    for (const row of householdRows) state.households.byId[row.householdId].inventory.wheat += row.wheatUnits;
    syncResidentAggregates(state, content);
  } else if (isHouseholdOwner(owner)) {
    const household = state.households?.byId?.[householdIdOf(owner)];
    if (!household || (household.voucherUnits || 0) < voucherUnits) return { ok: false, reason: "粮券余额不足" };
    household.voucherUnits -= voucherUnits;
    household.inventory.wheat = (household.inventory.wheat || 0) + wheatUnits;
    householdRows = [{ householdId: household.id, units: voucherUnits, wheatUnits }];
    syncResidentAggregates(state, content);
  } else if (owner === "town") {
    setVoucherBalance(state, owner, voucherBalance(state, owner) - voucherUnits, content);
  } else if (holdsCashWheat(owner)) {
    setVoucherBalance(state, owner, voucherBalance(state, owner) - voucherUnits, content);
    const slot = paymentWheatSlot(state, owner);
    slot.holder[slot.key] = readSlot(slot) + wheatUnits;
  }
  // 扣券成功后才扣镇库小麦（之前先扣麦，若扣券失败麦会凭空消失）。
  if (owner !== "town") {
    const quote = quoteTownCostRemoval(state, "wheat", wheatUnits, content);
    applyTownCostRemoval(state, quote);
    state.accounts.town.wheat -= wheatUnits;
    setVoucherBalance(state, "town", voucherBalance(state, "town") + voucherUnits, content);
  }
  currency.reserveWheatUnits = 0;
  currency.reserveWheatCostVoucherUnits = 0;
  currency.reserveModel = "town-inventory-v1";
  if (owner === "town") {
    currency.issuedUnits -= voucherUnits;
    currency.redeemedCumulativeUnits += voucherUnits;
  }
  const transactionId = makeTransactionId(state);
  currencyLedger(state, { type: "redeem", transactionId, owner, wheatUnits, voucherUnits, householdRows, reason }, content);
  recordHouseholdAssetExchange(state, householdRows, voucherUnits, content);
  recordLedger(state, { type: "voucher_redeem", transactionId, source: "town", destination: owner,
    itemId: "wheat", quantityUnits: owner === "town" ? 0 : wheatUnits,
    qeqUnits: owner === "town" ? 0 : wheatUnits * content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin, reason }, content);
  return { ok: true, transactionId, wheatUnits, voucherUnits, householdRows };
}

export function transferVouchers(state, from, to, voucherUnits, content, type = "voucher_transfer", reason = "粮券转账", options = {}) {
  if (!Number.isSafeInteger(voucherUnits) || voucherUnits < 0) return { ok: false, reason: "粮券数量无效" };
  if (voucherUnits === 0) return { ok: true, voucherUnits: 0, transactionId: null, householdDebits: [], householdCredits: [] };
  if (voucherBalance(state, from) < voucherUnits) return { ok: false, reason: "粮券余额不足" };
  if (!Number.isSafeInteger(voucherBalance(state, to) + voucherUnits)) return { ok: false, reason: "数值超过安全范围" };

  let householdDebits = [];
  let householdCredits = [];
  if (hasHouseholds(state) && from === "residents") {
    const result = takeResidentVouchers(state, voucherUnits, content, options.fromResidents || {});
    if (!result.ok) return result;
    householdDebits = result.rows;
  } else setVoucherBalance(state, from, voucherBalance(state, from) - voucherUnits, content);

  if (hasHouseholds(state) && to === "residents") {
    const result = distributeResidentVouchers(state, voucherUnits, content, options.toResidents || {});
    if (!result.ok) {
      if (from === "residents") for (const row of householdDebits) state.households.byId[row.householdId].voucherUnits += row.units;
      else setVoucherBalance(state, from, voucherBalance(state, from) + voucherUnits, content);
      syncResidentAggregates(state, content);
      return result;
    }
    householdCredits = result.rows;
  } else setVoucherBalance(state, to, voucherBalance(state, to) + voucherUnits, content);

  const transactionId = options.transactionId || makeTransactionId(state);
  currencyLedger(state, { type, transactionId, from, to, voucherUnits, householdDebits, householdCredits, reason }, content);
  recordHouseholdVoucherTransfer(state, { from, to, type, voucherUnits, householdDebits, householdCredits }, content);
  recordLedger(state, { type, transactionId, source: from, destination: to, itemId: "grain_voucher",
    quantityUnits: voucherUnits, qeqUnits: 0, reason }, content);
  return { ok: true, transactionId, voucherUnits, householdDebits, householdCredits };
}

export function maximumResidentAutoExchangeWheatUnits(state, population, reserveDays, content) {
  if (hasHouseholds(state)) return maximumResidentExchangeWheatUnits(state, content, reserveDays);
  const wheat = state.accounts?.residents?.wheat || 0;
  if (wheat <= 0) return 0;
  const needQeq = population * content.rules.foodPerPersonDay * reserveDays * content.precision.qeqUnitsPerJin;
  let otherFoodQeq = 0;
  for (const [itemId, item] of Object.entries(content.items)) {
    if (itemId === "wheat" || !item.edible || !item.qeq) continue;
    const units = state.accounts.residents[itemId] || 0;
    otherFoodQeq += units * content.precision.qeqUnitsPerJin * item.qeq.numerator /
      (content.precision.inventoryUnitsPerJin * item.qeq.denominator);
  }
  const wheatQeqPerUnit = content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin;
  const requiredWheatUnits = Math.max(0, Math.ceil((needQeq - otherFoodQeq) / wheatQeqPerUnit));
  return Math.max(0, wheat - requiredWheatUnits);
}


export function ensureHouseholdVouchersForEssential(state, householdId, requiredVoucherUnits, content, reserveDays = null) {
  const household = state.households?.byId?.[householdId];
  if (!household) return { ok: false, reason: "家庭不存在" };
  const current = household.voucherUnits || 0;
  if (current >= requiredVoucherUnits) return { ok: true, issuedUnits: 0 };
  const days = reserveDays ?? content.rules.basicCommerceFoodReserveDays ?? 30;
  const shortage = requiredVoucherUnits - current;
  const convertible = Math.min(
    householdConvertibleWheatUnits(state, household, content, days),
    householdExchangeAllowanceUnits(state, householdId, content)
  );
  const issue = Math.min(shortage, convertible);
  if (issue > 0) {
    const result = issueVouchersFromWheat(state, "household:" + householdId, issue, content,
      `家庭生活消费换券；保留${days}日口粮`);
    if (!result.ok) return result;
  }
  return (household.voucherUnits || 0) >= requiredVoucherUnits
    ? { ok: true, issuedUnits: issue }
    : { ok: false, issuedUnits: issue, reason: "家庭粮券不足或今日就业换券额度已用完" };
}

export function ensureResidentVouchersForEssential(state, requiredVoucherUnits, population, content, reserveDays = null) {
  const current = voucherBalance(state, "residents");
  if (current >= requiredVoucherUnits) return { ok: true, issuedUnits: 0 };
  const days = reserveDays ?? content.rules.basicCommerceFoodReserveDays ?? 30;
  const shortage = requiredVoucherUnits - current;
  const convertible = maximumResidentAutoExchangeWheatUnits(state, population, days, content);
  const issue = Math.min(shortage, convertible);
  if (issue > 0) {
    const result = issueVouchersFromWheat(state, "residents", issue, content, `家庭为生活消费换券；保留${days}日口粮`);
    if (!result.ok) return result;
  }
  return voucherBalance(state, "residents") >= requiredVoucherUnits
    ? { ok: true, issuedUnits: issue }
    : { ok: false, issuedUnits: issue, reason: `居民粮券不足；今日就业换券额度或${days}日口粮保护限制了换券` };
}
