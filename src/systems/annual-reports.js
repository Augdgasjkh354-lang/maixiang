import { computeWealthStats } from "./wealth-stats.js";
import { wholesalePrice } from "./wholesale-price.js";

const YEAR_TOTAL_FIELDS = ["harvestQeq", "consumptionQeq", "operatingWagesQeq", "constructionPayQeq", "reliefQeq", "processingLossQeq", "unemploymentPaidQeq", "wagePaidQeq", "wageArrearsQeq"];

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function annualPeriod(value) {
  if (!value || typeof value !== "object") return {};
  return cloneValue(value.year && typeof value.year === "object" ? value.year : value) || {};
}

function compactCompanyDistribution(row) {
  if (!row || typeof row !== "object") return null;
  return {
    totalVoucherUnits: row.totalVoucherUnits || row.distributedVoucherUnits || 0,
    townVoucherUnits: row.townVoucherUnits || 0,
    residentVoucherUnits: row.residentVoucherUnits || 0,
    retainedBeforeVoucherUnits: row.retainedBeforeVoucherUnits || 0,
    lastYearNetProfitVoucherUnits: row.lastYearNetProfitVoucherUnits || 0,
    workingCapitalReserveVoucherUnits: row.workingCapitalReserveVoucherUnits || row.workingCapitalTargetVoucherUnits || 0,
    debtPaidVoucherUnits: row.debtPaidVoucherUnits || 0
  };
}

function companyAnnualSummary(company, distribution = null) {
  return {
    id: company.id,
    name: company.name,
    typeId: company.typeId,
    buildingId: company.buildingId,
    listedLevels: company.listedLevels || 0,
    listed: Boolean(company.listing?.listed),
    ticker: company.listing?.ticker || null,
    accounts: annualPeriod(company.accounts),
    distribution: compactCompanyDistribution(distribution)
  };
}

function shopAnnualSummary(shop) {
  const accounts = annualPeriod(shop.accounts);
  const distributionKnown = Object.prototype.hasOwnProperty.call(accounts, "distributedVoucherUnits");
  return {
    id: shop.id,
    name: shop.name,
    typeId: shop.typeId,
    buildingId: shop.buildingId,
    ownerHouseholdId: shop.ownerHouseholdId,
    status: shop.status,
    accounts,
    distributedVoucherUnits: distributionKnown ? (accounts.distributedVoucherUnits || 0) : null
  };
}

function companyDistributionIndex(state, reports = []) {
  const rows = new Map();
  const add = (companyId, row) => {
    const year = Number(row?.year);
    if (!companyId || !Number.isInteger(year) || year < 1) return;
    rows.set(`${year}:${companyId}`, compactCompanyDistribution(row));
  };
  for (const company of Object.values(state?.companies || {})) {
    for (const row of company.dividendHistory || []) add(company.id, row);
  }
  for (const report of reports || []) {
    for (const [companyId, company] of Object.entries(report?.companies || {})) {
      for (const row of company?.dividendHistory || []) add(companyId, row);
      if (company?.distribution && Number.isInteger(report?.year)) rows.set(`${report.year}:${companyId}`, compactCompanyDistribution(company.distribution));
    }
  }
  return rows;
}

// 镇营产出的增加值（券）：产量 ×（市价 − 配方原料按市价折的成本），再与镇营工资对照（镇报 GDP 用）。
// 产量来自 business 与各行业账本的全年 producedUnits（只含镇营建筑；公司与民营另有账本）。
function townProductionSummary(state, content) {
  const perJin = content.precision.inventoryUnitsPerJin;
  const price = itemId => wholesalePrice(state, itemId, content) || Number(content.items[itemId]?.openingCostWheatPerJin) || 0;
  const inputCostPerJin = itemId => {
    for (const recipe of Object.values(content.recipes || {})) {
      const flexInputs = recipe.flex?.itemIds?.includes(itemId) ? recipe.flex.inputsPerJin?.[itemId] : null;
      if (flexInputs) return Object.entries(flexInputs).reduce((sum, [id, q]) => sum + q * price(id), 0);
      const out = (recipe.outputs || []).find(row => row.itemId === itemId);
      if (out && out.quantity > 0) return (recipe.inputs || []).reduce((sum, row) => sum + row.quantity * price(row.itemId), 0) / out.quantity;
    }
    return 0;
  };
  const produced = {};
  const addProduced = map => { for (const [itemId, units] of Object.entries(map || {})) produced[itemId] = (produced[itemId] || 0) + units; };
  addProduced(state.business?.year?.producedUnits);
  let wageUnits = state.business?.year?.operatingWagesWheatUnits || 0;
  for (const industry of Object.values(state.industries || {})) {
    addProduced(industry.year?.producedUnits);
    wageUnits += industry.year?.operatingWagesWheatUnits || 0;
  }
  let valueAdded = 0;
  for (const [itemId, units] of Object.entries(produced)) {
    valueAdded += (units / perJin) * Math.max(0, price(itemId) - inputCostPerJin(itemId));
  }
  return { valueAddedVoucher: valueAdded, wagesVoucher: wageUnits / perJin };
}

export function buildAnnualReport(state, content, { householdLifeYear, peopleBefore, peopleAfter, demography, closingQeq }) {
  const companies = {};
  for (const company of Object.values(state.companies || {})) companies[company.id] = companyAnnualSummary(company);
  const shops = {};
  for (const shop of Object.values(state.shops || {})) shops[shop.id] = shopAnnualSummary(shop);
  const industries = {};
  for (const [sector, value] of Object.entries(state.industries || {})) industries[sector] = annualPeriod(value);
  return {
    summaryVersion: 1,
    year: state.year,
    ...cloneValue(state.yearTotals),
    business: annualPeriod(state.business),
    payroll: annualPeriod(state.payroll),
    industries,
    privateEconomy: {
      year: cloneValue(state.privateEconomy?.year || {}),
      rightSalesYearWheatUnits: state.privateEconomy?.rightSales?.yearWheatUnits || 0
    },
    agricultureTax: cloneValue((state.agriculture?.taxHistory || []).filter(row => row.year === state.year)),
    financialFlows: annualPeriod(state.financialFlows),
    fiscal: annualPeriod(state.fiscal),
    stampDuty: annualPeriod(state.stampDuty),
    salt: annualPeriod(state.salt),
    townProduction: townProductionSummary(state, content),
    companies,
    shops,
    householdLife: cloneValue(householdLifeYear),
    populationAtClose: peopleBefore.total,
    populationAfterAging: peopleAfter.total,
    births: demography.births,
    deaths: demography.deaths,
    marriages: demography.marriages,
    laborChange: cloneValue(demography.laborChange),
    wealth: computeWealthStats(state, content),
    closingQeq
  };
}

export function applyCompanyDistributionsToAnnualReport(state, endingYear, distributionRows) {
  const report = (state.annualReports || []).find(row => row.year === endingYear);
  if (!report || report.summaryVersion !== 1) return;
  report.companies ||= {};
  for (const row of distributionRows || []) {
    const company = state.companies?.[row.companyId];
    if (!report.companies[row.companyId] && company) report.companies[row.companyId] = companyAnnualSummary(company);
    if (report.companies[row.companyId]) report.companies[row.companyId].distribution = compactCompanyDistribution(row);
  }
}

