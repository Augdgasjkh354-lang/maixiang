import { currencyScale, shareTick, roundToShareTick } from "../economy/currency.js";
import { currentPaymentComposition, maximumPayableValueUnits, settleMonetaryPayment } from "../economy/payment.js";
import { recordEvent } from "../economy/ledger.js";
import { householdList, isActiveHousehold } from "./households.js";
import { consumeHouseholdStockBudget } from "./investment-preference.js";
import { companyActualProfitValuation, offerSeller, offeredPoolShares, sellerHoldingShares, stockFairValueUnits } from "./companies.js";
import { selectOperatingRightPreview } from "../selectors/operating-rights.js";
import { buildingMaterialValueUnits } from "./ownership.js";
import { nextRandom } from "../core/random.js";

// 发行池的卖方与可售股数口径在 companies.js（offerSeller / sellerHoldingShares / offeredPoolShares），这里转出供本模块与外部使用。
export { offerSeller, offeredPoolShares, sellerHoldingShares };

// 上市默认总股本：2520 股（1—10 级都能整除）。股价按 0.01 粮券一档报价，股数太多每股价会低到一两档，涨跌就没有层次。
export const DEFAULT_TOTAL_SHARES = 2520;
// 股价单日涨跌幅上限（一档价不足 20% 时至少允许动一档）。
export const SHARE_PRICE_DAILY_LIMIT = 0.2;
// 股价模型参数：常态向业绩锚缓慢回拢并带惯性；偶发泡沫（脱离业绩持续上涨）→ 破裂后急跌 → 回到常态。
export const STOCK_MARKET = {
  reversion: 0.025,        // 常态：每天向业绩锚回拢缺口的比例（慢，泡沫期不回拢）
  momentumCarry: 0.35,     // 常态：昨日涨跌的惯性
  momentumDecay: 0.7,      // 惯性的指数平滑
  noise: 0.022,            // 常态日波动
  sentimentDrift: 0.0035,  // 市场情绪（-1—1）对日涨跌的推力
  bubbleStartDaily: 0.0018, // 常态每天进入泡沫的基础概率，情绪高涨时放大
  bubbleStartMaxGap: 0.35, // 价格已高出业绩锚 e^0.35 倍以上不再新起泡沫
  bubbleDriftMin: 0.012, bubbleDriftSpan: 0.02, // 泡沫期日均涨幅 1.2%—3.2%
  bubbleNoise: 0.035,
  bubbleMinDays: 25, bubbleSpanDays: 50,
  burstBase: 0.01, burstPerGap: 0.4, burstGapStart: 0.5, // 价格越过业绩锚越多，每天破裂概率越大
  crashDriftMin: 0.02, crashDriftSpan: 0.03, crashNoise: 0.05, // 破裂期日均跌幅 2%—5%，单日可近 20%
  crashMinDays: 8, crashSpanDays: 14,
  crashEndGap: 0.05        // 跌回业绩锚附近即结束
};

// 股价一档 = 0.01 粮券（shareTick / roundToShareTick 在 economy/currency.js）。
export { shareTick, roundToShareTick };

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

export function listingGate(state) {
  if (!hasStockExchange(state)) return "尚未建成交易所";
  return null;
}

// 建议每股价 = 整栋估值 ÷ 总股本（经营权估值口径），单位粮券，保留两位小数，不低于 0.01。
export function suggestedSharePriceVoucher(valuationVoucher, totalShares) {
  const perShare = totalShares > 0 ? (Number(valuationVoucher) || 0) / totalShares : 0;
  return Math.max(0.01, Math.round(perShare * 100) / 100);
}

// 整栋估值（粮券）：与经营权选择器同一口径。
export function buildingValuationVoucher(state, buildingId, content) {
  if (!buildingId) return 0;
  const value = Number(selectOperatingRightPreview(state, buildingId, content).valuationWheatJin);
  if (Number.isFinite(value) && value > 0) return value;
  // 新建筑还没有经营记录、估值为 0 时，按建造与升级材料的当前价值估，避免挂牌价落到最低一档。
  const building = (state.buildings || []).find(row => row.id === buildingId);
  return building ? buildingMaterialValueUnits(state, building, content) / currencyScale(content) : 0;
}

// 下一个空闲股票代码（001 起，已被其他上市公司占用的跳过）。
export function freeTicker(state, exceptCompanyId = null) {
  const used = new Set(Object.values(state.companies || {})
    .filter(company => company.id !== exceptCompanyId)
    .map(company => company.listing?.ticker)
    .filter(Boolean));
  for (let n = 1; n <= 999; n += 1) {
    const ticker = String(n).padStart(3, "0");
    if (!used.has(ticker)) return ticker;
  }
  return null;
}

