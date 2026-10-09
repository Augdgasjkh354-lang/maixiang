import { PRECISION } from "../content/rules.js";
import { accountInventory, isHouseholdOwner } from "./accounts.js";
import { makeTransactionId, recordLedger } from "./ledger.js";
import { allocateIntegerByWeight } from "../core/allocation.js";

export function quantityToUnits(quantityJin, content) {
  const value = Number(quantityJin);
  if (!Number.isFinite(value)) throw new TypeError("物品数量必须是有限数值");
  return Math.round((value + Number.EPSILON) * content.precision.inventoryUnitsPerJin);
}

export function unitsToQuantity(units, content) {
  return units / content.precision.inventoryUnitsPerJin;
}

export function itemQeqUnitsPerInventoryUnit(item, content) {
  if (!item || item.edible !== true || !item.qeq) return 0;
  const numerator = content.precision.qeqUnitsPerJin * item.qeq.numerator;
  const denominator = content.precision.inventoryUnitsPerJin * item.qeq.denominator;
  const ratio = numerator / denominator;
  if (!Number.isInteger(ratio)) throw new Error("口粮当量精度不支持物品：" + item.id);
  return ratio;
}

export function qeqUnitsForInventoryUnits(item, inventoryUnits, content) {
  return itemQeqUnitsPerInventoryUnit(item, content) * inventoryUnits;
}

export function qeqJinToUnits(qeqJin, content) {
  const value = Number(qeqJin);
  if (!Number.isFinite(value)) throw new TypeError("口粮数量必须是有限数值");
  return Math.round((value + Number.EPSILON) * content.precision.qeqUnitsPerJin);
}

export function qeqUnitsToJin(units, content) {
  return units / content.precision.qeqUnitsPerJin;
}

function hasHouseholdAccounts(state) {
  return Boolean(state.households?.byId);
}

function householdRows(state) {
  return Object.values(state.households?.byId || {});
}

function syncResidentInventoryMirror(state, content) {
  if (!hasHouseholdAccounts(state)) return;
  state.accounts ||= {};
  state.accounts.residents ||= {};
  // 一次遍历全部家庭（原来每种物品各遍历一遍，选择器里最热的一处）；结果与逐品求和相同。
  const itemIds = Object.keys(content.items);
  const totals = Object.fromEntries(itemIds.map(itemId => [itemId, 0]));
  for (const household of householdRows(state)) {
    const inventory = household.inventory;
    if (!inventory) continue;
    for (const itemId of itemIds) totals[itemId] += inventory[itemId] || 0;
  }
  for (const itemId of itemIds) state.accounts.residents[itemId] = totals[itemId];
}

// 居民库存镜像平时由转移增量维护（每次改动量已知，加减即可），不再每次读写都整表重算。
// 延迟同步期间（state._deferHouseholdSync）户库存可能被外部直接改动，仍整表重算；镜像缺物品键时也整表补齐。
function residentMirrorTrusted(state, content) {
  if (state._deferHouseholdSync) return false;
  const mirror = state.accounts?.residents;
  if (!mirror) return false;
  for (const itemId in content.items) if (!Number.isInteger(mirror[itemId])) return false;
  return true;
}

function freshenResidentMirror(state, content) {
  if (hasHouseholdAccounts(state) && !residentMirrorTrusted(state, content)) syncResidentInventoryMirror(state, content);
}

// 某户库存已按 delta 改过（改动总量正好等于 delta）：镜像加上 delta 即可。
function applyResidentMirrorDelta(state, itemId, delta, content) {
  if (!hasHouseholdAccounts(state)) return;
  if (!residentMirrorTrusted(state, content)) { syncResidentInventoryMirror(state, content); return; }
  state.accounts.residents[itemId] += delta;
}

const accountObject = accountInventory;

export function accountQeqUnits(state, owner, content) {
  if (owner === "residents") freshenResidentMirror(state, content);
  const account = accountObject(state, owner);
  if (!account) return 0;
  let total = 0;
  for (const [itemId, item] of Object.entries(content.items)) {
    total += qeqUnitsForInventoryUnits(item, account[itemId] || 0, content);
  }
  return total;
}

