// 陶器 mod · 内容（纯数据，不能 import 系统代码）。
// 两段产业链：陶土坑（原料，采掘陶土）→ 陶窑（加工，陶土 + 木柴 → 陶器）。
// 陶器是居民日用品：有余钱的家庭到综合商店买，用了加舒心值；民镇、王镇外镇也收。
// 价格单位一律是"每单位值多少斤小麦"。

export default {
  id: "pottery",

  items: {
    // 陶土：只在批发市场流通，居民不买。
    clay: { id: "clay", name: "陶土", unit: "斤", category: "material", edible: false, qeq: null, openingCostWheatPerJin: 0,
      wholesale: true },
    // 陶器：批发市场做市 + 综合商店零售（只能经商店卖给居民）+ 后加零售品。
    pottery: { id: "pottery", name: "陶器", unit: "件", category: "household", edible: false, qeq: null, openingCostWheatPerJin: 0,
      wholesale: true, retail: true, storeOnly: true, optionalRetail: true }
  },

  recipes: {
    // 采土：不需要原料，每人每日挖 3 斤陶土。
    clay_digging: { id: "clay_digging", name: "挖土", kind: "gather", inputs: [], outputs: [{ itemId: "clay", quantity: 3 }], losses: [], batchesPerWorkerDay: 1 },
    // 烧窑：每人每日 4 斤陶土 + 1 斤木柴 → 4 件陶器（增值约 11 斤小麦/人日，与织布相近）。
    kiln_firing: { id: "kiln_firing", name: "烧窑", inputs: [{ itemId: "clay", quantity: 4 }, { itemId: "wood", quantity: 1 }], outputs: [{ itemId: "pottery", quantity: 4 }], losses: [], batchesPerWorkerDay: 1 }
  },

  buildings: {
    clay_pit: {
      id: "clay_pit", name: "陶土坑", icon: "🪨", description: "掘取陶土 · 原料持续可用",
      industryTier: 0, maxInstances: 12,
      recipeId: "clay_digging", productionRoleId: "clay_diggers", accountingSector: "clay",
      jobs: [{ id: "clay_diggers", name: "掘土工", slots: 16, wagePerWorkerDay: 5, note: "每人每日挖3斤陶土", releasePriority: 30 }],
      materialRequirements: [{ itemId: "wood", quantity: 150 }],
      construction: { workDays: 180, recommendedWorkers: 10 },
      upgrade: { maxLevel: 5, workDays: 180, materialRequirements: [{ itemId: "wood", quantity: 150 }] }
    },
    kiln: {
      id: "kiln", name: "陶窑", icon: "🏺", description: "烧制陶器 · 需已有陶土与木柴",
      industryTier: 1, maxInstances: 12,
      recipeId: "kiln_firing", productionRoleId: "kiln_workers", accountingSector: "pottery",
      jobs: [{ id: "kiln_workers", name: "窑工", slots: 10, wagePerWorkerDay: 5, note: "每人每日耗4斤陶土、1斤木柴，烧出4件陶器", releasePriority: 40 }],
      materialRequirements: [{ itemId: "wood", quantity: 500 }],
      construction: { workDays: 400, recommendedWorkers: 10 },
      upgrade: { maxLevel: 5, workDays: 400, materialRequirements: [{ itemId: "wood", quantity: 500 }] }
    }
  },

  rules: {
    // 本镇中间价：陶器约 8 斤小麦一件，陶土约 1.5 斤。
    marketPricesVoucherPerUnit: { clay: 1.5, pottery: 8 },
    // 批发市场默认售价 / 收购价。
    wholesaleDefaultSalePrices: { clay: 2, pottery: 9 },
    wholesaleDefaultPurchasePrices: { clay: 1.2, pottery: 6.5 },
    // 居民日用品：正常人家年人均 1 件，越宽裕买得越多（弹性 0.6），用够标准量加舒心值 1 分。
    householdGoods: {
      pottery: { annualPerPerson: 1, incomeElasticity: 0.6, comfortMaximum: 1 }
    }
  },

  // 给已有外镇加陶器：两镇都要买，不自产、不卖给我们。
  outsideTownGoods: {
    minzhen: { pottery: { basePrice: 8, needPerPersonDay: 1 / 365, producePerPersonDay: 0, targetDays: 180, stock: 1500, sellsToUs: false, supplyWeight: 0.05 } },
    wangzhen: { pottery: { basePrice: 9.6, needPerPersonDay: 1.5 / 365, producePerPersonDay: 0, targetDays: 180, stock: 1200, sellsToUs: false, supplyWeight: 0.08 } }
  },

  initialState: {},

  save: { entityMaps: [], renames: [] }
};
