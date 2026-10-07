import { currencyScale, voucherBalance } from "../economy/currency.js";
import { householdList, householdPopulation, isActiveHousehold } from "./households.js";
import { wholesalePrice } from "./wealth-stats.js";

// 流动性系统（金融扩展五期）：投资比例算法自动调整，无需手调。
// - 安全线 = 每户 1 年生存 + 消费开支；超过安全线的部分按投资比例成为可投资金
// - 投资比例 = 50% + 30% × 流动性健康度，在 50%～80% 之间自动滑动
// - 健康度由民间资金覆盖年开支的倍数映射：覆盖 1 年→0（偏紧），覆盖 3 年→1（宽松）
export const INVEST_RATIO_MIN = 0.5;
export const INVEST_RATIO_MAX = 0.8;
export const FOOD_JIN_PER_PERSON_DAY = 2;

export function computeLiquidity(state, content) {
  const scale = currencyScale(content);
  const daysPerYear = content.rules.daysPerYear || 360;
  const wheatPricePerJin = wholesalePrice(state, "wheat", content) || 0;
  let population = 0;
  for (const household of householdList(state)) {
    if (isActiveHousehold(household)) population += householdPopulation(household);
  }
  // 全镇年生存消费开支（券单位）：人口 × 2斤/人/天 × 360天 × 券/斤
  const annualNeedVoucherUnits = Math.ceil(population * FOOD_JIN_PER_PERSON_DAY * daysPerYear * wheatPricePerJin * scale);
  // 民间资金 = 住户小麦（按市价折券）+ 住户手头粮券 + 住户银行存款
  const jinScale = content.precision.inventoryUnitsPerJin;
  const residentWheatJin = (state.accounts.residents.wheat || 0) / jinScale;
  const wheatVoucherUnits = Math.floor(residentWheatJin * wheatPricePerJin * scale);
  const cashVoucherUnits = voucherBalance(state, "residents");
  let depositVoucherUnits = 0;
  for (const units of Object.values(state.bank?.deposits || {})) depositVoucherUnits += units || 0;
  const privateFundsVoucherUnits = wheatVoucherUnits + cashVoucherUnits + depositVoucherUnits;
  const coverageRatio = annualNeedVoucherUnits > 0 ? privateFundsVoucherUnits / annualNeedVoucherUnits : 0;
  const health = Math.min(1, Math.max(0, (coverageRatio - 1) / 2));
  const investRatio = INVEST_RATIO_MIN + (INVEST_RATIO_MAX - INVEST_RATIO_MIN) * health;
  const level = health < 1 / 3 ? "tight" : health < 2 / 3 ? "normal" : "loose";
  return {
    health: Math.round(health * 1000) / 1000,
    investRatio: Math.round(investRatio * 1000) / 1000,
    level,
    coverageRatio: Math.round(coverageRatio * 100) / 100,
    privateFundsVoucherUnits,
    annualNeedVoucherUnits
  };
}

export function settleLiquidityDay(state, content) {
  state.liquidity ||= {};
  const daysPerYear = content.rules.daysPerYear || 360;
  const dayIndex = (state.year - 1) * daysPerYear + state.day;
  if (state.liquidity.dayIndex === dayIndex) return state.liquidity;
  const computed = computeLiquidity(state, content);
  state.liquidity.dayIndex = dayIndex;
  state.liquidity.health = computed.health;
  state.liquidity.investRatio = computed.investRatio;
  state.liquidity.level = computed.level;
  state.liquidity.coverageRatio = computed.coverageRatio;
  return state.liquidity;
}

// 当日投资比例（银行吸储、国债认购共用；每日结算时已刷新）
export function liquidityInvestRatio(state, content) {
  if (state.liquidity && Number.isFinite(state.liquidity.investRatio)) return state.liquidity.investRatio;
  return computeLiquidity(state, content).investRatio;
}
