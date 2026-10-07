import { currencyScale } from "../economy/currency.js";
import { currentPaymentComposition, maximumPayableValueUnits, settleMonetaryPayment } from "../economy/payment.js";
import { recordEvent } from "../economy/ledger.js";
import { householdList, isActiveHousehold } from "./households.js";
import { consumeHouseholdStockBudget } from "./investment-preference.js";
import { companyActualProfitValuation } from "./companies.js";
import { nextRandom } from "../core/random.js";

// 上市默认总股本（金融扩展四期）：10 万股，取最接近且能被公司级数整除的值。
export const DEFAULT_TOTAL_SHARES = 100000;
// 股价每日波动：向利润锚均值回归系数、噪声幅度、单日涨跌幅钳制。
export const SHARE_PRICE_REVERSION = 0.08;
export const SHARE_PRICE_NOISE_DAILY = 0.02;
export const SHARE_PRICE_DAILY_LIMIT = 0.1;

export function hasStockExchange(state) {
  return (state.buildings || []).some(row => row.typeId === "stock_exchange") || Boolean(state.stockExchange?.legacyAccess);
}

export function ensureStockExchangeState(state) {
  state.stockExchange ||= { legacyAccess: false, rotation: 0 };
  state.stockExchange.rotation ||= 0;
  return state.stockExchange;
}

export function nearbyDivisibleShareCounts(levels, requested) {
  const n = Math.max(1, Math.floor(Number(levels) || 1));
  const value = Math.max(n, Math.floor(Number(requested) || n));
  const lower = Math.max(n, Math.floor(value / n) * n);
  const upper = Math.max(n, Math.ceil(value / n) * n);
  return [...new Set([lower, upper, Math.max(n, lower - n), upper + n])].sort((a, b) => Math.abs(a - value) - Math.abs(b - value) || a - b).slice(0, 3);
}

function listingGate(state) {
  if (!hasStockExchange(state)) return "尚未建成交易所";
  if (state.monetaryReform?.stage !== "voucher") return "须先完成货币改革，上市与股票交易只使用粮券";
  return null;
}

export function listCompanyOnExchange(state, companyId, options, content) {
  ensureStockExchangeState(state);
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "公司不存在" };
  const gate = listingGate(state);
  if (gate) return { ok: false, reason: gate };
  if (company.listing?.listed) return { ok: false, reason: "公司已经上市；再次售股沿用现有总股本" };
  const ticker = String(options?.ticker ?? "").trim();
  if (!/^\d{3}$/.test(ticker)) return { ok: false, reason: "股票代码必须是三位数字，可保留前导零" };
  if (Object.values(state.companies || {}).some(other => other.id !== companyId && other.listing?.ticker === ticker)) return { ok: false, reason: "股票代码已被使用" };
  const requestedShares = Math.floor(Number(options?.totalShares) || 0);
  const levels = company.listedLevels;
  // 未指定时默认 10 万股（取最接近且能被级数整除的值）
  const totalShares = requestedShares > 0
    ? requestedShares
    : nearbyDivisibleShareCounts(levels, DEFAULT_TOTAL_SHARES)[0];
  if (!Number.isSafeInteger(totalShares) || totalShares <= 0) return { ok: false, reason: "总股本必须为正整数" };
  if (totalShares % levels !== 0) {
    return { ok: false, reason: `总股本必须能被公司${levels}级整除`, nearby: nearbyDivisibleShareCounts(levels, totalShares) };
  }
  const priceUnits = Math.round(Number(options?.priceVoucherPerShare) * currencyScale(content));
  const offeredShares = Math.floor(Number(options?.offeredShares) || 0);
  if (!Number.isSafeInteger(priceUnits) || priceUnits <= 0) return { ok: false, reason: "每股价格必须大于0" };
  if (!Number.isSafeInteger(offeredShares) || offeredShares < 0 || offeredShares > totalShares) return { ok: false, reason: "本次出售股数不能超过镇库持股" };

  company.totalShares = totalShares;
  company.townShares = totalShares;
  company.residentShares = 0;
  company.householdShares = {};
  company.listing = { listed: true, ticker, listedAt: { year: state.year, day: Math.min(content.rules.daysPerYear, state.day + 1) } };
  // 实时股价（金融扩展四期）：挂牌价起步，每日向利润锚波动
  company.sharePriceVoucherUnits = priceUnits;
  company.sharePriceHistory = [priceUnits];
  company.shareSale ||= {};
  company.shareSale.offeredShares = offeredShares;
  company.shareSale.sharePriceVoucherUnits = priceUnits;
  company.shareSale.cumulativeProceedsVoucherUnits ||= 0;
  company.shareSale.lastSaleVoucherUnits ||= 0;
  company.shareSale.lastSoldShares ||= 0;
  recordEvent(state, `${company.name}（${ticker}）在交易所挂牌，总股本${totalShares.toLocaleString("zh-CN")}股；挂牌不代表已全部售出。`, content, { day: state.day + 1 });
  return { ok: true, ticker, totalShares, offeredShares, priceVoucherUnits: priceUnits, townShares: totalShares };
}

