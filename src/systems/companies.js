import { inOpeningPeriod, reviewStaffing } from "./employment-contracts.js";
import { payDayFor } from "./paydays.js";
import { populationStats, readJobCount, jobKeyForBuilding, listedJobKeyForBuilding, selectJobRows } from "../selectors/labor.js";
import { laborBatches, nextCarry } from "../economy/productivity.js";
import { isIndustryType } from "../content/buildings.js";
import { householdIdOf } from "../economy/accounts.js";
import { putStock, sellCompanyGoods, takeStock } from "../economy/trade.js";
import { PERIODS, bookAdd, bookAddMap, ensureBook } from "../economy/books.js";
import { recordFundDividend } from "./social-security.js";
import { currencyScale, roundToShareTick, shareTick, voucherBalance } from "../economy/currency.js";
import { createPaymentViewState } from "../economy/payment-view-state.js";
import { currentPaymentComposition, maximumFullyPayableValueUnits, maximumPayableValueUnits, quoteMonetaryPayment, settleMonetaryPayment, spendableVoucherUnits } from "../economy/payment.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { makeTransactionId, recordEvent, recordLedger } from "../economy/ledger.js";
import { addTownCostBasis, removeTownInventoryWithCost } from "../economy/business.js";
import { currentUnitPrice, setCurrentUnitPrice } from "../economy/prices.js";
import { householdConvertibleWheatUnits, householdList, householdPopulation, isActiveHousehold, jobAssignments, setJobCount, syncResidentAggregates } from "./households.js";
import { plannedBatchesForProducer, plannedWorkersForProducer, recentAverage } from "../economy/operating-plan.js";

import { accrueWages, hireToward, payWages, productionTaxUnits, wageArrears, wageBook } from "./employer.js";
import { buyWholesaleForOwner, depositProductionTaxToWholesale, depositWholesalePurchasedInventory, hasWholesaleMarket, readWholesalePurchasePrice } from "./wholesale-market.js";
import { buildingOwner, companyOfBuilding, transferBuildingOwnership, valueUnitsOfGoods } from "./ownership.js";
import { transferWageClaimsToTown } from "./employer.js";
import { privateWageRate, townWageRate } from "./payroll.js";
import { flexPlan, flexRoomUnits } from "./flex-recipe.js";

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
  delete company.cashWheatUnits;
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

