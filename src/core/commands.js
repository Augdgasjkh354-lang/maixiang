import { assignWorkers } from "../systems/employment.js";
import { startConstruction, setProjectWorkers as setProjectWorkersSystem } from "../systems/construction.js";
import { payManualRelief, setAutomaticRelief } from "../systems/finance.js";
import { demolishBuilding, startBuildingUpgrade } from "../systems/building-development.js";
import { sellOperatingLevel as sellOperatingLevelSystem } from "../systems/operating-rights.js";
import { issueTownVouchers, issueVouchersFromWheat, redeemVouchersForWheat, currencyScale } from "../economy/currency.js";
import { startMonetaryReform } from "../economy/payment.js";
import {
  createIndependentCompany, executeShareSubscription, injectCompanyCapital,
  setCompanyDividendPercent, setIntermediatePrice, setShareOffer, setCompanyWage, setCompanyTargetWorkers, setCompanySalePrice,
  addCompanyLevel, removeCompanyLevel, liquidateCompanyToTown
} from "../systems/companies.js";
import { listCompanyOnExchange, configureListedShareOffer, executeTownBuyback } from "../systems/stock-exchange.js";
import { setCurrentUnitPrice, applyRecommendedIndustryPrices, keepExistingIndustryPrices } from "../economy/prices.js";
import { setPublicProcurementIntent as setPublicProcurementIntentSystem, clearPublicProcurementIntent as clearPublicProcurementIntentSystem } from "../systems/public-procurement.js";
import { openShop, setShopMerchants, setShopClerks, closeShop, fundShopLiquidation } from "../systems/shops.js";
import { setWholesalePrice, setWholesaleTownAllocation, setWholesalePurchasePrice, stockpileWholesale as stockpileWholesaleSystem, releaseWholesale as releaseWholesaleSystem } from "../systems/wholesale-market.js";
import { setShopTargetMarginPercent, setAllShopsTargetMarginPercent, setShopRetailPrice } from "../systems/shop-pricing.js";
import { setBuildingOutputTarget } from "../systems/production.js";
import { setServiceUnitPrice } from "../systems/services.js";
import { reclaimFarmland as reclaimFarmlandSystem } from "../systems/agriculture.js";
import { setVillaPolicy as setVillaPolicySystem } from "../systems/villas.js";
import { setBankPolicy as setBankPolicySystem } from "../systems/bank.js";
import { issueGovernmentBond as issueGovernmentBondSystem } from "../systems/bonds.js";
import { setWageControlPolicy as setWageControlPolicySystem } from "../systems/payroll.js";
import { setSocialSecurityPolicy as setSocialSecurityPolicySystem, injectSocialSecurity as injectSocialSecuritySystem, repaySocialSecurityDebt as repaySocialSecurityDebtSystem, fundBuyShares, fundSellShares } from "../systems/social-security.js";
import { setTradeTariffRate as setTradeTariffRateSystem, tradeWithOutsideTown as tradeWithOutsideTownSystem, issueWheatLoan as issueWheatLoanSystem } from "../systems/outside-town.js";
import { signTradeAgreement as signTradeAgreementSystem, terminateTradeAgreement as terminateTradeAgreementSystem } from "../systems/trade-agreements.js";

export function setWageRate(state, roleId, dailyJin, content) {
  const value = Number(dailyJin);
  const rows = Object.values(content.roles).some(role => role.id === roleId) ||
    Object.values(content.buildings).some(definition =>
      definition.jobs.some(job => job.id === roleId));
  if (!rows) return { ok: false, reason: "未知工种" };
  if (roleId === "farmers") return { ok: false, reason: "农民按收成分粮，不另发镇库日薪" };
  if (!Number.isFinite(value) || value < 0 || value > 100000) {
    return { ok: false, reason: "日薪须为有限的非负数" };
  }
  state.employment.wageRates[roleId] = value;
  return { ok: true, roleId, dailyJin: value };
}

export function setBreadPrice(state, wheatPerBreadJin, content) {
  const value = Number(wheatPerBreadJin);
  if (!Number.isFinite(value) || value <= 0 || value > 1000000) {
    return { ok: false, reason: "售价须为正的有限数值" };
  }
  return setCurrentUnitPrice(state, "bread", value, content);
}

