import { privateJobKeyForBuilding, listedJobKeyForBuilding, jobKeyForBuilding, populationStats, readJobCount, selectJobRows } from "./labor.js";
import { isIndustryType } from "../content/buildings.js";
import { accountQeqUnits } from "../economy/inventory.js";
import { voucherBalance } from "../economy/currency.js";
import { currentPaymentComposition, maximumFullyPayableValueUnits, maximumPayableValueUnits, quoteMonetaryPayment, spendableVoucherUnits } from "../economy/payment.js";
import { householdConvertibleWheatUnits, householdList, isActiveHousehold } from "../systems/households.js";
import { currentUnitPrice, theoreticalFullSaleProfitPerWorker } from "../economy/prices.js";
import { selectPublicProcurementDemand } from "../systems/public-procurement.js";
import { companyActualProfitValuation } from "../systems/companies.js";
import { createPaymentViewState } from "../economy/payment-view-state.js";
import { buildingOwner, companyOfBuilding } from "../systems/ownership.js";
import { readWholesalePurchasePrice, wholesaleMonopolyItemIds } from "../systems/wholesale-market.js";


function outputCompetitionStock(state, itemId) {
  const town = state.accounts.town[itemId] || 0;
  const companies = Object.values(state.companies || {}).reduce((sum, company) => sum + (company.inventory?.[itemId] || 0), 0);
  return town + companies;
}

function bakeryDemand(state, content) {
  const scale = content.precision.inventoryUnitsPerJin;
  const population = populationStats(state).total;
  const price = currentUnitPrice(state, "bread", content);
  const share = Math.min(content.rules.breadTargetShareMaximum,
    content.rules.breadTargetShareAtBasePrice * Math.pow(content.rules.breadBasePriceWheatPerJin / price, content.rules.breadPriceElasticity));
  const targetUnits = Math.round(population * content.rules.foodPerPersonDay * share * 1.2 * scale);
  const unmetResidentUnits = Math.max(0, targetUnits - (state.accounts.residents.bread || 0));
  const competitionUnits = outputCompetitionStock(state, "bread");
  const opportunityUnits = Math.max(0, unmetResidentUnits - competitionUnits);
  return {
    demandUnits: unmetResidentUnits,
    competitionUnits,
    opportunityUnits,
    reason: unmetResidentUnits <= 0 ? "居民自有面包已满足参考需求" : opportunityUnits <= 0 ? "现有竞争库存已覆盖居民需求" : "存在居民未满足面包需求"
  };
}

function saltDemand(state, content) {
  const scale = content.precision.inventoryUnitsPerJin;
  const population = populationStats(state).total;
  const dailyUnits = Math.round(population * content.rules.saltAnnualDemandJinPerPerson / content.rules.daysPerYear * scale);
  const unmetResidentUnits = Math.max(0, dailyUnits - (state.accounts.residents.salt || 0));
  const competitionUnits = outputCompetitionStock(state, "salt");
  const opportunityUnits = Math.max(0, unmetResidentUnits - competitionUnits);
  return {
    demandUnits: unmetResidentUnits,
    competitionUnits,
    opportunityUnits,
    reason: unmetResidentUnits <= 0 ? "居民自有食盐已满足当日需求" : opportunityUnits <= 0 ? "现有竞争库存已覆盖食盐需求" : "存在居民未满足食盐需求"
  };
}

