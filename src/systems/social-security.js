import { currencyScale } from "../economy/currency.js";
import { currentPaymentComposition, maximumPayableValueUnits, normalizePaymentObligation, settleMonetaryPayment } from "../economy/payment.js";
import { makeTransactionId, recordLedger } from "../economy/ledger.js";
import { syncResidentAggregates, householdList, isActiveHousehold } from "./households.js";

// 社保基金：独立钱包（支付账户 "social"），粮券存 cashVoucherUnits、实物小麦存 cashWheatUnits。
// - 收缴：从本日实际发放的工资按人头代扣，家庭 → 基金。
// - 发放：养老金、失业金（基金开启时）由基金支付；基金不足时镇库垫付，垫付额记入基金对国库的负债。
// - 镇库注资同样记为负债；基金可主动还款给镇库。
// - 基金可在交易所买卖上市公司股份（company.fundShares），按持股比例参与年度利润分配。
// - 设置与操作入口在社保局建筑；未建社保局时不能调整，旧档已开启的基金照常运转。

export const SOCIAL_OWNER = "social";
export const DEFAULT_SS_DAILY_JIN = 1;
export const DEFAULT_SS_PENSION_JIN = 2;

export function ensureSocialSecurity(state) {
  state.socialSecurity ||= {};
  const ss = state.socialSecurity;
  ss.enabled ??= false;
  ss.dailyPerWorkerJin ??= DEFAULT_SS_DAILY_JIN;
  ss.pensionPerElderJin ??= DEFAULT_SS_PENSION_JIN;
  ss.cashVoucherUnits ??= 0;
  ss.cashWheatUnits ??= 0;
  ss.debtToTownUnits ??= 0;
  ss.totalInjectedUnits ??= 0;
  ss.totalAdvancedUnits ??= 0;
  ss.totalRepaidUnits ??= 0;
  ss.totalCollectedUnits ??= 0;
  ss.totalPaidUnits ??= 0;
  ss.totalDividendUnits ??= 0;
  return ss;
}

export function hasSocialSecurityOffice(state) {
  return (state.buildings || []).some(building => building.typeId === "social_security_office");
}

function requireOffice(state) {
  return hasSocialSecurityOffice(state) ? null : { ok: false, reason: "需先建成社保局" };
}

// 旧档兼容：早期基金只是镇库里的记账标签（balanceUnits），钱实际在镇库。
// 载入时按标签余额把钱从镇库划入基金钱包（镇库不足时有多少划多少），历史注资计为负债。
export function migrateSocialSecurityWallet(state) {
  const ss = ensureSocialSecurity(state);
  if (ss.balanceUnits === undefined) return;
  const label = Math.max(0, Math.floor(Number(ss.balanceUnits) || 0));
  delete ss.balanceUnits;
  const currency = state.currency;
  const townVouchers = Math.max(0, currency?.balances?.town || 0);
  const fromVouchers = Math.min(label, townVouchers);
  if (fromVouchers > 0) {
    currency.balances.town = townVouchers - fromVouchers;
    ss.cashVoucherUnits += fromVouchers;
  }
  const townWheat = Math.max(0, state.accounts?.town?.wheat || 0);
  const fromWheat = Math.min(label - fromVouchers, townWheat);
  if (fromWheat > 0) {
    state.accounts.town.wheat = townWheat - fromWheat;
    ss.cashWheatUnits += fromWheat;
  }
  ss.debtToTownUnits = Math.max(ss.debtToTownUnits || 0, ss.totalInjectedUnits || 0);
}

export function fundValueUnits(state, content) {
  return maximumPayableValueUnits(state, SOCIAL_OWNER, content);
}

// 政策命令：开关 / 缴费标准 / 养老金标准。
export function setSocialSecurityPolicy(state, patch) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const ss = ensureSocialSecurity(state);
  if (patch.enabled !== undefined) ss.enabled = Boolean(patch.enabled);
  if (patch.dailyPerWorkerJin !== undefined) {
    const value = Number(patch.dailyPerWorkerJin);
    if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "每日缴费须为有限的非负数" };
    ss.dailyPerWorkerJin = value;
  }
  if (patch.pensionPerElderJin !== undefined) {
    const value = Number(patch.pensionPerElderJin);
    if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "养老金须为有限的非负数" };
    ss.pensionPerElderJin = value;
  }
  return { ok: true, socialSecurity: { enabled: ss.enabled, dailyPerWorkerJin: ss.dailyPerWorkerJin, pensionPerElderJin: ss.pensionPerElderJin } };
}

