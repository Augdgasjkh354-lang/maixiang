// 外贸中小麦与粮券的换算：外镇用小麦结算，我方只有粮券一种货币，所以贸易行与镇库之间按 1 斤 = 1 券换算。
//
//   出口收来的小麦：外镇付的小麦直接进镇库（带成本），镇库券池付粮券给贸易行（townBuysOutsideWheat）。
//                   镇库券池不够时补发缺口——这些小麦已经入库，发行有对应，粮券总账守恒。
//   进口要付的小麦：贸易行用粮券向镇库买（townSellsWheatToOutside），镇库把小麦交给外镇；
//                   镇库小麦不得低于 rules.townWheatReserveDays 天口粮（selectors/production.js 的 townWheatReserveUnits）。
// 镇里自己做外贸（outside-town.js 的手动外贸、trade-agreements.js 的长协）本来就直接用镇库小麦，不经过这里。
import { addTownCostBasis, applyTownCostRemoval, quoteTownCostRemoval } from "./business.js";
import { makeTransactionId, recordLedger } from "./ledger.js";
import { mintTownVouchers, transferVouchers, voucherBalance } from "./currency.js";
import { voucherUnitsForWheatUnits } from "./money-units.js";
import { townWheatReserveUnits } from "../selectors/production.js";

// 镇库可以卖给贸易行的小麦（单位同库存精度）：超出口粮储备线的部分。
export function townSellableWheatUnits(state, content) {
  return Math.max(0, (state.accounts?.town?.wheat || 0) - townWheatReserveUnits(state, content));
}

// 出口：外镇付了 wheatUnits 小麦（来自外镇自己的库存），进镇库；镇库付粮券给 payee（贸易行账户）。
export function townBuysOutsideWheat(state, content, payee, wheatUnits, reason) {
  const units = Math.floor(Number(wheatUnits) || 0);
  if (units <= 0) return { ok: true, wheatUnits: 0, voucherUnits: 0 };
  const voucherUnits = voucherUnitsForWheatUnits(units, content, "floor");
  if (voucherUnits <= 0) return { ok: true, wheatUnits: 0, voucherUnits: 0 };
  const shortfall = voucherUnits - Math.max(0, voucherBalance(state, "town"));
  if (shortfall > 0) {
    const minted = mintTownVouchers(state, shortfall, content, `${reason}；镇库券池不足，按入库小麦补发`);
    if (!minted.ok) return minted;
  }
  const transactionId = makeTransactionId(state);
  const paid = transferVouchers(state, "town", payee, voucherUnits, content, "trade_wheat_purchase", `${reason}；镇库按1斤=1券买下外镇付的小麦`, { transactionId });
  if (!paid.ok) return paid;
  state.accounts.town.wheat = (state.accounts.town.wheat || 0) + units;
  addTownCostBasis(state, "wheat", voucherUnits);
  recordLedger(state, {
    type: "trade_wheat_purchase", transactionId, source: "outside_town", destination: "town", itemId: "wheat",
    quantityUnits: units, qeqUnits: units * content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin,
    reason: `${reason}；外镇付的小麦入镇库`
  }, content);
  return { ok: true, wheatUnits: units, voucherUnits, transactionId };
}

// 进口：贸易行（payer）用粮券向镇库买 wheatUnits 小麦付给外镇。先预检再动账；失败不改任何状态。
export function townSellsWheatToOutside(state, content, payer, wheatUnits, reason) {
  const units = Math.floor(Number(wheatUnits) || 0);
  if (units <= 0) return { ok: true, wheatUnits: 0, voucherUnits: 0 };
  if (units > townSellableWheatUnits(state, content)) return { ok: false, reason: "镇库小麦已到口粮储备线，不能再卖给贸易行" };
  const voucherUnits = voucherUnitsForWheatUnits(units, content, "floor");
  if (voucherUnits <= 0) return { ok: true, wheatUnits: 0, voucherUnits: 0 };
  if (voucherBalance(state, payer) < voucherUnits) return { ok: false, reason: "贸易行粮券不足" };
  const transactionId = makeTransactionId(state);
  const paid = transferVouchers(state, payer, "town", voucherUnits, content, "trade_wheat_sale", `${reason}；贸易行按1斤=1券向镇库买小麦`, { transactionId });
  if (!paid.ok) return paid;
  const quote = quoteTownCostRemoval(state, "wheat", units, content);
  applyTownCostRemoval(state, quote);
  state.accounts.town.wheat -= units;
  recordLedger(state, {
    type: "trade_wheat_sale", transactionId, source: "town", destination: "outside_town", itemId: "wheat",
    quantityUnits: units, qeqUnits: units * content.precision.qeqUnitsPerJin / content.precision.inventoryUnitsPerJin,
    reason: `${reason}；镇库小麦付给外镇`
  }, content);
  return { ok: true, wheatUnits: units, voucherUnits, transactionId };
}