function millDemand(state, content) {
  const scale = content.precision.inventoryUnitsPerJin;
  const flourPrice = currentUnitPrice(state, "flour", content);
  // 下游面包房需求：民营面包房 + 镇营面包房（镇里自己的面包房也要面粉，按镇营岗位人数算）。
  let privateDemandUnits = 0;
  for (const building of state.buildings.filter(row => row.typeId === "bakery" && ((row.ownership?.privateLevels || 0) > 0 || (row.ownership?.townLevels || 0) > 0))) {
    const definition = content.buildings.bakery;
    const recipe = content.recipes[definition.recipeId];
    const job = definition.jobs[0];
    const ownerKey = (building.ownership?.privateLevels || 0) > 0 ? privateJobKeyForBuilding(building.id, job.id) : jobKeyForBuilding(building.id, job.id);
    const workers = readJobCount(state, ownerKey);
    privateDemandUnits += Math.round(workers * recipe.batchesPerWorkerDay * recipe.inputs[0].quantity * scale);
  }
  privateDemandUnits = Math.max(0, privateDemandUnits - (state.accounts.residents.flour || 0));

  let listedDemandUnits = 0;
  for (const company of Object.values(state.companies || {}).filter(row => row.typeId === "bakery")) {
    const definition = content.buildings.bakery;
    const recipe = content.recipes[definition.recipeId];
    const job = definition.jobs[0];
    const workers = readJobCount(state, listedJobKeyForBuilding(company.buildingId, job.id));
    const need = Math.round(workers * recipe.batchesPerWorkerDay * recipe.inputs[0].quantity * scale);
    const shortage = Math.max(0, need - (company.inventory?.flour || 0));
    const budget = maximumFullyPayableValueUnits(state, `company:${company.id}`, maximumPayableValueUnits(state, `company:${company.id}`, content), content);
    const affordable = flourPrice > 0 ? Math.floor(budget * content.precision.inventoryUnitsPerJin / (flourPrice * content.precision.currencyUnitsPerVoucher)) : 0;
    listedDemandUnits += Math.min(shortage, affordable);
  }
  const listedCompetitionUnits = (state.accounts.town.flour || 0) + Object.values(state.companies || {}).reduce((sum, company) =>
    sum + (company.typeId === "bakery" ? 0 : (company.inventory?.flour || 0)), 0);
  const listedOpportunityUnits = Math.max(0, listedDemandUnits - listedCompetitionUnits);
  const opportunityUnits = privateDemandUnits + listedOpportunityUnits;
  const demandUnits = privateDemandUnits + listedDemandUnits;
  return {
    demandUnits,
    competitionUnits: listedCompetitionUnits,
    opportunityUnits,
    reason: demandUnits <= 0 ? "暂无面粉需求" : opportunityUnits <= 0 ? "面粉库存已满足需求" : "有面粉需求"
  };
}

function woodDemand(state, content) {
  const procurement = selectPublicProcurementDemand(state, "wood", content);
  if (!procurement.active) return { demandUnits: 0, competitionUnits: 0, opportunityUnits: 0, reason: "暂无采购需求", procurement };
  if (procurement.fundedUnits <= 0) return { demandUnits: procurement.wantedUnits, competitionUnits: 0, opportunityUnits: 0, reason: procurement.reason, procurement };
  const competitionUnits = (state.accounts.residents.wood || 0) + Object.values(state.companies || {}).reduce((sum, company) => sum + (company.inventory?.wood || 0), 0);
  const opportunityUnits = Math.max(0, procurement.fundedUnits - competitionUnits);
  return {
    demandUnits: procurement.fundedUnits,
    competitionUnits,
    opportunityUnits,
    reason: opportunityUnits <= 0 ? "现有民营/企业木材库存已足以覆盖采购需求" : procurement.reason,
    procurement
  };
}

function demandForType(state, typeId, content) {
  if (typeId === "bakery") return bakeryDemand(state, content);
  if (typeId === "saltworks") return saltDemand(state, content);
  if (typeId === "mill") return millDemand(state, content);
  if (typeId === "lumberyard") return woodDemand(state, content);
  // 其他产业：按经营计划算出的需求（含下游原料需求）。
  const itemId = content.recipes[content.buildings[typeId]?.recipeId]?.outputs?.[0]?.itemId;
  const demandUnits = Math.max(0, state.market?.operatingPlan?.demand?.[typeId]?.demandUnits || 0);
  const competitionUnits = itemId ? outputCompetitionStock(state, itemId) : 0;
  const opportunityUnits = Math.max(0, demandUnits - competitionUnits);
  return { demandUnits, competitionUnits, opportunityUnits, reason: demandUnits <= 0 ? "暂无需求" : opportunityUnits <= 0 ? "现有库存已覆盖需求" : "存在未满足需求" };
}

