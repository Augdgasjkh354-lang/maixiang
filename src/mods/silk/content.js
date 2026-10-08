// 丝绸 mod · 内容（纯数据，不能 import 系统代码）。
// 桑园（原料产业，tier 0）种桑养蚕缫丝，每名桑农每天产 10 斤丝绸，等级与熟练度照常加成。
// 丝绸是富人的日用品：综合商店零售（只能经商店卖给居民，后加的零售品），收入弹性高，穷户几乎不买；
// 批发市场做市，民镇、王镇两个外镇也进口丝绸（王镇更富，出价高）。行为见 mod.js。
// 价格单位一律是"每单位值多少斤小麦"（1 券 ≈ 1 斤小麦）。

export default {
  id: "silk",

  items: {
    // 丝绸：批发市场做市 + 综合商店零售（只能经商店卖给居民）+ 后加零售品。
    silk: { id: "silk", name: "丝绸", unit: "斤", category: "household", edible: false, qeq: null, openingCostWheatPerJin: 0,
      wholesale: true, retail: true, storeOnly: true, optionalRetail: true }
  },

  recipes: {
    // 采桑缫丝：不需要原料。每人每日缫出 10 斤丝绸（一批 10 斤，每人每日一批）。
    silk_reeling: { id: "silk_reeling", name: "采桑缫丝", kind: "gather", inputs: [], outputs: [{ itemId: "silk", quantity: 10 }], losses: [], batchesPerWorkerDay: 1, demandGated: true }
  },

  buildings: {
    // 桑园：原料产业（tier 0），可民营、成立公司。开工要木材 800（比茶园重，桑树要成林）。
    mulberry_garden: {
      id: "mulberry_garden", name: "桑园", icon: "🌳", description: "种桑养蚕缫丝 · 每人每日产丝绸 10 斤",
      industryTier: 0, maxInstances: 6,
      recipeId: "silk_reeling", productionRoleId: "mulberry_farmers", accountingSector: "silk",
      jobs: [{ id: "mulberry_farmers", name: "桑农", slots: 10, wagePerWorkerDay: 5, note: "每人每日产丝绸 10 斤", releasePriority: 30 }],
      materialRequirements: [{ itemId: "wood", quantity: 800 }],
      construction: { workDays: 300, recommendedWorkers: 10 },
      upgrade: { maxLevel: 10, workDays: 300, materialRequirements: [{ itemId: "wood", quantity: 800 }] }
    }
  },

  rules: {
    // 本镇中间价：丝绸每斤约 100 斤小麦，是镇上最贵的日用品（茶叶 6、陶器 8、布 18）。
    marketPricesVoucherPerUnit: { silk: 100 },
    // 批发市场默认售价（卖给综合商店）略高于中间价；默认收购价（向桑园收购）低于中间价。
    wholesaleDefaultSalePrices: { silk: 105 },
    wholesaleDefaultPurchasePrices: { silk: 85 },
    // 居民日用品：正常人家年人均 0.3 斤；收入弹性 2.0（穷户几乎不买，富户买得多）；用到标准量加舒心值 2 分。
    householdGoods: {
      silk: { annualPerPerson: 0.3, incomeElasticity: 2.0, comfortMaximum: 2 }
    }
  },

  // 外镇进口丝绸（不自产、不卖给我们）。民镇寻常，王镇富庶、出价高两成、年耗更多。
  outsideTownGoods: {
    minzhen: { silk: { basePrice: 100, needPerPersonDay: 0.2 / 365, producePerPersonDay: 0, targetDays: 180, stock: 350, sellsToUs: false, supplyWeight: 0.03 } },
    wangzhen: { silk: { basePrice: 120, needPerPersonDay: 0.5 / 365, producePerPersonDay: 0, targetDays: 180, stock: 800, sellsToUs: false, supplyWeight: 0.08 } }
  },

  initialState: {},

  save: { entityMaps: [], renames: [] }
};
