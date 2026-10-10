import { assignWorkers } from "../systems/employment.js";
import { isIndustryType } from "../content/buildings.js";
import { startConstruction, setProjectWorkers as setProjectWorkersSystem } from "../systems/construction.js";
import { setAutomaticRelief } from "../systems/finance.js";
import { demolishBuilding, startBuildingUpgrade } from "../systems/building-development.js";
import { sellBuildingToPrivate, buyBuildingBackFromPrivate, sellOperatingLevel as sellOperatingLevelSystem } from "../systems/operating-rights.js";
import { issueTownVouchers, issueVouchersFromWheat, redeemVouchersForWheat, currencyScale } from "../economy/currency.js";
import { startMonetaryReform } from "../economy/payment.js";
import {
  executeShareSubscription, injectCompanyCapital,
  setCompanyDividendPercent, setIntermediatePrice, setShareOffer, setCompanyWage, setCompanyTargetWorkers, setCompanySalePrice,
  addCompanyLevel, removeCompanyLevel, liquidateCompanyToTown
} from "../systems/companies.js";
import { listCompanyOnExchange, configureListedShareOffer, executeTownBuyback } from "../systems/stock-exchange.js";
import { listBuilding as listBuildingSystem, approveIpoApplication as approveIpoApplicationSystem, rejectIpoApplication as rejectIpoApplicationSystem } from "../systems/ipo.js";
import { setCurrentUnitPrice, applyRecommendedIndustryPrices, keepExistingIndustryPrices } from "../economy/prices.js";
import { setPublicProcurementIntent as setPublicProcurementIntentSystem, clearPublicProcurementIntent as clearPublicProcurementIntentSystem } from "../systems/public-procurement.js";
import { openShop, openTownShop as openTownShopSystem, setShopMerchants, setShopClerks, closeShop, fundShopLiquidation } from "../systems/shops.js";
import { setWholesalePrice, setWholesaleTownAllocation, setWholesalePurchasePrice, setWholesaleAutoPricing, stockpileWholesale as stockpileWholesaleSystem, releaseWholesale as releaseWholesaleSystem } from "../systems/wholesale-market.js";
import { setShopTargetMarginPercent, setAllShopsTargetMarginPercent, setShopRetailPrice, isDynamicPricingShop } from "../systems/shop-pricing.js";
import { MARGIN_POLICY_MAX_PERCENT, pinGlideBeforeChange, policyShopMarginPercent, policyTradeMarginPercent, shopOverrideMarginPercent } from "../economy/margin-policy.js";
import { setBuildingOutputTarget } from "../systems/production.js";
import { setServiceUnitPrice } from "../systems/services.js";
import { reclaimFarmland as reclaimFarmlandSystem } from "../systems/agriculture.js";
import { setVillaPolicy as setVillaPolicySystem } from "../systems/villas.js";
import { setBankPolicy as setBankPolicySystem, repayBankDebtToTown as repayBankDebtToTownSystem } from "../systems/bank.js";
import { issueGovernmentBond as issueGovernmentBondSystem } from "../systems/bonds.js";
import { setWageControlPolicy as setWageControlPolicySystem } from "../systems/payroll.js";
import { setSocialSecurityPolicy as setSocialSecurityPolicySystem, injectSocialSecurity as injectSocialSecuritySystem, repaySocialSecurityDebt as repaySocialSecurityDebtSystem, fundBuyShares, fundSellShares, setEmployerSocialSharePercent as setEmployerSocialSharePercentSystem } from "../systems/social-security.js";
import { tradeWithOutsideTown as tradeWithOutsideTownSystem, issueWheatLoan as issueWheatLoanSystem } from "../systems/outside-town.js";
import { signTradeAgreement as signTradeAgreementSystem, terminateTradeAgreement as terminateTradeAgreementSystem } from "../systems/trade-agreements.js";
import { setWealthTaxPolicy, setInheritanceTaxPolicy } from "../systems/redistribution.js";

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

// 雇主替员工缴社保的比例（0—100%，默认 100）。
export function setEmployerSocialSharePercent(state, percent) {
  return setEmployerSocialSharePercentSystem(state, percent);
}

export function setSocialSecurityPolicy(state, patch) {
  return setSocialSecurityPolicySystem(state, patch || {});
}

