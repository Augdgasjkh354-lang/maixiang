import { populationStats, readJobCount, listedJobKeyForBuilding, selectJobRows } from "../selectors/labor.js";
import { laborBatches, nextCarry } from "../economy/productivity.js";
import { isIndustryType } from "../content/buildings.js";
import { householdIdOf } from "../economy/accounts.js";
import { putStock, sellCompanyGoods, takeStock } from "../economy/trade.js";
import { PERIODS, bookAdd, bookAddMap, ensureBook } from "../economy/books.js";
import { recordFundDividend } from "./social-security.js";
import { currencyScale, voucherBalance } from "../economy/currency.js";
import { createPaymentViewState } from "../economy/payment-view-state.js";
import { currentPaymentComposition, maximumFullyPayableValueUnits, maximumPayableValueUnits, paymentWheatBalanceUnits, quoteMonetaryPayment, settleMonetaryPayment } from "../economy/payment.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { addTownCostBasis, removeTownInventoryWithCost } from "../economy/business.js";
import { currentUnitPrice, setCurrentUnitPrice } from "../economy/prices.js";
import { householdConvertibleWheatUnits, householdList, householdPopulation, isActiveHousehold, jobAssignments, setJobCount, syncResidentAggregates } from "./households.js";
import { plannedBatchesForProducer, plannedWorkersForProducer, recentAverage } from "../economy/operating-plan.js";

import { accrueWages, hireToward, payWages, productionTaxUnits, wageArrears, wageBook } from "./employer.js";
import { buyWholesaleForOwner, depositProductionTaxToWholesale, depositWholesalePurchasedInventory, hasWholesaleMarket, wholesaleUnitPrice } from "./wholesale-market.js";

function blankPeriod() {
  return {
    revenueVoucherUnits: 0,
    cogsVoucherUnits: 0,
    wageExpenseVoucherUnits: 0,
    wagesPaidVoucherUnits: 0,
    inputPurchaseVoucherUnits: 0,
    taxCostVoucherUnits: 0,
    processingLossVoucherUnits: 0,
    profitVoucherUnits: 0,
    producedUnits: {},
    soldUnits: {},
    taxedUnits: {},
    purchasedInputUnits: {}
  };
}

function ensureCompanyBooks(company) {
  ensureBook(company.accounts ||= {}, blankPeriod);
  for (const period of PERIODS) {
    for (const key of ["producedUnits", "soldUnits", "taxedUnits", "purchasedInputUnits"]) {
      company.accounts[period][key] ||= {};
    }
  }
  company.inventory ||= {};
  company.inventoryCostVoucherUnits ||= {};
  wageBook(company.payroll ||= { arrearsVoucherUnits: 0, cumulativePaidVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0 });
  company.shareSale ||= { offeredShares: 0, sharePriceVoucherUnits: 0, cumulativeProceedsVoucherUnits: 0, lastSaleVoucherUnits: 0, lastSoldShares: 0 };
  company.listing ||= { listed: (company.totalShares || 0) > 0, ticker: null, listedAt: null };
  company.settings ||= { wagePerWorkerDay: null, targetWorkers: null, salePricesVoucherPerUnit: {} };
  company.settings.salePricesVoucherPerUnit ||= {};
  company.annualSettlement ||= { lastSettledYear: 0, lastYearNetProfitVoucherUnits: 0, workingCapitalTargetVoucherUnits: 0, distributedVoucherUnits: 0, undistributedVoucherUnits: company.retainedEarningsVoucherUnits || 0 };
  company.dividendHistory ||= [];
  company.householdShares ||= {};
  company.retainedEarningsVoucherUnits ||= 0;
  company.cashVoucherUnits ||= 0;
  company.cashWheatUnits ||= 0;
  company.operatingDays ||= 0;
  company.lastDividendYear ||= 0;
  company.history ||= [];
  company.plan ||= { ageDays: 0 };
  return company;
}

export function ensureCompanies(state, content) {
  state.companies ||= {};
  state.nextCompanyNumber ||= 1;
  state.employment ||= {};
  for (const company of Object.values(state.companies)) {
    ensureCompanyBooks(company);
    for (const itemId of Object.keys(content.items)) {
      company.inventory[itemId] ??= 0;
      company.inventoryCostVoucherUnits[itemId] ??= 0;
    }
  }
  return state.companies;
}

function addPeriodValue(company, key, amount) {
  if (amount) bookAdd(company.accounts, key, amount);
}

function addPeriodMap(company, key, itemId, amount) {
  if (amount) bookAddMap(company.accounts, key, itemId, amount);
}

function applyProfit(company, delta) {
  if (!delta) return;
  bookAdd(company.accounts, "profitVoucherUnits", delta);
  company.retainedEarningsVoucherUnits = (company.retainedEarningsVoucherUnits || 0) + delta;
}

function removeInventoryWithCost(company, itemId, quantityUnits) {
  return takeStock(company, itemId, quantityUnits, { strict: true }).costUnits;
}

const addInventory = putStock;

function marketUnitPrice(state, itemId, content) {
  return currentUnitPrice(state, itemId, content);
}

function voucherCost(quantityUnits, pricePerJinOrUnit, content) {
  const physical = quantityUnits / content.precision.inventoryUnitsPerJin;
  return Math.max(0, Math.round(physical * pricePerJinOrUnit * currencyScale(content)));
}

export function buyInputForCompany(state, company, itemId, wantedUnits, content) {
  if (wantedUnits <= 0) return { boughtUnits: 0, paidVoucherUnits: 0 };
  const purchase = buyWholesaleForOwner(state, `company:${company.id}`, itemId, wantedUnits, content,
    `${company.name}从批发市场采购${content.items[itemId]?.name || itemId}`);
  if ((purchase.boughtUnits || 0) > 0) {
    addInventory(company, itemId, purchase.boughtUnits, purchase.paidVoucherUnits || 0);
    addPeriodValue(company, "inputPurchaseVoucherUnits", purchase.paidVoucherUnits || 0);
    addPeriodMap(company, "purchasedInputUnits", itemId, purchase.boughtUnits);
  }
  return { boughtUnits: purchase.boughtUnits || 0, paidVoucherUnits: purchase.paidVoucherUnits || 0, missingUnits: Math.max(0, wantedUnits - (purchase.boughtUnits || 0)), reason: purchase.reason };
}

