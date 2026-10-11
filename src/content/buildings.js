// 铁制工具（金银消费第二期 B）：这些建筑每天生产前备工具，每名在岗工人每日耗 perWorkerDay 件；库存够则获得 bonus 的人均产出加成（见 systems/tool-boost.js）。
const IRON_TOOL_BOOST = Object.freeze({ itemId: "iron_tool", perWorkerDay: 0.02, bonus: 0.15 });

export const BUILDINGS = Object.freeze({
  mill: Object.freeze({
    id: "mill", name: "磨坊", icon: "⚙️",
    description: "小麦磨面",
    industryTier: 1,
    maxInstances: 12,
    recipeId: "mill_flour",
    productionRoleId: "millers",
    toolBoost: IRON_TOOL_BOOST,
    jobs: Object.freeze([Object.freeze({
      id: "millers", name: "磨坊工", slots: 12, wagePerWorkerDay: 5,
      note: "每人每日最多磨160斤麦", releasePriority: 30
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 600 }]),
    construction: Object.freeze({
      workDays: 480, recommendedWorkers: 12
    }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 480, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 600 }]) })
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
    upgrade: Object.freeze({ maxLevel: 10, workDays: 400, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]) })
  }),
  lumberyard: Object.freeze({
    id: "lumberyard", name: "伐木场", icon: "🪵",
    description: "南林伐木 · 木材持续可用",
    industryTier: 0,
    maxInstances: 12,
    recipeId: "lumber_gathering",
    productionRoleId: "lumberjacks",
    toolBoost: IRON_TOOL_BOOST,
    accountingSector: "forestry",
    requiredPlotFeature: "logging_resource",
    jobs: Object.freeze([Object.freeze({
      id: "lumberjacks", name: "伐木工", slots: 20, wagePerWorkerDay: 5,
      note: "每人每日产1单位木材", releasePriority: 30
    })]),
    construction: Object.freeze({
      workDays: 200, recommendedWorkers: 10
    }),
    // 伐木场最高 50 级（每级岗位 +20，生产率见 economy/productivity.js）；每级材料与工期沿用。
    upgrade: Object.freeze({ maxLevel: 50, workDays: 200, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 100 }]) })
  }),
  saltworks: Object.freeze({
    id: "saltworks", name: "盐场", icon: "🧂",
    description: "盐矿采掘并精制食盐 · 原料持续可用",
    industryTier: 0,
    maxInstances: 12,
    recipeId: "salt_gathering",
    productionRoleId: "salt_workers",
    toolBoost: IRON_TOOL_BOOST,
    accountingSector: "salt",
    requiredPlotFeature: "salt_mine",
    jobs: Object.freeze([Object.freeze({
      id: "salt_workers", name: "盐工", slots: 10, wagePerWorkerDay: 5,
      note: "每人每日产10斤食盐", releasePriority: 30
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 100 }]),
    construction: Object.freeze({
      workDays: 300, recommendedWorkers: 10
    }),
    // 盐场最高 50 级（同伐木场）。
    upgrade: Object.freeze({ maxLevel: 50, workDays: 300, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 100 }]) })
  }),

  // 煤矿、铁矿：只能建在南林矿点（requiredPlotFeature），与盐场同机制。每级 10 个矿工岗位，每人每日 10 斤（需求闸门）。
  coal_mine: Object.freeze({
    id: "coal_mine", name: "煤矿", icon: "🪨",
    description: "南林煤矿点采煤 · 每级10个矿工岗位 · 每人每日产10斤煤（需求闸门）· 只能建在煤矿点",
    industryTier: 0,
    maxInstances: 6,
    recipeId: "coal_mining",
    productionRoleId: "coal_miners",
    toolBoost: IRON_TOOL_BOOST,
    accountingSector: "coal",
    requiredPlotFeature: "coal_mine",
    jobs: Object.freeze([Object.freeze({
      id: "coal_miners", name: "煤矿工", slots: 10, wagePerWorkerDay: 5,
      note: "每人每日产10斤煤", releasePriority: 30
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 150 }]),
    construction: Object.freeze({ workDays: 350, recommendedWorkers: 10 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 350, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 150 }]) })
  }),
  iron_mine: Object.freeze({
    id: "iron_mine", name: "铁矿", icon: "⛏️",
    description: "南林铁矿点采铁矿石 · 每级10个矿工岗位 · 每人每日产10斤铁矿石（需求闸门）· 只能建在铁矿点",
    industryTier: 0,
    maxInstances: 6,
    recipeId: "iron_mining",
    productionRoleId: "iron_miners",
    toolBoost: IRON_TOOL_BOOST,
    accountingSector: "iron",
    requiredPlotFeature: "iron_mine",
    jobs: Object.freeze([Object.freeze({
      id: "iron_miners", name: "铁矿工", slots: 10, wagePerWorkerDay: 5,
      note: "每人每日产10斤铁矿石", releasePriority: 30
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 150 }]),
    construction: Object.freeze({ workDays: 350, recommendedWorkers: 10 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 350, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 150 }]) })
  }),
  // 冶炼厂（弹性配方 smelter_work）：一名冶炼工一日 10 个产能点，铁制农具、铁制工具、金银珠宝按批发市场缺口分配产能。
  smelter: Object.freeze({
    id: "smelter", name: "冶炼厂", icon: "🔥",
    description: "铁矿石与煤冶炼农具、工具，金银条制珠宝 · 每级8个冶炼工岗位 · 每工日10个产能点，产品按市场缺口分配",
    industryTier: 1,
    maxInstances: 6,
    recipeId: "smelter_work",
    productionRoleId: "smelters",
    toolBoost: IRON_TOOL_BOOST,
    accountingSector: "smelting",
    jobs: Object.freeze([Object.freeze({
      id: "smelters", name: "冶炼工", slots: 8, wagePerWorkerDay: 5,
      note: "每人每日10个产能点（农具4点/件、工具2点/件、珠宝1点/件）", releasePriority: 40
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 500, recommendedWorkers: 10 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 500, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]) })
  }),

  // 金银店（金银消费第一期 B）：产业建筑（industryTier 2，配方 jewelry_retail 为零产出的零售配方），批发市场进珠宝、零售给居民。
  // 建筑内置一个金银店（shop kind retail，店型 jewelry，systems/jewelers.js）：首饰匠在岗即营业，接待能力 = 在岗人数 × 每人日件数 × 生产率系数。
  // 所有制、上市、民营、公司、生产税、经营计划都按产业建筑处理；利润归业主（镇库 / 业主家庭 / 公司）。
  jeweler: Object.freeze({
    id: "jeweler", name: "金银店", icon: "💍",
    description: "批发珠宝零售给居民 · 每级6个首饰匠岗位 · 每人每日接待20件（等级、熟练、教育加成另计）· 富户才买",
    industryTier: 2,
    maxInstances: 4,
    recipeId: "jewelry_retail",
    productionRoleId: "jewelers",
    accountingSector: "jewelry",
    jobs: Object.freeze([Object.freeze({
      id: "jewelers", name: "首饰匠", slots: 6, wagePerWorkerDay: 5,
      note: "每人每日接待20件珠宝（金银珠宝）", releasePriority: 40
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 600 }]),
    construction: Object.freeze({ workDays: 400, recommendedWorkers: 6 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 400, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 600 }]) })
  }),
  // 斗兽场（金银消费第四期，巨型，systems/arena.js）：镇营单级建筑（不设升级、不做所有制转换）。内置一个镇营观赛店（店型 arena，shop.arena 标记），
  // 场务在岗才开门（每人接待 40 人，每日最多 2000 游客）；猎手每人每日抓 10 只兽；存栏兽每天吃 10 斤小麦，搏斗死亡产野味。
  arena: Object.freeze({
    id: "arena", name: "斗兽场", icon: "🏟️",
    description: "观看斗兽与押注 · 每日容纳2000游客（每40名场务一人接待）· 猎手抓兽 · 兽每日吃10斤小麦 · 搏斗产野味",
    maxInstances: 1,
    jobs: Object.freeze([
      Object.freeze({ id: "hunters", name: "猎手", slots: 40, wagePerWorkerDay: 5, note: "每人每日抓10只兽（抓兽目标与存栏空位封顶）", releasePriority: 40 }),
      Object.freeze({ id: "arena_staff", name: "场务", slots: 60, wagePerWorkerDay: 5, note: "每人每日接待40名游客，全场最多2000人", releasePriority: 40 })
    ]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1000000 }]),
    construction: Object.freeze({ workDays: 3000, recommendedWorkers: 40 })
  }),
  // 酒坊：一座酒坊同时酿四种酒（配方 winery_brewing）。每名酿酒工每日一批：普通啤酒 2、高档啤酒 1、普通白酒 2、高档白酒 1 斤。
  winery: Object.freeze({
    id: "winery", name: "酒坊", icon: "🍶",
    description: "小麦酿啤酒与白酒 · 每工日 12 斤酒，四种酒按市场缺口动态分配",
    industryTier: 1,
    maxInstances: 12,
    recipeId: "winery_brewing",
    productionRoleId: "brewers",
    accountingSector: "brewing",
    jobs: Object.freeze([Object.freeze({
      id: "brewers", name: "酿酒工", slots: 8, wagePerWorkerDay: 5,
      note: "每人每日 12 斤酒（四种酒按缺口分配）；啤酒每斤 0.2 斤麦，白酒每斤 1 斤麦", releasePriority: 40
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]),
    construction: Object.freeze({ workDays: 400, recommendedWorkers: 10 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 400, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]) })
  }),
  cotton_field: Object.freeze({
    id: "cotton_field", name: "棉田", icon: "☁️",
    description: "种植棉花 · 原料持续可用",
    industryTier: 0,
    maxInstances: 12,
    recipeId: "cotton_growing",
    productionRoleId: "cotton_farmers",
    toolBoost: IRON_TOOL_BOOST,
    accountingSector: "textile",
    jobs: Object.freeze([Object.freeze({
      id: "cotton_farmers", name: "棉农", slots: 20, wagePerWorkerDay: 5,
      note: "每人每日产3斤棉花", releasePriority: 30
    })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 200 }]),
    construction: Object.freeze({ workDays: 200, recommendedWorkers: 10 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 200, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 200 }]) })
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
    upgrade: Object.freeze({ maxLevel: 10, workDays: 400, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 500 }]) })
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
    upgrade: Object.freeze({ maxLevel: 10, workDays: 700, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1000 }]) })
  }),

  commercial_street: Object.freeze({
    id: "commercial_street", name: "商业街", icon: "🏬",
    description: "居民开店 · 每级2间铺位",
    maxInstances: 12,
    shopHost: Object.freeze({ slotsPerLevel: 2 }),
    jobs: Object.freeze([
      Object.freeze({ id: "merchants", name: "商人", slots: 8, wagePerWorkerDay: 5, note: "每间店最多4名商人，由店铺支付", releasePriority: 60, managedBy: "shops", shopRole: "merchant" }),
      Object.freeze({ id: "shop_clerks", name: "店员", slots: 100, wagePerWorkerDay: 5, note: "综合商店最多50名店员；其他店铺最多20名，由店铺支付", releasePriority: 70, managedBy: "shops", shopRole: "clerk" })
    ]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1200 }]),
    construction: Object.freeze({ workDays: 800, recommendedWorkers: 16 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 800, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1200 }]) })
  }),
  // 贸易中心：和商业街一样的宿主建筑，镇长在铺位上开"贸易行"（店铺 kind "trade"）；贸易行每天自己做外镇买卖（docs/TRADE.md）。
  trade_center: Object.freeze({
    id: "trade_center", name: "贸易中心", icon: "⚖️",
    description: "居民开贸易行 · 每级2间铺位 · 贸易行每天做外镇买卖",
    maxInstances: 6,
    shopHost: Object.freeze({ slotsPerLevel: 2 }),
    jobs: Object.freeze([
      Object.freeze({ id: "merchants", name: "商人", slots: 8, wagePerWorkerDay: 5, note: "每间贸易行最多4名商人，由店铺支付", releasePriority: 60, managedBy: "shops", shopRole: "merchant" }),
      Object.freeze({ id: "shop_clerks", name: "店员", slots: 100, wagePerWorkerDay: 5, note: "每间贸易行最多20名店员，由店铺支付", releasePriority: 70, managedBy: "shops", shopRole: "clerk" })
    ]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1200 }]),
    construction: Object.freeze({ workDays: 800, recommendedWorkers: 16 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 800, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1200 }]) })
  }),
  // 养殖基地：和商业街一样由居民入驻经营，每级 4 个养殖场位（鸡/鸭/鹅/猪）。
  livestock_base: Object.freeze({
    id: "livestock_base", name: "养殖基地", icon: "🐖",
    description: "居民开养殖场 · 每级4个场位",
    maxInstances: 12,
    shopHost: Object.freeze({ slotsPerLevel: 4 }),
    jobs: Object.freeze([
      Object.freeze({ id: "farm_owners", name: "养殖户", slots: 16, wagePerWorkerDay: 5, note: "每个养殖场最多4名养殖户，店主拿利润", releasePriority: 60, managedBy: "shops", shopRole: "merchant" }),
      Object.freeze({ id: "farm_hands", name: "饲养员", slots: 80, wagePerWorkerDay: 5, note: "每个养殖场最多20名，由养殖场支付", releasePriority: 70, managedBy: "shops", shopRole: "clerk" })
    ]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1000 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 600, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1000 }]) })
  }),
  // 时代广场：每级 50 个摊位，每摊最多 2 人；允许摆摊人数和摊租在政策里定。
  times_square: Object.freeze({
    id: "times_square", name: "时代广场", icon: "🎪",
    description: "居民摆摊 · 每级50个摊位",
    maxInstances: 4,
    shopHost: Object.freeze({ slotsPerLevel: 50 }),
    jobs: Object.freeze([
      Object.freeze({ id: "stall_keepers", name: "摊贩", slots: 100, wagePerWorkerDay: 0, note: "每摊最多2人，自负盈亏", releasePriority: 80, managedBy: "shops", shopRole: "merchant" })
    ]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 500, recommendedWorkers: 10 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 500, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]) })
  }),
  town_hall: Object.freeze({
    id: "town_hall", name: "政务厅", icon: "🏛️",
    description: "公务员办公 · 每级10个岗位容量",
    maxInstances: 12,
    jobs: Object.freeze([Object.freeze({ id: "civil_servants", name: "公务员", slots: 10, wagePerWorkerDay: 5, note: "全镇需求按人口计算", releasePriority: 50, globalDemand: "public_service" })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 600, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]) })
  }),
  police_station: Object.freeze({
    id: "police_station", name: "警察局", icon: "🚓",
    description: "警察办公 · 每级10个岗位容量",
    maxInstances: 12,
    jobs: Object.freeze([Object.freeze({ id: "police", name: "警察", slots: 10, wagePerWorkerDay: 5, note: "全镇需求按人口计算", releasePriority: 50, globalDemand: "public_service" })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 600, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]) })
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
    description: "对民镇贸易、长期协定与关系维护 · 至少1人在岗才能接单、关系分才回升 · 全镇限建一座 · 可建在河岸地块",
    maxInstances: 1,
    allowedPlotFeatures: Object.freeze(["riverside"]),
    jobs: Object.freeze([Object.freeze({ id: "trade_staff", name: "外贸职员", slots: 8, capacityMode: "building", wagePerWorkerDay: 5, note: "每人每月可跟2笔长期协定", releasePriority: 55 })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 800 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 })
  }),
  // 物流中心：脚夫搬运，每人每日运力 rules.logisticsJinPerWorker；每级 20 个岗位，可建多座。
  logistics_center: Object.freeze({
    id: "logistics_center", name: "物流中心", icon: "🛒",
    description: "脚夫搬运 · 每级20个脚夫岗位 · 每人每日基础运力60斤（等级、熟练、教育加成另计）· 可建多座",
    maxInstances: 6,
    jobs: Object.freeze([Object.freeze({ id: "porters", name: "脚夫", slots: 20, wagePerWorkerDay: 5, note: "每人每日运力60斤", releasePriority: 55 })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1000 }]),
    construction: Object.freeze({ workDays: 600, recommendedWorkers: 12 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 600, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1000 }]) })
  }),
  // 码头：只能建在河岸地块；码头工每人每日运力 rules.dockJinPerWorker（脚夫的 2 倍）。
  dock: Object.freeze({
    id: "dock", name: "码头", icon: "⚓",
    description: "河岸码头 · 每级20个码头工岗位 · 每人每日基础运力120斤（等级、熟练、教育加成另计）· 只能建在河岸地块",
    maxInstances: 4,
    requiredPlotFeature: "riverside",
    allowedPlotFeatures: Object.freeze(["riverside"]),
    jobs: Object.freeze([Object.freeze({ id: "dockers", name: "码头工", slots: 20, wagePerWorkerDay: 5, note: "每人每日运力120斤", releasePriority: 55 })]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 2000 }]),
    construction: Object.freeze({ workDays: 1000, recommendedWorkers: 16 }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 800, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1500 }]) })
  }),

  public_housing: Object.freeze({
    id: "public_housing", name: "公租住宅区", icon: "🏘️",
    description: "镇营住宅 · 每座20名管理员",
    maxInstances: 12,
    accountingSector: "housing",
    housingCapacity: 2000,
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 2000 }]),
    jobs: Object.freeze([Object.freeze({ id: "housing_managers", name: "公租房管理员", slots: 20, capacityMode: "building", wagePerWorkerDay: 5, note: "入住、维护与租务", releasePriority: 55 })]),
    construction: Object.freeze({
      workDays: 2000, recommendedWorkers: 20
    }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 2000, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 2000 }]) })
  }),

  villa_complex: Object.freeze({
    id: "villa_complex", name: "别墅群", icon: "🏰",
    description: "高档住宅区 · 每级20栋别墅，富裕家庭可购买",
    maxInstances: 12,
    // 每级可售别墅栋数：容量 = villaCapacity × 等级（见 systems/villas.js）。
    villaCapacity: 20,
    // 别墅群没有岗位；显式给空数组，否则建成后 selectDashboard 遍历 jobs 会崩溃导致界面卡死。
    jobs: Object.freeze([]),
    materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1500 }]),
    construction: Object.freeze({
      workDays: 1000, recommendedWorkers: 20
    }),
    upgrade: Object.freeze({ maxLevel: 10, workDays: 1000, materialRequirements: Object.freeze([{ itemId: "wood", quantity: 1500 }]) })
  })
});

// 生产型产业：有 industryTier 的建筑（0 原料 → 1 加工 → 2 成品）。按层级从上游到下游排序。
export function industryTypeIds(content) {
  return Object.values(content.buildings)
    .filter(def => Number.isInteger(def.industryTier) && def.recipeId)
    .sort((a, b) => a.industryTier - b.industryTier || a.id.localeCompare(b.id))
    .map(def => def.id);
}

// 零售型产业（金银店）：配方带 retail 标记，产业流水线不生产（店铺经营，见 systems/jewelers.js），不进经营计划的产量与用工计划。
export function isRetailIndustryType(content, typeId) {
  return Boolean(content.recipes[content.buildings[typeId]?.recipeId]?.retail);
}

export function isIndustryType(content, typeId) {
  const def = content.buildings[typeId];
  return Boolean(def && Number.isInteger(def.industryTier) && def.recipeId);
}