// 建立公司的内部步骤（只由 ipo.js 的 listBuilding 调用；对外已取消“单独成立公司”）。
// 整栋建筑划入新公司，岗位人数搬到公司键；公司建立后尚未挂牌（listing.listed=false），挂牌由 applyCompanyListing 完成。
// 主人是镇里：营运资金与实物投入可由镇库提供（options.operatingCapitalVoucher / initialMaterials）。
// 主人是一户：该户存货中本建筑的配方原料与产品随建筑入公司，按收购价计作投入资本，不另付钱。
export function createIndependentCompany(state, buildingId, options, content) {
  ensureCompanies(state, content);
  const building = state.buildings.find(row => row.id === buildingId);
  if (!building) return { ok: false, reason: "建筑不存在" };
  if (!isIndustryType(content, building.typeId)) return { ok: false, reason: "此建筑暂不支持成立独立公司" };
  if (companyOfBuilding(state, buildingId)) {
    return { ok: false, reason: "同一建筑最多对应一家公司" };
  }
  building.ownership ||= { townLevels: building.level || 1, privateLevels: 0, listedLevels: 0 };
  building.ownership.listedLevels ||= 0;
  const owner = buildingOwner(state, building);
  if (owner.kind === "company") return { ok: false, reason: "这栋建筑已有公司主人" };
  const fromTown = owner.kind === "town";
  const household = owner.kind === "household" ? state.households?.byId?.[owner.id] : null;
  if (owner.kind === "household" && !household) return { ok: false, reason: "业主家庭不存在" };
  const levels = Math.max(1, building.level || 1);
  const cashUnits = fromTown ? Math.round(Math.max(0, Number(options?.operatingCapitalVoucher || 0)) * currencyScale(content)) : 0;
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
  for (const input of (fromTown ? recipe?.inputs || [] : [])) {
    const quantity = Math.max(0, Number(requestedMaterials[input.itemId] || 0));
    const units = Math.round(quantity * content.precision.inventoryUnitsPerJin);
    if (units > (state.accounts.town[input.itemId] || 0)) return { ok: false, reason: `镇库${content.items[input.itemId]?.name || input.itemId}不足，不能作为企业初始投入` };
    if (units > 0) materialRows.push({ itemId: input.itemId, units });
  }
  // 业主是一户：本建筑配方里的原料与产品，该户持有多少就随建筑划入（按收购价计成本）。
  const householdStockRows = [];
  if (household) {
    for (const itemId of [...new Set([...(recipe?.inputs || []), ...(recipe?.outputs || [])].map(row => row.itemId))]) {
      const units = Math.max(0, household.inventory?.[itemId] || 0);
      if (units > 0) householdStockRows.push({ itemId, units });
    }
  }
  const id = "company-" + (state.nextCompanyNumber || 1);
  state.nextCompanyNumber = (state.nextCompanyNumber || 1) + 1;
  const inventory = Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
  const inventoryCostVoucherUnits = Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
  const name = String(options?.name || "").trim().slice(0, 30) || definition.name + "公司";
  // 公司起薪：民营转来的沿用业主定的工资，镇营转来的取镇营实际日薪（含工资调控系数）。
  const firstJob = definition.jobs?.[0];
  const defaultWage = !firstJob ? 5 : (building.ownership?.privateLevels || 0) > 0
    ? privateWageRate(state, building, firstJob, content)
    : Math.round(townWageRate(state, firstJob.id, content) * 2) / 2;
  const company = ensureCompanyBooks({
    id, name, buildingId, typeId: building.typeId, listedLevels: levels,
    totalShares: 0, townShares: 0, residentShares: 0, householdShares: {},
    cashVoucherUnits: 0, inventory, inventoryCostVoucherUnits,
    created: { year: state.year, day: Math.min(content.rules.daysPerYear, state.day + 1) },
    initialInvestment: { cashVoucherUnits: cashUnits, cashValueUnits: cashUnits, cashVoucherPaidUnits: 0, materials: [] },
    retainedEarningsVoucherUnits: 0, operatingDays: 0, lastDividendYear: 0, status: "待开工",
    listing: { listed: false, ticker: null, listedAt: null },
    settings: { wagePerWorkerDay: defaultWage, targetWorkers: Math.min(levels * (definition.jobs?.[0]?.slots || 0), levels * (definition.jobs?.[0]?.slots || 0)), salePricesVoucherPerUnit: {} }
  });
  state.companies[id] = company;
  transferBuildingOwnership(state, building, { kind: "company", id }, content);
  if (cashUnits > 0) {
    const transfer = settleMonetaryPayment(state, "town", "company:" + id, currentPaymentComposition(state, cashUnits), content,
      "enterprise_capital_injection", `镇库向${company.name}投入营运资金`, { requireFull: true });
    if (!transfer.ok) throw new Error("企业营运资金预检后转账失败：" + (transfer.reason || "未知错误"));
    company.initialInvestment.cashVoucherPaidUnits = transfer.voucherPaidValueUnits || 0;
  }
  for (const row of materialRows) {
    const transferredCostBasis = removeTownInventoryWithCost(state, row.itemId, row.units, content).costWheatUnits;
    const referenceValue = voucherCost(row.units, marketUnitPrice(state, row.itemId, content), content);
    addInventory(company, row.itemId, row.units, transferredCostBasis);
    company.initialInvestment.materials.push({ itemId: row.itemId, quantityUnits: row.units, referenceVoucherUnits: referenceValue, costBasisVoucherUnits: transferredCostBasis });
    recordLedger(state, { type: "enterprise_material_contribution", transactionId: makeTransactionId(state), source: "town", destination: "company:" + id, itemId: row.itemId, quantityUnits: row.units, qeqUnits: 0, reason: `${company.name}设立时的实物资本投入；不计经营收入` }, content);
  }
  for (const row of householdStockRows) {
    const price = readWholesalePurchasePrice(state, row.itemId, content) || marketUnitPrice(state, row.itemId, content);
    const costUnits = valueUnitsOfGoods(row.units, price, content);
    household.inventory[row.itemId] -= row.units;
    addInventory(company, row.itemId, row.units, costUnits);
    company.initialInvestment.materials.push({ itemId: row.itemId, quantityUnits: row.units, referenceVoucherUnits: costUnits, costBasisVoucherUnits: costUnits, sourceHouseholdId: household.id });
    recordLedger(state, { type: "enterprise_material_contribution", transactionId: makeTransactionId(state), source: "household:" + household.id, destination: "company:" + id, itemId: row.itemId, quantityUnits: row.units, qeqUnits: 0, reason: `${company.name}设立时由业主以存货投入（按收购价计成本）；不计经营收入` }, content);
  }
  if (householdStockRows.length) syncResidentAggregates(state, content);
  if (state.market?.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  return { ok: true, companyId: id, levels, ownerKind: owner.kind };
}

// 兼容旧内部调用名（内部步骤，已不对外提供“成立公司”）。
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

// 整栋归公司：不再按级划入/划回。保留函数与导出，供旧调用方平稳返回。
const WHOLE_BUILDING_REASON = "整栋归公司，不再按级划转";

export function previewCompanyLevelChange(state, companyId, direction, content) {
  return { available: false, reason: WHOLE_BUILDING_REASON, direction, levelsBefore: state.companies?.[companyId]?.listedLevels ?? 0 };
}

// 公司回到镇营的共同收尾：股份作废（居民与社保基金一并注销，不补偿）、公司对象删除、建筑整栋回镇营。
function closeCompanyToTown(state, company, building, content) {
  for (const household of householdList(state)) if (household.shares) delete household.shares[company.id];
  company.fundShares = 0;
  company.householdShares = {};
  company.totalShares = 0;
  company.townShares = 0;
  company.residentShares = 0;
  company.shareSale = { ...(company.shareSale || {}), offeredShares: 0, sharePriceVoucherUnits: 0 };
  company.listing = { listed: false, ticker: null, listedAt: null };
  const levels = building.ownership?.listedLevels || company.listedLevels || 0;
  delete state.companies[company.id];
  transferBuildingOwnership(state, building, { kind: "town", id: null }, content);
  return levels;
}

// 按级划入/划回已废止（整栋归公司）：保留导出，直接返回不可用原因。
export function addCompanyLevel(state, companyId, content) {
  return { ok: false, reason: WHOLE_BUILDING_REASON, preview: previewCompanyLevelChange(state, companyId, "add", content) };
}

export function removeCompanyLevel(state, companyId, content) {
  return { ok: false, reason: WHOLE_BUILDING_REASON, preview: previewCompanyLevelChange(state, companyId, "remove", content) };
}

// 手动清算（镇长操作）：要求没有欠薪、居民与基金不持股，现金与存货先交镇库。
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
  const levels = closeCompanyToTown(state, company, building, content);
  recordEvent(state, `${company.name}完成债务优先清算，整栋建筑划回镇营。`, content, { day: state.day + 1 });
  return { ok: true, levelsReturned: levels };
}