export function totalQeqUnits(state, content) {
  let total = accountQeqUnits(state, "residents", content) + accountQeqUnits(state, "town", content);
  for (const company of Object.values(state.companies || {})) {
    for (const [itemId, item] of Object.entries(content.items)) total += qeqUnitsForInventoryUnits(item, company.inventory?.[itemId] || 0, content);
  }
  for (const shop of Object.values(state.shops || {})) {
    for (const [itemId, item] of Object.entries(content.items)) total += qeqUnitsForInventoryUnits(item, shop.inventory?.[itemId] || 0, content);
  }
  return total;
}

function ownerBalance(state, owner, itemId, content) {
  if (!content.items[itemId]) throw new Error("未注册物品：" + itemId);
  if (owner === "residents") freshenResidentMirror(state, content);
  const account = accountObject(state, owner);
  if (!account) throw new Error("未知粮食账户：" + owner);
  if (!Number.isInteger(account[itemId])) account[itemId] = 0;
  return account[itemId];
}

function aggregateHouseholdPopulation(household) {
  const bands = household?.ageBands || {};
  return Math.max(0, bands.children || 0) + Math.max(0, bands.workers || 0) + Math.max(0, bands.elders || 0);
}

function distributeResidentDelta(state, itemId, delta, content) {
  const households = householdRows(state);
  if (!households.length) throw new Error("居民家庭账户为空");
  if (delta > 0) {
    const allocation = allocateIntegerByWeight(delta, households, household => aggregateHouseholdPopulation(household));
    if (!allocation.ok) throw new Error("居民家庭库存分配失败：" + allocation.reason);
    for (const { recipient: household, units } of allocation.rows) {
      household.inventory ||= {};
      household.inventory[itemId] = (household.inventory[itemId] || 0) + units;
    }
  } else if (delta < 0) {
    let left = -delta;
    const ordered = households.slice().sort((a, b) => (b.inventory?.[itemId] || 0) - (a.inventory?.[itemId] || 0) || String(a.id).localeCompare(String(b.id)));
    for (const h of ordered) {
      if (left <= 0) break;
      const available = h.inventory?.[itemId] || 0;
      const amount = Math.min(left, available);
      if (amount <= 0) continue;
      h.inventory[itemId] -= amount;
      left -= amount;
    }
    if (left > 0) throw new RangeError("居民家庭库存不足");
  }
  applyResidentMirrorDelta(state, itemId, delta, content);
}

function setBalance(state, owner, itemId, next, content) {
  if (!Number.isSafeInteger(next) || next < 0) throw new RangeError("库存不能为负数或超出精度");
  const before = ownerBalance(state, owner, itemId, content);
  if (owner === "residents" && hasHouseholdAccounts(state)) {
    distributeResidentDelta(state, itemId, next - before, content);
    return;
  }
  const account = accountObject(state, owner);
  account[itemId] = next;
  if (isHouseholdOwner(owner)) applyResidentMirrorDelta(state, itemId, next - before, content);
}

// 有库存的账户才能做实物转移（社保基金只有钱、没有库存）。
function ownerExists(state, owner) {
  return Boolean(accountInventory(state, owner));
}

function moveTownBookValue(state, from, to, itemId, quantityUnits, townBalanceBefore, content) {
  const book = state.business?.inventoryCostWheatUnits?.town;
  if (!book || from === to) return;
  const basis = Number.isSafeInteger(book[itemId]) ? book[itemId] : 0;
  if (from === "town") {
    const movedCost = quantityUnits === townBalanceBefore
      ? basis
      : (townBalanceBefore > 0 ? Math.floor(basis * quantityUnits / townBalanceBefore) : 0);
    book[itemId] = basis - movedCost;
  } else if (to === "town") {
    const rate = Number.isFinite(content.items[itemId]?.openingCostWheatPerJin)
      ? content.items[itemId].openingCostWheatPerJin : 0;
    book[itemId] = basis + Math.round(quantityUnits * rate);
  }
}

function addTotalQeq(state, key, amount) {
  state.yearTotals[key] = (state.yearTotals[key] || 0) + amount;
}

