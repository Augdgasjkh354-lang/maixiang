// 存档结构版本：只在彻底不兼容时才加一。日常加字段不用改（读档会自动补默认值，见 persistence/save-compat.js）。
export const SAVE_VERSION = 17;

// 戏园只招待富户：家庭宽裕度（household-budget.js 的 affluence）达到此值才去。服务定义里的 minAffluence 读它。
const THEATER_MIN_AFFLUENCE = 1.5;

export const RULES = Object.freeze({
  saveVersion: SAVE_VERSION,
  daysPerYear: 360, // 12 个月 × 30 天（monthDays）；旧存档读档时日期按比例换算（persistence/migrations.js）
  monthDays: 30,
  growingDays: 270, // 秋收在 10 月 1 日（第 270 天，0 起算）
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
  // 居民房屋修缮的木材需求：每户每年斤数，按活跃家庭数累计，日需求用 daysPerYear 分摊（小数由 state.housing.repairWoodCarry 结转）。
  // 250 户 × 7.3 斤 ÷ 360 ≈ 5 斤/日。
  houseRepairWoodJinPerHouseholdYear: 7.3,
  breadBasicReserveDays: 30,
  breadBasePriceWheatPerJin: 2,
  unemploymentDailyJin: 1,
  saltAnnualDemandJinPerPerson: 10,
  saltPriceWheatPerJin: 10,
  rentPerResidentDayWheatJin: 1,
  saltFoodReserveDays: 30,
  saltGraceDays: 30,
  buildingMaxLevel: 10,
  // 运力（docs/TRADE.md「运力」「运费」）：单位斤。外贸房在岗给基础运力；物流中心、码头按在岗人数给运力。
  tradeBaseCapacityJin: 300,
  logisticsJinPerWorker: 60,
  // 码头工每人每天运力是脚夫的 2 倍。
  dockJinPerWorker: 120,
  // 运力池最多攒这么多天的日运力，没用完的可以攒着。
  freightPoolMaxDays: 30,
  // 私人贸易行运费（券/斤）：走物流中心与外贸房运力的部分；走码头的部分按 dockFreightVoucherPerJin。
  freightVoucherPerJin: 0.06,
  dockFreightVoucherPerJin: 0.03,
  // 贸易中心 / 贸易行（docs/TRADE.md「贸易中心与贸易行」）：贸易行每天按店员数定成交量，另受当日运力的份额限制。
  tradeHouseTargetMarginPercent: 10, // 单斤利润率（卖价 − 买价 − 运费）达到这个百分比（相对买价+运费）才做
  tradeHouseImportMarginPercent: 25, // 进口的利润率门槛（高于出口，贸易行偏向出口）
  tradeHouseExportPriority: 1.5, // 排序时出口利润率乘这个系数，同等条件先做出口
  tradeHouseJinPerClerk: 300, // 每名店员（含商人）每天可成交的斤数
  tradeHouseCapacityShare: 0.8, // 各贸易行合计最多占当日运力的这个比例，按店员数分配；其余留给镇里
  tradeTariffMaximumPercent: 50, // 进出口关税上限（%）；默认 0，在贸易中心设
  tradeHouseExportMinStockDays: 10, // 批发市场存量不到这么多天销量时，不出口这样货（保本地供应）
  tradeHouseImportShortageDays: 3, // 批发市场存量不到这么多天销量时视为紧缺（界面标记用）
  agricultureTaxDefaultPercent: 40, // 用户 0.1.11 调优（原 50）
  agricultureTaxMaximumPercent: 80,
  agricultureTaxLookbackDays: 30,
  agricultureTaxSatisfactionLowPercent: 0,
  agricultureTaxSatisfactionHighPercent: 80,
  agricultureTaxSatisfactionSwing: 10,
  operatingRightReserveDays: 90,
  operatingRightValuationDays: 360,
  // 所有制（docs/OWNERSHIP.md）：民营/公司欠薪连续超过该天数，整栋收回镇营。
  ownershipTakeoverArrearsDays: 30, // 欠薪连续超过 30 天 → 镇里收回
  // 民营/公司业主自主升级：每隔这么多天检查一次。
  ownerUpgradeCheckDays: 30, // 每 30 天检查一次
  ownerUpgradeProfitDays: 60, // 近 60 天利润须大于 0
  ownerUpgradeReserveWageDays: 60, // 现金须留够 60 天工资
  ownerUpgradeStaffingRatio: 0.9, // 在岗须达到岗位上限的 90%
  // 上市（整栋，docs/OWNERSHIP.md 第 2 条）：挂牌时卖出比例的默认值，镇长可改。
  ipoDefaultOfferPercent: 49, // 民营业主申请上市时默认卖出 49%，业主持有其余股份
  stockProfitWindowDays: 60, // 股票看利润只看最近 60 天（折成全年）
  stockFairYieldPercent: 4, // 股票合理价：年利润 ÷ 总股本 ÷ 4%（市盈率 25）；股价对应的利润率跌到 3%、2%、1% 以下就是泡沫
  ipoTownDefaultOfferPercent: 0, // 镇长整栋上市默认一股不挂出：卖多少由镇长自己在交易所设，镇库持股不会被居民自动买走
  // 民营业主上市申请：经营好（近 60 天利润为正）但现金不够下一次升级的民营建筑，每隔这么多天检查一次是否递交申请。
  ipoApplicationCheckDays: 30, // 每 30 天检查一次
  ipoReapplyCooldownDays: 180, // 申请被驳回后，同一业主 180 天内不得再申请
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
  employmentExchangeDefaultJin: 20, // 5 时家底多是小麦的人家换不出钱买日用品，第二年消费塌到 2%
  employmentExchangeMinimumJin: 0,
  employmentExchangeMaximumJin: 50,
  publicServiceDemandPopulation: 500,
  publicServiceDefaultWageVoucher: 10,

  shopRentDefaultVoucher: 1,
  stallRentDefaultVoucher: 2,
  // 时代广场集市：默认允许摆摊人数。
  stallKeeperDefaultLimit: 50,
  // 集市补贴：免租时长（天，三个月/半年/一年/三年）；批发特价三档，每斤少收 0.1/0.2/0.4 斤小麦（第 0 档不打折）。
  stallRentFreeOptionsDays: Object.freeze([90, 180, 360, 1080]),
  stallWholesaleDiscountTiers: Object.freeze([0, 0.1, 0.2, 0.4]),
  // 集市售价比综合商店便宜几个百分点（默认 0：同价，居民轮流在两边买；原来低 3% 会把商店的生意全抢走），不低于进价。
  stallUndercutPercent: 0,
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
  // 一位客人（一户人家）一天在一家店平均买多少斤：决定商店卖货能力（客流 × 这个数）和加店员是否划算。
  shopJinPerCustomer: 20,
  generalStoreCustomersPerStaff: 20, // 客流按户计：每名店员（含商人）每天接待 20 户（旧口径一户约算 3 位客人、每人 60，用工规模不变）
  generalStoreMaxDailyCustomers: 2000, // 用户 0.1.11 调优（原 1000）
  // 0.2.3 流通改革：综合商店动态加价（v1 只做综合商店，其他小店保持固定加价）。
  generalStorePricingReviewDays: 7,        // 7 天复核一次
  generalStorePricingTolerancePercent: 3,  // 实际利润率偏离目标超过 ±3% 才调价
  generalStorePricingMaxStepPercent: 10,   // 单次涨跌幅 ≤ ±10%
  generalStoreLossPromotionDays: 30,       // 连续 30 天亏损 → 促销模式
  generalStorePromotionRecoverDays: 7,     // 连续 7 天盈利 → 退出促销
  generalStorePriceElasticity: 0.5,        // 售价每贵 10%，购买量降 5%
  generalStoreElasticityFloor: 0.1,        // 需求乘数下限，避免价格把需求打到 0
  // 物价会动（economy/price-adjust.js）：综合商店零售价系数与批发市场自动调价共用这一套阈值。
  priceAdjust: Object.freeze({
    reviewDays: 7,               // 复核周期（天）：综合商店每 7 天复核一次系数；批发自动调价同周期
    highStockDays: 21,           // 库存够卖超过 21 天 → 积压，降价
    clearanceStockDays: 42,      // 库存够卖超过 42 天 → 清库存，综合商店允许降到进货价 × minFactor
    lowStockDays: 3,             // 库存够卖不足 3 天且有拒客/断货 → 紧缺，涨价
    stepDown: 0.05,              // 积压时每次降价比例
    stepUp: 0.05,                // 紧缺时每次涨价比例
    shortageStepUp: 0.10,        // 库存已空且有断货时每次涨价比例（涨得更快）
    driftStep: 0.02,             // 正常时系数向 1 回归的每次步长（不越过 1）
    minFactor: 0.7,              // 系数下限（清库存时售价可低到进货价 × 0.7）
    maxFactor: 1.5,              // 系数上限
    wholesaleBandPercent: 30     // 批发市场自动调价：售价相对锚定价的最大偏离（±%）
  }),
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
  householdGoodsShoppingDays: 5, // 赶集：日用品与盐存货不够当天用才去买、一次买够这么多天；修房木材每这么多天统一采购一次
  // 正式员工（systems/employment-contracts.js）：入职满这么多天才能辞退；辞退付这么多天日薪作补偿；
  // 店铺、民营、公司每月 1 号按过去 hiringDemandWindowDays 天的需求审核一次，人手不够才招一人。
  dismissalMinTenureDays: 30,
  severanceWageDays: 30,
  hiringDemandWindowDays: 60,
  openingPeriodDays: 30, // 开张期：开店、转民营、成立公司后这么多天内每天按需求招人，可一次招够
  initialHouseholdSize: 5, // 开局约几人一户（systems/households.js）
  householdSplitMaxPeople: 8, // 一户超过这么多人就在年终分家（systems/household-split.js）
  farmStockDays: 7, // 养殖场存货够卖这么多天就停养；超过即算积压降价（systems/farm-pricing.js）
  // 民营工资（systems/private-wage.js）：参照镇营同岗位实际日薪，失业松紧系数与商店共用。
  privateWageAdjustIntervalDays: 15,
  privateWageStepPercent: 10,
  privateWageFloorPercent: 50,
  laborUnemploymentHighPercent: 8,
  laborUnemploymentLowPercent: 5,
  laborPoachPremiumPercent: 15,
  // 经济历史曲线保留天数（用户 0.1.11：地图"经济"面板走势）。
  economyHistoryDays: 60,
  serviceDemandMaximumCycles: 2,
  serviceComfortDailyMaximum: 3,
  operatingStockCorrectionDays: 5,
  // 家庭购买力（systems/household-budget.js）：宽裕度 m = maxAffluence × tanh(a × √(B/R))，a = atanh(1/maxAffluence)。
  //   maxAffluence 是渐近上限（不是硬封顶）；B = 可动用预算（斤/人/年）= 人均年收入 + usableWealthShare × 人均家底；
  //   年收入 = 近期日收入 × 360（household.recentIncomeUnits，收入类付款的指数滑动平均，半衰期 incomeHalfLifeDays；白名单见 systems/household-life.js 的 BUDGET_INCOME_TYPES）；
  //   无记录时用收入预期 incomeExpectationJin ÷ 360 作初值。
  //   R = referenceBudgetPerCapitaJin × 物价指数（篮子 basket：面粉、面包、盐，相对开局售价 wholesaleDefaultSalePrices 的加权平均；小麦钉价，不进篮子）。
  //   B = R 时 m = 1（正常人家）。referenceBudgetPerCapitaJin 按"有店主、有贫富差距"的探针镇第 2 年末人口加权宽裕度中位数 ≈ 1 标定（见 CHANGELOG）。
  // 家底只算粮券 + 存款 + 留够 wealthFoodReserveDays 天口粮后多出的小麦（不留到秋收，免得秋收前宽裕度断崖）；
  // harvestBufferDays 只用于富人税等付款保护（留到下次秋收再加这么多天）；每日可花 = B ÷ 360，服务预算 = 每日可花 × serviceShare；
  // 主食里面粉、面包的比例 = 标准比例 × 宽裕度（最多 stapleUpgradeMax 倍）。
  // 批发市场对外卖小麦（养殖场饲料、公司原料）时给镇库留的口粮底线天数。
  townWheatSaleReserveDays: 60,
  householdBudget: Object.freeze({
    referenceBudgetPerCapitaJin: 2000, maxAffluence: 4, usableWealthShare: 0.1, incomeHalfLifeDays: 30,
    basket: Object.freeze({ flour: 0.5, bread: 0.3, salt: 0.2 }),
    wealthFoodReserveDays: 30, harvestBufferDays: 30, serviceShare: 0.35, stapleUpgradeMax: 1.5
  }),
  // 戏园的门槛：宽裕度低于此值的家庭不去戏园（不产生需求，也不计入"需求未满足"）。
  // 再分配（docs/REDISTRIBUTION.md）：富人税每 30 天收一次；基尼系数逐年记录最多保留 50 年。
  wealthTaxPeriodDays: 30,
  giniHistoryLimit: 50,
  theaterMinAffluence: THEATER_MIN_AFFLUENCE,
  // 日用品：annualPerPerson 是正常人家（宽裕度 1）的年人均量；实际量 × 宽裕度^incomeElasticity（必需品弹性小，享受品大）；
  // comfortMaximum 是用到标准量时的舒心值加成，多用边际递减（最多 1.5 倍）。
  householdGoods: Object.freeze({
    cloth: Object.freeze({ annualPerPerson: 1, incomeElasticity: 0.6, comfortMaximum: 3 }),
    wine: Object.freeze({ annualPerPerson: 6, incomeElasticity: 1.2, comfortMaximum: 2 })
  }),
  // 肉当主食（market.js 的 meatStapleShare）：主食里肉的口粮当量占比 = maxShare × (宽裕度/fullAffluence)^exponent（封顶 maxShare），
  // fullAffluence 是肉占比达到 maxShare 的宽裕度（不再跟 householdBudget.maxAffluence 挂钩：那已是渐近上限 4，会让肉的曲线整体漂移）；
  // 宽裕度 1 约 5%、2 约 27%、3 为 75%；肉按 weights 分到鸡鸭鹅猪，没买到的改买面粉。comfortMaximum：肉占口粮 1/4 时的舒心值加成。
  // 这里的宽裕度是"吃肉习惯"：近 habitDays 天宽裕度的平滑值，秋收前后余粮起落时饮食慢慢变。
  meatStaple: Object.freeze({ maxShare: 0.75, fullAffluence: 3, exponent: 2.5, habitDays: 90, weights: Object.freeze({ chicken: 4, duck: 3, goose: 2, pork: 8 }), comfortMaximum: 4 }),
  serviceTypes: Object.freeze({
    haircut: Object.freeze({ id: "haircut", name: "理发店", basis: "person", cycleDays: 20, priceVoucher: 4, merchantCapacity: 24, clerkCapacity: 30, consumables: Object.freeze([]), comfort: 0.8, incomeSensitivity: 0.8 }),
    repair: Object.freeze({ id: "repair", name: "修补铺", basis: "household", cycleDays: 30, priceVoucher: 8, merchantCapacity: 14, clerkCapacity: 18, consumables: Object.freeze([]), comfort: 1.2, incomeSensitivity: 0.7 }),
    tea: Object.freeze({ id: "tea", name: "茶馆", basis: "person", cycleDays: 5, priceVoucher: 3, merchantCapacity: 40, clerkCapacity: 48, consumables: Object.freeze([]), comfort: 0.6, incomeSensitivity: 1.6 }),
    school: Object.freeze({ id: "school", name: "学堂", basis: "child", cycleDays: 1, priceVoucher: 1, adjustablePrice: true, merchantCapacity: 50, clerkCapacity: 50, maxCapacity: 100, employeeOnlyCapacity: true, consumables: Object.freeze([]), comfort: 0.4, incomeSensitivity: 0.8 }),
    restaurant: Object.freeze({ id: "restaurant", name: "饭店", basis: "person", cycleDays: 5, priceVoucher: 4, merchantCapacity: 50, clerkCapacity: 50, employeeOnlyCapacity: true, consumables: Object.freeze([{ itemId: "wheat", quantity: 2 }]), mealReplacement: true, comfort: 1.0, incomeSensitivity: 1.0 }),
    // 戏园：富户的消遣。票价 6 券（茶馆的两倍），收入弹性 2.5，实际门槛约 15 券/场（票价 × 弹性，与茶馆同一口径，超出家庭日预算就买不起）；
    // 人工密集：每个店员只接待 6 人（茶馆 48 人）；舒心值 1.2（茶馆 0.6）。只有宽裕度 ≥ minAffluence 的家庭去。
    theater: Object.freeze({ id: "theater", name: "戏园", basis: "person", cycleDays: 10, priceVoucher: 6, merchantCapacity: 10, clerkCapacity: 6, consumables: Object.freeze([]), comfort: 1.2, incomeSensitivity: 2.5, minAffluence: THEATER_MIN_AFFLUENCE })
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
    general: Object.freeze({ id: "general", name: "综合商店", kind: "retail", itemIds: Object.freeze(["flour", "bread", "salt", "wood", "wine", "cloth"]) }),
    haircut: Object.freeze({ id: "haircut", name: "理发店", kind: "service", serviceId: "haircut" }),
    repair: Object.freeze({ id: "repair", name: "修补铺", kind: "service", serviceId: "repair" }),
    tea: Object.freeze({ id: "tea", name: "茶馆", kind: "service", serviceId: "tea" }),
    theater: Object.freeze({ id: "theater", name: "戏园", kind: "service", serviceId: "theater" }),
    school: Object.freeze({ id: "school", name: "学堂", kind: "service", serviceId: "school" }),
    restaurant: Object.freeze({ id: "restaurant", name: "饭店", kind: "service", serviceId: "restaurant" }),
    // 养殖场：开在养殖基地。商人和饲养员一起养，每人每日出 outputPerWorkerDay 斤肉，每斤肉吃 feedPerUnit 斤小麦。
    // 产品直接卖给综合商店，多余的卖给批发市场。
    chicken_farm: Object.freeze({ id: "chicken_farm", name: "养鸡场", kind: "farm", hostBuildingTypeId: "livestock_base", productItemId: "chicken", feedItemId: "wheat", feedPerUnit: 4, outputPerWorkerDay: 10 }),
    duck_farm: Object.freeze({ id: "duck_farm", name: "养鸭场", kind: "farm", hostBuildingTypeId: "livestock_base", productItemId: "duck", feedItemId: "wheat", feedPerUnit: 4, outputPerWorkerDay: 10 }),
    goose_farm: Object.freeze({ id: "goose_farm", name: "养鹅场", kind: "farm", hostBuildingTypeId: "livestock_base", productItemId: "goose", feedItemId: "wheat", feedPerUnit: 4, outputPerWorkerDay: 10 }),
    pig_farm: Object.freeze({ id: "pig_farm", name: "养猪场", kind: "farm", hostBuildingTypeId: "livestock_base", productItemId: "pork", feedItemId: "wheat", feedPerUnit: 4, outputPerWorkerDay: 10 }),
    // 时代广场集市：一座广场一个集体摊位，待业的人自动来摆，人数按销量增减（不超过允许人数）。
    // 从批发市场进少量日用品（不卖主食），每人每日最多卖 25 斤（一摊 2 人 50 斤），按摊交租；每天的利润按人头 ×0.8—1.2 随机分给摆摊家庭。
    stall: Object.freeze({ id: "stall", name: "集市", kind: "stall", hostBuildingTypeId: "times_square", maxClerks: 0,
      startupVoucher: 200, perKeeperSalesJin: 25, markupPercent: 10, // markupPercent 只在镇上没有综合商店时用
      settlementDays: 1, workingCapitalReserveDays: 2 }),
    // 贸易行：开在贸易中心，店主与店员每天自己做外镇买卖（systems/trading-houses.js），不卖给居民。
    trading_house: Object.freeze({ id: "trading_house", name: "贸易行", kind: "trade", hostBuildingTypeId: "trade_center", maxClerks: 20,
      startupVoucher: 300, workingCapitalReserveDays: 2 }),
    // 兼容旧调用；新开店会统一归一为综合商店。
    grain: Object.freeze({ id: "grain", name: "粮店", kind: "legacy_retail", itemId: "wheat", aliasOf: "general" }),
    bakery: Object.freeze({ id: "bakery", name: "面包店", kind: "legacy_retail", itemId: "bread", aliasOf: "general" }),
    salt: Object.freeze({ id: "salt", name: "盐店", kind: "legacy_retail", itemId: "salt", aliasOf: "general" })
  }),

  marketPricesVoucherPerUnit: Object.freeze({ wheat: 1, flour: 1.8, bread: 2, wood: 15, salt: 10, wine: 4, cotton: 2.5, cloth: 18, chicken: 5, duck: 5, goose: 6, pork: 6 }),
  // 0.2.3 流通改革：批发市场做市商默认挂价（小麦斤等价）。
  // 售价 = 卖给综合商店/生产者的价；收购价 = 向公司/民营收购的价。可在批发市场面板调整。
  wholesaleDefaultSalePrices: Object.freeze({ wheat: 1, flour: 1.8, bread: 2.6, wood: 16, salt: 12, wine: 4.5, cotton: 2.8, cloth: 20, chicken: 5.5, duck: 5.5, goose: 6.6, pork: 6.6 }),
  wholesaleDefaultPurchasePrices: Object.freeze({ wheat: 0.8, flour: 1.6, bread: 2, wood: 12, salt: 8, wine: 3.5, cotton: 2.2, cloth: 16, chicken: 4.6, duck: 4.6, goose: 5, pork: 5 }),
  // 镇营产出闸门（市场积压）：镇营磨坊/面包房等按批发市场需求定产，不再无限入市。
  // 目标库存 = max(最低库存, 近 7 日需求 × 备货天数)；需求 = 市场售出 + 镇营自身领用。
  townOutputMinStockJin: 200, // 最低备货（斤）：没有销量时也保留这么多货
  townOutputStockDays: 30, // 备货天数：目标库存相当于多少天的需求
  // 镇营吃小麦的口粮储备：磨坊/酒坊不得把镇库小麦压到 全镇人口 × 日口粮 × 天数 以下，留给救济与居民。
  townWheatReserveDays: 180
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
