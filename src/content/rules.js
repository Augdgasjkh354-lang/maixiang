export const SAVE_VERSION = 16;

export const RULES = Object.freeze({
  saveVersion: SAVE_VERSION,
  daysPerYear: 365,
  growingDays: 274,
  foodPerPersonDay: 2,
  housingCapacity: 1000,
  builderSlots: 24,
  dailyDaysPerSecond: 0.45,
  speedChoices: [1, 4, 16],
  automaticReliefTriggerDays: 7,
  automaticReliefTargetDays: 14,
  // 邻里互助（用户 0.1.11）：缺粮 trigger 天先由富户接济，再到 target 天；自动救济随后补缺口。
  maxAge: 105,
  ledgerLimit: 500,
  breadTargetShareAtBasePrice: 0.25,
  breadPriceElasticity: 0.75,
  breadTargetShareMaximum: 0.5,
  // 居民主食需求按固定比例拆分到小麦、面粉、面包。三项之和应为 1，改动后需同步核算口粮当量。
  stapleDemandShares: Object.freeze({ wheat: 0.6, flour: 0.2, bread: 0.2 }),
  // 居民每日用于房屋修缮的木材需求（木材“单位”，非库存精度单位）。
  houseRepairWoodUnitsPerDay: 5,
  breadBasicReserveDays: 30,
  breadBasePriceWheatPerJin: 2,
  unemploymentDailyJin: 1,
  saltAnnualDemandJinPerPerson: 10,
  saltPriceWheatPerJin: 10,
  rentPerResidentDayWheatJin: 1,
  saltFoodReserveDays: 30,
  saltGraceDays: 30,
  buildingMaxLevel: 5,
  agricultureTaxDefaultPercent: 40, // 用户 0.1.11 调优（原 50）
  agricultureTaxMaximumPercent: 80,
  agricultureTaxLookbackDays: 30,
  agricultureTaxSatisfactionLowPercent: 0,
  agricultureTaxSatisfactionHighPercent: 80,
  agricultureTaxSatisfactionSwing: 10,
  operatingRightReserveDays: 90,
  operatingRightValuationDays: 365,
  privateProductionTaxDefaultPercent: 10,
  privateProductionTaxMaximumPercent: 80,
  privateWoodTargetJin: 2000,
  currencyLedgerLimit: 1500,
  basicCommerceFoodReserveDays: 30,
  shareFoodReserveDays: 90,
  shareLivingVoucherReserveDays: 30,
  sharesPerListedLevel: 1000,
  defaultDividendPercent: 50, // Legacy company save/API compatibility only; 0.1.7 annual settlement does not use this ratio.
  companyOperatingReserveDays: 360,
  sharePerformanceObservationDays: 30,
  shareTargetAnnualYieldPercent: 8,
  companyValuationProfitYears: 5,
  companyValuationTargetProfitRatePercent: 20,
  companyValuationRateFactorMinimum: 0.5,
  companyValuationRateFactorMaximum: 1.5,
  shareNoHistoryMaxTakePercent: 10,

  // v16 household/employment policy. Values live here so UI and settlement use one source.
  householdFoodReserveDays: 30,
  householdLifeHistoryDays: 14,
  householdFoodRedemptionTargetDays: 3,
  satisfactionObservationDays: 14,
  satisfactionUpdateIntervalDays: 3,
  satisfactionSmoothing: 0.18,
  satisfactionUrgentFoodSmoothing: 0.55,
  householdSatisfaction: Object.freeze({
    foodWeight: 35, saltWeight: 12, housingWeight: 15, wageWeight: 15, reserveWeight: 13, disposableWeight: 5, breadComfortMaximum: 5,
    reserveTargetDays: 30, disposableTargetVoucherPerCapitaDay: 1.5
  }),
  householdLiving: Object.freeze({
    difficultPerCapitaVoucher: 30,
    comfortablePerCapitaVoucher: 180,
    difficultFoodDays: 14,
    comfortableFoodDays: 60
  }),
  employmentExchangeDefaultJin: 2,
  employmentExchangeMinimumJin: 0,
  employmentExchangeMaximumJin: 10,
  publicServiceDemandPopulation: 500,
  publicServiceDefaultWageVoucher: 10,

  shopRentDefaultVoucher: 1,
  shopProfitTaxDefaultPercent: 10,
  shopProfitTaxMaximumPercent: 80,
  shopSettlementDays: 30,
  shopMerchantStartupVoucher: 120,
  shopWorkingCapitalReserveDays: 7,
  shopMerchantSalesCapacityJin: 60,
  shopClerkSalesCapacityJin: 120,
  shopMaxMerchants: 4,
  shopMaxClerks: 20,
  generalStoreMaxClerks: 50,
  generalStoreMarkupPercent: 20,
  generalStoreCustomersPerStaff: 60, // 基线清理：从40提到60，缓解小额多笔时的接待笔数瓶颈
  generalStoreMaxDailyCustomers: 2000, // 用户 0.1.11 调优（原 1000）
  // 0.2.3 流通改革：综合商店动态加价（v1 只做综合商店，其他小店保持固定加价）。
  generalStorePricingReviewDays: 7,        // 7 天复核一次
  generalStorePricingTolerancePercent: 3,  // 实际利润率偏离目标超过 ±3% 才调价
  generalStorePricingMaxStepPercent: 10,   // 单次涨跌幅 ≤ ±10%
  generalStoreLossPromotionDays: 30,       // 连续 30 天亏损 → 促销模式
  generalStorePromotionRecoverDays: 7,     // 连续 7 天盈利 → 退出促销
  generalStorePriceElasticity: 0.5,        // 售价每贵 10%，购买量降 5%
  generalStoreElasticityFloor: 0.1,        // 需求乘数下限，避免价格把需求打到 0
  // 0.2.3 流通改革：批发市场做市商——收购价随库存反馈（防大公司抽干粮券）。
  wholesalePurchasePriceElasticity: 1.0,
  wholesalePurchasePriceScale: 1.0,
  wholesalePurchasePriceReferenceJin: 2000, // 每种商品的收购价参考库存（斤）
  shopMinimumEmploymentDays: 30,
  shopMerchantDefaultWageVoucher: 10,
  shopClerkDefaultWageVoucher: 10,
  shopClosureBadDays: 30,
  // 动态劳动力市场（移植自用户 0.1.11 优化）：商店按行情调工资的节拍与幅度。
  shopWageAdjustIntervalDays: 15,
  shopWageStepPercent: 10,
  shopWageFloorPercent: 50,
  shopWageRaiseProfitShare: 0.5,
  shopWageSlackFactor: 0.85,
  shopWageTightFactor: 1.2,
  laborUnemploymentHighPercent: 8,
  laborUnemploymentLowPercent: 5,
  laborPoachPremiumPercent: 15,
  // 经济历史曲线保留天数（用户 0.1.11：地图"经济"面板走势）。
  economyHistoryDays: 60,
  serviceDemandMaximumCycles: 2,
  serviceBudgetSharePercent: 35,
  serviceComfortDailyMaximum: 3,
  serviceTypes: Object.freeze({
    haircut: Object.freeze({ id: "haircut", name: "理发店", basis: "person", cycleDays: 20, priceVoucher: 4, merchantCapacity: 24, clerkCapacity: 30, consumables: Object.freeze([]), comfort: 0.8, incomeSensitivity: 0.8 }),
    repair: Object.freeze({ id: "repair", name: "修补铺", basis: "household", cycleDays: 30, priceVoucher: 8, merchantCapacity: 14, clerkCapacity: 18, consumables: Object.freeze([]), comfort: 1.2, incomeSensitivity: 0.7 }),
    tea: Object.freeze({ id: "tea", name: "茶馆", basis: "person", cycleDays: 5, priceVoucher: 3, merchantCapacity: 40, clerkCapacity: 48, consumables: Object.freeze([]), comfort: 0.6, incomeSensitivity: 1.6 }),
    school: Object.freeze({ id: "school", name: "学堂", basis: "child", cycleDays: 1, priceVoucher: 1, adjustablePrice: true, merchantCapacity: 50, clerkCapacity: 50, maxCapacity: 100, employeeOnlyCapacity: true, consumables: Object.freeze([]), comfort: 0.4, incomeSensitivity: 0.8 }),
    restaurant: Object.freeze({ id: "restaurant", name: "饭店", basis: "person", cycleDays: 5, priceVoucher: 4, merchantCapacity: 50, clerkCapacity: 50, employeeOnlyCapacity: true, consumables: Object.freeze([{ itemId: "wheat", quantity: 2 }]), mealReplacement: true, comfort: 1.0, incomeSensitivity: 1.0 })
  }),

  // v0.1.1 operating-plan parameters. Demand planning refreshes in coarse cycles to avoid daily hire/fire churn.
  operatingPlanIntervalDays: 3,
  operatingObservationDays: 7,
  producerInventoryTargetDays: 2,
  shopInventoryTargetDays: 2,
  operatingWorkerAdjustMaxPerCycle: 2,
  newBusinessTrialWorkers: 1,
  newBusinessTrialDays: 6,
  shopClerkUtilizationHireThreshold: 0.85,
  shopClerkUtilizationReleaseThreshold: 0.45,
  shopTypes: Object.freeze({
    general: Object.freeze({ id: "general", name: "综合商店", kind: "retail", itemIds: Object.freeze(["flour", "bread", "salt", "wood"]) }),
    haircut: Object.freeze({ id: "haircut", name: "理发店", kind: "service", serviceId: "haircut" }),
    repair: Object.freeze({ id: "repair", name: "修补铺", kind: "service", serviceId: "repair" }),
    tea: Object.freeze({ id: "tea", name: "茶馆", kind: "service", serviceId: "tea" }),
    school: Object.freeze({ id: "school", name: "学堂", kind: "service", serviceId: "school" }),
    restaurant: Object.freeze({ id: "restaurant", name: "饭店", kind: "service", serviceId: "restaurant" }),
    // 兼容旧调用；新开店会统一归一为综合商店。
    grain: Object.freeze({ id: "grain", name: "粮店", kind: "legacy_retail", itemId: "wheat", aliasOf: "general" }),
    bakery: Object.freeze({ id: "bakery", name: "面包店", kind: "legacy_retail", itemId: "bread", aliasOf: "general" }),
    salt: Object.freeze({ id: "salt", name: "盐店", kind: "legacy_retail", itemId: "salt", aliasOf: "general" })
  }),

  marketPricesVoucherPerUnit: Object.freeze({ wheat: 1, flour: 1.8, bread: 2, wood: 15, salt: 10 }),
  // 0.2.3 流通改革：批发市场做市商默认挂价（小麦斤等价）。
  // 售价 = 卖给综合商店/生产者的价；收购价 = 向公司/民营收购的价。可在批发市场面板调整。
  wholesaleDefaultSalePrices: Object.freeze({ wheat: 1, flour: 1.8, bread: 2.6, wood: 16, salt: 12 }),
  wholesaleDefaultPurchasePrices: Object.freeze({ wheat: 0.8, flour: 1.4, bread: 2, wood: 12, salt: 8 })
});

export const AGRICULTURE = Object.freeze({
  // 总可开垦上限；acres 为初始已开荒亩数（新档即 15000 亩供 1500 人耕种）。
  acres: 15000,
  acresMaximum: 100000,
  acresPerFarmer: 10,
  yieldPerAcre: 600,
  cropItemId: "wheat",
  farmerRoleId: "farmers",
  // 每 100 亩开荒需 100 工日，即 1 亩 1 工日。
  reclaimAcresPerBatch: 100,
  reclaimWorkDaysPerBatch: 100,
  // 开荒工人默认日薪沿用营造工标准（以现有工资换算，不另写死汇率）。
  reclaimWageRoleId: "builders",
  townTaxRate: Object.freeze({ numerator: 1, denominator: 2 })
});

export const PRECISION = Object.freeze({
  inventoryUnitsPerJin: 3000,
  qeqUnitsPerJin: 18000,
  currencyUnitsPerVoucher: 3000
});

export const INITIAL = Object.freeze({
  seed: 917309,
  stocks: Object.freeze({
    residents: Object.freeze({ wheat: 3000000 }),
    town: Object.freeze({ wheat: 3000000 })
  }),
  roleCounts: Object.freeze({ farmers: 1500, builders: 0 }),
  satisfaction: 75
});
