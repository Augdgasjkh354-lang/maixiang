import { totalQeqUnits } from "../economy/inventory.js";
import { MODS } from "../mods/registry.js";
import { assembleDailySteps } from "../mods/api.js";
import { emptyYearTotals, recordEvent } from "../economy/ledger.js";
import { populationStats } from "../selectors/labor.js";
import { employmentSnapshot, refillAgricultureToTarget } from "./employment.js";
import { clearDailyHouseholdIncome, ensureEmploymentExchangeDay, resetYearHouseholdIncome } from "./households.js";
import { advanceConstruction } from "./construction.js";
import { processAllBuildings } from "./production.js";
import { applyAutomaticRelief } from "./finance.js";
import { payDailyWages, payUnemploymentBenefit } from "./payroll.js";
import { buyStaplesForResidents } from "./market.js";
import { consumeDailyRations } from "./consumption.js";
import { updateSatisfaction } from "./satisfaction.js";
import { accumulateFarmDay, harvest } from "./agriculture.js";
import { advancePopulation } from "./population.js";
import { selectHousing } from "../selectors/housing.js";
import { settleHousingRent, buyRepairWoodForResidents } from "./housing.js";
import { settleVillaPurchases, settleVillaPropertyTax } from "./villas.js";
import { collectSocialContributions, payPensions } from "./social-security.js";
import { advanceOutsideTownDay, settleOutsideTownYear, settleWheatLoansYear } from "./outside-town.js";
import { settleTradeAgreementsMonth, settleTradeAgreementsYear } from "./trade-agreements.js";
import { resetLaborCompetitionYear } from "./labor-market.js";
import { recordEconomyHistory } from "./wealth-stats.js";
import { accrueSaltNeed, buySaltForResidents, consumeDailySalt, finishSaltGraceDay, selectSaltCoverage } from "./salt.js";
import { arrangePrivateWorkers, processPrivateIndustries, resetPrivateDaily, resetPrivateYear, payPrivateIndustryWages } from "./private-industry.js";
import { emptyFinancialFlowPeriod } from "../economy/financial-flows.js";
import { arrangeListedWorkers, payListedCompanyWages, processListedCompanies, resetCompanyDaily, resetCompanyYear, sellCompanyOutputsToWholesale, settleAnnualCompanyDividends } from "./companies.js";
import { resetShopDaily, prepareShopsForDay, finishShopsDay, resetShopYear, syncShopEmployment } from "./shops.js";
import { refreshOperatingPlan, recordConsumerDay } from "../economy/operating-plan.js";
import { archiveHouseholdLifeYear, finalizeHouseholdLifeDay, resetHouseholdLifeDay, resetHouseholdLifeYear } from "./household-life.js";
import { settleBankDay } from "./bank.js";
import { settleBondsDay } from "./bonds.js";
import { settleStockMarketDay, settleHouseholdStockBuying } from "./stock-exchange.js";
import { settleLiquidityDay } from "./liquidity.js";
import { maybeRefreshHouseholdIncomeExpectations } from "./income-expectation.js";
import { accrueServiceDemand, processServiceDemand } from "./services.js";
import { accrueGoodsDemand, buyGoodsForResidents, consumeGoods } from "./goods-demand.js";
import { accrueIndustryExperience } from "./productivity.js";
import { resetWholesaleDay, resetWholesaleYear, runWholesaleIntake, snapshotWholesaleHistory } from "./wholesale-market.js";
import { applyCompanyDistributionsToAnnualReport, buildAnnualReport } from "./annual-reports.js";

// ---------------------------------------------------------------- 账本翻页