export function createIndependentCompany(state, buildingId, options, content) {
  ensureCompanies(state, content);
  const building = state.buildings.find(row => row.id === buildingId);
  if (!building) return { ok: false, reason: "建筑不存在" };
  if (!isIndustryType(content, building.typeId)) return { ok: false, reason: "此建筑暂不支持成立独立公司" };
  if (Object.values(state.companies).some(company => company.buildingId === buildingId)) {
    return { ok: false, reason: "同一建筑最多对应一家公司" };
  }
  building.ownership ||= { townLevels: building.level || 1, privateLevels: 0, listedLevels: 0 };
  building.ownership.listedLevels ||= 0;
  const levels = Math.floor(Number(options?.levels) || 0);
  if (levels <= 0 || levels > (building.ownership.townLevels || 0)) return { ok: false, reason: "公司等级必须来自尚属镇营的等级" };
  const cashUnits = Math.round(Math.max(0, Number(options?.operatingCapitalVoucher || 0)) * currencyScale(content));
  if (cashUnits > 0) {
    const quote = quoteMonetaryPayment(state, "town", currentPaymentComposition(state, cashUnits), content);
    if (!quote.full) return { ok: false, reason: "镇库可支付资产不足，无法投入所设营运资金" };
  }
  const definition = content.buildings[building.typeId];
  const recipe = content.recipes[definition.recipeId];
  const requestedMaterials = options?.initialMaterials && typeof options.initialMaterials === "object"
    ? options.initialMaterials
    : Object.fromEntries((recipe?.inputs || []).slice(0, 1).map(row => [row.itemId, Math.max(0, Number(options?.initialMaterialQuantity || 0))]));
  const materialRows = [];
  for (const input of recipe?.inputs || []) {
    const quantity = Math.max(0, Number(requestedMaterials[input.itemId] || 0));
    const units = Math.round(quantity * content.precision.inventoryUnitsPerJin);
    if (units > (state.accounts.town[input.itemId] || 0)) return { ok: false, reason: `镇库${content.items[input.itemId]?.name || input.itemId}不足，不能作为企业初始投入` };
    if (units > 0) materialRows.push({ itemId: input.itemId, units });
  }
  const id = "company-" + (state.nextCompanyNumber || 1);
  state.nextCompanyNumber = (state.nextCompanyNumber || 1) + 1;
  const inventory = Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
  const inventoryCostVoucherUnits = Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
  const name = String(options?.name || "").trim().slice(0, 30) || definition.name + "公司";
  const defaultWage = state.employment.wageRates?.[definition.jobs?.[0]?.id] ?? definition.jobs?.[0]?.wagePerWorkerDay ?? 5;
  const company = ensureCompanyBooks({
    id, name, buildingId, typeId: building.typeId, listedLevels: levels,
    totalShares: 0, townShares: 0, residentShares: 0, householdShares: {},
    cashVoucherUnits: 0, cashWheatUnits: 0, inventory, inventoryCostVoucherUnits,
    created: { year: state.year, day: Math.min(content.rules.daysPerYear, state.day + 1) },
    initialInvestment: { cashVoucherUnits: cashUnits, cashValueUnits: cashUnits, cashVoucherPaidUnits: 0, cashWheatValueUnits: 0, materials: [] },
    retainedEarningsVoucherUnits: 0, operatingDays: 0, lastDividendYear: 0, status: "待开工",
    listing: { listed: false, ticker: null, listedAt: null },
    settings: { wagePerWorkerDay: defaultWage, targetWorkers: Math.min(levels * (definition.jobs?.[0]?.slots || 0), levels * (definition.jobs?.[0]?.slots || 0)), salePricesVoucherPerUnit: {} }
  });
  state.companies[id] = company;
  building.ownership.townLevels -= levels;
  building.ownership.listedLevels += levels;
  const job = definition.jobs?.[0];
  if (job) {
    const townKey = buildingId + "::" + job.id;
    const companyKey = listedJobKeyForBuilding(buildingId, job.id);
    const townWorkers = readJobCount(state, townKey);
    const townCapacity = job.slots * building.ownership.townLevels;
    const transferable = Math.max(0, townWorkers - townCapacity);
    setJobCount(state, townKey, Math.min(townWorkers, townCapacity), content);
    setJobCount(state, companyKey, Math.min(transferable, job.slots * levels), content, { type: "company", id });
  }
  if (cashUnits > 0) {
    const transfer = settleMonetaryPayment(state, "town", "company:" + id, currentPaymentComposition(state, cashUnits), content,
      "enterprise_capital_injection", `镇库向${company.name}投入营运资金`, { requireFull: true });
    if (!transfer.ok) throw new Error("企业营运资金预检后转账失败：" + (transfer.reason || "未知错误"));
    company.initialInvestment.cashVoucherPaidUnits = transfer.voucherPaidValueUnits || 0;
    company.initialInvestment.cashWheatValueUnits = transfer.wheatPaidValueUnits || 0;
  }
  for (const row of materialRows) {
    const transferredCostBasis = removeTownInventoryWithCost(state, row.itemId, row.units, content).costWheatUnits;
    const referenceValue = voucherCost(row.units, marketUnitPrice(state, row.itemId, content), content);
    addInventory(company, row.itemId, row.units, transferredCostBasis);
    company.initialInvestment.materials.push({ itemId: row.itemId, quantityUnits: row.units, referenceVoucherUnits: referenceValue, costBasisVoucherUnits: transferredCostBasis });
    recordLedger(state, { type: "enterprise_material_contribution", transactionId: makeTransactionId(state), source: "town", destination: "company:" + id, itemId: row.itemId, quantityUnits: row.units, qeqUnits: 0, reason: `${company.name}设立时的实物资本投入；不计经营收入` }, content);
  }
  if (state.market?.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  recordEvent(state, `${company.name}成立：${levels}级产能划归公司，由镇库100%持有；成立不等于上市。`, content, { day: state.day + 1 });
  return { ok: true, companyId: id, levels };
}

// 兼容旧内部调用名；0.1.7 语义已改为“成立公司”，不会自动上市。
export const createListedCompany = createIndependentCompany;

export function setCompanyWage(state, companyId, value, content) {
  const company = state.companies?.[companyId];
  const wage = Number(value);
  if (!company) return { ok: false, reason: "企业不存在" };
  if (!Number.isFinite(wage) || wage < 0 || wage > 100000) return { ok: false, reason: "企业日薪须为有限的非负数" };
  ensureCompanyBooks(company).settings.wagePerWorkerDay = wage;
  return { ok: true, value: wage };
}

export function setCompanyTargetWorkers(state, companyId, value, content) {
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "企业不存在" };
  const definition = content.buildings[company.typeId];
  const max = (definition.jobs?.[0]?.slots || 0) * company.listedLevels;
  const target = Math.floor(Number(value));
  if (!Number.isFinite(target) || target < 0 || target > max) return { ok: false, reason: `目标用工须为0—${max}人` };
  ensureCompanyBooks(company).settings.targetWorkers = target;
  return { ok: true, value: target };
}

export function setCompanySalePrice(state, companyId, itemId, value, content) {
  const company = state.companies?.[companyId];
  const price = Number(value);
  if (!company) return { ok: false, reason: "企业不存在" };
  const outputIds = (content.recipes[content.buildings[company.typeId]?.recipeId]?.outputs || []).map(row => row.itemId);
  if (!outputIds.includes(itemId)) return { ok: false, reason: "该商品不是此公司的产品" };
  if (!Number.isFinite(price) || price <= 0 || price > 1e6) return { ok: false, reason: "售价须为正的有限数值" };
  ensureCompanyBooks(company).settings.salePricesVoucherPerUnit[itemId] = price;
  return { ok: true, itemId, value: price };
}

export function companySalePrice(state, company, itemId, content) {
  const value = ensureCompanyBooks(company).settings.salePricesVoucherPerUnit[itemId];
  return Number.isFinite(value) && value > 0 ? value : marketUnitPrice(state, itemId, content);
}

