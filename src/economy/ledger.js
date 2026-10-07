import { RULES } from "../content/rules.js";
import { recordFinancialFlow } from "./financial-flows.js";

export function recordLedger(state, entry, content, options = {}) {
  const date = {
    year: options.year ?? state.year,
    day: Math.max(1, Math.min(content.rules.daysPerYear, options.day ?? (state.day + 1)))
  };
  state.ledgerSequence += 1;
  state.ledger.unshift({ id: state.ledgerSequence, ...date, ...entry });
  recordFinancialFlow(state, { id: state.ledgerSequence, ...date, ...entry });
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
