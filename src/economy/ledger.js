import { RULES } from "../content/rules.js";
import { recordFinancialFlow } from "./financial-flows.js";

// 账本批次（日结期间开启）：钱货照常逐笔结清，账本行先按"类型、付款方、收款方、物品、日期"合并，
// 批次结束时一次写入并计入资金流统计（只读这几个字段且是累加，合计不变）。一天几万笔小额买卖
// 变成每户每个收款方每类一行，写账开销降一个量级。批次不进存档（WeakMap 以 state 为键）。
const ledgerBatches = new WeakMap();

export function withLedgerBatch(state, content, fn) {
  if (ledgerBatches.has(state)) return fn();
  const batch = { rows: new Map(), currency: new Map() };
  ledgerBatches.set(state, batch);
  try {
    return fn();
  } finally {
    ledgerBatches.delete(state);
    for (const row of batch.rows.values()) writeLedgerRow(state, row, content);
    for (const entry of batch.currency.values()) entry.flush();
  }
}

// 粮券账本（currency.js）用：批次中返回当前批次的合并表，否则 null。
export function currencyLedgerBatch(state) {
  return ledgerBatches.get(state)?.currency || null;
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
  const date = {
    year: options.year ?? state.year,
    day: Math.max(1, Math.min(content.rules.daysPerYear, options.day ?? (state.day + 1)))
  };
  const batch = ledgerBatches.get(state);
  if (batch) {
    const key = `${entry.type}|${entry.source}|${entry.destination}|${entry.itemId}|${date.year}|${date.day}`;
    const merged = batch.rows.get(key);
    if (merged) {
      merged.quantityUnits = (merged.quantityUnits || 0) + (entry.quantityUnits || 0);
      merged.qeqUnits = (merged.qeqUnits || 0) + (entry.qeqUnits || 0);
      merged.count += 1;
    } else batch.rows.set(key, { id: 0, ...date, ...entry, count: 1 });
    return;
  }
  state.ledgerSequence += 1;
  // 同一行对象给账本和资金流统计（recordFinancialFlow 只读），省一次对象展开。
  const row = { id: state.ledgerSequence, ...date, ...entry };
  state.ledger.unshift(row);
  recordFinancialFlow(state, row);
  if (state.ledger.length > content.rules.ledgerLimit) {
    state.ledger.length = content.rules.ledgerLimit;
  }
}

export function recordEvent(state, text, content, options = {}) {
  const eventDay = Math.max(1, Math.min(content.rules.daysPerYear, options.day ?? state.day));
  // 事件合并（0.1.11 机制补回）：同 mergeKey 且在合并窗口内的重复事件折叠为一条，
  // 改写 untilDay/mergeCount/mergeAmount，并用 mergedText 生成聚合叙述句。
  if (options.mergeKey) {
    const mergeWindowDays = Math.max(1, Math.floor(options.mergeWindowDays || 1));
    const existing = state.events.find(e => e.mergeKey === options.mergeKey);
    const baseDay = existing ? (existing.untilDay ?? existing.day) : null;
    if (existing && existing.year === state.year && baseDay != null &&
        eventDay - baseDay >= 0 && eventDay - baseDay <= mergeWindowDays) {
      existing.untilDay = eventDay;
      existing.mergeCount = (existing.mergeCount || 1) + 1;
      existing.mergeAmount = (existing.mergeAmount || 0) + (options.amount || 0);
      if (typeof options.mergedText === "function") {
        existing.text = options.mergedText(existing.mergeCount, existing.mergeAmount);
      } else {
        existing.text = text;
      }
      return;
    }
    state.events.unshift({
      year: state.year,
      day: eventDay,
      text,
      mergeKey: options.mergeKey,
      mergeCount: 1,
      mergeAmount: options.amount || 0
    });
    if (state.events.length > 24) state.events.length = 24;
    return;
  }
  state.events.unshift({
    year: state.year,
    day: eventDay,
    text
  });
  if (state.events.length > 24) state.events.length = 24;
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