export function tradeWithOutsideTown(state, direction, itemId, quantityJin, content, townId) {
  return tradeWithOutsideTownSystem(state, direction, itemId, quantityJin, content, townId);
}

export function issueWheatLoan(state, principalJin, annualRatePercent, content, townId) {
  return issueWheatLoanSystem(state, principalJin, annualRatePercent, content, townId);
}

// 长期贸易协定：外贸房在岗才能签约；主动解约收违约金。
export function signTradeAgreement(state, options, content) {
  return signTradeAgreementSystem(state, { ...(options || {}), content });
}

export function terminateTradeAgreement(state, id, content) {
  return terminateTradeAgreementSystem(state, id, content);
}

export function repayBankDebtToTown(state, amountJin, content) {
  return repayBankDebtToTownSystem(state, amountJin, content);
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

// 再分配政策（docs/REDISTRIBUTION.md）：富人税门槛与税率、遗产税率。
export function setWealthTax(state, patch) {
  return setWealthTaxPolicy(state, patch || {});
}

export function setInheritanceTax(state, percent) {
  return setInheritanceTaxPolicy(state, percent);
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
  if (!isIndustryType(content, typeId)) {
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

// 整栋卖给民营（要价 options.priceVoucher 可省，默认用预览价）。
export function sellBuildingToPrivateCommand(state, buildingId, options, content) {
  return sellBuildingToPrivate(state, buildingId, options, content);
}

// 镇里按估值回购民营整栋。
export function buyBuildingBackFromPrivateCommand(state, buildingId, content) {
  return buyBuildingBackFromPrivate(state, buildingId, content);
}

// 旧命令名：等同整栋出售（旧版按级出售已废止）。
export function sellOperatingLevel(state, buildingId, content) {
  return sellOperatingLevelSystem(state, buildingId, content);
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

// 已取消单独成立公司（docs/OWNERSHIP.md 第 2 条）：整栋上市一步完成。旧命令名保留，只返回原因。
const FOUNDING_REMOVED_REASON = "已取消单独成立公司：请直接整栋上市";
export function createCompany(state, buildingId, options, content) {
  return { ok: false, reason: FOUNDING_REMOVED_REASON };
}

export function listCompany(state, buildingId, options, content) {
  return { ok: false, reason: FOUNDING_REMOVED_REASON };
}

// 整栋上市（建筑现主人 → 新公司 → 交易所挂牌，一步完成）。
export function listBuilding(state, buildingId, options, content) {
  return listBuildingSystem(state, buildingId, options, content);
}

// 镇长批准 / 驳回民营业主的上市申请。
export function approveIpoApplication(state, buildingId, options, content) {
  return approveIpoApplicationSystem(state, buildingId, options, content);
}

export function rejectIpoApplication(state, buildingId, content) {
  return rejectIpoApplicationSystem(state, buildingId, content);
}

// 老公司（整栋已在公司名下、尚未上市，多见于旧存档）挂牌。
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
  const minimum = content.rules.employmentExchangeMinimumJin ?? 0;
  const maximum = content.rules.employmentExchangeMaximumJin ?? 50;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    return { ok: false, reason: `每日换券额度须为${minimum}—${maximum}斤` };
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

export function setStallRent(state, voucher) {
  const value = Number(voucher);
  if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "摊租须为非负数" };
  state.policy.stallRentVoucher = Math.round(value * 100) / 100;
  return { ok: true, value: state.policy.stallRentVoucher };
}

// 集市免租：days 为 0 取消，否则必须是规则里的选项（三个月/半年/一年/三年），从今天起算。
export function setStallRentFree(state, days, content) {
  const value = Math.floor(Number(days));
  const options = content.rules.stallRentFreeOptionsDays || [];
  if (value !== 0 && !options.includes(value)) return { ok: false, reason: "免租时长只能是三个月、半年、一年或三年" };
  const serial = (Math.max(1, state.year || 1) - 1) * content.rules.daysPerYear + (state.day || 0);
  state.policy.stallRentFreeUntilSerial = value === 0 ? 0 : serial + value;
  return { ok: true, days: value };
}

export function setStallDiscountTier(state, tier, content) {
  const value = Math.floor(Number(tier));
  const max = (content.rules.stallWholesaleDiscountTiers || [0]).length - 1;
  if (!Number.isFinite(value) || value < 0 || value > max) return { ok: false, reason: `特价等级须为0—${max}` };
  state.policy.stallDiscountTier = value;
  return { ok: true, tier: value };
}

export function setStallKeeperLimit(state, people) {
  const value = Math.floor(Number(people));
  if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "允许摆摊人数须为非负整数" };
  state.policy.stallKeeperLimit = value;
  return { ok: true, value };
}

export function setShopProfitTax(state, percent, content) {
  const value = Number(percent);
  const max = content.rules.shopProfitTaxMaximumPercent ?? 80;
  if (!Number.isFinite(value) || value < 0 || value > max) return { ok: false, reason: `商业利润税须为0%—${max}%` };
  state.policy.shopProfitTaxPercent = Math.round(value * 100) / 100;
  return { ok: true, value: state.policy.shopProfitTaxPercent };
}

// 进出口关税：patch = { importPercent?, exportPercent? }，0—tradeTariffMaximumPercent。
export function setTradeTariff(state, patch, content) {
  const max = content.rules.tradeTariffMaximumPercent ?? 50;
  const tariff = { importPercent: 0, exportPercent: 0, ...(state.policy.tradeTariff || {}) };
  for (const key of ["importPercent", "exportPercent"]) {
    if (patch?.[key] === undefined) continue;
    const value = Number(patch[key]);
    if (!Number.isFinite(value) || value < 0 || value > max) return { ok: false, reason: `关税须为0%—${max}%` };
    tariff[key] = Math.round(value * 100) / 100;
  }
  state.policy.tradeTariff = tariff;
  return { ok: true, value: { ...tariff } };
}

// 利润率政策：patch = { shopMarginPercent?, tradeMarginPercent?, tradeImportMarginPercent? }，0—200，一位小数。
// 综合商店全局目标变了：先把未单独设置的店当前生效的目标记下（pinGlideBeforeChange），再写政策；
// 之后各店按 7 天复核平滑追上新目标，不跳价。单店覆盖不受影响。
export function setMarginPolicy(state, patch, content) {
  const keys = ["shopMarginPercent", "tradeMarginPercent", "tradeImportMarginPercent"];
  const next = {};
  for (const key of keys) {
    const raw = patch?.[key];
    if (raw === undefined) continue;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) return { ok: false, reason: "利润率须为0—200%之间的有限数" };
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > MARGIN_POLICY_MAX_PERCENT) return { ok: false, reason: "利润率须为0—200%之间的有限数" };
    next[key] = Math.round(value * 10) / 10;
  }
  if (next.shopMarginPercent !== undefined && next.shopMarginPercent !== policyShopMarginPercent(state, content)) {
    for (const shop of Object.values(state.shops || {})) {
      if (!isDynamicPricingShop(shop, content) || shopOverrideMarginPercent(shop) !== null) continue;
      pinGlideBeforeChange(state, shop, content);
      shop.pricing.lastReviewSerial = -1;
    }
  }
  state.policy ||= {};
  for (const key of keys) {
    if (next[key] !== undefined) state.policy[key] = next[key];
  }
  return { ok: true, value: {
    shopMarginPercent: policyShopMarginPercent(state, content),
    tradeMarginPercent: policyTradeMarginPercent(state, content, "export"),
    tradeImportMarginPercent: policyTradeMarginPercent(state, content, "import")
  } };
}

export function openResidentShop(state, buildingId, typeId, householdId, content) {
  return openShop(state, buildingId, typeId, content, householdId || null);
}

// 镇里在商业街开一家镇营综合商店：镇库持有，店员由镇里设定，收入进镇库（systems/shops.js）。
export function openTownShop(state, buildingId, content) {
  return openTownShopSystem(state, buildingId, content);
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

// 物价会动：批发市场某商品的自动调价开关（默认关；开启时以当前售价为锚定价）。
export function configureWholesaleAutoPricing(state, itemId, enabled, content) {
  return setWholesaleAutoPricing(state, itemId, enabled, content);
}

// 0.2.3 综合商店动态加价：单店或全镇统一设置目标利润率（0~200%；percent 为 null 时取消单店设置，改跟随全局政策）。
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