// 挂牌条款（整栋上市与老公司挂牌共用）：代码、总股本、卖出股数、每股价。只校验，不改状态。
// input: { companyId?, buildingId, levels, ticker?, totalShares?, offerPercent?, offeredShares?, priceVoucherPerShare? }
// - 代码缺省取第一个空闲代码；总股本缺省 10 万股（取最接近且能被级数整除的值）。
// - 卖出：offeredShares（绝对股数）优先；否则按 offerPercent（缺省 rules.ipoDefaultOfferPercent，即 49%）。
// - 每股价缺省 = 整栋估值 ÷ 总股本；一律取 0.01 粮券的整数倍。
export function resolveListingTerms(state, input, content) {
  const companyId = input.companyId || null;
  const levels = Math.max(1, Math.floor(Number(input.levels) || 1));
  const tickerInput = input.ticker == null ? "" : String(input.ticker).trim();
  const ticker = tickerInput || freeTicker(state, companyId);
  if (!ticker) return { ok: false, reason: "没有空闲的股票代码" };
  if (!/^\d{3}$/.test(ticker)) return { ok: false, reason: "股票代码必须是三位数字，可保留前导零" };
  if (Object.values(state.companies || {}).some(other => other.id !== companyId && other.listing?.ticker === ticker)) return { ok: false, reason: "股票代码已被使用" };
  const requestedShares = Math.floor(Number(input.totalShares) || 0);
  const totalShares = requestedShares > 0 ? requestedShares : nearbyDivisibleShareCounts(levels, DEFAULT_TOTAL_SHARES)[0];
  if (!Number.isSafeInteger(totalShares) || totalShares <= 0) return { ok: false, reason: "总股本必须为正整数" };
  if (totalShares % levels !== 0) {
    return { ok: false, reason: `总股本必须能被公司${levels}级整除`, nearby: nearbyDivisibleShareCounts(levels, totalShares) };
  }
  const hasPrice = input.priceVoucherPerShare !== undefined && input.priceVoucherPerShare !== null && input.priceVoucherPerShare !== "";
  const priceVoucher = hasPrice ? Number(input.priceVoucherPerShare) : suggestedSharePriceVoucher(buildingValuationVoucher(state, input.buildingId, content), totalShares);
  if (!Number.isFinite(priceVoucher) || priceVoucher <= 0) return { ok: false, reason: "每股价格必须大于0" };
  const priceUnits = roundToShareTick(priceVoucher * currencyScale(content), content);
  if (!Number.isSafeInteger(priceUnits)) return { ok: false, reason: "每股价格必须大于0" };
  let offeredShares;
  if (input.offeredShares !== undefined && input.offeredShares !== null) {
    offeredShares = Math.floor(Number(input.offeredShares) || 0);
  } else {
    const percent = Number(input.offerPercent ?? content.rules.ipoDefaultOfferPercent ?? 49);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return { ok: false, reason: "卖出比例须在0%—100%之间" };
    offeredShares = Math.floor(totalShares * percent / 100);
  }
  if (!Number.isSafeInteger(offeredShares) || offeredShares < 0 || offeredShares > totalShares) return { ok: false, reason: "本次出售股数不能超过总股本" };
  return { ok: true, ticker, totalShares, offeredShares, priceUnits };
}

// 挂牌的共同写入：全部股份先记在卖方名下（镇库或业主家庭）；发行池 offeredShares 是其中挂出的部分。
// 售出后卖方保留其余股份（例如 49% 卖出后镇库或业主保留 51%）。
// seller = { kind: "town" } 或 { kind: "household", householdId }。调用前须已通过 resolveListingTerms。
export function applyCompanyListing(state, company, terms, seller, content) {
  const { ticker, totalShares, offeredShares, priceUnits } = terms;
  company.totalShares = totalShares;
  company.fundShares = 0;
  company.townShares = 0;
  company.residentShares = 0;
  company.householdShares = {};
  if (seller.kind === "household") {
    const household = state.households.byId[seller.householdId];
    company.householdShares = { [seller.householdId]: totalShares };
    company.residentShares = totalShares;
    household.shares ||= {};
    household.shares[company.id] = totalShares;
  } else {
    company.townShares = totalShares;
  }
  company.listing = { listed: true, ticker, listedAt: { year: state.year, day: Math.min(content.rules.daysPerYear, state.day + 1) } };
  // 实时股价（金融扩展四期）：挂牌价起步，每日向利润锚波动
  company.sharePriceVoucherUnits = priceUnits;
  company.sharePriceHistory = [priceUnits];
  company.stockMarket = { regime: "normal", daysLeft: 0, drift: 0, momentum: 0, anchorUnits: priceUnits };
  company.shareSale ||= {};
  company.shareSale.sellerOwner = seller.kind === "household" ? seller.householdId : "town";
  company.shareSale.offeredShares = offeredShares;
  company.shareSale.sharePriceVoucherUnits = priceUnits;
  company.shareSale.cumulativeProceedsVoucherUnits ||= 0;
  company.shareSale.lastSaleVoucherUnits ||= 0;
  company.shareSale.lastSoldShares ||= 0;
  return company;
}