// 欠薪超过宽限天数后的强制清算（docs/OWNERSHIP.md 第 3 条）：
// 现金先还欠薪 → 存货按收购价抵欠薪（只算有收购口径的商品）→ 余下存货与现金归镇库 → 镇库垫付余额 → 股份作废、建筑回镇营。
// 股东（居民、社保基金）不补偿。
export function liquidateCompanyForArrears(state, companyId, content) {
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "企业不存在" };
  const building = state.buildings.find(row => row.id === company.buildingId);
  if (!building) return { ok: false, reason: "公司建筑不存在" };
  const payerId = "company:" + company.id;
  const book = wageBook(company.payroll ||= { arrearsVoucherUnits: 0, cumulativePaidVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0 });
  const arrearsBefore = wageArrears(book);
  const scale = content.precision.inventoryUnitsPerJin;
  // 1. 现金先还欠薪。
  payWages(state, book, payerId, content, "enterprise_liquidation_wage_payment", `${company.name}清算先偿付欠薪`);
  // 2. 存货按收购价变现：批发市场向公司买下（镇库先付现金给公司，市场 purchaseSpend 只记这笔实付），
  //    公司即刻用这笔现金偿付欠薪（先到先抵）。镇库付不起就停，余下存货归镇库（第 3 步，不付钱）。
  let inKindValueUnits = 0;
  for (const itemId of Object.keys(content.items)) {
    if (wageArrears(book) <= 0) break;
    const qty = company.inventory?.[itemId] || 0;
    const price = readWholesalePurchasePrice(state, itemId, content);
    if (qty <= 0 || price <= 0) continue;
    const remaining = wageArrears(book);
    const unitsNeeded = Math.ceil(remaining * scale / (price * currencyScale(content)));
    const take = Math.min(qty, unitsNeeded);
    if (take <= 0) continue;
    const value = valueUnitsOfGoods(take, price, content);
    const purchase = settleMonetaryPayment(state, "town", payerId, currentPaymentComposition(state, value), content,
      "wholesale_private_purchase", `批发市场收购${company.name}清算存货抵欠薪`, { requireFull: true });
    if (!purchase.ok) break;
    removeInventoryWithCost(company, itemId, take);
    depositWholesalePurchasedInventory(state, itemId, take, value, content);
    const paid = payWages(state, book, payerId, content, "enterprise_liquidation_wage_payment", `${company.name}清算存货变现偿付欠薪`);
    inKindValueUnits += paid.paid || 0;
  }
  // 3. 余下存货归镇库（成本随货），余下现金归镇库。
  for (const itemId of Object.keys(content.items)) {
    const qty = company.inventory?.[itemId] || 0;
    if (qty <= 0) continue;
    const cost = removeInventoryWithCost(company, itemId, qty);
    state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + qty;
    addTownCostBasis(state, itemId, cost);
  }
  const cash = maximumFullyPayableValueUnits(state, payerId, maximumPayableValueUnits(state, payerId, content), content);
  if (cash > 0) {
    const payment = settleMonetaryPayment(state, payerId, "town", currentPaymentComposition(state, cash), content, "enterprise_liquidation", `${company.name}清算余款返还镇库`, { requireFull: true });
    if (!payment.ok) throw new Error("公司清算余款转账预检后失败：" + (payment.reason || "未知"));
  }
  // 4. 镇库垫付余额：经镇库支付；仍付不起的部分转入镇库的历史工资债权表。
  let townAdvanceUnits = 0;
  if (wageArrears(book) > 0) {
    const before = wageArrears(book);
    payWages(state, book, "town", content, "enterprise_arrears_town_advance", `${company.name}欠薪由镇库垫付`);
    townAdvanceUnits = before - wageArrears(book);
  }
  const job = content.buildings[company.typeId]?.jobs?.[0];
  const transferredClaimsUnits = job ? transferWageClaimsToTown(state, book, jobKeyForBuilding(company.buildingId, job.id), content) : 0;
  company.payroll.arrearsVoucherUnits = wageArrears(book);
  // 5. 股份作废、建筑回镇营。
  const cancelledResidentShares = company.residentShares || 0;
  const cancelledFundShares = company.fundShares || 0;
  const levels = closeCompanyToTown(state, company, building, content);
  recordEvent(state, `${company.name}连续欠薪超过${content.rules.ownershipTakeoverArrearsDays || 30}天，债务清算：存货抵欠薪${Math.round(inKindValueUnits / content.precision.currencyUnitsPerVoucher)}券，镇库垫付${Math.round(townAdvanceUnits / content.precision.currencyUnitsPerVoucher)}券；居民股份${cancelledResidentShares}股、基金股份${cancelledFundShares}股作废，整栋建筑收回镇营。`, content, { day: state.day + 1 });
  return { ok: true, companyId, arrearsBeforeUnits: arrearsBefore, inKindValueUnits, townAdvanceUnits, transferredClaimsUnits, cancelledResidentShares, cancelledFundShares, levelsReturned: levels };
}

