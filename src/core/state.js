import { CONTENT } from "../content/index.js";
import { emptyFinancialFlowPeriod } from "../economy/financial-flows.js";
import { createInitialHouseholds, householdList, householdPopulation, syncResidentAggregates } from "../systems/households.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { createOutsideTowns } from "../systems/outside-town.js";
import { buildingMaxLevel } from "../content/building-level.js";

// 建造工程：state.projects 是权威数组，支持多工程并行。
// state.project 保留为“单工程兼容访问器”（getter 返回首个工程、setter 整体替换数组），
// 让既有单工程调用方与旧存档读取路径继续可用；该属性不可枚举，不进入 JSON 存档。
export function ensureProjectAccessor(state) {
  if (!state || typeof state !== "object") return state;
  state.projects = Array.isArray(state.projects) ? state.projects : [];
  if (Object.getOwnPropertyDescriptor(state, "project")?.get) return state;
  const existing = Object.prototype.hasOwnProperty.call(state, "project") ? state.project : undefined;
  Object.defineProperty(state, "project", {
    configurable: true,
    enumerable: false,
    get: function () { return state.projects.length ? state.projects[0] : null; },
    set: function (value) {
      state.projects = value ? [value] : [];
    }
  });
  if (existing && state.projects.length === 0) state.projects = [existing];
  return state;
}

function spreadAgeBand(total, start, end) {
  const count = end - start + 1;
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, function (_, index) {
    const number = base + (index < remainder ? 1 : 0);
    const female = Math.floor(number / 2);
    return {
      age: start + index,
      m: number - female,
      f: female,
      marriedM: 0,
      marriedF: 0
    };
  });
}

export function createInitialCohorts() {
  // 总人口 6600：未成年 2100 / 劳动力 3500 / 老年 1000（世界规模翻倍，人均结构不变）。
  // 未成年占比 31.8%（原 27.3%），每年约 58 人成年、约 37 人退出劳动力，
  // 劳动力年净增约 21 人，前期呈增长趋势。
  const cohorts = [
    ...spreadAgeBand(2100, 0, 17),
    ...spreadAgeBand(3500, 18, 64),
    ...spreadAgeBand(1000, 65, 84)
  ];
  let couples = 576;
  for (const cohort of cohorts) {
    if (cohort.age < 20 || cohort.age > 39 || couples <= 0) continue;
    const pairs = Math.min(cohort.m, cohort.f, couples);
    cohort.marriedM = pairs;
    cohort.marriedF = pairs;
    couples -= pairs;
  }
  return cohorts;
}

function emptyAccounts(content) {
  const accounts = { residents: {}, town: {} };
  for (const itemId of Object.keys(content.items)) {
    accounts.residents[itemId] = 0;
    accounts.town[itemId] = 0;
  }
  for (const owner of ["residents", "town"]) {
    for (const [itemId, quantity] of Object.entries(content.initial.stocks?.[owner] || {})) {
      if (!content.items[itemId]) throw new Error("初始库存引用了未注册物品：" + itemId);
      accounts[owner][itemId] = Math.round(quantity * content.precision.inventoryUnitsPerJin);
    }
  }
  return accounts;
}

export function emptyYearTotals() {
  return {
    harvestQeq: 0,
    consumptionQeq: 0,
    operatingWagesQeq: 0,
    constructionPayQeq: 0,
    reliefQeq: 0,
    processingLossQeq: 0,
    unemploymentPaidQeq: 0,
    wagePaidQeq: 0,
    wageArrearsQeq: 0
  };
}

export function defaultWageRates(content) {
  const rates = {};
  for (const role of Object.values(content.roles)) {
    if (role.wagePerWorkerDay > 0) rates[role.id] = role.wagePerWorkerDay;
  }
  for (const definition of Object.values(content.buildings)) {
    for (const job of definition.jobs || []) {
      if (rates[job.id] === undefined) rates[job.id] = job.wagePerWorkerDay ?? 5;
    }
  }
  return rates;
}

export function emptyTradeTotals() {
  return { soldBreadUnits: 0, revenueWheatUnits: 0, breadCogsWheatUnits: 0, rawInputCostWheatUnits: 0 };
}