// 老公司挂牌（整栋已在公司名下、尚未上市，多见于旧存档）：卖方为镇库。
export function listCompanyOnExchange(state, companyId, options, content) {
  ensureStockExchangeState(state);
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "公司不存在" };
  const gate = listingGate(state);
  if (gate) return { ok: false, reason: gate };
  if (company.listing?.listed) return { ok: false, reason: "公司已经上市；再次售股沿用现有总股本" };
  const terms = resolveListingTerms(state, {
    companyId, buildingId: company.buildingId, levels: company.listedLevels,
    ticker: options?.ticker, totalShares: options?.totalShares, offerPercent: options?.offerPercent ?? content.rules.ipoTownDefaultOfferPercent ?? 0,
    offeredShares: options?.offeredShares, priceVoucherPerShare: options?.priceVoucherPerShare
  }, content);
  if (!terms.ok) return terms;
  applyCompanyListing(state, company, terms, { kind: "town" }, content);
  recordEvent(state, `${company.name}（${terms.ticker}）在交易所挂牌，总股本${terms.totalShares.toLocaleString("zh-CN")}股；挂牌不代表已全部售出。`, content, { day: state.day + 1 });
  return { ok: true, ticker: terms.ticker, totalShares: terms.totalShares, offeredShares: terms.offeredShares, priceVoucherUnits: terms.priceUnits, townShares: terms.totalShares, sellerOwner: "town" };
}

export function configureListedShareOffer(state, companyId, offeredShares, priceVoucherPerShare, content) {
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "公司不存在" };
  const gate = listingGate(state);
  if (gate) return { ok: false, reason: gate };
  if (!company.listing?.listed) return { ok: false, reason: "公司尚未上市" };
  if (!offerSeller(state, company)) return { ok: false, reason: "发行池卖方不明，无法挂牌出售" };
  const shares = Math.floor(Number(offeredShares) || 0);
  const priceInput = Number(priceVoucherPerShare);
  if (shares < 0 || shares > sellerHoldingShares(state, company)) return { ok: false, reason: "出售股数不能超过卖方持股" };
  if (!Number.isFinite(priceInput) || priceInput <= 0) return { ok: false, reason: "每股售价须大于0" };
  const priceUnits = roundToShareTick(priceInput * currencyScale(content), content);
  company.shareSale.offeredShares = shares;
  company.shareSale.sharePriceVoucherUnits = priceUnits;
  return { ok: true, offeredShares: shares, priceVoucherUnits: priceUnits };
}