export function setUnemploymentPolicy(state, patch) {
  const enabled = patch.enabled === undefined
    ? state.policy.unemploymentBenefit.enabled
    : Boolean(patch.enabled);
  const amount = patch.dailyPerWorkerJin === undefined
    ? state.policy.unemploymentBenefit.dailyPerWorkerJin
    : Number(patch.dailyPerWorkerJin);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) {
    return { ok: false, reason: "每日失业金须为有限的非负数" };
  }
  state.policy.unemploymentBenefit = { enabled, dailyPerWorkerJin: amount };
  return { ok: true, ...state.policy.unemploymentBenefit };
}

export function setVillaPolicy(state, patch) {
  return setVillaPolicySystem(state, patch || {});
}

export function setBankPolicy(state, patch) {
  return setBankPolicySystem(state, patch || {});
}

export function issueGovernmentBond(state, options, content) {
  return issueGovernmentBondSystem(state, options || {}, content);
}

export function setWageControl(state, patch) {
  return setWageControlPolicySystem(state, patch || {});
}

export function setSocialSecurityPolicy(state, patch) {
  return setSocialSecurityPolicySystem(state, patch || {});
}

export function setTradeTariffRate(state, percent) {
  return setTradeTariffRateSystem(state, percent);
}

export function tradeWithOutsideTown(state, direction, itemId, quantityJin, content) {
  return tradeWithOutsideTownSystem(state, direction, itemId, quantityJin, content);
}

export function issueWheatLoan(state, principalJin, annualRatePercent, content) {
  return issueWheatLoanSystem(state, principalJin, annualRatePercent, content);
}

// 长期贸易协定（民镇）：外贸房在岗才能签约；主动解约收违约金。
export function signTradeAgreement(state, options, content) {
  return signTradeAgreementSystem(state, { ...(options || {}), content });
}

export function terminateTradeAgreement(state, id, content) {
  return terminateTradeAgreementSystem(state, id, content);
}

export function injectSocialSecurity(state, amountJin, content) {
  return injectSocialSecuritySystem(state, amountJin, content);
}

export function repaySocialSecurityDebt(state, amountJin, content) {
  return repaySocialSecurityDebtSystem(state, amountJin, content);
}

export function socialBuyShares(state, companyId, shares, content) {
  return fundBuyShares(state, companyId, shares, content);
}

export function socialSellShares(state, companyId, shares, content) {
  return fundSellShares(state, companyId, shares, content);
}

export function setAgricultureTax(state, percent) {
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > 80) return { ok: false, reason: "农业税率须为0%—80%" };
  state.policy.agricultureTaxPercent = Math.round(value * 100) / 100;
  return { ok: true, value: state.policy.agricultureTaxPercent };
}

export function setAutosaveMonths(state, months) {
  const value = Number(months);
  if (![1, 3, 6].includes(value)) return { ok: false, reason: "自动存档频率只能是每月、每3月或每半年" };
  state.policy.autosaveMonths = value;
  return { ok: true, value };
}

export function setPrivateProductionTax(state, typeId, percent, content) {
  if (!["mill", "bakery", "lumberyard", "saltworks"].includes(typeId) || !content.buildings[typeId]) {
    return { ok: false, reason: "该产业不开放民营生产税设置" };
  }
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > 80) return { ok: false, reason: "民营生产税率须为0%—80%" };
  state.policy.privateProductionTaxPercent[typeId] = Math.round(value * 100) / 100;
  return { ok: true, typeId, value: state.policy.privateProductionTaxPercent[typeId] };
}

export function setOperatingRightPrice(state, buildingId, priceWheatJin) {
  const value = Number(priceWheatJin);
  if (!Number.isFinite(value) || value <= 0 || value > 1e9) return { ok: false, reason: "经营权售价须为正的有限数值" };
  state.market.operatingRightPrices[buildingId] = Math.round(value * 3000);
  return { ok: true, buildingId, priceWheatJin: state.market.operatingRightPrices[buildingId] / 3000 };
}

export function transferFood(state, amountJin, content) {
  return payManualRelief(state, amountJin, content);
}

