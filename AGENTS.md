# 麦乡 · AGENTS.md

给接手开发的 AI / 人的速览。读完即可动手。

## 项目是什么

《麦乡》：单文件网页模拟经营游戏。镇长视角经营一座以小麦为本的古代小镇，核心是**政策模拟**：调一个参数，看全镇连锁反应（工资 → 物价 → 利润 → 挖人）。

- 纯 JavaScript + 浏览器原生 ES modules，无框架、无依赖、无后端。
- 模拟内核（`src/core` `src/systems` `src/economy`）不碰 DOM，可在 Node 里无界面运行。
- 存档在浏览器 IndexedDB。

## 三分钟上手

```bash
node --test                                          # 跑全部测试（注意：不要写成 node --test tests/）
node scripts/bundle-single.mjs --out index.html      # 打包成单文件，自带语法检查 + 30 天无界面冒烟
node scripts/simulate.mjs scenarios/<场景>.json      # 跑数值场景，输出每年指标 CSV
```

- **根目录 `index.html` 是打包产物**，不要手改；改 `src/` 后用上面的命令重新生成。浏览器直接打开它就能玩。
- `麦乡-0.2.3.html` 是 0.2.3 发布时的打包文件，留作对照。
- `scripts/build.mjs` 是旧的多文件构建，已不适用，忽略。

## 目录

| 路径 | 内容 |
|---|---|
| `src/content/` | 静态定义：物品、建筑、岗位、规则参数。版本号在 `version.js`，存档版本 `SAVE_VERSION` 在 `rules.js` |
| `src/core/` | 初始状态 `state.js`、所有玩家操作 `commands.js`、状态校验 `validation.js` |
| `src/systems/` | 日结各系统；入口 `daily.js` 的 `settleOneDay` |
| `src/economy/` | 货币、支付、库存、价格、账本 |
| `src/selectors/` | 只读派生数据；界面数据总入口 `dashboard.js` 的 `selectDashboard` |
| `src/persistence/` | 存档读写与旧档迁移（`migrations.js`） |
| `src/ui/` | 界面：`shell.js` 骨架、`app.js` 渲染与事件、`panel-*.js` 各面板、`map*.js` 地图 |
| `src/styles/main.css` | 全部样式 |
| `src/engine.js` | 对外门面：`createSimulation()` 返回状态工厂 + 全部命令 + 校验，测试和脚本都用它 |
| `tests/` `scenarios/` `docs/` | 测试、模拟场景、设计文档（`docs/ARCHITECTURE.md` 是总体架构） |

## 核心概念

| 概念 | 说明 |
|---|---|
| 小麦（斤） | 价值尺度，所有价格以小麦斤计 |
| 粮券 | 货币，1 券 ≈ 1 斤；内部整数单位，换算见 `content.precision` |
| 镇库 | 镇财政：收税、发工资与救济、存战略小麦 |
| 货币阶段 | `wheat`（实物）→ `transition`（过渡，按目标比例用券）→ `voucher`（全粮券）。很多逻辑按阶段分叉 |
| 批发市场 | 镇营做市商：对面粉/面包/木材/盐挂收购价与售价、管库存；镇营产品统购入库。**没有自己的钱**，收付款都走镇库；小麦一直在镇库 |
| 综合商店 | 居民买面粉/面包/盐的唯一渠道；动态加价（目标利润率，7 天复核） |
| 镇营 / 民营 / 公司 / 上市公司 | 产业所有制，依次升级：镇营等级可卖给民营或划入公司，公司在交易所完成货币改革后可上市 |
| 家庭 | 居民以户为单位，有库存、粮券、岗位、舒心值 |
| 社保基金 | 独立钱包（支付账户 `social`），操作入口在社保局建筑。养老金、失业金由基金付，不够时镇库垫付并记为基金欠国库的债；镇库注资也记债，基金可还款；基金可买卖上市公司股票（`company.fundShares`）并分红 |

开局只有麦田。伐木场盖在南林伐木点、**不需要木材**，是起步路线；其他建筑都要木材。**建筑建成后不会自动派工**，要在就业面板设人数，否则没有产出、也没有工资支付。

## 铁律

1. **存档兼容**：新字段一律 `||=` 初始化；`SAVE_VERSION` 保持 15；旧档迁移（`normalizeV15`）优先保留存档值，别被新默认值覆盖。
2. **测试全绿**：`node --test` 零失败，新功能和修 bug 都要加测试。设计变了，验证旧行为的测试直接删掉，不必改写。
3. **selector 只读**：`src/selectors/` 和 `selectDashboard` 里绝不写 state。
4. **状态合法**：`validateState` 必须通过，禁止 NaN / Infinity / 负钱负粮。
5. **不手改构建产物**：改 `src/`，再打包。

## 常见坑（都真出过 bug）

**钱与货**
- 付钱就要真到账：采购必须真实入库到买方账户。
- 镇里内部（镇库 ↔ 批发市场 ↔ 镇营建筑）之间只搬货不付钱；自己付钱给自己是 bug 温床，0.2.3 早期就因此出过三个 bug。
- 多阶段支付：每阶段以上一阶段返回的 `remainingComposition` 为准，不能拿付款前的总额，否则重复支付。
- 先扣后给：兑换类操作先扣付出方，成功后再给对方，失败时不能让东西凭空消失。
- 负债不能记在即将 `delete` 的对象上（例：开店失败退款由镇库先垫付给家庭）。
- 谁受益谁出钱：含公司/民营经营权的建筑，镇库不垫付升级。
- 清算要有破产核销：30 天还不清就核销坏账关闭，避免永久僵死。

**流通口径**
- 小麦归镇库直管：磨坊直接用镇库小麦，公司/民营经批发市场按售价从镇库存量买小麦。做市清单是 `WHOLESALE_MONOPOLY_ITEM_IDS`（面粉/面包/木材/盐）。
- 面粉/面包/盐只能经综合商店卖给居民（`generalStoreOnly`）；测试 fixture 要先建商店。
- 小麦阶段居民直接从镇库买主粮、不经过市场和商店；测批发/商店要先推进到粮券阶段。
- 主食购买按户缺口分配，不按人口均分；需求弹性只在综合商店是卖家时生效。
- 店员和商人都算接待能力；店主兼商人拿利润，不领固定工资。

**界面**
- 面板商品清单不要手写，跟可买卖清单保持一致。
- 按钮逻辑放 click 处理，别塞进 change 处理器。
- 每种建筑定义都要有 `jobs` 数组（没有岗位就写空数组），`selectDashboard` 会遍历它。

## 验证改动

- 逻辑改动：`node --test` + 跑一个相关场景（`scenarios/` 里有现成的）。
- 界面改动：打包后用浏览器（或 Playwright）打开 `index.html`，点"新游戏"实际操作一遍。打包冒烟只跑模拟、不渲染界面，界面报错它查不出来。
- 写测试或脚本时，场景里可以直接给镇库加木材来跳过开局（`state.accounts.town.wood += 数量 * content.precision.inventoryUnitsPerJin`）。

## 协作

- 仓库：`augdgasjkh354-lgtm/maixiang`，主分支 `main`。
- 由 Kavi 调度的子 agent：一个需求一个分支，Kavi 验收后再合入 main。
- 版本历史见 `CHANGELOG.md`，各子系统设计见 `docs/`。
