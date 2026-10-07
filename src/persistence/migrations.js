import { CONTENT } from "../content/index.js";
import { validateState } from "../core/validation.js";
import { addTownCostBasis } from "../economy/business.js";
import { syncShopEmployment } from "../systems/shops.js";
import { summarizeLegacyAnnualReports } from "../systems/annual-reports.js";
import { ensureWholesaleMarket, mergeWholesaleCashIntoTown } from "../systems/wholesale-market.js";
import { migrateSocialSecurityWallet } from "../systems/social-security.js";
import { migrateMonetaryReform } from "../economy/payment.js";
import { releaseExcessHouseholdEmployment, totalHouseholdAgeBands, householdList, syncResidentAggregates } from "../systems/households.js";
import {
  defaultWageRates, emptyBusinessState, emptyIndustryState, emptyFiscalState, ensureProjectAccessor
} from "../core/state.js";

function cloneJson(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// 旧档 state.project 是单对象或 null；幂等迁移为 state.projects 数组。
// 有则单元素（补齐并行施工所需字段），无则空数组。不改存档版本号，不重算既有收成/在岗。
function migrateProjects(raw, state) {
  if (Array.isArray(state.projects)) {
    state.projects = state.projects.filter(row => row && typeof row === "object");
  } else if (raw?.project && typeof raw.project === "object") {
    state.projects = [cloneJson(raw.project)];
  } else if (state.project && typeof state.project === "object") {
    state.projects = [state.project];
  } else {
    state.projects = [];
  }
  for (const project of state.projects) {
    project.kind ||= "build";
    if (!Array.isArray(project.materialsConsumed)) project.materialsConsumed = [];
    if (!Number.isInteger(project.workers) || project.workers < 0) {
      // 旧档没有“每工程投入人数”：按旧模型该工程独占全部营造工，迁移时如实登记。
      project.workers = Math.max(0, Math.floor(Number(project.workers) || 0));
    }
    if (!Number.isSafeInteger(project.prepaidWageCreditUnits)) project.prepaidWageCreditUnits = 0;
    if (project.kind === "upgrade") {
      project.targetLevel ||= (state.buildings?.find(row => row.id === project.buildingId)?.level || 1) + 1;
    }
  }
  // 兼容单工程访问器：旧迁移函数仍可能通过 state.project 读写。
  ensureProjectAccessor(state);
  return state;
}

function cohortBandTotals(state) {
  const totals = { children: 0, workers: 0, elders: 0 };
  for (const cohort of state.cohorts || []) {
    const count = Math.max(0, Number(cohort.m) || 0) + Math.max(0, Number(cohort.f) || 0);
    if (cohort.age < 18) totals.children += count;
    else if (cohort.age < 65) totals.workers += count;
    else totals.elders += count;
  }
  return totals;
}

function householdIdOrder(a, b) {
  const number = value => Number(String(value?.id || value || "").match(/(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
  return number(a) - number(b) || String(a?.id || a).localeCompare(String(b?.id || b));
}

function calibrateHouseholdBandsToCohorts(state) {
  const households = householdList(state).slice().sort(householdIdOrder);
  if (!households.length) throw new Error("v10 存档缺少家庭，无法迁移人口。");
  const before = totalHouseholdAgeBands(state);
  const target = cohortBandTotals(state);
  const adjustments = {};
  const touch = (household, band, delta) => {
    if (!delta) return;
    household.ageBands[band] += delta;
    adjustments[household.id] ||= { children: 0, workers: 0, elders: 0 };
    adjustments[household.id][band] += delta;
  };
  for (const band of ["children", "workers", "elders"]) {
    let delta = target[band] - households.reduce((sum, h) => sum + h.ageBands[band], 0);
    if (delta > 0) {
      let cursor = 0;
      while (delta > 0) {
        const household = households[cursor % households.length];
        touch(household, band, 1);
        delta -= 1;
        cursor += 1;
      }
    } else if (delta < 0) {
      let left = -delta;
      // Deterministic constrained removal: highest current count first, then stable household id.
      while (left > 0) {
        const candidates = households.filter(h => h.ageBands[band] > 0)
          .sort((a, b) => b.ageBands[band] - a.ageBands[band] || householdIdOrder(a, b));
        if (!candidates.length) throw new Error("v10 家庭人口校准失败：" + band);
        for (const household of candidates) {
          if (left <= 0) break;
          touch(household, band, -1);
          left -= 1;
        }
      }
    }
  }
  return { before, target, after: totalHouseholdAgeBands(state), adjustments };
}

function normalizeV11(raw, definitions) {
  const state = cloneJson(raw);
  state.version = 11;
  state.schemaVersion = 11;
  // 尽早把旧单工程迁移为 projects 数组并装好兼容访问器，后续归一化与运行期都按数组读写。
  migrateProjects(raw, state);
  state.accounts ||= { residents: {}, town: {} };
  for (const owner of ["residents", "town"]) {
    state.accounts[owner] ||= {};
    for (const itemId of Object.keys(definitions.items)) state.accounts[owner][itemId] ??= 0;
  }
  if (!state.households?.byId) throw new Error("v11 存档缺少家庭账户。");
  state.households.exchange ||= { dayKey: null, eligibleByHousehold: {}, usedByHousehold: {} };
  state.households.exchange.eligibleByHousehold ||= {};
  state.households.exchange.usedByHousehold ||= {};
  for (const household of Object.values(state.households.byId || {})) {
    household.ageBands ||= { children: 0, workers: 0, elders: 0 };
    household.jobs ||= {};
    household.inventory ||= {};
    for (const itemId of Object.keys(definitions.items)) household.inventory[itemId] ??= 0;
    household.voucherUnits ??= 0;
    household.shares ||= {};
    household.shopIds ||= [];
    household.operatingRights ||= [];
    household.life ||= { day: {}, year: {}, cumulative: {}, recent: [], satisfaction: null, satisfactionHistory: [] };
  }
  for (const building of state.buildings || []) {
    building.ownership ||= { townLevels: building.level || 1, privateLevels: 0, listedLevels: 0 };
    building.ownership.townLevels ??= building.level || 1;
    building.ownership.privateLevels ??= 0;
    building.ownership.listedLevels ??= 0;
    building.privateOwners ||= [];
  }
  state.market ||= {};
  state.market.pricesVoucherPerUnit = { ...(definitions.rules.marketPricesVoucherPerUnit || {}), ...(state.market.pricesVoucherPerUnit || {}) };
  state.market.operatingPlan ||= { updatedSerial: -1, rotation: {}, rows: {}, demand: {} };
  state.market.consumerHistory ||= { bread: [], salt: [], wood: [] };
  state.market.publicProcurementDemand ||= {};
  state.privateEconomy ||= {};
  state.privateEconomy.plans ||= {};
  state.privateEconomy.payrollByBuilding ||= {};
  for (const payroll of Object.values(state.privateEconomy.payrollByBuilding)) {
    payroll.claimsVoucherUnits ||= {};
    if (payroll.legacyUnattributedArrearsVoucherUnits === undefined) payroll.legacyUnattributedArrearsVoucherUnits = payroll.arrearsVoucherUnits || 0;
  }
  state.payroll ||= { arrearsVoucherUnits: {}, totals: {}, year: {} };
  state.payroll.creditorClaims ||= {};
  state.payroll.legacyUnattributedArrearsVoucherUnits ||= { ...(state.payroll.arrearsVoucherUnits || state.payroll.arrearsWheatUnits || {}) };
  state.shops ||= {};
  state.nextShopNumber ||= Object.keys(state.shops).length + 1;
  for (const shop of Object.values(state.shops)) {
    shop.inventory ||= {};
    for (const itemId of Object.keys(definitions.items)) shop.inventory[itemId] ??= 0;
    shop.history ||= [];
    shop.plan ||= { lastAdjustedSerial: -1 };
    shop.retainedEarningsVoucherUnits ??= 0;
    shop.liabilities ||= { wageVoucherUnits: 0, rentVoucherUnits: 0, taxVoucherUnits: 0 };
    shop.liabilities.claimsVoucherUnits ||= {};
    if (shop.liabilities.legacyUnattributedWageVoucherUnits === undefined) shop.liabilities.legacyUnattributedWageVoucherUnits = shop.liabilities.wageVoucherUnits || 0;
  }
  for (const company of Object.values(state.companies || {})) {
    company.inventory ||= {};
    for (const itemId of Object.keys(definitions.items)) company.inventory[itemId] ??= 0;
    company.householdShares ||= {};
    company.history ||= [];
    company.plan ||= { ageDays: 0 };
    company.payroll ||= { arrearsVoucherUnits: 0, cumulativePaidVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0 };
    company.payroll.claimsVoucherUnits ||= {};
    if (company.payroll.legacyUnattributedArrearsVoucherUnits === undefined) company.payroll.legacyUnattributedArrearsVoucherUnits = company.payroll.arrearsVoucherUnits || 0;
  }
  state.policy ||= {};
  state.policy.employmentExchangeJin ??= definitions.rules.employmentExchangeDefaultJin ?? 2;
  state.policy.shopRentVoucher ??= definitions.rules.shopRentDefaultVoucher ?? 1;
  state.policy.shopProfitTaxPercent ??= definitions.rules.shopProfitTaxDefaultPercent ?? 10;
  state.employment ||= {};
  state.employment.wageRates = { ...defaultWageRates(definitions), ...(state.employment.wageRates || {}) };
  delete state.employment.roles;
  delete state.employment.byBuilding;
  delete state.employment.privateByBuilding;
  delete state.employment.listedByBuilding;
  syncShopEmployment(state, definitions);
  syncResidentAggregates(state, definitions);
  return state;
}

function legacyVoucherObligation(units) {
  const value = Math.max(0, Math.round(Number(units) || 0));
  return { valueUnits: value, wheatValueUnits: 0, voucherValueUnits: value };
}

function normalizeV12(raw, definitions, legacyCompleted = false) {
  const state = normalizeV11(raw, definitions);
  state.version = 12;
  state.schemaVersion = 12;
  state.monetaryReform ||= { stage: "wheat", legacyBankAccess: false, started: null, completed: null };
  migrateMonetaryReform(state);
  state.monetaryReform.legacyBankAccess = Boolean(state.monetaryReform.legacyBankAccess || legacyCompleted);

  state.payroll.creditorPaymentClaims ||= {};
  for (const [payrollKey, claims] of Object.entries(state.payroll.creditorClaims || {})) {
    const target = state.payroll.creditorPaymentClaims[payrollKey] ||= {};
    for (const [householdId, units] of Object.entries(claims || {})) target[householdId] ||= legacyVoucherObligation(units);
  }
  state.payroll.legacyUnattributedPaymentClaims ||= {};
  for (const [key, units] of Object.entries(state.payroll.legacyUnattributedArrearsVoucherUnits || {})) {
    state.payroll.legacyUnattributedPaymentClaims[key] ||= legacyVoucherObligation(units);
  }

  for (const [buildingId, payroll] of Object.entries(state.privateEconomy.payrollByBuilding || {})) {
    payroll.claimsPayment ||= {};
    for (const [householdId, units] of Object.entries(payroll.claimsVoucherUnits || {})) payroll.claimsPayment[householdId] ||= legacyVoucherObligation(units);
    payroll.legacyUnattributedPaymentClaim ||= legacyVoucherObligation(payroll.legacyUnattributedArrearsVoucherUnits || 0);
  }
  for (const shop of Object.values(state.shops || {})) {
    shop.cashWheatUnits ??= 0;
    shop.liabilities.claimsPayment ||= {};
    for (const [householdId, units] of Object.entries(shop.liabilities.claimsVoucherUnits || {})) shop.liabilities.claimsPayment[householdId] ||= legacyVoucherObligation(units);
    shop.liabilities.legacyUnattributedWagePaymentClaim ||= legacyVoucherObligation(shop.liabilities.legacyUnattributedWageVoucherUnits || 0);
    shop.liabilities.rentPaymentClaim ||= legacyVoucherObligation(shop.liabilities.rentVoucherUnits || 0);
    shop.liabilities.taxPaymentClaim ||= legacyVoucherObligation(shop.liabilities.taxVoucherUnits || 0);
  }
  for (const company of Object.values(state.companies || {})) {
    company.cashWheatUnits ??= 0;
    company.payroll.claimsPayment ||= {};
    for (const [householdId, units] of Object.entries(company.payroll.claimsVoucherUnits || {})) company.payroll.claimsPayment[householdId] ||= legacyVoucherObligation(units);
    company.payroll.legacyUnattributedPaymentClaim ||= legacyVoucherObligation(company.payroll.legacyUnattributedArrearsVoucherUnits || 0);
  }
  state.legacyMigration = { ...(state.legacyMigration || {}), toVersion: 12, v12: { ...(state.legacyMigration?.v12 || {}), monetaryReformCompatibility: legacyCompleted ? "completed" : "native" } };
  syncShopEmployment(state, definitions);
  syncResidentAggregates(state, definitions);
  return state;
}

function normalizeV13(raw, definitions, legacyCompleted = false) {
  const state = normalizeV12(raw, definitions, legacyCompleted);
  state.version = 13;
  state.schemaVersion = 13;
  state.employment ||= {};
  state.employment.targets ||= {};
  if (!Number.isInteger(state.employment.targets.farmers)) {
    state.employment.targets.farmers = householdList(state).reduce((sum, household) => sum + Math.max(0, household.jobs?.farmers || 0), 0);
  }
  state.services ||= {};
  state.services.demandByHousehold ||= {};
  state.services.carryByHousehold ||= {};
  state.services.rotation ||= { households: 0, shops: {}, services: 0 };
  state.services.rotation.shops ||= {};
  state.services.day ||= { demandedUses: {}, servedUses: {}, spendingVoucherUnits: 0 };
  state.services.history = Array.isArray(state.services.history) ? state.services.history : [];
  for (const household of householdList(state)) {
    state.services.demandByHousehold[household.id] ||= {};
    state.services.carryByHousehold[household.id] ||= {};
    for (const serviceId of Object.keys(definitions.rules.serviceTypes || {})) {
      state.services.demandByHousehold[household.id][serviceId] ??= 0;
      state.services.carryByHousehold[household.id][serviceId] ??= 0;
    }
  }
  for (const shop of Object.values(state.shops || {})) {
    const oldTypeId = shop.typeId;
    const oldDef = definitions.rules.shopTypes?.[oldTypeId];
    const legacyItem = oldDef?.aliasOf ? oldDef.itemId : null;
    if (oldDef?.aliasOf) {
      shop.legacyTypeId ||= oldTypeId;
      shop.typeId = oldDef.aliasOf;
      shop.primaryItemId ||= shop.itemId || legacyItem || "wheat";
    }
    const def = definitions.rules.shopTypes?.[shop.typeId];
    shop.itemId = shop.primaryItemId || shop.itemId || def?.itemIds?.[0] || null;
    shop.itemIds = def?.kind === "retail" ? [...(def.itemIds || [])] : [];
    shop.serviceId = def?.kind === "service" ? def.serviceId : null;
    for (const period of ["day", "year", "cumulative"]) {
      shop.accounts ||= {};
      shop.accounts[period] ||= {};
      shop.accounts[period].soldUnits ||= {};
      shop.accounts[period].purchasedUnits ||= {};
      shop.accounts[period].serviceUses ||= {};
      shop.accounts[period].customerCount ||= 0;
    }
    shop.history = (shop.history || []).map(row => ({ ...row, soldUnitsByItem: { ...(row.soldUnitsByItem || (shop.primaryItemId ? { [shop.primaryItemId]: row.soldUnits || 0 } : {})) }, serviceUses: { ...(row.serviceUses || {}) }, customerCount: row.customerCount || 0 }));
  }
  state.legacyMigration = { ...(state.legacyMigration || {}), toVersion: 13, v13: { ...(state.legacyMigration?.v13 || {}), agricultureTargetFromActual: true, commercialStreet: "general_store+services" } };
  syncShopEmployment(state, definitions);
  syncResidentAggregates(state, definitions);
  return state;
}

function gcdInt(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function normalizeV14(raw, definitions, legacyCompleted = false) {
  const state = normalizeV13(raw, definitions, legacyCompleted);
  state.version = 14;
  state.schemaVersion = 14;
  state.stockExchange ||= { legacyAccess: false, rotation: 0 };
  state.stockExchange.rotation ||= 0;
  const usedCodes = new Set();
  let codeCursor = 0;
  const nextCode = () => {
    while (codeCursor < 1000) {
      const code = String(codeCursor++).padStart(3, "0");
      if (!usedCodes.has(code)) { usedCodes.add(code); return code; }
    }
    throw new Error("旧公司数量超过三位股票代码容量");
  };
  for (const company of Object.values(state.companies || {}).sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    company.settings ||= { wagePerWorkerDay: null, targetWorkers: null, salePricesVoucherPerUnit: {} };
    company.settings.salePricesVoucherPerUnit ||= {};
    const definition = definitions.buildings[company.typeId];
    const job = definition?.jobs?.[0];
    if (!Number.isFinite(company.settings.wagePerWorkerDay)) company.settings.wagePerWorkerDay = state.employment?.wageRates?.[job?.id] ?? job?.wagePerWorkerDay ?? 5;
    if (!Number.isInteger(company.settings.targetWorkers)) company.settings.targetWorkers = Math.min(job?.slots * company.listedLevels || 0, company.plan?.desiredWorkers ?? job?.slots * company.listedLevels ?? 0);
    company.annualSettlement ||= { lastSettledYear: company.lastDividendYear || 0, lastYearNetProfitVoucherUnits: 0, workingCapitalTargetVoucherUnits: 0, distributedVoucherUnits: 0, undistributedVoucherUnits: company.retainedEarningsVoucherUnits || 0 };

    const hadShares = Number.isInteger(company.totalShares) && company.totalShares > 0;
    if (hadShares) {
      // 旧公司都是“上市即成立”。迁移后保留为上市状态。
      const levels = Math.max(1, company.listedLevels || 1);
      if (company.totalShares % levels !== 0) {
        const factor = levels / gcdInt(company.totalShares, levels);
        company.totalShares *= factor;
        company.townShares *= factor;
        company.residentShares *= factor;
        for (const householdId of Object.keys(company.householdShares || {})) company.householdShares[householdId] *= factor;
        for (const household of householdList(state)) {
          if (household.shares?.[company.id]) household.shares[company.id] *= factor;
        }
      }
      let ticker = /^\d{3}$/.test(company.listing?.ticker || "") ? company.listing.ticker : null;
      if (ticker && usedCodes.has(ticker)) ticker = null;
      if (ticker) usedCodes.add(ticker); else ticker = nextCode();
      company.listing = { listed: true, ticker, listedAt: company.listing?.listedAt || { legacy: true } };
      state.stockExchange.legacyAccess = true;
    } else {
      company.totalShares = 0; company.townShares = 0; company.residentShares = 0; company.householdShares ||= {};
      company.listing = { listed: false, ticker: null, listedAt: null };
    }
  }
  state.legacyMigration = { ...(state.legacyMigration || {}), toVersion: 14, v14: { independentCompanies: true, exchangeCompatibility: state.stockExchange.legacyAccess, integerShareSplit: true } };
  syncShopEmployment(state, definitions);
  syncResidentAggregates(state, definitions);
  return state;
}

function normalizeV15(raw, definitions, legacyCompleted = false) {
  const state = normalizeV14(raw, definitions, legacyCompleted);
  state.version = 15;
  state.schemaVersion = 15;
  for (const shop of Object.values(state.shops || {})) {
    for (const period of ["day", "year", "cumulative"]) {
      shop.accounts ||= {};
      shop.accounts[period] ||= {};
      shop.accounts[period].distributedVoucherUnits ??= 0;
    }
  }
  // r05：旧兑付储备一次性释放回镇库；以后换券只转移镇库已印粮券，小麦直接进入镇库，不再维护独立储备。
  state.currency ||= {};
  if (state.currency.reserveModel !== "town-inventory-v1") {
    const legacyReserve = Math.max(0, Math.floor(state.currency.reserveWheatUnits || 0));
    const legacyCost = Math.max(0, Math.floor(state.currency.reserveWheatCostVoucherUnits || 0));
    if (legacyReserve > 0) {
      state.accounts.town.wheat = (state.accounts.town.wheat || 0) + legacyReserve;
      addTownCostBasis(state, "wheat", legacyCost);
    }
    state.currency.reserveWheatUnits = 0;
    state.currency.reserveWheatCostVoucherUnits = 0;
    state.currency.reserveModel = "town-inventory-v1";
  }

  // r03 可能把商业街聚合岗位错记为镇库欠薪。仅清理内容定义明确 managedBy=shops 的 key，
  // 真实镇营岗位、公司岗位和店铺自身 liabilities 均不受影响。
  state.payroll ||= {};
  state.payroll.arrearsVoucherUnits ||= state.payroll.arrearsWheatUnits || {};
  state.payroll.creditorClaims ||= {};
  state.payroll.creditorPaymentClaims ||= {};
  state.payroll.legacyUnattributedArrearsVoucherUnits ||= {};
  for (const building of state.buildings || []) {
    const def = definitions.buildings?.[building.typeId];
    for (const job of def?.jobs || []) {
      if (job.managedBy !== "shops") continue;
      const key = `${building.id}::${job.id}`;
      delete state.payroll.arrearsVoucherUnits[key];
      delete state.payroll.creditorClaims[key];
      delete state.payroll.creditorPaymentClaims[key];
      delete state.payroll.legacyUnattributedArrearsVoucherUnits[key];
    }
  }
  state.payroll.arrearsWheatUnits = state.payroll.arrearsVoucherUnits;

  // 0.2.3 做市商：旧档若已有批发市场挂价则沿用（玩家可能已调过），缺项补做市商默认价。
  mergeWholesaleCashIntoTown(state);
  ensureWholesaleMarket(state, definitions);
  state.services ||= {};
  state.services.demandByHousehold ||= {};
  state.services.carryByHousehold ||= {};
  state.services.pricesVoucherPerUse ||= {};
  for (const def of Object.values(definitions.rules.serviceTypes || {})) {
    if (!(Number.isFinite(state.services.pricesVoucherPerUse[def.id]) && state.services.pricesVoucherPerUse[def.id] >= 0)) {
      state.services.pricesVoucherPerUse[def.id] = def.priceVoucher || 0;
    }
  }
  state.services.mealsByHousehold ||= {};
  state.services.rotation ||= { households: 0, shops: {}, services: 0 };
  state.services.rotation.shops ||= {};

  // 0.2.0 adds more v15 fields without bumping the save version. Older v15 saves
  // must receive the same neutral defaults as a new game before validation.
  state.policy ||= {};
  state.policy.villa ||= { priceWheatJin: 10000, taxRatePercent: 0.5 };
  state.policy.villa.priceWheatJin ??= 10000;
  state.policy.villa.taxRatePercent ??= 0.5;
  state.policy.wageControl ||= { civil: 1.0, industry: 1.0 };
  state.policy.wageControl.civil ??= 1.0;
  state.policy.wageControl.industry ??= 1.0;
  state.policy.tradeTariffRate ??= 5;
  // 自动存档频率是 v15 内新增的策略字段，旧档缺失时补默认"每月"（读取方虽有 ?? 1 兜底，仍按铁律补齐）。
  state.policy.autosaveMonths ??= 1;
  state.socialSecurity ||= { enabled: false, dailyPerWorkerJin: 1, pensionPerElderJin: 2, cashVoucherUnits: 0, cashWheatUnits: 0, debtToTownUnits: 0, totalInjectedUnits: 0, totalAdvancedUnits: 0, totalRepaidUnits: 0, totalCollectedUnits: 0, totalPaidUnits: 0, totalDividendUnits: 0 };
  state.socialSecurity.enabled ??= false;
  state.socialSecurity.dailyPerWorkerJin ??= 1;
  state.socialSecurity.pensionPerElderJin ??= 2;
  state.socialSecurity.totalInjectedUnits ??= 0;
  state.socialSecurity.totalCollectedUnits ??= 0;
  state.socialSecurity.totalPaidUnits ??= 0;
  migrateSocialSecurityWallet(state);
  state.villas ||= { sold: [], taxArrearsValueUnits: {}, stats: {} };
  if (!Array.isArray(state.villas.sold)) state.villas.sold = [];
  state.villas.taxArrearsValueUnits ||= {};
  state.villas.stats ||= {};
  state.villas.stats.soldTotal ??= 0;
  state.villas.stats.revenueValueUnits ??= 0;
  state.villas.stats.taxCollectedValueUnits ??= 0;
  state.villas.stats.taxArrearsValueUnits ??= 0;
  state.outsideTown ||= { name: "民镇", rulers: ["民镇议事会"], landMu: 10000, laborers: 1000, population: 3500, wheatStockJin: 3000000, saltStockJin: 20000, woodStockUnits: 8000, relations: 60, prosperity: 60, saltDemand: 1.4, woodDemand: 1.3, grainDemand: 0.7, weather: 1.0, event: null, tradeClosed: false, stats: {} };
  // 民镇（原四地主镇）：老存档补名字迁移与盐/木材库存、外交关系分默认值。
  if (state.outsideTown.name === "四地主镇") state.outsideTown.name = "民镇";
  // 执政迁移：四地主 → 民镇议事会（与改名保持一致，存档本体一次收敛）。
  if (Array.isArray(state.outsideTown.rulers) &&
      state.outsideTown.rulers.join("|") === ["陈", "王", "李", "赵"].join("|")) {
    state.outsideTown.rulers = ["民镇议事会"];
  }
  state.outsideTown.saltStockJin ??= 20000;
  state.outsideTown.woodStockUnits ??= 8000;
  state.outsideTown.relations ??= 60;
  // 长期贸易协定（民镇）：老存档补空数组，字段由 trade-agreements.js 的 ||= 兜底。
  if (!Array.isArray(state.tradeAgreements)) state.tradeAgreements = [];
  state.outsideTown.stats ||= {};
  // 动态劳动力市场（用户 0.1.11）：挖人竞争统计。
  state.laborCompetition ||= { dayKey: null, day: { moves: 0 }, year: { moves: 0 }, recent: [] };
  state.laborCompetition.day ||= { moves: 0 };
  state.laborCompetition.year ||= { moves: 0 };
  if (!Array.isArray(state.laborCompetition.recent)) state.laborCompetition.recent = [];
  // 经济历史曲线（用户 0.1.11）。
  if (!Array.isArray(state.economyHistory)) state.economyHistory = [];

  // Earlier v15 saves can contain household age-band aggregates that drifted
  // from the authoritative cohorts. Reconcile deterministically so the existing
  // v15 save remains playable, then release only assignments that no longer fit.
  const householdBands = totalHouseholdAgeBands(state);
  const cohortBands = cohortBandTotals(state);
  if (["children", "workers", "elders"].some(band => householdBands[band] !== cohortBands[band])) {
    calibrateHouseholdBandsToCohorts(state);
    releaseExcessHouseholdEmployment(state);
  }

  state.annualReports = summarizeLegacyAnnualReports(state);
  // 开荒是 v15 内的增量字段：旧档没有该字段时按“初始已开荒亩数”补齐，
  // 不改变存档版本号，也不重算既有收成与在岗农人。
  state.agriculture ||= { workUnits: 0, lastHarvestYear: 0 };
  const acresMaximum = definitions.agriculture.acresMaximum ?? definitions.agriculture.acres;
  if (!Number.isInteger(state.agriculture.reclaimedAcres)) {
    const legacyAcres = Number.isInteger(state.agriculture.acres)
      ? state.agriculture.acres : definitions.agriculture.acres;
    state.agriculture.reclaimedAcres = Math.max(0, Math.min(acresMaximum, legacyAcres));
  }
  state.agriculture.reclaimedAcres = Math.max(0, Math.min(acresMaximum, Math.floor(state.agriculture.reclaimedAcres)));
  state.agriculture.reclaim ||= {
    day: { acres: 0, workDays: 0, paidVoucherUnits: 0 },
    year: { acres: 0, workDays: 0, paidVoucherUnits: 0 },
    cumulative: { acres: 0, workDays: 0, paidVoucherUnits: 0 },
    last: null,
    history: []
  };
  for (const period of ["day", "year", "cumulative"]) {
    state.agriculture.reclaim[period] ||= { acres: 0, workDays: 0, paidVoucherUnits: 0 };
  }
  if (!Array.isArray(state.agriculture.reclaim.history)) state.agriculture.reclaim.history = [];
  state.legacyMigration = {
    ...(state.legacyMigration || {}),
    toVersion: 15,
    v15: { annualReportSummary: true, saveContainerVersion: 2, r04TownInventoryExchange: true, r04ShopPayrollCleanup: true, reclaimFarmland: true, parallelConstruction: true }
  };
  // v12–v15 直接进入本函数时也要保证 projects 数组与兼容访问器就位。
  migrateProjects(raw, state);
  syncShopEmployment(state, definitions);
  syncResidentAggregates(state, definitions);
  return state;
}

export function migrateSave(raw, content) {
  const definitions = content || CONTENT;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("存档必须是 JSON 对象。");
  const current = definitions.rules.saveVersion || 15;
  const stored = Math.max(Number(raw.schemaVersion) || 0, Number(raw.version) || 0);
  if (stored > current) throw new Error("该存档来自更高版本，当前版本无法读取。");
  // 只读取 v15 存档（0.1.10 起一直是 v15）；更早的存档请开新局。
  if (stored !== 15) throw new Error("旧版存档不兼容，请开始新游戏。");
  const state = normalizeV15(raw, definitions, false);
  const result = validateState(state, definitions);
  if (!result.valid) throw new Error("存档校验失败：" + result.errors.join("；"));
  return state;
}

