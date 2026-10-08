import { BUILDING_PRESENTATION } from "../content/world.js";
import { MODS } from "../mods/registry.js";
import { selectModViews } from "../mods/api.js";
import { industryTypeIds, isIndustryType } from "../content/buildings.js";
import { experienceBonus, industryWorkerDays, levelBonus, productivityFactor } from "../economy/productivity.js";
import { populationStats, selectJobRows, readJobCount, jobKeyForBuilding, privateJobKeyForBuilding, listedJobKeyForBuilding } from "./labor.js";
import { selectAccounts, selectFoodDays, selectTotalQeq } from "./economy.js";
import { productionStatus } from "./production.js";
import { selectHarvestForecast } from "./agriculture.js";
import { reclaimCostEstimate, reclaimWorkDaysForAcres, reclaimedAcres, reclaimedAcresMaximum } from "../systems/agriculture.js";
import { qeqUnitsToJin } from "../economy/inventory.js";
import { selectHousing } from "./housing.js";
import { selectSaltCoverage } from "../systems/salt.js";
import { selectDemolitionPreview, selectUpgradePreview } from "../systems/building-development.js";
import { selectOperatingRightPreview } from "./operating-rights.js";
import { companySummary, previewShareSubscription, companyWorkingCapitalReserve } from "../systems/companies.js";
import { hasStockExchange, stockReference } from "../systems/stock-exchange.js";
import { selectIpoView } from "./ipo.js";
import { previewTownMaterialProcurement, selectPublicProcurementDemand } from "../systems/public-procurement.js";
import { currentPriceMap, currentUnitPrice } from "../economy/prices.js";
import { computeLaborMarket } from "../systems/labor-market.js";
import { computeWealthStats } from "../systems/wealth-stats.js";
import { currencyScale, validateCurrencyInvariant, voucherBalance } from "../economy/currency.js";
import { hasBankAccess } from "../economy/payment.js";
import { WAGE_CONTROL_CIVIL_ROLE_IDS } from "../systems/payroll.js";
import { householdLivingSummary, occupationCounts, householdPopulation, householdIdleWorkers } from "../systems/households.js";
import { bondOutstandingVoucherUnits } from "../systems/bonds.js";
import { stallSquareSummaries, shopSummaries } from "../systems/shops.js";
import { wholesaleSummary, wholesaleTrends, hasWholesaleMarket, purchasePriceFeedback, PURCHASE_PRICE_FLOOR_RATIO } from "../systems/wholesale-market.js";
import { selectOutsideTownView } from "../systems/outside-town.js";
import { DEFAULT_OUTSIDE_TOWN_ID } from "../content/outside-towns.js";
import { selectTradeAgreementView } from "../systems/trade-agreements.js";
import { householdRecentTotalsReadonly, householdFoodDays } from "../systems/household-life.js";
import { createDashboardRuntime, employmentExchangeRemainingUnits } from "./dashboard-runtime.js";
import { selectVillaStats } from "../systems/villas.js";
import { selectSocialSecurityStats } from "../systems/social-security.js";

export function selectSeason(day) {
  if (day < 91) return { key: "spring", name: "春", field: "麦苗返青", index: day + 1 };
  if (day < 183) return { key: "summer", name: "夏", field: "麦穗抽长", index: day - 90 };
  if (day < 274) return { key: "autumn", name: "秋", field: "金穗待收", index: day - 182 };
  return { key: "winter", name: "冬", field: "田间休整", index: day - 273 };
}

// 面板只读视图：已开荒/上限、可选亩数、工日与镇库预计工资。
export function selectReclaimView(state, content) {
  const current = reclaimedAcres(state, content);
  const maximum = reclaimedAcresMaximum(content);
  const batch = content.agriculture.reclaimAcresPerBatch || 100;
  const remaining = Math.max(0, maximum - current);
  const step = remain => Math.min(batch, remain);
  const nextBatch = step(remaining);
  const estimate = reclaimCostEstimate(state, content, nextBatch);
  const ledger = state.agriculture?.reclaim || {};
  const scale = currencyScale(content);
  const paidVoucherUnits = ledger.cumulative?.paidVoucherUnits || 0;
  return {
    current, maximum, remaining,
    batchAcres: batch,
    nextAcres: nextBatch,
    nextWorkDays: estimate.workDays,
    nextVoucher: estimate.estimatedVoucher,
    wagePerWorkerDay: estimate.wagePerWorkerDay,
    wageRoleId: estimate.wageRoleId,
    workDaysPerBatch: reclaimWorkDaysForAcres(batch, content),
    canReclaim: remaining > 0,
    day: { ...(ledger.day || {}) },
    year: { ...(ledger.year || {}) },
    cumulative: { ...(ledger.cumulative || {}), paidVoucher: paidVoucherUnits / scale },
    last: ledger.last ? { ...ledger.last } : null,
    history: (ledger.history || []).slice(-5).reverse()
  };
}

function companyActualReferencePlaceholder(company, content) {
  return { observedDays: (company.history || []).length, validProfitMethod: false, basis: "尚未上市；经营业绩仍按实际日历日记录", referenceCompanyValueVoucherUnits: 0, referencePerShareVoucherUnits: 0, scale: currencyScale(content) };
}

