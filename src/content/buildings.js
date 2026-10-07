export const BUILDINGS = Object.freeze({
  mill: Object.freeze({
    id: "mill", name: "磨坊", icon: "⚙️",
    description: "小麦磨面",
    industryTier: 1,
    maxInstances: 12,
    recipeId: "mill_flour",
    productionRoleId: "millers",
    jobs: Object.freeze([Object.freeze({
      id: "millers", name: "磨坊工", slots: 12, wagePerWorkerDay: 5,
      note: "每人每日最多磨80斤麦", releasePriority: 30
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 600 }]),
    construction: Object.freeze({
      workDays: 480, recommendedWorkers: 12
    }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 480, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 600 }]) })
  }),
  bakery: Object.freeze({
    id: "bakery", name: "面包房", icon: "🥖",
    description: "面粉烤面包 · 需已有面粉",
    industryTier: 2,
    maxInstances: 12,
    recipeId: "bakery_bread",
    productionRoleId: "bakers",
    jobs: Object.freeze([Object.freeze({
      id: "bakers", name: "面包师", slots: 10, wagePerWorkerDay: 5,
      note: "每人每日最多烤80斤面粉", releasePriority: 40
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]),
    construction: Object.freeze({
      workDays: 400, recommendedWorkers: 10
    }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 400, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]) })
  }),
  lumberyard: Object.freeze({
    id: "lumberyard", name: "伐木场", icon: "🪵",
    description: "南林伐木 · 木材持续可用",
    industryTier: 0,
    maxInstances: 12,
    recipeId: "lumber_gathering",
    productionRoleId: "lumberjacks",
    accountingSector: "forestry",
    requiredPlotFeature: "logging_resource",
    jobs: Object.freeze([Object.freeze({
      id: "lumberjacks", name: "伐木工", slots: 20, wagePerWorkerDay: 5,
      note: "每人每日产1单位木材", releasePriority: 30
    })]),
    construction: Object.freeze({
      workDays: 200, recommendedWorkers: 10
    }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 200, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 100 }]) })
  }),
  saltworks: Object.freeze({
    id: "saltworks", name: "盐场", icon: "🧂",
    description: "盐矿采掘并精制食盐 · 原料持续可用",
    industryTier: 0,
    maxInstances: 12,
    recipeId: "salt_gathering",
    productionRoleId: "salt_workers",
    accountingSector: "salt",
    requiredPlotFeature: "salt_mine",
    jobs: Object.freeze([Object.freeze({
      id: "salt_workers", name: "盐工", slots: 10, wagePerWorkerDay: 5,
      note: "每人每日产5斤食盐", releasePriority: 30
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 100 }]),
    construction: Object.freeze({
      workDays: 300, recommendedWorkers: 10
    }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 300, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 100 }]) })
  }),

  winery: Object.freeze({
    id: "winery", name: "酒坊", icon: "🍶",
    description: "小麦酿酒 · 用镇库小麦",
    industryTier: 1,
    maxInstances: 12,
    recipeId: "winery_wine",
    productionRoleId: "brewers",
    accountingSector: "brewing",
    jobs: Object.freeze([Object.freeze({
      id: "brewers", name: "酿酒工", slots: 8, wagePerWorkerDay: 5,
      note: "每人每日用30斤麦酿12斤酒", releasePriority: 40
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]),
    construction: Object.freeze({ workDays: 400, recommendedWorkers: 10 }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 400, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]) })
  }),
  cotton_field: Object.freeze({
    id: "cotton_field", name: "棉田", icon: "☁️",
    description: "种植棉花 · 原料持续可用",
    industryTier: 0,
    maxInstances: 12,
    recipeId: "cotton_growing",
    productionRoleId: "cotton_farmers",
    accountingSector: "textile",
    jobs: Object.freeze([Object.freeze({
      id: "cotton_farmers", name: "棉农", slots: 20, wagePerWorkerDay: 5,
      note: "每人每日产3斤棉花", releasePriority: 30
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 200 }]),
    construction: Object.freeze({ workDays: 200, recommendedWorkers: 10 }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 200, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 200 }]) })
  }),
  weaving_mill: Object.freeze({
    id: "weaving_mill", name: "织坊", icon: "🧵",
    description: "棉花织布 · 需已有棉花",
    industryTier: 1,
    maxInstances: 12,
    recipeId: "weaving_cloth",
    productionRoleId: "weavers",
    accountingSector: "textile",
    jobs: Object.freeze([Object.freeze({
      id: "weavers", name: "织工", slots: 12, wagePerWorkerDay: 5,
      note: "每人每日用4斤棉花织1匹布", releasePriority: 40
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]),
    construction: Object.freeze({ workDays: 400, recommendedWorkers: 10 }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 400, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]) })
  }),

  wholesale_market: Object.freeze({
    id: "wholesale_market", name: "批发市场", icon: "🏪",
    description: "镇营商品集散 · 每级10个岗位 · 统一批发价与下游进货",
    maxInstances: 1,
    jobs: Object.freeze([Object.freeze({
      id: "wholesale_workers", name: "批发市场职员", slots: 10, wagePerWorkerDay: 5,
      note: "每级增加10个镇营岗位", releasePriority: 45
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1000 }]),
    construction: Object.freeze({ workDays: 700, recommendedWorkers: 14 }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 700, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1000 }]) })
  }),

  commercial_street: Object.freeze({
    id: "commercial_street", name: "商业街", icon: "🏬",
    description: "居民开店 · 每级2间铺位",
    maxInstances: 12,
    jobs: Object.freeze([
      Object.freeze({ id: "merchants", name: "商人", slots: 8, wagePerWorkerDay: 5, note: "每间店最多4名商人，由店铺支付", releasePriority: 60, managedBy: "shops" }),
      Object.freeze({ id: "shop_clerks", name: "店员", slots: 100, wagePerWorkerDay: 5, note: "综合商店最多50名店员；其他店铺最多20名，由店铺支付", releasePriority: 70, managedBy: "shops" })
    ]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1200 }]),
    construction: Object.freeze({ workDays: 800, recommendedWorkers: 16 }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 800, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1200 }]) })
  }),
  town_hall: Object.freeze({
    id: "town_hall", name: "政务厅", icon: "🏛️",
    description: "公务员办公 · 每级10个岗位容量",
    maxInstances: 12,
    jobs: Object.freeze([Object.freeze({ id: "civil_servants", name: "公务员", slots: 10, wagePerWorkerDay: 5, note: "全镇需求按人口计算", releasePriority: 50, globalDemand: "public_service" })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 600, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]) })
  }),
  police_station: Object.freeze({
    id: "police_station", name: "警察局", icon: "🚓",
    description: "警察办公 · 每级10个岗位容量",
    maxInstances: 12,
    jobs: Object.freeze([Object.freeze({ id: "police", name: "警察", slots: 10, wagePerWorkerDay: 5, note: "全镇需求按人口计算", releasePriority: 50, globalDemand: "public_service" })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 600, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]) })
  }),
  bank: Object.freeze({
    id: "bank", name: "银行", icon: "🏦",
    description: "粮券印制、换券与注销 · 全镇限建一座",
    maxInstances: 1,
    jobs: Object.freeze([Object.freeze({ id: "bank_staff", name: "银行职员", slots: 8, capacityMode: "building", wagePerWorkerDay: 5, note: "银行日常运营", releasePriority: 55 })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 })
  }),
  social_security_office: Object.freeze({
    id: "social_security_office", name: "社保局", icon: "🛡️",
    description: "管理社保基金：缴费、养老金、注资还款与股票投资 · 全镇限建一座",
    maxInstances: 1,
    jobs: Object.freeze([Object.freeze({ id: "social_staff", name: "社保专员", slots: 6, capacityMode: "building", wagePerWorkerDay: 5, note: "社保收缴与发放", releasePriority: 55 })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 600 }]),
    construction: Object.freeze({ workDays: 500, recommendedWorkers: 10 })
  }),
  stock_exchange: Object.freeze({
    id: "stock_exchange", name: "交易所", icon: "📈",
    description: "挂牌、认购与回购 · 全镇限建一座",
    maxInstances: 1,
    jobs: Object.freeze([Object.freeze({ id: "exchange_staff", name: "交易所职员", slots: 8, capacityMode: "building", wagePerWorkerDay: 5, note: "交易登记与清算", releasePriority: 55 })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 })
  }),
  foreign_trade_house: Object.freeze({
    id: "foreign_trade_house", name: "外贸房", icon: "🚢",
    description: "对民镇贸易、长期协定与关系维护 · 至少1人在岗才能接单、关系分才回升 · 全镇限建一座",
    maxInstances: 1,
    jobs: Object.freeze([Object.freeze({ id: "trade_staff", name: "外贸职员", slots: 8, capacityMode: "building", wagePerWorkerDay: 5, note: "每人每月可跟2笔长期协定", releasePriority: 55 })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 })
  }),

  public_housing: Object.freeze({
    id: "public_housing", name: "公租住宅区", icon: "🏘️",
    description: "镇营住宅 · 每座20名管理员",
    maxInstances: 12,
    accountingSector: "housing",
    housingCapacity: 1000,
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 2000 }]),
    jobs: Object.freeze([Object.freeze({ id: "housing_managers", name: "公租房管理员", slots: 20, capacityMode: "building", wagePerWorkerDay: 5, note: "入住、维护与租务", releasePriority: 55 })]),
    construction: Object.freeze({
      workDays: 2000, recommendedWorkers: 20
    }),
    upgrade: Object.freeze({ maxLevel: 5, workDays: 2000, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 2000 }]) })
  }),

  villa_complex: Object.freeze({
    id: "villa_complex", name: "别墅群", icon: "🏰",
    description: "高档住宅区 · 每座含20栋别墅，富裕家庭可购买",
    maxInstances: 12,
    villaCapacity: 20,
    // 别墅群没有岗位；显式给空数组，否则建成后 selectDashboard 遍历 jobs 会崩溃导致界面卡死。
    jobs: Object.freeze([]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1500 }]),
    construction: Object.freeze({
      workDays: 1000, recommendedWorkers: 20
    })
  })
});

// 生产型产业：有 industryTier 的建筑（0 原料 → 1 加工 → 2 成品）。按层级从上游到下游排序。
export function industryTypeIds(content) {
  return Object.values(content.buildings)
    .filter(def => Number.isInteger(def.industryTier) && def.recipeId)
    .sort((a, b) => a.industryTier - b.industryTier || a.id.localeCompare(b.id))
    .map(def => def.id);
}

export function isIndustryType(content, typeId) {
  const def = content.buildings[typeId];
  return Boolean(def && Number.isInteger(def.industryTier) && def.recipeId);
}
