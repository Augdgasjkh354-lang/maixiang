// 茶叶 mod · 内容（纯数据，不能 import 系统代码）。
// 茶园（原料产业）采茶，产出茶叶：居民当日用品（喝茶加舒心值）、综合商店零售，
// 民镇、王镇两个外镇都收茶叶；王镇出价高约两成。行为见 mod.js。

export default {
  id: "tea",

  // 茶叶：批发市场做市，综合商店只卖给居民（storeOnly），后加的零售品（optionalRetail）。
  items: {
    tea_leaf: { id: "tea_leaf", name: "茶叶", unit: "斤", category: "household", edible: false, qeq: null, openingCostWheatPerJin: 0,
      wholesale: true, retail: true, storeOnly: true, optionalRetail: true }
  },

  // 采茶：不需要原料。每人每日采 2 斤。
  recipes: {
    tea_picking: { id: "tea_picking", name: "采茶", kind: "gather", inputs: [], outputs: [{ itemId: "tea_leaf", quantity: 2 }], losses: [], batchesPerWorkerDay: 1 }
  },

  // 茶园：坡地种茶，原料产业（tier 0），可民营、成立公司。开工要木材（不像伐木场可以免木材）。
  buildings: {
    tea_garden: {
      id: "tea_garden", name: "茶园", icon: "🍵", description: "坡地种茶，人工采摘 · 每人每日采茶 2 斤",
      industryTier: 0, maxInstances: 6,
      recipeId: "tea_picking", productionRoleId: "tea_pickers", accountingSector: "tea",
      jobs: [{ id: "tea_pickers", name: "采茶工", slots: 12, wagePerWorkerDay: 5, note: "每人每日采 2 斤茶", releasePriority: 30 }],
      materialRequirements: [{ itemId: "wood", quantity: 200 }],
      construction: { workDays: 200, recommendedWorkers: 10 },
      upgrade: { maxLevel: 5, workDays: 240, materialRequirements: [{ itemId: "wood", quantity: 240 }] }
    }
  },

  // 规则参数（对象型逐键合并，核心价格不受影响）。
  // 茶叶定位：比酒贵、比盐便宜，中间价每斤约 6 斤小麦。
  rules: {
    marketPricesVoucherPerUnit: { tea_leaf: 6 },
    wholesaleDefaultSalePrices: { tea_leaf: 6.5 },
    wholesaleDefaultPurchasePrices: { tea_leaf: 5 },
    // 居民日用品：每人每年 2 斤；有余钱（每人至少 20 券）才去买；喝茶最多加 1 分舒心值。
    householdGoods: {
      tea_leaf: { annualPerPerson: 2, incomeElasticity: 1, comfortMaximum: 1 }
    }
  },

  // 外镇收茶。basePrice 是外镇中间价（斤小麦/斤）；needPerPersonDay 是人均日消耗；
  // producePerPersonDay 为 0 表示不自产，全靠我方供给。sellsToUs: false 表示它不卖茶给我们。
  outsideTownGoods: {
    // 民镇：寻常口味，中间价 6。
    minzhen: { tea_leaf: { basePrice: 6, needPerPersonDay: 1 / 365, producePerPersonDay: 0, targetDays: 120, stock: 600, sellsToUs: false, supplyWeight: 0.1 } },
    // 王镇：讲究饮茶，出价高约两成（6 × 1.2 = 7.2），日耗更大。
    wangzhen: { tea_leaf: { basePrice: 7.2, needPerPersonDay: 2 / 365, producePerPersonDay: 0, targetDays: 120, stock: 800, sellsToUs: false, supplyWeight: 0.15 } }
  },

  // mod 状态初值（开局放进 state.mods.tea）。
  // producedUnits / marketSoldUnits / townSoldUnits 为累计值，单位为库存单位（见 precision.inventoryUnitsPerJin）。
  // gardens 按茶园建筑 id 记每座茶园的累计产量，属于实体表，需登记到 save.entityMaps。
  initialState: {
    producedUnits: 0,
    marketSoldUnits: 0,
    townSoldUnits: 0,
    todayProducedUnits: 0,
    gardens: {}
  },

  save: { entityMaps: ["mods.tea.gardens"], renames: [] }
};