// 分红比例（占近一季净利润的百分比，docs/STOCK.md）：镇库控股（镇库持股过半）的公司由镇长设置；
// 民营上市公司按公司自身策略，缺省 rules.sharePayoutDefaultPercent（60%），镇长不能改。
export function companyPayoutPercent(company, content) {
  if (company.payoutPercent == null) return content.rules.sharePayoutDefaultPercent ?? 60;
  const value = Number(company.payoutPercent);
  return Number.isFinite(value) ? value : (content.rules.sharePayoutDefaultPercent ?? 60);
}

export function townControlsCompany(company) {
  return company.totalShares > 0 && (company.townShares || 0) * 2 > company.totalShares;
}

export function setCompanyDividendPercent(state, companyId, percent, content = null) {
  const company = state.companies?.[companyId];
  const value = Number(percent);
  if (!company) return { ok: false, reason: "企业不存在" };
  if (!company.listing?.listed) return { ok: false, reason: "公司尚未上市" };
  if (!townControlsCompany(company)) return { ok: false, reason: "民营上市公司的分红比例由公司自定，镇长只能设置镇库控股公司的分红比例" };
  const maximum = content?.rules?.sharePayoutMaximumPercent ?? 100;
  if (!Number.isFinite(value) || value < 0 || value > maximum) return { ok: false, reason: `分红比例须为0%—${maximum}%` };
  company.payoutPercent = Math.round(value * 100) / 100;
  return { ok: true, value: company.payoutPercent };
}

export function setIntermediatePrice(state, itemId, price, content) {
  if (!["flour", "bread", "wood"].includes(itemId)) return { ok: false, reason: "该商品价格本版不开放调整" };
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0 || value > 1e6) return { ok: false, reason: "价格须为正的有限数值" };
  return setCurrentUnitPrice(state, itemId, value, content);
}

// 发行池的卖方：shareSale.sellerOwner 缺省或 "town" 为镇库；否则为某户家庭 id（须存在）。
// 卖方不明时返回 null，该公司不参与二级市场。
export function offerSeller(state, company) {
  const owner = company.shareSale?.sellerOwner;
  if (!owner || owner === "town") return { kind: "town" };
  if (state.households?.byId?.[owner]) return { kind: "household", householdId: owner };
  return null;
}

// 卖方在本公司的持股：镇库持股，或该户持股。
export function sellerHoldingShares(state, company) {
  const seller = offerSeller(state, company);
  if (!seller) return 0;
  return seller.kind === "town"
    ? (company.townShares || 0)
    : (company.householdShares?.[seller.householdId] || 0);
}

// 可供住户买入的发行池股数：卖方挂出的股数（shareSale.offeredShares），封顶于卖方实际持股。
// 卖方未挂出的股份不在此列；镇里不会因此自动卖股或回购。
export function offeredPoolShares(state, company) {
  if (!offerSeller(state, company)) return 0;
  return Math.max(0, Math.min(company.shareSale?.offeredShares || 0, sellerHoldingShares(state, company)));
}