function resetDayBooks(state, content) {
  state.financialFlows ||= { day: emptyFinancialFlowPeriod(), year: emptyFinancialFlowPeriod(), cumulative: emptyFinancialFlowPeriod() };
  state.financialFlows.day = emptyFinancialFlowPeriod();
  resetCompanyDaily(state, content);
  resetShopDaily(state, content);
  resetWholesaleDay(state, content);
  clearDailyHouseholdIncome(state);
  resetHouseholdLifeDay(state, content);
  if (state.business) {
    state.business.day = {
      producedUnits: {}, soldBreadUnits: 0, revenueWheatUnits: 0, breadCogsWheatUnits: 0, rawInputCostWheatUnits: 0,
      operatingWagesWheatUnits: 0, constructionWagesWheatUnits: 0, processingLossWheatUnits: 0
    };
    for (const row of Object.values(state.business.buildings || {})) row.todayOutputUnits = {};
  }
  for (const industry of Object.values(state.industries || {})) {
    industry.day = { producedUnits: {}, soldUnits: 0, revenueWheatUnits: 0, operatingWagesWheatUnits: 0 };
  }
  resetPrivateDaily(state);
  if (state.fiscal) state.fiscal.day = { dueWheatUnits: 0, collectedWheatUnits: 0, waivedWheatUnits: 0 };
  if (state.agriculture?.reclaim) state.agriculture.reclaim.day = { acres: 0, workDays: 0, paidVoucherUnits: 0 };
}

function resetYearBooks(state, content) {
  state.yearTotals = emptyYearTotals();
  if (state.business) {
    state.business.year = {
      producedUnits: {}, soldBreadUnits: 0, revenueWheatUnits: 0, breadCogsWheatUnits: 0, rawInputCostWheatUnits: 0,
      operatingWagesWheatUnits: 0, constructionWagesWheatUnits: 0, processingLossWheatUnits: 0
    };
    for (const row of Object.values(state.business.buildings || {})) row.yearOutputUnits = {};
  }
  if (state.payroll) state.payroll.year = {
    paidWheatUnits: 0, currentPaidWheatUnits: 0, arrearsPaidWheatUnits: 0,
    unpaidWheatUnits: 0, unemploymentPaidWheatUnits: 0, accruedWheatUnits: 0
  };
  for (const industry of Object.values(state.industries || {})) {
    industry.year = { producedUnits: {}, soldUnits: 0, revenueWheatUnits: 0, operatingWagesWheatUnits: 0 };
  }
  resetPrivateYear(state);
  resetCompanyYear(state, content, state.year - 1);
  resetShopYear(state, content);
  resetWholesaleYear(state, content);
  resetLaborCompetitionYear(state);
  state.financialFlows.year = emptyFinancialFlowPeriod();
  if (state.fiscal) state.fiscal.year = { dueWheatUnits: 0, collectedWheatUnits: 0, waivedWheatUnits: 0 };
  if (state.agriculture?.reclaim) state.agriculture.reclaim.year = { acres: 0, workDays: 0, paidVoucherUnits: 0 };
  if (state.salt) state.salt.year = { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 };
  resetYearHouseholdIncome(state);
  resetHouseholdLifeYear(state, content);
}

// ---------------------------------------------------------------- 日结流水线
//
// 一天按下表从上到下执行。每步：
//   id    结果名，run 的返回值存进 day[id]，最后作为 settleOneDay 的返回值
//   when  可选，返回 false 时跳过（结果为 null）
//   run   (state, content, day) → 结果；day 里有前面各步的结果和开日快照
// 加新系统：在合适位置插一行即可。顺序就是经济逻辑：先发钱、再生产、再买卖、再消费、最后金融与翻日。

const newYearDay = (state, content, day) => day.isNewYearDay;
const yearEndsToday = (state, content) => state.day + 1 >= content.rules.daysPerYear;