export function previewCompanyLevelChange(state, companyId, direction, content) {
  const company = state.companies?.[companyId];
  if (!company) return { available: false, reason: "企业不存在", direction };
  const building = state.buildings.find(row => row.id === company.buildingId);
  if (!building) return { available: false, reason: "公司建筑不存在", direction };
  const listed = Boolean(company.listing?.listed);
  const levelsBefore = company.listedLevels;
  const totalSharesBefore = company.totalShares || 0;
  const townSharesBefore = company.townShares || 0;
  const townPercentBefore = totalSharesBefore > 0 ? townSharesBefore / totalSharesBefore * 100 : 0;

  if (direction === "add") {
    if ((building.ownership?.townLevels || 0) <= 0) return { available: false, reason: "没有可划入的镇营等级", direction, levelsBefore };
    let issuedShares = 0;
    if (listed) {
      if (totalSharesBefore <= 0 || totalSharesBefore % levelsBefore !== 0) return { available: false, reason: "当前总股本不能按每级等量股份划分", direction, levelsBefore };
      issuedShares = totalSharesBefore / levelsBefore;
    }
    const totalSharesAfter = totalSharesBefore + issuedShares;
    const townSharesAfter = townSharesBefore + issuedShares;
    return {
      available: true, direction, listed, levelDelta: 1, levelsBefore, levelsAfter: levelsBefore + 1,
      issuedShares, cancelledShares: 0, totalSharesBefore, totalSharesAfter, townSharesBefore, townSharesAfter,
      townPercentBefore, townPercentAfter: totalSharesAfter > 0 ? townSharesAfter / totalSharesAfter * 100 : 0
    };
  }

  if (direction === "remove") {
    if (levelsBefore <= 1) return { available: false, reason: "全部等级划回须先完成居民股权回购与公司清算", direction, levelsBefore };
    let cancelledShares = 0;
    if (listed) {
      if (totalSharesBefore <= 0 || totalSharesBefore % levelsBefore !== 0) return { available: false, reason: "当前总股本不能按每级等量股份划分", direction, levelsBefore };
      cancelledShares = totalSharesBefore / levelsBefore;
      if (townSharesBefore < cancelledShares) return {
        available: false, reason: `镇库还缺${cancelledShares - townSharesBefore}股；须先由镇库回购居民股份`, direction, listed, levelsBefore,
        cancelledShares, requiredTownShares: cancelledShares, totalSharesBefore, townSharesBefore, townPercentBefore
      };
    }
    const totalSharesAfter = totalSharesBefore - cancelledShares;
    const townSharesAfter = townSharesBefore - cancelledShares;
    return {
      available: true, direction, listed, levelDelta: -1, levelsBefore, levelsAfter: levelsBefore - 1,
      issuedShares: 0, cancelledShares, totalSharesBefore, totalSharesAfter, townSharesBefore, townSharesAfter,
      townPercentBefore, townPercentAfter: totalSharesAfter > 0 ? townSharesAfter / totalSharesAfter * 100 : 0
    };
  }

  return { available: false, reason: "未知等级变动", direction, levelsBefore };
}

export function addCompanyLevel(state, companyId, content) {
  const preview = previewCompanyLevelChange(state, companyId, "add", content);
  if (!preview.available) return { ok: false, reason: preview.reason, preview };
  const company = state.companies[companyId];
  const building = state.buildings.find(row => row.id === company.buildingId);
  if (preview.listed) {
    company.totalShares = preview.totalSharesAfter;
    company.townShares = preview.townSharesAfter;
  }
  company.listedLevels = preview.levelsAfter;
  building.ownership.townLevels -= 1;
  building.ownership.listedLevels += 1;
  const job = content.buildings[company.typeId]?.jobs?.[0];
  if (job) company.settings.targetWorkers = Math.min(company.settings.targetWorkers ?? 0, job.slots * company.listedLevels);
  if (state.market?.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  return { ok: true, issuedShares: preview.issuedShares, levels: company.listedLevels, totalShares: company.totalShares, townShares: company.townShares, preview };
}

export function removeCompanyLevel(state, companyId, content) {
  const preview = previewCompanyLevelChange(state, companyId, "remove", content);
  if (!preview.available) return { ok: false, reason: preview.reason, requiredTownShares: preview.requiredTownShares, preview };
  const company = state.companies[companyId];
  const building = state.buildings.find(row => row.id === company.buildingId);
  if (preview.listed) {
    company.totalShares = preview.totalSharesAfter;
    company.townShares = preview.townSharesAfter;
    if (company.shareSale) company.shareSale.offeredShares = Math.min(company.shareSale.offeredShares || 0, company.townShares);
  }
  company.listedLevels = preview.levelsAfter;
  building.ownership.townLevels += 1;
  building.ownership.listedLevels -= 1;
  const job = content.buildings[company.typeId]?.jobs?.[0];
  if (job) {
    const key = listedJobKeyForBuilding(company.buildingId, job.id);
    const cap = job.slots * company.listedLevels;
    if (readJobCount(state, key) > cap) setJobCount(state, key, cap, content, { type: "company", id: company.id });
    company.settings.targetWorkers = Math.min(company.settings.targetWorkers ?? cap, cap);
  }
  if (state.market?.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  return { ok: true, cancelledShares: preview.cancelledShares, levels: company.listedLevels, totalShares: company.totalShares, townShares: company.townShares, preview };
}

export function liquidateCompanyToTown(state, companyId, content) {
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "企业不存在" };
  if (company.listing?.listed && (company.residentShares || 0) > 0) return { ok: false, reason: "仍有居民持股，须先完成镇库回购" };
  if ((company.fundShares || 0) > 0) return { ok: false, reason: "社保基金仍持股，须先卖回镇库" };
  if ((company.payroll?.arrearsVoucherUnits || 0) > 0) return { ok: false, reason: "公司仍有工资债务，不能先向股东返还资产" };
  const building = state.buildings.find(row => row.id === company.buildingId);
  if (!building) return { ok: false, reason: "公司建筑不存在" };
  const payable = maximumPayableValueUnits(state, "company:" + company.id, content);
  const cash = maximumFullyPayableValueUnits(state, "company:" + company.id, payable, content);
  if (cash > 0) {
    const payment = settleMonetaryPayment(state, "company:" + company.id, "town", currentPaymentComposition(state, cash), content, "enterprise_liquidation", `${company.name}清算返还镇库`, { requireFull: true });
    if (!payment.ok) return { ok: false, reason: payment.reason || "公司现金清算失败" };
  }
  for (const itemId of Object.keys(content.items)) {
    const qty = company.inventory?.[itemId] || 0;
    if (qty <= 0) continue;
    const cost = removeInventoryWithCost(company, itemId, qty);
    state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + qty;
    addTownCostBasis(state, itemId, cost);
  }
  const levels = company.listedLevels;
  building.ownership.townLevels += levels;
  building.ownership.listedLevels -= levels;
  const job = content.buildings[company.typeId]?.jobs?.[0];
  if (job) setJobCount(state, listedJobKeyForBuilding(company.buildingId, job.id), 0, content, { type: "company", id: company.id });
  for (const household of householdList(state)) if (household.shares) delete household.shares[company.id];
  delete state.companies[company.id];
  if (state.market?.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  recordEvent(state, `${company.name}完成债务优先清算，全部等级划回镇营。`, content, { day: state.day + 1 });
  return { ok: true, levelsReturned: levels };
}

// v14/v15 command/save compatibility only. 0.1.7 annual settlement and share valuation do not multiply by this field.
export function setCompanyDividendPercent(state, companyId, percent) {
  const company = state.companies?.[companyId];
  const value = Number(percent);
  if (!company) return { ok: false, reason: "企业不存在" };
  if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, reason: "分红比例须为0%—100%" };
  company.dividendPercent = Math.round(value * 100) / 100;
  return { ok: true, value: company.dividendPercent };
}

export function setIntermediatePrice(state, itemId, price, content) {
  if (!["flour", "bread", "wood"].includes(itemId)) return { ok: false, reason: "该商品价格本版不开放调整" };
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0 || value > 1e6) return { ok: false, reason: "价格须为正的有限数值" };
  return setCurrentUnitPrice(state, itemId, value, content);
}