export function changeInventory(state, owner, itemId, deltaUnits, reason, type, content, transactionId, ledgerDate) {
  if (!Number.isSafeInteger(deltaUnits) || deltaUnits === 0) {
    if (deltaUnits === 0) return { ok: true, quantityUnits: 0 };
    throw new TypeError("库存变化必须是整数精度单位");
  }
  const before = ownerBalance(state, owner, itemId, content);
  const after = before + deltaUnits;
  if (after < 0) return { ok: false, reason: "库存不足" };
  setBalance(state, owner, itemId, after, content);
  const item = content.items[itemId];
  const qeqUnits = qeqUnitsForInventoryUnits(item, Math.abs(deltaUnits), content);
  recordLedger(state, {
    type: type || (deltaUnits > 0 ? "deposit" : "withdrawal"),
    transactionId: transactionId || makeTransactionId(state),
    source: deltaUnits > 0 ? "external" : owner,
    destination: deltaUnits > 0 ? owner : "external",
    itemId,
    quantityUnits: Math.abs(deltaUnits),
    qeqUnits,
    reason
  }, content, ledgerDate);
  return { ok: true, quantityUnits: Math.abs(deltaUnits), qeqUnits };
}

export function returnConstructionMaterial(state, sourceId, owner, itemId, units, reason, content) {
  if (!Number.isSafeInteger(units) || units <= 0 || !content.items[itemId] || !ownerExists(state, owner)) {
    return { ok: false, reason: "材料返还记录无效" };
  }
  const before = ownerBalance(state, owner, itemId, content);
  if (!Number.isSafeInteger(before + units)) return { ok: false, reason: "库存超出精度" };
  setBalance(state, owner, itemId, before + units, content);
  const transactionId = makeTransactionId(state);
  recordLedger(state, {
    type: "construction_material_return", transactionId,
    source: sourceId, destination: owner, itemId, quantityUnits: units,
    qeqUnits: qeqUnitsForInventoryUnits(content.items[itemId], units, content), reason
  }, content);
  return { ok: true, transactionId, quantityUnits: units };
}

export function addInventory(state, owner, itemId, quantityJin, reason, type, content) {
  const units = quantityToUnits(quantityJin, content);
  if (units <= 0) return { ok: false, reason: "数量须大于零" };
  return changeInventory(state, owner, itemId, units, reason, type, content);
}

export function planFoodTransfer(account, qeqUnits, content, allowPartial) {
  const requested = Math.max(0, Math.floor(qeqUnits));
  const priority = Object.values(content.items)
    .filter(function (item) { return item.edible && item.qeq; })
    .sort(function (a, b) {
      return (a.transferPriority || 0) - (b.transferPriority || 0);
    });
  let remaining = requested;
  const moves = [];
  for (const item of priority) {
    const perUnit = itemQeqUnitsPerInventoryUnit(item, content);
    const available = Math.max(0, Math.floor(account[item.id] || 0));
    const amount = Math.min(available, Math.floor(remaining / perUnit));
    if (amount > 0) {
      moves.push({ itemId: item.id, quantityUnits: amount, qeqUnits: amount * perUnit });
      remaining -= amount * perUnit;
    }
    if (remaining === 0) break;
  }
  if (remaining > 0 && !allowPartial) return null;
  return { requestedQeqUnits: requested, movedQeqUnits: requested - remaining, remainingQeqUnits: remaining, moves };
}

export function transferFoodQeq(state, from, to, qeqUnits, reason, category, content, options) {
  const settings = options || {};
  if (from === "residents") freshenResidentMirror(state, content);
  const fromAccount = accountObject(state, from);
  const plan = planFoodTransfer(fromAccount, qeqUnits, content, settings.allowPartial === true);
  if (!plan || plan.movedQeqUnits === 0) {
    return { ok: false, movedQeqUnits: 0, missingQeqUnits: Math.max(0, qeqUnits) };
  }
  const transactionId = makeTransactionId(state);
  for (const move of plan.moves) {
    const balance = ownerBalance(state, from, move.itemId, content);
    const target = ownerBalance(state, to, move.itemId, content);
    moveTownBookValue(state, from, to, move.itemId, move.quantityUnits,
      state.accounts.town[move.itemId] || 0, content);
    setBalance(state, from, move.itemId, balance - move.quantityUnits, content);
    setBalance(state, to, move.itemId, target + move.quantityUnits, content);
    recordLedger(state, {
      type: category || "transfer",
      transactionId,
      source: from,
      destination: to,
      itemId: move.itemId,
      quantityUnits: move.quantityUnits,
      qeqUnits: move.qeqUnits,
      reason
    }, content);
  }
  if (category === "wage") addTotalQeq(state, "operatingWagesQeq", plan.movedQeqUnits);
  if (category === "construction") addTotalQeq(state, "constructionPayQeq", plan.movedQeqUnits);
  if (category === "relief") addTotalQeq(state, "reliefQeq", plan.movedQeqUnits);
  return {
    ok: plan.remainingQeqUnits === 0,
    movedQeqUnits: plan.movedQeqUnits,
    missingQeqUnits: plan.remainingQeqUnits,
    moves: plan.moves,
    transactionId
  };
}

