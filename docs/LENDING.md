# 民间贷款（银行向住户放贷）

状态：规格（实现前）。2026-10 与 Jack 确认的决定：

- 第一版用途：**开店启动资金**、**购买别墅**。升级建筑暂不放。
- 全镇统一贷款利率 `bank` 政策的 `loanRateAnnualPercent`，新开局默认 **5%**（旧默认 6%，只改新开局默认，已存的政策值不动）。
- 违约：**不关店、不收资产**，欠款一直挂着，有钱就还；只有户灭（整户无人，家产归镇库）时才核销。
- 银行亏损**没有硬约束**，不因坏账比例停贷；放贷只受"可贷额度"限制（见下）。
- 界面：居民资金显示为「手头 + 存款」合计一个数，括号小字拆分；银行面板加「闲置现金」。

## 目的

居民的钱每天按存款倾向存进银行（`systems/bank.js` 的 `depositToBank`），银行现金因此长期空放（居民手头只剩零头）。
民间贷款让银行把存款重新借给居民，使现金流动起来，也让银行付存款利息有收入来源（现在利息靠留存利润变负 + 镇库托底垫付）。

## 现有基础（不要重写）

`systems/bank.js` 已有 `bank.loans[]`（现仅向上市公司放贷）：`issueBankLoan`、`settleBankLoansDay`、`bankLoanableVoucherUnits`、坏账核销、台账守恒式
`存款 + 欠镇库 + 应付利息 = 现金 + 在贷 + 国债 − 留存利润`。住户贷款复用同一张表和同一守恒式，新增 `borrowerKind: "household"`。

## 数据

`bank.loans[]` 的住户贷款多出这些字段（公司贷款不变）：

| 字段 | 含义 |
|---|---|
| `borrowerKind: "household"`、`borrowerId` | 住户 id |
| `purpose` | `"shop"` 或 `"villa"` |
| `termMonths` | 期限（月）。开店 24，别墅 60 |
| `instalmentVoucherUnits` | 月供：按期初本金、月利率、期数算的等额本息，发放时定死，之后不变 |
| `nextDueDayIndex` | 下次还款日（日序号，发放日 + 30 的整数倍） |
| `missedInstalments` | 已欠月供期数（欠款不单独计罚息） |
| `overdueDays` | 复用现有字段，表示有欠期的天数，仅作展示 |

利息：沿用 `settleBankLoansDay` 的日计息（利息滚入 `outstandingVoucherUnits`，同时计入 `bank.retainedVoucherUnits`）。
住户贷款**不走**公司贷款"到期一次扣款 + 逾期 30 天核销"的分支，改走下面的月供逻辑。

`household.loanIds`（可选，缓存）不进存档：需要时按 `bank.loans` 现算。

## 发放

函数：`systems/household-loans.js`（新）`quoteHouseholdLoan(state, householdId, purpose, needUnits, content)`、`issueHouseholdLoan(...)`。

额度（全部满足才放，放 `min(缺口, 各项上限)`）：

1. 缺口 = 该用途要的钱 − 住户可动用资金（沿用现有的"总价值 ≥ 启动资金 + 生活储备"口径，见 `shops.js` 的 `chooseMerchantHousehold`、`villas.js` 的 `settleVillaPurchases`）。缺口为 0 不借。
2. **净家底**要为正：净家底 = 家底（`household-budget.js`）− 现有贷款余额。借款后净家底不低于 0 之外，贷款余额上限 = `rules.lending.maxDebtToWealthShare`（默认 0.6）× 借款前家底。
3. **还款能力**：借款后全部月供合计 ≤ `rules.lending.maxServiceShareOfIncome`（默认 0.3）× 近 30 天收入（`household-budget.js` 的近期日收入 × 30）。
4. 单户余额上限 `rules.lending.maxPerHouseholdJin`（默认 20000 斤，换成内部单位）。
5. 银行可贷额度 `bankLoanableVoucherUnits(state)` ≥ 放款额（已扣准备金、欠镇库、应付利息；不要再另设安全垫）。
6. 银行已建成（`bankAvailable`）。

放款分录：`bank.cashVoucherUnits -= units`；`household.voucherUnits += units`（用 `economy/` 现有的转账原语，别手写）；
`bank.loans.push(loan)`；`bank.stats.loansIssuedCount/VoucherUnits` 累加；记一条事件和账本（类型 `household_loan_issue`，付款方 `bank`、收款方 `household:<id>`）。
放款后调用 `syncResidentAggregates`（居民汇总是缓存），然后才让原流程（开店、买别墅）去付款。

接入点：
- 开店 `shops.js`：`chooseMerchantHousehold` 筛不到人时，对"有空闲劳力、净家底够"的候选尝试贷款补缺口，再用原流程付款。
- 别墅 `villas.js` 的 `settleVillaPurchases`：`affordable < priceUnits` 的候选尝试贷款补缺口。
- 贷款的钱先进住户手头，付款仍走 `settleMonetaryPayment`，**用途不锁定**到只能付这一笔（第一版可接受）；借款当天必须用掉，用不掉（原流程失败）就当天原路退回银行（同日冲销，不留一笔空贷款）。