export function setShareOffer(state, companyId, offeredShares, priceVoucherPerShare, content) {
  const company = state.companies?.[companyId];
  if (!company) return { ok: false, reason: "企业不存在" };
  if (!company.listing?.listed) return { ok: false, reason: "公司尚未上市" };
  if (!(state.buildings || []).some(row => row.typeId === "stock_exchange") && !state.stockExchange?.legacyAccess) return { ok: false, reason: "尚未建成交易所" };
  if (!offerSeller(state, company)) return { ok: false, reason: "发行池卖方不明，无法挂牌出售" };
  const shares = Math.floor(Number(offeredShares) || 0);
  const priceInput = Number(priceVoucherPerShare);
  if (shares < 0 || shares > sellerHoldingShares(state, company)) return { ok: false, reason: "出售股数不能超过卖方持股" };
  if (!Number.isFinite(priceInput) || priceInput <= 0) return { ok: false, reason: "每股售价须大于0" };
  const priceUnits = roundToShareTick(priceInput * currencyScale(content), content);
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
  const totalValue = spendableVoucherUnits(state, `household:${household.id}`) + voucherUnitsForWheatUnits(maxWheatUnits, content, "floor");
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
  if (!(state.buildings || []).some(row => row.typeId === "stock_exchange") && !state.stockExchange?.legacyAccess) return { available: false, reason: "尚未建成交易所" };
  const scale = currencyScale(content);
  const shareSale = company.shareSale || {};
  const seller = offerSeller(state, company);
  if (!seller) return { available: false, reason: "发行池卖方不明，无法认购" };
  const offered = offeredPoolShares(state, company);
  const priceUnits = shareSale.sharePriceVoucherUnits || 0;
  if (offered <= 0 || priceUnits <= 0) return { available: false, reason: "请先设置出售股数和每股售价", offeredShares: offered };
  const people = populationStats(state).total;
  const foodNeedQeq = people * content.rules.foodPerPersonDay * (content.rules.shareFoodReserveDays || 90) * content.precision.qeqUnitsPerJin;
  const foodReserveOk = residentsFoodReserveQeq(state, content) >= foodNeedQeq;
  const livingVoucherReserve = Math.round(people * content.rules.foodPerPersonDay *
    (content.rules.shareLivingVoucherReserveDays || 30) * scale);
  // 卖方家庭不能买自己挂出的股份。
  const sellerHouseholdId = seller.kind === "household" ? seller.householdId : null;
  const affordableShares = householdList(state).filter(household => isActiveHousehold(household) && household.id !== sellerHouseholdId)
    .reduce((sum, household) => sum + householdShareCapacity(paymentState, household, priceUnits, content), 0);
  const residentCash = maximumPayableValueUnits(paymentState, "residents", content);
  const actualPerformance = companyActualProfitValuation(state, company, content, content.rules.stockProfitWindowDays);
  const observedDays = actualPerformance.observedDays;
  const realizedProfit = actualPerformance.actualProfitVoucherUnits;
  const annualizedProfit = actualPerformance.annualizedProfitVoucherUnits;
  const referenceCompanyValue = stockFairValueUnits(actualPerformance, content);
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
    sellerOwner: sellerHouseholdId || "town",
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
  // 股款付给卖方（镇库或原业主家庭）；股份从卖方名下转出。
  const seller = offerSeller(state, company);
  const sellerHousehold = seller.kind === "household" ? state.households.byId[seller.householdId] : null;
  const payee = sellerHousehold ? `household:${sellerHousehold.id}` : "town";
  let sharesLeft = preview.subscribedShares;
  let proceeds = 0;
  const buyers = [];
  const households = householdList(state).filter(household => isActiveHousehold(household) && household.id !== sellerHousehold?.id).slice().sort((a, b) =>
    householdShareCapacity(state, b, priceUnits, content) - householdShareCapacity(state, a, priceUnits, content) || a.id.localeCompare(b.id));
  for (const household of households) {
    if (sharesLeft <= 0) break;
    const shares = Math.min(sharesLeft, householdShareCapacity(state, household, priceUnits, content));
    if (shares <= 0) continue;
    const cost = shares * priceUnits;
    const payment = settleMonetaryPayment(state, `household:${household.id}`, payee, currentPaymentComposition(state, cost), content,
      "share_subscription", `${household.name}认购${company.name}股份`,
      { requireFull: true, maxWheatUnits: householdConvertibleWheatUnits(state, household, content, content.rules.shareFoodReserveDays || 90) });
    if (!payment.ok) continue;
    if (sellerHousehold) {
      company.householdShares[sellerHousehold.id] = (company.householdShares[sellerHousehold.id] || 0) - shares;
      if (company.householdShares[sellerHousehold.id] <= 0) delete company.householdShares[sellerHousehold.id];
      sellerHousehold.shares ||= {};
      sellerHousehold.shares[company.id] = Math.max(0, (sellerHousehold.shares[company.id] || 0) - shares);
      if (sellerHousehold.shares[company.id] <= 0) delete sellerHousehold.shares[company.id];
    } else {
      company.townShares -= shares;
      company.residentShares += shares;
    }
    company.householdShares[household.id] = (company.householdShares[household.id] || 0) + shares;
    household.shares ||= {};
    household.shares[company.id] = (household.shares[company.id] || 0) + shares;
    buyers.push({ householdId: household.id, shares, voucherUnits: cost });
    sharesLeft -= shares;
    proceeds += cost;
  }
  const subscribedShares = preview.subscribedShares - sharesLeft;
  if (subscribedShares <= 0) return { ok: false, reason: "没有家庭具备足够的可投资资产", preview };
  company.shareSale.cumulativeProceedsVoucherUnits += proceeds;
  company.shareSale.lastSaleVoucherUnits = proceeds;
  company.shareSale.lastSoldShares = subscribedShares;
  company.shareSale.offeredShares = Math.max(0, company.shareSale.offeredShares - subscribedShares);
  const payeeName = sellerHousehold ? sellerHousehold.name : "镇库";
  recordEvent(state, `居民家庭认购${company.name}${subscribedShares.toLocaleString("zh-CN")}股；售股收入归${payeeName}。`, content, { day: state.day + 1 });
  return { ok: true, ...preview, subscribedShares, proceedsVoucherUnits: proceeds, buyers, sellerOwner: sellerHousehold?.id || "town" };
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
    const manual = Number.isInteger(company.settings?.targetWorkers);
    const desired = manual ? company.settings.targetWorkers : (plannedWorkers == null ? current : plannedWorkers);
    // 正式员工：计划用工每月 1 号审核、一次一人；玩家手设的目标人数立即招，减人仍须满 30 天并付补偿。
    const rate = Number.isFinite(company.settings?.wagePerWorkerDay) ? company.settings.wagePerWorkerDay : (state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 5);
    idle = reviewStaffing(state, content, { jobKey, current: readJobCount(state, jobKey), desired, idle, immediateHire: manual,
      hire: next => setJobCount(state, jobKey, next, content, { type: "company", id: company.id }),
      payer: `company:${company.id}`, dailyWage: rate, book: wageBook(company.payroll ||= {}), reason: `${company.name}辞退补偿`,
      opening: inOpeningPeriod(state, content, company.created),
      losing: (company.history || []).slice(-30).reduce((sum, row) => sum + (row.profitVoucherUnits || 0), 0) < 0 });
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
    const paid = payWages(state, payroll, "company:" + company.id, content, "enterprise_wage_payment", `${company.name}偿付具体债权家庭工资`,
      { payDay: payDayFor(state, `company:${company.id}`) }).paid;
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
  const scale = content.precision.inventoryUnitsPerJin;
  // 弹性配方（动态产品）：先按市场缺口算出本日需要的投入，逐项补足；再按公司实际库存分配（只为分配所需的投入付钱）。
  let flex = null;
  if (recipe.flex) {
    const rooms = flexRoomUnits(state, recipe, content);
    const capacityUnits = planned * recipe.flex.totalJin * scale;
    const want = flexPlan(recipe, rooms, capacityUnits, null, content);
    if (want.totalPoints <= 0) {
      company.status = "市场饱和";
      return { companyId: company.id, status: "market_capped", workers, batches: 0 };
    }
    for (const [itemId, need] of Object.entries(want.inputUnits)) {
      const have = company.inventory[itemId] || 0;
      if (have < need) buyInputForCompany(state, company, itemId, need - have, content);
    }
    const caps = Object.fromEntries(Object.keys(want.inputUnits).map(itemId => [itemId, company.inventory[itemId] || 0]));
    flex = flexPlan(recipe, rooms, capacityUnits, caps, content);
    batches = flex.batchEquiv;
  } else {
    for (const input of recipe.inputs) {
      const perBatch = Math.round(input.quantity * scale);
      const need = perBatch * planned;
      const have = company.inventory[input.itemId] || 0;
      if (have < need) buyInputForCompany(state, company, input.itemId, need - have, content);
      batches = Math.min(batches, Math.floor((company.inventory[input.itemId] || 0) / perBatch));
    }
  }
  if (flex ? flex.totalPoints <= 0 : batches <= 0) {
    company.status = maximumPayableValueUnits(state, "company:" + company.id, content) <= 0 ? "缺资金/原料" : "缺原料";
    return { companyId: company.id, status: maximumPayableValueUnits(state, "company:" + company.id, content) <= 0 ? "no_cash_or_materials" : "no_materials", batches: 0 };
  }
  company.productivityCarry = nextCarry(laborExact, batches, batches >= capacity);
  if (!company.productivityCarry) delete company.productivityCarry;
  // 仅保留为运营统计/旧档兼容：只统计实际生产日；认购与估值不使用此字段。
  company.operatingDays += 1;
  let totalInputCost = 0;
  const inputRows = flex
    ? Object.entries(flex.inputUnits).filter(([, units]) => units > 0).map(([itemId, units]) => ({ itemId, units }))
    : recipe.inputs.map(input => ({ itemId: input.itemId, units: Math.round(input.quantity * batches * scale) }));
  for (const row of inputRows) totalInputCost += removeInventoryWithCost(company, row.itemId, row.units);
  const outputs = flex
    ? recipe.flex.itemIds.filter(itemId => flex.units[itemId] > 0).map(itemId => ({ itemId, units: flex.units[itemId] }))
    : recipe.outputs.map(row => ({ itemId: row.itemId, units: Math.round(row.quantity * batches * scale) }));
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
      // 与民营收购（buyPrivateOutput）同口径：批发市场按收购价买进，不按售价。非统购品收购价为 0，跳过（否则货出库而市场收不进）。
      const price = readWholesalePurchasePrice(state, itemId, content);
      if (!(price > 0)) continue;
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
      "enterprise_wage_debt_settlement", `${company.name}年度结算前偿付工资债务`, { overdueOnly: true });
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