// 开荒账目：记录本日/本年/累计的亩数、工日与镇库实付工资，供面板与审计读取。
export function emptyReclaimPeriod() {
  return { acres: 0, workDays: 0, paidVoucherUnits: 0 };
}

export function emptyReclaimState() {
  return {
    day: emptyReclaimPeriod(),
    year: emptyReclaimPeriod(),
    cumulative: emptyReclaimPeriod(),
    last: null,
    history: []
  };
}

export function emptyBusinessState(content) {
  const inventoryCostWheatUnits = { town: {} };
  const opening = {};
  for (const [itemId, item] of Object.entries(content.items)) {
    const balance = Math.round((content.initial.stocks?.town?.[itemId] || 0) *
      content.precision.inventoryUnitsPerJin);
    const rate = item.openingCostWheatPerJin;
    const unitCost = Number.isFinite(rate) ? rate : (itemId === "wheat" ? 1 : 0);
    inventoryCostWheatUnits.town[itemId] = Math.round(balance * unitCost);
    opening[itemId] = unitCost;
  }
  return {
    inventoryCostWheatUnits,
    openingValuationWheatPerJin: opening,
    buildings: {},
    day: { producedUnits: {}, ...emptyTradeTotals(), operatingWagesWheatUnits: 0, constructionWagesWheatUnits: 0, processingLossWheatUnits: 0 },
    year: { producedUnits: {}, ...emptyTradeTotals(), operatingWagesWheatUnits: 0, constructionWagesWheatUnits: 0, processingLossWheatUnits: 0 },
    cumulative: { producedUnits: {}, ...emptyTradeTotals(), operatingWagesWheatUnits: 0, constructionWagesWheatUnits: 0, processingLossWheatUnits: 0 }
  };
}

function emptyIndustryPeriod() {
  return {
    producedUnits: {},
    soldUnits: 0,
    revenueWheatUnits: 0,
    operatingWagesWheatUnits: 0
  };
}

// 产业账本：每个建筑定义里出现的 accountingSector 各一本（"bread" 记在镇营作坊账 business 里，不在这里）。
export function emptyIndustryState(content = CONTENT) {
  const sectors = new Set(Object.values(content.buildings).map(def => def.accountingSector).filter(sector => sector && sector !== "bread"));
  return Object.fromEntries([...sectors].map(function (sector) {
    return [sector, {
      day: emptyIndustryPeriod(),
      year: emptyIndustryPeriod(),
      cumulative: emptyIndustryPeriod()
    }];
  }));
}

function emptyRentPeriod() {
  return { dueWheatUnits: 0, collectedWheatUnits: 0, waivedWheatUnits: 0 };
}

export function emptyFiscalState() {
  return { day: emptyRentPeriod(), year: emptyRentPeriod(), cumulative: emptyRentPeriod() };
}

// 开局即粮券阶段：一次性发行开局粮券，不经银行闸门（印券闸门只管之后的增发）。
// 居民按户人口各得 openingVoucherPerResidentJin 斤粮券，镇库券池得 openingVoucherTownPoolJin 斤；发行总量 = 两者之和。
// 1 斤 ≈ 1 券，换算走 voucherUnitsForWheatUnits（与以粮换券同一口径）。居民与镇库的小麦库存不动。
function issueOpeningVouchers(state, content) {
  const perJin = (jin) => voucherUnitsForWheatUnits(jin * content.precision.inventoryUnitsPerJin, content, "floor");
  const perResidentJin = content.initial.openingVoucherPerResidentJin ?? 1000;
  let residentUnits = 0;
  for (const household of householdList(state)) {
    const units = perJin(householdPopulation(household) * perResidentJin);
    household.voucherUnits = units;
    residentUnits += units;
  }
  const townUnits = perJin(content.initial.openingVoucherTownPoolJin ?? 13400000);
  const currency = state.currency;
  currency.balances.town = townUnits;
  currency.issuedUnits = residentUnits + townUnits;
  currency.issuedCumulativeUnits = currency.issuedUnits;
  currency.guidancePending = false;
  syncResidentAggregates(state, content);
}

