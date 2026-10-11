# 股市机制（印花税、季度分红与除权、居民卖出）

代码：`src/systems/stock-exchange.js`（行情、印花税、居民卖出与撮合）、`src/systems/companies.js`（季度分红、除权、公司摘要）、`src/systems/daily.js` 的 `finance` 步骤（先分红，再行情，再撮合）。
参数：`src/systems/stock-exchange.js` 的 `STOCK_MARKET`；`src/content/rules.js` 的 `stampDutyDefaultPercent`、`stampDutyMaximumPercent`、`sharePayoutDefaultPercent`、`sharePayoutMaximumPercent`、`shareDividendIntervalDays`、`shareExRightsRecoverDays`。

## 一、价格模型（不变的部分）

- 每只上市股票的价格按一档（0.01 粮券）报价，单日涨跌不超过 ±20%（价格很低时至少动一档）。
- 业绩锚 = 近 60 天净利润折年 ÷ 4%（`rules.stockFairYieldPercent`）。常态向锚缓慢回拢并带惯性、市场情绪推力与噪声；偶发泡沫（脱离业绩持续上涨），泡沫越高越容易破裂，破裂后连日急跌直到回到锚附近。
- 本版在这之上加两项：居民买卖的净流量（下一节）和除权下移的业绩锚（分红一节）。

## 二、居民买卖与撮合

### 卖出意愿（每户每天抽样）

只遍历持有该股的户（`company.householdShares`），不遍历全体居民。用几何跳跃取候选（候选率 `residentSellCandidateDaily` = 11%），候选再按实际概率接受，等价于每户独立判定一次。实际概率：

| 项 | 日概率 | 条件 |
|---|---|---|
| 基础换手 `residentSellBaseDaily` | 0.5% | 每个持仓户 |
| 缺现金 `residentSellCashDaily` | +4% | 可动用粮券 + 存款 < 30 天生活储备的口粮钱 |
| 获利了结 `residentSellProfitDaily` | +0—3% | 泡沫期，价格高出业绩锚（对数差 0.5 时满额） |
| 恐慌 `residentSellPanicDaily` | +3% | 破裂期 |

挂卖股数：基础 / 获利 / 恐慌为持股的 10%—50%，缺现金为 20%—60%，至少 1 股、至多全部持股。

卖单只在当日有效：不预先扣股份，不跨日，不进存档。成交时再校验卖方仍持有该股数。

### 撮合顺序

日结 `settleDailyShareMarket`：先生成居民卖单，再按住户买股预算撮合。每户对每只股票的预算（按追涨权重分配）：

1. 先吃居民卖单（市价，卖方收款减印花税）；
2. 再吃发行池（镇长或业主挂出的限价单，原规则不变：市价不低于卖方定价才成交）。

### 净流量与次日股价

当日净流量 `flow = (买入股数 − 卖出意愿股数) ÷ 总股本`，写入 `company.stockMarket.flow`，限幅 ±1。居民间成交两边都计（买入与卖出意愿各计一次），所以撮合掉的卖单净额为零，只有没人接的卖压和发行池的买盘会动价。无成交也照算（卖单无人接时压价）。

次日 `stepSharePrice` 涨跌项加 `STOCK_MARKET.flowImpact × clamp(flow, ±flowCap)`：`flowImpact` = 0.5，`flowCap` = 0.1，即净流量每占股本 1% 推动次日 0.5%，单日最多 ±5%。用过后清零，当日成交再写入新值。

## 三、印花税

- 政策 `state.policy.stampDutyPercent`，开局 0.1%，范围 0—5%，两位小数（政策页「股市印花税」卡；命令 `setStampDuty`）。
- 对象：二级市场成交。居民之间的卖出，以及居民卖方挂出的发行池成交。税额 = 成交额 × 税率，取整到粮券内部整数单位。
- 承担：卖方。买方付全额股款；卖方收到股款后另付印花税给镇库（`stamp_duty`）。卖方是镇库自己时不征（镇库卖出、镇营发行池）。
- 不征：一级发行（认购，`executeShareSubscription`）、镇库回购（`executeTownBuyback`）、社保基金的买卖（本版未改，若要征需单独定）。
- 账：`state.stampDuty` 三段账（`stampDutyUnits`），年报 `annualReports[].stampDuty`；政策页显示今日 / 本年 / 累计。

