# 麦乡 · MODDING.md

新功能尽量写成 mod：一个 mod 一个文件夹，只改自己的文件，多人（多个 agent）并行开发互不冲突。

## 一、文件布局

```
src/mods/<id>/content.js   纯数据：物品、配方、建筑、岗位、规则参数、外镇商品、mod 状态初值、存档登记
src/mods/<id>/mod.js       行为：每日步骤、玩家命令、只读视图、界面卡片、建筑美术、校验、舒心值
tests/mod-<id>.test.js     测试
```

起步：复制 `src/mods/_template/` 改名，把两个文件里的 `_template` 换成新 id。模板以"茶叶"为例，每个字段都有注释。

登记（**唯一需要改的公共文件，各加一行**）：

```js
// src/mods/content-registry.js
import tea from "./tea/content.js";
export const MOD_CONTENTS = [tea];

// src/mods/registry.js
import tea from "./tea/mod.js";
export const MODS = [tea];
```

只有数据、没有行为的 mod 可以不写 mod.js，只登记 content。

## 二、content.js（纯数据，不能 import 系统代码）

| 字段 | 说明 |
|---|---|
| `id` | mod id，和 mod.js 相同 |
| `items` / `recipes` / `buildings` / `roles` | 与 `src/content/` 同格式；id 与核心或其他 mod 重复会直接报错 |
| `rules` | 与核心规则合并；对象型参数（价格表、`householdGoods` 等）逐键合并 |
| `outsideTowns` | 新外镇档案（格式见 `content/outside-towns.js`） |
| `outsideTownGoods` | `{ 外镇id: { 物品id: 档案 } }`，给已有外镇加商品 |
| `initialState` | 开局放进 `state.mods[id]` |
| `save` | `{ entityMaps: [...], renames: [{from, to}] }`，见第五节 |

物品流通标记（替代了以前各处手写的清单）：

| 标记 | 含义 |
|---|---|
| `wholesale` | 批发市场做市（挂收购价/售价、管库存） |
| `retail` | 上综合商店货架 |
| `storeOnly` | 只能经综合商店卖给居民 |
| `optionalRetail` | 后加零售品：镇上有货才参与商店试进货与资金储备 |

建筑带 `industryTier`（0 原料 / 1 加工 / 2 成品）就自动成为产业：镇营/民营/公司/生产税/熟练度/经营计划全部支持；`accountingSector` 自动建产业账本。每个建筑必须有 `jobs` 数组。

加工建筑的原料（小麦除外）都从批发市场领用，测试里要先建好批发市场并派人（见 `tests/mod-pottery.test.js` 的 `potteryWorld`）。

居民日用品：在 `rules.householdGoods` 里加一项，居民就会到综合商店买、用了加舒心值。

## 三、mod.js（默认导出 `defineMod({...})`）

| 钩子 | 签名 | 用途 |
|---|---|---|
| `dailySteps` | `[{ id, after, when?, run(state, content, day) }]` | 插进每日结算，放在 `after` 那步之后；最终 id 为 `"<mod>:<step>"` |
| `commands` | `{ name(state, content, ...args) => { ok, reason?, message? } }` | 玩家操作，经 `simulation.mods[id].name(state, ...args)` 调用 |
| `select` | `(state, content) => 对象` | 只读视图，界面里是 `view.mods[id]`；**绝不写 state** |
| `ui.economySection` | `{ title, render(view, modView) => html }` | 经营页的一张可折叠卡片 |
| `ui.buildingSections` | `{ 建筑类型id: (view, building, modView) => html }` | 建筑详情里追加卡片 |
| `art` | `{ 建筑类型id: (options) => svg }` | 建筑美术，地图图标自动复用 |
| `validate` | `(state, content) => [中文错误]` | 状态校验，错误自动加 `[id]` 前缀 |
| `comfort` | `(state, household, people, dayBook, content) => 分数` | 家庭当日舒心值加分（≥0） |