// 镇库注资：真实转账到基金钱包，并记为基金欠国库的负债。
export function injectSocialSecurity(state, amountJin, content) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const ss = ensureSocialSecurity(state);
  const requested = Math.round(Math.max(0, Number(amountJin) || 0) * currencyScale(content));
  if (!Number.isSafeInteger(requested) || requested <= 0) return { ok: false, reason: "注资金额必须大于0" };
  const amount = Math.min(requested, maximumPayableValueUnits(state, "town", content));
  if (amount <= 0) return { ok: false, reason: "镇库可用资金不足" };
  const result = settleMonetaryPayment(state, "town", SOCIAL_OWNER, currentPaymentComposition(state, amount), content,
    "social_security_inject", "镇库向社保基金注资（计为基金负债）", { requireFull: false });
  const paid = result.paidValueUnits || 0;
  if (paid <= 0) return { ok: false, reason: result.reason || "注资失败" };
  ss.totalInjectedUnits += paid;
  ss.debtToTownUnits += paid;
  return { ok: true, injectedValueUnits: paid, injectedJin: paid / currencyScale(content) };
}

// 基金还款给镇库：最多还清负债。
export function repaySocialSecurityDebt(state, amountJin, content) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const ss = ensureSocialSecurity(state);
  if ((ss.debtToTownUnits || 0) <= 0) return { ok: false, reason: "基金没有欠国库的钱" };
  const requested = Math.round(Math.max(0, Number(amountJin) || 0) * currencyScale(content));
  if (!Number.isSafeInteger(requested) || requested <= 0) return { ok: false, reason: "还款金额必须大于0" };
  const amount = Math.min(requested, ss.debtToTownUnits, fundValueUnits(state, content));
  if (amount <= 0) return { ok: false, reason: "基金可用资金不足" };
  const result = settleMonetaryPayment(state, SOCIAL_OWNER, "town", currentPaymentComposition(state, amount), content,
    "social_security_repay", "社保基金向镇库还款", { requireFull: false });
  const paid = result.paidValueUnits || 0;
  if (paid <= 0) return { ok: false, reason: result.reason || "还款失败" };
  ss.debtToTownUnits = Math.max(0, ss.debtToTownUnits - paid);
  ss.totalRepaidUnits += paid;
  return { ok: true, repaidValueUnits: paid, repaidJin: paid / currencyScale(content), debtJin: ss.debtToTownUnits / currencyScale(content) };
}

// 基金向家庭付款：基金先付，不足部分镇库垫付并记为基金负债。
export function payFromFund(state, householdId, dueUnits, content, type, reason) {
  const ss = ensureSocialSecurity(state);
  const target = `household:${householdId}`;
  const fundResult = settleMonetaryPayment(state, SOCIAL_OWNER, target, currentPaymentComposition(state, dueUnits), content,
    type, reason, { requireFull: false });
  const fromFund = fundResult.paidValueUnits || 0;
  let fromTown = 0;
  if ((fundResult.remainingValueUnits || 0) > 0) {
    const townResult = settleMonetaryPayment(state, "town", target, normalizePaymentObligation(fundResult.remainingComposition, state), content,
      type, `${reason}（镇库垫付，计入基金负债）`, { requireFull: false });
    fromTown = townResult.paidValueUnits || 0;
    ss.debtToTownUnits += fromTown;
    ss.totalAdvancedUnits += fromTown;
  }
  ss.totalPaidUnits += fromFund + fromTown;
  return { paidValueUnits: fromFund + fromTown, fromFund, fromTown };
}

