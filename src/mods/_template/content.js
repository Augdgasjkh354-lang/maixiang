// mod 模板 · 内容（纯数据，不能 import 系统代码）。复制整个 _template 文件夹改名即可开始。
// 本模板没有登记，不会进游戏；登记方法见 MODDING.md。
// 下面以"茶叶"为例：茶园（原料产业）产茶叶，居民买来喝加舒心值，外镇也收。

export default {
  id: "_template",

  // 新物品。价格单位一律是"每单位值多少斤小麦"。
  // 流通标记：wholesale 进批发市场做市；retail 上综合商店货架；storeOnly 只能经综合商店卖给居民。
  items: {
    tea_leaf: { id: "tea_leaf", name: "茶叶", unit: "斤", category: "household", edible: false, qeq: null, openingCostWheatPerJin: 0,
      wholesale: true, retail: true, storeOnly: true, optionalRetail: true }
  },

  // 配方：kind "gather" 表示不需要原料（采集/种植）；加工配方写 inputs。
  recipes: {
    tea_picking: { id: "tea_picking", name: "采茶", kind: "gather", inputs: [], outputs: [{ itemId: "tea_leaf", quantity: 2 }], losses: [], batchesPerWorkerDay: 1 }
  },

  // 建筑：带 industryTier 的就是生产产业（0 原料 / 1 加工 / 2 成品），自动支持镇营、民营、公司、生产税、熟练度。
  // 每个建筑必须有 jobs 数组。
  buildings: {
    tea_garden: {
      id: "tea_garden", name: "茶园", icon: "🍵", description: "种茶采茶", industryTier: 0, maxInstances: 12,
      recipeId: "tea_picking", productionRoleId: "tea_pickers", accountingSector: "tea",   // 产业账本名，自动建账
      jobs: [{ id: "tea_pickers", name: "采茶工", slots: 12, wagePerWorkerDay: 5, note: "每人每日采2斤茶", releasePriority: 30 }],
      materialRequirements: [{ itemId: "wood", quantity: 200 }],
      construction: { workDays: 200, recommendedWorkers: 10 },
      upgrade: { maxLevel: 10, workDays: 200, materialRequirements: [{ itemId: "wood", quantity: 200 }] }
    }
  },

  // 规则参数：对象型参数会和核心逐键合并。
  rules: {
    marketPricesVoucherPerUnit: { tea_leaf: 6 },          // 本镇中间价
    wholesaleDefaultSalePrices: { tea_leaf: 6.5 },        // 批发市场默认售价
    wholesaleDefaultPurchasePrices: { tea_leaf: 5 },      // 批发市场默认收购价
    householdGoods: {                                     // 居民日用品：正常人家每人每年用量、收入弹性、舒心值加成
      tea_leaf: { annualPerPerson: 2, incomeElasticity: 1, comfortMaximum: 1 }
    }
  },

  // 给已有外镇加商品（档案字段见 content/outside-towns.js 顶部说明）。
  outsideTownGoods: {
    minzhen: { tea_leaf: { basePrice: 6, needPerPersonDay: 2 / 365, producePerPersonDay: 0, targetDays: 180, stock: 2000, sellsToUs: false, supplyWeight: 0.05 } }
  },

  // mod 自己的状态初值，开局放在 state.mods["_template"]。
  initialState: { pickedTotalUnits: 0 },

  // 存档兼容：state.mods 下按实体 id 存的表登记在 entityMaps（路径从 state 根算起）；改名写 renames。
  save: { entityMaps: [], renames: [] }
};