export function configureListedShareOffer(state, companyId, offeredShares, priceVoucherPerShare, content) {
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "公司不存在" };
  const gate = listingGate(state);
  if (gate) return { ok: false, reason: gate };
  if (!company.listing?.listed) return { ok: false, reason: "公司尚未上市" };
  const shares = Math.floor(Number(offeredShares) || 0);
  const priceUnits = Math.round(Number(priceVoucherPerShare) * currencyScale(content));
  if (shares < 0 || shares > company.townShares) return { ok: false, reason: "出售股数不能超过镇库持股" };
  if (!Number.isSafeInteger(priceUnits) || priceUnits <= 0) return { ok: false, reason: "每股售价须大于0" };
  company.shareSale.offeredShares = shares;
  company.shareSale.sharePriceVoucherUnits = priceUnits;
  return { ok: true, offeredShares: shares, priceVoucherUnits: priceUnits };
}

export function stockReference(state, company, content) {
  const scale = currencyScale(content);
  const profit = companyActualProfitValuation(state, company, content);
  const basisUnits = profit.referenceCompanyValueVoucherUnits || 0;
  return {
    ...profit,
    bookAssetsVoucherUnits: 0,
    referenceCompanyValueVoucherUnits: basisUnits,
    referencePerShareVoucherUnits: company.totalShares > 0 ? Math.floor(basisUnits / company.totalShares) : 0,
    basis: profit.validProfitMethod
      ? `最近${profit.observedDays}个日历日真实净利润与投入资本利润率统一估值；停工日计入观察窗口`
      : (profit.observedDays > 0 ? `${profit.performanceStatus || "观察中"}；库存不计入公司估值` : "暂无业绩；库存不计入公司估值"),
    scale
  };
}

export function previewTownBuyback(state, companyId, options, content) {
  const company = state.companies?.[companyId];
  if (!company) return { available: false, reason: "公司不存在" };
  const gate = listingGate(state);
  if (gate) return { available: false, reason: gate };
  if (!company.listing?.listed) return { available: false, reason: "公司尚未上市" };
  const requestedShares = Math.max(0, Math.floor(Number(options?.shares) || 0));
  const priceUnits = Math.round(Number(options?.priceVoucherPerShare) * currencyScale(content));
  if (!requestedShares || !Number.isSafeInteger(priceUnits) || priceUnits <= 0) return { available: false, reason: "请输入回购股数和正的每股价格" };
  const reference = stockReference(state, company, content);
  const willing = [];
  let willingShares = 0;
  // 无人家庭仍是合法资产账户；人口归零不能让既有股份失去回购/清算出口。
  for (const household of householdList(state)) {
    const shares = Math.max(0, company.householdShares?.[household.id] || 0);
    if (!shares) continue;
    // 自愿出售：报价不低于统一业绩估值参考；暂无业绩时参考价为0。
    if (priceUnits >= reference.referencePerShareVoucherUnits) {
      willing.push({ householdId: household.id, shares });
      willingShares += shares;
    }
  }
  const affordableShares = Math.floor(maximumPayableValueUnits(state, "town", content) / priceUnits);
  const executableShares = Math.min(requestedShares, willingShares, affordableShares);
  return {
    available: executableShares > 0,
    reason: executableShares > 0 ? null : willingShares <= 0 ? "当前回购价下没有居民自愿出售" : "镇库粮券不足",
    requestedShares, priceVoucherUnits: priceUnits, willingShares, affordableShares, executableShares,
    costVoucherUnits: executableShares * priceUnits, reference
  };
}

