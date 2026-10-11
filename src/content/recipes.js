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
  // 煤矿、铁矿：矿工每人每日一批（10 斤），需求闸门（demandGated）：批发市场存够 360 天需求就停。
  coal_mining: Object.freeze({
    id: "coal_mining", name: "采煤",
    kind: "gather", demandGated: true, inputs: Object.freeze([]),
    outputs: Object.freeze([{ itemId: "coal", quantity: 10 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  }),
  iron_mining: Object.freeze({
    id: "iron_mining", name: "采铁矿",
    kind: "gather", demandGated: true, inputs: Object.freeze([]),
    outputs: Object.freeze([{ itemId: "iron_ore", quantity: 10 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  }),
  // 冶炼（弹性配方）：一名冶炼工一日一批，每批总产能 10 个产能点。各产品每件占用的产能点与投入见 flex
  // （铁制农具 4 点、铁制工具 2 点、金银珠宝各 1 点）；产能点按各产品批发市场缺口分配（systems/flex-recipe.js）。
  // inputs / outputs 是名义值（一批按农具为主的典型配比：铁矿石 25 斤、煤 13 斤，产农具 2.5 件），只供估算与内容校验。
  smelter_work: Object.freeze({
    id: "smelter_work", name: "冶炼（动态产品）",
    flex: Object.freeze({
      itemIds: Object.freeze(["iron_farm_tool", "iron_tool", "gold_jewelry", "silver_jewelry"]),
      totalJin: 10,
      capacityPerJin: Object.freeze({ iron_farm_tool: 4, iron_tool: 2, gold_jewelry: 1, silver_jewelry: 1 }),
      inputsPerJin: Object.freeze({
        iron_farm_tool: Object.freeze({ iron_ore: 10, coal: 5 }),
        iron_tool: Object.freeze({ iron_ore: 4, coal: 2 }),
        gold_jewelry: Object.freeze({ gold_bar: 0.01, coal: 0.2 }),
        silver_jewelry: Object.freeze({ silver_bar: 0.01, coal: 0.2 })
      })
    }),
    inputs: Object.freeze([{ itemId: "iron_ore", quantity: 25 }, { itemId: "coal", quantity: 13 }]),
    outputs: Object.freeze([{ itemId: "iron_farm_tool", quantity: 2.5 }]),
    losses: Object.freeze([]),
    batchesPerWorkerDay: 1
  }),
  // 金银零售（金银店）：零产出的零售配方。retail 标记：生产流水线不处理（店铺按首饰匠在岗接待，见 systems/jewelers.js）。
  jewelry_retail: Object.freeze({
    id: "jewelry_retail", name: "金银零售", retail: true,
    inputs: Object.freeze([]), outputs: Object.freeze([]), losses: Object.freeze([]),
    batchesPerWorkerDay: 1 // 不用于产出（零售配方）；内容校验要求正整数。
  }),
  // 酒坊（弹性配方）：一名酿酒工一日一批，每批总产能 12 斤酒，四种酒按市场缺口动态分配（systems/flex-recipe.js）。
  // 小麦按实际产出折算（inputsPerJin）：啤酒、高档啤酒每斤 0.2 斤麦，白酒、高档白酒每斤 1 斤麦。
  // inputs / outputs 是名义配比（每种 3 斤、小麦 8.4 斤/批），只供估算与内容校验，实际产出由缺口分配决定。
  winery_brewing: Object.freeze({
    id: "winery_brewing", name: "酿酒（动态酒品）",
    flex: Object.freeze({
      itemIds: Object.freeze(["beer", "beer_premium", "baijiu", "baijiu_premium"]),
      totalJin: 12,
      inputsPerJin: Object.freeze({
        beer: Object.freeze({ wheat: 0.2 }), beer_premium: Object.freeze({ wheat: 0.2 }),
        baijiu: Object.freeze({ wheat: 1 }), baijiu_premium: Object.freeze({ wheat: 1 })
      })
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
