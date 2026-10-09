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
node scripts/health-check.mjs 10                     # 十年经济体检：人口、货币分布、家底、基尼、物价、产业、履约；可加 --wealth-tax 1,3,5 --inheritance 30 --employer-share 100
```

- **根目录 `index.html` 是打包产物**，不要手改；改 `src/` 后用上面的命令重新生成。浏览器直接打开它就能玩。
- `麦乡-0.2.3.html` 是 0.2.3 发布时的打包文件，留作对照。
- `scripts/build.mjs` 是旧的多文件构建，已不适用，忽略。

## 目录

| 路径 | 内容 |
|---|---|
| `src/content/` | 静态定义：物品、建筑、岗位、规则参数。版本号在 `version.js`，存档版本 `SAVE_VERSION` 在 `rules.js` |
| `src/core/` | 初始状态 `state.js`、所有玩家操作 `commands.js`、状态校验 `validation.js` |
| `src/systems/` | 日结各系统。一天的执行顺序就是 `daily.js` 里的 `DAILY_STEPS` 表（开日 → 用工 → 发钱 → 生产 → 购买 → 生活 → 金融 → 翻日/年终 → 外镇）；加系统就在表里插一行 |
| `src/economy/` | 货币、支付、库存、价格、账本。`accounts.js` 统一回答"某账户的粮券/小麦/库存存在哪"，`books.js` 统一当日/本年/累计三段记账，`trade.js` 统一买卖（带成本库存 `putStock`/`takeStock`、卖家列表 `directSellers`、直接采购 `buyDirect`） |
| `src/selectors/` | 只读派生数据；界面数据总入口 `dashboard.js` 的 `selectDashboard` |
| `src/persistence/` | 存档：IndexedDB 多存档位（`indexed-save-manager.js`）、带校验和的存档容器（`save-container.js`）、读档校验（`migrations.js` 的 `migrateSave`，只认当前版本） |
| `src/ui/` | 界面：`shell.js` 骨架、`app.js` 渲染与事件、`panel-*.js` 各面板、`map*.js` 地图 |
| `src/styles/main.css` | 全部样式 |
| `src/mods/` | mod：每个 mod 一个文件夹，登记在 `registry.js` / `content-registry.js`；公共工具 `api.js`；模板 `_template/`。**新功能优先写成 mod，见 `MODDING.md`** |
| `src/engine.js` | 对外门面：`createSimulation()` 返回状态工厂 + 全部命令 + 校验，测试和脚本都用它 |
| `tests/` `scenarios/` `docs/` | 测试、模拟场景、设计文档（`docs/ARCHITECTURE.md` 总体架构；`OWNERSHIP.md` 所有制、`TRADE.md` 外贸运力与贸易行、`REDISTRIBUTION.md` 再分配） |
| `scripts/` | `bundle-single.mjs` 打包；`simulate.mjs` 场景；`health-check.mjs` 多年体检；`demand-probe.mjs` 需求探针 |

## 核心概念

| 概念 | 说明 |
|---|---|
| 小麦（斤） | 价值尺度，所有价格以小麦斤计 |
| 粮券 | 货币，1 券 ≈ 1 斤；内部整数单位，换算见 `content.precision` |
| 镇库 | 镇财政：收税、发工资与救济、存战略小麦 |
| 货币阶段 | `wheat`（实物）→ `voucher`（粮券）。建银行后在政策页一键切换，镇库按小麦存量印制等额粮券；没有过渡期 |
| 批发市场 | 镇营做市商：对面粉/面包/木材/盐挂收购价与售价、管库存；镇营产品统购入库。**没有自己的钱**，收付款都走镇库；小麦一直在镇库 |
| 综合商店 | 居民买面粉/面包/盐和日用品的主渠道；目标利润率加价 × 库存系数（见下一行"调价"）；肉直接向养殖场进货 |
| 调价（物价会动） | 规则在 `economy/price-adjust.js`（`nextPriceFactor`，阈值见 `content/rules.js` 的 `priceAdjust`）。综合商店每 7 天按库存够卖天数、日均销量、断货记录给每个商品定系数（积压降价、紧缺涨价、正常回归 1），售价 = 基准价 × 系数，清库存才可降到进货价 × 0.7，在 `systems/shop-pricing.js`；批发市场自动调价默认关闭，玩家逐品开启后以开启时售价为锚定、±30% 内浮动，在 `systems/wholesale-market.js` 的 `reviewWholesaleAutoPricing`（日结 `pricing` 步） |
| 镇营 / 民营 / 公司 | 一栋产业建筑整栋只有一个主人（镇里 / 一户 / 一家公司），换主人一律走 `systems/ownership.js` 的 `transferBuildingOwnership`。卖给民营整栋卖；整栋上市一步完成（`systems/ipo.js`，镇营默认一股不挂出、民营申请默认卖 49%，股款归原主人），民营要上市须业主申请、镇长批准；民营和公司自主升级，欠薪超 30 天由镇里收回。镇库持股只在挂出发行池时才卖，且市价不低于镇长定的售价才成交。股价（`systems/stock-exchange.js`）：0.01 粮券一档、单日 ≤20%，常态向业绩锚回拢，偶发泡沫→破裂，参数集中在 `STOCK_MARKET`。旧档拆开的建筑读档时整栋换算（`systems/ownership-migrate.js`）。详见 `docs/OWNERSHIP.md` |
| 家庭 | 居民以户为单位，有库存、粮券、岗位、舒心值。开局约 5 人一户（`rules.initialHouseholdSize`，3300 人 ≈ 660 户）；每年年终人口超过 8 人的户分家（`systems/household-split.js`，`householdSplitMaxPeople`）：新户拿约一半人口，钱粮按人口比例分，股票/建筑/店铺/经营权/别墅/欠薪债权留原户，岗位放不下的随人走。读旧存档时大户一次分完。户数随人口增长，日结耗时约与户数成正比 |
| 日历 / 月薪 / 正式员工 | 一年 12 月 × 30 天（`rules.daysPerYear` 360、`monthDays` 30）。工资按天计入 `employer.js` 的 `pendingByMonth`，到发薪日（`systems/paydays.js`：5/10/15/20/25 号，按人均利润排，镇营 5 号）才到期支付上个月的；到期没付的才是欠薪（`wageArrears`）。用工审核与辞退在 `systems/employment-contracts.js`：每月 1 号审核、一次 +1，开张期 30 天每天招够；入职满 30 天（`household.jobSince`）才能辞退，付一个月工资补偿，付得起才辞 |
| 救济 | 政策页一个开关：口粮不足 7 天的家庭补到 14 天（家庭先用自己的粮券兑粮）。口粮由镇库实物拨付；社保基金开启时由基金按价值结算，付不起记债。没有手动拨粮和邻里互助 |
| 国债 | 粮券阶段可发，玩家定总额/期限/固定利率；发行当天住户和银行按闲钱认购 |
| 外镇 | 档案在 `content/outside-towns.js`，算法共用 `systems/outside-town.js`（状态 `state.outsideTowns[id]`）。每天按人口自产/消耗各商品、吃口粮；进口品（盐、木材、酒、布）存货不足 3 年用量都按正常价收，超过 3 年才压价，繁荣度越低越肯出高价；自产外卖品（面粉、面包）按库存比目标定价；买卖价差随关系分收窄，大单逐段计价，没有套利。繁荣度跟随供应满足率；人口只增不减（每年 0.5%—3%，随繁荣度），口粮不足的年份停止增长、每年开垦新耕地，秋收入库。只用口粮储备以上的小麦付款。外贸房在岗才能交易、签长协。关税只对贸易行征收（`trading-houses.js` 的 `tradeTariffRate`，见 `docs/TRADE.md`），镇里自己的外贸与长协不收。加新外镇 = 加一份档案 |
| 运力 / 贸易行 | `systems/logistics.js` 管运力池（外贸房基础 + 物流中心 + 码头），所有对外镇的货都要 `takeFreightCapacity`；镇里自己的货不付运费。贸易中心的贸易行是 kind `trade` 的店铺（`systems/trading-houses.js`），自己做进出口（偏向出口，进口利润门槛更高）、付运费和关税给镇库，像商业街店铺一样自己增减店员。河岸地块只建码头和外贸房。详见 `docs/TRADE.md` |
| 再分配 | `systems/redistribution.js`：富人税（人均家底三档超额累进，每 30 天）、遗产税（年终按去世成年人份额）、整户无人家产归镇库；基尼与逐年曲线在 `selectors/inequality.js`。社保由雇主替员工交（`socialSecurity.employerSharePercent`，岗位 → 雇主映射在 `social-security.js`）。服务可设 `minAffluence`（戏园只有宽裕人家去）。详见 `docs/REDISTRIBUTION.md` |
| 整户无人 | 家产归镇库（`redistribution.js` 的 `escheatHousehold`）；别墅退回空置再卖；开的店不清算，由本店商人 → 店员 → 家底最厚的一户接手（`shops.js` 的 `transferShopOwnership`），旧档里的孤儿店在日结店铺步骤里自动接手 |
| 社保基金 | 独立钱包（支付账户 `social`），操作入口在社保局建筑。养老金、失业金、农民补贴（按在岗务农人数发，`farmerSubsidyPerFarmerJin`，默认 0）由基金付，不够时镇库垫付并记为基金欠国库的债；镇库注资也记债，基金可还款；基金可买卖上市公司股票（`company.fundShares`）并分红 |

| 产业 | 有 `industryTier` 的建筑（0 原料：伐木场/盐场/棉田，mod 的茶园/陶土坑/桑园；1 加工：磨坊/酒坊/织坊/陶窑；2 成品：面包房）。镇营加工（有原料投入、或配方标 `demandGated` 的）按市场需求减产：批发市场存够 30 天销量就停（`selectors/production.js` 的 `townOutputGate`），磨坊、酒坊不把镇库小麦用到 180 天口粮以下。所有"哪些建筑能民营/成立公司/设生产税"都由 `content/buildings.js` 的 `industryTypeIds` / `isIndustryType` 推导，经营计划从下游往上游排。加新产业 = 加 item + recipe + 带 industryTier 的建筑 |
| 养殖基地 / 时代广场 | 都是"店铺"的宿主建筑（建筑定义带 `shopHost.slotsPerLevel`），复用店铺的店主、商人、店员、工资、租金、利润税、清算。养殖场是 `kind: "farm"` 的店铺（`systems/livestock.js` 每天喂麦出肉，直供综合商店 `buyFromFarms`，余量进批发市场；`systems/farm-pricing.js` 按存货自主定价、存货够 7 天停养，售价不低于饲料加人工成本）；时代广场是一个集体集市（`kind: "stall"`、`collective: true` 的店铺，不属于某一户；`systems/stalls.js` 按销量增减摆摊人数，卖 `householdGoods` 和肉（`shops.js` 的 `stallItemIds`，肉与综合商店一样直接从养殖场进，集市先进货），与综合商店同价，每人每日 25 斤，利润每天按人头 ×0.8—1.2 随机分给摆摊家庭） |
| 家底 / 宽裕度 | `systems/household-budget.js`：家底 = 粮券 + 存款 + 留够 30 天口粮后多出的小麦（`wealthFoodReserveDays`；富人税付款保护仍留到下次秋收）；宽裕度 = √(人均家底/参照值)，封顶 3。日用品数量、主食里面粉面包的比例、服务预算都由它决定（`rules.householdBudget`）。当天缓存不进存档，同一天内改了家底要 `invalidateHouseholdBudgets` |
| 肉当主食 | 鸡鸭鹅猪肉 edible、1 斤顶 2 斤口粮，家里有肉先吃。`market.js` 的 `buyStaplesForResidents` 先买肉：占口粮比例 = `meatStapleShare(吃肉习惯)`（`rules.meatStaple`，习惯 = 近 90 天宽裕度平滑值，存在 `household.meatHabit`），没买到的算回其余口粮按面粉面包比例吃。养殖场每人日产 10 斤、每斤耗 4 斤麦 |
| 日用品 | 酒、布（茶叶、陶器在 mod 里）：`rules.householdGoods` 配置正常人家的年人均量和收入弹性，实际量 = 标准量 × 宽裕度^弹性；主食和盐之后到综合商店买，用了加舒心值（多用边际递减），没有不扣分（`systems/goods-demand.js`）。后加的零售商品标 `optionalRetail`，镇上有货才参与商店试进货与资金储备。赶集：日用品和盐存货不够当天用才去买、一次买够 `householdGoodsShoppingDays`（5）天，修房木材每 5 天统一采购（省掉大部分小额交易） |

开局只有麦田。伐木场盖在南林伐木点、**不需要木材**，是起步路线；其他建筑都要木材。**建筑建成后不会自动派工**，要在就业面板设人数，否则没有产出、也没有工资支付。

## 加新内容：先考虑 mod

新商品、新建筑、新玩法优先写成 mod（`MODDING.md`）：只动 `src/mods/<id>/` 和自己的测试，两个登记表各加一行。缺扩展点时在核心加通用钩子（`src/mods/api.js`），不要写某个 mod 的特例。物品的流通方式用标记表达（`wholesale` 批发做市 / `retail` 上商店货架 / `storeOnly` 只经商店卖居民 / `optionalRetail`），不要再手写商品清单。

## 铁律

1. **存档一直能读**：读档时用新开局状态当底板，把存档盖上去（`persistence/save-compat.js`）——新增字段、新系统、新商品不用写任何迁移代码，也不用改 `SAVE_VERSION`（固定 17）。字段**改名或搬家**时必须在 `RENAMES` 里加一行 `{ from, to }`；含义变了（单位、口径）要在那里写换算。按实体 id 存的表（如 `households.byId`）要登记进 `ENTITY_MAPS`，否则旧档会被底板"补出"不存在的实体。能重算的派生数据尽量不进存档。坏数据读档时自动修复，修不了的子系统重置并提示玩家
2. **测试全绿**：`node --test` 零失败，新功能和修 bug 都要加测试。设计变了，验证旧行为的测试直接删掉，不必改写。
3. **selector 只读**：`src/selectors/` 和 `selectDashboard` 里绝不写 state。
4. **状态合法**：`validateState` 必须通过，禁止 NaN / Infinity / 负钱负粮。
5. **不手改构建产物**：改 `src/`，再打包。

## 常见坑（都真出过 bug）

**钱与货**
- 新增经济主体（要收付钱的）：在 `economy/accounts.js` 登记账户名和存放位置即可，不要在货币、支付、库存里再写 `owner.startsWith(...)` 分支。
- 日结整天在一个账本批次里（`economy/ledger.js` 的 `withLedgerBatch`）：账本与粮券流水按"类型、付款方、收款方、物品"合并，日终写入。日结中不要回头读当天的 `state.ledger` / `currency.ledger` 找某一笔。
- 三段记账一律用 `economy/books.js` 的 `bookAdd` / `bookAddMap`，不要手写 day/year/cumulative 循环。
- 直接买卖（镇库采购、直购、公司卖货）一律走 `economy/trade.js`，不要再各写一套卖家循环和库存成本计算。
- 发工资一律走 `systems/employer.js`：`accrueWages` 记家庭债权、`payWages` 按户偿付、欠薪 = `wageArrears`。镇库、民营、公司、店铺同一套；行业实物生产税用 `productionTaxUnits`。
- 付钱就要真到账：采购必须真实入库到买方账户。
- 镇里内部（镇库 ↔ 批发市场 ↔ 镇营建筑）之间只搬货不付钱；自己付钱给自己是 bug 温床，0.2.3 早期就因此出过三个 bug。
- 多阶段支付：每阶段以上一阶段返回的 `remainingComposition` 为准，不能拿付款前的总额，否则重复支付。
- 先扣后给：兑换类操作先扣付出方，成功后再给对方，失败时不能让东西凭空消失。
- 负债不能记在即将 `delete` 的对象上（例：开店失败退款由镇库先垫付给家庭）。
- 谁受益谁出钱：含公司/民营经营权的建筑，镇库不垫付升级。
- 清算要有破产核销：30 天还不清就核销坏账关闭，避免永久僵死。

**流通口径**
- 小麦归镇库直管：磨坊直接用镇库小麦，公司/民营经批发市场按售价从镇库存量买小麦。做市清单 `WHOLESALE_MONOPOLY_ITEM_IDS` 由物品的 `wholesale` 标记推导。
- 带 `storeOnly` 标记的商品（面粉/面包/盐/酒/布）只能经综合商店卖给居民；测试 fixture 要先建商店。
- 小麦阶段居民直接从镇库买主粮、不经过市场和商店；测批发/商店要先推进到粮券阶段。
- 主食按户算：口粮默认吃自家小麦，宽裕人家换一部分面粉面包（面包买不到改面粉，再不够买小麦）；需求弹性只在综合商店是卖家时生效。
- 居民实际能花多少还受每日就业换券额度限制（政策 `employmentExchangeJin`），家底多但粮券少时这是最常见的瓶颈。
- 付款顺序：手头粮券 → 银行存款自动取回 → 以粮换券（镇库券池封顶）。判断"付不付得起"一律用 `spendableVoucherUnits`（含存款），别只看 `voucherUnits`。
- 新增镇营产出时想清楚有没有需求闸门：没有闸门的产品会无限堆进批发市场（0.2.3 出过 4000 万斤面包）。
- 店员和商人都算接待能力；店主兼商人拿利润，不领固定工资。

**界面**
- 面板商品清单不要手写，跟可买卖清单保持一致。
- 按钮逻辑放 click 处理，别塞进 change 处理器。
- 每种建筑定义都要有 `jobs` 数组（没有岗位就写空数组），`selectDashboard` 会遍历它。

## 改代码前先分清"bug"还是"可调结果"

体检或测试里看到数字难看，先问：玩家能不能用现有政策调（税率、工资、换券额度、印券、社保费率……）？能调的只写报告、不改代码；钱粮凭空出现或消失、账对不上、某个机制把整局卡死，才算 bug 去修。

## 验证改动

- 逻辑改动：`node --test` + 跑一个相关场景（`scenarios/` 里有现成的）。
- 界面改动：打包后用浏览器（或 Playwright）打开 `index.html`，点"新游戏"实际操作一遍。打包冒烟只跑模拟、不渲染界面，界面报错它查不出来。
- 验收以"账平"为准（`validateState` 通过、钱粮无凭空增减）。模拟最多跑 3 年，不跑 10 年；数值校准类需求另说。
- 写测试或脚本时，场景里可以直接给镇库加木材来跳过开局（`state.accounts.town.wood += 数量 * content.precision.inventoryUnitsPerJin`）。

## 协作

- 仓库：`augdgasjkh354-lgtm/maixiang`，主分支 `main`。目前直接提交到 main。

### 分工（主 agent 调度子 agent）

主 agent 只做难事：设计判断、规划拆任务、核心经济逻辑、疑难问题、最终把关与提交。**基础执行性工作一律交给便宜快速的子 agent（Haiku）**，包括写代码、写测试、跑 `node --test`、打包、跑场景对比、浏览器冒烟、初审 diff；多个子 agent 并行。

| 任务 | 谁做 | 子 agent 思考程度 |
|---|---|---|
| 中等及以下难度：外围功能、界面、美术、文档、脚本、局部修 bug | 子 agent | 中（默认） |
| 测试（补测试、改测试、跑场景对比） | 全部交给子 agent | 中 |
| 高难度但是针对性、标准化的任务（有明确规格、改动范围清楚，比如按给定规则改一个系统、按清单排查一类问题、只读调查并出报告） | 子 agent | 高 |
| 高难度且需要设计判断的任务：核心经济逻辑、跨系统的设计、子 agent 搞不定的问题 | 主 agent 自己做 | — |

派子 agent 时：
- 写清楚要改哪些文件、不许碰哪些文件（并行的子 agent 不改同一个文件）、验收标准（测试、场景数字）。
- 并行时子 agent 只用精确替换改文件，不整篇重写；默认不提交，由主 agent 审完统一提交。若让子 agent 提交，只能 `git add` 自己改的文件，禁止 `git add -A`。
- 子 agent 交回后，另派子 agent 跑全部测试、打包、跑相关场景、界面改动在浏览器里点一遍并出报告；主 agent 读报告，对设计相关的关键改动抽查 diff，不亲自重复执行这些机械步骤。
- 不达标先退回给原子 agent 返工（指出具体问题和验收标准）；同一任务连续两次返工仍不达标，主 agent 亲自接手。
- 能交给子 agent 的尽量交，主 agent 的精力留给设计判断、规划和最终决策。
- 版本历史见 `CHANGELOG.md`，各子系统设计见 `docs/`。