// 救济口粮由镇库实物拨付；基金开启时按口粮价值向镇库结算，付不起的部分计入基金负债。
export function chargeFundForRelief(state, valueUnits, content) {
  const ss = ensureSocialSecurity(state);
  if (!ss.enabled || valueUnits <= 0) return { fromFund: 0, owed: 0 };
  const result = settleMonetaryPayment(state, SOCIAL_OWNER, "town", currentPaymentComposition(state, valueUnits), content,
    "relief_reimbursement", "社保基金承担救济口粮", { requireFull: false });
  const fromFund = result.paidValueUnits || 0;
  const owed = Math.max(0, valueUnits - fromFund);
  ss.debtToTownUnits += owed;
  ss.totalAdvancedUnits += owed;
  ss.totalPaidUnits += valueUnits;
  return { fromFund, owed };
}

// 工资代扣：payDailyWages 在发放完毕后调用。
export function collectSocialContributions(state, workerPay, currentPaidByKey, paidByHousehold, content) {
  const ss = ensureSocialSecurity(state);
  if (!ss.enabled) return { collected: 0 };
  const perWorker = Math.round(Math.max(0, Number(ss.dailyPerWorkerJin) || 0) * currencyScale(content));
  if (perWorker <= 0) return { collected: 0 };
  let collected = 0;
  for (const row of workerPay) {
    const payable = row.payable || 0;
    const currentPaid = currentPaidByKey[row.payrollKey] || 0;
    if (payable <= 0 || currentPaid <= 0 || !(row.count > 0)) continue;
    // 按本日工资实际发放比例折算缴费人数。
    const contribTotal = Math.round(row.count * Math.min(1, currentPaid / payable) * perWorker);
    if (contribTotal <= 0) continue;
    const paidRows = paidByHousehold[row.payrollKey] || {};
    const paidTotal = Object.values(paidRows).reduce((sum, value) => sum + (value || 0), 0);
    if (paidTotal <= 0) continue;
    for (const [householdId, hpaid] of Object.entries(paidRows)) {
      const share = Math.round(contribTotal * (hpaid || 0) / paidTotal);
      const household = state.households?.byId?.[householdId];
      if (share <= 0 || !household) continue;
      const result = settleMonetaryPayment(state, `household:${householdId}`, SOCIAL_OWNER,
        currentPaymentComposition(state, share), content,
        "social_security_contribution", `${household.name}缴纳社保（从工资代扣）`, { requireFull: false });
      collected += result.paidValueUnits || 0;
    }
  }
  ss.totalCollectedUnits += collected;
  if (collected > 0) syncResidentAggregates(state, content);
  return { collectedValueUnits: collected };
}

// 每日养老金：按老人人数发到所在家庭。
export function payPensions(state, content) {
  const ss = ensureSocialSecurity(state);
  if (!ss.enabled) return { paid: 0 };
  const perElder = Math.round(Math.max(0, Number(ss.pensionPerElderJin) || 0) * currencyScale(content));
  if (perElder <= 0) return { paid: 0 };
  let paid = 0;
  let fromFund = 0;
  let due = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const elders = Math.max(0, household.ageBands?.elders || 0);
    if (elders <= 0) continue;
    due += elders * perElder;
    const result = payFromFund(state, household.id, elders * perElder, content, "pension_payment", `社保基金发放养老金${elders}位老人`);
    paid += result.paidValueUnits;
    fromFund += result.fromFund;
  }
  if (paid > 0) {
    recordLedger(state, {
      type: "pension_payment", transactionId: makeTransactionId(state), source: "social_security_fund", destination: "residents",
      itemId: "money_value", quantityUnits: paid, qeqUnits: 0,
      reason: `本日发放养老金${paid}小麦等值单位（基金承担${fromFund}，镇库垫付${paid - fromFund}）`
    }, content);
    syncResidentAggregates(state, content);
  }
  return { paidValueUnits: paid, fromFundValueUnits: fromFund, dueValueUnits: due };
}

// ---------------------------------------------------------------- 股票

function listedCompany(state, companyId) {
  const company = state.companies?.[companyId];
  if (!company?.listing?.listed) return null;
  company.fundShares ??= 0;
  return company;
}

