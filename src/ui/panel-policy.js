import { number } from "./format.js";
import { renderNumericInput } from "./numeric-drafts.js";

export function renderPolicy(view) {
  const policy = view.policy.unemploymentBenefit;
  const last = view.policy.lastDay || {};
  const agriculture = view.agriculturePolicy;
  const industries = [["mill", "磨坊"], ["bakery", "面包房"], ["lumberyard", "伐木场"], ["saltworks", "盐场"]];
  const privateTaxes = industries.map(([id, name]) => `<div class="row"><span class="label">${name}</span><div class="setting-input">${renderNumericInput(view, { key: `private-tax:${id}`, kind: "private-tax-rate", target: id, value: view.policy.privateProductionTaxPercent?.[id] ?? 10, label: `${name}民营生产税率`, minimum: 0, maximum: 80, className: "setting-editor" })}<b>%</b></div></div>`).join("");
  // 建筑门控（0.1.11 补回）：无相关建筑时不渲染对应卡片
  const buildingTypeIds = new Set((view.buildings || []).map(b => b.typeId));
  const hasCommerce = buildingTypeIds.has("commercial_street") || buildingTypeIds.has("public_housing") || (view.shops || []).length > 0;
  const hasIndustry = industries.some(([id]) => buildingTypeIds.has(id));
  const workshopWage = view.wageRates.millers ?? view.wageRates.bakers ?? 5;
  const builderWage = view.wageRates.builders ?? 5;
  const shopTax = (view.shops || []).reduce((sum, row) => sum + (row.lastTaxVoucher || 0), 0);
  const relief = view.relief || {};
  const neighborAid = view.neighborAid || {};
  const neighborAidDay = neighborAid.lastDay || {};
  const reform = view.monetaryReform;
  const moneyUnit = reform.stage === "wheat" ? "斤小麦" : reform.stage === "voucher" ? "粮券" : `小麦等值（目标${number(reform.targetPercent, 2)}%粮券）`;
  const reformAction = reform.stage === "wheat"
    ? `<button class="primary wide" data-reform-start ${reform.hasBankAccess ? "" : "disabled"}>启动货币改革</button><div class="subtle">${reform.hasBankAccess ? "启动后进入过渡期，初始粮券支付比例为0%。" : "需先建成银行后才能启动。"}</div>`
    : `<button class="secondary wide" data-bank-open>进入银行管理</button>`;
  // 货币改革简化态（0.1.11 补回）：小麦阶段且无银行时只显示一行提示
  const reformCard = (reform.stage === "wheat" && !reform.hasBankAccess)
    ? `<div class="cardlet subtle">货币改革：建成银行后可启动。</div>`
    : `<details class="detail-block" data-detail-key="policy-reform"><summary>货币改革</summary><div class="detail-body">
      <div class="row"><span class="label">当前制度</span><strong class="value">${reform.stageName}</strong></div>
      ${reform.stage !== "wheat" ? `<div class="row"><span class="label">目标粮券支付比例</span><strong class="value">${number(reform.targetPercent, 2)}%</strong></div>` : ""}
      ${reform.legacyBankAccess && !reform.hasPhysicalBank ? `<div class="subtle">旧存档兼容银行入口已启用，不占用地图地块。</div>` : ""}
      ${reformAction}
    </div></details>`;
  return `${reformCard}
    ${hasCommerce ? `<details class="detail-block" data-detail-key="policy-commerce"><summary>家庭与商业</summary><div class="detail-body">` : `<div class="cardlet policy-commerce">`}
      <div class="row"><span class="label">营业店铺日租</span><div class="setting-input">${renderNumericInput(view, { key: "shop-rent", kind: "shop-rent", target: "shops", value: view.policy.shopRentVoucher ?? 1, label: "每间营业店铺每日租金", minimum: 0, maximum: 100000, className: "setting-editor" })}<b>${moneyUnit}</b></div></div>
      <div class="row"><span class="label">商业利润税</span><div class="setting-input">${renderNumericInput(view, { key: "shop-tax", kind: "shop-profit-tax", target: "shops", value: view.policy.shopProfitTaxPercent ?? 10, label: "商业利润税", minimum: 0, maximum: 80, className: "setting-editor" })}<b>%</b></div></div>
      
      <div class="row"><span class="label">今日住宅实收租金</span><strong class="value">${number(view.housing.lastRentDay?.collectedVoucher || 0,1)}${moneyUnit}</strong></div>
      <div class="row"><span class="label">最近店铺利润税</span><strong class="value">${number(shopTax,1)}${moneyUnit}</strong></div>
      
    ${hasCommerce ? "</div></details>" : "</div>"}
    <details class="detail-block" data-detail-key="policy-welfare"><summary>工资与福利</summary><div class="detail-body">
      <div class="row"><span class="label">作坊 / 建筑日薪</span><strong class="value">${number(workshopWage)} / ${number(builderWage)}${moneyUnit}</strong></div>
      <label class="toggle"><input id="benefitEnabled" type="checkbox" ${policy.enabled ? "checked" : ""}><span>失业金</span></label>
      <div class="row"><span class="label">每名待业者每日</span><div class="setting-input">${renderNumericInput(view, { key: "unemployment-rate", kind: "unemployment-rate", target: "unemployment", value: policy.dailyPerWorkerJin, label: "每名待业者每日失业金", minimum: 0, maximum: 100000, className: "setting-editor" })}<b>${moneyUnit}</b></div></div>
      <div class="row"><span class="label">符合 / 已覆盖 / 未覆盖</span><strong class="value">${number(last.eligible ?? view.policy.unemployed)} / ${number(last.paidPeople||0)} / ${number(last.uncoveredPeople||0)}人</strong></div>
      <div class="row"><span class="label">应发 / 实发</span><strong class="value">${number(last.expectedVoucher||0,1)} / ${number(last.paidVoucher||0,1)}${moneyUnit}</strong></div>
      ${policy.enabled && (last.shortWheatJin || 0) > 0 ? `<div class="shortage-banner visible">今日少发 ${number(last.shortWheatJin)}${moneyUnit}</div>` : ""}
    </div></details>
    <details class="detail-block" data-detail-key="policy-wage"><summary>工资调控</summary><div class="detail-body">
      <div class="row"><span class="label">公务员类系数（政务/警察/银行/交易所）</span><div class="setting-input">${renderNumericInput(view, { key: "wage-control-civil", kind: "wage-control-civil", target: "wageControl", value: view.policy.wageControl?.civil ?? 1, label: "公务员类工资系数", minimum: 0, maximum: 10, className: "setting-editor" })}<b>×</b></div></div>
      <div class="row"><span class="label">镇营产业类系数（其余镇营岗位）</span><div class="setting-input">${renderNumericInput(view, { key: "wage-control-industry", kind: "wage-control-industry", target: "wageControl", value: view.policy.wageControl?.industry ?? 1, label: "镇营产业类工资系数", minimum: 0, maximum: 10, className: "setting-editor" })}<b>×</b></div></div>
      <div class="row"><span class="label">今日镇营工资应发</span><strong class="value">${number(view.policy.wageLastDay?.expectedVoucher || 0, 1)}${moneyUnit}</strong></div>
      <div class="subtle">系数1为基准，不影响上市公司。</div>
    </div></details>
    <details class="detail-block" data-detail-key="policy-social"><summary>社保基金</summary><div class="detail-body">
      <label class="toggle"><input id="socialSecurityEnabled" type="checkbox" ${view.policy.socialSecurity?.enabled ? "checked" : ""}><span>开启社保基金</span></label>
      <div class="row"><span class="label">每劳动力每日缴纳</span><div class="setting-input">${renderNumericInput(view, { key: "social-daily", kind: "social-daily", target: "socialSecurity", value: view.policy.socialSecurity?.dailyPerWorkerJin ?? 1, label: "社保每日缴费", minimum: 0, maximum: 100000, className: "setting-editor" })}<b>斤</b></div></div>
      <div class="row"><span class="label">每老人每日养老金</span><div class="setting-input">${renderNumericInput(view, { key: "social-pension", kind: "social-pension", target: "socialSecurity", value: view.policy.socialSecurity?.pensionPerElderJin ?? 2, label: "养老金标准", minimum: 0, maximum: 100000, className: "setting-editor" })}<b>斤</b></div></div>
      <div class="row"><span class="label">手动注资（镇库→基金）</span><div class="setting-input">${renderNumericInput(view, { key: "social-inject", kind: "social-inject", target: "socialSecurity", value: 10000, label: "社保基金注资金额", minimum: 0, maximum: 1000000000, className: "setting-editor" })}<b>斤</b><button class="secondary" data-social-inject>注资</button></div></div>
      <div class="row"><span class="label">基金余额</span><strong class="value">${number(view.policy.socialSecurity?.balanceJin || 0, 1)}斤</strong></div>
      <div class="row"><span class="label">累计注资 / 收缴 / 支出</span><strong class="value">${number(view.policy.socialSecurity?.totalInjectedJin || 0, 1)} / ${number(view.policy.socialSecurity?.totalCollectedJin || 0, 1)} / ${number(view.policy.socialSecurity?.totalPaidJin || 0, 1)}斤</strong></div>
      <div class="subtle">工资代扣；基金不足时镇库兜底。</div>
    </div></details>
    <details class="detail-block" data-detail-key="policy-villa"><summary>别墅</summary><div class="detail-body">
      <div class="row"><span class="label">别墅定价</span><div class="setting-input">${renderNumericInput(view, { key: "villa-price", kind: "villa-price", target: "villa", value: view.policy.villa?.priceWheatJin ?? 10000, label: "别墅定价", minimum: 0, maximum: 1000000000, className: "setting-editor" })}<b>小麦等值</b></div></div>
      <div class="row"><span class="label">房产税率（每年1月1日征收）</span><div class="setting-input">${renderNumericInput(view, { key: "villa-tax-rate", kind: "villa-tax-rate", target: "villa", value: view.policy.villa?.taxRatePercent ?? 0.5, label: "别墅房产税率", minimum: 0, maximum: 100, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">别墅群 / 已售 / 空置</span><strong class="value">${number(view.policy.villaStats?.complexes || 0)}座 / ${number(view.policy.villaStats?.sold || 0)}栋 / ${number(view.policy.villaStats?.vacant || 0)}栋</strong></div>
      <div class="row"><span class="label">累计购房款（已入镇库）</span><strong class="value">${number(view.policy.villaStats?.revenueWheatJin || 0, 1)}小麦等值</strong></div>
      <div class="row"><span class="label">累计房产税 / 欠税</span><strong class="value">${number(view.policy.villaStats?.taxCollectedWheatJin || 0, 1)} / ${number(view.policy.villaStats?.taxArrearsWheatJin || 0, 1)}小麦等值</strong></div>
      
    </div></details>
    ${reform.hasBankAccess ? `<details class="detail-block" data-detail-key="policy-bank"><summary>银行</summary><div class="detail-body">
      <div class="row"><span class="label">存款年利率</span><div class="setting-input">${renderNumericInput(view, { key: "bank-deposit-rate", kind: "bank-deposit-rate", target: "bank", value: view.policy.bankStats?.depositRateAnnualPercent ?? 2, label: "银行存款年利率", minimum: 0, maximum: 100, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">贷款年利率</span><div class="setting-input">${renderNumericInput(view, { key: "bank-loan-rate", kind: "bank-loan-rate", target: "bank", value: view.policy.bankStats?.loanRateAnnualPercent ?? 6, label: "银行贷款年利率", minimum: 0, maximum: 100, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">准备金率</span><div class="setting-input">${renderNumericInput(view, { key: "bank-reserve", kind: "bank-reserve", target: "bank", value: view.policy.bankStats?.reserveRequirementPercent ?? 10, label: "银行准备金率", minimum: 0, maximum: 100, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">居民存款 / 在贷余额</span><strong class="value">${number(view.policy.bankStats?.totalDepositsVoucher || 0, 1)} / ${number(view.policy.bankStats?.outstandingLoansVoucher || 0, 1)}券</strong></div>
      <div class="row"><span class="label">可贷额度 / 坏账累计</span><strong class="value">${number(view.policy.bankStats?.loanableVoucher || 0, 1)} / ${number(view.policy.bankStats?.badDebtVoucher || 0, 1)}券</strong></div>
      <div class="row"><span class="label">累计收息 / 付息</span><strong class="value">${number(view.policy.bankStats?.interestEarnedVoucher || 0, 1)} / ${number(view.policy.bankStats?.interestPaidVoucher || 0, 1)}券</strong></div>
      <div class="subtle">按日计息；逾期30天核销坏账。</div>
    </div></details>` : ""}
    ${reform.stage === "voucher" ? `<details class="detail-block" data-detail-key="policy-bonds"><summary>国债</summary><div class="detail-body">
      <div class="row"><span class="label">发行总额</span><div class="setting-input">${renderNumericInput(view, { key: "bond-issue-total", kind: "bond-issue-total", target: "bonds", value: 100000, label: "国债发行总额", minimum: 1, maximum: 1000000000, className: "setting-editor" })}<b>券</b></div></div>
      <div class="row"><span class="label">期限</span><div class="setting-input">${renderNumericInput(view, { key: "bond-issue-years", kind: "bond-issue-years", target: "bonds", value: 3, label: "国债期限", minimum: 1, maximum: 10, className: "setting-editor" })}<b>年</b><button class="secondary" data-bond-issue>发行</button></div></div>
      <div class="row"><span class="label">起拍票面年利率</span><div class="setting-input">${renderNumericInput(view, { key: "bond-issue-rate", kind: "bond-issue-rate", target: "bonds", value: 3, label: "国债起拍票面年利率", minimum: 0, maximum: 20, className: "setting-editor" })}<b>%</b></div></div>
      ${(view.policy.bondStats?.issues || []).map(issue => `<div class="row"><span class="label">${issue.id} · ${issue.statusLabel}</span><strong class="value">${number(issue.totalVoucher)}券 · 票面${number(issue.couponRateAnnualPercent, 2)}% · ${issue.termYears}年</strong></div>`).join("")}
      ${(view.policy.bondStats?.creditPenaltyBps || 0) > 0 ? `<div class="shortage-banner visible">镇库信用受损，发债利率上浮${number(view.policy.bondStats.creditPenaltyBps / 100, 2)}%</div>` : ""}
      <div class="subtle">认购7天，不足3成流拍；每年付息，到期还本。</div>
    </div></details>` : ""}
    <details class="detail-block" data-detail-key="policy-agritax"><summary>农业税</summary><div class="detail-body">
      <div class="row"><span class="label">当前税率</span><div class="setting-input">${renderNumericInput(view, { key: "agriculture-tax", kind: "agriculture-tax", target: "agriculture", value: agriculture.currentPercent, label: "农业税率", minimum: 0, maximum: 80, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">预计秋收分粮</span><strong class="value">镇库${number(agriculture.townShareJin)} / 居民${number(agriculture.residentShareJin)}斤</strong></div>
      <div class="subtle">${agriculture.lastHarvest ? `上次秋收实际：镇库${number(agriculture.lastHarvest.townJin)} / 居民${number(agriculture.lastHarvest.residentJin)}斤` : "尚未到秋收结算；税率按农事日累计。"}</div>
    </div></details>
    <details class="detail-block" data-detail-key="policy-relief"><summary>救济</summary><div class="detail-body"><div class="row"><span class="label">需救济 / 已拨家庭</span><strong class="value">${number(relief.eligibleHouseholds||0)} / ${number(relief.servedHouseholds||0)}户</strong></div><div class="row"><span class="label">今日正常兑付 / 救济</span><strong class="value">${number((relief.redeemedWheatUnits||0)/view.inventoryUnitsPerJin,1)} / ${number((relief.movedQeqUnits||0)/view.qeqUnitsPerJin,1)}斤</strong></div>${(relief.missingQeqUnits||0)>0?`<div class="shortage-banner visible">镇库不足，尚缺 ${number(relief.missingQeqUnits/view.qeqUnitsPerJin,1)}斤口粮</div>`:""}<div class="row"><span class="label">今日邻里互助</span><strong class="value">${number(neighborAidDay.donorHouseholds||0)}户接济${number(neighborAidDay.helpedHouseholds||0)}户 · ${number((neighborAidDay.movedQeqUnits||0)/view.qeqUnitsPerJin,1)}斤</strong></div><div class="row"><span class="label">本年邻里接济</span><strong class="value">${number((neighborAid.year?.movedQeqUnits||0)/view.qeqUnitsPerJin,1)}斤</strong></div></div></details>
    ${hasIndustry ? `<details class="detail-block" data-detail-key="policy-privatetax"><summary>民营生产税</summary><div class="detail-body">${privateTaxes}</div></details>` : ""}
    <details class="detail-block" data-detail-key="policy-detail"><summary>政策详情</summary><div class="detail-body">
      <div class="row"><span class="label">本季农业税平均</span><strong class="value">${number(agriculture.accumulatedAveragePercent, 2)}%</strong></div>
      <div class="row"><span class="label">预计结算税率</span><strong class="value">${number(agriculture.projectedSettlementPercent, 2)}%</strong></div>
      <div class="row"><span class="label">本日失业金已发 / 少发</span><strong class="value">${number(last.paidWheatJin || 0)} / ${number(last.shortWheatJin || 0)}${moneyUnit}</strong></div>
      <div class="row"><span class="label">预计年度失业金</span><strong class="value">${number(view.policy.annualExpectedWheatJin)}${moneyUnit}</strong></div>
    </div></details>`;
}
