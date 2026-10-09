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
  // 酒：享受品，不算口粮。棉花：织布原料。布：日用必需品（按匹）。
  wine: Object.freeze({
    wholesale: true, retail: true, storeOnly: true,
    id: "wine", name: "酒", unit: "斤", category: "household",
    edible: false, qeq: null, openingCostWheatPerJin: 0, optionalRetail: true
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
