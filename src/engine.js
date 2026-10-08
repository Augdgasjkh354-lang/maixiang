import { CONTENT } from "./content/index.js";
import { MODS } from "./mods/registry.js";
import { bindModCommands } from "./mods/api.js";
import { validateContent } from "./content/validate.js";
import { createInitialState } from "./core/state.js";
import { settleOneDay } from "./systems/daily.js";
import {
  advanceGameDays as advanceDaysWithClock
} from "./core/clock.js";
import {
  setEmployment, buildAt, toggleAutomaticRelief,
  setWageRate, setBreadPrice, setUnemploymentPolicy, setVillaPolicy, setWageControl,
  setBankPolicy, issueGovernmentBond,
  setSocialSecurityPolicy, injectSocialSecurity, repaySocialSecurityDebt, socialBuyShares, socialSellShares, tradeWithOutsideTown, issueWheatLoan, signTradeAgreement, terminateTradeAgreement, setAgricultureTax,
  setPrivateProductionTax, setOperatingRightPrice, upgradeBuilding, demolishAt, setProjectWorkers,
  setAutosaveMonths,
  sellOperatingLevel, issueGrainVouchers, redeemGrainVouchers, listCompany, createCompany, listCompanyShares,
  configureShareOffer, subscribeShares, addCompanyCapital, configureDividend, configureIntermediatePrice,
  configureCompanyWage, configureCompanyTargetWorkers, configureCompanySalePrice, addCompanyOperatingLevel, removeCompanyOperatingLevel, liquidateCompany, buybackCompanyShares,
  setPublicProcurementIntent, clearPublicProcurementIntent, adoptRecommendedIndustryPrices, retainExistingIndustryPrices,
  setEmploymentExchangeQuota, setShopRent, setStallRent, setStallKeeperLimit, setStallRentFree, setStallDiscountTier, setShopProfitTax, openResidentShop, configureShopMerchants, configureShopClerks, closeResidentShop, fundResidentShopLiquidation,
  configureWholesalePrice, configureWholesaleTownAllocation, configureWholesalePurchasePrice, configureWholesaleAutoPricing, configureShopTargetMargin, configureAllShopsTargetMargin, configureShopRetailPrice, stockpileWholesale, releaseWholesale, setOutputTarget, configureServicePrice,
  startCurrencyReform,
  reclaimFarmland
} from "./core/commands.js";
import { selectDemolitionPreview, selectUpgradePreview } from "./systems/building-development.js";
import { validateState } from "./core/validation.js";
import { selectDashboard } from "./selectors/dashboard.js";
import { selectOperatingRightPreview } from "./selectors/operating-rights.js";
import { populationStats, selectJobRows } from "./selectors/labor.js";
import { accountQeqUnits, totalQeqUnits } from "./economy/inventory.js";
import { previewShareSubscription, previewCompanyLevelChange } from "./systems/companies.js";
import { previewTownBuyback } from "./systems/stock-exchange.js";
import { validateCurrencyInvariant } from "./economy/currency.js";

