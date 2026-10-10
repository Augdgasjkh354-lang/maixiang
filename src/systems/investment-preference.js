import { currencyScale } from "../economy/currency.js";
import { householdList, householdPopulation, isActiveHousehold } from "./households.js";
import { wholesalePrice } from "./wholesale-price.js";
import { liquidityInvestRatio } from "./liquidity.js";
import { nextRandom } from "../core/random.js";

// 存款 vs 股票投资倾向（为下版本打地基，也驱动本期行为）。
// - 投资意愿锚：沿用流动性算法的 50%—80%（investRatio），作用于生活支出储备之外的闲钱
// - 分流：存款倾向 ← 存款年利率（现实直觉）；股票倾向 = 1 − 存款倾向
// - 每户独立倾向：基准 ±10% 个体差异；7—30 天随机刷新；存款利率变动时即时刷新

export const HOUSEHOLD_RESERVE_DAYS = 30; // 生活支出储备天数（口粮），与银行吸储口径一致
export const DEFAULT_DEPOSIT_RATE_ANNUAL_PERCENT = 2;

// 存款年利率 r% → 存款倾向基准：1%→20% / 2%→35% / 3%→50% / 4%→65% / 5%→80%
export function baseDepositPropensity(depositRateAnnualPercent) {
  const r = Number(depositRateAnnualPercent) || 0;
  return Math.min(0.85, Math.max(0.15, 0.2 + 0.15 * (r - 1)));
}

export function depositRateAnnualPercent(state) {
  return state.policy?.bank?.depositRateAnnualPercent ?? DEFAULT_DEPOSIT_RATE_ANNUAL_PERCENT;
}

function absoluteDay(state, content) {
  return (state.year - 1) * (content.rules.daysPerYear || 365) + state.day;
}

// 确保每户倾向字段存在且新鲜，返回 { deposit, stock }（和为 1）
export function ensureHouseholdInvestPropensity(state, content, household) {
  const rateBps = Math.round(depositRateAnnualPercent(state) * 100);
  const absDay = absoluteDay(state, content);
  const due = household.investPropensityNextRefreshAbsDay == null || absDay >= household.investPropensityNextRefreshAbsDay;
  const rateChanged = household.investPropensityRateBps !== rateBps;
  const missing = !(household.depositPropensity >= 0) || !(household.stockPropensity >= 0);
  if (due || rateChanged || missing) {
    const base = baseDepositPropensity(rateBps / 100);
    const jitter = 0.9 + nextRandom(state) * 0.2;
    const deposit = Math.min(0.95, Math.max(0.05, base * jitter));
    household.depositPropensity = Math.round(deposit * 1000) / 1000;
    household.stockPropensity = Math.round((1 - household.depositPropensity) * 1000) / 1000;
    household.investPropensityRateBps = rateBps;
    household.investPropensityNextRefreshAbsDay = absDay + 7 + Math.floor(nextRandom(state) * 24);
  }
  return { deposit: household.depositPropensity, stock: household.stockPropensity };
}

// 可投资金（券）：手头现金 − 30 天口粮储备，超出部分 × 当日流动性投资比例（50%—80%）
// 供银行吸储与股票买入共用同一口径，避免重复计算。
export function householdInvestableVoucherUnits(state, content, household) {
  const pop = householdPopulation(household);
  if (!(pop > 0)) return 0;
  const scale = currencyScale(content);
  const wheatPricePerJin = wholesalePrice(state, "wheat", content) || 0;
  if (!(wheatPricePerJin > 0)) return 0;
  const reserveUnits = Math.ceil(pop * 2 * HOUSEHOLD_RESERVE_DAYS * wheatPricePerJin * scale);
  const surplus = (household.voucherUnits || 0) - reserveUnits;
  if (surplus <= 0) return 0;
  return Math.floor(surplus * liquidityInvestRatio(state, content));
}

// 取出本日股票购买预算并清零：银行结算时已按倾向分流并写入 household.stockBuyBudgetVoucherUnits；
// 银行不可用时直接按倾向现算。若银行今日已结算且预算已消费，不再重算（防同日重复调用超发）。
export function consumeHouseholdStockBudget(state, content, household) {
  let budget = household.stockBuyBudgetVoucherUnits || 0;
  household.stockBuyBudgetVoucherUnits = 0;
  if (budget > 0) return budget;
  const absDay = (state.year - 1) * (content.rules.daysPerYear || 365) + state.day;
  if (household.stockBudgetAbsDay === absDay) return 0;
  const investable = householdInvestableVoucherUnits(state, content, household);
  if (investable <= 0) return 0;
  const propensity = ensureHouseholdInvestPropensity(state, content, household);
  return Math.floor(investable * propensity.stock);
}

export function activeHouseholdsWithBudget(state) {
  return householdList(state).filter(isActiveHousehold);
}