export function setShareOffer(state, companyId, offeredShares, priceVoucherPerShare, content) {
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "企业不存在" };
  if (!company.listing?.listed) return { ok: false, reason: "公司尚未上市" };
  if (state.monetaryReform?.stage !== "voucher") return { ok: false, reason: "股票交易须在货币改革完成后使用粮券" };
  const shares = Math.floor(Number(offeredShares) || 0);
  const priceUnits = Math.round(Number(priceVoucherPerShare) * currencyScale(content));
  if (shares < 0 || shares > company.townShares) return { ok: false, reason: "出售股数不能超过镇库持股" };
  if (!Number.isSafeInteger(priceUnits) || priceUnits <= 0) return { ok: false, reason: "每股售价须大于0" };
  company.shareSale.offeredShares = shares;
  company.shareSale.sharePriceVoucherUnits = priceUnits;
  return { ok: true, offeredShares: shares, priceVoucherUnits: priceUnits };
}

function householdShareCapacity(state, household, priceUnits, content) {
  if (priceUnits <= 0) return 0;
  const scale = currencyScale(content);
  const foodReserveDays = content.rules.shareFoodReserveDays || 90;
  const livingDays = content.rules.shareLivingVoucherReserveDays || 30;
  const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, foodReserveDays);
  const totalValue = voucherBalance(state, `household:${household.id}`) + voucherUnitsForWheatUnits(maxWheatUnits, content, "floor");
  const livingReserve = Math.round(householdPopulation(household) * content.rules.foodPerPersonDay * livingDays * scale);
  let high = Math.max(0, Math.floor((totalValue - livingReserve) / priceUnits));
  let low = 0;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const quote = quoteMonetaryPayment(state, `household:${household.id}`, currentPaymentComposition(state, mid * priceUnits), content, { maxWheatUnits });
    if (quote.full) low = mid; else high = mid - 1;
  }
  return low;
}

function residentsFoodReserveQeq(state, content) {
  let total = 0;
  for (const [itemId, item] of Object.entries(content.items)) {
    if (!item.edible || !item.qeq) continue;
    const units = state.accounts.residents[itemId] || 0;
    total += units * content.precision.qeqUnitsPerJin * item.qeq.numerator /
      (content.precision.inventoryUnitsPerJin * item.qeq.denominator);
  }
  return total;
}

export function previewShareSubscription(state, companyId, content) {
  const paymentState = createPaymentViewState(state);
  const company = state.companies?.[companyId];
  if (!company) return { available: false, reason: "企业不存在" };
  if (!company.listing?.listed) return { available: false, reason: "公司尚未上市" };
  if (state.monetaryReform?.stage !== "voucher") return { available: false, reason: "股票认购须在货币改革完成后使用粮券" };
  if (!(state.buildings || []).some(row => row.typeId === "stock_exchange") && !state.stockExchange?.legacyAccess) return { available: false, reason: "尚未建成交易所" };
  const scale = currencyScale(content);
  const shareSale = company.shareSale || {};
  const offered = Math.min(shareSale.offeredShares || 0, company.townShares || 0);
  const priceUnits = shareSale.sharePriceVoucherUnits || 0;
  if (offered <= 0 || priceUnits <= 0) return { available: false, reason: "请先设置出售股数和每股售价", offeredShares: offered };
  const people = populationStats(state).total;
  const foodNeedQeq = people * content.rules.foodPerPersonDay * (content.rules.shareFoodReserveDays || 90) * content.precision.qeqUnitsPerJin;
  const foodReserveOk = residentsFoodReserveQeq(state, content) >= foodNeedQeq;
  const livingVoucherReserve = Math.round(people * content.rules.foodPerPersonDay *
    (content.rules.shareLivingVoucherReserveDays || 30) * scale);
  const affordableShares = householdList(state).filter(isActiveHousehold)
    .reduce((sum, household) => sum + householdShareCapacity(paymentState, household, priceUnits, content), 0);
  const residentCash = maximumPayableValueUnits(paymentState, "residents", content);
  const actualPerformance = companyActualProfitValuation(state, company, content);
  const observedDays = actualPerformance.observedDays;
  const realizedProfit = actualPerformance.actualProfitVoucherUnits;
  const annualizedProfit = actualPerformance.annualizedProfitVoucherUnits;
  const referenceCompanyValue = actualPerformance.referenceCompanyValueVoucherUnits || 0;
  const referencePerShare = company.totalShares > 0 ? Math.floor(referenceCompanyValue / company.totalShares) : 0;
  const epsUnits = company.totalShares > 0 ? annualizedProfit / company.totalShares : 0;
  const annualProfitPerShareUnits = Math.max(0, epsUnits);
  const yieldRatio = priceUnits > 0 ? annualProfitPerShareUnits / priceUnits : 0;
  let demandFactor = 0;
  let basis = actualPerformance.performanceStatus || "暂无业绩";
  if (actualPerformance.validProfitMethod && referencePerShare > 0) {
    demandFactor = Math.max(0, Math.min(1, referencePerShare / priceUnits));
    basis = `按${observedDays}个日历日真实净利润、投入资本利润率统一估值；停工日计入观察窗口`;
  } else if (observedDays < (content.rules.sharePerformanceObservationDays || 30)) {
    // 无足够业绩时公司估值仍为0；只保留少量“新股试购”需求，不用库存/净资产伪造估值或收益。
    demandFactor = Math.max(0, Math.min(1, (content.rules.shareNoHistoryMaxTakePercent || 10) / 100));
    basis = observedDays > 0
      ? `已观察${observedDays}个日历日，尚未达到${content.rules.sharePerformanceObservationDays || 30}日业绩窗口；估值为0，仅允许小比例试购`
      : "暂无业绩；估值为0，仅允许小比例试购";
  } else {
    basis = `已观察${observedDays}个日历日，但净利润未形成正估值`;
  }
  const demandShares = Math.floor(offered * demandFactor);
  const subscribedShares = foodReserveOk ? Math.min(offered, affordableShares, demandShares) : 0;
  const proceedsUnits = subscribedShares * priceUnits;
  return {
    available: foodReserveOk && subscribedShares > 0,
    reason: !foodReserveOk ? `居民未达到${content.rules.shareFoodReserveDays || 90}日基本口粮储备` :
      affordableShares <= 0 ? "居民可投资资产不足" :
      demandShares <= 0 ? "当前售价相对实际经营表现缺乏认购吸引力" : null,
    offeredShares: offered,
    subscribedShares,
    proceedsVoucherUnits: proceedsUnits,
    priceVoucherUnits: priceUnits,
    residentCashUnits: residentCash,
    livingVoucherReserveUnits: livingVoucherReserve,
    affordableShares,
    demandFactor,
    observedDays,
    realizedProfitVoucherUnits: realizedProfit,
    annualizedProfitVoucherUnits: annualizedProfit,
    epsVoucherUnits: epsUnits,
    referenceDividendYield: yieldRatio,
    referenceCompanyValueVoucherUnits: referenceCompanyValue,
    referencePerShareVoucherUnits: referencePerShare,
    investedCapitalVoucherUnits: actualPerformance.investedCapitalVoucherUnits,
    annualizedProfitRateBps: actualPerformance.annualizedProfitRateBps,
    bookValuePerShareVoucherUnits: 0,
    basis
  };
}

