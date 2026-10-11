export const RECIPES = Object.freeze({
  mill_flour: Object.freeze({
    id: "mill_flour", name: "磨粉",
    accountingRawInputs: Object.freeze(["wheat"]),
    inputs: Object.freeze([{ itemId: "wheat", quantity: 20 }]),
    outputs: Object.freeze([{ itemId: "flour", quantity: 16 }]),
    losses: Object.freeze([{ itemId: "wheat", quantity: 4 }]),
    batchesPerWorkerDay: 8
  }),
  bakery_bread: Object.freeze({
    id: "bakery_bread", name: "烤面包",
    inputs: Object.freeze([{ itemId: "flour", quantity: 5 }]),
    outputs: Object.freeze([{ itemId: "bread", quantity: 6 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 16
  }),
  lumber_gathering: Object.freeze({
    id: "lumber_gathering", name: "伐木",
    kind: "gather", inputs: Object.freeze([]),
    outputs: Object.freeze([{ itemId: "wood", quantity: 1 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  }),
  salt_gathering: Object.freeze({
    id: "salt_gathering", name: "采盐与加工",
    kind: "gather", inputs: Object.freeze([]),
    outputs: Object.freeze([{ itemId: "salt", quantity: 10 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  }),
  // 酒坊（弹性配方）：一名酿酒工一日一批，每批总产能 12 斤酒，四种酒按市场缺口动态分配（systems/flex-recipe.js）。
  // 小麦按实际产出折算：啤酒、高档啤酒每斤 0.2 斤麦，白酒、高档白酒每斤 1 斤麦。
  // inputs / outputs 是名义配比（每种 3 斤、小麦 8.4 斤/批），只供估算与内容校验，实际产出由缺口分配决定。
  winery_brewing: Object.freeze({
    id: "winery_brewing", name: "酿酒（动态酒品）",
    flex: Object.freeze({
      itemIds: Object.freeze(["beer", "beer_premium", "baijiu", "baijiu_premium"]),
      totalJin: 12,
      wheatPerJin: Object.freeze({ beer: 0.2, beer_premium: 0.2, baijiu: 1, baijiu_premium: 1 })
    }),
    inputs: Object.freeze([{ itemId: "wheat", quantity: 8.4 }]),
    outputs: Object.freeze([
      { itemId: "beer", quantity: 3 },
      { itemId: "beer_premium", quantity: 3 },
      { itemId: "baijiu", quantity: 3 },
      { itemId: "baijiu_premium", quantity: 3 }
    ]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  }),
  cotton_growing: Object.freeze({
    id: "cotton_growing", name: "种棉",
    kind: "gather", inputs: Object.freeze([]),
    outputs: Object.freeze([{ itemId: "cotton", quantity: 3 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  }),
  weaving_cloth: Object.freeze({
    id: "weaving_cloth", name: "织布",
    inputs: Object.freeze([{ itemId: "cotton", quantity: 4 }]),
    outputs: Object.freeze([{ itemId: "cloth", quantity: 1 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  })
});
