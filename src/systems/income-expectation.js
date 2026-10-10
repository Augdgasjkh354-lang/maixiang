import { householdList, isActiveHousehold } from "./households.js";
import { nextRandom } from "../core/random.js";

// 收入预期（为下一版本打地基）：每户每年期望收入（斤，小麦等值）。
// - 农民：年分粮 = 亩产 × 耕地 × (1 - 农业税率) / 农民总数（以农业税为基准）
// - 工作者：日薪 × 360（按当年天数）
// - 混合户按成员构成加总；无业者为 0
// 每日刷新，存 household.incomeExpectationJin（||= 兼容老档）。
// 本期只计算 + 存储 + 展示，不参与任何决策；下版本接满意度/消费/跳槽。
export const FALLBACK_DAILY_WAGE_JIN = 5;

function jobDailyWageJin(state, content, jobKey) {
  const override = state.employment?.wageRates?.[jobKey];
  if (Number.isFinite(override)) return override;
  let baseId = jobKey;
  if (jobKey.startsWith("shop:")) {
    baseId = jobKey.endsWith(":merchant") ? "merchants" : "shop_clerks";
  }
  if (content.roles?.[baseId]?.wagePerWorkerDay != null) return content.roles[baseId].wagePerWorkerDay;
  for (const building of Object.values(content.buildings || {})) {
    const job = (building.jobs || []).find(row => row.id === baseId);
    if (job) return job.wagePerWorkerDay ?? FALLBACK_DAILY_WAGE_JIN;
  }
  return FALLBACK_DAILY_WAGE_JIN;
}

// 7—30 天随机刷新一次（种子随机，保证读档一致）；首次直接计算。
export function maybeRefreshHouseholdIncomeExpectations(state, content) {
  const absDay = (state.year - 1) * (content.rules.daysPerYear || 365) + state.day;
  if (state.incomeExpectationNextRefreshAbsDay == null) {
    updateHouseholdIncomeExpectations(state, content);
  } else if (absDay < state.incomeExpectationNextRefreshAbsDay) {
    return;
  } else {
    updateHouseholdIncomeExpectations(state, content);
  }
  state.incomeExpectationNextRefreshAbsDay = absDay + 7 + Math.floor(nextRandom(state) * 24);
}

// 每个农民的年分粮（斤）：全镇农田产出扣掉农业税，平均到在岗农民。收入预期的务农部分与秋收初值共用这一口径。
export function perFarmerShareJin(state, content) {
  const acres = state.agriculture?.reclaimedAcres || 0;
  const yieldPerAcre = content.agriculture?.yieldPerAcre ?? 0;
  const taxRate = (state.policy?.agricultureTaxPercent ?? content.rules.agricultureTaxDefaultPercent ?? 50) / 100;
  let totalFarmers = 0;
  for (const household of householdList(state)) {
    if (isActiveHousehold(household)) totalFarmers += household.jobs?.farmers || 0;
  }
  return totalFarmers > 0 ? acres * yieldPerAcre * (1 - taxRate) / totalFarmers : 0;
}

// 开局（尚无秋收记录）时，每户的 lastHarvestIncomeJin 用收入预期里的务农分粮部分（在岗农民 × 每人年分粮）作初值，
// 使开局全年收入一致。只补缺失的户，已有秋收记录的不动。每日开日调用（读旧档时同样生效）。
export function fillMissingHouseholdLastHarvestIncome(state, content) {
  const missing = householdList(state).filter(household => !Number.isFinite(household.lastHarvestIncomeJin));
  if (!missing.length) return;
  const share = perFarmerShareJin(state, content);
  for (const household of missing) {
    const farmers = isActiveHousehold(household) ? (household.jobs?.farmers || 0) : 0;
    household.lastHarvestIncomeJin = Math.max(0, farmers * share);
  }
}

export function updateHouseholdIncomeExpectations(state, content) {
  const daysPerYear = content.rules.daysPerYear || 360;
  const households = householdList(state);
  const perFarmerShare = perFarmerShareJin(state, content);
  for (const household of households) {
    if (!isActiveHousehold(household)) {
      household.incomeExpectationJin ||= 0;
      continue;
    }
    let expectation = 0;
    const jobs = household.jobs || {};
    const farmers = jobs.farmers || 0;
    if (farmers > 0) expectation += farmers * perFarmerShare;
    for (const [jobKey, count] of Object.entries(jobs)) {
      if (jobKey === "farmers" || !(count > 0)) continue;
      expectation += count * jobDailyWageJin(state, content, jobKey) * daysPerYear;
    }
    household.incomeExpectationJin = Math.max(0, Math.round(expectation));
  }
}