export function createSimulation(content) {
  const definitions = content || CONTENT;
  const check = validateContent(definitions);
  if (!check.valid) throw new Error("模拟内容定义无效：" + check.errors.join("；"));
  return {
    content: definitions,
    // mod 命令：simulation.mods[modId][command](state, ...args)
    mods: bindModCommands(MODS, definitions),
    createInitialState: function (options) {
      return createInitialState({ ...(options || {}), content: definitions });
    },
    advanceDay: function (state) {
      return settleOneDay(state, definitions);
    },
    advanceDays: function (state, days) {
      return advanceDaysWithClock(state, days, function (current) {
        return settleOneDay(current, definitions);
      });
    },
    setEmployment: function (state, jobKey, count) {
      return setEmployment(state, jobKey, count, definitions);
    },
    buildAt: function (state, typeId, plotId, options) {
      return buildAt(state, typeId, plotId, definitions, options);
    },
    upgradeBuilding: function (state, buildingId, options) {
      return upgradeBuilding(state, buildingId, definitions, options);
    },
    setProjectWorkers: function (state, projectId, workers) {
      return setProjectWorkers(state, projectId, workers, definitions);
    },
    demolishBuilding: function (state, buildingId) {
      return demolishAt(state, buildingId, definitions);
    },
    selectUpgradePreview: function (state, buildingId) {
      return selectUpgradePreview(state, buildingId, definitions);
    },
    selectDemolitionPreview: function (state, buildingId) {
      return selectDemolitionPreview(state, buildingId, definitions);
    },
    toggleAutomaticRelief: function (state, enabled) {
      return toggleAutomaticRelief(state, enabled);
    },
    setWageRate: function (state, roleId, dailyJin) {
      return setWageRate(state, roleId, dailyJin, definitions);
    },
    setBreadPrice: function (state, dailyPrice) {
      return setBreadPrice(state, dailyPrice, definitions);
    },
    setUnemploymentPolicy: function (state, patch) {
      return setUnemploymentPolicy(state, patch);
    },
    setVillaPolicy: function (state, patch) {
      return setVillaPolicy(state, patch);
    },
    setBankPolicy: function (state, patch) {
      return setBankPolicy(state, patch);
    },
    setAutosaveMonths: function (state, months) {
      return setAutosaveMonths(state, months);
    },
    issueGovernmentBond: function (state, options) {
      return issueGovernmentBond(state, options, definitions);
    },
    setWageControl: function (state, patch) {
      return setWageControl(state, patch);
    },
    setSocialSecurityPolicy: function (state, patch) {
      return setSocialSecurityPolicy(state, patch);
    },
    injectSocialSecurity: function (state, amountJin) {
      return injectSocialSecurity(state, amountJin, definitions);
    },
    repaySocialSecurityDebt: function (state, amountJin) {
      return repaySocialSecurityDebt(state, amountJin, definitions);
    },
    socialBuyShares: function (state, companyId, shares) {
      return socialBuyShares(state, companyId, shares, definitions);
    },
    socialSellShares: function (state, companyId, shares) {
      return socialSellShares(state, companyId, shares, definitions);
    },
    tradeWithOutsideTown: function (state, direction, itemId, quantityJin, townId) {
      return tradeWithOutsideTown(state, direction, itemId, quantityJin, definitions, townId);
    },
    issueWheatLoan: function (state, principalJin, annualRatePercent, townId) {
      return issueWheatLoan(state, principalJin, annualRatePercent, definitions, townId);
    },
    signTradeAgreement: function (state, options) {
      return signTradeAgreement(state, options, definitions);
    },
    terminateTradeAgreement: function (state, id) {
      return terminateTradeAgreement(state, id, definitions);
    },
    setAgricultureTax: function (state, percent) { return setAgricultureTax(state, percent); },
    setPrivateProductionTax: function (state, typeId, percent) { return setPrivateProductionTax(state, typeId, percent, definitions); },
    setOperatingRightPrice: function (state, buildingId, price) { return setOperatingRightPrice(state, buildingId, price); },
    selectOperatingRightPreview: function (state, buildingId, price) { return selectOperatingRightPreview(state, buildingId, definitions, price); },
    sellOperatingLevel: function (state, buildingId) { return sellOperatingLevel(state, buildingId, definitions); },
    issueGrainVouchers: function (state, owner, amount) { return issueGrainVouchers(state, owner, amount, definitions); },
    redeemGrainVouchers: function (state, owner, amount) { return redeemGrainVouchers(state, owner, amount, definitions); },
    listCompany: function (state, buildingId, options) { return listCompany(state, buildingId, options, definitions); },
    createCompany: function (state, buildingId, options) { return createCompany(state, buildingId, options, definitions); },
    listCompanyShares: function (state, companyId, options) { return listCompanyShares(state, companyId, options, definitions); },
    configureCompanyWage: function (state, companyId, value) { return configureCompanyWage(state, companyId, value, definitions); },
    configureCompanyTargetWorkers: function (state, companyId, value) { return configureCompanyTargetWorkers(state, companyId, value, definitions); },
    configureCompanySalePrice: function (state, companyId, itemId, value) { return configureCompanySalePrice(state, companyId, itemId, value, definitions); },
    addCompanyOperatingLevel: function (state, companyId) { return addCompanyOperatingLevel(state, companyId, definitions); },
    removeCompanyOperatingLevel: function (state, companyId) { return removeCompanyOperatingLevel(state, companyId, definitions); },
    liquidateCompany: function (state, companyId) { return liquidateCompany(state, companyId, definitions); },
    previewTownBuyback: function (state, companyId, options) { return previewTownBuyback(state, companyId, options, definitions); },
    buybackCompanyShares: function (state, companyId, options) { return buybackCompanyShares(state, companyId, options, definitions); },
    previewCompanyLevelChange: function (state, companyId, direction) { return previewCompanyLevelChange(state, companyId, direction, definitions); },
    configureShareOffer: function (state, companyId, shares, price) { return configureShareOffer(state, companyId, shares, price, definitions); },
    previewShareSubscription: function (state, companyId) { return previewShareSubscription(state, companyId, definitions); },
    subscribeShares: function (state, companyId) { return subscribeShares(state, companyId, definitions); },
    addCompanyCapital: function (state, companyId, amount) { return addCompanyCapital(state, companyId, amount, definitions); },
    configureDividend: function (state, companyId, percent) { return configureDividend(state, companyId, percent); },
    configureIntermediatePrice: function (state, itemId, price) { return configureIntermediatePrice(state, itemId, price, definitions); },
    setPublicProcurementIntent: function (state, intent) { return setPublicProcurementIntent(state, intent, definitions); },
    clearPublicProcurementIntent: function (state, itemId) { return clearPublicProcurementIntent(state, itemId); },
    adoptRecommendedIndustryPrices: function (state) { return adoptRecommendedIndustryPrices(state, definitions); },
    retainExistingIndustryPrices: function (state) { return retainExistingIndustryPrices(state, definitions); },
    setEmploymentExchangeQuota: function (state, value) { return setEmploymentExchangeQuota(state, value, definitions); },
    startCurrencyReform: function (state) { return startCurrencyReform(state, definitions); },
    setShopRent: function (state, value) { return setShopRent(state, value); },
    setStallRent: function (state, value) { return setStallRent(state, value); },
    setStallKeeperLimit: function (state, value) { return setStallKeeperLimit(state, value); },
    setStallRentFree: function (state, days) { return setStallRentFree(state, days, definitions); },
    setStallDiscountTier: function (state, tier) { return setStallDiscountTier(state, tier, definitions); },
    setShopProfitTax: function (state, value) { return setShopProfitTax(state, value, definitions); },
    openResidentShop: function (state, buildingId, typeId, householdId) { return openResidentShop(state, buildingId, typeId, householdId, definitions); },
    configureShopMerchants: function (state, shopId, count) { return configureShopMerchants(state, shopId, count, definitions); },
    configureShopClerks: function (state, shopId, count) { return configureShopClerks(state, shopId, count, definitions); },
    closeResidentShop: function (state, shopId) { return closeResidentShop(state, shopId, definitions); },
    fundResidentShopLiquidation: function (state, shopId) { return fundResidentShopLiquidation(state, shopId, definitions); },
    configureWholesalePrice: function (state, itemId, value) { return configureWholesalePrice(state, itemId, value, definitions); },
    // 0.2.3 流通改革：做市商收购价 / 综合商店目标利润率。
    configureWholesalePurchasePrice: function (state, itemId, value) { return configureWholesalePurchasePrice(state, itemId, value, definitions); },
    configureShopTargetMargin: function (state, shopId, percent) { return configureShopTargetMargin(state, shopId, percent, definitions); },
    configureAllShopsTargetMargin: function (state, percent) { return configureAllShopsTargetMargin(state, percent, definitions); },
    configureShopRetailPrice: function (state, shopId, itemId, value) { return configureShopRetailPrice(state, shopId, itemId, value, definitions); },
    // 物价会动：批发市场自动调价开关（默认关；开启时以当前售价为锚定价，玩家手动改价即重置锚定）。
    configureWholesaleAutoPricing: function (state, itemId, enabled) { return configureWholesaleAutoPricing(state, itemId, enabled, definitions); },
    configureWholesaleTownAllocation: function (state, itemId, value) { return configureWholesaleTownAllocation(state, itemId, value, definitions); },
    stockpileWholesale: function (state, itemId, quantityJin) { return stockpileWholesale(state, itemId, quantityJin, definitions); },
    releaseWholesale: function (state, itemId, quantityJin) { return releaseWholesale(state, itemId, quantityJin, definitions); },
    setOutputTarget: function (state, buildingId, quantityJin) { return setOutputTarget(state, buildingId, quantityJin, definitions); },
    configureServicePrice: function (state, serviceId, value) { return configureServicePrice(state, serviceId, value, definitions); },
    reclaimFarmland: function (state, acres, workers) { return reclaimFarmland(state, acres, workers, definitions); },
    validateCurrencyInvariant: function (state) { return validateCurrencyInvariant(state, definitions); },
    selectDashboard: function (state, selection) {
      return selectDashboard(state, definitions, selection);
    },
    validateState: function (state) {
      return validateState(state, definitions);
    },
    populationStats,
    selectJobRows: function (state) {
      return selectJobRows(state, definitions);
    },
    accountQeq: function (state, owner) {
      return accountQeqUnits(state, owner, definitions) / definitions.precision.qeqUnitsPerJin;
    },
    totalQeq: function (state) {
      return totalQeqUnits(state, definitions) / definitions.precision.qeqUnitsPerJin;
    }
  };
}

export const simulation = createSimulation(CONTENT);
export { CONTENT, createInitialState, validateState };