export function stockReference(state, company, content) {
  const scale = currencyScale(content);
  const profit = companyActualProfitValuation(state, company, content, content.rules.stockProfitWindowDays);
  const basisUnits = stockFairValueUnits(profit, content);
  return {
    ...profit,
    bookAssetsVoucherUnits: 0,
    referenceCompanyValueVoucherUnits: basisUnits,
    referencePerShareVoucherUnits: company.totalShares > 0 ? Math.floor(basisUnits / company.totalShares) : 0,
    basis: profit.validProfitMethod
      ? `最近${profit.observedDays}个日历日净利润折年，按${content.rules.stockFairYieldPercent || 4}%利润率估值（市盈率${Math.round(100 / (content.rules.stockFairYieldPercent || 4))}）；停工日计入观察窗口`
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
  // 回购可能减少业主家庭的持股，发行池股数不得超过卖方实际持股。
  company.shareSale.offeredShares = Math.min(company.shareSale.offeredShares || 0, sellerHoldingShares(state, company));
  recordEvent(state, `镇库以玩家定价回购${company.name}${boughtShares.toLocaleString("zh-CN")}股。`, content, { day: state.day + 1 });
  return { ok: true, boughtShares, paidVoucherUnits: paid, sellers, preview };
}

// 近似标准正态（三个均匀数之和）。
function gauss(state) {
  return (nextRandom(state) + nextRandom(state) + nextRandom(state) - 1.5) / 0.5;
}

// 单只股票一天的价格。纯函数（随机数由 draw 提供），方便单测与调参。
// market = company.stockMarket：{ regime: "normal"|"bubble"|"crash", daysLeft, drift, momentum, anchorUnits }
// - 常态：慢慢回拢业绩锚，带惯性、情绪推力与噪声；
// - 偶发泡沫：持续上涨、不再回拢业绩锚，价格越高越容易破裂（或到期）；
// - 破裂：连日急跌，单日最多约 20%，回到业绩锚附近结束。
// 返回新价（一档整数倍）并原地更新 market。涨跌幅 ≤ 20%（价格很低时至少允许动一档）。
export function stepSharePrice(price, anchorUnits, market, sentiment, draw, content) {
  const P = STOCK_MARKET;
  const tick = shareTick(content);
  const gap = Math.log(price / Math.max(tick, anchorUnits));
  if (market.regime === "normal") {
    const chance = P.bubbleStartDaily * (1 + 2.5 * Math.max(0, sentiment)) * (gap < P.bubbleStartMaxGap ? 1 : 0);
    if (draw.uniform() < chance) {
      market.regime = "bubble";
      market.daysLeft = P.bubbleMinDays + Math.floor(draw.uniform() * P.bubbleSpanDays);
      market.drift = P.bubbleDriftMin + draw.uniform() * P.bubbleDriftSpan;
    }
  } else if (market.regime === "bubble") {
    const burst = P.burstBase + P.burstPerGap * Math.max(0, gap - P.burstGapStart);
    if (market.daysLeft <= 0 || draw.uniform() < burst) {
      market.regime = "crash";
      market.daysLeft = P.crashMinDays + Math.floor(draw.uniform() * P.crashSpanDays);
      market.drift = -(P.crashDriftMin + draw.uniform() * P.crashDriftSpan);
    }
  } else if (market.daysLeft <= 0 || gap <= P.crashEndGap) {
    market.regime = "normal";
    market.drift = 0;
    market.momentum = 0;
  }
  let change;
  if (market.regime === "bubble") change = market.drift + P.bubbleNoise * draw.gauss();
  else if (market.regime === "crash") change = market.drift + P.crashNoise * draw.gauss();
  else change = -P.reversion * gap + P.momentumCarry * market.momentum + P.sentimentDrift * sentiment + P.noise * draw.gauss();
  if (market.regime !== "normal") market.daysLeft -= 1;
  // 涨跌幅钳制：不超过 ±20%，价格很低时至少允许一档。
  const maxSteps = Math.max(1, Math.floor(price * SHARE_PRICE_DAILY_LIMIT / tick));
  const steps = Math.max(-maxSteps, Math.min(maxSteps, Math.round(price * change / tick)));
  const next = Math.max(tick, price + steps * tick);
  market.momentum = P.momentumDecay * market.momentum + (1 - P.momentumDecay) * (next / price - 1);
  return next;
}

// 每日股价结算：AI 做市商 + 市场情绪。
// 每只上市股票各有自己的行情（常态/泡沫/破裂，见 stepSharePrice）；市场情绪是全市场共有的慢变量，情绪高涨时更容易起泡沫。
// 用种子随机数保证模拟可复现；没有上市公司时不消耗随机数。
export function settleStockMarketDay(state, content) {
  if (!hasStockExchange(state)) return null;
  const listed = Object.values(state.companies || {}).filter(company => company.listing?.listed && company.totalShares > 0);
  if (!listed.length) return null;
  const exchange = ensureStockExchangeState(state);
  exchange.sentiment = Math.max(-1, Math.min(1, 0.96 * (exchange.sentiment || 0) + 0.12 * gauss(state)));
  const draw = { uniform: () => nextRandom(state), gauss: () => gauss(state) };
  const moved = [];
  for (const company of listed) {
    // 老存档兼容：没有实时股价时用挂牌价起步；旧价不是一档整数倍时取整到一档。
    company.sharePriceVoucherUnits ||= company.shareSale?.sharePriceVoucherUnits || 0;
    if (!(company.sharePriceVoucherUnits > 0)) continue;
    const current = roundToShareTick(company.sharePriceVoucherUnits, content);
    const market = company.stockMarket ||= { regime: "normal", daysLeft: 0, drift: 0, momentum: 0, anchorUnits: current };
    // 业绩锚 = 合理价（年利润 ÷ 4%）：有业绩就用它；观察够了仍不赚钱，锚每天缓慢下滑；还没有业绩（新股）沿用上一次的锚，从未有过就用挂牌价。
    const performance = stockReference(state, company, content);
    const reference = performance.referencePerShareVoucherUnits || 0;
    if (reference > 0) market.anchorUnits = reference;
    else if (performance.observedDays >= (content.rules.sharePerformanceObservationDays || 30)) market.anchorUnits = Math.max(shareTick(content), Math.floor((market.anchorUnits || current) * 0.99));
    const next = stepSharePrice(current, market.anchorUnits > 0 ? market.anchorUnits : current, market, exchange.sentiment, draw, content);
    company.sharePriceVoucherUnits = next;
    if (!Array.isArray(company.sharePriceHistory)) company.sharePriceHistory = [];
    company.sharePriceHistory.push(next);
    if (company.sharePriceHistory.length > 30) company.sharePriceHistory.shift();
    if (next !== current) moved.push({ companyId: company.id, from: current, to: next });
  }
  return moved.length ? { moved } : null;
}

// 住户日常股票买入：按投资倾向把本日股票预算分散买入发行池（镇长或业主挂出的）股份。
// - 买入对象：已上市、发行池有股且市价不低于卖方定价的公司，按实时股价成交；镇库未挂出的股份不卖
// - 预算：household.stockBuyBudgetVoucherUnits（银行分流后写入）或无银行时现算
// - 付款：住户 → 卖方（镇库或原业主家庭）；付不起就跳过
// - 股份转移：卖方是镇库则 townShares → residentShares；卖方是家庭则只在居民之间转手
export function settleHouseholdStockBuying(state, content) {
  if (!hasStockExchange(state)) return null;
  // 发行池是卖方挂出的限价卖单：市价低于卖方定的每股售价时不成交（成交价按市价，卖方不会卖得比自己定的价低）。
  const listed = Object.values(state.companies || {}).filter(company =>
    company.listing?.listed && (company.sharePriceVoucherUnits || 0) > 0 &&
    company.sharePriceVoucherUnits >= (company.shareSale?.sharePriceVoucherUnits || 0) &&
    offeredPoolShares(state, company) > 0);
  if (!listed.length) return null;
  // 追涨：近期涨得多、正处泡沫的股票分到更多买入预算，破裂期的股票少人问津。
  const weights = new Map(listed.map(company => {
    const market = company.stockMarket || {};
    const heat = 1 + 6 * (market.momentum || 0) + (market.regime === "bubble" ? 0.5 : market.regime === "crash" ? -0.3 : 0);
    return [company.id, Math.max(0.25, Math.min(3, heat))];
  }));
  const weightTotal = [...weights.values()].reduce((sum, value) => sum + value, 0);
  let totalShares = 0;
  let totalSpentUnits = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const budget = consumeHouseholdStockBudget(state, content, household);
    if (budget <= 0) continue;
    for (const company of listed) {
      const perCompany = Math.floor(budget * weights.get(company.id) / weightTotal);
      if (perCompany <= 0) continue;
      const available = offeredPoolShares(state, company);
      if (available <= 0) continue;
      const seller = offerSeller(state, company);
      if (!seller || (seller.kind === "household" && seller.householdId === household.id)) continue;
      const priceUnits = company.sharePriceVoucherUnits;
      const shares = Math.min(available, Math.floor(perCompany / priceUnits));
      if (shares <= 0) continue;
      const cost = shares * priceUnits;
      const payee = seller.kind === "town" ? "town" : `household:${seller.householdId}`;
      const payment = settleMonetaryPayment(state, `household:${household.id}`, payee,
        currentPaymentComposition(state, cost), content, "share_market_buy",
        `${household.name}二级市场买入${company.name}${shares}股`, { requireFull: true });
      if (!payment.ok) continue;
      company.shareSale.offeredShares = Math.max(0, (company.shareSale.offeredShares || 0) - shares);
      if (seller.kind === "town") {
        company.townShares -= shares;
        company.residentShares = (company.residentShares || 0) + shares;
      } else {
        const sellerId = seller.householdId;
        company.householdShares[sellerId] = (company.householdShares[sellerId] || 0) - shares;
        if (company.householdShares[sellerId] <= 0) delete company.householdShares[sellerId];
        const sellerHousehold = state.households.byId[sellerId];
        sellerHousehold.shares ||= {};
        sellerHousehold.shares[company.id] = Math.max(0, (sellerHousehold.shares[company.id] || 0) - shares);
        if (sellerHousehold.shares[company.id] <= 0) delete sellerHousehold.shares[company.id];
      }
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