export function setEmployment(state, jobKey, count, content) {
  return assignWorkers(state, jobKey, count, content);
}

export function buildAt(state, typeId, plotId, content, options) {
  return startConstruction(state, typeId, plotId, content, options);
}

export function upgradeBuilding(state, buildingId, content, options) {
  return startBuildingUpgrade(state, buildingId, content, options);
}

// 调整某个在建工程的投入建筑工人数；减少的人回归待业，增加的人受全镇待业余量约束。
export function setProjectWorkers(state, projectId, workers, content) {
  return setProjectWorkersSystem(state, projectId, workers, content);
}

export function demolishAt(state, buildingId, content) {
  return demolishBuilding(state, buildingId, content);
}

export function sellOperatingLevel(state, buildingId, content) {
  return sellOperatingLevelSystem(state, buildingId, content);
}

export function sendRelief(state, amountJin, content) {
  return payManualRelief(state, amountJin, content);
}

export function toggleAutomaticRelief(state, enabled) {
  return setAutomaticRelief(state, enabled);
}


export function issueGrainVouchers(state, owner, amountVoucher, content) {
  if (owner === "town") {
    const voucherUnits = Math.round(Number(amountVoucher) * currencyScale(content));
    if (!Number.isSafeInteger(voucherUnits) || voucherUnits <= 0) return { ok: false, reason: "发行数量必须大于0" };
    return issueTownVouchers(state, voucherUnits, content);
  }
  const wheatUnits = Math.round(Number(amountVoucher) * content.precision.inventoryUnitsPerJin);
  if (!Number.isSafeInteger(wheatUnits) || wheatUnits <= 0) return { ok: false, reason: "换券数量必须大于0" };
  return issueVouchersFromWheat(state, owner, wheatUnits, content);
}

export function redeemGrainVouchers(state, owner, amountVoucher, content) {
  const units = Math.round(Number(amountVoucher) * currencyScale(content));
  if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, reason: "兑换数量必须大于0" };
  return redeemVouchersForWheat(state, owner, units, content);
}

export function createCompany(state, buildingId, options, content) {
  return createIndependentCompany(state, buildingId, options, content);
}

// 旧内部命令名保留，但语义自0.1.7起为“成立公司”，不会自动上市。
export function listCompany(state, buildingId, options, content) {
  return createIndependentCompany(state, buildingId, options, content);
}

export function listCompanyShares(state, companyId, options, content) {
  return listCompanyOnExchange(state, companyId, options, content);
}

export function configureShareOffer(state, companyId, shares, price, content) {
  return configureListedShareOffer(state, companyId, shares, price, content);
}

export function subscribeShares(state, companyId, content) {
  return executeShareSubscription(state, companyId, content);
}

export function addCompanyCapital(state, companyId, amount, content) {
  return injectCompanyCapital(state, companyId, amount, content);
}

export function configureCompanyWage(state, companyId, value, content) { return setCompanyWage(state, companyId, value, content); }
export function configureCompanyTargetWorkers(state, companyId, value, content) { return setCompanyTargetWorkers(state, companyId, value, content); }
export function configureCompanySalePrice(state, companyId, itemId, value, content) { return setCompanySalePrice(state, companyId, itemId, value, content); }
export function addCompanyOperatingLevel(state, companyId, content) { return addCompanyLevel(state, companyId, content); }
export function removeCompanyOperatingLevel(state, companyId, content) { return removeCompanyLevel(state, companyId, content); }
export function liquidateCompany(state, companyId, content) { return liquidateCompanyToTown(state, companyId, content); }
export function buybackCompanyShares(state, companyId, options, content) { return executeTownBuyback(state, companyId, options, content); }

export function configureDividend(state, companyId, percent) {
  return setCompanyDividendPercent(state, companyId, percent);
}

export function configureIntermediatePrice(state, itemId, price, content) {
  return setIntermediatePrice(state, itemId, price, content);
}

export function setPublicProcurementIntent(state, intent, content) {
  return setPublicProcurementIntentSystem(state, intent, content);
}

export function clearPublicProcurementIntent(state, itemId) {
  return clearPublicProcurementIntentSystem(state, itemId);
}