export function executeShareSubscription(state, companyId, content) {
  const company = state.companies?.[companyId];
  const preview = previewShareSubscription(state, companyId, content);
  if (!company || !preview.available) return { ok: false, reason: preview.reason || "当前无认购成交", preview };
  const priceUnits = company.shareSale.sharePriceVoucherUnits || 0;
  const scale = currencyScale(content);
  let sharesLeft = preview.subscribedShares;
  let proceeds = 0;
  const buyers = [];
  const households = householdList(state).filter(isActiveHousehold).slice().sort((a, b) =>
    householdShareCapacity(state, b, priceUnits, content) - householdShareCapacity(state, a, priceUnits, content) || a.id.localeCompare(b.id));
  for (const household of households) {
    if (sharesLeft <= 0) break;
    const shares = Math.min(sharesLeft, householdShareCapacity(state, household, priceUnits, content));
    if (shares <= 0) continue;
    const cost = shares * priceUnits;
    const payment = settleMonetaryPayment(state, `household:${household.id}`, "town", currentPaymentComposition(state, cost), content,
      "share_subscription", `${household.name}认购${company.name}股份`,
      { requireFull: true, maxWheatUnits: householdConvertibleWheatUnits(state, household, content, content.rules.shareFoodReserveDays || 90) });
    if (!payment.ok) continue;
    company.householdShares[household.id] = (company.householdShares[household.id] || 0) + shares;
    household.shares ||= {};
    household.shares[company.id] = (household.shares[company.id] || 0) + shares;
    buyers.push({ householdId: household.id, shares, voucherUnits: cost });
    sharesLeft -= shares;
    proceeds += cost;
  }
  const subscribedShares = preview.subscribedShares - sharesLeft;
  if (subscribedShares <= 0) return { ok: false, reason: "没有家庭具备足够的可投资资产", preview };
  company.townShares -= subscribedShares;
  company.residentShares += subscribedShares;
  company.shareSale.cumulativeProceedsVoucherUnits += proceeds;
  company.shareSale.lastSaleVoucherUnits = proceeds;
  company.shareSale.lastSoldShares = subscribedShares;
  company.shareSale.offeredShares = Math.max(0, company.shareSale.offeredShares - subscribedShares);
  recordEvent(state, `居民家庭认购${company.name}${subscribedShares.toLocaleString("zh-CN")}股；售股收入归镇库。`, content, { day: state.day + 1 });
  return { ok: true, ...preview, subscribedShares, proceedsVoucherUnits: proceeds, buyers };
}

export function injectCompanyCapital(state, companyId, amountVoucher, content) {
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "企业不存在" };
  const units = Math.round(Number(amountVoucher) * currencyScale(content));
  if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, reason: "投入金额必须大于0" };
  const transfer = settleMonetaryPayment(state, "town", "company:" + companyId, currentPaymentComposition(state, units), content,
    "enterprise_capital_injection", `镇库追加${company.name}营运资金`, { requireFull: true });
  if (!transfer.ok) return transfer;
  company.initialInvestment ||= { cashVoucherUnits: 0, materials: [] };
  company.initialInvestment.cashVoucherUnits = (company.initialInvestment.cashVoucherUnits || 0) + units;
  company.initialInvestment.cashValueUnits = (company.initialInvestment.cashValueUnits || 0) + units;
  company.initialInvestment.cashVoucherPaidUnits = (company.initialInvestment.cashVoucherPaidUnits || 0) + (transfer.voucherPaidValueUnits || 0);
  company.initialInvestment.cashWheatValueUnits = (company.initialInvestment.cashWheatValueUnits || 0) + (transfer.wheatPaidValueUnits || 0);
  return { ok: true, voucherUnits: units, payment: transfer };
}

export function arrangeListedWorkers(state, content) {
  ensureCompanies(state, content);
  let idle = selectJobRows(state, content).idle;
  for (const company of Object.values(state.companies).sort((a, b) => a.id.localeCompare(b.id))) {
    const building = state.buildings.find(row => row.id === company.buildingId);
    const definition = content.buildings[company.typeId];
    const job = definition?.jobs?.[0];
    if (!building || !job) continue;
    const jobKey = listedJobKeyForBuilding(building.id, job.id);
    const current = Math.min(readJobCount(state, jobKey), job.slots * company.listedLevels);
    const plannedWorkers = plannedWorkersForProducer(state, `company:${company.id}`);
    const desired = Number.isInteger(company.settings?.targetWorkers) ? company.settings.targetWorkers : (plannedWorkers == null ? current : plannedWorkers);
    idle = hireToward(desired, idle, () => readJobCount(state, jobKey), next => setJobCount(state, jobKey, next, content, { type: "company", id: company.id }));
  }
}

export function payListedCompanyWages(state, content) {
  const scale = currencyScale(content); const results = [];
  for (const company of Object.values(ensureCompanies(state, content))) {
    const definition = content.buildings[company.typeId]; const job = definition?.jobs?.[0]; if (!job) continue;
    const jobKey = listedJobKeyForBuilding(company.buildingId, job.id); const workers = readJobCount(state, jobKey);
    const rate = Number.isFinite(company.settings?.wagePerWorkerDay) ? company.settings.wagePerWorkerDay : (state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 5); const due = Math.round(workers * rate * scale);
    const payroll = wageBook(company.payroll);
    accrueWages(state, payroll, jobAssignments(state, jobKey), due, content);
    payroll.cumulativeAccruedVoucherUnits += due; addPeriodValue(company, "wageExpenseVoucherUnits", due); applyProfit(company, -due);
    const paid = payWages(state, payroll, "company:" + company.id, content, "enterprise_wage_payment", `${company.name}偿付具体债权家庭工资`).paid;
    payroll.arrearsVoucherUnits = wageArrears(payroll);
    payroll.cumulativePaidVoucherUnits += paid; addPeriodValue(company, "wagesPaidVoucherUnits", paid);
    results.push({ companyId: company.id, workers, dueVoucherUnits: due, paidVoucherUnits: paid, arrearsVoucherUnits: payroll.arrearsVoucherUnits });
  }
  return results;
}

function companyCapacity(company, state, content) {
  const definition = content.buildings[company.typeId];
  const recipe = content.recipes[definition?.recipeId];
  const job = definition?.jobs?.[0];
  if (!recipe || !job) return { workers: 0, capacity: 0, recipe, definition };
  const workers = readJobCount(state, listedJobKeyForBuilding(company.buildingId, job.id));
  const level = state.buildings.find(row => row.id === company.buildingId)?.level || 1;
  const labor = laborBatches(state, company.typeId, level, workers, recipe.batchesPerWorkerDay, company.productivityCarry);
  return { workers, capacity: labor.batches, exact: labor.exact, recipe, definition };
}

function planTaxUnits(state, company, outputItemId, outputUnits, content) {
  company.taxRemainders ||= {};
  const { taxUnits, carryAfter } = productionTaxUnits(state, company.typeId, company.taxRemainders, outputItemId, outputUnits, content);
  company.taxRemainders[outputItemId] = carryAfter;
  return taxUnits;
}