// 整栋经营权预览（docs/OWNERSHIP.md 第 1 条）。
// 价值口径：民营/公司业主实际拿到的是批发收购价减去实物生产税，所以产出按收购价折算；
// 产出受限于原料能否领到（镇库小麦 / 批发市场现有库存），不假设无限原料。
// 整栋价格 = 整栋估值（不再按级）；买家 = 付得起整栋价的家底最多的一户（不合资）。
// 字段名沿用旧版（priceWheatJin、buyerGroup 等），界面不必同步改名。
export function selectOperatingRightPreview(state, buildingId, content, requestedPrice) {
  const paymentState = createPaymentViewState(state);
  const building = state.buildings.find(row => row.id === buildingId);
  if (!building) return { available: false, reason: "建筑不存在" };
  if (!isIndustryType(content, building.typeId)) return { available: false, reason: "该建筑不开放经营权出售" };
  const hasProject = (state.projects || []).some(project => project.buildingId === buildingId || project.plotId === building.plotId);
  const level = Math.max(1, building.level || 1);
  const owner = buildingOwner(state, building);
  const definition = content.buildings[building.typeId];
  const job = definition.jobs[0];
  const recipe = content.recipes[definition.recipeId];
  const taxPercent = state.policy.privateProductionTaxPercent?.[building.typeId] ?? content.rules.privateProductionTaxDefaultPercent ?? 10;
  const output = recipe.outputs[0];
  const sellPrice = currentUnitPrice(state, output.itemId, content);
  // 业主拿到的是收购价（无批发市场时为 0，即没有可成交的产品口径）。
  const outputPrice = readWholesalePurchasePrice(state, output.itemId, content);
  const demand = demandForType(paymentState, building.typeId, content);
  const scale = content.precision.inventoryUnitsPerJin;
  const moneyScale = content.precision.currencyUnitsPerVoucher || scale;
  const rows = selectJobRows(state, content);
  const townKey = building.id + "::" + job.id;
  const publicWorkers = readJobCount(state, townKey);
  const availableLabor = Math.min(job.slots * level, publicWorkers + rows.idle);
  const outputUnitsPerBatch = Math.round(output.quantity * scale);
  const taxKeep = Math.max(0, 1 - taxPercent / 100);
  const netOutputUnitsPerBatch = Math.max(0, Math.floor(outputUnitsPerBatch * taxKeep));
  // 原料可得性：小麦在镇库；其余原料看批发市场现有库存。
  const market = state.wholesaleMarket || {};
  const inputBatchLimits = recipe.inputs.map(row => {
    const stock = row.itemId === "wheat"
      ? Math.max(0, state.accounts?.town?.wheat || 0)
      : (wholesaleMonopolyItemIds(content).includes(row.itemId) ? Math.max(0, market.inventory?.[row.itemId] || 0) : 0);
    const perBatchUnits = row.quantity * scale;
    return perBatchUnits > 0 ? Math.floor(stock / perBatchUnits) : Number.POSITIVE_INFINITY;
  });
  const inputBatchCap = inputBatchLimits.length ? Math.min(...inputBatchLimits) : Number.POSITIVE_INFINITY;
  const maxDailyBatchesByLabor = availableLabor * recipe.batchesPerWorkerDay;
  const maxDailyBatchesByDemand = netOutputUnitsPerBatch > 0 ? Math.floor(demand.opportunityUnits / netOutputUnitsPerBatch) : 0;
  const maxBatches = Math.max(0, Math.min(maxDailyBatchesByLabor, maxDailyBatchesByDemand, inputBatchCap));
  const effectiveWorkers = maxBatches > 0 ? Math.ceil(maxBatches / recipe.batchesPerWorkerDay) : 0;
  const outputValue = maxBatches * output.quantity * outputPrice * (1 - taxPercent / 100);
  const inputCost = recipe.inputs.reduce((sum, row) => sum + maxBatches * row.quantity * currentUnitPrice(state, row.itemId, content), 0);
  const wageRate = state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 0;
  const wageCost = effectiveWorkers * wageRate;
  const dailyNetWheatJin = outputValue - inputCost - wageCost;
  const theoreticalAnnual = Number.isFinite(dailyNetWheatJin) ? dailyNetWheatJin * content.rules.daysPerYear : 0;

  // 优先使用同一建筑公司最近365个日历日的实际净利润（公司即整栋，无需再按级折算）。
  const company = companyOfBuilding(state, buildingId);
  const actual = company ? companyActualProfitValuation(state, company, content) : null;
  let referencePriceWheatJin = 0;
  let valuationBasis = "利润法资料不足；理论满产估算单独列示。";
  let actualAnnualProfitWheatJin = 0;
  let actualObservedDays = actual?.observedDays || 0;
  let annualizedEstimateWheatJin = 0;
  if (actual && actual.observedDays > 0) {
    actualAnnualProfitWheatJin = actual.actualProfitVoucherUnits / moneyScale;
    annualizedEstimateWheatJin = actual.annualizedProfitVoucherUnits / moneyScale;
    if (actual.validProfitMethod) {
      referencePriceWheatJin = Math.max(0, annualizedEstimateWheatJin * 5);
      valuationBasis = `最近${actual.observedDays}个日历日实际净利润（含停工日）年化后×5年；整栋估值。`;
    } else {
      valuationBasis = `已观察${actual.observedDays}个日历日，实际净利润未形成正的利润法参考价；理论估算仅作旁注。`;
    }
  }
  const theoreticalFiveYear = Math.max(0, theoreticalAnnual * 5);
  if (referencePriceWheatJin <= 0 && actualObservedDays === 0) referencePriceWheatJin = theoreticalFiveYear;
  if (!Number.isFinite(referencePriceWheatJin)) referencePriceWheatJin = 0;

  const storedPriceUnits = state.market.operatingRightPrices?.[buildingId];
  const priceWheatJin = requestedPrice ?? (Number.isSafeInteger(storedPriceUnits)
    ? storedPriceUnits / moneyScale : Math.floor(referencePriceWheatJin * 100) / 100);
  const population = populationStats(state).total;
  const residentReserveUnits = Math.round(population * content.rules.foodPerPersonDay * content.rules.operatingRightReserveDays * content.precision.qeqUnitsPerJin);
  const currentResidentQeq = accountQeqUnits(state, "residents", content);
  const costUnits = Math.round(priceWheatJin * moneyScale);
  const minimumPerCapita = content.rules.householdLiving?.difficultPerCapitaVoucher ?? 30;
  const investmentRows = householdList(state).filter(isActiveHousehold).map(household => {
    const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
    const totalValue = spendableVoucherUnits(state, `household:${household.id}`) + Math.floor(maxWheatUnits * moneyScale / scale);
    const livingReserve = Math.round((household.ageBands?.children || 0) + (household.ageBands?.workers || 0) + (household.ageBands?.elders || 0)) * minimumPerCapita * moneyScale;
    const investableValue = Math.max(0, totalValue - livingReserve);
    const canPayPrice = investableValue >= costUnits && costUnits > 0 && quoteMonetaryPayment(paymentState, `household:${household.id}`, currentPaymentComposition(paymentState, costUnits), content, { maxWheatUnits }).full;
    return { household, maxWheatUnits, totalValue, roughValue: investableValue, canPayPrice };
  });
  // 买家：付得起整栋价格的家庭里，家底（粮券 + 可换小麦）最多的一户。
  const buyerRow = investmentRows.filter(row => row.canPayPrice)
    .sort((a, b) => b.totalValue - a.totalValue || a.household.id.localeCompare(b.household.id))[0] || null;
  const buyerCandidate = buyerRow ? {
    householdId: buyerRow.household.id,
    householdName: buyerRow.household.name || `居民户${buyerRow.household.id}`,
    totalValueVoucher: buyerRow.totalValue / moneyScale
  } : null;
  const buyerGroup = buyerCandidate ? [{ ...buyerCandidate, contributionVoucherUnits: costUnits }] : [];
  const canPay = Boolean(buyerCandidate);
  const totalInvestableVoucher = investmentRows.reduce((sum, row) => sum + row.roughValue, 0) / moneyScale;
  const maxHouseholdPayVoucher = investmentRows.reduce((max, row) => Math.max(max, row.roughValue), 0) / moneyScale;
  const keepsReserve = currentResidentQeq >= residentReserveUnits;
  const attractive = referencePriceWheatJin > 0 && priceWheatJin <= referencePriceWheatJin;
  const isTownOwned = owner.kind === "town";
  const ownerBlocked = !isTownOwned ? (owner.kind === "household" ? "这栋建筑已归民营，不能再整栋出售" : "这栋建筑已归公司，不能整栋出售") : null;
  const reason = ownerBlocked
    || (hasProject ? "施工或升级期间不能出售" : null)
    || (!canPay && priceWheatJin > 0 ? "即使家底最多的一户也付不起整栋价格" : null)
    || (!keepsReserve ? "居民基本口粮不足90天储备" : null)
    || (!attractive ? "预期收益缺乏吸引力" : null);
  const demandFactor = demand.demandUnits > 0 ? Math.max(0, Math.min(1, demand.opportunityUnits / demand.demandUnits)) : 0;
  const theoretical = theoreticalFullSaleProfitPerWorker(state, building.typeId, content);
  const privateWorkers = readJobCount(state, privateJobKeyForBuilding(buildingId, job.id));
  const listedWorkers = readJobCount(state, listedJobKeyForBuilding(buildingId, job.id));
  return {
    available: isTownOwned && !hasProject && priceWheatJin > 0 && canPay && keepsReserve && attractive,
    reason,
    buildingId, typeId: building.typeId, level,
    owner,
    townLevels: building.ownership?.townLevels ?? level, privateLevels: building.ownership?.privateLevels || 0, listedLevels: building.ownership?.listedLevels || 0,
    townCapacityBefore: isTownOwned ? level * job.slots : 0,
    townCapacityAfter: 0,
    publicWorkers, transferableWorkers: publicWorkers, privateWorkers, listedWorkers,
    workersAvailable: availableLabor,
    priceWheatJin, maximumPriceWheatJin: referencePriceWheatJin,
    valuationWheatJin: referencePriceWheatJin,
    referencePriceWheatJin,
    actualObservedDays,
    actualProfitObservedWheatJin: actualAnnualProfitWheatJin,
    annualizedActualProfitWheatJin: annualizedEstimateWheatJin,
    theoreticalAnnualProfitWheatJin: theoreticalAnnual,
    theoreticalFiveYearWheatJin: theoreticalFiveYear,
    dailyNetWheatJin: Number.isFinite(dailyNetWheatJin) ? dailyNetWheatJin : 0,
    annualReferenceNetWheatJin: annualizedEstimateWheatJin || theoreticalAnnual,
    estimatedAnnualReferenceReturn: annualizedEstimateWheatJin || theoreticalAnnual,
    outputItemId: output.itemId,
    outputPriceVoucherPerUnit: outputPrice, itemPriceVoucher: outputPrice,
    sellPriceVoucherPerUnit: sellPrice,
    inputPricesVoucherPerUnit: Object.fromEntries(recipe.inputs.map(row => [row.itemId, currentUnitPrice(state, row.itemId, content)])),
    inputPricesVoucher: Object.fromEntries(recipe.inputs.map(row => [row.itemId, currentUnitPrice(state, row.itemId, content)])),
    inputBatchCap: Number.isFinite(inputBatchCap) ? inputBatchCap : null,
    taxPercent, wageRateVoucher: wageRate,
    demandFactor, demandUnits: demand.demandUnits, competitionUnits: demand.competitionUnits, opportunityUnits: demand.opportunityUnits,
    dailyDemandJin: demand.demandUnits / scale, competitionStockJin: demand.competitionUnits / scale, unmetDemandJin: demand.opportunityUnits / scale,
    demandReason: demand.reason, demandBasis: valuationBasis, valuationBasis,
    theoreticalFullSaleProfitPerWorkerVoucher: theoretical?.profitVoucher ?? 0,
    canPay, groupCanPay: canPay, buyer: buyerCandidate, buyerGroup,
    keepsReserve, attractive,
    residentInvestableFundsVoucher: totalInvestableVoucher,
    maxHouseholdPayVoucher,
    residentWheatJin: (state.accounts.residents.wheat || 0) / scale,
    residentVoucher: voucherBalance(state, "residents") / moneyScale,
    reserveDays: content.rules.operatingRightReserveDays,
    maxWilling: referencePriceWheatJin > 0
  };
}
