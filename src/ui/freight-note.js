// 手动外贸的运力提示（docs/TRADE.md「运力」）：请求量大于实际成交量，且成交前运力池几乎都被这笔用掉（余量不到0.05斤），
// 视为受运力限制。交易结果本身不带"哪道上限起作用"，所以这里用成交前的池子余量判断；资金或库存不足时池子还有余量，不提示。
export function freightLimitNote(requestedJin, actualJin, poolBeforeJin) {
  if (![requestedJin, actualJin, poolBeforeJin].every(Number.isFinite)) return "";
  if (requestedJin - actualJin < 0.01) return "";
  const usedOfPool = poolBeforeJin - actualJin;
  return usedOfPool < 0.05 ? "（受运力限制）" : "";
}