export function processListedCompany(state, company, content) {
  ensureCompanyBooks(company);
  const { workers, capacity, exact: laborExact, recipe, definition } = companyCapacity(company, state, content);
  if (workers <= 0 || capacity <= 0) {
    company.status = "缺工人";
    return { companyId: company.id, status: "no_workers", batches: 0 };
  }
  const planBatches = plannedBatchesForProducer(state, `company:${company.id}`);
  const planned = Math.min(capacity, planBatches == null ? capacity : planBatches);
  if (planned <= 0) {
    company.status = "缺订单";
    return { companyId: company.id, status: "no_demand", workers, batches: 0 };
  }
  let batches = planned;
  for (const input of recipe.inputs) {
    const perBatch = Math.round(input.quantity * content.precision.inventoryUnitsPerJin);
    const need = perBatch * planned;
    const have = company.inventory[input.itemId] || 0;
    if (have < need) buyInputForCompany(state, company, input.itemId, need - have, content);
    batches = Math.min(batches, Math.floor((company.inventory[input.itemId] || 0) / perBatch));
  }
  if (batches <= 0) {
    company.status = maximumPayableValueUnits(state, "company:" + company.id, content) <= 0 ? "缺资金/原料" : "缺原料";
    return { companyId: company.id, status: maximumPayableValueUnits(state, "company:" + company.id, content) <= 0 ? "no_cash_or_materials" : "no_materials", batches: 0 };
  }
  company.productivityCarry = nextCarry(laborExact, batches, batches >= capacity);
  if (!company.productivityCarry) delete company.productivityCarry;
  // 仅保留为运营统计/旧档兼容：只统计实际生产日；认购与估值不使用此字段。
  company.operatingDays += 1;
  let totalInputCost = 0;
  for (const input of recipe.inputs) {
    const units = Math.round(input.quantity * batches * content.precision.inventoryUnitsPerJin);
    totalInputCost += removeInventoryWithCost(company, input.itemId, units);
  }
  const outputs = recipe.outputs.map(row => ({ itemId: row.itemId, units: Math.round(row.quantity * batches * content.precision.inventoryUnitsPerJin) }));
  const losses = recipe.losses.map(row => ({ itemId: row.itemId, units: Math.round(row.quantity * batches * content.precision.inventoryUnitsPerJin) }));
  const outputWeight = outputs.reduce((sum, row) => sum + row.units, 0);
  const lossWeight = losses.reduce((sum, row) => sum + row.units, 0);
  const totalWeight = outputWeight + lossWeight;
  let assignedCost = 0;
  let processingLossCost = 0;
  for (const loss of losses) {
    const cost = totalWeight > 0 ? Math.floor(totalInputCost * loss.units / totalWeight) : 0;
    assignedCost += cost;
    processingLossCost += cost;
  }
  if (processingLossCost) {
    addPeriodValue(company, "processingLossVoucherUnits", processingLossCost);
    applyProfit(company, -processingLossCost);
  }
  outputs.forEach((output, index) => {
    const grossCost = index === outputs.length - 1
      ? totalInputCost - assignedCost
      : (totalWeight > 0 ? Math.floor(totalInputCost * output.units / totalWeight) : 0);
    assignedCost += index === outputs.length - 1 ? totalInputCost - assignedCost : grossCost;
    const taxUnits = planTaxUnits(state, company, output.itemId, output.units, content);
    const netUnits = output.units - taxUnits;
    const taxCost = output.units > 0 ? Math.floor(grossCost * taxUnits / output.units) : 0;
    const netCost = grossCost - taxCost;
    if (taxUnits > 0) {
      // 统购品税货直接入批发市场（成本随货带入）；没有批发市场时仍入镇库。
      const intake = depositProductionTaxToWholesale(state, output.itemId, taxUnits, taxCost, content,
        { source: "company:" + company.id, reason: `${company.name}按行业生产税以实物缴税` });
      if (!intake.ok) {
        state.accounts.town[output.itemId] = (state.accounts.town[output.itemId] || 0) + taxUnits;
        addTownCostBasis(state, output.itemId, taxCost);
        recordLedger(state, {
          type: "enterprise_production_tax", transactionId: makeTransactionId(state),
          source: "company:" + company.id, destination: "town", itemId: output.itemId,
          quantityUnits: taxUnits, qeqUnits: 0,
          reason: `${company.name}按行业生产税以实物缴税；不再重复扣粮券税`
        }, content);
      }
      addPeriodMap(company, "taxedUnits", output.itemId, taxUnits);
      addPeriodValue(company, "taxCostVoucherUnits", taxCost);
      applyProfit(company, -taxCost);
    }
    addInventory(company, output.itemId, netUnits, netCost);
    addPeriodMap(company, "producedUnits", output.itemId, output.units);
  });
  company.status = batches < planned ? "原料有限" : (planned < capacity ? "按订单生产" : "生产中");
  return { companyId: company.id, status: batches < planned ? "limited_materials" : "ready", workers, batches, plannedBatches: planned };
}

export function processListedCompanies(state, content) {
  const results = [];
  for (const company of Object.values(ensureCompanies(state, content))) results.push(processListedCompany(state, company, content));
  return results;
}

export function sellCompanyProduct(state, companyId, buyer, itemId, quantityUnits, unitPrice, content, reason) {
  const company = state.companies?.[companyId];
  if (!company || quantityUnits <= 0) return { ok: false, reason: "企业或数量无效" };
  // 家庭买方要留够口粮储备。
  const buyerHousehold = state.households?.byId?.[householdIdOf(buyer)];
  const options = buyerHousehold ? { maxWheatUnits: householdConvertibleWheatUnits(state, buyerHousehold, content, content.rules.basicCommerceFoodReserveDays ?? 30) } : {};
  return sellCompanyGoods(state, company, buyer, itemId, quantityUnits, unitPrice, content, reason, options);
}


export function sellCompanyOutputsToWholesale(state, content) {
  if (!hasWholesaleMarket(state)) return { active: false, soldUnits: {} };
  const soldUnits = {};
  for (const company of Object.values(ensureCompanies(state, content))) {
    const definition = content.buildings[company.typeId];
    const recipe = definition?.recipeId ? content.recipes[definition.recipeId] : null;
    for (const output of recipe?.outputs || []) {
      const itemId = output.itemId;
      const available = Math.max(0, company.inventory?.[itemId] || 0);
      if (available <= 0) continue;
      const price = wholesaleUnitPrice(state, itemId, content);
      const sale = sellCompanyProduct(state, company.id, "town", itemId, available, price, content,
        `批发市场收购${company.name}的${content.items[itemId]?.name || itemId}`);
      if (!sale.ok || sale.quantityUnits <= 0) continue;
      depositWholesalePurchasedInventory(state, itemId, sale.quantityUnits, sale.revenueVoucherUnits, content);
      soldUnits[itemId] = (soldUnits[itemId] || 0) + sale.quantityUnits;
    }
  }
  return { active: true, soldUnits };
}

export function companyWorkingCapitalReserve(company, state, content) {
  const definition = content.buildings[company.typeId];
  const job = definition?.jobs?.[0];
  if (!job) return 0;
  const workers = readJobCount(state, listedJobKeyForBuilding(company.buildingId, job.id));
  const capacity = Math.max(0, job.slots * company.listedLevels);
  const configuredTarget = Number.isInteger(company.settings?.targetWorkers) ? company.settings.targetWorkers : null;
  const plannedTarget = Number.isInteger(company.plan?.desiredWorkers) ? company.plan.desiredWorkers : null;
  // 周转金按明确目标经营规模计算；显式0人即0人，只有未设置目标时才回退到计划/容量。短暂停工但目标仍大于0不会压低储备。
  const reserveWorkers = Math.min(capacity, Math.max(0, configuredTarget ?? plannedTarget ?? capacity));
  const wageRate = Number.isFinite(company.settings?.wagePerWorkerDay) ? company.settings.wagePerWorkerDay : (state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 5);
  const days = content.rules.companyOperatingReserveDays || 360;
  const wageReserve = Math.round(reserveWorkers * wageRate * days * currencyScale(content));
  const recipe = definition?.recipeId ? content.recipes[definition.recipeId] : null;
  let inputReserve = 0;
  if (recipe && reserveWorkers > 0) {
    const batchesPerDay = reserveWorkers * (recipe.batchesPerWorkerDay || 0);
    for (const input of recipe.inputs || []) {
      const unitsPerDay = Math.round(input.quantity * batchesPerDay * content.precision.inventoryUnitsPerJin);
      inputReserve += voucherCost(unitsPerDay * days, marketUnitPrice(state, input.itemId, content), content);
    }
  }
  return wageReserve + inputReserve;
}

