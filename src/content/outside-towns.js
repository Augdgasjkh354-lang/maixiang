// 外镇档案：每个外镇只是一份数据，算法全部共用（src/systems/outside-town.js）。
// 加新外镇 = 在这里加一份档案。
//
// 单位：小麦、面粉、面包、盐按斤，木材按单位；价格一律是"每单位值多少斤小麦"。
// goods 里每样商品：
//   basePrice            外镇的中间价 = 本镇中间价（rules.marketPricesVoucherPerUnit）× 档案系数，本镇调价外镇跟着变
//   needPerPersonDay     每人每天消耗
//   producePerPersonDay  每人每天自产（0 = 完全靠进口）
//   targetDays           理想库存 = 多少天的消耗；库存低于它就涨价，高于它就跌价
//   sellsToUs            是否愿意把多余的卖给我们
//   supplyWeight         对繁荣度的影响权重（缺了它民心受多大影响）
// 小麦是外镇的口粮兼结算货币：每年收一次（耕地 × 亩产 × 天气），每天按人口吃掉。

import { RULES } from "./rules.js";

const P = RULES.marketPricesVoucherPerUnit;

export const OUTSIDE_TOWNS = Object.freeze({
  minzhen: Object.freeze({
    id: "minzhen",
    name: "民镇",
    rulers: Object.freeze(["民镇议事会"]),
    description: "农业小镇，盛产小麦，自产面粉面包；盐、木材完全不产，全靠我方供给。",
    population: 3500,
    landMu: 10000,
    // 每年开垦的新耕地；耕地决定口粮上限，从而决定人口能长多大。
    landGrowthMuPerYear: 500,
    yieldPerMuJin: 300,
    foodPerPersonDayJin: 2,
    wheatStockJin: 3000000,
    // 口粮储备：付货款、还贷款都不会动用这部分小麦。
    foodReserveDays: 90,
    prosperity: 60,
    relations: 60,
    goods: Object.freeze({
      salt: Object.freeze({ basePrice: P.salt, needPerPersonDay: 10 / 365, producePerPersonDay: 0, targetDays: 240, stock: 20000, sellsToUs: false, supplyWeight: 0.35 }),
      wood: Object.freeze({ basePrice: P.wood, needPerPersonDay: 4 / 365, producePerPersonDay: 0, targetDays: 240, stock: 8000, sellsToUs: false, supplyWeight: 0.2 }),
      flour: Object.freeze({ basePrice: P.flour, needPerPersonDay: 0.15, producePerPersonDay: 0.155, targetDays: 60, stock: 31500, sellsToUs: true, supplyWeight: 0 }),
      bread: Object.freeze({ basePrice: P.bread, needPerPersonDay: 0.1, producePerPersonDay: 0.103, targetDays: 45, stock: 15750, sellsToUs: true, supplyWeight: 0 }),
      // 民镇自己酿一些酒、织一些布，不够的部分从外面买。
      wine: Object.freeze({ basePrice: P.wine, needPerPersonDay: 6 / 365, producePerPersonDay: 4 / 365, targetDays: 90, stock: 5200, sellsToUs: false, supplyWeight: 0.05 }),
      cloth: Object.freeze({ basePrice: P.cloth, needPerPersonDay: 1 / 365, producePerPersonDay: 0.55 / 365, targetDays: 180, stock: 1700, sellsToUs: false, supplyWeight: 0.1 })
    })
  }),
  // 王镇：规模与民镇相同（待调），但几乎不产布、少酿酒，更看重布和酒——我镇新产业的主要买家。
  wangzhen: Object.freeze({
    id: "wangzhen",
    name: "王镇",
    rulers: Object.freeze(["王氏宗族"]),
    description: "宗族治理的富庶小镇，讲究衣着、好饮酒；布几乎全靠外购，盐木同样不产。",
    population: 3500,
    landMu: 10000,
    landGrowthMuPerYear: 500,
    yieldPerMuJin: 300,
    foodPerPersonDayJin: 2,
    wheatStockJin: 3000000,
    foodReserveDays: 90,
    prosperity: 60,
    relations: 50,
    goods: Object.freeze({
      salt: Object.freeze({ basePrice: P.salt, needPerPersonDay: 10 / 365, producePerPersonDay: 0, targetDays: 240, stock: 20000, sellsToUs: false, supplyWeight: 0.25 }),
      wood: Object.freeze({ basePrice: P.wood, needPerPersonDay: 4 / 365, producePerPersonDay: 0, targetDays: 240, stock: 8000, sellsToUs: false, supplyWeight: 0.15 }),
      flour: Object.freeze({ basePrice: P.flour, needPerPersonDay: 0.15, producePerPersonDay: 0.155, targetDays: 60, stock: 31500, sellsToUs: true, supplyWeight: 0 }),
      bread: Object.freeze({ basePrice: P.bread, needPerPersonDay: 0.1, producePerPersonDay: 0.103, targetDays: 45, stock: 15750, sellsToUs: true, supplyWeight: 0 }),
      wine: Object.freeze({ basePrice: P.wine * 1.2, needPerPersonDay: 10 / 365, producePerPersonDay: 2 / 365, targetDays: 90, stock: 6000, sellsToUs: false, supplyWeight: 0.1 }),
      cloth: Object.freeze({ basePrice: P.cloth * 1.2, needPerPersonDay: 1.5 / 365, producePerPersonDay: 0.1 / 365, targetDays: 180, stock: 1500, sellsToUs: false, supplyWeight: 0.2 })
    })
  })
});

export const DEFAULT_OUTSIDE_TOWN_ID = "minzhen";
