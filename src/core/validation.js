import { populationStats, selectJobRows } from "../selectors/labor.js";
import { MODS } from "../mods/registry.js";
import { validateMods } from "../mods/api.js";
import { industryTypeIds, isIndustryType } from "../content/buildings.js";
import { PERIODS } from "../economy/books.js";
import { householdList, householdPopulation, householdWorkingAge, householdEmploymentCount, totalHouseholdAgeBands, jobCount, isActiveHousehold } from "../systems/households.js";
import { validateContent } from "../content/validate.js";
import { validateCurrencyInvariant } from "../economy/currency.js";
import { bankLedgerInvariant } from "../systems/bank.js";

export function validateState(state, content) {
  const errors = [];
  const contentCheck = validateContent(content);
  errors.push(...contentCheck.errors);
  const ss = state?.socialSecurity;
  if (ss) {
    for (const key of ["cashVoucherUnits", "cashWheatUnits", "debtToTownUnits"]) {
      if (!Number.isSafeInteger(ss[key] || 0) || (ss[key] || 0) < 0) errors.push("社保基金账户无效：" + key);
    }
    if (ss.farmerSubsidyPerFarmerJin !== undefined && (!Number.isFinite(ss.farmerSubsidyPerFarmerJin) || ss.farmerSubsidyPerFarmerJin < 0)) {
      errors.push("农民补贴标准无效");
    }
    if (ss.totalSubsidyUnits !== undefined && (!Number.isSafeInteger(ss.totalSubsidyUnits) || ss.totalSubsidyUnits < 0)) {
      errors.push("农民补贴累计无效");
    }
  }
  const logistics = state?.logistics;
  if (logistics) {
    for (const key of ["poolJin", "usedToday"]) {
      if (!Number.isFinite(logistics[key]) || logistics[key] < 0) errors.push("运力账户无效：" + key);
    }
  }
  // 再分配政策与账（docs/REDISTRIBUTION.md）：富人税门槛递增、税率 0–20%；遗产税率 0–50%；账目为非负整数。
  const wealthTax = state?.policy?.wealthTax;
  if (wealthTax) {
    const thresholds = wealthTax.thresholds;
    const rates = wealthTax.ratesPercent;
    if (!Array.isArray(thresholds) || thresholds.length !== 3 || thresholds.some(value => !Number.isFinite(value) || value <= 0) ||
        !(thresholds[0] < thresholds[1] && thresholds[1] < thresholds[2])) errors.push("富人税门槛无效");
    if (!Array.isArray(rates) || rates.length !== 3 || rates.some(value => !Number.isFinite(value) || value < 0 || value > 20)) errors.push("富人税税率无效");
  }
  const inheritancePercent = state?.policy?.inheritanceTaxPercent;
  if (inheritancePercent !== undefined && (!Number.isFinite(inheritancePercent) || inheritancePercent < 0 || inheritancePercent > 50)) errors.push("遗产税率无效");
  const redistribution = state?.redistribution;
  if (redistribution) {
    for (const period of PERIODS) {
      for (const [key, value] of Object.entries(redistribution[period] || {})) {
        if (!Number.isSafeInteger(value) || value < 0) errors.push("再分配账无效：" + period + "/" + key);
      }
    }
    if (redistribution.giniHistory !== undefined && (!Array.isArray(redistribution.giniHistory) ||
        redistribution.giniHistory.some(row => !Number.isInteger(row?.year) || !Number.isFinite(row?.gini) || row.gini < 0 || row.gini > 1))) {
      errors.push("基尼历史无效");
    }
  }
  const saveVersion = content.rules.saveVersion || 3;
  if (!state || state.schemaVersion !== saveVersion || state.version !== saveVersion) {
    errors.push("存档版本不是" + saveVersion);
    return { valid: false, errors };
  }
  if (!Number.isInteger(state.year) || state.year < 1 ||
      !Number.isInteger(state.day) || state.day < 0 || state.day >= content.rules.daysPerYear) {
    errors.push("日期字段无效");
  }
  if (!Array.isArray(state.cohorts) || !Array.isArray(state.buildings) ||
      !Array.isArray(state.plots) || !Array.isArray(state.ledger) ||
      !Array.isArray(state.annualReports) || !Array.isArray(state.events)) {
    errors.push("人口、建筑、地图或账目结构缺失");
    return { valid: false, errors };
  }
  if (state.events.some(event => !Number.isInteger(event?.year) || event.year < 1 ||
      !Number.isInteger(event?.day) || event.day < 1 || event.day > content.rules.daysPerYear ||
      typeof event?.text !== "string" ||
      (event.untilDay != null && (!Number.isInteger(event.untilDay) || event.untilDay < event.day || event.untilDay > content.rules.daysPerYear)))) {
    errors.push("事件日期或内容无效");
  }
  if (state.ledger.some(row => !Number.isInteger(row?.year) || row.year < 1 ||
      !Number.isInteger(row?.day) || row.day < 1 || row.day > content.rules.daysPerYear)) {
    errors.push("账目日期无效");
  }
  for (const owner of ["residents", "town"]) {
    const account = state.accounts?.[owner];
    if (!account) {
      errors.push("缺少物品账户：" + owner);
      continue;
    }
    for (const itemId of Object.keys(content.items)) {
      const value = account[itemId];
      if (!Number.isSafeInteger(value) || value < 0) errors.push("库存无效：" + owner + "/" + itemId);
    }
    for (const itemId of Object.keys(account)) {
      if (!content.items[itemId]) errors.push("存档含未注册物品：" + itemId);
    }
  }
  const households = state.households?.byId ? householdList(state) : [];
  if (!households.length) {
    errors.push("缺少家庭账户");
  } else {
    if (state.households.members !== undefined || state.households.nextMemberNumber !== undefined) errors.push("v11 存档仍含逐人家庭数据");
    const people = populationStats(state);
    const bands = totalHouseholdAgeBands(state);
    if (bands.children !== people.children || bands.workers !== people.workers || bands.elders !== people.elders) {
      errors.push("家庭年龄段汇总与人口 cohort 不一致");
    }
    for (const household of households) {
      if (!household.inventory || !Number.isSafeInteger(household.voucherUnits) || household.voucherUnits < 0) {
        errors.push("家庭账户无效：" + (household.id || "未知"));
        continue;
      }
      for (const key of ["children", "workers", "elders"]) {
        if (!Number.isInteger(household.ageBands?.[key]) || household.ageBands[key] < 0) errors.push("家庭年龄段无效：" + household.id + "/" + key);
      }
      for (const [jobKey, count] of Object.entries(household.jobs || {})) {
        if (!Number.isInteger(count) || count < 0) errors.push("家庭岗位数量无效：" + household.id + "/" + jobKey);
      }
      if (householdEmploymentCount(household) > householdWorkingAge(household)) errors.push("家庭就业超过劳动年龄人数：" + household.id);
      for (const itemId of Object.keys(content.items)) if (!Number.isSafeInteger(household.inventory[itemId] || 0) || (household.inventory[itemId] || 0) < 0) errors.push("家庭库存无效：" + household.id + "/" + itemId);
      if (!isActiveHousehold(household) && householdEmploymentCount(household) > 0) errors.push("无人家庭仍占用岗位：" + household.id);
    }
    for (const itemId of Object.keys(content.items)) {
      const sum = households.reduce((total, h) => total + (h.inventory[itemId] || 0), 0);
      if (sum !== (state.accounts?.residents?.[itemId] || 0)) errors.push("居民汇总库存与家庭不一致：" + itemId);
    }
  }
  if (!Number.isFinite(state.policy?.employmentExchangeJin) || state.policy.employmentExchangeJin < (content.rules.employmentExchangeMinimumJin ?? 0) || state.policy.employmentExchangeJin > (content.rules.employmentExchangeMaximumJin ?? 50)) errors.push("就业换券额度无效");
  if (!Number.isFinite(state.policy?.shopRentVoucher) || state.policy.shopRentVoucher < 0) errors.push("店租设置无效");
  for (const key of ["importPercent", "exportPercent"]) {
    const value = state.policy?.tradeTariff?.[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > (content.rules.tradeTariffMaximumPercent ?? 50))) errors.push("关税设置无效");
  }
  if (!Number.isFinite(state.policy?.shopProfitTaxPercent) || state.policy.shopProfitTaxPercent < 0 || state.policy.shopProfitTaxPercent > (content.rules.shopProfitTaxMaximumPercent || 80)) errors.push("商业利润税设置无效");

  if (!state.employment || !state.employment.wageRates) {
    errors.push("缺少就业工资设置");
  } else {
    for (const legacyKey of ["roles", "byBuilding", "privateByBuilding", "listedByBuilding"]) {
      if (state.employment[legacyKey] !== undefined) errors.push("v11 存档仍含旧就业计数：" + legacyKey);
    }
    for (const [roleId, rate] of Object.entries(state.employment.wageRates || {})) {
      if (!Number.isFinite(rate) || rate < 0) errors.push("工种日薪无效：" + roleId);
    }
    if (!Number.isInteger(state.employment.targets?.farmers) || state.employment.targets.farmers < 0) errors.push("农业目标用工无效");
    const people = populationStats(state);
    const jobs = selectJobRows(state, content);
    if (people.total !== people.children + people.workers + people.elders) errors.push("年龄人口总数不一致");
    if (jobs.householdWorkingAge !== people.workers) errors.push("家庭劳动年龄人口与 cohort 不一致");
    if (jobs.employed > people.workers) errors.push("就业人数超过劳动年龄人口");
    for (const row of jobs.rows) if (row.count > row.capacity) errors.push("岗位超过容量：" + row.key);
    const farmer = jobs.rows.find(row => row.roleId === "farmers" && row.scope === "core");
    if (farmer && state.employment.targets.farmers > farmer.capacity) errors.push("农业目标用工超过土地容量");
  }
  if (!state.services || typeof state.services !== "object" || Array.isArray(state.services) || !state.services.demandByHousehold || !state.services.carryByHousehold || !state.services.rotation) {
    errors.push("服务需求状态无效");
  } else {
    for (const [householdId, row] of Object.entries(state.services.demandByHousehold || {})) {
      if (!state.households?.byId?.[householdId]) errors.push("服务需求引用未知家庭：" + householdId);
      for (const [serviceId, value] of Object.entries(row || {})) {
        if (!content.rules.serviceTypes?.[serviceId] || !Number.isSafeInteger(value) || value < 0) errors.push("服务需求无效：" + householdId + "/" + serviceId);
      }
    }
  }
  const ages = new Set();
  for (const cohort of state.cohorts) {
    if (!Number.isInteger(cohort.age) || ages.has(cohort.age)) errors.push("年龄组重复或无效");
    ages.add(cohort.age);
    for (const key of ["m", "f", "marriedM", "marriedF"]) {
      if (!Number.isInteger(cohort[key]) || cohort[key] < 0) errors.push("年龄组数量无效：" + key);
    }
    if (cohort.marriedM > cohort.m || cohort.marriedF > cohort.f) errors.push("婚姻人数超过性别人数");
  }
  if (!state.agriculture || !Number.isInteger(state.agriculture.workUnits) ||
      state.agriculture.workUnits < 0 || !Number.isInteger(state.agriculture.lastHarvestYear)) {
    errors.push("农业投入记录无效");
  }
  if (!Number.isInteger(state.agriculture?.reclaimedAcres) || state.agriculture.reclaimedAcres < 0 ||
      state.agriculture.reclaimedAcres > (content.agriculture.acresMaximum ?? content.agriculture.acres)) {
    errors.push("已开荒耕地亩数无效");
  }
  if (!state.rng || state.rng.algorithm !== "lcg32-v1" ||
      !Number.isInteger(state.rng.state) || state.rng.state < 0 || state.rng.state > 4294967295) {
    errors.push("随机数状态无效");
  }
  if (!Number.isFinite(state.satisfaction) || state.satisfaction < 0 || state.satisfaction > 100) {
    errors.push("满意度无效");
  }
  if (!state.yearTotals || !Number.isFinite(state.yearTotals.harvestQeq) ||
      !Number.isFinite(state.yearTotals.consumptionQeq)) errors.push("年度账目无效");
  if (!Number.isFinite(state.market?.breadPriceWheatPerJin) || state.market.breadPriceWheatPerJin <= 0) {
    errors.push("面包售价必须为正的有限数值");
  }
  for (const itemId of ["wheat", "flour", "bread", "wood", "salt"]) {
    const price = state.market?.pricesVoucherPerUnit?.[itemId];
    if (!Number.isFinite(price) || price <= 0) errors.push("统一商品价格无效：" + itemId);
  }
  if (!Number.isFinite(state.policy?.agricultureTaxPercent) || state.policy.agricultureTaxPercent < 0 || state.policy.agricultureTaxPercent > 80) errors.push("农业税率无效");
  for (const typeId of industryTypeIds(content)) {
    const rate = state.policy?.privateProductionTaxPercent?.[typeId];
    if (!Number.isFinite(rate) || rate < 0 || rate > 80) errors.push("民营生产税率无效：" + typeId);
  }
  for (const building of state.buildings || []) {
    const level = building.level || 1;
    const townLevels = building.ownership?.townLevels;
    const privateLevels = building.ownership?.privateLevels;
    const listedLevels = building.ownership?.listedLevels ?? 0;
    if (!Number.isInteger(townLevels) || townLevels < 0 || !Number.isInteger(privateLevels) || privateLevels < 0 ||
        !Number.isInteger(listedLevels) || listedLevels < 0) {
      errors.push("建筑经营权等级无效：" + building.id);
      continue;
    }
    // 所有制（docs/OWNERSHIP.md）：整栋只有一个主人——三者恰好一个等于 level，其余为 0。
    const levelsAtLevel = [townLevels, privateLevels, listedLevels].filter(value => value === level).length;
    if (townLevels + privateLevels + listedLevels !== level || levelsAtLevel !== 1) {
      errors.push("建筑整栋须只有一个主人：" + building.id);
    }
    if (privateLevels > 0) {
      const owners = building.privateOwners;
      if (!Array.isArray(owners) || owners.length !== 1 || !state.households?.byId?.[owners[0]]) {
        errors.push("民营建筑须恰好一户业主：" + building.id);
      }
    }
    if (listedLevels > 0) {
      const company = Object.values(state.companies || {}).find(row => row.buildingId === building.id);
      if (!company || company.listedLevels !== listedLevels) errors.push("公司建筑须有对应公司且等级一致：" + building.id);
    }
  }
  if (!Array.isArray(state.agriculture?.taxDays) || state.agriculture.taxDays.some(row => !Number.isInteger(row.rateBps) || row.rateBps < 0 || row.rateBps > 8000)) errors.push("农业税日记录无效");
  if (!Array.isArray(state.policy?.agricultureTaxRecent) || state.policy.agricultureTaxRecent.some(row => !Number.isInteger(row.rateBps) || row.rateBps < 0 || row.rateBps > 8000)) errors.push("农业税舒心值记录无效");
  const benefit = state.policy?.unemploymentBenefit;
  if (!benefit || typeof benefit.enabled !== "boolean" ||
      !Number.isFinite(benefit.dailyPerWorkerJin) || benefit.dailyPerWorkerJin < 0) {
    errors.push("失业金政策设置无效");
  }
  if (!state.payroll || !state.payroll.arrearsWheatUnits ||
      Object.values(state.payroll.arrearsWheatUnits || {}).some(value => !Number.isSafeInteger(value) || value < 0)) {
    errors.push("欠薪账目无效");
  }
  if (!state.business?.inventoryCostWheatUnits?.town ||
      Object.values(state.business.inventoryCostWheatUnits.town).some(value => !Number.isSafeInteger(value) || value < 0)) {
    errors.push("作坊库存成本账无效");
  }
  if (!Number.isInteger(state.housing?.villageCapacity) || state.housing.villageCapacity <= 0) {
    errors.push("村舍基础住房容量无效");
  }
  if (!state.salt || !Number.isInteger(state.salt.demandCarry) ||
      state.salt.demandCarry < 0 || state.salt.demandCarry >= content.rules.daysPerYear ||
      !Number.isInteger(state.salt.graceDaysElapsed) || state.salt.graceDaysElapsed < 0 ||
      !Array.isArray(state.salt.history)) {
    errors.push("食盐需求结算状态无效");
  } else {
    for (const row of state.salt.history) {
      if (!Number.isSafeInteger(row.demandUnits) || row.demandUnits < 0 ||
          !Number.isSafeInteger(row.satisfiedUnits) || row.satisfiedUnits < 0 ||
          row.satisfiedUnits > row.demandUnits) errors.push("食盐日保障记录无效");
    }
  }
  for (const sector of ["forestry", "salt"]) {
    const industry = state.industries?.[sector];
    if (!industry) {
      errors.push("缺少行业经营账：" + sector);
      continue;
    }
    for (const period of PERIODS) {
      const group = industry[period];
      if (!group || !group.producedUnits ||
          !Number.isSafeInteger(group.soldUnits || 0) || (group.soldUnits || 0) < 0 ||
          !Number.isSafeInteger(group.revenueWheatUnits || 0) || (group.revenueWheatUnits || 0) < 0 ||
          !Number.isSafeInteger(group.operatingWagesWheatUnits || 0) || (group.operatingWagesWheatUnits || 0) < 0) {
        errors.push("行业经营账字段无效：" + sector + "/" + period);
      }
    }
  }
  for (const period of PERIODS) {
    const row = state.fiscal?.[period];
    if (!row || ["dueWheatUnits", "collectedWheatUnits", "waivedWheatUnits"]
      .some(key => !Number.isSafeInteger(row[key]) || row[key] < 0)) {
      errors.push("公租房财政账无效：" + period);
    }
  }
  const reform = state.monetaryReform;
  if (!reform || !["wheat", "voucher"].includes(reform.stage) || typeof reform.legacyBankAccess !== "boolean") {
    errors.push("货币改革状态无效");
  }
  const currencyCheck = validateCurrencyInvariant(state, content);
  if (!currencyCheck.valid) errors.push("粮券总账不守恒：账户余额与未注销发行量不一致");
  // 存款台账 = 银行现金 + 在贷余额 + 国债本金 − 留存利润：存款利息必须有现金支撑。
  if (!bankLedgerInvariant(state).valid) errors.push("银行存款台账与现金、贷款、国债不守恒");
  if (!state.stockExchange || typeof state.stockExchange !== "object" || Array.isArray(state.stockExchange) || typeof state.stockExchange.legacyAccess !== "boolean") {
    errors.push("交易所状态无效");
  }
  const physicalExchanges = state.buildings.filter(row => row.typeId === "stock_exchange");
  if (physicalExchanges.length > 1) errors.push("全镇交易所超过一座");
  if (!state.companies || typeof state.companies !== "object" || Array.isArray(state.companies)) {
    errors.push("上市企业账结构无效");
  } else {
    const companyBuildings = new Set();
    for (const [companyId, company] of Object.entries(state.companies)) {
      const building = state.buildings.find(row => row.id === company.buildingId);
      if (!building || !isIndustryType(content, company.typeId) || building.typeId !== company.typeId) {
        errors.push("企业引用了无效建筑：" + companyId);
        continue;
      }
      if (companyBuildings.has(company.buildingId)) errors.push("同一建筑存在多家公司：" + company.buildingId);
      companyBuildings.add(company.buildingId);
      if (!Number.isInteger(company.listedLevels) || company.listedLevels <= 0 || company.listedLevels !== (building.ownership?.listedLevels || 0)) errors.push("公司等级与建筑归属不一致：" + companyId);
      if (!company.settings || !Number.isFinite(company.settings.wagePerWorkerDay) || company.settings.wagePerWorkerDay < 0 ||
          !Number.isInteger(company.settings.targetWorkers) || company.settings.targetWorkers < 0) errors.push("公司经营设置无效：" + companyId);
      const maxCompanyWorkers = (content.buildings[company.typeId]?.jobs?.[0]?.slots || 0) * company.listedLevels;
      if ((company.settings?.targetWorkers || 0) > maxCompanyWorkers) errors.push("公司目标用工超过容量：" + companyId);
      if (!company.listing || typeof company.listing.listed !== "boolean") errors.push("公司上市状态无效：" + companyId);
      if (company.listing?.listed) {
        if (!/^\d{3}$/.test(company.listing.ticker || "")) errors.push("公司股票代码无效：" + companyId);
        if (!Number.isInteger(company.totalShares) || company.totalShares <= 0 || company.totalShares % company.listedLevels !== 0 ||
            !Number.isInteger(company.townShares) || company.townShares < 0 ||
            !Number.isInteger(company.residentShares) || company.residentShares < 0 ||
            !Number.isInteger(company.fundShares || 0) || (company.fundShares || 0) < 0 ||
            company.townShares + company.residentShares + (company.fundShares || 0) !== company.totalShares) errors.push("上市公司股份总数或持股结构无效：" + companyId);
        const householdShareSum = Object.values(company.householdShares || {}).reduce((sum, value) => sum + Math.max(0, value || 0), 0);
        if (householdShareSum !== company.residentShares) errors.push("居民逐户持股与公司居民持股不一致：" + companyId);
      } else {
        if ((company.totalShares || 0) !== 0 || (company.townShares || 0) !== 0 || (company.residentShares || 0) !== 0 || (company.fundShares || 0) !== 0 || Object.values(company.householdShares || {}).some(value => value)) errors.push("未上市公司不应存在股票：" + companyId);
      }
      if (!Number.isSafeInteger(company.cashVoucherUnits) || company.cashVoucherUnits < 0) errors.push("企业粮券余额无效：" + companyId);
      if (!Number.isSafeInteger(company.cashWheatUnits || 0) || (company.cashWheatUnits || 0) < 0) errors.push("企业支付小麦余额无效：" + companyId);
      for (const itemId of Object.keys(content.items)) {
        if (!Number.isSafeInteger(company.inventory?.[itemId]) || company.inventory[itemId] < 0) errors.push("企业库存无效：" + companyId + "/" + itemId);
        if (!Number.isSafeInteger(company.inventoryCostVoucherUnits?.[itemId]) || company.inventoryCostVoucherUnits[itemId] < 0) errors.push("企业库存成本无效：" + companyId + "/" + itemId);
      }
      if (!Number.isSafeInteger(company.payroll?.arrearsVoucherUnits) || company.payroll.arrearsVoucherUnits < 0) errors.push("企业欠薪无效：" + companyId);
      if (!Number.isSafeInteger(company.retainedEarningsVoucherUnits)) errors.push("企业未分配利润无效：" + companyId);
      // 发行池卖方：镇库（缺省）或某户家庭；挂出股数不得超过卖方实际持股（卖方持股含尚未售出的挂牌股份）。
      const shareSeller = company.shareSale?.sellerOwner;
      const sellerIsHousehold = Boolean(shareSeller) && shareSeller !== "town";
      if (sellerIsHousehold && !state.households?.byId?.[shareSeller]) errors.push("发行池卖方家庭不存在：" + companyId);
      const sellerHolding = sellerIsHousehold ? (company.householdShares?.[shareSeller] || 0) : (company.townShares || 0);
      if (!Number.isInteger(company.shareSale?.offeredShares) || company.shareSale.offeredShares < 0 || company.shareSale.offeredShares > sellerHolding ||
          !Number.isSafeInteger(company.shareSale?.sharePriceVoucherUnits || 0) || (company.shareSale?.sharePriceVoucherUnits || 0) < 0 ||
          !Number.isSafeInteger(company.shareSale?.cumulativeProceedsVoucherUnits || 0) || (company.shareSale?.cumulativeProceedsVoucherUnits || 0) < 0) {
        errors.push("企业股份出售记录无效：" + companyId);
      }
      for (const period of PERIODS) {
        const account = company.accounts?.[period];
        if (!account || ["revenueVoucherUnits", "cogsVoucherUnits", "wageExpenseVoucherUnits", "wagesPaidVoucherUnits", "inputPurchaseVoucherUnits", "taxCostVoucherUnits", "processingLossVoucherUnits", "profitVoucherUnits"]
          .some(key => !Number.isSafeInteger(account[key] || 0))) errors.push("企业核算账无效：" + companyId + "/" + period);
      }
    }
    // 上市申请与驳回冷却（docs/OWNERSHIP.md 第 2 条）：只查结构；业主变更后的失效申请由日结清理，不算非法。
    for (const [buildingId, application] of Object.entries(state.ipoApplications || {})) {
      if (!state.buildings.some(row => row.id === buildingId)) errors.push("上市申请引用了不存在的建筑：" + buildingId);
      if (!state.households?.byId?.[application?.householdId]) errors.push("上市申请的业主家庭不存在：" + buildingId);
      if (!(Number.isFinite(application?.offerPercent) && application.offerPercent > 0 && application.offerPercent <= 100)) errors.push("上市申请的卖出比例无效：" + buildingId);
      if (!(Number.isFinite(application?.priceVoucherPerShare) && application.priceVoucherPerShare > 0)) errors.push("上市申请的每股价无效：" + buildingId);
    }
    for (const [buildingId, cooldown] of Object.entries(state.ipoCooldowns || {})) {
      if (!Number.isInteger(cooldown?.untilSerial) || cooldown.untilSerial < 0) errors.push("上市冷却记录无效：" + buildingId);
    }
    const tickers = new Set();
    for (const company of Object.values(state.companies || {})) if (company.listing?.listed) {
      if (tickers.has(company.listing.ticker)) errors.push("股票代码重复：" + company.listing.ticker);
      tickers.add(company.listing.ticker);
    }
    for (const building of state.buildings) {
      if ((building.ownership?.listedLevels || 0) > 0 && !companyBuildings.has(building.id)) errors.push("建筑有公司等级但缺少公司：" + building.id);
    }
  }

  if (!state.shops || typeof state.shops !== "object" || Array.isArray(state.shops)) {
    errors.push("店铺账结构无效");
  } else {
    for (const shop of Object.values(state.shops)) {
      const shopTypeDef = content.rules.shopTypes?.[content.rules.shopTypes?.[shop.typeId]?.aliasOf || shop.typeId];
      const street = state.buildings.find(row => row.id === shop.buildingId && row.typeId === (shopTypeDef?.hostBuildingTypeId || "commercial_street"));
      if (!street && shop.status !== "closed") errors.push("店铺引用了无效商业街：" + shop.id);
      const owner = state.households?.byId?.[shop.ownerHouseholdId];
      if (!owner && !shop.collective) errors.push("店铺缺少家庭所有者：" + shop.id);
      if (!content.rules.shopTypes?.[shop.typeId]) errors.push("店铺类型无效：" + shop.id);
      if (!Number.isSafeInteger(shop.cashVoucherUnits) || shop.cashVoucherUnits < 0) errors.push("店铺粮券余额无效：" + shop.id);
      if (!Number.isSafeInteger(shop.cashWheatUnits || 0) || (shop.cashWheatUnits || 0) < 0) errors.push("店铺支付小麦余额无效：" + shop.id);
      if (!Number.isSafeInteger(shop.retainedEarningsVoucherUnits)) errors.push("店铺未分配利润无效：" + shop.id);
      if (!["open", "paused", "liquidating", "closed"].includes(shop.status)) errors.push("店铺状态无效：" + shop.id);
      for (const itemId of Object.keys(content.items)) if (!Number.isSafeInteger(shop.inventory?.[itemId] || 0) || (shop.inventory?.[itemId] || 0) < 0) errors.push("店铺库存无效：" + shop.id + "/" + itemId);
      for (const key of ["wageVoucherUnits", "rentVoucherUnits", "taxVoucherUnits"]) if (!Number.isSafeInteger(shop.liabilities?.[key] || 0) || (shop.liabilities?.[key] || 0) < 0) errors.push("店铺欠款无效：" + shop.id);
      const merchantKey = `shop:${shop.id}:merchant`;
      const clerkKey = `shop:${shop.id}:clerk`;
      const merchantCount = jobCount(state, merchantKey);
      const clerkCount = jobCount(state, clerkKey);
      if (!shop.collective && merchantCount > (shopTypeDef?.maxMerchants ?? content.rules.shopMaxMerchants ?? 4)) errors.push("商人超过上限：" + shop.id);
      const shopClerkMax = Number.isFinite(shopTypeDef?.maxClerks) ? shopTypeDef.maxClerks
        : shopTypeDef?.id === "general" ? (content.rules.generalStoreMaxClerks || 50) : (content.rules.shopMaxClerks || 20);
      if (clerkCount > shopClerkMax) errors.push("店员超过上限：" + shop.id);
      if (shop.status === "open") {
        if (!shop.collective && (!owner || !isActiveHousehold(owner) || (owner.jobs?.[merchantKey] || 0) < 1 || merchantCount < 1)) errors.push("商人岗位归属无效：" + shop.id);
      } else if (merchantCount || clerkCount) {
        errors.push("非营业店铺仍保留岗位：" + shop.id);
      }
    }
    for (const street of state.buildings.filter(row => content.buildings?.[row.typeId]?.shopHost)) {
      const active = Object.values(state.shops).filter(shop => shop.buildingId === street.id && shop.status !== "closed" && shop.status !== "liquidating");
      const streetDef = content.buildings[street.typeId];
      if (active.length > (street.level || 1) * streetDef.shopHost.slotsPerLevel) errors.push("商业街店铺超过容量：" + street.id);
      const roleSlots = role => (streetDef.jobs || []).filter(job => (job.shopRole || (job.id === "merchants" ? "merchant" : job.id === "shop_clerks" ? "clerk" : null)) === role).reduce((sum, job) => sum + job.slots, 0);
      const merchantCapacity = roleSlots("merchant") * (street.level || 1);
      const clerkCapacity = roleSlots("clerk") * (street.level || 1);
      const merchantCount = active.reduce((sum, shop) => sum + jobCount(state, `shop:${shop.id}:merchant`), 0);
      const clerkCount = active.reduce((sum, shop) => sum + jobCount(state, `shop:${shop.id}:clerk`), 0);
      if (merchantCount > merchantCapacity) errors.push("商业街商人超过容量：" + street.id);
      if (clerkCount > clerkCapacity) errors.push("商业街店员超过容量：" + street.id);
    }
  }
  const publicDemand = Math.ceil(populationStats(state).total / (content.rules.publicServiceDemandPopulation || 500));
  for (const roleId of ["civil_servants", "police"]) {
    const assigned = selectJobRows(state, content).rows.filter(row => row.roleId === roleId).reduce((sum, row) => sum + row.count, 0);
    if (assigned > publicDemand) errors.push("公共岗位超过全镇需求：" + roleId);
  }

  if (!Array.isArray(state.projects)) {
    errors.push("在建工程列表无效");
  } else {
    const projectInstanceIds = new Set();
    const projectPlotIds = new Set();
    for (const project of state.projects) {
      if (!project || typeof project !== "object") { errors.push("在建工程结构无效"); continue; }
      if (!content.buildings[project.typeId] ||
          !state.plots.some(function (plot) { return plot.id === project.plotId; }) ||
          !Number.isFinite(project.workDone) ||
          !Number.isFinite(project.workRequired) ||
          project.workDone < 0 || project.workDone >= project.workRequired) {
        errors.push("在建工程结构无效：" + (project.instanceId || project.plotId || "?"));
      }
      if (!project.instanceId || projectInstanceIds.has(project.instanceId)) errors.push("在建工程实例 ID 重复或缺失");
      projectInstanceIds.add(project.instanceId);
      // 每地块同时只能有一个工程或建筑
      if (projectPlotIds.has(project.plotId)) errors.push("同一地块存在多个在建工程");
      projectPlotIds.add(project.plotId);
      if (!Number.isInteger(project.workers) || project.workers < 0) errors.push("在建工程投入人数无效：" + (project.instanceId || "?"));
      const projectBuilding = project.kind === "upgrade"
        ? state.buildings.find(building => building.id === project.buildingId) : null;
      if (project.kind === "upgrade" && (!projectBuilding || projectBuilding.plotId !== project.plotId ||
          project.targetLevel !== (projectBuilding.level || 1) + 1)) errors.push("升级工程与目标建筑不一致");
      if (project.kind && !["build", "upgrade"].includes(project.kind)) errors.push("工程类型无效");
      if (state.buildings.some(function (building) { return building.plotId === project.plotId; }) && project.kind !== "upgrade") {
        errors.push("在建工程与已有建筑叠地");
      }
      if (project.materialsConsumed !== undefined && (!Array.isArray(project.materialsConsumed) ||
          project.materialsConsumed.some(row => !content.items[row.itemId] ||
            !Number.isSafeInteger(row.quantityUnits) || row.quantityUnits < 0))) {
        errors.push("工程材料记录无效");
      }
    }
  }
  const buildingIds = new Set();
  const plotIds = new Set();
  for (const plot of state.plots) {
    if (!plot?.id || plotIds.has(plot.id) || !Number.isFinite(plot.x) || !Number.isFinite(plot.y)) {
      errors.push("建设地块 ID 或坐标无效");
    }
    plotIds.add(plot.id);
  }
  const occupiedPlots = new Set();
  for (const building of state.buildings) {
    if (!building.id || buildingIds.has(building.id) || !content.buildings[building.typeId]) {
      errors.push("建筑实例 ID 或类型无效");
    }
    buildingIds.add(building.id);
    if (!Number.isInteger(building.level || 1) || (building.level || 1) < 1 || (building.level || 1) > (content.rules.buildingMaxLevel || 10)) {
      errors.push("建筑等级无效：" + building.id);
    }
    if (building.materialInvestments !== undefined && (!Array.isArray(building.materialInvestments) ||
        building.materialInvestments.some(row => !content.items[row.itemId] || !Number.isSafeInteger(row.quantityUnits) || row.quantityUnits < 0 || !["town", "residents"].includes(row.sourceOwner || "town")))) {
      errors.push("建筑材料投入记录无效：" + building.id);
    }
    if (occupiedPlots.has(building.plotId)) errors.push("同一地块存在多个建筑");
    occupiedPlots.add(building.plotId);
    if (!state.plots.some(function (plot) { return plot.id === building.plotId; })) {
      errors.push("建筑地块不存在：" + building.plotId);
    }
    if ((state.projects || []).some(project => project.plotId === building.plotId &&
        !(project.kind === "upgrade" && project.buildingId === building.id))) errors.push("在建工程与已有建筑叠地");
  }
  if (!Array.isArray(state.demolishedBuildings)) errors.push("拆除历史记录无效");
  errors.push(...validateMods(state, content, MODS));
  return { valid: errors.length === 0, errors };
}