export function settleAnnualCompanyProfits(state, endingYear, content) {
  const rows = [];
  for (const company of Object.values(ensureCompanies(state, content))) {
    ensureCompanyBooks(company);
    company.annualSettlement ||= { lastSettledYear: 0 };
    if ((company.annualSettlement.lastSettledYear || 0) >= endingYear) continue;
    const pending = company.pendingAnnualSettlement;
    const lastYearNetProfit = pending?.year === endingYear ? (pending.accounts?.profitVoucherUnits || 0) : 0;

    // 先尝试偿付已形成的工资债务。债权仍归原家庭，支付媒介由统一支付层决定。
    const debtResult = payWages(state, company.payroll, "company:" + company.id, content,
      "enterprise_wage_debt_settlement", `${company.name}年度结算前偿付工资债务`);
    company.payroll.arrearsVoucherUnits = wageArrears(company.payroll);

    const retainedBefore = Math.max(0, company.retainedEarningsVoucherUnits || 0);
    const reserve = companyWorkingCapitalReserve(company, state, content);
    const availableValue = maximumPayableValueUnits(state, "company:" + company.id, content);
    const freeCash = Math.max(0, availableValue - reserve);
    let distributable = Math.min(retainedBefore, freeCash);
    if ((company.payroll.arrearsVoucherUnits || 0) > 0 || distributable <= 0) distributable = 0;
    distributable = maximumFullyPayableValueUnits(state, "company:" + company.id, distributable, content);

    let residentPart = 0;
    const householdRows = [];
    if (distributable > 0 && company.listing?.listed && company.totalShares > 0) {
      for (const [householdId, shares] of Object.entries(company.householdShares || {})) {
        const amount = Math.floor(distributable * Math.max(0, shares || 0) / company.totalShares);
        if (amount <= 0) continue;
        const result = settleMonetaryPayment(state, "company:" + company.id, `household:${householdId}`, currentPaymentComposition(state, amount), content,
          "enterprise_annual_distribution", `${company.name}第${endingYear}年家庭股东利润分配`, { requireFull: true });
        if (!result.ok) throw new Error("企业家庭股东年度分配转账失败");
        residentPart += amount;
        householdRows.push({ householdId, shares, voucherUnits: amount });
      }
    }
    let fundPart = 0;
    if (distributable > 0 && company.listing?.listed && company.totalShares > 0 && (company.fundShares || 0) > 0) {
      const amount = Math.floor(distributable * company.fundShares / company.totalShares);
      if (amount > 0) {
        const result = settleMonetaryPayment(state, "company:" + company.id, "social", currentPaymentComposition(state, amount), content,
          "enterprise_annual_distribution", `${company.name}第${endingYear}年社保基金股东利润分配`, { requireFull: true });
        if (!result.ok) throw new Error("企业社保基金股东年度分配转账失败");
        fundPart = amount;
        recordFundDividend(state, amount);
      }
    }
    const townPart = distributable - residentPart - fundPart;
    if (townPart > 0) {
      const result = settleMonetaryPayment(state, "company:" + company.id, "town", currentPaymentComposition(state, townPart), content,
        "enterprise_annual_distribution", `${company.name}第${endingYear}年镇库利润上交`, { requireFull: true });
      if (!result.ok) throw new Error("企业镇库年度分配转账失败");
    }
    company.retainedEarningsVoucherUnits -= distributable;
    company.lastDividendYear = endingYear;
    company.annualSettlement = {
      lastSettledYear: endingYear,
      lastYearNetProfitVoucherUnits: lastYearNetProfit,
      workingCapitalTargetVoucherUnits: reserve,
      distributedVoucherUnits: distributable,
      townVoucherUnits: townPart,
      residentVoucherUnits: residentPart,
      fundVoucherUnits: fundPart,
      undistributedVoucherUnits: company.retainedEarningsVoucherUnits,
      debtPaidVoucherUnits: debtResult?.paid || 0
    };
    const row = { year: endingYear, totalVoucherUnits: distributable, townVoucherUnits: townPart, residentVoucherUnits: residentPart,
      householdRows, retainedBeforeVoucherUnits: retainedBefore, lastYearNetProfitVoucherUnits: lastYearNetProfit,
      workingCapitalReserveVoucherUnits: reserve, debtPaidVoucherUnits: debtResult?.paid || 0 };
    company.dividendHistory.push(row);
    company.pendingAnnualSettlement = null;
    rows.push({ companyId: company.id, ...row });
  }
  return rows;
}

export const settleAnnualCompanyDividends = settleAnnualCompanyProfits;

export function companyActualProfitValuation(state, company, content) {
  const horizon = content.rules.operatingRightValuationDays || 365;
  const serialNow = (state.year - 1) * (content.rules.daysPerYear || 365) + state.day;
  const rows = (company.history || []).filter(row => Number.isInteger(row.serial) && row.serial > serialNow - horizon && row.serial <= serialNow);
  const currentSerial = serialNow;
  const currentIncluded = state.day > 0 && !rows.some(row => row.serial === currentSerial);
  const current = currentIncluded ? [{ serial: currentSerial, profitVoucherUnits: company.accounts?.day?.profitVoucherUnits || 0, revenueVoucherUnits: company.accounts?.day?.revenueVoucherUnits || 0 }] : [];
  const all = rows.concat(current);
  const investedCapital = Math.max(0,
    company.initialInvestment?.cashValueUnits ?? company.initialInvestment?.cashVoucherUnits ?? 0) +
    (company.initialInvestment?.materials || []).reduce((sum, row) => sum + Math.max(0, row.referenceVoucherUnits || 0), 0);
  if (!all.length) return {
    observedDays: 0, actualRevenueVoucherUnits: 0, actualProfitVoucherUnits: 0, annualizedProfitVoucherUnits: 0,
    investedCapitalVoucherUnits: investedCapital, annualizedProfitRateBps: 0, valuationRateFactor: 0,
    referenceCompanyValueVoucherUnits: 0, fiveYearReferenceVoucherUnits: 0, validProfitMethod: false, performanceStatus: "暂无业绩"
  };
  const firstSerial = Math.min(...all.map(row => row.serial));
  const observedDays = Math.min(horizon, Math.max(1, serialNow - firstSerial + 1));
  const actualRevenue = all.reduce((sum, row) => sum + (row.revenueVoucherUnits || 0), 0);
  const actualProfit = all.reduce((sum, row) => sum + (row.profitVoucherUnits || 0), 0);
  const annualized = Math.round(actualProfit * (content.rules.daysPerYear || 365) / observedDays);
  const profitRateBps = investedCapital > 0 ? Math.round(annualized * 10000 / investedCapital) : 0;
  const minDays = content.rules.sharePerformanceObservationDays || 30;
  const targetRate = Math.max(1, Math.round((content.rules.companyValuationTargetProfitRatePercent || 20) * 100));
  const minFactor = Math.max(0, Number(content.rules.companyValuationRateFactorMinimum ?? 0.5));
  const maxFactor = Math.max(minFactor, Number(content.rules.companyValuationRateFactorMaximum ?? 1.5));
  const rateFactor = investedCapital > 0 ? Math.max(minFactor, Math.min(maxFactor, profitRateBps / targetRate)) : 1;
  const validProfitMethod = observedDays >= minDays && annualized > 0;
  const years = Math.max(1, content.rules.companyValuationProfitYears || 5);
  const reference = validProfitMethod ? Math.max(0, Math.round(annualized * years * rateFactor)) : 0;
  return {
    observedDays, actualRevenueVoucherUnits: actualRevenue, actualProfitVoucherUnits: actualProfit,
    annualizedProfitVoucherUnits: annualized, investedCapitalVoucherUnits: investedCapital,
    annualizedProfitRateBps: profitRateBps, valuationRateFactor: rateFactor,
    referenceCompanyValueVoucherUnits: reference, fiveYearReferenceVoucherUnits: reference,
    validProfitMethod, performanceStatus: observedDays < minDays ? "观察中" : (annualized > 0 ? "已有业绩" : "暂无正收益")
  };
}

