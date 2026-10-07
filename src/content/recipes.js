export const RECIPES = Object.freeze({
  mill_flour: Object.freeze({
    id: "mill_flour", name: "磨粉",
    accountingRawInputs: Object.freeze(["wheat"]),
    inputs: Object.freeze([{ itemId: "wheat", quantity: 20 }]),
    outputs: Object.freeze([{ itemId: "flour", quantity: 16 }]),
    losses: Object.freeze([{ itemId: "wheat", quantity: 4 }]),
    batchesPerWorkerDay: 4
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
    outputs: Object.freeze([{ itemId: "salt", quantity: 5 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  })
});