export function transferItemUnits(state, from, to, itemId, units, reason, content, type) {
  if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, reason: "数量须大于零" };
  const before = ownerBalance(state, from, itemId, content);
  if (before < units) return { ok: false, reason: "库存不足" };
  const target = ownerBalance(state, to, itemId, content);
  const transactionId = makeTransactionId(state);
  moveTownBookValue(state, from, to, itemId, units,
    state.accounts.town[itemId] || 0, content);
  setBalance(state, from, itemId, before - units, content);
  setBalance(state, to, itemId, target + units, content);
  const qeqUnits = qeqUnitsForInventoryUnits(content.items[itemId], units, content);
  recordLedger(state, {
    type: type || "transfer",
    transactionId,
    source: from,
    destination: to,
    itemId,
    quantityUnits: units,
    qeqUnits,
    reason
  }, content);
  return { ok: true, quantityUnits: units, qeqUnits };
}

export function transferItem(state, from, to, itemId, quantityJin, reason, content) {
  return transferItemUnits(
    state, from, to, itemId, quantityToUnits(quantityJin, content), reason, content
  );
}

export function atomicItemExchange(state, transfers, reason, content) {
  const totals = new Map();
  const checked = [];
  for (const line of transfers) {
    if (!content.items[line.itemId] || !ownerExists(state, line.from) || !ownerExists(state, line.to) ||
        line.from === line.to || !Number.isSafeInteger(line.quantityUnits) || line.quantityUnits <= 0) {
      return { ok: false, reason: "交换内容无效" };
    }
    checked.push(line);
    const fromKey = line.from + "|" + line.itemId;
    const toKey = line.to + "|" + line.itemId;
    totals.set(fromKey, (totals.get(fromKey) || 0) - line.quantityUnits);
    totals.set(toKey, (totals.get(toKey) || 0) + line.quantityUnits);
  }
  for (const [key, delta] of totals) {
    const split = key.indexOf("|");
    const owner = key.slice(0, split);
    const itemId = key.slice(split + 1);
    const result = ownerBalance(state, owner, itemId, content) + delta;
    if (!Number.isSafeInteger(result) || result < 0) {
      return { ok: false, reason: "交换一方库存不足", itemId, owner };
    }
  }
  const transactionId = makeTransactionId(state);
  for (const [key, delta] of totals) {
    const split = key.indexOf("|");
    const owner = key.slice(0, split);
    const itemId = key.slice(split + 1);
    setBalance(state, owner, itemId, ownerBalance(state, owner, itemId, content) + delta, content);
  }
  for (const line of checked) {
    recordLedger(state, {
      type: line.type || "market_trade",
      transactionId,
      source: line.from,
      destination: line.to,
      itemId: line.itemId,
      quantityUnits: line.quantityUnits,
      qeqUnits: qeqUnitsForInventoryUnits(content.items[line.itemId], line.quantityUnits, content),
      reason
    }, content);
  }
  return { ok: true, transactionId, transfers: checked };
}

