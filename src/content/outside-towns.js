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
// 我方出口品（盐、木材、酒、布）的外镇基准价整体抬高这个倍数（外贸稳定性改动：让出口更有利可图）。
const EXPORT_PRICE_FACTOR = 1.2;
const exportPrice = price => price * EXPORT_PRICE_FACTOR;
// 初始人口 12000、耕地 60000 亩；库存与初始小麦按人口相对 6000 放大（× 2），人均初始库存不变（原档 6000 人 / 3 万亩，世界规模翻倍）。

export const OUTSIDE_TOWNS = Object.freeze({
  minzhen: Object.freeze({
    id: "minzhen",
    name: "民镇",
    rulers: Object.freeze(["民镇议事会"]),
    description: "农业小镇，盛产小麦，自产面粉面包；盐、木材完全不产，全靠我方供给。",
    population: 12000,
    landMu: 60000,
    // 每年开垦的新耕地；耕地决定口粮上限，从而决定人口能长多大。
    landGrowthMuPerYear: 1000,
    yieldPerMuJin: 300,
    foodPerPersonDayJin: 2,
    wheatStockJin: 10285714,
    // 口粮储备：付货款、还贷款都不会动用这部分小麦。
    foodReserveDays: 90,
    prosperity: 60,
    relations: 60,
    goods: Object.freeze({
      salt: Object.freeze({ basePrice: exportPrice(P.salt), needPerPersonDay: 10 / 365, producePerPersonDay: 0, targetDays: 240, stock: 68572, sellsToUs: false, supplyWeight: 0.35 }),
      wood: Object.freeze({ basePrice: exportPrice(P.wood), needPerPersonDay: 4 / 365, producePerPersonDay: 0, targetDays: 240, stock: 27428, sellsToUs: false, supplyWeight: 0.2 }),
      flour: Object.freeze({ basePrice: P.flour, needPerPersonDay: 0.15, producePerPersonDay: 0.155, targetDays: 60, stock: 108000, sellsToUs: true, supplyWeight: 0 }),
      bread: Object.freeze({ basePrice: P.bread, needPerPersonDay: 0.1, producePerPersonDay: 0.103, targetDays: 45, stock: 54000, sellsToUs: true, supplyWeight: 0 }),
      // 民镇自己酿一些酒、织一些布，不够的部分从外面买。酒按四种拆：年人均需求合计 6 斤、自产合计 4 斤（原 wine 的口径）。
      beer: Object.freeze({ basePrice: exportPrice(P.beer), needPerPersonDay: 4 / 365, producePerPersonDay: 3 / 365, targetDays: 90, stock: 11836, sellsToUs: false, supplyWeight: 0.03 }),
      beer_premium: Object.freeze({ basePrice: exportPrice(P.beer_premium), needPerPersonDay: 0.2 / 365, producePerPersonDay: 0, targetDays: 90, stock: 592, sellsToUs: false, supplyWeight: 0.01 }),
      baijiu: Object.freeze({ basePrice: exportPrice(P.baijiu), needPerPersonDay: 1.6 / 365, producePerPersonDay: 1 / 365, targetDays: 90, stock: 4734, sellsToUs: false, supplyWeight: 0.02 }),
      baijiu_premium: Object.freeze({ basePrice: exportPrice(P.baijiu_premium), needPerPersonDay: 0.2 / 365, producePerPersonDay: 0, targetDays: 90, stock: 592, sellsToUs: false, supplyWeight: 0.01 }),
      cloth: Object.freeze({ basePrice: exportPrice(P.cloth), needPerPersonDay: 1 / 365, producePerPersonDay: 0.55 / 365, targetDays: 180, stock: 5828, sellsToUs: false, supplyWeight: 0.1 })
    })
  }),
  // 王镇：规模与民镇相同（待调），但几乎不产布、少酿酒，更看重布和酒——我镇新产业的主要买家。
  wangzhen: Object.freeze({
    id: "wangzhen",
    name: "王镇",
    rulers: Object.freeze(["王氏宗族"]),
    description: "宗族治理的富庶小镇，讲究衣着、好饮酒；布几乎全靠外购，盐木同样不产。",
    population: 12000,
    landMu: 60000,
    landGrowthMuPerYear: 1000,
    yieldPerMuJin: 300,
    foodPerPersonDayJin: 2,
    wheatStockJin: 10285714,
    foodReserveDays: 90,
    prosperity: 60,
    relations: 50,
    goods: Object.freeze({
      salt: Object.freeze({ basePrice: exportPrice(P.salt), needPerPersonDay: 10 / 365, producePerPersonDay: 0, targetDays: 240, stock: 68572, sellsToUs: false, supplyWeight: 0.25 }),
      wood: Object.freeze({ basePrice: exportPrice(P.wood), needPerPersonDay: 4 / 365, producePerPersonDay: 0, targetDays: 240, stock: 27428, sellsToUs: false, supplyWeight: 0.15 }),
      flour: Object.freeze({ basePrice: P.flour, needPerPersonDay: 0.15, producePerPersonDay: 0.155, targetDays: 60, stock: 108000, sellsToUs: true, supplyWeight: 0 }),
      bread: Object.freeze({ basePrice: P.bread, needPerPersonDay: 0.1, producePerPersonDay: 0.103, targetDays: 45, stock: 54000, sellsToUs: true, supplyWeight: 0 }),
      // 王镇讲究饮酒：酒按四种拆，年人均需求合计 10 斤（原 wine 口径），自产合计 2 斤；酒价 × 1.2。
      beer: Object.freeze({ basePrice: exportPrice(P.beer * 1.2), needPerPersonDay: 6 / 365, producePerPersonDay: 1 / 365, targetDays: 90, stock: 17753, sellsToUs: false, supplyWeight: 0.04 }),
      beer_premium: Object.freeze({ basePrice: exportPrice(P.beer_premium * 1.2), needPerPersonDay: 1.2 / 365, producePerPersonDay: 0, targetDays: 90, stock: 3551, sellsToUs: false, supplyWeight: 0.02 }),
      baijiu: Object.freeze({ basePrice: exportPrice(P.baijiu * 1.2), needPerPersonDay: 2.6 / 365, producePerPersonDay: 1 / 365, targetDays: 90, stock: 7693, sellsToUs: false, supplyWeight: 0.03 }),
      baijiu_premium: Object.freeze({ basePrice: exportPrice(P.baijiu_premium * 1.2), needPerPersonDay: 0.2 / 365, producePerPersonDay: 0, targetDays: 90, stock: 592, sellsToUs: false, supplyWeight: 0.01 }),
      cloth: Object.freeze({ basePrice: exportPrice(P.cloth * 1.2), needPerPersonDay: 1.5 / 365, producePerPersonDay: 0.1 / 365, targetDays: 180, stock: 5142, sellsToUs: false, supplyWeight: 0.2 })
    })
  })
});

export const DEFAULT_OUTSIDE_TOWN_ID = "minzhen";