export function executeTownBuyback(state, companyId, options, content) {
  const company = state.companies?.[companyId];
  const preview = previewTownBuyback(state, companyId, options, content);
  if (!company || !preview.available) return { ok: false, reason: preview.reason || "当前无可回购股份", preview };
  let left = preview.executableShares;
  let paid = 0;
  const sellers = [];
  const rows = householdList(state)
    .filter(h => (company.householdShares?.[h.id] || 0) > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const start = ensureStockExchangeState(state).rotation % Math.max(1, rows.length);
  const ordered = rows.slice(start).concat(rows.slice(0, start));
  for (const household of ordered) {
    if (left <= 0) break;
    const held = company.householdShares?.[household.id] || 0;
    if (held <= 0) continue;
    if (preview.priceVoucherUnits < preview.reference.referencePerShareVoucherUnits) continue;
    const shares = Math.min(held, left);
    const cost = shares * preview.priceVoucherUnits;
    const payment = settleMonetaryPayment(state, "town", `household:${household.id}`, currentPaymentComposition(state, cost), content,
      "town_share_buyback", `镇库回购${company.name}股份`, { requireFull: true });
    if (!payment.ok) break;
    company.householdShares[household.id] -= shares;
    if (company.householdShares[household.id] <= 0) delete company.householdShares[household.id];
    household.shares ||= {};
    household.shares[company.id] = Math.max(0, (household.shares[company.id] || 0) - shares);
    if (household.shares[company.id] <= 0) delete household.shares[company.id];
    company.residentShares -= shares;
    company.townShares += shares;
    left -= shares;
    paid += cost;
    sellers.push({ householdId: household.id, shares, voucherUnits: cost });
  }
  ensureStockExchangeState(state).rotation = rows.length ? (start + 1) % rows.length : 0;
  const boughtShares = preview.executableShares - left;
  if (boughtShares <= 0) return { ok: false, reason: "回购未成交", preview };
  recordEvent(state, `镇库以玩家定价回购${company.name}${boughtShares.toLocaleString("zh-CN")}股。`, content, { day: state.day + 1 });
  return { ok: true, boughtShares, paidVoucherUnits: paid, sellers, preview };
}

// 每日股价结算（金融扩展四期）：AI 做市商。
// 每只上市股票的价格每天向利润锚（统一业绩估值）均值回归，叠加 ±2% 噪声，
// 单日涨跌幅钳制 ±10%，最低 1 单位。用种子随机数保证模拟可复现。
export function settleStockMarketDay(state, content) {
  if (!hasStockExchange(state)) return null;
  const moved = [];
  for (const company of Object.values(state.companies || {})) {
    if (!company.listing?.listed || !(company.totalShares > 0)) continue;
    // 老存档兼容：没有实时股价时用挂牌价起步
    company.sharePriceVoucherUnits ||= company.shareSale?.sharePriceVoucherUnits || 0;
    const current = company.sharePriceVoucherUnits;
    if (!(current > 0)) continue;
    const reference = stockReference(state, company, content).referencePerShareVoucherUnits || 0;
    const anchor = reference > 0 ? reference : current;
    const reverted = current + (anchor - current) * SHARE_PRICE_REVERSION;
    const noised = reverted * (1 + (nextRandom(state) * 2 - 1) * SHARE_PRICE_NOISE_DAILY);
    const lo = Math.floor(current * (1 - SHARE_PRICE_DAILY_LIMIT));
    const hi = Math.ceil(current * (1 + SHARE_PRICE_DAILY_LIMIT));
    const next = Math.min(hi, Math.max(Math.max(1, lo), Math.floor(noised)));
    company.sharePriceVoucherUnits = next;
    if (!Array.isArray(company.sharePriceHistory)) company.sharePriceHistory = [];
    company.sharePriceHistory.push(next);
    if (company.sharePriceHistory.length > 30) company.sharePriceHistory.shift();
    if (next !== current) moved.push({ companyId: company.id, from: current, to: next });
  }
  return moved.length ? { moved } : null;
}

// 住户日常股票买入：按投资倾向把本日股票预算分散买入镇库做市的股份。
// - 买入对象：已上市、镇库有可售股份（扣除 IPO 发行池）的公司，按实时股价成交
// - 预算：household.stockBuyBudgetVoucherUnits（银行分流后写入）或无银行时现算
// - 付款：住户 → 镇库（镇库做市），沿用认购的支付口径；付不起就跳过
export function settleHouseholdStockBuying(state, content) {
  if (!hasStockExchange(state)) return null;
  const listed = Object.values(state.companies || {}).filter(company =>
    company.listing?.listed && (company.sharePriceVoucherUnits || 0) > 0 &&
    (company.townShares || 0) - (company.shareSale?.offeredShares || 0) > 0);
  if (!listed.length) return null;
  let totalShares = 0;
  let totalSpentUnits = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const budget = consumeHouseholdStockBudget(state, content, household);
    if (budget <= 0) continue;
    const perCompany = Math.floor(budget / listed.length);
    if (perCompany <= 0) continue;
    for (const company of listed) {
      const available = (company.townShares || 0) - (company.shareSale?.offeredShares || 0);
      if (available <= 0) continue;
      const priceUnits = company.sharePriceVoucherUnits;
      const shares = Math.min(available, Math.floor(perCompany / priceUnits));
      if (shares <= 0) continue;
      const cost = shares * priceUnits;
      const payment = settleMonetaryPayment(state, `household:${household.id}`, "town",
        currentPaymentComposition(state, cost), content, "share_market_buy",
        `${household.name}二级市场买入${company.name}${shares}股`, { requireFull: true });
      if (!payment.ok) continue;
      company.townShares -= shares;
      company.residentShares = (company.residentShares || 0) + shares;
      company.householdShares ||= {};
      company.householdShares[household.id] = (company.householdShares[household.id] || 0) + shares;
      household.shares ||= {};
      household.shares[company.id] = (household.shares[company.id] || 0) + shares;
      totalShares += shares;
      totalSpentUnits += cost;
    }
  }
  return totalShares > 0 ? { shares: totalShares, spentVoucherUnits: totalSpentUnits } : null;
}