export function selectConstructionOptions(state, content, context = {}) {
  const runtime = context.runtime || createDashboardRuntime(state);
  const labor = context.labor || selectJobRows(state, content, runtime);
  const currentBuilders = readJobCount(state, "builders", runtime);
  const projects = state.projects || [];
  return Object.values(content.buildings).map(function (definition) {
    const project = projects.find(row => row.kind !== "upgrade" && row.typeId === definition.id) || null;
    const count = runtime.buildingTypeCounts.get(definition.id) || 0;
    // 该类型“已建 + 在建”合计达到 maxInstances 才不可再建；工程数量本身不设人为上限。
    const pendingCount = projects.filter(row => row.kind !== "upgrade" && row.typeId === definition.id).length;
    const builderSlots = content.rules.builderSlots || definition.construction.recommendedWorkers;
    // 该类型新工程的施工口径：待业劳力 + 尚未挂到工程上的既有营造工，
    // 再受本类型推荐人数与营造岗位总量上限约束；不再把其他工程的人算进来。
    const assignedBuilders = projects.reduce((sum, row) => sum + Math.max(0, Math.floor(row.workers || 0)), 0);
    const unassignedBuilders = Math.max(0, currentBuilders - assignedBuilders);
    const previewBuilders = Math.min(builderSlots, Math.max(unassignedBuilders,
      Math.min(definition.construction.recommendedWorkers, unassignedBuilders + labor.idle)));
    const estimatedDays = previewBuilders > 0 ? Math.ceil(definition.construction.workDays / previewBuilders) : null;
    const builderWage = state.employment.wageRates?.builders ?? content.roles.builders?.wagePerWorkerDay ?? 5;
    const allowedPlots = definition.requiredPlotFeature
      ? runtime.plotsByFeature.get(definition.requiredPlotFeature) || []
      : runtime.ordinaryPlots;
    const openPlots = allowedPlots.filter(function (plot) {
      return !runtime.buildingByPlotId.has(plot.id) &&
        !projects.some(project => project.plotId === plot.id);
    });
    const materials = (definition.materialRequirements || []).map(function (row) {
      const scale = content.precision.inventoryUnitsPerJin;
      const townAvailableUnits = state.accounts.town[row.itemId] || 0;
      const requiredUnits = Math.round(row.quantity * scale);
      const marketNeedUnits = Math.max(0, requiredUnits - townAvailableUnits);
      const market = previewTownMaterialProcurement(state, row.itemId, marketNeedUnits, content);
      const effectiveUnits = townAvailableUnits + market.purchasableUnits;
      return {
        itemId: row.itemId,
        name: content.items[row.itemId]?.name || row.itemId,
        unit: content.items[row.itemId]?.unit || "单位",
        required: row.quantity,
        available: townAvailableUnits / scale,
        marketAvailable: market.totalAvailableUnits / scale,
        wholesaleAvailable: (market.wholesaleAvailableUnits || 0) / scale,
        residentMarketAvailable: market.residentAvailableUnits / scale,
        companyMarketAvailable: market.companyAvailableUnits / scale,
        marketPurchasable: market.purchasableUnits / scale,
        marketCostVoucher: market.costVoucherUnits / currencyScale(content),
        missing: Math.max(0, requiredUnits - effectiveUnits) / scale
      };
    });
    return {
      id: definition.id,
      name: definition.name,
      icon: definition.icon,
      description: definition.description,
      built: count > 0,
      count,
      pendingCount,
      project,
      unavailable: (count + pendingCount) >= (definition.maxInstances ?? Infinity) || openPlots.length === 0,
      maxInstances: definition.maxInstances ?? Infinity,
      estimatedWageJin: estimatedDays ? previewBuilders * builderWage * estimatedDays : 0,
      affordable: true,
      workDays: definition.construction.workDays,
      recommendedWorkers: definition.construction.recommendedWorkers,
      constructionCrewDays: estimatedDays,
      previewBuilders, waitingForWorkers: previewBuilders <= 0,
      requiredPlotFeature: definition.requiredPlotFeature || null,
      allowedPlotIds: allowedPlots.map(plot => plot.id),
      availablePlotCount: openPlots.length,
      materials,
      materialsAffordable: materials.every(row => row.missing <= 1 / content.precision.inventoryUnitsPerJin),
      jobs: definition.jobs,
      recipe: content.recipes[definition.recipeId]
    };
  });
}

// 人均产出展示口径：熟练度上限 50%，百分比保留 1 位，系数保留 2 位。
const PRODUCTIVITY_MAX_PERCENT = 50;

function productivityView(state, typeId, level, content) {
  if (!isIndustryType(content, typeId)) {
    return { productivityFactor: null, levelBonusPercent: null, experienceBonusPercent: null };
  }
  return {
    productivityFactor: Math.round(productivityFactor(state, typeId, level) * 100) / 100,
    levelBonusPercent: Math.round((levelBonus(level) - 1) * 100),
    experienceBonusPercent: Math.round((experienceBonus(state, typeId) - 1) * 1000) / 10
  };
}

function industryProductivityRows(state, content) {
  return industryTypeIds(content).map(function (typeId) {
    return {
      typeId,
      name: content.buildings[typeId]?.name || typeId,
      workerDays: Math.floor(industryWorkerDays(state, typeId)),
      experiencePercent: Math.round((experienceBonus(state, typeId) - 1) * 1000) / 10,
      maxPercent: PRODUCTIVITY_MAX_PERCENT
    };
  });
}