export function adoptRecommendedIndustryPrices(state, content) {
  return applyRecommendedIndustryPrices(state, content);
}

export function retainExistingIndustryPrices(state, content) {
  return keepExistingIndustryPrices(state, content);
}

export function setEmploymentExchangeQuota(state, jin, content) {
  const value = Number(jin);
  if (!Number.isFinite(value) || value < (content.rules.employmentExchangeMinimumJin ?? 0) || value > (content.rules.employmentExchangeMaximumJin ?? 10)) {
    return { ok: false, reason: "每日换券额度须为0—10斤" };
  }
  state.policy.employmentExchangeJin = Math.round(value * 100) / 100;
  return { ok: true, value: state.policy.employmentExchangeJin };
}

export function setShopRent(state, voucher) {
  const value = Number(voucher);
  if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "店租须为非负数" };
  state.policy.shopRentVoucher = Math.round(value * 100) / 100;
  return { ok: true, value: state.policy.shopRentVoucher };
}

export function setShopProfitTax(state, percent, content) {
  const value = Number(percent);
  const max = content.rules.shopProfitTaxMaximumPercent ?? 80;
  if (!Number.isFinite(value) || value < 0 || value > max) return { ok: false, reason: `商业利润税须为0%—${max}%` };
  state.policy.shopProfitTaxPercent = Math.round(value * 100) / 100;
  return { ok: true, value: state.policy.shopProfitTaxPercent };
}

export function openResidentShop(state, buildingId, typeId, householdId, content) {
  return openShop(state, buildingId, typeId, content, householdId || null);
}

export function configureShopMerchants(state, shopId, count, content) {
  return setShopMerchants(state, shopId, count, content);
}

export function configureShopClerks(state, shopId, count, content) {
  return setShopClerks(state, shopId, count, content);
}

export function closeResidentShop(state, shopId, content) {
  return closeShop(state, shopId, content, false);
}

export function fundResidentShopLiquidation(state, shopId, content) {
  return fundShopLiquidation(state, shopId, content);
}


export function configureWholesalePrice(state, itemId, value, content) {
  return setWholesalePrice(state, itemId, value, content);
}

// 0.2.3 流通改革：批发市场做市商——收购价独立可调（售价沿用 configureWholesalePrice）。
export function configureWholesalePurchasePrice(state, itemId, value, content) {
  return setWholesalePurchasePrice(state, itemId, value, content);
}

// 0.2.3 综合商店动态加价：单店或全镇统一设置目标利润率（0~100%）。
export function configureShopTargetMargin(state, shopId, percent, content) {
  return setShopTargetMarginPercent(state, shopId, percent, content);
}

export function configureAllShopsTargetMargin(state, percent, content) {
  return setAllShopsTargetMarginPercent(state, percent, content);
}

// 0.2.3：直接指定某综合商店某商品的零售价（下限不低于进货价）。
export function configureShopRetailPrice(state, shopId, itemId, value, content) {
  return setShopRetailPrice(state, shopId, itemId, value, content);
}

export function configureWholesaleTownAllocation(state, itemId, quantity, content) {
  return setWholesaleTownAllocation(state, itemId, quantity, content);
}

// 用户 0.1.11：批发市场单次调运——收储（批发市场→镇库）/投放（镇库→批发市场），用来平抑库存。
export function stockpileWholesale(state, itemId, quantityJin, content) {
  return stockpileWholesaleSystem(state, itemId, quantityJin, content);
}

export function releaseWholesale(state, itemId, quantityJin, content) {
  return releaseWholesaleSystem(state, itemId, quantityJin, content);
}

// 用户 0.1.11：镇营建筑目标日产量。
export function setOutputTarget(state, buildingId, quantityJin, content) {
  return setBuildingOutputTarget(state, buildingId, quantityJin, content);
}

export function configureServicePrice(state, serviceId, value, content) {
  return setServiceUnitPrice(state, serviceId, value, content);
}

export function startCurrencyReform(state, content) { return startMonetaryReform(state, content); }

// 开荒：亩数与投入人数由面板输入，成本按内容比例换算，工资由镇库承担并记账。
export function reclaimFarmland(state, acres, workers, content) {
  return reclaimFarmlandSystem(state, content, { acres, workers });
}
