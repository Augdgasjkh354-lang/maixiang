// 住户存款的取款原语。放在 economy/ 下，只依赖 households.js 与 currency.js，
// 使 economy/payment.js（付款时自动取款）与 systems/bank.js（存款台账）之间不产生循环引用。
import { syncResidentAggregates } from "../systems/households.js";
import { transferVouchers, voucherBalance } from "./currency.js";

// 从住户存款取回粮券到住户手上。
// 银行现金不够时，缺口由镇库垫付（镇库 −X、银行现金 +X，类型 bank_town_advance），计为银行欠镇库的债
// （bank.debtToTownUnits / totalAdvancedUnits），随后取款（银行现金 −X、住户 +X）。
// 镇库粮券也不够垫付时整笔拒绝，不做任何改动。所有取回存款的真实扣款都经过这里。
export function withdrawFromBank(state, householdId, voucherUnits, content = null) {
  const units = Math.floor(Number(voucherUnits) || 0);
  if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, reason: "取款金额必须为正整数" };
  const bank = state.bank;
  const deposited = bank?.deposits?.[householdId] || 0;
  if (deposited < units) return { ok: false, reason: "存款余额不足" };
  const household = state.households?.byId?.[householdId];
  if (!household) return { ok: false, reason: "住户不存在" };
  const cash = Math.max(0, bank.cashVoucherUnits || 0);
  const shortfall = Math.max(0, units - cash);
  if (shortfall > Math.max(0, voucherBalance(state, "town"))) {
    return { ok: false, reason: "银行现金不足，镇库垫付也不够，暂无法兑付" };
  }
  if (shortfall > 0) {
    const advance = transferVouchers(state, "town", "bank", shortfall, content, "bank_town_advance",
      "镇库垫付银行取款缺口，计入银行负债");
    if (!advance.ok) return { ok: false, reason: "镇库垫付失败：" + advance.reason };
    bank.debtToTownUnits = (bank.debtToTownUnits || 0) + shortfall;
    bank.totalAdvancedUnits = (bank.totalAdvancedUnits || 0) + shortfall;
  }
  bank.deposits[householdId] = deposited - units;
  bank.cashVoucherUnits -= units;
  household.voucherUnits = (household.voucherUnits || 0) + units;
  // 居民汇总粮券是缓存值，改动家庭券后必须同步。
  if (content) syncResidentAggregates(state, content);
  return { ok: true, householdId, voucherUnits: units, advancedUnits: shortfall };
}
