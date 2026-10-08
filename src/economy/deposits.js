// 住户存款的取款原语。放在 economy/ 下，只依赖 households.js，
// 使 economy/payment.js（付款时自动取款）与 systems/bank.js（存款台账）之间不产生循环引用。
import { syncResidentAggregates } from "../systems/households.js";

// 从住户存款取回粮券到住户手上（银行现金同步减少）。
export function withdrawFromBank(state, householdId, voucherUnits, content = null) {
  const units = Math.floor(Number(voucherUnits) || 0);
  if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, reason: "取款金额必须为正整数" };
  const bank = state.bank;
  const deposited = bank?.deposits?.[householdId] || 0;
  if (deposited < units) return { ok: false, reason: "存款余额不足" };
  if ((bank.cashVoucherUnits || 0) < units) return { ok: false, reason: "银行现金不足，暂无法兑付" };
  const household = state.households?.byId?.[householdId];
  if (!household) return { ok: false, reason: "住户不存在" };
  bank.deposits[householdId] = deposited - units;
  bank.cashVoucherUnits -= units;
  household.voucherUnits = (household.voucherUnits || 0) + units;
  // 居民汇总粮券是缓存值，改动家庭券后必须同步。
  if (content) syncResidentAggregates(state, content);
  return { ok: true, householdId, voucherUnits: units };
}