界面按钮不用改 app.js，写成：

```html
<button data-mod="tea" data-mod-command="reset">清零</button>
<!-- 带数值输入：data-mod-input 指向一个数字草稿键；data-mod-arg 传固定参数 -->
```

点击后调用 `simulation.mods[mod][command](state, 输入值, data-mod-arg)`，命令返回的 `message` / `reason` 会弹提示。

`after` 可用的核心步骤 id（按执行顺序，见 `systems/daily.js` 的 `CORE_DAILY_STEPS`）：

`openDay` `yearStartCompanyDistributions` `villaTax` `staffing` `relief` `wages` `companyWages` `privateWages` `socialContribution` `unemployment` `pension` `construction` `wholesaleTownAllocation` `production` `wholesaleTownOutput` `privateProduction` `wholesalePrivateIntake` `companyProduction` `wholesaleCompanyIntake` `livestock` `industryExperience` `shopPreparation` `rent` `villaSales` `saltTrade` `trade` `repairWood` `goodsTrade` `services` `meal` `saltMeal` `goodsUsed` `satisfaction` `shops` `stalls` `farmDay` `finance` `harvest` `annualReport` `outsideTownYear` `wheatLoanYear` `tradeAgreementMonth` `tradeAgreementYear` `outsideTownDay` `history`

也可以插在别的 mod 的步骤后面（`after: "其他mod:步骤"`），前提是那个 mod 登记在前面。

## 四、规矩

1. **只写自己的状态**：mod 只读写 `state.mods[id]`（用 `modState(state, id)` 取）。要动核心状态（钱、货、建筑、家庭），只能走经济底层工具：
   - 账户/存放位置 `economy/accounts.js`；支付 `economy/payment.js`；
   - 买卖 `economy/trade.js`（`putStock` / `takeStock` / `buyDirect`）；
   - 发工资 `systems/employer.js`；记账 `economy/books.js` 的 `bookAdd` / `bookAddMap`。
2. **钱货守恒**：付钱就要真到账，先扣后给；`validateState` 必须通过（无 NaN / 负钱负粮）。
3. **不改核心文件**：缺扩展点就找主管（Claude）加钩子，不要在核心里写 `if (mod...)` 特例。
4. **不碰别的 mod**。

## 五、存档

不用写迁移。读档时 `state.mods[id]` 会以 `initialState` 为底板补齐新字段。

- `state.mods[id]` 下按实体 id 存的表（如 `state.mods.tea.gardens`），登记 `save.entityMaps: ["mods.tea.gardens"]`，否则旧档会被底板"补出"不存在的实体。
- 字段改名/搬家：`save.renames: [{ from: "mods.tea.old", to: "mods.tea.new" }]`。

## 六、测试与验证

测试不必登记 mod，直接组装内容和步骤表跑：

```js
import { assembleContent } from "../src/content/assemble.js";
import { CORE_CONTENT } from "../src/content/index.js";
import { createInitialState } from "../src/core/state.js";
import { CORE_DAILY_STEPS, runDay } from "../src/systems/daily.js";
import { assembleDailySteps } from "../src/mods/api.js";
import teaContent from "../src/mods/tea/content.js";
import teaMod from "../src/mods/tea/mod.js";

const content = assembleContent(CORE_CONTENT, [teaContent]);   // 核心内容 + 本 mod（登记与否都可以）
const steps = assembleDailySteps(CORE_DAILY_STEPS, [teaMod]);
const state = createInitialState({ seed: 1, content });
for (let i = 0; i < 30; i++) runDay(state, content, steps);
```

参考 `tests/mods-framework.test.js` 里模板 mod 的端到端测试。

登记后完整验证：

```bash
node --test                                       # 全绿
node scripts/bundle-single.mjs --out index.html   # 打包 + 30 天冒烟
```

有界面的 mod，打包后用 Playwright 打开 `index.html` 点一遍。