// ---------------------------------------------------------------- 季度分红与除权（docs/STOCK.md）

// 分红日：每 shareDividendIntervalDays 天（默认 90，即第 90/180/270/360 天）一次。
export function isDividendDay(state, content) {
  const interval = content.rules.shareDividendIntervalDays || 90;
  return interval > 0 && (state.day + 1) % interval === 0;
}

// 除权后业绩锚的下移额（每股，单位内部粮券）：除权日整额，之后按线性回升到 0（rules.shareExRightsRecoverDays，默认 90 天）。
// 业绩锚来自利润，分红只是把现金搬走，利润不变；不下移锚，股价会被均值回归“补回”分红，等于重复计价。
export function exRightsOffsetUnits(market, absDay, content) {
  const ex = market?.exRights;
  if (!ex || !(ex.offsetUnits > 0)) return 0;
  const days = Math.max(1, content.rules.shareExRightsRecoverDays || 90);
  const elapsed = absDay - ex.startAbsDay;
  if (elapsed >= days) return 0;
  return Math.round(ex.offsetUnits * (1 - Math.max(0, elapsed) / days));
}

// 每季分红：近一季（分红间隔内）净利润 × 分红比例，封顶于未分配利润与可自由支配现金（扣工作营运资金），按持股比例入账。
// 付款：居民户（enterprise_dividend）、社保基金（recordFundDividend）、镇库（townShares）。分红后股价按每股分红额下调（≥1 档，不受单日涨跌幅限制），业绩锚同额下移并逐日回升。
// 欠薪中的公司不分红；本季没有利润或可分配额不足一股时不分红（不记除权）。
export function payListedDividends(state, content) {
  if (!isDividendDay(state, content)) return [];
  const absDay = (state.year - 1) * (content.rules.daysPerYear || 365) + state.day;
  const rows = [];
  for (const company of Object.values(state.companies || {})) {
    if (!company.listing?.listed || !(company.totalShares > 0)) continue;
    const row = payCompanyDividend(state, company, content, absDay);
    if (row) rows.push({ companyId: company.id, ...row });
  }
  return rows;
}

