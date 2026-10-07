import { CONTENT } from "../content/index.js";
import { emptyYearTotals } from "../economy/ledger.js";
import { quantityToUnits, qeqJinToUnits } from "../economy/inventory.js";
import { validateState } from "../core/validation.js";
import { emptyFinancialFlowPeriod } from "../economy/financial-flows.js";
import { addTownCostBasis } from "../economy/business.js";
import { syncShopEmployment } from "../systems/shops.js";
import { summarizeLegacyAnnualReports } from "../systems/annual-reports.js";
import { ensureWholesaleMarket, mergeWholesaleCashIntoTown } from "../systems/wholesale-market.js";
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

function migrateLegacyLedger(rows, content) {
  const typeMap = {
    harvest: "harvest",
    consume: "legacy_consume",
    relief: "relief",
    wage: "wage",
    construction: "construction",
    process: "legacy_process",
    loss: "legacy_loss",
    transfer: "legacy_transfer"
  };
  return (rows || []).map(function (row, index) {
    let source = null;
    let destination = null;
    if (row.detail?.includes("镇库 → 居民")) {
      source = "town";
      destination = "residents";
    } else if (row.detail?.includes("居民 → 镇库")) {
      source = "residents";
      destination = "town";
    } else if (row.type === "consume") {
      source = "residents";
      destination = "consumed";
    } else if (row.type === "harvest") {
      source = "field";
      destination = "accounts";
    } else if (row.type === "loss") {
      source = "processing";
      destination = "loss";
    }
    const hasQeq = ["consume", "relief", "wage", "construction", "transfer"].includes(row.type);
    return {
      id: index + 1,
      transactionId: "legacy-v1-" + index,
      year: row.year || 1,
      day: row.day || 1,
      type: typeMap[row.type] || "legacy_entry",
      source,
      destination,
      itemId: null,
      quantityUnits: 0,
      qeqUnits: qeqJinToUnits(Number(row.amount) || 0, content),
      legacyAmount: Number(row.amount) || 0,
      legacyDetail: row.detail || "",
      reason: row.reason || "旧版账目",
      legacyQuantityWasQeq: hasQeq
    };
  });
}

function convertV1(raw, content) {
  const required = [
    raw?.version === 1,
    Number.isInteger(raw.year),
    Number.isInteger(raw.day),
    raw.stocks?.residents,
    raw.stocks?.town,
    Array.isArray(raw.cohorts),
    raw.jobs,
    Array.isArray(raw.plots),
    Array.isArray(raw.buildings),
    Number.isInteger(raw.seed)
  ];
  if (required.includes(false)) throw new Error("v1 存档缺少必要字段，原存档已保留。");

  const buildings = raw.buildings.map(function (building, index) {
    const typeId = building.typeId || building.type;
    if (!content.buildings[typeId]) throw new Error("v1 存档含未知建筑：" + typeId);
    return {
      id: building.id || "legacy-building-" + (index + 1),
      typeId,
      plotId: building.plotId,
      x: building.x,
      y: building.y,
      completed: null
    };
  });
  const project = raw.project ? {
    instanceId: raw.project.instanceId || "legacy-project-" + (buildings.length + 1),
    typeId: raw.project.typeId || raw.project.type,
    plotId: raw.project.plotId,
    workDone: Number(raw.project.workDone) || 0,
    workRequired: Number(raw.project.workRequired) || 0,
    recommendedWorkers: Number(raw.project.recommendedWorkers) || 0,
    costQeqUnits: qeqJinToUnits(Number(raw.project.cost) || 0, content),
    started: null
  } : null;
  if (project && !content.buildings[project.typeId]) {
    throw new Error("v1 在建工程引用未知建筑：" + project.typeId);
  }

  const employment = {
    roles: {
      farmers: Number(raw.jobs.farmers) || 0,
      builders: Number(raw.jobs.builders) || 0
    },
    byBuilding: {}
  };
  for (const building of buildings) {
    employment.byBuilding[building.id] = {};
    const definition = content.buildings[building.typeId];
    for (const job of definition.jobs || []) employment.byBuilding[building.id][job.id] = 0;
  }
  const legacyJobs = [
    ["mill", "millers"],
    ["bakery", "bakers"]
  ];
  for (const [typeId, roleId] of legacyJobs) {
    let left = Number(raw.jobs[roleId]) || 0;
    for (const building of buildings.filter(function (item) { return item.typeId === typeId; })) {
      const definition = content.buildings[typeId];
      const job = definition.jobs.find(function (item) { return item.id === roleId; });
      if (!job) continue;
      const assigned = Math.min(left, job.slots);
      employment.byBuilding[building.id][roleId] = assigned;
      left -= assigned;
    }
    if (left > 0) throw new Error("v1 岗位数量无法映射到已建建筑，原存档已保留。");
  }

  const accounts = { residents: {}, town: {} };
  for (const itemId of Object.keys(content.items)) {
    accounts.residents[itemId] = 0;
    accounts.town[itemId] = 0;
  }
  for (const itemId of Object.keys(content.items)) {
    accounts.residents[itemId] = quantityToUnits(Number(raw.stocks.residents[itemId]) || 0, content);
    accounts.town[itemId] = quantityToUnits(Number(raw.stocks.town[itemId]) || 0, content);
  }

  const yearTotals = emptyYearTotals();
  const oldTotals = raw.yearTotals || {};
  yearTotals.harvestQeq = qeqJinToUnits(oldTotals.harvest || 0, content);
  yearTotals.consumptionQeq = qeqJinToUnits(oldTotals.consumption || 0, content);
  yearTotals.operatingWagesQeq = qeqJinToUnits(oldTotals.operatingWages || 0, content);
  yearTotals.constructionPayQeq = qeqJinToUnits(oldTotals.constructionPay || 0, content);
  yearTotals.reliefQeq = qeqJinToUnits(oldTotals.relief || 0, content);
  yearTotals.processingLossQeq = qeqJinToUnits(oldTotals.processingLoss || 0, content);

  const state = {
    version: 2,
    schemaVersion: 2,
    year: raw.year,
    day: raw.day,
    accounts,
    cohorts: cloneJson(raw.cohorts),
    employment,
    agriculture: {
      workUnits: Math.round((Number(raw.cropWorkDays) || 0) *
        content.agriculture.acres / content.agriculture.acresPerFarmer),
      lastHarvestYear: raw.day >= content.rules.growingDays ? raw.year : raw.year - 1
    },
    plots: cloneJson(raw.plots),
    buildings,
    project,
    nextInstanceNumber: buildings.length + (project ? 1 : 0) + 1,
    autoRelief: Boolean(raw.autoRelief),
    satisfaction: Number.isFinite(raw.satisfaction) ? raw.satisfaction : 75,
    shortageQeq: Math.round((Number(raw.shortage) || 0) * content.precision.qeqUnitsPerJin),
    rng: { algorithm: "lcg32-v1", state: raw.seed >>> 0 },
    lastDemography: cloneJson(raw.lastDemography || { births: 0, deaths: 0, marriages: 0 }),
    yearTotals,
    annualReports: [],
    ledger: migrateLegacyLedger(raw.ledger, content),
    ledgerSequence: (raw.ledger || []).length,
    transactionSequence: (raw.ledger || []).length,
    events: cloneJson(raw.events || []),
    legacyMigration: { fromVersion: 1 }
  };

  for (const building of state.buildings) {
    for (const job of content.buildings[building.typeId].jobs || []) {
      if (!(job.id in state.employment.byBuilding[building.id])) {
        state.employment.byBuilding[building.id][job.id] = 0;
      }
    }
  }
  if (state.project && state.project.workRequired <= 0) {
    throw new Error("v1 在建工程施工工日无效，原存档已保留。");
  }
  return state;
}

