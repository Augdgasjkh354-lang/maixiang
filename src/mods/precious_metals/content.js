// 贵金属 mod · 内容（纯数据，不能 import 系统代码）。
// 民镇每年产银条 5000 斤，王镇每年产金条 500 斤，产量逐年增加 5%（mine 字段，见 systems/outside-town.js）。
// 银条、金条不是批发品、不上货架、不进综合商店：只能用小麦向外镇买（手动外贸面板），也可以卖回外镇。
// 价格单位一律是"每斤值多少斤小麦"：银条开局 1000，金条开局 10000。行为与校验见 mod.js。

export default {
  id: "precious_metals",

  // 银条、金条：category valuable，不可食用，不带 wholesale / retail / storeOnly 标记。
  items: {
    silver_bar: { id: "silver_bar", name: "银条", unit: "斤", category: "valuable", edible: false, qeq: null, openingCostWheatPerJin: 0 },
    gold_bar: { id: "gold_bar", name: "金条", unit: "斤", category: "valuable", edible: false, qeq: null, openingCostWheatPerJin: 0 }
  },

  // 外镇商品档案（同 content/outside-towns.js）。mine 是矿产扩展：
  //   annualOutputJin      当年产量（斤/年），每天平均入库，开局即为档案值
  //   annualGrowthPercent  每年年初产量增长百分比（取整，至少 +1 斤）
  //   stockMaxYears       库存上限 = 当年产量 × 此倍数（默认 3），超出部分不再入库
  // 开局库存 = 一年产量，玩家可以立即购买。basePrice 直接是开局买价（斤小麦/斤），不套 exportPrice 的 ×1.2。
  outsideTownGoods: {
    minzhen: {
      silver_bar: {
        basePrice: 1000, needPerPersonDay: 0, producePerPersonDay: 0, targetDays: 360, stock: 5000,
        sellsToUs: true, supplyWeight: 0,
        mine: { annualOutputJin: 5000, annualGrowthPercent: 5, stockMaxYears: 3 }
      }
    },
    wangzhen: {
      gold_bar: {
        basePrice: 10000, needPerPersonDay: 0, producePerPersonDay: 0, targetDays: 360, stock: 500,
        sellsToUs: true, supplyWeight: 0,
        mine: { annualOutputJin: 500, annualGrowthPercent: 5, stockMaxYears: 3 }
      }
    }
  }
};