export const CORE_DAILY_STEPS = [
  // ── 开日：清当日账，做快照
  { id: "openDay", run: (state, content, day) => {
    day.saltDemandUnits = accrueSaltNeed(state, day.peopleAtStart.total, content);
    accrueGoodsDemand(state, day.peopleAtStart.total, content);
    resetDayBooks(state, content);
  } },
  // 新年首日：先结上一年公司利润（居民到账进入新一年账本），再收别墅房产税。
  { id: "yearStartCompanyDistributions", run: (state, content) => {
    if (!(state.day === 0 && state.year > 1)) return [];
    const rows = settleAnnualCompanyDividends(state, state.year - 1, content);
    if (rows.length) applyCompanyDistributionsToAnnualReport(state, state.year - 1, rows);
    return rows;
  } },
  { id: "villaTax", when: (state) => state.day === 0, run: settleVillaPropertyTax },

  // ── 用工：排生产计划、招工，之后的工资与失业金都按这一刻的就业快照
  { id: "staffing", run: (state, content, day) => {
    accrueServiceDemand(state, content);
    refreshOperatingPlan(state, content);
    arrangePrivateWorkers(state, content);
    arrangeListedWorkers(state, content);
    syncShopEmployment(state, content);
    refillAgricultureToTarget(state, content);
    ensureEmploymentExchangeDay(state, content);
    day.laborAtStart = employmentSnapshot(state, content);
    day.housingAtStart = selectHousing(state, content);
    state.policy.agricultureTaxRecent ||= [];
    state.policy.agricultureTaxRecent.push({ year: state.year, day: state.day + 1,
      rateBps: Math.round((state.policy.agricultureTaxPercent ?? 50) * 100) });
    state.policy.agricultureTaxRecent = state.policy.agricultureTaxRecent.slice(-(content.rules.agricultureTaxLookbackDays || 30));
  } },

  // ── 发钱：救济优先，再发工资（先还旧欠薪），再失业金、养老金
  { id: "relief", run: (state, content, day) => applyAutomaticRelief(state, day.peopleAtStart.total, content) },
  { id: "wages", run: (state, content, day) => payDailyWages(state, day.laborAtStart, content) },
  { id: "companyWages", run: payListedCompanyWages },
  { id: "privateWages", run: payPrivateIndustryWages },
  // 各雇主发完工资后统一收社保（按在岗人数，所有岗位都算）。
  { id: "socialContribution", run: collectSocialContributions },
  { id: "unemployment", run: (state, content, day) => payUnemploymentBenefit(state, day.laborAtStart, content) },
  { id: "pension", run: payPensions },

  // ── 生产：施工 → 镇营（原料从批发市场领，产品交回）→ 民营 → 公司，产品都进批发市场
  { id: "construction", run: advanceConstruction },
  { id: "wholesaleTownAllocation", run: (state, content) => runWholesaleIntake(state, [], [], content, { includeTownAllocation: true }) },
  { id: "production", run: processAllBuildings },
  { id: "wholesaleTownOutput", run: (state, content, day) => runWholesaleIntake(state, day.production, [], content, { includeTownAllocation: false }) },
  { id: "privateProduction", run: processPrivateIndustries },
  { id: "wholesalePrivateIntake", run: (state, content, day) => runWholesaleIntake(state, [], day.privateProduction, content, { includeTownAllocation: false }) },
  { id: "companyProduction", run: processListedCompanies },
  { id: "wholesaleCompanyIntake", run: sellCompanyOutputsToWholesale },
  // 今天在岗的生产工人累计成熟练度（工日），明天起生效。
  { id: "industryExperience", run: accrueIndustryExperience },

  // ── 商业与居民购买：店铺计提并补货 → 房租 → 别墅 → 盐 → 主食 → 修缮木材 → 酒与布 → 服务
  { id: "shopPreparation", run: prepareShopsForDay },
  { id: "rent", run: (state, content, day) => settleHousingRent(state, day.housingAtStart, content) },
  { id: "villaSales", run: settleVillaPurchases },
  { id: "saltTrade", run: buySaltForResidents },
  { id: "trade", run: (state, content, day) => buyStaplesForResidents(state, day.peopleAtStart.total, content) },
  { id: "repairWood", run: buyRepairWoodForResidents },
  { id: "goodsTrade", run: buyGoodsForResidents },
  { id: "services", run: processServiceDemand },

  // ── 生活：吃饭、吃盐、舒心值、家庭日账
  { id: "meal", run: (state, content, day) => consumeDailyRations(state, day.peopleAtStart.total, content) },
  { id: "saltMeal", run: consumeDailySalt },
  { id: "goodsUsed", run: consumeGoods },
  { id: "satisfaction", run: (state, content, day) => {
    const comfortQeq = day.meal.moves.reduce((sum, move) => sum + move.qeqUnits * (content.items[move.itemId]?.satisfactionPerQeq || 0), 0);
    const interval = content.rules.satisfactionUpdateIntervalDays || 1;
    const serial = (state.year - 1) * content.rules.daysPerYear + state.day;
    const urgent = day.meal.missingQeqUnits > 0 || day.saltMeal.missingUnits > 0 || day.housingAtStart.shortage > 0 || (day.wages.unpaidCurrentVoucher || 0) > 0;
    if (urgent || serial % interval === 0 || !state.satisfactionFactors?.householdWeighted) {
      updateSatisfaction(state, day.peopleAtStart.total, comfortQeq, content, {
        housing: day.housingAtStart,
        saltCoverage: selectSaltCoverage(state, content).coverage,
        saltGrace: state.salt.graceDaysElapsed < content.rules.saltGraceDays
      });
    }
    finalizeHouseholdLifeDay(state, content);
    maybeRefreshHouseholdIncomeExpectations(state, content);
    finishSaltGraceDay(state, content);
  } },

  // ── 收尾：店铺结账（年末强制结算）、记录消费、农田出工
  { id: "shops", run: (state, content) => finishShopsDay(state, content, yearEndsToday(state, content)) },
  { id: "farmDay", run: (state, content) => { recordConsumerDay(state, content); accumulateFarmDay(state, content); } },

  // ── 金融：流动性 → 银行 → 国债 → 股市 → 住户买股
  { id: "finance", run: (state, content) => {
    settleLiquidityDay(state, content);
    settleBankDay(state, content);
    settleBondsDay(state, content);
    settleStockMarketDay(state, content);
    settleHouseholdStockBuying(state, content);
  } },

  // ── 翻日：节气、秋收
  { id: "harvest", run: (state, content) => {
    state.day += 1;
    if (state.day === 91) recordEvent(state, "春耕已过，麦苗渐渐齐整。", content);
    if (state.day === 183) recordEvent(state, "暑气渐盛，田间进入拔节时节。", content);
    if (state.day === content.rules.growingDays) recordEvent(state, "秋收将启，田里麦浪金黄。", content);
    return state.day === content.rules.growingDays && state.agriculture.lastHarvestYear !== state.year ? harvest(state, content) : null;
  } },

  // ── 年终：人口变动、年报、翻年
  { id: "annualReport", when: (state, content) => state.day >= content.rules.daysPerYear, run: (state, content, day) => {
    const householdLifeYear = archiveHouseholdLifeYear(state, content);
    const peopleBefore = populationStats(state);
    day.demography = advancePopulation(state, content);
    syncShopEmployment(state, content);
    const peopleAfter = populationStats(state);
    const report = buildAnnualReport(state, content, {
      householdLifeYear, peopleBefore, peopleAfter, demography: day.demography, closingQeq: totalQeqUnits(state, content)
    });
    state.annualReports.push(report);
    state.year += 1;
    state.day = 0;
    resetYearBooks(state, content);
    return report;
  } },

  // ── 外镇（放最后，不扰动前面系统的随机数流）与历史记录
  { id: "outsideTownYear", when: newYearDay, run: settleOutsideTownYear },
  { id: "wheatLoanYear", when: newYearDay, run: settleWheatLoansYear },
  { id: "tradeAgreementMonth", run: settleTradeAgreementsMonth },
  { id: "tradeAgreementYear", when: newYearDay, run: settleTradeAgreementsYear },
  { id: "outsideTownDay", run: advanceOutsideTownDay },
  { id: "history", run: (state, content) => { recordEconomyHistory(state, content); snapshotWholesaleHistory(state, content); } }
];

// 核心步骤 + 已启用 mod 插入的步骤（mod 步骤 id 为 "<modId>:<stepId>"）。
export const DAILY_STEPS = assembleDailySteps(CORE_DAILY_STEPS, MODS);

export function settleOneDay(state, content) {
  return runDay(state, content, DAILY_STEPS);
}

// 按给定步骤表跑一天（测试可传入带自定义 mod 步骤的表）。
export function runDay(state, content, steps) {
  const beforeTotal = totalQeqUnits(state, content);
  const day = { isNewYearDay: state.day === 0, peopleAtStart: populationStats(state), demography: null };
  for (const step of steps) {
    day[step.id] = !step.when || step.when(state, content, day) ? (step.run(state, content, day) ?? null) : null;
  }
  return {
    ...day,
    wholesaleIntake: { allocation: day.wholesaleTownAllocation, town: day.wholesaleTownOutput, private: day.wholesalePrivateIntake, company: day.wholesaleCompanyIntake },
    shortageQeq: day.meal.missingQeqUnits,
    totalChangeQeqUnits: totalQeqUnits(state, content) - beforeTotal,
    population: populationStats(state)
  };
}
