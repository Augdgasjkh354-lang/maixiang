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
  // 酒坊：一名工人一天酿一批，无损耗，一批同时出四种酒（啤酒 2 斤、高档啤酒 1 斤、普通白酒 2 斤、高档白酒 1 斤）。
  // 投入小麦按出粮比折算：啤酒 1 斤麦出 5 斤、白酒 1 斤麦出 1 斤（高档款同比），2/5 + 1/5 + 2 + 1 = 3.6 斤。
  winery_brewing: Object.freeze({
    id: "winery_brewing", name: "酿酒（啤酒与白酒）",
    inputs: Object.freeze([{ itemId: "wheat", quantity: 3.6 }]),
    outputs: Object.freeze([
      { itemId: "beer", quantity: 2 },
      { itemId: "beer_premium", quantity: 1 },
      { itemId: "baijiu", quantity: 2 },
      { itemId: "baijiu_premium", quantity: 1 }
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