## 还款（每日，`settleBankDay` 里 `settleBankLoansDay` 之后）

对每笔 `status === "active"` 的住户贷款，`dayIndex >= nextDueDayIndex` 时：

1. 应还 = 一期月供 × (1 + 已欠期数)，不超过 `outstandingVoucherUnits`。
2. 能还多少：住户 `spendableVoucherUnits`（手头 + 存款）**扣掉 30 天口粮钱**（`householdStartupReserveUnits` 同口径，或 `householdFoodReserveDays` 折算）之后的部分。
3. 先用手头粮券，不够再 `withdrawFromBank` 取自己的存款（取款失败就停）。实还 = min(应还, 能还)。
4. 实还全额：`missedInstalments = 0`，`nextDueDayIndex += 30`。不足：已还的先冲利息再冲本金，`missedInstalments += 1`（每个到期日最多 +1），`nextDueDayIndex += 30`。
5. 还款分录：`bank.cashVoucherUnits += paid`；`loan.outstandingVoucherUnits -= paid`；`bank.stats.loansRepaidVoucherUnits`、`interestEarnedVoucherUnits`（先冲利息）累加；账本类型 `household_loan_repay`。
6. 有欠期的贷款，每天额外检查一次：住户有富余（同第 2 条口径）就补还欠款，直到欠期清零。**有钱就还**。
7. `outstandingVoucherUnits <= 0` → `status = "repaid"`，记事件。

月供与计息：月供按固定利率算，若中途政策利率调整，**已发放贷款利率不变**（`loan.rateAnnualPercent` 在发放时固定，日计息读这一字段，不读当前政策利率——现有公司贷款也这样，统一）。

## 核销

唯一触发：借款住户整户无人 / 迁出，家产归镇库（`redistribution.js` 的 `escheatHousehold`）：
先用该户手头与存款还一部分（正常还款分录），剩余 `outstanding` 全部核销——`status = "written_off"`、`bank.stats.badDebtVoucherUnits +=`、`bank.retainedVoucherUnits -=`（可为负，沿用现有核销写法），记事件。
**不**因欠期天数核销，**不**关店、**不**收房。

分家（`household-split.js`）：贷款留在原户，不拆分。

## 统计口径

- 富人税、基尼、遗产税等用的家底改为**净家底**（`systems/wealth-stats.js` 的 `wealthDistributionRows`、`redistribution.js` 的税基）：家底 − 该户贷款余额。负值按 0 计税，但基尼里保留负值需要谨慎——第一版统一**下限 0**。
- 宽裕度（`household-budget.js`）的"家底"同口径用净家底；年度可动用预算里 `usableWealthShare × 家底` 随之下降。贷款本身不计入年收入。

## 校验（`core/validation.js`）

- 住户贷款的 `borrowerId` 必须是存在的住户（已核销的除外）；所有数值有限、非负；`instalmentVoucherUnits > 0`；`termMonths ≥ 1`。
- 银行台账守恒式不变，仍须成立（贷款是资产，放款/还款/计息/核销都成对）。
- 粮券总量守恒：放款 = 银行现金 → 住户手头，不印券。

## 界面

- 居民资金一律显示"手头 + 存款"合计（`selectors/dashboard.js` 给合计和拆分，`ui/` 只展示），括号小字写拆分。涉及：银行面板、统计页里"居民粮券"一类行。
- 银行面板新增：「闲置现金」= `bankLoanableVoucherUnits`；「住户贷款」笔数、余额、有欠期笔数；贷款年利率输入已存在，默认值改为 5。
- 住户（家庭）详情里显示贷款余额、月供、欠期。
- 所有文案不出现"小麦结算""货币改革"。

## 测试清单（`tests/household-loans.test.js`）

1. 发放：额度各项上限分别生效（缺口、净家底、还款能力、单户上限、银行可贷额度）；放款后粮券总量不变，银行台账守恒式成立。
2. 开店：没人付得起启动资金时，贷款补缺口后开成店；开店失败当天冲销，无残留贷款。
3. 别墅：资金不足的候选借款买下别墅。
4. 月供：全额按期还，12 期后余额与等额本息公式一致（允许取整误差 ≤ 期数）；最后一期结清状态为 `repaid`。
5. 还不起：欠期累加、不关店；之后有富余自动补还，欠期清零。
6. 口粮保护：还款后住户仍留够 30 天口粮钱。
7. 整户无人：剩余核销，留存利润减少，台账守恒，`validateState` 通过。
8. 利率：政策利率调整不影响已发放贷款；新开局默认 5%。
9. 净家底：有贷款的住户富人税/基尼/宽裕度口径下降；净家底下限 0。
10. 存档往返：带住户贷款的存档读回一致；旧档无这些字段正常读。
11. 3 年模拟（新开局 + 放开贷款）：`validateState` 每 30 天通过，粮券守恒，打印银行闲置现金、贷款余额、欠期笔数、欠镇库。

## 不做（第一版）

升级建筑贷款、按信用分档利率、提前还款、抵押、贷款转让、公司贷款改动。