function normalizeV2(raw, content) {
  const state = cloneJson(raw);
  if (state.schemaVersion !== 2 || state.version !== 2) {
    throw new Error("不支持此存档版本：" + (state.schemaVersion || state.version));
  }
  for (const owner of ["residents", "town"]) {
    if (!state.accounts?.[owner]) throw new Error("v2 存档缺少账户：" + owner);
    for (const itemId of Object.keys(content.items)) {
      if (state.accounts[owner][itemId] === undefined) state.accounts[owner][itemId] = 0;
    }
  }
  state.yearTotals = { ...emptyYearTotals(), ...(state.yearTotals || {}) };
  state.annualReports = Array.isArray(state.annualReports) ? state.annualReports : [];
  state.ledger = (Array.isArray(state.ledger) ? state.ledger : []).map(row => ({
    ...row,
    day: Math.max(1, Math.min(content.rules.daysPerYear, Number(row?.day) || 1))
  }));
  state.events = (Array.isArray(state.events) ? state.events : []).map(event => ({
    ...event,
    day: Math.max(1, Math.min(content.rules.daysPerYear, Number(event?.day) || 1))
  }));
  state.ledgerSequence = Number.isInteger(state.ledgerSequence)
    ? state.ledgerSequence : state.ledger.length;
  state.transactionSequence = Number.isInteger(state.transactionSequence)
    ? state.transactionSequence : 0;
  if (!state.rng && Number.isInteger(state.seed)) {
    state.rng = { algorithm: "lcg32-v1", state: state.seed >>> 0 };
  }
  if (state.agriculture && state.agriculture.workUnits === undefined) {
    state.agriculture.workUnits = Math.round((Number(state.cropWorkDays) || 0) *
      content.agriculture.acres / content.agriculture.acresPerFarmer);
  }
  if (state.agriculture && state.agriculture.lastHarvestYear === undefined) {
    state.agriculture.lastHarvestYear = state.day >= content.rules.growingDays
      ? state.year : state.year - 1;
  }
  for (const building of state.buildings || []) {
    if (!state.employment?.byBuilding?.[building.id]) {
      if (!state.employment) state.employment = { roles: { farmers: 0, builders: 0 }, byBuilding: {} };
      if (!state.employment.roles) state.employment.roles = { farmers: 0, builders: 0 };
      if (!state.employment.byBuilding) state.employment.byBuilding = {};
      state.employment.byBuilding[building.id] = {};
    }
    const definition = content.buildings[building.typeId];
    for (const job of definition?.jobs || []) {
      if (state.employment.byBuilding[building.id][job.id] === undefined) {
        state.employment.byBuilding[building.id][job.id] = 0;
      }
    }
  }
  state.version = 2;
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

function upgradeV10ToV11(raw, content) {
  const state = cloneJson(raw);
  if (Math.max(Number(state.schemaVersion) || 0, Number(state.version) || 0) !== 10) {
    throw new Error("仅支持从 v10 迁移到 v11。");
  }
  if (!state.households?.byId || !state.households?.members) throw new Error("v10 存档缺少家庭成员数据，原存档未更改。");
  const members = state.households.members;
  for (const household of Object.values(state.households.byId)) {
    if (!Array.isArray(household.memberIds)) throw new Error("v10 家庭成员索引缺失：" + household.id);
    const ageBands = { children: 0, workers: 0, elders: 0 };
    const jobs = {};
    for (const memberId of household.memberIds) {
      const member = members[memberId];
      if (!member) throw new Error("v10 家庭成员引用失效：" + memberId);
      const age = Number(member.age);
      if (!Number.isInteger(age) || age < 0) throw new Error("v10 家庭成员年龄无效：" + memberId);
      if (age < 18) ageBands.children += 1;
      else if (age < 65) {
        ageBands.workers += 1;
        if (member.jobKey) jobs[member.jobKey] = (jobs[member.jobKey] || 0) + 1;
      } else ageBands.elders += 1;
    }
    household.ageBands = ageBands;
    household.jobs = jobs;
    delete household.memberIds;
  }
  delete state.households.members;
  delete state.households.nextMemberNumber;
  state.households.exchange = { dayKey: null, eligibleByHousehold: {}, usedByHousehold: {} };
  for (const shop of Object.values(state.shops || {})) {
    delete shop.merchantMemberId;
    delete shop.clerkMemberIds;
  }
  const populationCalibration = calibrateHouseholdBandsToCohorts(state);
  const employmentReleases = releaseExcessHouseholdEmployment(state);
  state.employment = { wageRates: { ...defaultWageRates(content), ...(state.employment?.wageRates || {}) } };
  state.version = 11;
  state.schemaVersion = 11;
  state.legacyMigration = {
    ...(state.legacyMigration || {}),
    fromVersion: state.legacyMigration?.fromVersion || 10,
    toVersion: 11,
    v11: {
      populationAuthority: "cohort",
      householdModel: "ageBands+jobs",
      populationCalibration,
      employmentReleases
    }
  };
  syncShopEmployment(state, content);
  syncResidentAggregates(state, content);
  return state;
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
  state.monetaryReform ||= legacyCompleted ? {
    stage: "voucher", targetVoucherBps: 10000, residentExchangeEnabled: true, legacyBankAccess: true,
    started: null, completed: { legacy: true }, paymentHistory: [], voucherShortfallByKey: {}
  } : {
    stage: "wheat", targetVoucherBps: 0, residentExchangeEnabled: false, legacyBankAccess: false,
    started: null, completed: null, paymentHistory: [], voucherShortfallByKey: {}
  };
  if (!["wheat", "transition", "voucher"].includes(state.monetaryReform.stage)) state.monetaryReform.stage = legacyCompleted ? "voucher" : "wheat";
  state.monetaryReform.targetVoucherBps = Math.max(0, Math.min(10000, Math.round(Number(state.monetaryReform.targetVoucherBps) || 0)));
  state.monetaryReform.residentExchangeEnabled = Boolean(state.monetaryReform.residentExchangeEnabled);
  state.monetaryReform.legacyBankAccess = Boolean(state.monetaryReform.legacyBankAccess || legacyCompleted);
  state.monetaryReform.paymentHistory = Array.isArray(state.monetaryReform.paymentHistory) ? state.monetaryReform.paymentHistory : [];
  state.monetaryReform.voucherShortfallByKey ||= {};

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
      for (const shortfallKey of Object.keys(state.monetaryReform?.voucherShortfallByKey || {})) {
        if (shortfallKey.startsWith(`town-wage:${key}:`)) delete state.monetaryReform.voucherShortfallByKey[shortfallKey];
      }
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
  state.socialSecurity ||= { enabled: false, balanceUnits: 0, dailyPerWorkerJin: 1, pensionPerElderJin: 2, totalInjectedUnits: 0, totalCollectedUnits: 0, totalPaidUnits: 0 };
  state.socialSecurity.enabled ??= false;
  state.socialSecurity.balanceUnits ??= 0;
  state.socialSecurity.dailyPerWorkerJin ??= 1;
  state.socialSecurity.pensionPerElderJin ??= 2;
  state.socialSecurity.totalInjectedUnits ??= 0;
  state.socialSecurity.totalCollectedUnits ??= 0;
  state.socialSecurity.totalPaidUnits ??= 0;
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
  if (stored < 10) throw new Error("旧版存档不兼容，请开始新游戏。");
  let state;
  if (stored === 10) state = normalizeV15(upgradeV10ToV11(raw, definitions), definitions, true);
  else if (stored === 11) state = normalizeV15(raw, definitions, true);
  else if ([12, 13, 14, 15].includes(stored)) state = normalizeV15(raw, definitions, false);
  else throw new Error("旧版存档不兼容，请开始新游戏。");
  const result = validateState(state, definitions);
  if (!result.valid) throw new Error("存档校验失败：" + result.errors.join("；"));
  return state;
}

function normalizeV7(raw, content) {
  const state = cloneJson(raw);
  state.accounts ||= { residents: {}, town: {} };
  for (const owner of ["residents", "town"]) {
    state.accounts[owner] ||= {};
    for (const itemId of Object.keys(content.items)) state.accounts[owner][itemId] ??= 0;
  }
  state.employment ||= { roles: {}, byBuilding: {}, privateByBuilding: {}, listedByBuilding: {}, wageRates: {} };
  state.employment.byBuilding ||= {};
  state.employment.privateByBuilding ||= {};
  state.employment.listedByBuilding ||= {};
  state.market ||= {};
  state.market.breadPriceWheatPerJin ??= content.rules.breadBasePriceWheatPerJin;
  state.market.breadPriceVoucherPerJin ??= state.market.breadPriceWheatPerJin;
  state.market.intermediatePricesVoucherPerUnit = { ...(content.rules.marketPricesVoucherPerUnit || {}), ...(state.market.intermediatePricesVoucherPerUnit || {}) };
  state.market.operatingRightPrices ||= {};
  state.market.sellerRotation ||= { bread: 0, salt: 0 };
  state.currency ||= { reserveWheatUnits: 0, reserveWheatCostVoucherUnits: 0, issuedUnits: 0, balances: { town: 0, residents: 0 }, issuedCumulativeUnits: 0, exchangedCumulativeUnits: 0, redeemedCumulativeUnits: 0, guidancePending: true, ledger: [] };
  state.currency.balances ||= { town: 0, residents: 0 };
  state.currency.balances.town ??= 0;
  state.currency.balances.residents ??= 0;
  state.currency.reserveWheatUnits ??= 0;
  state.currency.reserveWheatCostVoucherUnits ??= 0;
  state.currency.issuedUnits ??= 0;
  state.currency.issuedCumulativeUnits ??= state.currency.issuedUnits;
  state.currency.exchangedCumulativeUnits ??= 0;
  state.currency.redeemedCumulativeUnits ??= 0;
  if (!Array.isArray(state.currency.ledger)) state.currency.ledger = [];
  state.companies ||= {};
  state.nextCompanyNumber ||= Object.keys(state.companies).length + 1;
  state.payroll ||= { totals: {}, year: {} };
  state.payroll.arrearsVoucherUnits ||= { ...(state.payroll.arrearsWheatUnits || {}) };
  state.payroll.arrearsWheatUnits = state.payroll.arrearsVoucherUnits;
  for (const building of state.buildings || []) {
    building.ownership ||= { townLevels: building.level || 1, privateLevels: 0, listedLevels: 0 };
    building.ownership.townLevels ??= building.level || 1;
    building.ownership.privateLevels ??= 0;
    building.ownership.listedLevels ??= 0;
    state.employment.listedByBuilding[building.id] ||= {};
    for (const job of content.buildings[building.typeId]?.jobs || []) state.employment.listedByBuilding[building.id][job.id] ??= 0;
  }
  for (const company of Object.values(state.companies || {})) {
    company.inventory ||= Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
    company.inventoryCostVoucherUnits ||= Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
    for (const itemId of Object.keys(content.items)) { company.inventory[itemId] ??= 0; company.inventoryCostVoucherUnits[itemId] ??= 0; }
    company.cashVoucherUnits ??= 0;
    company.totalShares ??= company.listedLevels * (content.rules.sharesPerListedLevel || 1000);
    company.townShares ??= company.totalShares;
    company.residentShares ??= 0;
    company.dividendPercent ??= content.rules.defaultDividendPercent || 50;
    company.retainedEarningsVoucherUnits ??= 0;
    company.operatingDays ??= 0;
    company.lastDividendYear ??= 0;
    company.payroll ||= { arrearsVoucherUnits: 0, cumulativePaidVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0 };
    company.accounts ||= {};
    const blank = { revenueVoucherUnits: 0, cogsVoucherUnits: 0, wageExpenseVoucherUnits: 0, wagesPaidVoucherUnits: 0, inputPurchaseVoucherUnits: 0, taxCostVoucherUnits: 0, processingLossVoucherUnits: 0, profitVoucherUnits: 0, producedUnits: {}, soldUnits: {}, taxedUnits: {}, purchasedInputUnits: {} };
    for (const period of ["day", "year", "cumulative"]) company.accounts[period] = { ...blank, ...(company.accounts[period] || {}), producedUnits: { ...(company.accounts[period]?.producedUnits || {}) }, soldUnits: { ...(company.accounts[period]?.soldUnits || {}) }, taxedUnits: { ...(company.accounts[period]?.taxedUnits || {}) }, purchasedInputUnits: { ...(company.accounts[period]?.purchasedInputUnits || {}) } };
    company.shareSale ||= { offeredShares: 0, sharePriceVoucherUnits: 0, cumulativeProceedsVoucherUnits: 0, lastSaleVoucherUnits: 0, lastSoldShares: 0 };
    company.dividendHistory ||= [];
    company.initialInvestment ||= { cashVoucherUnits: 0, materials: [] };
  }
  state.version = 7;
  state.schemaVersion = 7;
  return state;
}


function legacyV7Price(state, itemId, content) {
  if (itemId === "bread") {
    const value = state.market?.breadPriceVoucherPerJin ?? state.market?.breadPriceWheatPerJin;
    return Number.isFinite(value) && value > 0 ? Number(value) : Number(content.rules.marketPricesVoucherPerUnit?.bread ?? 2);
  }
  if (itemId === "flour" || itemId === "wood") {
    const value = state.market?.pricesVoucherPerUnit?.[itemId] ?? state.market?.intermediatePricesVoucherPerUnit?.[itemId];
    const fallback = itemId === "flour" ? 1.5 : 8;
    return Number.isFinite(value) && value > 0 ? Number(value) : fallback;
  }
  const value = state.market?.pricesVoucherPerUnit?.[itemId];
  return Number.isFinite(value) && value > 0 ? Number(value) : Number(content.rules.marketPricesVoucherPerUnit?.[itemId] ?? 0);
}

function upgradeV7ToV8(raw, content) {
  const state = cloneJson(raw);
  state.market ||= {};
  const preserved = {
    wheat: legacyV7Price(state, "wheat", content) || 1,
    flour: legacyV7Price(state, "flour", content),
    bread: legacyV7Price(state, "bread", content),
    wood: legacyV7Price(state, "wood", content),
    salt: legacyV7Price(state, "salt", content) || 10
  };
  state.market.pricesVoucherPerUnit = preserved;
  state.market.breadPriceWheatPerJin = preserved.bread;
  state.market.breadPriceVoucherPerJin = preserved.bread;
  state.market.intermediatePricesVoucherPerUnit = { flour: preserved.flour, wood: preserved.wood };
  state.market.publicProcurementDemand ||= {};
  const recommendationItems = [];
  if (Math.abs(preserved.flour - 1.5) < 1e-9) recommendationItems.push({ itemId: "flour", current: preserved.flour, suggested: Number(content.rules.marketPricesVoucherPerUnit?.flour ?? 1.8) });
  if (Math.abs(preserved.wood - 8) < 1e-9) recommendationItems.push({ itemId: "wood", current: preserved.wood, suggested: Number(content.rules.marketPricesVoucherPerUnit?.wood ?? 15) });
  state.market.priceRecommendation = recommendationItems.length
    ? { pending: true, choice: null, items: recommendationItems }
    : { pending: false, choice: "custom_preserved", items: [] };
  state.legacyMigration = {
    ...(state.legacyMigration || {}),
    toVersion: 8,
    v8: "统一商品价格来源。旧存档面粉1.5、木材8若无法判断是否玩家自定义则原值保留，并提供一次新版建议价格选择；历史交易、库存成本、利润、粮券、股份和欠薪均不改写。"
  };
  state.version = 8;
  state.schemaVersion = 8;
  return state;
}

function normalizeV8(raw, content) {
  const state = cloneJson(raw);
  if (state.schemaVersion !== 8 && state.version !== 8) throw new Error("不支持此存档版本：" + (state.schemaVersion || state.version));
  state.accounts ||= { residents: {}, town: {} };
  for (const owner of ["residents", "town"]) {
    state.accounts[owner] ||= {};
    for (const itemId of Object.keys(content.items)) state.accounts[owner][itemId] ??= 0;
  }
  state.employment ||= { roles: {}, byBuilding: {}, privateByBuilding: {}, listedByBuilding: {}, wageRates: {} };
  state.employment.byBuilding ||= {};
  state.employment.privateByBuilding ||= {};
  state.employment.listedByBuilding ||= {};
  state.market ||= {};
  const defaults = content.rules.marketPricesVoucherPerUnit || {};
  const existing = state.market.pricesVoucherPerUnit || {};
  const flour = Number.isFinite(existing.flour) && existing.flour > 0 ? Number(existing.flour)
    : (Number.isFinite(state.market.intermediatePricesVoucherPerUnit?.flour) ? Number(state.market.intermediatePricesVoucherPerUnit.flour) : Number(defaults.flour ?? 1.8));
  const wood = Number.isFinite(existing.wood) && existing.wood > 0 ? Number(existing.wood)
    : (Number.isFinite(state.market.intermediatePricesVoucherPerUnit?.wood) ? Number(state.market.intermediatePricesVoucherPerUnit.wood) : Number(defaults.wood ?? 15));
  const breadLegacy = state.market.breadPriceVoucherPerJin ?? state.market.breadPriceWheatPerJin;
  const bread = Number.isFinite(existing.bread) && existing.bread > 0 ? Number(existing.bread)
    : (Number.isFinite(breadLegacy) && breadLegacy > 0 ? Number(breadLegacy) : Number(defaults.bread ?? 2));
  state.market.pricesVoucherPerUnit = {
    wheat: Number.isFinite(existing.wheat) && existing.wheat > 0 ? Number(existing.wheat) : Number(defaults.wheat ?? 1),
    flour,
    bread,
    wood,
    salt: Number.isFinite(existing.salt) && existing.salt > 0 ? Number(existing.salt) : Number(defaults.salt ?? 10)
  };
  state.market.breadPriceWheatPerJin = bread;
  state.market.breadPriceVoucherPerJin = bread;
  state.market.intermediatePricesVoucherPerUnit = { flour, wood };
  state.market.operatingRightPrices ||= {};
  state.market.sellerRotation ||= { bread: 0, salt: 0 };
  state.market.publicProcurementDemand ||= {};
  state.market.priceRecommendation ||= { pending: false, choice: "existing_v8", items: [] };
  if (!Array.isArray(state.market.priceRecommendation.items)) state.market.priceRecommendation.items = [];
  state.currency ||= { reserveWheatUnits: 0, reserveWheatCostVoucherUnits: 0, issuedUnits: 0, balances: { town: 0, residents: 0 }, issuedCumulativeUnits: 0, exchangedCumulativeUnits: 0, redeemedCumulativeUnits: 0, guidancePending: true, ledger: [] };
  state.currency.balances ||= { town: 0, residents: 0 };
  state.currency.balances.town ??= 0;
  state.currency.balances.residents ??= 0;
  state.currency.reserveWheatUnits ??= 0;
  state.currency.reserveWheatCostVoucherUnits ??= 0;
  state.currency.issuedUnits ??= 0;
  state.currency.issuedCumulativeUnits ??= state.currency.issuedUnits;
  state.currency.exchangedCumulativeUnits ??= 0;
  state.currency.redeemedCumulativeUnits ??= 0;
  if (!Array.isArray(state.currency.ledger)) state.currency.ledger = [];
  state.companies ||= {};
  state.nextCompanyNumber ||= Object.keys(state.companies).length + 1;
  state.payroll ||= { totals: {}, year: {} };
  state.payroll.arrearsVoucherUnits ||= { ...(state.payroll.arrearsWheatUnits || {}) };
  state.payroll.arrearsWheatUnits = state.payroll.arrearsVoucherUnits;
  for (const building of state.buildings || []) {
    building.ownership ||= { townLevels: building.level || 1, privateLevels: 0, listedLevels: 0 };
    building.ownership.townLevels ??= building.level || 1;
    building.ownership.privateLevels ??= 0;
    building.ownership.listedLevels ??= 0;
    state.employment.listedByBuilding[building.id] ||= {};
    for (const job of content.buildings[building.typeId]?.jobs || []) state.employment.listedByBuilding[building.id][job.id] ??= 0;
  }
  for (const company of Object.values(state.companies || {})) {
    company.inventory ||= Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
    company.inventoryCostVoucherUnits ||= Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
    for (const itemId of Object.keys(content.items)) { company.inventory[itemId] ??= 0; company.inventoryCostVoucherUnits[itemId] ??= 0; }
    company.cashVoucherUnits ??= 0;
    company.totalShares ??= company.listedLevels * (content.rules.sharesPerListedLevel || 1000);
    company.townShares ??= company.totalShares;
    company.residentShares ??= 0;
    company.dividendPercent ??= content.rules.defaultDividendPercent || 50;
    company.retainedEarningsVoucherUnits ??= 0;
    company.operatingDays ??= 0;
    company.lastDividendYear ??= 0;
    company.payroll ||= { arrearsVoucherUnits: 0, cumulativePaidVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0 };
    company.accounts ||= {};
    const blank = { revenueVoucherUnits: 0, cogsVoucherUnits: 0, wageExpenseVoucherUnits: 0, wagesPaidVoucherUnits: 0, inputPurchaseVoucherUnits: 0, taxCostVoucherUnits: 0, processingLossVoucherUnits: 0, profitVoucherUnits: 0, producedUnits: {}, soldUnits: {}, taxedUnits: {}, purchasedInputUnits: {} };
    for (const period of ["day", "year", "cumulative"]) company.accounts[period] = { ...blank, ...(company.accounts[period] || {}), producedUnits: { ...(company.accounts[period]?.producedUnits || {}) }, soldUnits: { ...(company.accounts[period]?.soldUnits || {}) }, taxedUnits: { ...(company.accounts[period]?.taxedUnits || {}) }, purchasedInputUnits: { ...(company.accounts[period]?.purchasedInputUnits || {}) } };
    company.shareSale ||= { offeredShares: 0, sharePriceVoucherUnits: 0, cumulativeProceedsVoucherUnits: 0, lastSaleVoucherUnits: 0, lastSoldShares: 0 };
    company.dividendHistory ||= [];
    company.initialInvestment ||= { cashVoucherUnits: 0, materials: [] };
  }
  state.version = 8;
  state.schemaVersion = 8;
  return state;
}


function upgradeV6ToV7(raw, content) {
  const state = cloneJson(raw);
  state.currency = {
    reserveWheatUnits: 0, reserveWheatCostVoucherUnits: 0, issuedUnits: 0, balances: { town: 0, residents: 0 },
    issuedCumulativeUnits: 0, exchangedCumulativeUnits: 0, redeemedCumulativeUnits: 0, guidancePending: true, ledger: []
  };
  state.companies = {};
  state.nextCompanyNumber = 1;
  state.employment ||= {};
  state.employment.listedByBuilding = {};
  state.market ||= {};
  state.market.breadPriceVoucherPerJin = state.market.breadPriceWheatPerJin ?? content.rules.breadBasePriceWheatPerJin;
  state.market.intermediatePricesVoucherPerUnit = { flour: 1.5, wood: 8 };
  state.market.sellerRotation = { bread: 0, salt: 0 };
  state.payroll ||= { totals: {}, year: {} };
  state.payroll.arrearsVoucherUnits = { ...(state.payroll.arrearsWheatUnits || {}) };
  state.payroll.arrearsWheatUnits = state.payroll.arrearsVoucherUnits;
  for (const building of state.buildings || []) {
    building.ownership ||= { townLevels: building.level || 1, privateLevels: 0 };
    building.ownership.listedLevels = 0;
    state.employment.listedByBuilding[building.id] = {};
    for (const job of content.buildings[building.typeId]?.jobs || []) state.employment.listedByBuilding[building.id][job.id] = 0;
  }
  state.legacyMigration = {
    ...(state.legacyMigration || {}),
    toVersion: 7,
    v7: "粮券与兑付储备从0开始，不把既有粮食改名或赠送货币；旧欠薪按1:1迁移为粮券债务。旧建筑上市等级为0，原镇营/民营归属和库存保持不变。"
  };
  state.version = 7;
  state.schemaVersion = 7;
  return state;
}

function upgradeV5ToV6(raw, content, fromVersion = 5) {
  const state = cloneJson(raw);
  for (const owner of ["residents", "town"]) {
    state.accounts[owner] ||= {};
    for (const itemId of Object.keys(content.items)) if (state.accounts[owner][itemId] === undefined) state.accounts[owner][itemId] = 0;
  }
  const totalDays = Math.max(0, Math.min(content.rules.growingDays,
    Number.isInteger(state.day) ? state.day : 0));
  state.employment ||= { roles: {}, byBuilding: {}, wageRates: {} };
  state.employment.privateByBuilding ||= {};
  state.agriculture ||= { workUnits: 0, lastHarvestYear: 0 };
  state.agriculture.taxDays ||= Array.from({ length: totalDays }, (_, index) => ({
    year: state.year || 1, day: index + 1, rateBps: 5000
  }));
  state.agriculture.taxHistory ||= [];
  state.policy ||= {};
  state.policy.unemploymentBenefit ||= { enabled: false, dailyPerWorkerJin: content.rules.unemploymentDailyJin };
  state.policy.villa ||= { priceWheatJin: 10000, taxRatePercent: 0.5 };
  state.policy.villa.priceWheatJin ??= 10000;
  state.policy.villa.taxRatePercent ??= 0.5;
  state.policy.wageControl ||= { civil: 1.0, industry: 1.0 };
  state.policy.wageControl.civil ??= 1.0;
  state.policy.wageControl.industry ??= 1.0;
  state.socialSecurity ||= { enabled: false, balanceUnits: 0, dailyPerWorkerJin: 1, pensionPerElderJin: 2, totalInjectedUnits: 0, totalCollectedUnits: 0, totalPaidUnits: 0 };
  state.socialSecurity.enabled ??= false;
  state.socialSecurity.balanceUnits ??= 0;
  state.socialSecurity.dailyPerWorkerJin ??= 1;
  state.socialSecurity.pensionPerElderJin ??= 2;
  state.socialSecurity.totalInjectedUnits ??= 0;
  state.socialSecurity.totalCollectedUnits ??= 0;
  state.socialSecurity.totalPaidUnits ??= 0;
  state.villas ||= { sold: [], taxArrearsValueUnits: {}, stats: {} };
  if (!Array.isArray(state.villas.sold)) state.villas.sold = [];
  state.villas.taxArrearsValueUnits ||= {};
  state.villas.stats ||= {};
  state.villas.stats.soldTotal ||= 0;
  state.villas.stats.revenueValueUnits ||= 0;
  state.villas.stats.taxCollectedValueUnits ||= 0;
  state.policy.tradeTariffRate ??= 5;
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
  state.policy.agricultureTaxPercent ??= content.rules.agricultureTaxDefaultPercent ?? 50;
  state.policy.agricultureTaxRecent ||= Array.from({ length: content.rules.agricultureTaxLookbackDays || 30 }, (_, index) => ({
    year: 0, day: index, rateBps: 5000, baseline: true
  }));
  state.policy.privateProductionTaxPercent ||= {};
  for (const typeId of ["mill", "bakery", "lumberyard", "saltworks"]) {
    state.policy.privateProductionTaxPercent[typeId] ??= content.rules.privateProductionTaxDefaultPercent ?? 10;
  }
  state.market ||= { breadPriceWheatPerJin: content.rules.breadBasePriceWheatPerJin };
  state.market.operatingRightPrices ||= {};
  for (const building of state.buildings || []) {
    building.level = Math.max(1, Number(building.level) || 1);
    building.ownership ||= { townLevels: building.level, privateLevels: 0 };
    building.ownership.townLevels ??= building.level;
    building.ownership.privateLevels ??= 0;
    state.employment.privateByBuilding[building.id] ||= {};
    for (const job of content.buildings[building.typeId]?.jobs || []) {
      state.employment.privateByBuilding[building.id][job.id] ??= 0;
    }
  }
  state.privateEconomy ||= {
    taxRemainders: {},
    day: { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 },
    year: { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 },
    cumulative: { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 },
    rightSales: { dayWheatUnits: 0, yearWheatUnits: 0, cumulativeWheatUnits: 0 }
  };
  state.financialFlows ||= { day: emptyFinancialFlowPeriod(), year: emptyFinancialFlowPeriod(), cumulative: emptyFinancialFlowPeriod() };
  state.version = 6;
  state.schemaVersion = 6;
  state.legacyMigration = {
    ...(state.legacyMigration || {}),
    fromVersion: state.legacyMigration?.fromVersion || fromVersion,
    toVersion: 6,
    v6: "旧建筑均保持镇营；本季已过农事日按50%税率补齐；已完成收获不重算。民营账户、生产税余数与经营权收入从零初始化。"
  };
  return state;
}

function upgradeV4ToV5(raw, content) {
  const state = cloneJson(raw);
  for (const owner of ["residents", "town"]) {
    state.accounts[owner] ||= {};
    for (const itemId of Object.keys(content.items)) {
      if (state.accounts[owner][itemId] === undefined) state.accounts[owner][itemId] = 0;
    }
  }
  for (const building of state.buildings || []) {
    building.level = Math.max(1, Math.min(content.rules.buildingMaxLevel || 5, Number(building.level) || 1));
    if (!Array.isArray(building.materialInvestments)) building.materialInvestments = [];
  }
  if (state.project) {
    state.project.kind ||= "build";
    if (!Array.isArray(state.project.materialsConsumed)) state.project.materialsConsumed = [];
    if (state.project.kind === "upgrade") {
      state.project.targetLevel ||= (state.buildings.find(row => row.id === state.project.buildingId)?.level || 1) + 1;
    }
  }
  state.demolishedBuildings ||= [];
  state.legacyMigration = {
    ...(state.legacyMigration || {}),
    fromVersion: state.legacyMigration?.fromVersion || 4,
    toVersion: 5,
    buildingLevels: "旧建筑按1级恢复；旧存档缺少可靠的材料投入明细，因此不推算历史材料返还量。存档中尚在施工的工程保留已有实际材料扣除记录。"
  };
  state.version = 5;
  state.schemaVersion = 5;
  return state;
}

function mergePlotCatalog(existing, content) {
  const plots = Array.isArray(existing) ? cloneJson(existing) : [];
  const used = new Set(plots.map(plot => plot.id));
  for (const plot of content.plots) {
    if (!used.has(plot.id)) {
      plots.push({ ...plot });
      used.add(plot.id);
    }
  }
  return plots;
}

function createBusinessBaseline(state, content) {
  const business = emptyBusinessState(content);
  business.inventoryCostWheatUnits.town = {};
  for (const [itemId, item] of Object.entries(content.items)) {
    const balance = state.accounts.town[itemId] || 0;
    const rate = Number.isFinite(item.openingCostWheatPerJin)
      ? item.openingCostWheatPerJin : (itemId === "wheat" ? 1 : 0);
    business.inventoryCostWheatUnits.town[itemId] = Math.round(balance * rate);
    business.openingValuationWheatPerJin[itemId] = rate;
  }
  return business;
}

function normalizeV3(raw, content) {
  const state = cloneJson(raw);
  if (state.schemaVersion !== 3 || state.version !== 3) {
    throw new Error("不支持此存档版本：" + (state.schemaVersion || state.version));
  }
  for (const owner of ["residents", "town"]) {
    if (!state.accounts?.[owner]) throw new Error("v3 存档缺少账户：" + owner);
    for (const itemId of Object.keys(content.items)) {
      if (state.accounts[owner][itemId] === undefined) state.accounts[owner][itemId] = 0;
    }
  }
  state.plots = mergePlotCatalog(state.plots, content);
  state.employment = state.employment || { roles: {}, byBuilding: {} };
  state.employment.roles = state.employment.roles || {};
  state.employment.byBuilding = state.employment.byBuilding || {};
  state.employment.wageRates = {
    ...defaultWageRates(content),
    ...(state.employment.wageRates || {})
  };
  state.yearTotals = { ...emptyYearTotals(), ...(state.yearTotals || {}) };
  state.annualReports = Array.isArray(state.annualReports) ? state.annualReports : [];
  state.ledger = (Array.isArray(state.ledger) ? state.ledger : []).map(row => ({
    ...row,
    day: Math.max(1, Math.min(content.rules.daysPerYear, Number(row?.day) || 1))
  }));
  state.events = (Array.isArray(state.events) ? state.events : []).map(event => ({
    ...event,
    day: Math.max(1, Math.min(content.rules.daysPerYear, Number(event?.day) || 1))
  }));
  state.ledgerSequence = Number.isInteger(state.ledgerSequence) ? state.ledgerSequence : state.ledger.length;
  state.transactionSequence = Number.isInteger(state.transactionSequence) ? state.transactionSequence : 0;
  state.policy = state.policy || {
    unemploymentBenefit: { enabled: false, dailyPerWorkerJin: content.rules.unemploymentDailyJin }
  };
  state.policy.unemploymentBenefit = {
    enabled: state.policy.unemploymentBenefit?.enabled === true,
    dailyPerWorkerJin: state.policy.unemploymentBenefit?.dailyPerWorkerJin ?? content.rules.unemploymentDailyJin
  };
  state.market = state.market || { breadPriceWheatPerJin: content.rules.breadBasePriceWheatPerJin };
  state.payroll = state.payroll || { arrearsWheatUnits: {}, totals: {} };
  state.payroll.arrearsWheatUnits = state.payroll.arrearsWheatUnits || {};
  state.payroll.totals = {
    paidWheatUnits: 0, currentPaidWheatUnits: 0, arrearsPaidWheatUnits: 0,
    unpaidWheatUnits: 0, unemploymentPaidWheatUnits: 0, accruedWheatUnits: 0,
    unpaidBalanceWheatUnits: 0, ...(state.payroll.totals || {})
  };
  state.payroll.year = {
    paidWheatUnits: 0, currentPaidWheatUnits: 0, arrearsPaidWheatUnits: 0,
    unpaidWheatUnits: 0, unemploymentPaidWheatUnits: 0, accruedWheatUnits: 0,
    ...(state.payroll.year || {})
  };
  state.business = state.business || createBusinessBaseline(state, content);
  state.business.inventoryCostWheatUnits = state.business.inventoryCostWheatUnits || { town: {} };
  state.business.inventoryCostWheatUnits.town = state.business.inventoryCostWheatUnits.town || {};
  state.business.openingValuationWheatPerJin = state.business.openingValuationWheatPerJin || {};
  for (const [itemId, item] of Object.entries(content.items)) {
    if (state.business.inventoryCostWheatUnits.town[itemId] === undefined) {
      const rate = Number.isFinite(item.openingCostWheatPerJin) ? item.openingCostWheatPerJin : 0;
      state.business.inventoryCostWheatUnits.town[itemId] =
        Math.round((state.accounts.town[itemId] || 0) * rate);
    }
    if (state.business.openingValuationWheatPerJin[itemId] === undefined) {
      state.business.openingValuationWheatPerJin[itemId] = item.openingCostWheatPerJin ?? 0;
    }
  }
  state.business.buildings = state.business.buildings || {};
  if (state.project && !Number.isSafeInteger(state.project.prepaidWageCreditUnits)) {
    state.project.prepaidWageCreditUnits = 0;
  }
  for (const building of state.buildings || []) {
    state.business.buildings[building.id] = state.business.buildings[building.id] || {
      todayOutputUnits: {}, yearOutputUnits: {}, lifetimeOutputUnits: {}
    };
  }
  const emptyActivity = {
    producedUnits: {}, soldBreadUnits: 0, revenueWheatUnits: 0, breadCogsWheatUnits: 0, rawInputCostWheatUnits: 0,
    operatingWagesWheatUnits: 0, constructionWagesWheatUnits: 0, processingLossWheatUnits: 0
  };
  state.business.day = { ...emptyActivity, ...(state.business.day || {}) };
  state.business.year = { ...emptyActivity, ...(state.business.year || {}) };
  state.business.cumulative = { ...emptyActivity, ...(state.business.cumulative || {}) };
  state.rng = state.rng || (Number.isInteger(state.seed)
    ? { algorithm: "lcg32-v1", state: state.seed >>> 0 } : null);
  state.version = 3;
  state.schemaVersion = 3;
  return state;
}

function upgradeV3ToV4(raw, content) {
  const compatibleV3 = { ...cloneJson(raw), version: 3, schemaVersion: 3 };
  const state = normalizeV3(compatibleV3, content);
  const defaultIndustries = emptyIndustryState();
  state.industries = state.industries || {};
  for (const [sector, defaults] of Object.entries(defaultIndustries)) {
    const prior = state.industries[sector] || {};
    state.industries[sector] = {};
    for (const period of ["day", "year", "cumulative"]) {
      state.industries[sector][period] = {
        ...defaults[period], ...(prior[period] || {}),
        producedUnits: { ...defaults[period].producedUnits, ...(prior[period]?.producedUnits || {}) }
      };
    }
  }
  const defaultFiscal = emptyFiscalState();
  state.fiscal = state.fiscal || {};
  for (const period of ["day", "year", "cumulative"]) {
    state.fiscal[period] = { ...defaultFiscal[period], ...(state.fiscal[period] || {}) };
  }
  state.housing = { villageCapacity: content.rules.housingCapacity, ...(state.housing || {}) };
  const saltDefaults = {
    demandCarry: 0, graceDaysElapsed: 0, todayDemandUnits: 0, todaySatisfiedUnits: 0,
    history: [],
    day: { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 },
    year: { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 },
    lifetime: { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 }
  };
  state.salt = { ...saltDefaults, ...(state.salt || {}) };
  for (const period of ["day", "year", "lifetime"]) {
    state.salt[period] = { ...saltDefaults[period], ...(state.salt[period] || {}) };
  }
  state.salt.history = Array.isArray(state.salt.history) ? state.salt.history : [];
  for (const building of state.buildings || []) {
    state.business.buildings[building.id] = state.business.buildings[building.id] || {
      todayOutputUnits: {}, yearOutputUnits: {}, lifetimeOutputUnits: {}
    };
  }
  if (state.project && !Array.isArray(state.project.materialsConsumed)) state.project.materialsConsumed = [];
  state.legacyMigration = {
    ...(state.legacyMigration || {}),
    fromVersion: state.legacyMigration?.fromVersion || 3,
    toVersion: 4,
    housingAllocation: "村舍优先；其后按建筑落成顺序分配公租房，入住数由人口与容量派生。",
    saltOpeningState: "新增木材、食盐初始库存为零；盐需求余量和三十日满意度引导期从零开始。"
  };
  state.version = 4;
  state.schemaVersion = 4;
  return state;
}

function upgradeV2ToV3(raw, content) {
  const state = cloneJson(raw);
  state.plots = mergePlotCatalog(state.plots, content);
  state.employment.wageRates = defaultWageRates(content);
  state.policy = {
    unemploymentBenefit: { enabled: false, dailyPerWorkerJin: content.rules.unemploymentDailyJin }
  };
  state.market = { breadPriceWheatPerJin: content.rules.breadBasePriceWheatPerJin };
  state.payroll = {
    arrearsWheatUnits: {},
    totals: {
      paidWheatUnits: 0, currentPaidWheatUnits: 0, arrearsPaidWheatUnits: 0,
      unpaidWheatUnits: 0, unemploymentPaidWheatUnits: 0, accruedWheatUnits: 0,
      unpaidBalanceWheatUnits: 0
    },
    year: {
      paidWheatUnits: 0, currentPaidWheatUnits: 0, arrearsPaidWheatUnits: 0,
      unpaidWheatUnits: 0, unemploymentPaidWheatUnits: 0, accruedWheatUnits: 0
    },
    lastDay: null
  };
  const qeqToWheatUnits = qeq => Math.round(qeq * content.precision.inventoryUnitsPerJin /
    content.precision.qeqUnitsPerJin);
  const priorLedger = state.ledger || [];
  let oldConstructionUnits = 0;
  let thisYearConstructionUnits = 0;
  for (const row of priorLedger) {
    if (row.type === "construction") {
      const qeq = row.qeqUnits || 0;
      const units = qeqToWheatUnits(qeq);
      oldConstructionUnits += units;
      if (row.year === state.year) thisYearConstructionUnits += units;
    }
  }
  state.business = createBusinessBaseline(state, content);
  state.business.cumulative.constructionWagesWheatUnits = oldConstructionUnits;
  state.business.year.constructionWagesWheatUnits = thisYearConstructionUnits;

  if (state.project) {
    const legacyPaidQeqUnits = Math.max(0, Number(state.project.costQeqUnits) || 0);
    const remaining = Math.max(0, state.project.workRequired - state.project.workDone);
    const remainingQeq = state.project.workRequired > 0
      ? Math.floor(legacyPaidQeqUnits * remaining / state.project.workRequired) : 0;
    state.project.legacyPrepaidQeqUnits = legacyPaidQeqUnits;
    state.project.prepaidWageCreditUnits = qeqToWheatUnits(remainingQeq);
    state.project.prepaidWageCreditMigration = {
      originalQeqUnits: legacyPaidQeqUnits,
      remainingWork: remaining,
      totalWork: state.project.workRequired,
      creditWheatUnits: state.project.prepaidWageCreditUnits
    };
  }
  state.legacyMigration = {
    ...(state.legacyMigration || {}),
    fromVersion: state.legacyMigration?.fromVersion || raw.version,
    toVersion: 3,
    breadStockValuation: "按新版公开期初成本估值；不生成旧日利润。",
    projectPrepayment: state.project?.prepaidWageCreditMigration || null
  };
  state.version = 3;
  state.schemaVersion = 3;
  return normalizeV3(state, content);
}