function archiveCompanyDay(state, company, content) {
  const serial = (state.year - 1) * (content.rules.daysPerYear || 365) + state.day;
  if (serial <= 0 || company.plan?.lastArchivedSerial === serial) return;
  const soldUnits = Object.values(company.accounts?.day?.soldUnits || {}).reduce((sum, units) => sum + units, 0);
  const producedUnits = Object.values(company.accounts?.day?.producedUnits || {}).reduce((sum, units) => sum + units, 0);
  company.history ||= [];
  company.history.push({ serial, soldUnits, producedUnits,
    revenueVoucherUnits: company.accounts?.day?.revenueVoucherUnits || 0,
    inputPurchaseVoucherUnits: company.accounts?.day?.inputPurchaseVoucherUnits || 0,
    wageExpenseVoucherUnits: company.accounts?.day?.wageExpenseVoucherUnits || 0,
    profitVoucherUnits: company.accounts?.day?.profitVoucherUnits || 0 });
  const limit = Math.max(content.rules.operatingRightValuationDays || 365, (content.rules.operatingObservationDays || 7) * 4);
  if (company.history.length > limit) company.history.splice(0, company.history.length - limit);
  company.plan ||= {};
  company.plan.lastArchivedSerial = serial;
}

export function resetCompanyDaily(state, content) {
  for (const company of Object.values(ensureCompanies(state, content))) {
    archiveCompanyDay(state, company, content);
    company.accounts.day = blankPeriod();
  }
}

export function resetCompanyYear(state, content, closingYear = null) {
  for (const company of Object.values(ensureCompanies(state, content))) {
    // 跨年时 state 已进入新年 day=0，但 company.accounts.day 仍是旧年最后一天。
    // 先按连续日序列归档，避免玩家在新年首次日结前挂牌/认购时少算第365天。
    if (closingYear) archiveCompanyDay(state, company, content);
    if (closingYear && company.accounts?.year) company.pendingAnnualSettlement = { year: closingYear, accounts: JSON.parse(JSON.stringify(company.accounts.year)) };
    company.accounts.year = blankPeriod();
  }
}

export function companySummary(state, company, content) {
  const scale = currencyScale(content);
  const actualPerformance = companyActualProfitValuation(state, company, content);
  const annualizedProfitUnits = actualPerformance.annualizedProfitVoucherUnits;
  const epsUnits = company.totalShares > 0 ? annualizedProfitUnits / company.totalShares : 0;
  const sharePrice = company.shareSale?.sharePriceVoucherUnits || 0;
  const referenceYield = sharePrice > 0 ? Math.max(0, epsUnits) / sharePrice : 0;
  const definition = content.buildings[company.typeId];
  const job = definition?.jobs?.[0];
  const workers = job ? readJobCount(state, listedJobKeyForBuilding(company.buildingId, job.id)) : 0;
  const recipe = definition?.recipeId ? content.recipes[definition.recipeId] : null;
  const outputItemIds = (recipe?.outputs || []).map(row => row.itemId);
  const finishedStock = outputItemIds.reduce((sum, itemId) => sum + (company.inventory?.[itemId] || 0), 0);
  const soldToday = Object.values(company.accounts?.day?.soldUnits || {}).reduce((sum, units) => sum + units, 0);
  const observed = [...(company.history || []), { soldUnits: soldToday,
    revenueVoucherUnits: company.accounts?.day?.revenueVoucherUnits || 0,
    inputPurchaseVoucherUnits: company.accounts?.day?.inputPurchaseVoucherUnits || 0,
    wageExpenseVoucherUnits: company.accounts?.day?.wageExpenseVoucherUnits || 0,
    profitVoucherUnits: company.accounts?.day?.profitVoucherUnits || 0 }];
  const averageDailySalesUnits = recentAverage(observed, "soldUnits", content);
  const averageDailyProfitUnits = recentAverage(observed, "profitVoucherUnits", content);
  const averageRevenueUnits = recentAverage(observed, "revenueVoucherUnits", content);
  const averageInputPurchaseUnits = recentAverage(observed, "inputPurchaseVoucherUnits", content);
  const averageWageUnits = recentAverage(observed, "wageExpenseVoucherUnits", content);
  const inventoryDays = averageDailySalesUnits > 0 ? finishedStock / averageDailySalesUnits : null;
  let displayStatus = company.status || "运营中";
  const wageRate = job ? (Number.isFinite(company.settings?.wagePerWorkerDay) ? company.settings.wagePerWorkerDay : (state.employment?.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 5)) : 0;
  const nextPayrollUnits = Math.round(Math.max(1, workers) * wageRate * scale);
  if ((company.payroll?.arrearsVoucherUnits || 0) > 0) displayStatus = "欠薪";
  else if ((company.plan?.plannedBatches || 0) > 0 && maximumPayableValueUnits(state, "company:" + company.id, content) < nextPayrollUnits) displayStatus = "资金不足";
  else if (workers <= 0 && (company.plan?.desiredWorkers || 0) > 0) displayStatus = "缺工人";
  else if (workers > (company.plan?.desiredWorkers ?? workers)) displayStatus = "用工偏多";
  else if (averageDailyProfitUnits < 0 && averageInputPurchaseUnits > averageWageUnits && averageInputPurchaseUnits > averageRevenueUnits * 0.5) displayStatus = "原料成本高";
  else if (averageDailyProfitUnits < 0 && averageWageUnits >= averageInputPurchaseUnits) displayStatus = "工资压力高";
  else if (averageDailySalesUnits <= 0 && finishedStock > 0) displayStatus = "暂无销量";
  else if (finishedStock > 0 && soldToday <= 0 && ["生产中", "原料有限", "按订单生产"].includes(displayStatus)) displayStatus = "缺订单";
  return {
    ...company,
    status: displayStatus,
    workers,
    capacity: job ? job.slots * company.listedLevels : 0,
    cashVoucher: (company.cashVoucherUnits || 0) / scale,
    cashWheatJin: (company.cashWheatUnits || 0) / content.precision.inventoryUnitsPerJin,
    cashValue: maximumPayableValueUnits(state, "company:" + company.id, content) / scale,
    arrearsVoucher: (company.payroll?.arrearsVoucherUnits || 0) / scale,
    retainedEarningsVoucher: (company.retainedEarningsVoucherUnits || 0) / scale,
    averageDailySales: averageDailySalesUnits / content.precision.inventoryUnitsPerJin,
    averageDailyProfitVoucher: averageDailyProfitUnits / scale,
    inventoryDays,
    plannedWorkers: Number.isInteger(company.settings?.targetWorkers) ? company.settings.targetWorkers : (company.plan?.desiredWorkers || 0),
    plannedBatches: company.plan?.plannedBatches || 0,
    demandBasis: company.plan?.demandBasis || "暂无经营计划",
    annualizedProfitVoucher: annualizedProfitUnits / scale,
    epsVoucher: epsUnits / scale,
    referenceDividendYield: referenceYield,
    townSharePercent: company.totalShares ? company.townShares / company.totalShares : 0,
    residentSharePercent: company.totalShares ? company.residentShares / company.totalShares : 0
  };
}