// 从镇库做市池按实时股价买入。
export function fundBuyShares(state, companyId, shares, content) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const company = listedCompany(state, companyId);
  if (!company) return { ok: false, reason: "公司未上市" };
  const count = Math.floor(Number(shares) || 0);
  if (count <= 0) return { ok: false, reason: "股数须大于0" };
  const price = company.sharePriceVoucherUnits || company.shareSale?.sharePriceVoucherUnits || 0;
  if (!(price > 0)) return { ok: false, reason: "暂无股价" };
  const available = (company.townShares || 0) - (company.shareSale?.offeredShares || 0);
  if (count > available) return { ok: false, reason: `镇库可售仅${Math.max(0, available)}股` };
  const cost = count * price;
  if (cost > fundValueUnits(state, content)) return { ok: false, reason: "基金资金不足" };
  const result = settleMonetaryPayment(state, SOCIAL_OWNER, "town", currentPaymentComposition(state, cost), content,
    "social_share_buy", `社保基金买入${company.name}${count}股`, { requireFull: true });
  if (!result.ok) return { ok: false, reason: result.reason || "支付失败" };
  company.townShares -= count;
  company.fundShares += count;
  return { ok: true, shares: count, costVoucherUnits: cost };
}

// 按实时股价卖回镇库。
export function fundSellShares(state, companyId, shares, content) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const company = listedCompany(state, companyId);
  if (!company) return { ok: false, reason: "公司未上市" };
  const count = Math.floor(Number(shares) || 0);
  if (count <= 0) return { ok: false, reason: "股数须大于0" };
  if (count > (company.fundShares || 0)) return { ok: false, reason: `基金仅持有${company.fundShares || 0}股` };
  const price = company.sharePriceVoucherUnits || company.shareSale?.sharePriceVoucherUnits || 0;
  if (!(price > 0)) return { ok: false, reason: "暂无股价" };
  const proceeds = count * price;
  const result = settleMonetaryPayment(state, "town", SOCIAL_OWNER, currentPaymentComposition(state, proceeds), content,
    "social_share_sell", `社保基金卖出${company.name}${count}股给镇库`, { requireFull: true });
  if (!result.ok) return { ok: false, reason: result.reason || "镇库资金不足，无法回购" };
  company.fundShares -= count;
  company.townShares += count;
  return { ok: true, shares: count, proceedsVoucherUnits: proceeds };
}

export function recordFundDividend(state, units) {
  ensureSocialSecurity(state).totalDividendUnits += Math.max(0, units || 0);
}

export function selectSocialSecurityStats(state, content) {
  const ss = state.socialSecurity || {};
  const scale = currencyScale(content);
  const wheatScale = content.precision.inventoryUnitsPerJin;
  const jin = value => (value || 0) / scale;
  const holdings = Object.values(state.companies || {})
    .filter(company => company.listing?.listed)
    .map(company => {
      const price = company.sharePriceVoucherUnits || company.shareSale?.sharePriceVoucherUnits || 0;
      return {
        companyId: company.id, name: company.name, shares: company.fundShares || 0,
        priceJin: price / scale, valueJin: (company.fundShares || 0) * price / scale,
        townAvailable: Math.max(0, (company.townShares || 0) - (company.shareSale?.offeredShares || 0))
      };
    });
  return {
    hasOffice: hasSocialSecurityOffice(state),
    enabled: Boolean(ss.enabled),
    dailyPerWorkerJin: ss.dailyPerWorkerJin ?? DEFAULT_SS_DAILY_JIN,
    pensionPerElderJin: ss.pensionPerElderJin ?? DEFAULT_SS_PENSION_JIN,
    cashJin: jin(ss.cashVoucherUnits) + (ss.cashWheatUnits || 0) / wheatScale,
    voucherJin: jin(ss.cashVoucherUnits),
    wheatJin: (ss.cashWheatUnits || 0) / wheatScale,
    debtJin: jin(ss.debtToTownUnits),
    stockValueJin: holdings.reduce((sum, row) => sum + row.valueJin, 0),
    holdings,
    totalInjectedJin: jin(ss.totalInjectedUnits),
    totalAdvancedJin: jin(ss.totalAdvancedUnits),
    totalRepaidJin: jin(ss.totalRepaidUnits),
    totalCollectedJin: jin(ss.totalCollectedUnits),
    totalPaidJin: jin(ss.totalPaidUnits),
    totalDividendJin: jin(ss.totalDividendUnits)
  };
}