function payCompanyDividend(state, company, content, absDay) {
  ensureCompanyBooks(company);
  if ((company.payroll?.arrearsVoucherUnits || 0) > 0) return null;
  const owner = "company:" + company.id;
  const interval = content.rules.shareDividendIntervalDays || 90;
  const quarter = companyActualProfitValuation(state, company, content, interval);
  const profitUnits = Math.max(0, quarter.actualProfitVoucherUnits || 0);
  const payoutPercent = companyPayoutPercent(company, content);
  const targetUnits = Math.floor(profitUnits * payoutPercent / 100);
  if (targetUnits <= 0) return null;
  const retainedUnits = Math.max(0, company.retainedEarningsVoucherUnits || 0);
  const reserveUnits = companyWorkingCapitalReserve(company, state, content);
  const freeCashUnits = Math.max(0, maximumPayableValueUnits(state, owner, content) - reserveUnits);
  let distributable = Math.min(targetUnits, retainedUnits, freeCashUnits);
  distributable = maximumFullyPayableValueUnits(state, owner, distributable, content);
  const perShareUnits = Math.floor(distributable / company.totalShares);
  if (perShareUnits <= 0) return null;
  const label = `${company.name}第${state.year}年${state.day + 1}日季度分红`;
  let residentUnits = 0;
  for (const [householdId, shares] of Object.entries(company.householdShares || {})) {
    const amount = perShareUnits * Math.max(0, shares || 0);
    if (amount <= 0) continue;
    const result = settleMonetaryPayment(state, owner, `household:${householdId}`, currentPaymentComposition(state, amount), content,
      "enterprise_dividend", label, { requireFull: true });
    if (!result.ok) throw new Error("企业季度分红转账失败");
    residentUnits += amount;
  }
  let fundUnits = 0;
  if ((company.fundShares || 0) > 0) {
    const amount = perShareUnits * company.fundShares;
    const result = settleMonetaryPayment(state, owner, "social", currentPaymentComposition(state, amount), content,
      "enterprise_dividend", label, { requireFull: true });
    if (!result.ok) throw new Error("企业社保基金季度分红转账失败");
    recordFundDividend(state, amount);
    fundUnits = amount;
  }
  let townUnits = 0;
  if ((company.townShares || 0) > 0) {
    const amount = perShareUnits * company.townShares;
    const result = settleMonetaryPayment(state, owner, "town", currentPaymentComposition(state, amount), content,
      "enterprise_dividend", label, { requireFull: true });
    if (!result.ok) throw new Error("企业镇库季度分红转账失败");
    townUnits = amount;
  }
  const paidUnits = residentUnits + fundUnits + townUnits;
  company.retainedEarningsVoucherUnits = (company.retainedEarningsVoucherUnits || 0) - paidUnits;
  // 除权：股价下调一股分红额（至少一档），业绩锚同额下移（叠加尚未回升的旧余额）。
  const tick = shareTick(content);
  const dropUnits = Math.max(tick, roundToShareTick(perShareUnits, content));
  const market = company.stockMarket ||= { regime: "normal", daysLeft: 0, drift: 0, momentum: 0, anchorUnits: company.sharePriceVoucherUnits || tick };
  const remainingOffset = exRightsOffsetUnits(market, absDay, content);
  market.exRights = { offsetUnits: remainingOffset + dropUnits, startAbsDay: absDay };
  const priceBefore = roundToShareTick(company.sharePriceVoucherUnits || 0, content);
  company.sharePriceVoucherUnits = Math.max(tick, priceBefore - dropUnits);
  const row = {
    year: state.year, day: state.day + 1, payoutPercent, profitVoucherUnits: profitUnits, targetVoucherUnits: targetUnits,
    capped: distributable < targetUnits, totalVoucherUnits: paidUnits, perShareVoucherUnits: perShareUnits,
    residentVoucherUnits: residentUnits, fundVoucherUnits: fundUnits, townVoucherUnits: townUnits,
    exDropVoucherUnits: dropUnits, priceBeforeVoucherUnits: priceBefore, priceAfterVoucherUnits: company.sharePriceVoucherUnits
  };
  company.quarterlyDividends ||= [];
  company.quarterlyDividends.push(row);
  if (company.quarterlyDividends.length > 8) company.quarterlyDividends.splice(0, company.quarterlyDividends.length - 8);
  recordEvent(state, `${company.name}（${company.listing.ticker || "---"}）分红每股${(perShareUnits / currencyScale(content)).toFixed(2)}粮券，股价除权下调${(dropUnits / currencyScale(content)).toFixed(2)}粮券。`, content, { day: state.day + 1 });
  return row;
}

