// 粮券收购的只读视图（政策页卡片与仪表盘共用）。不写 state。
import { currencyScale } from "../economy/currency.js";
import { townSellableWheatUnits } from "../economy/foreign-wheat.js";
import { readVoucherBuybackPolicy, voucherBuybackBankReady } from "../systems/voucher-buyback.js";

function periodView(row = {}, scale, inventoryScale) {
  return {
    voucher: (row.voucherUnits || 0) / scale,
    wheatJin: (row.wheatUnits || 0) / inventoryScale,
    households: row.households || 0
  };
}

export function selectVoucherBuyback(state, content) {
  const policy = readVoucherBuybackPolicy(state);
  const book = state.voucherBuyback || {};
  const scale = currencyScale(content);
  const inventoryScale = content.precision.inventoryUnitsPerJin;
  return {
    enabled: policy.enabled,
    bankReady: voucherBuybackBankReady(state),
    dailyWheatJin: policy.dailyWheatJin,
    wheatPerVoucher: policy.wheatPerVoucher,
    sellShare: content.rules.voucherBuybackSellShare ?? 0.2,
    retentionDays: content.rules.voucherBuybackRetentionDays ?? 30,
    townWheatJin: (state.accounts?.town?.wheat || 0) / inventoryScale,
    townSellableWheatJin: townSellableWheatUnits(state, content) / inventoryScale,
    townVoucher: (state.currency?.balances?.town || 0) / scale,
    error: book.lastError || null,
    day: periodView(book.day, scale, inventoryScale),
    year: periodView(book.year, scale, inventoryScale),
    cumulative: periodView(book.cumulative, scale, inventoryScale)
  };
}
