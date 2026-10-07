import { totalQeqUnits } from "../economy/inventory.js";
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
import { payPensions } from "./social-security.js";
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
import { finalizeMonetaryPaymentDay } from "../economy/payment.js";
import { settleBankDay } from "./bank.js";
import { settleBondsDay } from "./bonds.js";
import { settleStockMarketDay, settleHouseholdStockBuying } from "./stock-exchange.js";
import { settleLiquidityDay } from "./liquidity.js";
import { maybeRefreshHouseholdIncomeExpectations } from "./income-expectation.js";
import { accrueServiceDemand, processServiceDemand } from "./services.js";
import { resetWholesaleDay, resetWholesaleYear, runWholesaleIntake, ensureWholesaleWheatForTown, townMillWheatDemandUnits, snapshotWholesaleHistory, subsidizeWholesaleWheat } from "./wholesale-market.js";
import { applyCompanyDistributionsToAnnualReport, buildAnnualReport } from "./annual-reports.js";
import { settleNeighborAid, resetNeighborAidYear } from "./neighbor-aid.js";

export function settleOneDay(state, content) {
  const beforeTotal = totalQeqUnits(state, content);
  const isNewYearDay = state.day === 0;
  const peopleAtStart = populationStats(state);
  const saltDemandUnits = accrueSaltNeed(state, peopleAtStart.total, content);
  state.financialFlows ||= { day: emptyFinancialFlowPeriod(), year: emptyFinancialFlowPeriod(), cumulative: emptyFinancialFlowPeriod() };
  state.financialFlows.day = emptyFinancialFlowPeriod();
  resetCompanyDaily(state, content);
  resetShopDaily(state, content);
  resetWholesaleDay(state, content);
  clearDailyHouseholdIncome(state);
  resetHouseholdLifeDay(state, content);
  // 新年首日先清空新日账，再结算上一年度利润；居民实际到账立即进入本日/本年/累计投资收入。
  const yearStartCompanyDistributions = state.day === 0 && state.year > 1
    ? settleAnnualCompanyDividends(state, state.year - 1, content) : [];
  if (yearStartCompanyDistributions.length) applyCompanyDistributionsToAnnualReport(state, state.year - 1, yearStartCompanyDistributions);
  // 每年1月1日征收别墅房产税（含补扣历史欠税）。
  const villaTax = state.day === 0 ? settleVillaPropertyTax(state, content) : null;
  accrueServiceDemand(state, content);
  refreshOperatingPlan(state, content);
  arrangePrivateWorkers(state, content);
  arrangeListedWorkers(state, content);
  syncShopEmployment(state, content);
  refillAgricultureToTarget(state, content);
  ensureEmploymentExchangeDay(state, content);
  const laborAtStart = employmentSnapshot(state, content);
  const housingAtStart = selectHousing(state, content);
  state.policy.agricultureTaxRecent ||= [];
  state.policy.agricultureTaxRecent.push({ year: state.year, day: state.day + 1,
    rateBps: Math.round((state.policy.agricultureTaxPercent ?? 50) * 100) });
  state.policy.agricultureTaxRecent = state.policy.agricultureTaxRecent.slice(-(content.rules.agricultureTaxLookbackDays || 30));

  // Reset only the current-day business view; annual and lifetime books remain intact.
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

  // 0. 邻里互助（用户 0.1.11）：缺粮 3 天先由富户接济，自动救济随后补剩余缺口。
  const neighborAid = settleNeighborAid(state, content);
  // 1. Basic relief protects residents before any discretionary payment.
  const relief = applyAutomaticRelief(state, peopleAtStart.total, content);
  // 2. Settle old wage arrears, then today's wages. Builders are captured before completion.
  const wages = payDailyWages(state, laborAtStart, content);
  const companyWages = payListedCompanyWages(state, content);
  const privateWages = payPrivateIndustryWages(state, content);
  // 3. Unemployment benefit uses that same start-of-day employment snapshot.
  const unemployment = payUnemploymentBenefit(state, laborAtStart, content);
  // 3b. 社保基金开启时发放养老金（按老人人数到户）。
  const pension = payPensions(state, content);
  // 4–5. Construction consumes committed materials once; operating buildings then process.
  const construction = advanceConstruction(state, content);
  // 固定调拨先执行，镇营生产者也必须从批发市场取得当日原料。
  const wholesaleTownAllocation = runWholesaleIntake(state, [], [], content, { includeTownAllocation: true });
  // 统购统销保障原料：镇库小麦自动投放市场，供磨坊领用（小麦产权仍归镇库）。
  const wholesaleWheatPreroll = ensureWholesaleWheatForTown(state, content, townMillWheatDemandUnits(state, content));
  // 每日小麦补贴：前期市场不盈利，镇库默认每天给市场1000斤运营资金（政策可调）。
  const wholesaleWheatSubsidy = subsidizeWholesaleWheat(state, content);
  const production = processAllBuildings(state, content);
  // 当日镇营产成品立即回到批发市场，供后续民营、公司与商铺采购。
  const wholesaleTownOutput = runWholesaleIntake(state, production, [], content, { includeTownAllocation: false });
  const privateProduction = processPrivateIndustries(state, content);
  const wholesalePrivateIntake = runWholesaleIntake(state, [], privateProduction, content, { includeTownAllocation: false });
  const companyProduction = processListedCompanies(state, content);
  const wholesaleCompanyIntake = sellCompanyOutputsToWholesale(state, content);
  const wholesaleIntake = { allocation: wholesaleTownAllocation, wheatPreroll: wholesaleWheatPreroll, town: wholesaleTownOutput, private: wholesalePrivateIntake, company: wholesaleCompanyIntake };
  // 6. Shops accrue wages/rent and restock after producers finish.
  const shopPreparation = prepareShopsForDay(state, content);
  // 7. Rent uses the opening occupancy snapshot, so housing completed today earns rent tomorrow.
  const rent = settleHousingRent(state, housingAtStart, content);
  // 7b. 别墅购买：检查空置别墅，按流动资产从高到低撮合富裕家庭购房（购房款进镇库）。
  const villaSales = settleVillaPurchases(state, content);
  // 8. Salt purchase is independent of food, but protects the same thirty-day staple reserve.
  const saltTrade = buySaltForResidents(state, content);
  // 9. 主食购买按固定份额拆分到小麦、面粉、面包，并复核盐后的剩余粮食与预算。
  const trade = buyStaplesForResidents(state, peopleAtStart.total, content);
  // 9b. 主食之后居民再买木材修缮房屋，买入即消耗，不留在家庭库存。
  const repairWood = buyRepairWoodForResidents(state, content);
  // 10. Services spend only the household's remaining discretionary budget after basic living payments.
  const services = processServiceDemand(state, content);
  // 11. Grain and salt are consumed independently; salt never replaces口粮.
  const meal = consumeDailyRations(state, peopleAtStart.total, content);
  const saltMeal = consumeDailySalt(state, content);
  const comfortQeq = meal.moves.reduce(function (sum, move) {
    const item = content.items[move.itemId];
    return sum + move.qeqUnits * (item?.satisfactionPerQeq || 0);
  }, 0);
  const satisfactionInterval = content.rules.satisfactionUpdateIntervalDays || 1;
  const satisfactionSerial = (state.year - 1) * content.rules.daysPerYear + state.day;
  const urgentLifeIssue = meal.missingQeqUnits > 0 || saltMeal.missingUnits > 0 || housingAtStart.shortage > 0 || (wages.unpaidCurrentVoucher || 0) > 0;
  if (urgentLifeIssue || satisfactionSerial % satisfactionInterval === 0 || !state.satisfactionFactors?.householdWeighted) {
    updateSatisfaction(state, peopleAtStart.total, comfortQeq, content, {
      housing: housingAtStart,
      saltCoverage: selectSaltCoverage(state, content).coverage,
      saltGrace: state.salt.graceDaysElapsed < content.rules.saltGraceDays
    });
  }
  finalizeHouseholdLifeDay(state, content);
  // 收入预期：7—30 天随机刷新一次（为下版本满意度/消费/跳槽打地基；本期只计算存储）。
  maybeRefreshHouseholdIncomeExpectations(state, content);
  finishSaltGraceDay(state, content);
  // 11. Finish shop books after retail demand is known.
  const shops = finishShopsDay(state, content, state.day + 1 >= content.rules.daysPerYear);
  recordConsumerDay(state, content);
  // 12. Today's staffed farm labor accrues before the day advances.
  accumulateFarmDay(state, content);
  const endingYearToday = state.day + 1 >= content.rules.daysPerYear;
  finalizeMonetaryPaymentDay(state, content);
  // 流动性日结算：刷新投资比例（五期算法），供银行/国债当日使用。
  settleLiquidityDay(state, content);
  // 银行日结算：存款计息/吸储、贷款计息/还款/核销、公司自动借款（金融扩展二期）。
  settleBankDay(state, content);
  // 国债日结算：认购/拍卖定价、付息、到期还本/展期/违约（金融扩展三期）。
  settleBondsDay(state, content);
  // 股市日结算：AI 做市商驱动股价向利润锚波动（金融扩展四期）。
  settleStockMarketDay(state, content);
  // 住户日常股票买入：按存款/股票倾向分流后的预算在二级市场买入（镇库做市）
  settleHouseholdStockBuying(state, content);

  state.day += 1;
  if (state.day === 91) recordEvent(state, "春耕已过，麦苗渐渐齐整。", content);
  if (state.day === 183) recordEvent(state, "暑气渐盛，田间进入拔节时节。", content);
  if (state.day === content.rules.growingDays) {
    recordEvent(state, "秋收将启，田里麦浪金黄。", content);
  }

  let harvestResult = null;
  if (state.day === content.rules.growingDays &&
      state.agriculture.lastHarvestYear !== state.year) {
    harvestResult = harvest(state, content);
  }

  let demography = null;
  let annualReport = null;
  if (state.day >= content.rules.daysPerYear) {
    const householdLifeYear = archiveHouseholdLifeYear(state, content);
    const peopleBefore = populationStats(state);
    demography = advancePopulation(state, content);
      syncShopEmployment(state, content);
    const peopleAfter = populationStats(state);
    annualReport = buildAnnualReport(state, content, {
      householdLifeYear, peopleBefore, peopleAfter, demography, closingQeq: totalQeqUnits(state, content)
    });
    state.annualReports.push(annualReport);
    state.year += 1;
    state.day = 0;
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
    if (state.industries) {
      for (const industry of Object.values(state.industries)) {
        industry.year = { producedUnits: {}, soldUnits: 0, revenueWheatUnits: 0, operatingWagesWheatUnits: 0 };
      }
    }
    resetPrivateYear(state);
    resetCompanyYear(state, content, state.year - 1);
    resetShopYear(state, content);
    resetWholesaleYear(state, content);
    resetLaborCompetitionYear(state);
    resetNeighborAidYear(state);
    state.financialFlows.year = emptyFinancialFlowPeriod();
    if (state.fiscal) state.fiscal.year = { dueWheatUnits: 0, collectedWheatUnits: 0, waivedWheatUnits: 0 };
    if (state.agriculture?.reclaim) state.agriculture.reclaim.year = { acres: 0, workDays: 0, paidVoucherUnits: 0 };
    if (state.salt) state.salt.year = { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 };
    resetYearHouseholdIncome(state);
    resetHouseholdLifeYear(state, content);
  }
  // 外镇动态放在一日结算末尾：年事件/生产消费在1月1日结算，每日衰减贸易记忆并重算价格。
  // 刻意在既有系统之后推进，避免扰动既有随机数流（存档种子可复现性不受影响）。
  const outsideTownYear = isNewYearDay ? settleOutsideTownYear(state, content) : null;
  // 小麦贷款年结：计息 + 外镇用结余小麦还款（放在年事件之后，有当年收成可还）
  const wheatLoanYear = isNewYearDay ? settleWheatLoansYear(state, content) : null;
  // 长期贸易协定：每月交付 1/12（只从批发市场扣货），年结递减剩余年限。
  const tradeAgreementMonth = settleTradeAgreementsMonth(state, content);
  const tradeAgreementYear = isNewYearDay ? settleTradeAgreementsYear(state, content) : null;
  const outsideTownDay = advanceOutsideTownDay(state, content);
  // 经济历史曲线（用户 0.1.11）：每日收盘后记录，供地图"经济"面板画走势。
  recordEconomyHistory(state, content);
  // 批发市场历史快照（0.1.11 补回）：每日库存/销量/价格，保留30天，供趋势分析。
  snapshotWholesaleHistory(state, content);
  const afterTotal = totalQeqUnits(state, content);
  return {
    construction,
    production,
    privateProduction,
    companyProduction,
    wholesaleIntake,
    shopPreparation,
    shops,
    relief,
    neighborAid,
    companyWages,
    privateWages,
    wages,
    unemployment,
    pension,
    rent,
    villaSales,
    villaTax,
    outsideTownYear,
    outsideTownDay,
    tradeAgreementMonth,
    tradeAgreementYear,
    saltTrade,
    saltMeal,
    trade,
    repairWood,
    services,
    meal,
    harvest: harvestResult,
    demography,
    annualReport,
    yearStartCompanyDistributions,
    shortageQeq: meal.missingQeqUnits,
    totalChangeQeqUnits: afterTotal - beforeTotal,
    population: populationStats(state)
  };
}
