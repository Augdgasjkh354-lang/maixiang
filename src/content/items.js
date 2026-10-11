// 流通标记：wholesale 批发市场做市；retail 综合商店上架；storeOnly 只能经综合商店卖给居民。
export const ITEMS = Object.freeze({
  wheat: Object.freeze({
    id: "wheat", name: "小麦", unit: "斤", category: "grain",
    edible: true, qeq: Object.freeze({ numerator: 1, denominator: 1 }),
    consumptionPriority: 30, transferPriority: 30, openingCostWheatPerJin: 1
  }),
  flour: Object.freeze({
    wholesale: true, retail: true, storeOnly: true,
    id: "flour", name: "面粉", unit: "斤", category: "food",
    edible: true, qeq: Object.freeze({ numerator: 1, denominator: 1 }),
    consumptionPriority: 20, transferPriority: 20, openingCostWheatPerJin: 1
  }),
  bread: Object.freeze({
    wholesale: true, retail: true, storeOnly: true,
    id: "bread", name: "面包", unit: "斤", category: "food",
    edible: true, qeq: Object.freeze({ numerator: 5, denominator: 6 }),
    satisfactionPerQeq: 1,
    consumptionPriority: 10, transferPriority: 10, openingCostWheatPerJin: 5 / 6
  }),
  wood: Object.freeze({
    wholesale: true, retail: true,
    id: "wood", name: "木材", unit: "单位", category: "material",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  salt: Object.freeze({
    wholesale: true, retail: true, storeOnly: true,
    id: "salt", name: "食盐", unit: "斤", category: "household",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  // 酒：享受品，不算口粮，四种（啤酒/白酒 × 普通/高档），由酒坊一座同时酿出。普通款面向所有人，高档款只有宽裕人家买（见 rules.householdGoods）。
  // liquor 标记：酒类专售令（policy.liquorMonopoly）开启后，综合商店与时代广场停售，居民只向酒馆买。
  // 棉花：织布原料。布：日用必需品（按匹）。
  beer: Object.freeze({
    wholesale: true, retail: true, storeOnly: true,
    id: "beer", name: "普通啤酒", unit: "斤", category: "household",
    edible: false, qeq: null, openingCostWheatPerJin: 0, optionalRetail: true, liquor: true
  }),
  beer_premium: Object.freeze({
    wholesale: true, retail: true, storeOnly: true,
    id: "beer_premium", name: "高档啤酒", unit: "斤", category: "household",
    edible: false, qeq: null, openingCostWheatPerJin: 0, optionalRetail: true, liquor: true
  }),
  baijiu: Object.freeze({
    wholesale: true, retail: true, storeOnly: true,
    id: "baijiu", name: "普通白酒", unit: "斤", category: "household",
    edible: false, qeq: null, openingCostWheatPerJin: 0, optionalRetail: true, liquor: true
  }),
  baijiu_premium: Object.freeze({
    wholesale: true, retail: true, storeOnly: true,
    id: "baijiu_premium", name: "高档白酒", unit: "斤", category: "household",
    edible: false, qeq: null, openingCostWheatPerJin: 0, optionalRetail: true, liquor: true
  }),
  cotton: Object.freeze({
    wholesale: true,
    id: "cotton", name: "棉花", unit: "斤", category: "material",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  cloth: Object.freeze({
    wholesale: true, retail: true, storeOnly: true,
    id: "cloth", name: "布", unit: "匹", category: "household",
    edible: false, qeq: null, openingCostWheatPerJin: 0, optionalRetail: true
  }),
  // 煤、铁矿石：南林矿点开采（煤矿、铁矿），冶炼厂原料。批发品，不上货架。
  coal: Object.freeze({
    wholesale: true,
    id: "coal", name: "煤", unit: "斤", category: "material",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  iron_ore: Object.freeze({
    wholesale: true,
    id: "iron_ore", name: "铁矿石", unit: "斤", category: "material",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  // 金银珠宝、铁器：冶炼厂产品，按件计。珠宝经金银店零售（见上）；铁器暂无需求侧（第二期）。
  // 珠宝：批发 + 零售（第一期 B）。居民只能经金银店买（retailShopTypeIds 限定店型，不进综合商店、酒馆、集市）。
  gold_jewelry: Object.freeze({
    wholesale: true, retail: true, storeOnly: true, optionalRetail: true, retailShopTypeIds: Object.freeze(["jewelry"]),
    id: "gold_jewelry", name: "黄金珠宝", unit: "件", category: "valuable",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  silver_jewelry: Object.freeze({
    wholesale: true, retail: true, storeOnly: true, optionalRetail: true, retailShopTypeIds: Object.freeze(["jewelry"]),
    id: "silver_jewelry", name: "白银珠宝", unit: "件", category: "valuable",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  iron_farm_tool: Object.freeze({
    wholesale: true,
    id: "iron_farm_tool", name: "铁制农具", unit: "件", category: "tool",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  iron_tool: Object.freeze({
    wholesale: true,
    id: "iron_tool", name: "铁制工具", unit: "件", category: "tool",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  // 肉：养殖基地产，算主食：1 斤肉顶 2 斤口粮（qeq 2:1），家里有肉先吃肉。越宽裕的人家主食里肉越多（market.js 的 meatStapleShare）。
  // 养殖场直接卖给综合商店，多余的卖给批发市场。
  chicken: Object.freeze({
    wholesale: true, retail: true, storeOnly: true, livestock: true,
    id: "chicken", name: "鸡肉", unit: "斤", category: "food",
    edible: true, qeq: Object.freeze({ numerator: 2, denominator: 1 }),
    consumptionPriority: 5, transferPriority: 5, openingCostWheatPerJin: 2, optionalRetail: true
  }),
  duck: Object.freeze({
    wholesale: true, retail: true, storeOnly: true, livestock: true,
    id: "duck", name: "鸭肉", unit: "斤", category: "food",
    edible: true, qeq: Object.freeze({ numerator: 2, denominator: 1 }),
    consumptionPriority: 5, transferPriority: 5, openingCostWheatPerJin: 2, optionalRetail: true
  }),
  goose: Object.freeze({
    wholesale: true, retail: true, storeOnly: true, livestock: true,
    id: "goose", name: "鹅肉", unit: "斤", category: "food",
    edible: true, qeq: Object.freeze({ numerator: 2, denominator: 1 }),
    consumptionPriority: 5, transferPriority: 5, openingCostWheatPerJin: 2, optionalRetail: true
  }),
  pork: Object.freeze({
    wholesale: true, retail: true, storeOnly: true, livestock: true,
    id: "pork", name: "猪肉", unit: "斤", category: "food",
    edible: true, qeq: Object.freeze({ numerator: 2, denominator: 1 }),
    consumptionPriority: 5, transferPriority: 5, openingCostWheatPerJin: 2, optionalRetail: true
  })
});