export function atomicInventoryTransaction(state, transaction, content) {
  const inputs = transaction.inputs || [];
  const outputs = transaction.outputs || [];
  const inputTotals = new Map();
  const outputTotals = new Map();
  const unitsOf = function (line) {
    return line.quantityUnits ?? quantityToUnits(line.quantityJin, content);
  };
  const keyOf = function (line) { return line.owner + "|" + line.itemId; };
  for (const input of inputs) {
    if (!content.items[input.itemId]) return { ok: false, reason: "未注册物品：" + input.itemId };
    const key = keyOf(input);
    inputTotals.set(key, (inputTotals.get(key) || 0) + unitsOf(input));
  }
  for (const output of outputs) {
    if (!content.items[output.itemId]) return { ok: false, reason: "未注册物品：" + output.itemId };
    const key = keyOf(output);
    outputTotals.set(key, (outputTotals.get(key) || 0) + unitsOf(output));
  }
  for (const [key, units] of inputTotals) {
    const split = key.indexOf("|");
    const owner = key.slice(0, split);
    const itemId = key.slice(split + 1);
    if (ownerBalance(state, owner, itemId, content) < units) {
      return { ok: false, reason: "原料不足", itemId };
    }
  }
  for (const [key, units] of outputTotals) {
    const split = key.indexOf("|");
    const owner = key.slice(0, split);
    const itemId = key.slice(split + 1);
    if (!Number.isSafeInteger(ownerBalance(state, owner, itemId, content) + units)) {
      return { ok: false, reason: "产物超出库存精度", itemId };
    }
  }
  if (Number.isSafeInteger(transaction.minEndingQeqUnits)) {
    let endingQeq = accountQeqUnits(state, transaction.protectedOwner || "residents", content);
    for (const [key, units] of inputTotals) {
      const [owner, itemId] = key.split("|");
      if (owner === (transaction.protectedOwner || "residents")) endingQeq -= qeqUnitsForInventoryUnits(content.items[itemId], units, content);
    }
    for (const [key, units] of outputTotals) {
      const [owner, itemId] = key.split("|");
      if (owner === (transaction.protectedOwner || "residents")) endingQeq += qeqUnitsForInventoryUnits(content.items[itemId], units, content);
    }
    if (endingQeq < transaction.minEndingQeqUnits) return { ok: false, reason: "民营加工会侵占居民基本口粮储备" };
  }

  const transactionId = makeTransactionId(state);
  const applyLines = function (lines, direction) {
    for (const line of lines) {
      const owner = line.owner;
      const itemId = line.itemId;
      const units = unitsOf(line);
      const before = ownerBalance(state, owner, itemId, content);
      const delta = direction * units;
      setBalance(state, owner, itemId, before + delta, content);
      const item = content.items[itemId];
      const qeqUnits = qeqUnitsForInventoryUnits(item, Math.abs(delta), content);
    recordLedger(state, {
      type: direction < 0 ? (line.type || transaction.inputType || "process_input") : (line.type || transaction.outputType || "process_output"),
      transactionId,
      source: direction < 0 ? owner : (line.source || transaction.outputSource || "processing"),
      destination: direction < 0 ? (line.destination || transaction.inputDestination || "processing") : (line.destination || owner),
        itemId,
        quantityUnits: units,
        qeqUnits,
        reason: transaction.reason
      }, content);
    }
  };
  applyLines(inputs, -1);

  for (const loss of transaction.losses || []) {
    const units = loss.quantityUnits ?? quantityToUnits(loss.quantityJin, content);
    if (!units) continue;
    const qeqUnits = qeqUnitsForInventoryUnits(content.items[loss.itemId], units, content);
    recordLedger(state, {
      type: "processing_loss",
      transactionId,
      source: loss.owner || "town",
      destination: "loss",
      itemId: loss.itemId,
      quantityUnits: units,
      qeqUnits,
      reason: transaction.lossReason || "加工损耗（未进入口粮）"
    }, content);
    addTotalQeq(state, "processingLossQeq", qeqUnits);
  }

  applyLines(outputs, 1);
  return { ok: true, transactionId, wageQeqUnits: 0 };
}

export function consumeFoodQeq(state, owner, demandQeqUnits, reason, content) {
  if (owner === "residents" && hasHouseholdAccounts(state)) syncResidentInventoryMirror(state, content);
  const account = accountObject(state, owner);
  const plan = planFoodTransfer(account, demandQeqUnits, content, true);
  const transactionId = makeTransactionId(state);
  for (const move of plan.moves) {
    const before = ownerBalance(state, owner, move.itemId, content);
    setBalance(state, owner, move.itemId, before - move.quantityUnits, content);
    recordLedger(state, {
      type: "consume",
      transactionId,
      source: owner,
      destination: "consumed",
      itemId: move.itemId,
      quantityUnits: move.quantityUnits,
      qeqUnits: move.qeqUnits,
      reason
    }, content);
  }
  addTotalQeq(state, "consumptionQeq", plan.movedQeqUnits);
  return {
    consumedQeqUnits: plan.movedQeqUnits,
    missingQeqUnits: plan.remainingQeqUnits,
    moves: plan.moves
  };
}

export const INVENTORY_PRECISION = PRECISION.inventoryUnitsPerJin;