export function companyActualProfitValuation(state, company, content, horizonDays = null) {
  const horizon = horizonDays || content.rules.operatingRightValuationDays || 365;
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

// 股票合理总价 = 年化净利润 ÷ 合理利润率（rules.stockFairYieldPercent，默认 4%，即市盈率 25）。没有有效业绩时为 0。
export function stockFairValueUnits(performance, content) {
  const yieldPercent = Math.max(0.1, Number(content.rules.stockFairYieldPercent) || 4);
  return performance.validProfitMethod ? Math.max(0, Math.round(performance.annualizedProfitVoucherUnits * 100 / yieldPercent)) : 0;
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
  const actualPerformance = companyActualProfitValuation(state, company, content, content.rules.stockProfitWindowDays);
  const annualizedProfitUnits = actualPerformance.annualizedProfitVoucherUnits;
  const epsUnits = company.totalShares > 0 ? annualizedProfitUnits / company.totalShares : 0;
  const sharePrice = company.shareSale?.sharePriceVoucherUnits || 0;
  const referenceYield = sharePrice > 0 ? Math.max(0, epsUnits) / sharePrice : 0;
  const lastDividend = (company.quarterlyDividends || []).at(-1) || null;
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
    payoutPercent: companyPayoutPercent(company, content),
    payoutControllable: townControlsCompany(company),
    lastDividend: lastDividend ? { year: lastDividend.year, day: lastDividend.day, perShareVoucher: lastDividend.perShareVoucherUnits / scale, totalVoucher: lastDividend.totalVoucherUnits / scale, exDropVoucher: lastDividend.exDropVoucherUnits / scale } : null,
    dividendYieldPercent: (company.sharePriceVoucherUnits || 0) > 0 && lastDividend ? (lastDividend.perShareVoucherUnits * (content.rules.daysPerYear / (content.rules.shareDividendIntervalDays || 90))) / company.sharePriceVoucherUnits * 100 : 0,
    townSharePercent: company.totalShares ? company.townShares / company.totalShares : 0,
    residentSharePercent: company.totalShares ? company.residentShares / company.totalShares : 0
  };
}