// 开局种类：blank（默认，引擎与脚本用，不放任何建筑）；standard（界面"新游戏"用，放 rules.INITIAL.standardOpeningBuildings）。
export const OPENING_KINDS = Object.freeze(["blank", "standard"]);

// 标准开局：建筑开局即落成（completed = 开局日），不耗材料、不派工（岗位留空，玩家在就业面板设人数）。
// 地块、等级与清单都在 content/rules.js 的 INITIAL.standardOpeningBuildings，这里只负责落位。
function placeStandardOpening(state, content) {
  const rows = content.initial.standardOpeningBuildings || [];
  for (const row of rows) {
    const definition = content.buildings[row.typeId];
    const plot = state.plots.find(item => item.id === row.plotId);
    if (!definition || !plot) throw new Error("标准开局配置无效：" + row.typeId + " @ " + row.plotId);
    if (definition.requiredPlotFeature && plot.feature !== definition.requiredPlotFeature) {
      throw new Error("标准开局地块不符：" + row.typeId + " @ " + row.plotId);
    }
    const level = Math.max(1, Math.min(buildingMaxLevel(content, row.typeId), Math.floor(row.level || 1)));
    const instanceNumber = state.nextInstanceNumber || 1;
    state.nextInstanceNumber = instanceNumber + 1;
    state.buildings.push({
      id: "building-" + instanceNumber,
      typeId: row.typeId,
      level,
      ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
      materialInvestments: [],
      plotId: plot.id,
      x: plot.x,
      y: plot.y,
      housingCapacity: definition.housingCapacity || 0,
      completed: { year: state.year, day: state.day + 1 }
    });
  }
  if (rows.length) {
    // 开局提示走界面上的一次性横幅（state.openingHint），玩家点掉后置空。
    const names = rows.map(row => content.buildings[row.typeId].name).join("、");
    state.openingHint = `新任镇长上任。${names}已建好，开局不派工：记得在就业面板设人数，否则没有产出。`;
  }
}