## 四、季度分红与除权

### 分红

- 分红日：每 `shareDividendIntervalDays`（90）天一次，即第 90/180/270/360 天，在金融步骤里、行情之前。
- 分红额 = 近一季（最近 90 天）净利润 × 分红比例（`company.payoutPercent`，缺省 `sharePayoutDefaultPercent` = 60%）。封顶：未分配利润、可自由支配现金（扣工作营运资金储备）、本季利润为负或欠薪则不分。
- 分红比例：镇库控股（镇库持股过半）的公司由镇长设置（`configureDividend`，0—100%）；民营上市公司按公司自身策略，镇长不能改。
- 每股分红 = 分红额 ÷ 总股本，取整到内部单位。持股人按股数入账：居民户（`enterprise_dividend`）、社保基金（`recordFundDividend`）、镇库（`town`）。付款走统一支付层。
- 分红记入 `company.quarterlyDividends`（最近 8 条）和事件日志。它不进年报的 `dividendHistory`（那是年度利润分配）。年度结算仍照旧：分红先扣未分配利润，年末剩下的按原规则分配。

### 除权

- 除权日 = 分红日：股价下调一股分红额，至少一档，**不受单日 ±20% 限制**（分红额可能超过 20%，这是有意的）。股价不低于一档。
- 业绩锚同额下移。锚来自利润，而分红只是把现金搬走、利润不变，不下移的话股价会被均值回归“补回”，等于重复计价。
- 下移额按线性回升：`exRights = { offsetUnits, startAbsDay }`，之后 `shareExRightsRecoverDays`（90）天回到 0。新的除权叠加尚未回升的余额。
- 股价计算用的锚 = 业绩锚 − 除权余额（`effectiveAnchorUnits`，`settleStockMarketDay` 内）。

### 摘要

`companySummary` 给出：`payoutPercent`、`payoutControllable`、`lastDividend`（年、日、每股、总额、除权额）、`dividendYieldPercent` = 每股分红 × 4 ÷ 现价。

## 五、守恒与校验

- 印花税、分红、居民卖出收款都是粮券转移，粮券总量（`totalVoucherBalances`）不变。测试：`tests/stock-stamp-duty.test.js`、`tests/stock-resident-trading.test.js`、`tests/stock-dividend.test.js`。
- `validateState` 检查：印花税账非负整数、分红比例 0—100、净流量有限且在 ±1 内、除权记录有效、政策税率范围。
- 股份：居民持股合计 = `residentShares`，居民逐户持股表与之一致（既有规则，居民间转手不改总数）。

## 六、旧档

新字段都由底板补齐（`state.policy.stampDutyPercent`、`state.stampDuty`），公司字段缺省时用规则默认（分红比例、除权、净流量），不需要迁移，`SAVE_VERSION` 不变。`tests/stock-dividend.test.js` 的最后一条测试覆盖了缺字段的存档读取。

## 七、性能

日结的股市部分只碰持股户：`generateResidentSellOrders` 只遍历持股户（几何跳跃抽样），撮合的买方循环只新增同一公司卖单列表的遍历，不多出每户的昂贵调用。1320 户、两家上市公司、约 600—900 持股户的 90 天冒烟中，股市相关函数（卖单生成、日结股市撮合、分红、行情）合计约占总耗时的 0.3%（CPU 采样）。

## 八、遗留与取舍

- 社保基金在二级市场的买卖本版未征印花税、也未计入净流量。
- 除权日不受单日涨跌幅限制，极端分红时价格可能一日大跌。
- 分红每股取整到内部单位，余数留在公司未分配利润。
- 卖单的股数按持股比例抽取，持股很少（1—2 股）的户只能整股卖；大户的卖出由抽样决定，不是逐户精确的。
- 居民卖出的价格是当日市价，不按卖方意愿价；卖单不排队，当日未成交即作废。
