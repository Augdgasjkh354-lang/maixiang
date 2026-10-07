export const ITEMS = Object.freeze({
  wheat: Object.freeze({
    id: "wheat", name: "小麦", unit: "斤", category: "grain",
    edible: true, qeq: Object.freeze({ numerator: 1, denominator: 1 }),
    consumptionPriority: 30, transferPriority: 30, openingCostWheatPerJin: 1
  }),
  flour: Object.freeze({
    id: "flour", name: "面粉", unit: "斤", category: "food",
    edible: true, qeq: Object.freeze({ numerator: 1, denominator: 1 }),
    consumptionPriority: 20, transferPriority: 20, openingCostWheatPerJin: 1
  }),
  bread: Object.freeze({
    id: "bread", name: "面包", unit: "斤", category: "food",
    edible: true, qeq: Object.freeze({ numerator: 5, denominator: 6 }),
    satisfactionPerQeq: 1,
    consumptionPriority: 10, transferPriority: 10, openingCostWheatPerJin: 5 / 6
  }),
  wood: Object.freeze({
    id: "wood", name: "木材", unit: "单位", category: "material",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  }),
  salt: Object.freeze({
    id: "salt", name: "食盐", unit: "斤", category: "household",
    edible: false, qeq: null, openingCostWheatPerJin: 0
  })
});
