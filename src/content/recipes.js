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
  // 四种酒：无损耗。普通款每工日 3 批（30 斤麦）；高档款陈酿，每工日 1 批（普通的 1/3 工时），出粮比与普通款相同。
  brewery_beer: Object.freeze({
    id: "brewery_beer", name: "酿啤酒",
    inputs: Object.freeze([{ itemId: "wheat", quantity: 10 }]),
    outputs: Object.freeze([{ itemId: "beer", quantity: 50 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 3
  }),
  craft_brewery_beer: Object.freeze({
    id: "craft_brewery_beer", name: "酿高档啤酒",
    inputs: Object.freeze([{ itemId: "wheat", quantity: 10 }]),
    outputs: Object.freeze([{ itemId: "beer_premium", quantity: 50 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  }),
  winery_baijiu: Object.freeze({
    id: "winery_baijiu", name: "酿普通白酒",
    inputs: Object.freeze([{ itemId: "wheat", quantity: 10 }]),
    outputs: Object.freeze([{ itemId: "baijiu", quantity: 10 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 3
  }),
  premium_winery_baijiu: Object.freeze({
    id: "premium_winery_baijiu", name: "窖藏高档白酒",
    inputs: Object.freeze([{ itemId: "wheat", quantity: 10 }]),
    outputs: Object.freeze([{ itemId: "baijiu_premium", quantity: 10 }]),
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
