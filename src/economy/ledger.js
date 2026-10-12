import { RULES } from "../content/rules.js";
import { recordFinancialFlow } from "./financial-flows.js";
import { addGazetteNote } from "./gazette-notes.js";

// 账本批次（日结期间开启）：钱货照常逐笔结清，账本行先按"类型、付款方、收款方、物品、日期"合并，
// 批次结束时一次写入并计入资金流统计（只读这几个字段且是累加，合计不变）。一天几万笔小额买卖
// 变成每户每个收款方每类一行，写账开销降一个量级。批次不进存档（WeakMap 以 state 为键）。
const ledgerBatches = new WeakMap();

// 显式开/关批次（分段日结用，见 systems/daily.js 的 createDayRunner）。open 返回 true 表示由本次调用开启，
// 已有批次时返回 false（调用方不应关闭别人的批次）。close 没有批次时什么也不做。
export function openLedgerBatch(state) {
  if (ledgerBatches.has(state)) return false;
  // rows / currency：按首次出现顺序排列的待写入行（写入顺序与合并前后的账一致）；
  // rowIndex / currencyIndex：合并用的查找表。查找用嵌套 Map（付款方 → 收款方 → 类型），不再每笔拼一个长字符串再算哈希。
  ledgerBatches.set(state, { rows: [], rowIndex: new Map(), currency: [], currencyIndex: new Map() });
  return true;
}

export function closeLedgerBatch(state, content) {
  const batch = ledgerBatches.get(state);
  if (!batch) return;
  ledgerBatches.delete(state);
  for (const row of batch.rows) writeLedgerRow(state, row, content);
  for (const entry of batch.currency) entry.flush();
}

// 把键分量规范成字符串，与原先 `${...}` 拼键时的转换一致（undefined → "undefined"，数字 → 数字串）。
function keyPart(value) { return typeof value === "string" ? value : String(value); }

// 在 a → b → c 三层嵌套 Map 里取（或建）叶子数组。
function leafList(index, a, b, c) {
  let level2 = index.get(a);
  if (level2 === undefined) { level2 = new Map(); index.set(a, level2); }
  let level3 = level2.get(b);
  if (level3 === undefined) { level3 = new Map(); level2.set(b, level3); }
  let leaf = level3.get(c);
  if (leaf === undefined) { leaf = []; level3.set(c, leaf); }
  return leaf;
}

export function withLedgerBatch(state, content, fn) {
  if (!openLedgerBatch(state)) return fn();
  try {
    return fn();
  } finally {
    closeLedgerBatch(state, content);
  }
}

// 粮券账本（currency.js）用：批次中返回当前批次的合并表，否则 null。
export function currencyLedgerBatch(state) {
  return ledgerBatches.get(state) || null;
}

// 粮券流水批次合并：同类型、同 owner、同付款方、同收款方的流水合并成一行。
// 返回已有的合并项（调用方累加），没有则返回 null；addCurrencyBatchEntry 登记新项。
export function findCurrencyBatchEntry(batch, type, owner, from, to) {
  const t = keyPart(type);
  const o = keyPart(owner ?? "");
  const f = keyPart(from ?? "");
  const d = keyPart(to ?? "");
  // 付款方为空的流水（铸币、换券，owner 才是主体）以 owner 作第一层键。
  const leaf = leafList(batch.currencyIndex, f !== "" ? f : o, d, t);
  for (let i = 0; i < leaf.length; i += 1) {
    const item = leaf[i];
    if (item.owner === o && item.from === f) return item.entry;
  }
  return null;
}

export function addCurrencyBatchEntry(batch, type, owner, from, to, entry) {
  const t = keyPart(type);
  const o = keyPart(owner ?? "");
  const f = keyPart(from ?? "");
  const d = keyPart(to ?? "");
  leafList(batch.currencyIndex, f !== "" ? f : o, d, t).push({ owner: o, from: f, entry });
  batch.currency.push(entry);
}

function writeLedgerRow(state, row, content) {
  state.ledgerSequence += 1;
  row.id = state.ledgerSequence;
  state.ledger.unshift(row);
  recordFinancialFlow(state, row);
  if (state.ledger.length > content.rules.ledgerLimit) {
    state.ledger.length = content.rules.ledgerLimit;
  }
}

export function recordLedger(state, entry, content, options = {}) {
  const year = options.year ?? state.year;
  const day = Math.max(1, Math.min(content.rules.daysPerYear, options.day ?? (state.day + 1)));
  const batch = ledgerBatches.get(state);
  if (batch) {
    // 同类型、同付款方、同收款方、同物品、同日的账合并成一行。
    const itemId = keyPart(entry.itemId);
    const leaf = leafList(batch.rowIndex, keyPart(entry.source), keyPart(entry.destination), keyPart(entry.type));
    for (let i = 0; i < leaf.length; i += 1) {
      const item = leaf[i];
      if (item.itemId === itemId && item.year === year && item.day === day) {
        const merged = item.row;
        merged.quantityUnits = (merged.quantityUnits || 0) + (entry.quantityUnits || 0);
        merged.qeqUnits = (merged.qeqUnits || 0) + (entry.qeqUnits || 0);
        merged.count += 1;
        return;
      }
    }
    const row = { id: 0, year, day, ...entry, count: 1 };
    leaf.push({ itemId, year, day, row });
    batch.rows.push(row);
    return;
  }
  state.ledgerSequence += 1;
  // 同一行对象给账本和资金流统计（recordFinancialFlow 只读），省一次对象展开。
  const row = { id: state.ledgerSequence, year, day, ...entry };
  state.ledger.unshift(row);
  recordFinancialFlow(state, row);
  if (state.ledger.length > content.rules.ledgerLimit) {
    state.ledger.length = content.rules.ledgerLimit;
  }
}

// 账本事件（state.events）已取消：玩家不再有事件流水。recordEvent 保留签名，调用点照旧，但默认什么也不存。
// 打了 options.gazette（{ kind, weight }）的消息写进镇报素材库（economy/gazette-notes.js），年终由 systems/gazette.js 编成镇报。
// mergeKey / mergedText 等旧的事件合并参数已无效果。
export function recordEvent(state, text, content, options = {}) {
  if (!options.gazette) return;
  addGazetteNote(state, {
    year: state.year,
    day: Math.max(1, Math.min(content.rules.daysPerYear, options.day ?? state.day)),
    kind: options.gazette.kind,
    weight: options.gazette.weight,
    text
  });
}

export function makeTransactionId(state) {
  state.transactionSequence = (state.transactionSequence || 0) + 1;
  return "tx-" + state.transactionSequence;
}

export function emptyYearTotals() {
  return {
    harvestQeq: 0,
    consumptionQeq: 0,
    operatingWagesQeq: 0,
    constructionPayQeq: 0,
    reliefQeq: 0,
    processingLossQeq: 0,
    unemploymentPaidQeq: 0,
    wagePaidQeq: 0,
    wageArrearsQeq: 0
  };
}
