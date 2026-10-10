// 住户存款的取款原语。放在 economy/ 下，只依赖 households.js、currency.js 与 ledger.js，
// 使 economy/payment.js（付款时自动取款）与 systems/bank.js（存款台账）之间不产生循环引用。
import { syncResidentAggregates } from "../systems/households.js";
import { currencyScale, transferVouchers, voucherBalance } from "./currency.js";
import { recordEvent } from "./ledger.js";

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
    noteBankDebtGrowth(state, content, shortfall, "住户取回存款时银行现金不足");
  }
  bank.deposits[householdId] = deposited - units;
  bank.cashVoucherUnits -= units;
  household.voucherUnits = (household.voucherUnits || 0) + units;
  // 居民汇总粮券是缓存值，改动家庭券后必须同步。
  if (content) syncResidentAggregates(state, content);
  return { ok: true, householdId, voucherUnits: units, advancedUnits: shortfall };
}

// 粮券数量的展示文本：至多两位小数（券面值较大时小额垫付不会被四舍五入成 0）。
export function voucherText(units, scale) {
  return String(Math.round(units / scale * 100) / 100);
}

// 欠镇库增长的事件提示：每年最多一次，写明本次垫付金额与银行欠镇库的累计余额（之后同年的增长不再提示）。
// 调用方须已把垫付额加入 bank.debtToTownUnits。
export function noteBankDebtGrowth(state, content, amount, reason) {
  const bank = state.bank;
  if (!bank || !(amount > 0) || bank.debtNoticeYear === state.year) return;
  bank.debtNoticeYear = state.year;
  const scale = currencyScale(content);
  recordEvent(state, `${reason}，镇库垫付${voucherText(amount, scale)}券，银行欠镇库累计${voucherText((bank.debtToTownUnits || 0), scale)}券（本年仅提示一次）。`, content);
}
