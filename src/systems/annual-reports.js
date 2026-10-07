import { computeWealthStats } from "./wealth-stats.js";

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
    salt: annualPeriod(state.salt),
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

export function summarizeLegacyAnnualReports(state) {
  const reports = Array.isArray(state.annualReports) ? state.annualReports : [];
  const distributions = companyDistributionIndex(state, reports);
  return reports.map(report => {
    if (!report || typeof report !== "object") return report;
    const companies = {};
    for (const [companyId, company] of Object.entries(report.companies || {})) {
      const distribution = distributions.get(`${report.year}:${companyId}`) || company.distribution || null;
      companies[companyId] = companyAnnualSummary({ id: companyId, ...company }, distribution);
    }
    const shops = {};
    for (const [shopId, shop] of Object.entries(report.shops || {})) shops[shopId] = shopAnnualSummary({ id: shopId, ...shop });
    const industries = {};
    for (const [sector, value] of Object.entries(report.industries || {})) industries[sector] = annualPeriod(value);
    const privateEconomy = report.privateEconomy?.year
      ? { year: cloneValue(report.privateEconomy.year), rightSalesYearWheatUnits: report.privateEconomy.rightSales?.yearWheatUnits || 0 }
      : { year: cloneValue(report.privateEconomy?.year || report.privateEconomy || {}), rightSalesYearWheatUnits: report.privateEconomy?.rightSalesYearWheatUnits || 0 };
    const totals = Object.fromEntries(YEAR_TOTAL_FIELDS.map(key => [key, report[key] || 0]));
    return {
      summaryVersion: 1,
      year: report.year,
      ...totals,
      business: annualPeriod(report.business),
      payroll: annualPeriod(report.payroll),
      industries,
      privateEconomy,
      agricultureTax: cloneValue(report.agricultureTax || []),
      financialFlows: annualPeriod(report.financialFlows),
      fiscal: annualPeriod(report.fiscal),
      salt: annualPeriod(report.salt),
      companies,
      shops,
      householdLife: cloneValue(report.householdLife || null),
      populationAtClose: report.populationAtClose,
      populationAfterAging: report.populationAfterAging,
      births: report.births || 0,
      deaths: report.deaths || 0,
      marriages: report.marriages || 0,
      laborChange: cloneValue(report.laborChange || null),
      closingQeq: report.closingQeq || 0
    };
  });
}
