# 扩展物品、配方和建筑

内容 ID 是存档与模拟引用，新增后应保持稳定。普通生产建筑使用同一套岗位、工资、施工和生产接口；有专属收支的行业只增加它自己的行业账，不改人口或每日调度。

## 1. 注册物品

```js
wood: {
  id: "wood", name: "木材", unit: "单位", category: "material",
  edible: false, qeq: null, openingCostWheatPerJin: 0
}
```

非食品必须使用 `edible: false, qeq: null`。它仍能入库、转移、成为配方材料并记账，但不会进入居民口粮、工资、救济或粮食财富。注册后，新存档会自动生成双方零库存；迁移也为旧存档补零。

食物用 `{ numerator, denominator }` 配口粮当量。例如 1斤面包 = 5/6口粮斤。金额、库存以整数最小单位保存；换算参数集中在 `src/content/rules.js`。

## 2. 注册配方

加工配方可含多种投入、多种产出和多项损耗：

```js
board_making: {
  id: "board_making", name: "锯木",
  inputs: [{ itemId: "wood", quantity: 2 }],
  outputs: [
    { itemId: "plank", quantity: 1 },
    { itemId: "sawdust", quantity: 0.5 }
  ],
  losses: [],
  batchesPerWorkerDay: 1
}
```

引擎先核对所有原料和支付条件，再一次性扣料、记损耗、增加产物。`accountingRawInputs` 可选，用于描述经营账里的直接原料成本；内部中间品流转按实际成本传递，不重复计入整条生产链。

无需原料的资源采集使用 `kind: "gather"`、空 `inputs` 和产出清单。当前实例：

```js
lumber_gathering: {
  id: "lumber_gathering", name: "伐木", kind: "gather", inputs: [],
  outputs: [{ itemId: "wood", quantity: 1 }], losses: [],
  batchesPerWorkerDay: 1
}
```

## 3. 注册建筑与岗位

```js
sawmill: {
  id: "sawmill", name: "锯木场", icon: "🪚",
  maxInstances: 4,
  recipeId: "board_making", productionRoleId: "sawyers",
  jobs: [{ id: "sawyers", name: "锯木工", slots: 4, wagePerWorkerDay: 10 }],
  construction: { workDays: 80, recommendedWorkers: 4 }
}
```

开工调用 `game.buildAt(state, "sawmill", plotId)`。建成后岗位身份是建筑实例 ID 加岗位 ID，例如 `building-3::sawyers`，不能按坐标或建筑类型分配人数。工资由统一工资结算按在岗人数逐日支付；施工成本以工日和每日建筑工工资估算，不在配方中再次支付工资。

本版配置例子：

| 建筑 | 岗位与产出 | 建造 |
| --- | --- | --- |
| 伐木场 | 最多 20 名伐木工；每人每日 1 单位木材；日薪 10 粮券 | 南林伐木点；200 工日；不耗木材 |
| 盐场 | 最多 10 名盐工；每人每日 5 斤食盐；日薪 10 粮券 | 南部盐矿点；100 单位木材、300 工日 |
| 公租房 | 不设生产岗位；完工后容量 1,000 人 | 2,000 单位木材、2,000 工日 |

需要独占资源位置时，在建筑配置加 `requiredPlotFeature`，并在 `src/content/world.js` 增加具有相同 `feature` 的稳定资源地块。共享资源库存仍来自 `state.accounts`，地图资源图标和选址由真实地块派生；不要另建一份经营状态。

住房容量在建筑定义中用 `housingCapacity` 声明。`src/selectors/housing.js` 按村舍优先、已建公租房顺序计算实际入住；施工中的房屋不提供容量。租金通过 `src/systems/housing.js` 按入住人数收取，并保护基本口粮储备。

## 4. 配置 1–5 级原地升级

在建筑定义添加 `upgrade`，容量由一级岗位 `slots` 或住房 `housingCapacity` 乘等级得到；不要改生产配方的每人效率。升级复用 `construction.workDays` 对应的工日，给升级单独列出每级材料。例如：

```js
upgrade: {
  maxLevel: 5,
  workDays: 480,
  materialRequirements: [{ itemId: "wood", quantity: 600 }]
}
```

每个新等级都使用同一份升级材料量和工日。升级时通过 `simulation.upgradeBuilding(state, instanceId)` 发出命令；系统为升级生成独立工程 ID，开工时实际扣料，完工后把带账户、物品、数量、工程 ID 和交易 ID 的投入行写到该建筑的 `materialInvestments`。新增岗位仍为 0 人，不能在此自动招聘。

拆除使用 `simulation.selectDemolitionPreview` 生成只读结果，再由界面的明确确认调用 `simulation.demolishBuilding`。返还只依据投入流水，不能读取当前配置估算历史材料；没有可追溯记录的旧建筑就显示“无可追溯材料可返还”。

新行业只需登记物品、建筑、岗位与配方即可复用施工和生产。若它有独立收入、原料估值或成本归集，再在对应行业账实现明确的业务接口；不要将林业、盐业工资或租金并入面包链利润。

## 5. 测试配置与运行

`tests/simulation.test.js` 的锯木棚/多产出配方只用于验证通用扩展接口，不进入正式玩法。正式林业、盐业、住房及交易规则在 `tests/forestry-housing-salt.test.js` 中覆盖。

```sh
npm test
npm run build
```