export function createInitialState(options) {
  const settings = options || {};
  const opening = settings.opening ?? "blank";
  if (!OPENING_KINDS.includes(opening)) throw new Error("未知开局：" + opening);
  const content = settings.content || CONTENT;
  const state = {
    version: content.rules.saveVersion || 3,
    schemaVersion: content.rules.saveVersion || 3,
    year: 1,
    day: 0,
    // 存档时的日历天数（一年几天）；旧存档没有这个字段，读档时按 365 天换算日期。
    calendarDaysPerYear: content.rules.daysPerYear,
    accounts: emptyAccounts(content),
    cohorts: createInitialCohorts(),
    employment: {
      wageRates: defaultWageRates(content),
      targets: { farmers: Math.max(0, Math.floor(content.initial.roleCounts?.farmers || 0)) }
    },
    agriculture: {
      workUnits: 0,
      lastHarvestYear: 0,
      reclaimedAcres: Math.max(0, Math.min(
        content.agriculture.acresMaximum ?? content.agriculture.acres,
        content.agriculture.acres
      )),
      reclaim: emptyReclaimState(),
      // 铁犁牛耕改革（金银消费第三期）：被替代的耕地亩数，默认 0（systems/iron-plow.js）。
      ironPlowAcres: 0,
      taxDays: [],
      taxHistory: []
    },
    plots: content.plots.map(function (plot) { return { ...plot }; }),
    buildings: [],
    demolishedBuildings: [],
    projects: [],
    nextInstanceNumber: 1,
    autoRelief: true,
    policy: {
      unemploymentBenefit: { enabled: false, dailyPerWorkerJin: content.rules.unemploymentDailyJin },
      agricultureTaxPercent: content.rules.agricultureTaxDefaultPercent ?? 50,
      villa: { priceWheatJin: 10000, taxRatePercent: 0.5 },
      wageControl: { civil: 1.0, industry: 1.0 },
      privateProductionTaxPercent: Object.fromEntries(
        Object.keys(content.buildings).map(typeId => [typeId, content.rules.privateProductionTaxDefaultPercent ?? 10])
      ),
      // 利润率政策（0—200，一位小数）：综合商店全局目标利润率；贸易行出口 / 进口利润门槛。
      // 印花税（%）：二级市场每笔成交按成交额由卖方承担，交镇库；镇库自己卖出不征（economy 在 systems/stock-exchange.js）。
      stampDutyPercent: content.rules.stampDutyDefaultPercent ?? 0.1,
      // 酒类专售令（默认关）：开启后综合商店与时代广场停售四种酒，居民买酒只去酒馆（systems/shop-types.js）。
      liquorMonopoly: false,
      shopMarginPercent: content.rules.generalStoreMarkupPercent ?? 20,
      tradeMarginPercent: content.rules.tradeHouseTargetMarginPercent ?? 20,
      tradeImportMarginPercent: content.rules.tradeHouseImportMarginPercent ?? 25,
      employmentExchangeJin: content.rules.employmentExchangeDefaultJin ?? 5,
      // 公租房日租（斤/人·日，0—20，一位小数；0 = 免租）。
      publicHousingRentPerResidentDayJin: content.rules.rentPerResidentDayWheatJin ?? 1,
      shopRentVoucher: content.rules.shopRentDefaultVoucher ?? 1,
      // 粮券收购（systems/voucher-buyback.js，默认关）：开关；每日收购小麦上限（斤）；比价（每 1 粮券给多少斤小麦，0.5—2，一位小数）。
      voucherBuyback: { enabled: false, dailyWheatJin: 50000, wheatPerVoucher: 1 },
      // 斗兽场政策（systems/arena.js，默认值见 content/rules.js 的 arena.defaults）：每日抓兽目标、每日搏斗数、押注抽成（%）、存栏上限。
      arena: { dailyCaptureTarget: 100, dailyFights: 100, rakePercent: 10, beastCapacity: 2000 },
      stallRentVoucher: content.rules.stallRentDefaultVoucher ?? 2,
      stallKeeperLimit: content.rules.stallKeeperDefaultLimit ?? 50,
      stallRentFreeUntilSerial: 0,
      stallDiscountTier: 0,
      shopProfitTaxPercent: content.rules.shopProfitTaxDefaultPercent ?? 10,
      // 进出口关税（%）：只对贸易中心的贸易行征收，交镇库（systems/trading-houses.js）。
      tradeTariff: { importPercent: 0, exportPercent: 0 },
      autosaveMonths: 1,
      // 再分配（docs/REDISTRIBUTION.md）：富人税按人均家底分档累进，遗产税按去世成年人的份额征收。默认全部为 0。
      wealthTax: { thresholds: [300, 1000, 3000], ratesPercent: [0, 0, 0] },
      inheritanceTaxPercent: 0,
      agricultureTaxRecent: Array.from({ length: content.rules.agricultureTaxLookbackDays || 30 }, (_, index) => ({
        year: 0, day: index, rateBps: 5000, baseline: true
      }))
    },
    wholesaleMarket: {
      inventory: Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0])),
      inventoryCostVoucherUnits: Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0])),
      // 0.2.3 做市商挂价：新档取做市商默认售价（面包 2.6 / 木材 16 / 盐 12）。
      pricesVoucherPerUnit: { ...(content.rules.wholesaleDefaultSalePrices || {}) },
      purchasePricesVoucherPerUnit: { ...(content.rules.wholesaleDefaultPurchasePrices || {}) },
      purchasePriceReferenceVoucherPerUnit: { ...(content.rules.wholesaleDefaultPurchasePrices || {}) },
      purchasePriceIndex: Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 1])),
      // 物价会动：批发自动调价，默认全部关闭。条目 { enabled, anchorVoucherPerUnit, reason, lastReviewSerial }，缺省即关闭。
      autoPricing: {},
      monopoly: { allocatedInValueUnits: 0, allocatedInputValueUnits: 0 },
      valueFlow: { day: { sales: 0, purchases: 0 }, year: { sales: 0, purchases: 0 }, cumulative: { sales: 0, purchases: 0 } },
      purchaseSpend: { day: 0, year: 0, cumulative: 0 },
      dailyTownAllocationUnits: Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0])),
      day: { intakeUnits: {}, soldUnits: {}, townAllocatedUnits: {}, townConsumedUnits: {}, unmetUnits: {}, purchaseVoucherUnits: 0, salesVoucherUnits: 0 },
      year: { intakeUnits: {}, soldUnits: {}, townAllocatedUnits: {}, townConsumedUnits: {}, purchaseVoucherUnits: 0, salesVoucherUnits: 0 },
      cumulative: { intakeUnits: {}, soldUnits: {}, townAllocatedUnits: {}, townConsumedUnits: {}, purchaseVoucherUnits: 0, salesVoucherUnits: 0 }
    },
    market: {
      breadPriceWheatPerJin: content.rules.marketPricesVoucherPerUnit?.bread ?? content.rules.breadBasePriceWheatPerJin,
      breadPriceVoucherPerJin: content.rules.marketPricesVoucherPerUnit?.bread ?? content.rules.breadBasePriceWheatPerJin,
      pricesVoucherPerUnit: { ...(content.rules.marketPricesVoucherPerUnit || {}) },
      intermediatePricesVoucherPerUnit: {
        flour: content.rules.marketPricesVoucherPerUnit?.flour ?? 1.8,
        wood: content.rules.marketPricesVoucherPerUnit?.wood ?? 15
      },
      operatingRightPrices: {},
      sellerRotation: { bread: 0, salt: 0 },
      publicProcurementDemand: {},
      operatingPlan: { updatedSerial: -1, rotation: {}, rows: {}, demand: {} },
      consumerHistory: { bread: [], salt: [], wood: [] },
      priceRecommendation: { pending: false, choice: "new_game" }
    },
    currency: {
      reserveWheatUnits: 0,
      reserveWheatCostVoucherUnits: 0,
      reserveModel: "town-inventory-v1",
      issuedUnits: 0,
      balances: { town: 0, residents: 0 },
      issuedCumulativeUnits: 0,
      exchangedCumulativeUnits: 0,
      redeemedCumulativeUnits: 0,
      guidancePending: true,
      ledger: []
    },
    // 只有粮券一种货币。monetaryReform 只剩 legacyBankAccess：没有银行建筑的测试/场景用它开放印券与换券入口。
    monetaryReform: { legacyBankAccess: false },
    companies: {},
    nextCompanyNumber: 1,
    // 民营业主上市申请（按建筑 id）与驳回后的冷却（按建筑 id，记业主家庭与解禁日序）。
    ipoApplications: {},
    ipoCooldowns: {},
    stockExchange: { legacyAccess: false, rotation: 0 },
    // 印花税账（粮券，三段记账）：二级市场卖方交给镇库的税额，年报里看 annualReports[].stampDuty。
    stampDuty: { day: {}, year: {}, cumulative: {} },
    // 粮券收购账（粮券，三段记账；政策在 policy.voucherBuyback）。rotation：每户轮转起点（按户序号）。
    voucherBuyback: { rotation: 0, day: {}, year: {}, cumulative: {} },
    // 斗兽场（金银消费第四期，systems/arena.js）：beasts 存栏兽数；beastCarry 饿死余数；opened 建成首日已放入开场存栏；三段记账 day/year/cumulative。
    arena: { beasts: 0, beastCarry: 0, opened: false, day: {}, year: {}, cumulative: {} },
    shops: {},
    nextShopNumber: 1,
    services: {
      demandByHousehold: {},
      carryByHousehold: {},
      pricesVoucherPerUse: Object.fromEntries(Object.values(content.rules.serviceTypes || {}).map(def => [def.id, def.priceVoucher || 0])),
      mealsByHousehold: {},
      rotation: { households: 0, shops: {}, services: 0 },
      day: { demandedUses: {}, attemptedUses: {}, servedUses: {}, unaffordableUses: {}, capacityUnmetUses: {}, spendingVoucherUnits: 0 },
      history: []
    },
    privateEconomy: {
      taxRemainders: {},
      day: { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 },
      year: { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 },
      cumulative: { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 },
      rightSales: { dayWheatUnits: 0, yearWheatUnits: 0, cumulativeWheatUnits: 0 },
      plans: {},
      payrollByBuilding: {}
    },
    financialFlows: { day: emptyFinancialFlowPeriod(), year: emptyFinancialFlowPeriod(), cumulative: emptyFinancialFlowPeriod() },
    payroll: {
      arrearsWheatUnits: {},
      totals: { paidWheatUnits: 0, currentPaidWheatUnits: 0, arrearsPaidWheatUnits: 0, unpaidWheatUnits: 0, unemploymentPaidWheatUnits: 0 },
      year: { paidWheatUnits: 0, currentPaidWheatUnits: 0, arrearsPaidWheatUnits: 0, unpaidWheatUnits: 0, unemploymentPaidWheatUnits: 0 }
    },
    business: emptyBusinessState(content),
    industries: emptyIndustryState(content),
    fiscal: emptyFiscalState(),
    housing: { villageCapacity: content.rules.housingCapacity, repairWoodCarry: 0 },
    villas: { sold: [], taxArrearsValueUnits: {}, stats: { soldTotal: 0, revenueValueUnits: 0, taxCollectedValueUnits: 0, taxArrearsValueUnits: 0 } },
    socialSecurity: { enabled: false, dailyPerWorkerJin: 1, pensionPerElderJin: 2, farmerSubsidyPerFarmerJin: 0, totalSubsidyUnits: 0, cashVoucherUnits: 0, debtToTownUnits: 0, totalInjectedUnits: 0, totalAdvancedUnits: 0, totalRepaidUnits: 0, totalCollectedUnits: 0, totalPaidUnits: 0, totalDividendUnits: 0 },
    // 再分配账（富人税、遗产税、家产归公）：day/year/cumulative 三段，见 systems/redistribution.js；giniHistory 逐年基尼。
    redistribution: { day: {}, year: {}, cumulative: {}, lastRun: null, giniHistory: [] },
    outsideTowns: createOutsideTowns(content),
    // 长期贸易协定：外贸房签约，每月从批发市场交货。
    tradeAgreements: [],
    // 运力池（docs/TRADE.md）：每日按日运力补充，出货进货都从池里扣；history 记最近 30 天。
    logistics: { poolJin: 0, usedToday: 0, history: [] },
    laborCompetition: { dayKey: null, day: { moves: 0 }, year: { moves: 0 }, recent: [] },
    goodsDemand: { todayDemandUnits: {}, day: {}, year: {} },
    industryExperience: {},
    // 教育：schoolDays 为学堂累计实际办学天数（接待过学生的日子），见 systems/productivity.js 与 economy/productivity.js 的 educationBonus。
    education: { schoolDays: 0 },
    // 各 mod 自己的状态（初值来自 mod 的 content.js initialState）。
    mods: structuredClone(content.modStates || {}),
    salt: {
      demandCarry: 0,
      graceDaysElapsed: 0,
      todayDemandUnits: 0,
      todaySatisfiedUnits: 0,
      history: [],
      day: { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 },
      year: { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 },
      lifetime: { demandUnits: 0, satisfiedUnits: 0, purchasedUnits: 0, paidWheatUnits: 0 }
    },
    satisfaction: content.initial.satisfaction,
    shortageQeq: 0,
    rng: { algorithm: "lcg32-v1", state: (settings.seed ?? content.initial.seed) >>> 0 },
    lastDemography: { births: 0, deaths: 0, marriages: 0, laborChange: null },
    yearTotals: emptyYearTotals(),
    annualReports: [],
    ledger: [],
    ledgerSequence: 0,
    transactionSequence: 0,
    // 镇报素材库（systems/gazette.js）：notes 当年要闻，issues 最近各期，readYear 已读的最新一期年份，marks 年终快照（同比用）。
    gazette: { notes: [], issues: [], readYear: 0, marks: null },
    // 开局提示（仅标准开局）：界面上的一次性横幅，玩家点掉后置空。
    openingHint: null
  };
  createInitialHouseholds(state, content);
  issueOpeningVouchers(state, content);
  if (opening === "standard") placeStandardOpening(state, content);
  ensureProjectAccessor(state);
  return state;
}