export function selectDashboard(state, content, selection) {
  const panel = selection?.panel || "all";
  const full = panel === "all";
  const needResidents = full || panel === "residents";
  const needBusiness = full || panel === "business";
  const needPolicy = full || panel === "policy" || panel === "settings";
  const needBuild = full || panel === "build";
  const needSite = full || panel === "site";
  const runtime = createDashboardRuntime(state);
  const households = runtime.households;
  const people = populationStats(state);
  const labor = selectJobRows(state, content, runtime);
  labor.dailyWageExpectedWheatJin = labor.rows.reduce(function (sum, row) {
    return sum + (row.scope === "private" || row.scope === "listed" || row.roleId === "farmers" ? 0 : row.count * row.wagePerWorkerDay);
  }, 0);
  const laborRowByKey = new Map(labor.rows.map(row => [row.key, row]));
  const accounts = selectAccounts(state, content);
  const needHousing = full || needResidents || needBusiness || needSite;
  const housing = needHousing ? selectHousing(state, content) : { capacity: 0, shortage: 0, rentals: [], householdHousing: [] };
  const housingRentalByBuilding = new Map((housing.rentals || []).map(row => [row.buildingId, row]));
  const selectedBuildingId = selection?.site?.startsWith("building:") ? selection.site.slice("building:".length) : null;
  // 外镇选择：界面传入 selection.outsideTownId；未知或缺省时用默认外镇。
  const outsideTownIds = Object.keys(content.outsideTowns || {});
  const outsideTownId = outsideTownIds.includes(selection?.outsideTownId) ? selection.outsideTownId : DEFAULT_OUTSIDE_TOWN_ID;
  const outsideTownViews = needBusiness ? outsideTownIds.map(id => selectOutsideTownView(state, content, id)).filter(Boolean) : [];
  const buildings = state.buildings.map(function (building) {
    const definition = content.buildings[building.typeId];
    const ownership = building.ownership || { townLevels: building.level || 1, privateLevels: 0, listedLevels: 0 };
    const includeSiteDetails = full || (needSite && selectedBuildingId === building.id);
    const rental = includeSiteDetails ? housingRentalByBuilding.get(building.id) || null : null;
    const privateState = includeSiteDetails ? runtime.privateDayByBuildingId.get(building.id) : null;
    const jobs = definition ? definition.jobs.map(function (job) {
      const laborRow = laborRowByKey.get(`${building.id}::${job.id}`);
      return {
        id: job.id,
        name: job.name,
        workers: readJobCount(state, jobKeyForBuilding(building.id, job.id), runtime),
        capacity: job.capacityMode === "building" ? job.slots : job.slots * Math.max(0, ownership.townLevels ?? building.level ?? 1),
        wagePerWorkerDay: state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 5,
        poachable: laborRow?.poachable || 0,
        globalDemandKind: laborRow?.globalDemandKind || null,
        globalDemand: laborRow?.globalDemand ?? null,
        globalInPost: laborRow?.globalInPost ?? null,
        globalShortage: laborRow?.globalShortage ?? null,
        outputToday: state.business?.buildings?.[building.id]?.todayOutputUnits || {},
        outputYear: state.business?.buildings?.[building.id]?.yearOutputUnits || {},
        outputLifetime: state.business?.buildings?.[building.id]?.lifetimeOutputUnits || {}
      };
    }) : [];
    const privateJobs = includeSiteDetails && definition ? definition.jobs.map(function (job) {
      return { id: job.id, name: job.name,
        workers: readJobCount(state, privateJobKeyForBuilding(building.id, job.id), runtime),
        capacity: job.slots * (ownership.privateLevels || 0),
        wagePerWorkerDay: state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 0 };
    }) : [];
    const listedJobs = includeSiteDetails && definition ? definition.jobs.map(function (job) {
      const company = runtime.companyByBuildingId.get(building.id);
      return { id: job.id, name: job.name,
        workers: readJobCount(state, listedJobKeyForBuilding(building.id, job.id), runtime),
        capacity: job.slots * (ownership.listedLevels || 0),
        wagePerWorkerDay: Number.isFinite(company?.settings?.wagePerWorkerDay)
          ? company.settings.wagePerWorkerDay
          : (state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 0) };
    }) : [];
    const result = {
      id: building.id,
      typeId: building.typeId,
      level: Math.max(1, Math.min(content.rules.buildingMaxLevel || 10, building.level || 1)),
      ownership: { townLevels: ownership.townLevels ?? building.level ?? 1, privateLevels: ownership.privateLevels || 0, listedLevels: ownership.listedLevels || 0 },
      materialInvestments: building.materialInvestments || [],
      plotId: building.plotId,
      x: building.x,
      y: building.y,
      name: definition ? definition.name : building.typeId,
      icon: definition ? definition.icon : "🏚️",
      status: definition?.housingCapacity
        ? { status: "housing", label: "已落成 · 可入住" }
        : productionStatus(state, building, content),
      housing: rental,
      jobs,
      privateJobs,
      listedJobs,
      companyId: runtime.companyByBuildingId.get(building.id)?.id || null,
      privateStatus: includeSiteDetails ? (privateState?.status || ((ownership.privateLevels || 0) > 0 ? "no_demand" : "not_private")) : null,
      privateReason: includeSiteDetails ? (privateState?.reason || null) : null,
      privateInputPurchases: includeSiteDetails ? (privateState?.inputPurchases || []) : [],
      privateOutputToday: includeSiteDetails ? (privateState?.taxRows || []) : [],
      privateStock: includeSiteDetails ? (function () {
        const recipe = definition?.recipeId ? content.recipes[definition.recipeId] : null;
        const itemIds = new Set([...(recipe?.inputs || []), ...(recipe?.outputs || [])].map(row => row.itemId));
        return Object.fromEntries(Array.from(itemIds, itemId => [itemId, {
          residents: state.accounts.residents[itemId] || 0, town: state.accounts.town[itemId] || 0
        }]));
      })() : {},
      // 民营原料从批发市场采购、产品按批发市场收购价预期：面板不再展示容易误解的"居民/镇库"全局库存，
      // 改为展示批发市场采购价/市场存货（原料）与预期售价（产品）。
      // 纯读：不用 wholesaleUnitPrice/wholesalePurchasePrice（内部 ensureWholesaleMarket 会写状态，selector 禁写）。
      privateMarket: includeSiteDetails ? (function () {
        const recipe = definition?.recipeId ? content.recipes[definition.recipeId] : null;
        const market = state.wholesaleMarket;
        if (!recipe || !hasWholesaleMarket(state) || !market) return [];
        const scale = content.precision.inventoryUnitsPerJin;
        const salePriceOf = (itemId) => {
          const v = Number(market.pricesVoucherPerUnit?.[itemId]);
          if (Number.isFinite(v) && v > 0) return v;
          if (itemId === "wheat") return content.rules.marketPricesVoucherPerUnit?.[itemId] ?? content.rules.wholesaleDefaultSalePrices?.[itemId] ?? 1;
          return content.rules.wholesaleDefaultSalePrices?.[itemId]
            ?? content.rules.marketPricesVoucherPerUnit?.[itemId] ?? content.rules.wholesaleDefaultSalePrices?.[itemId] ?? 1;
        };
        const purchasePriceOf = (itemId) => {
          const reference = Number(market.purchasePriceReferenceVoucherPerUnit?.[itemId] || market.purchasePricesVoucherPerUnit?.[itemId] || 0);
          if (!(reference > 0)) return 0;
          const feedback = purchasePriceFeedback(market, itemId, content);
          return Math.max(reference * PURCHASE_PRICE_FLOOR_RATIO, reference * feedback);
        };
        const rows = [];
        for (const input of recipe.inputs || []) {
          const itemId = input.itemId;
          rows.push({
            itemId, kind: "input",
            priceVoucherPerJin: salePriceOf(itemId),
            marketStockJin: (itemId === "wheat" ? (state.accounts?.town?.wheat || 0) : (market.inventory?.[itemId] || 0)) / scale
          });
        }
        for (const output of recipe.outputs || []) {
          rows.push({ itemId: output.itemId, kind: "output", priceVoucherPerJin: purchasePriceOf(output.itemId) });
        }
        return rows;
      })() : [],
      operatingRight: includeSiteDetails ? selectOperatingRightPreview(state, building.id, content) : null,
      // 用户 0.1.11：镇营目标日产量（斤，0 表示按人手满产）与主产出品。
      outputTargetJin: building.outputTargetJin || 0,
      mainOutputItemId: definition?.recipeId ? content.recipes[definition.recipeId]?.outputs?.[0]?.itemId || null : null,
      // 人均产出（劳动生产率）：仅产业建筑有；等级加成与熟练度加成拆开展示。
      ...productivityView(state, building.typeId, Math.max(1, Math.min(content.rules.buildingMaxLevel || 10, building.level || 1)), content)
    };
    return result;
  });
  const options = (needBuild || needSite) ? selectConstructionOptions(state, content, { runtime, labor }) : [];
  // 在建工程列表：每个工程各自带名称、进度、投入人数与预计工期/工资。
  const builderWage = state.employment.wageRates?.builders ?? content.roles.builders?.wagePerWorkerDay ?? 5;
  const projectViews = (state.projects || []).map(function (project) {
    const definition = content.buildings[project.typeId];
    const workers = Math.max(0, Math.floor(project.workers || 0));
    const remaining = Math.max(0, project.workRequired - project.workDone);
    return {
      ...project,
      workers,
      builders: workers,
      name: definition ? definition.name : project.typeId,
      icon: definition ? definition.icon : "🪚",
      remaining,
      percent: project.workRequired ? Math.min(100, project.workDone / project.workRequired * 100) : 100,
      estimatedDays: workers > 0 ? Math.ceil(remaining / workers) : null,
      estimatedWageJin: workers > 0 ? Math.ceil(remaining / workers) * workers * builderWage : 0
    };
  });
  const dailyNeed = people.total * content.rules.foodPerPersonDay;
  const season = selectSeason(state.day);
  const voucherScale = currencyScale(content);
  const needMarket = full || needBusiness;
  const breadPrice = needMarket ? currentUnitPrice(state, "bread", content) : 0;
  const targetBreadShare = needMarket ? Math.max(0, Math.min(
    content.rules.breadTargetShareMaximum,
    content.rules.breadTargetShareAtBasePrice *
      Math.pow(content.rules.breadBasePriceWheatPerJin / breadPrice, content.rules.breadPriceElasticity)
  )) : 0;
  const saltScale = content.precision.inventoryUnitsPerJin;
  const saltPeriod = state.salt || {};
  const saltCoverage = (needBusiness || needResidents) ? selectSaltCoverage(state, content) : { coverage: 1, grace: false, daysObserved: 0 };
  const currencyInvariant = needSite ? validateCurrencyInvariant(state) : { balances: 0, valid: true };
  const needMoney = full || needResidents || needBusiness || needPolicy || needBuild || needSite;

  const householdLiving = needResidents ? householdLivingSummary(state, content) : null;
  const occupations = needResidents ? occupationCounts(state, content) : null;
  const exchangeRemainingUnits = needResidents ? employmentExchangeRemainingUnits(state, content, runtime) : 0;
  const housingByHousehold = needResidents
    ? new Map((housing.householdHousing || []).map(row => [row.householdId, row]))
    : new Map();
  const factorByHousehold = needResidents
    ? new Map((state.satisfactionFactors?.rows || []).map(row => [row.householdId, row]))
    : new Map();
  const householdDetails = needResidents ? households.map(household => {
    const life = household.life || {};
    const recent = householdRecentTotalsReadonly(household, content.rules.satisfactionObservationDays || 14, content);
    const factors = factorByHousehold.get(household.id) || life.lastFactors || {};
    const housingRow = housingByHousehold.get(household.id) || { unhousedPeople: 0, rentalPeople: 0 };
    const foodDays = householdFoodDays(state, household, content);
    const issues = [];
    if ((factors.foodCoverage ?? 1) < 0.999) issues.push(`缺粮：今日口粮满足${Math.round((factors.foodCoverage || 0) * 100)}%`);
    if ((factors.saltCoverage ?? 1) < 0.999) issues.push(`缺盐：今日满足${Math.round((factors.saltCoverage || 0) * 100)}%`);
    if ((housingRow.unhousedPeople || 0) > 0) issues.push(`住房不足${housingRow.unhousedPeople}人`);
    if ((factors.wageCoverage ?? 1) < 0.999) issues.push(`欠薪：今日到账${Math.round((factors.wageCoverage || 0) * 100)}%`);
    if (!issues.length && foodDays < (content.rules.householdLiving?.difficultFoodDays || 14)) issues.push(`口粮储备仅${foodDays.toFixed(1)}日`);
    return { id: household.id, name: household.name, people: householdPopulation(household), satisfaction: life.satisfaction ?? state.satisfaction, incomeExpectationJin: household.incomeExpectationJin || 0, depositPropensity: household.depositPropensity ?? null, stockPropensity: household.stockPropensity ?? null, voucher: (household.voucherUnits || 0) / voucherScale, foodDays, saltJin: (household.inventory?.salt || 0) / content.precision.inventoryUnitsPerJin, rentalPeople: housingRow.rentalPeople || 0, unhousedPeople: housingRow.unhousedPeople || 0, issues: issues.slice(0,2), recent: { days: recent.days, incomeVoucher: recent.incomeVoucherUnits / voucherScale, lifeExpenseVoucher: recent.lifeExpenseVoucherUnits / voucherScale, investmentVoucher: recent.investmentVoucherUnits / voucherScale, inKindIncomeJin: recent.inKindIncomeQeqUnits / content.precision.qeqUnitsPerJin, foodConsumedJin: recent.foodConsumedQeqUnits / content.precision.qeqUnitsPerJin, wageDueVoucher: recent.wageDueVoucherUnits / voucherScale, wagePaidVoucher: recent.wagePaidVoucherUnits / voucherScale } };
  }) : [];
  const categoryDefs = [
    ["农民家庭", h => (h.jobs?.farmers || 0) > 0],
    ["工人家庭", h => Object.entries(h.jobs || {}).some(([k, n]) => n > 0 && k !== "farmers" && !k.startsWith("shop:"))],
    ["商人家庭", h => (h.shopIds || []).some(id => state.shops?.[id]?.status !== "closed")],
    ["失业者家庭", h => householdIdleWorkers(h) > 0]
  ];
  const householdCategories = needResidents ? categoryDefs.map(([name, test]) => {
    const matched = households.filter(test);
    const pop = matched.reduce((sum,h) => sum + householdPopulation(h), 0);
    return { name, households: matched.length, people: pop, satisfaction: pop ? matched.reduce((sum,h) => sum + ((h.life?.satisfaction ?? state.satisfaction) * householdPopulation(h)), 0) / pop : null };
  }) : [];
  const recentSat = state.satisfactionHistory || [];
  const satisfactionChange = needResidents && recentSat.length > 1
    ? state.satisfaction - recentSat[Math.max(0, recentSat.length - 8)].value
    : 0;
  const shops = (full || needPolicy || needSite) ? shopSummaries(state, content) : [];
  const stallSquares = (full || needPolicy || needSite) ? stallSquareSummaries(state, content, shops) : [];
  const companies = needBusiness ? Object.values(state.companies || {}).map(company => {
    const summary = companySummary(state, company, content);
    const subscription = company.listing?.listed ? previewShareSubscription(state, company.id, content) : { available: false, reason: "公司尚未上市" };
    const reference = company.listing?.listed ? stockReference(state, company, content) : companyActualReferencePlaceholder(company, content);
    const reserveUnits = companyWorkingCapitalReserve(company, state, content);
    return {
      ...summary,
      subscription,
      stockReference: reference,
      workingCapitalReserveVoucher: reserveUnits / voucherScale,
      lastAnnualSettlement: company.annualSettlement || null,
      sharePriceVoucher: ((company.sharePriceVoucherUnits || company.shareSale?.sharePriceVoucherUnits || 0)) / voucherScale,
      shareSaleProceedsVoucher: (company.shareSale?.cumulativeProceedsVoucherUnits || 0) / voucherScale,
      revenueDayVoucher: (company.accounts?.day?.revenueVoucherUnits || 0) / voucherScale,
      cogsDayVoucher: (company.accounts?.day?.cogsVoucherUnits || 0) / voucherScale,
      wagesDayVoucher: (company.accounts?.day?.wageExpenseVoucherUnits || 0) / voucherScale,
      taxCostDayVoucher: (company.accounts?.day?.taxCostVoucherUnits || 0) / voucherScale,
      processingLossDayVoucher: (company.accounts?.day?.processingLossVoucherUnits || 0) / voucherScale,
      costsDayVoucher: ((company.accounts?.day?.cogsVoucherUnits || 0) + (company.accounts?.day?.wageExpenseVoucherUnits || 0) + (company.accounts?.day?.taxCostVoucherUnits || 0) + (company.accounts?.day?.processingLossVoucherUnits || 0)) / voucherScale,
      profitDayVoucher: (company.accounts?.day?.profitVoucherUnits || 0) / voucherScale,
      taxRowsDay: Object.entries(company.accounts?.day?.taxedUnits || {}).filter(([, units]) => units > 0).map(([itemId, units]) => ({ itemId, name: content.items[itemId]?.name || itemId, unit: content.items[itemId]?.unit || "单位", quantity: units / content.precision.inventoryUnitsPerJin })),
      producedRowsDay: Object.entries(company.accounts?.day?.producedUnits || {}).filter(([, units]) => units > 0).map(([itemId, units]) => ({ itemId, name: content.items[itemId]?.name || itemId, unit: content.items[itemId]?.unit || "单位", quantity: units / content.precision.inventoryUnitsPerJin })),
      soldRowsDay: Object.entries(company.accounts?.day?.soldUnits || {}).filter(([, units]) => units > 0).map(([itemId, units]) => ({ itemId, name: content.items[itemId]?.name || itemId, unit: content.items[itemId]?.unit || "单位", quantity: units / content.precision.inventoryUnitsPerJin })),
      revenueCumulativeVoucher: (company.accounts?.cumulative?.revenueVoucherUnits || 0) / voucherScale,
      profitCumulativeVoucher: (company.accounts?.cumulative?.profitVoucherUnits || 0) / voucherScale,
      initialCashVoucher: (company.initialInvestment?.cashVoucherUnits || 0) / voucherScale,
      inventoryRows: Object.entries(company.inventory || {}).filter(([, units]) => units > 0).map(([itemId, units]) => ({ itemId, name: content.items[itemId]?.name || itemId, quantity: units / content.precision.inventoryUnitsPerJin })),
      productRows: (content.recipes[content.buildings[company.typeId]?.recipeId]?.outputs || []).map(row => ({
        itemId: row.itemId, name: content.items[row.itemId]?.name || row.itemId,
        salePrice: company.settings?.salePricesVoucherPerUnit?.[row.itemId] ?? currentUnitPrice(state, row.itemId, content)
      }))
    };
  }) : [];
  // 宏观面板指标（金融扩展第一期）：只读派生，不写 state；
  // 国债/银行利率/流动性字段预留，后续期数接入后填充。
  const laborMarket = computeLaborMarket(state, content);
  const jinScale = content.precision.inventoryUnitsPerJin;
  const macroHistory = state.economyHistory || [];
  const macroLastHistory = macroHistory[macroHistory.length - 1] || {};
  let macroMarketCapVoucherUnits = 0;
  let macroListedCount = 0;
  for (const company of Object.values(state.companies || {})) {
    if (!company.listing?.listed) continue;
    macroListedCount += 1;
    // 实时股价（四期）；老数据回退到挂牌价
    const marketPriceUnits = company.sharePriceVoucherUnits || company.shareSale?.sharePriceVoucherUnits || 0;
    macroMarketCapVoucherUnits += marketPriceUnits * (company.totalShares || 0);
  }
  const macro = {
    unemploymentRate: laborMarket.unemploymentRate,
    residentWheatJin: (state.accounts.residents.wheat || 0) / jinScale,
    residentVoucher: voucherBalance(state, "residents") / voucherScale,
    townWheatJin: (state.accounts.town.wheat || 0) / jinScale,
    townVoucher: voucherBalance(state, "town") / voucherScale,
    wheatPrice: Number.isFinite(macroLastHistory.wheatPrice) ? macroLastHistory.wheatPrice : null,
    listedCount: macroListedCount,
    stockMarketCapVoucher: macroMarketCapVoucherUnits / voucherScale,
    bondOutstandingVoucher: bondOutstandingVoucherUnits(state) / voucherScale,
    depositRateAnnualPercent: state.policy?.bank?.depositRateAnnualPercent ?? null,
    loanRateAnnualPercent: state.policy?.bank?.loanRateAnnualPercent ?? null,
    liquidityLevel: state.liquidity?.level ?? null
  };
  return {
    year: state.year,
    day: state.day,
    season,
    paused: !selection || selection.paused !== false,
    speed: selection && selection.speed ? selection.speed : 1,
    people,
    labor,
    laborMarket,
    macro,
    laborUnemploymentHighPercent: content.rules.laborUnemploymentHighPercent ?? 8,
    laborUnemploymentLowPercent: content.rules.laborUnemploymentLowPercent ?? 5,
    wealthNow: computeWealthStats(state, content),
    economy: {
      history: state.economyHistory || [],
      poachYear: state.laborCompetition?.year?.moves || 0,
      recentPoach: (state.laborCompetition?.recent || []).slice(0, 5)
    },
    accounts,
    households: { count: households.length, living: householdLiving, occupations, exchangeRemainingJin: exchangeRemainingUnits / content.precision.inventoryUnitsPerJin, details: householdDetails, categories: householdCategories, issueCounts: state.satisfactionFactors?.issueCounts || { food:0,salt:0,housing:0,wage:0 }, satisfactionChange },
    shops,
    stallSquares,
    wholesaleMarket: (needBusiness || needSite) ? wholesaleSummary(state, content) : null,
    wholesaleTrends: (needBusiness || needSite) ? wholesaleTrends(state, content) : null,
    ipo: (needBusiness || needSite) ? selectIpoView(state, content) : null,
    servicePricesVoucherPerUse: (needBusiness || needSite) ? { ...(state.services?.pricesVoucherPerUse || {}) } : {},
    residentFoodDays: selectFoodDays(state, content, false),
    totalFoodDays: needBusiness ? selectFoodDays(state, content, true) : 0,
    dailyNeed,
    annualNeed: dailyNeed * content.rules.daysPerYear,
    totalQeq: needBusiness ? selectTotalQeq(state, content) : 0,
    forecast: selectHarvestForecast(state, content),
    satisfaction: state.satisfaction,
    shortageQeq: state.shortageQeq,
    autoRelief: state.autoRelief,
    relief: state.relief?.lastDay || null,
    buildings,
    productivity: industryProductivityRows(state, content),
    constructionOptions: options,
    projects: projectViews,
    // 兼容旧调用方：单工程访问器仍然返回首个在建工程。
    project: projectViews.length ? projectViews[0] : null,
    yearTotals: needBusiness ? {
      harvest: qeqUnitsToJin(state.yearTotals.harvestQeq || 0, content),
      consumption: qeqUnitsToJin(state.yearTotals.consumptionQeq || 0, content),
      operatingWages: qeqUnitsToJin(state.yearTotals.operatingWagesQeq || 0, content),
      constructionPay: qeqUnitsToJin(state.yearTotals.constructionPayQeq || 0, content),
      relief: qeqUnitsToJin(state.yearTotals.reliefQeq || 0, content),
      processingLoss: qeqUnitsToJin(state.yearTotals.processingLossQeq || 0, content),
      wagePaid: qeqUnitsToJin(state.yearTotals.wagePaidQeq || 0, content),
      wageArrears: qeqUnitsToJin(state.yearTotals.wageArrearsQeq || 0, content),
      unemploymentPaid: qeqUnitsToJin(state.yearTotals.unemploymentPaidQeq || 0, content)
    } : null,
    annualReports: (needBusiness || needResidents) ? state.annualReports : [],
    market: needBusiness ? {
      breadPriceWheatPerJin: currentUnitPrice(state, "bread", content),
      breadPriceVoucherPerJin: currentUnitPrice(state, "bread", content),
      pricesVoucherPerUnit: currentPriceMap(state, content),
      intermediatePricesVoucherPerUnit: {
        flour: currentUnitPrice(state, "flour", content),
        wood: currentUnitPrice(state, "wood", content)
      },
      priceRecommendation: state.market?.priceRecommendation || { pending: false },
      publicWoodDemand: selectPublicProcurementDemand(state, "wood", content),
      targetBreadShare,
      residentBreadJin: (state.accounts.residents.bread || 0) / content.precision.inventoryUnitsPerJin,
      townBreadJin: (state.accounts.town.bread || 0) / content.precision.inventoryUnitsPerJin,
      trade: state.market?.lastDay || null,
      business: state.business
    } : null,
    // 各 mod 的只读视图（mod.js 的 select）。
    mods: selectModViews(state, content, MODS),
    // 外镇：outsideTowns 是全部外镇的视图（界面切换用）；outsideTown / tradeAgreements 是当前选中的那一个。
    outsideTowns: needBusiness ? outsideTownViews : null,
    outsideTownId: outsideTownId,
    outsideTown: needBusiness ? outsideTownViews.find(row => row.id === outsideTownId) || null : null,
    tradeAgreements: needBusiness ? selectTradeAgreementView(state, content, outsideTownId) : null,
    // 镇营岗位实际日薪 = 岗位基础日薪 × 所属类别系数；界面只读展示，调节入口在政策页。
    wageControl: { civil: state.policy?.wageControl?.civil ?? 1, industry: state.policy?.wageControl?.industry ?? 1, civilRoleIds: WAGE_CONTROL_CIVIL_ROLE_IDS },
    socialSecurity: (needSite || needPolicy) ? selectSocialSecurityStats(state, content) : null,
    policy: needPolicy ? {
      ...(state.policy || { unemploymentBenefit: { enabled: false, dailyPerWorkerJin: 1 } }),
      unemployed: labor.idle,
      dailyExpectedWheatJin: labor.idle * (state.policy?.unemploymentBenefit?.dailyPerWorkerJin || 0),
      dailyExpectedVoucher: labor.idle * (state.policy?.unemploymentBenefit?.dailyPerWorkerJin || 0),
      annualExpectedWheatJin: labor.idle * (state.policy?.unemploymentBenefit?.dailyPerWorkerJin || 0) * content.rules.daysPerYear,
      lastDay: state.policy?.lastDay || null,
      villa: state.policy?.villa || { priceWheatJin: 10000, taxRatePercent: 0.5 },
      villaStats: selectVillaStats(state, content),
      wageControl: state.policy?.wageControl || { civil: 1.0, industry: 1.0 },
      wageLastDay: state.payroll?.lastDay || null,
      // 银行统计（金融扩展二期）：只读，不初始化 state.bank
      bankStats: (function () {
        const bank = state.bank || {};
        let totalDeposits = 0;
        for (const units of Object.values(bank.deposits || {})) totalDeposits += units || 0;
        let outstanding = 0;
        for (const loan of bank.loans || []) {
          if (loan.status === "active") outstanding += loan.outstandingVoucherUnits || 0;
        }
        const reservePct = state.policy?.bank?.reserveRequirementPercent ?? 10;
        return {
          depositRateAnnualPercent: state.policy?.bank?.depositRateAnnualPercent ?? 2,
          loanRateAnnualPercent: state.policy?.bank?.loanRateAnnualPercent ?? 6,
          reserveRequirementPercent: reservePct,
          totalDepositsVoucher: totalDeposits / voucherScale,
          outstandingLoansVoucher: outstanding / voucherScale,
          loanableVoucher: Math.max(0, (bank.cashVoucherUnits || 0) - Math.floor(totalDeposits * reservePct / 100)) / voucherScale,
          badDebtVoucher: (bank.stats?.badDebtVoucherUnits || 0) / voucherScale,
          interestEarnedVoucher: (bank.stats?.interestEarnedVoucherUnits || 0) / voucherScale,
          interestPaidVoucher: (bank.stats?.interestPaidVoucherUnits || 0) / voucherScale
        };
      })(),
      // 国债统计（金融扩展三期）：只读
      bondStats: (function () {
        const bonds = state.bonds || {};
        const daysPerYear = content.rules.daysPerYear || 360;
        const statusLabel = { active: "存续中", matured: "已兑付", failed: "未发行", defaulted: "已违约" };
        return {
          issues: (bonds.issues || []).slice(-5).reverse().map(issue => ({
            id: issue.id,
            status: issue.status,
            statusLabel: statusLabel[issue.status] || issue.status,
            totalVoucher: (issue.totalVoucherUnits || 0) / voucherScale,
            couponRateAnnualPercent: issue.couponRateAnnualPercent,
            termYears: Math.round((issue.termDays || 0) / daysPerYear)
          }))
        };
      })()
    } : null,
    agriculturePolicy: needPolicy ? (function () {
      const rows = (state.agriculture.taxDays || []).filter(row => row.year === state.year);
      const current = state.policy?.agricultureTaxPercent ?? content.rules.agricultureTaxDefaultPercent ?? 50;
      const rowSum = rows.reduce((sum, row) => sum + row.rateBps, 0);
      const seasonStart = state.day < 91 ? 1 : state.day < 183 ? 92 : state.day < 274 ? 184 : 1;
      const seasonEnd = state.day < 91 ? 91 : state.day < 183 ? 183 : state.day < 274 ? 274 : 274;
      const seasonRows = rows.filter(row => row.day >= seasonStart && row.day <= seasonEnd);
      const accumulatedAveragePercent = seasonRows.length ? seasonRows.reduce((sum, row) => sum + row.rateBps, 0) / seasonRows.length / 100 : current;
      const remain = Math.max(0, content.rules.growingDays - rows.length);
      const projectedSettlementPercent = state.agriculture.lastHarvestYear === state.year
        ? (state.agriculture.taxHistory.find(row => row.year === state.year)?.averageRateBps || 0) / 100
        : (rowSum + remain * current * 100) / content.rules.growingDays / 100;
      const forecastUnits = Math.round(selectHarvestForecast(state, content) * content.precision.inventoryUnitsPerJin);
      const townUnits = Math.floor(forecastUnits * projectedSettlementPercent / 100);
      const lastHarvestRow = (state.agriculture.taxHistory || []).slice(-1)[0];
      return { currentPercent: current, accumulatedAveragePercent, projectedSettlementPercent,
        farmDays: seasonRows.length, yearAveragePercent: rows.length ? rowSum / rows.length / 100 : current, townShareJin: townUnits / content.precision.inventoryUnitsPerJin,
        residentShareJin: (forecastUnits - townUnits) / content.precision.inventoryUnitsPerJin,
        lastHarvest: lastHarvestRow ? { year: lastHarvestRow.year, townJin: lastHarvestRow.townUnits / content.precision.inventoryUnitsPerJin, residentJin: lastHarvestRow.residentUnits / content.precision.inventoryUnitsPerJin } : null,
        satisfactionAdjustment: state.satisfactionFactors?.agricultureTaxAdjustment || 0,
        satisfactionAveragePercent: state.satisfactionFactors?.agricultureTaxAveragePercent ?? current };
    })() : null,
    privateEconomy: needBusiness ? state.privateEconomy : null,
    financialFlows: needBusiness ? state.financialFlows : null,
    payroll: (needBusiness || needResidents || needSite) ? state.payroll : null,
    housing: (needBusiness || needResidents || needSite || needPolicy) ? {
      ...housing,
      rentPerResidentDayWheatJin: content.rules.rentPerResidentDayWheatJin,
      rentPerResidentDayVoucher: content.rules.rentPerResidentDayWheatJin,
      lastRentDay: state.fiscal?.lastRentDay || null,
      rentFiscal: state.fiscal || null
    } : null,
    industries: needBusiness ? (state.industries || {}) : {},
    salt: needBusiness ? {
      priceWheatPerJin: currentUnitPrice(state, "salt", content),
      priceVoucherPerJin: currentUnitPrice(state, "salt", content),
      annualDemandJinPerPerson: content.rules.saltAnnualDemandJinPerPerson,
      residentStockJin: (state.accounts.residents.salt || 0) / saltScale,
      townStockJin: (state.accounts.town.salt || 0) / saltScale,
      todayDemandJin: (saltPeriod.todayDemandUnits || 0) / saltScale,
      todaySatisfiedJin: (saltPeriod.todaySatisfiedUnits || 0) / saltScale,
      day: saltPeriod.day || {},
      year: saltPeriod.year || {},
      lifetime: saltPeriod.lifetime || {},
      historyCoverage: saltCoverage.coverage,
      grace: saltCoverage.grace,
      daysObserved: saltCoverage.daysObserved,
      trade: saltPeriod.market || null
    } : needResidents ? { historyCoverage: saltCoverage.coverage, grace: saltCoverage.grace, daysObserved: saltCoverage.daysObserved } : {},
    monetaryReform: needMoney ? (function () {
      const stage = state.monetaryReform?.stage === "voucher" ? "voucher" : "wheat";
      const bankBuilding = runtime.firstBuildingByType.get("bank") || null;
      return {
        stage,
        stageName: stage === "wheat" ? "粮食结算" : "粮券结算",
        hasBankAccess: hasBankAccess(state),
        hasPhysicalBank: Boolean(bankBuilding),
        bankBuildingId: bankBuilding?.id || null,
        legacyBankAccess: Boolean(state.monetaryReform?.legacyBankAccess),
        employmentExchangeJin: state.policy?.employmentExchangeJin ?? content.rules.employmentExchangeDefaultJin ?? 5,
        employmentExchangeMinimumJin: content.rules.employmentExchangeMinimumJin ?? 0,
        employmentExchangeMaximumJin: content.rules.employmentExchangeMaximumJin ?? 50
      };
    })() : null,
    currency: needSite ? {
      townVoucher: voucherBalance(state, "town") / voucherScale,
      residentVoucher: voucherBalance(state, "residents") / voucherScale,
      issuedVoucher: (state.currency?.issuedUnits || 0) / voucherScale,
      circulationVoucher: currencyInvariant.balances / voucherScale,
      availableTownWheatJin: (state.accounts.town.wheat || 0) / content.precision.inventoryUnitsPerJin,
      availableResidentWheatJin: (state.accounts.residents.wheat || 0) / content.precision.inventoryUnitsPerJin,
      invariantValid: currencyInvariant.valid,
      guidancePending: Boolean(state.currency?.guidancePending)
    } : null,
    companies,
    stockExchange: needBusiness ? {
      available: hasStockExchange(state),
      physical: runtime.buildingTypeCounts.has("stock_exchange"),
      legacyAccess: Boolean(state.stockExchange?.legacyAccess),
      reformComplete: state.monetaryReform?.stage === "voucher"
    } : null,
    listableBuildings: needBusiness ? buildings.filter(building => isIndustryType(content, building.typeId) && building.ownership.townLevels > 0 && !building.companyId) : [],
    shareConfig: needBusiness ? {
      sharesPerListedLevel: content.rules.sharesPerListedLevel || 1000,
      foodReserveDays: content.rules.shareFoodReserveDays || 90,
      livingVoucherReserveDays: content.rules.shareLivingVoucherReserveDays || 30,
      observationDays: content.rules.sharePerformanceObservationDays || 30,
      targetYieldPercent: content.rules.shareTargetAnnualYieldPercent || 8,
      companyOperatingReserveDays: content.rules.companyOperatingReserveDays || 30
    } : null,
    wageRates: (needBuild || needPolicy || needSite) ? (state.employment.wageRates || {}) : {},
    plotCount: state.plots.length,
    ledger: needBusiness ? state.ledger : [],
    inventoryUnitsPerJin: content.precision.inventoryUnitsPerJin,
    qeqUnitsPerJin: content.precision.qeqUnitsPerJin,
    currencyUnitsPerVoucher: voucherScale,
    events: state.events,
    plots: state.plots,
    plotOccupants: full ? state.plots.map(function (plot) {
      const plotProject = projectViews.find(row => row.plotId === plot.id) || null;
      return {
        ...plot,
        building: runtime.buildingByPlotId.get(plot.id) || null,
        project: plotProject,
        occupied: runtime.buildingByPlotId.has(plot.id) || !!plotProject
      };
    }) : [],
    selectedSite: selection ? selection.site || null : null,
    buildingDevelopment: needSite && selection?.site?.startsWith("building:") ? {
      upgrade: selectUpgradePreview(state, selection.site.slice("building:".length), content),
      demolition: selectDemolitionPreview(state, selection.site.slice("building:".length), content)
    } : null,
    selectedResourcePlot: needSite && selection?.site?.startsWith("resource:")
      ? runtime.plotById.get(selection.site.slice("resource:".length)) || null
      : null,
    selectedBuild: needBuild && selection ? selection.build || null : null,
    selectedPlot: needBuild && selection?.plotId ? runtime.plotById.get(selection.plotId) || null : null,
    constructionCostNote: needBuild ? options.map(function (option) {
      return option.name + "施工需" + option.workDays + "工日、预计工钱" + option.estimatedWageJin + "粮券";
    }) : [],
    presentation: BUILDING_PRESENTATION,
    lastDemography: needResidents ? state.lastDemography : null,
    housingCapacity: (needResidents || needSite) ? housing.capacity : 0,
    daysPerYear: content.rules.daysPerYear,
    farmCapacity: reclaimedAcres(state, content) / content.agriculture.acresPerFarmer,
    cropWorkUnits: state.agriculture.workUnits,
    farmWorkDays: (needResidents || needSite) ? state.agriculture.workUnits /
      (reclaimedAcres(state, content) / content.agriculture.acresPerFarmer) : 0,
    farmWorkPercent: needSite ? Math.min(100, state.agriculture.workUnits /
      ((reclaimedAcres(state, content) / content.agriculture.acresPerFarmer) *
        content.rules.growingDays) * 100) : 0,
    growingDays: (needResidents || needSite) ? content.rules.growingDays : 0,
    automaticReliefTriggerDays: content.rules.automaticReliefTriggerDays,
    automaticReliefTargetDays: content.rules.automaticReliefTargetDays,
    farmAcres: reclaimedAcres(state, content),
    farmAcresMaximum: content.agriculture.acresMaximum ?? content.agriculture.acres,
    acresPerFarmer: content.agriculture.acresPerFarmer,
    farmYieldPerAcre: content.agriculture.yieldPerAcre,
    farmMaximumHarvest: reclaimedAcres(state, content) * content.agriculture.yieldPerAcre,
    reclaim: needSite || needResidents ? selectReclaimView(state, content) : null,
    ledgerQuantity: function (row) {
      return row.quantityUnits / content.precision.inventoryUnitsPerJin;
    },
    qeqQuantity: function (row) {
      return qeqUnitsToJin(row.qeqUnits || 0, content);
    },
    itemNames: (needBusiness || needSite) ? Object.fromEntries(Object.entries(content.items).map(function (row) {
      return [row[0], row[1].name];
    })) : {},
    itemUnits: (needBusiness || needSite) ? Object.fromEntries(Object.entries(content.items).map(function (row) {
      return [row[0], row[1].unit];
    })) : {}
  };
}

export function selectBuilding(state, buildingId, content) {
  const view = selectDashboard(state, content);
  return view.buildings.find(function (building) { return building.id === buildingId; }) || null;
}
