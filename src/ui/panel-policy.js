import { escapeHtml, number, numberMax, payDayText } from "./format.js";
import { CONTENT } from "../content/index.js";
import { industryTypeIds } from "../content/buildings.js";
import { renderNumericInput } from "./numeric-drafts.js";

// 再分配：富人税（按人均家底分三档、超额累进）与遗产税（docs/REDISTRIBUTION.md 第 1、2 条）。
// 富人税三个门槛与三档税率一起暂存在输入框草稿里，由"保存"按钮一次提交（app.js 读取）。
export const WEALTH_TAX_THRESHOLD_KEYS = [0, 1, 2].map(index => `wealth-tax:threshold:${index}`);
export const WEALTH_TAX_RATE_KEYS = [0, 1, 2].map(index => `wealth-tax:rate:${index}`);
const WEALTH_TAX_DEFAULT_THRESHOLDS = [300, 1000, 3000];
const WEALTH_TAX_DEFAULT_RATES = [0, 0, 0];

function stagedTaxInput(view, key, value, label, maximum) {
  const shown = view.numericDrafts?.[key]?.value ?? String(value ?? "");
  return `<input class="staged-input" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" spellcheck="false" value="${escapeHtml(shown)}" aria-label="${escapeHtml(label)}" data-draft-key="${escapeHtml(key)}" data-draft-kind="stage" data-draft-label="${escapeHtml(label)}" data-draft-minimum="0" data-draft-maximum="${maximum}" data-draft-integer="false" data-draft-positive="false">`;
}

function wealthTaxCard(view) {
  const policy = view.policy.wealthTax || {};
  const thresholds = Array.isArray(policy.thresholds) && policy.thresholds.length === 3 ? policy.thresholds : WEALTH_TAX_DEFAULT_THRESHOLDS;
  const rates = Array.isArray(policy.ratesPercent) && policy.ratesPercent.length === 3 ? policy.ratesPercent : WEALTH_TAX_DEFAULT_RATES;
  const year = view.inequality?.thisYear;
  const thresholdRows = thresholds.map((value, index) => `<div class="row"><span class="label">${index + 1}档门槛 · 人均家底超过（券）</span><div class="setting-input">${stagedTaxInput(view, WEALTH_TAX_THRESHOLD_KEYS[index], value, `富人税第${index + 1}档门槛`, 1000000000)}<b>券</b></div></div>`).join("");
  const rateRows = rates.map((value, index) => `<div class="row"><span class="label">${index + 1}档年税率（超过门槛部分）</span><div class="setting-input">${stagedTaxInput(view, WEALTH_TAX_RATE_KEYS[index], value, `富人税第${index + 1}档年税率`, 20)}<b>%</b></div></div>`).join("");
  const collected = year
    ? `<div class="row"><span class="label">本年已收 / 付不起免征</span><strong class="value">${number(year.wealthTaxVoucher, 2)} / ${number(year.wealthTaxWaivedVoucher, 2)}券</strong></div><div class="row"><span class="label">本年纳税户数</span><strong class="value">${number(year.wealthTaxPayers)}户</strong></div>`
    : "";
  return `<details class="detail-block" data-detail-key="policy-wealthtax"><summary>富人税</summary><div class="detail-body">
      <div class="subtle">超额累进，每30天收一次，付不起的部分当月免征。家底含粮券、存款、超出口粮储备的小麦、股票与民营建筑；按人均家底分档。</div>
      ${thresholdRows}
      ${rateRows}
      <div class="settings-actions"><button class="primary" data-wealth-tax-save>保存</button></div>
      ${collected}
    </div></details>`;
}

function inheritanceTaxCard(view) {
  const percent = view.policy.inheritanceTaxPercent ?? 0;
  const year = view.inequality?.thisYear;
  const collected = year
    ? `<div class="row"><span class="label">本年遗产税 / 无主家产归公</span><strong class="value">${number(year.inheritanceTaxVoucher, 2)} / ${number(year.escheatVoucher, 2)}券</strong></div>`
    : "";
  return `<details class="detail-block" data-detail-key="policy-inheritance"><summary>遗产税</summary><div class="detail-body">
      <div class="row"><span class="label">遗产税率（超过富人税第一档门槛的部分）</span><div class="setting-input">${renderNumericInput(view, { key: "inheritance-tax", kind: "inheritance-tax", target: "policy", value: percent, label: "遗产税率", minimum: 0, maximum: 50, className: "setting-editor" })}<b>%</b></div></div>
      <div class="subtle">整户无人时家产归镇库（一直生效）。</div>
      ${collected}
    </div></details>`;
}

// 商店与贸易利润率（政策 shopMarginPercent / tradeMarginPercent / tradeImportMarginPercent，0—200，一位小数）。
// 旧档没有这些字段时回落到 rules 的开局默认值，与读档后的实际取值一致。
function marginPolicyCard(view) {
  const policy = view.policy || {};
  const shopDefault = policy.shopMarginPercent ?? CONTENT.rules.generalStoreMarkupPercent ?? 20;
  const tradeExport = policy.tradeMarginPercent ?? CONTENT.rules.tradeHouseTargetMarginPercent ?? 20;
  const tradeImport = policy.tradeImportMarginPercent ?? CONTENT.rules.tradeHouseImportMarginPercent ?? 25;
  return `<details class="detail-block" data-detail-key="policy-margin"><summary>商店与贸易利润率</summary><div class="detail-body">
      <div class="row"><span class="label">综合商店默认目标利润率</span><div class="setting-input">${renderNumericInput(view, { key: "shop-margin-default", kind: "shop-margin-default", target: "policy", value: shopDefault, label: "综合商店默认目标利润率", minimum: 0, maximum: 200, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">贸易行出口利润门槛</span><div class="setting-input">${renderNumericInput(view, { key: "trade-margin-export", kind: "trade-margin-export", target: "policy", value: tradeExport, label: "贸易行出口利润门槛", minimum: 0, maximum: 200, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">贸易行进口利润门槛</span><div class="setting-input">${renderNumericInput(view, { key: "trade-margin-import", kind: "trade-margin-import", target: "policy", value: tradeImport, label: "贸易行进口利润门槛", minimum: 0, maximum: 200, className: "setting-editor" })}<b>%</b></div></div>
      <div class="subtle">综合商店：未单独设置的店铺跟随默认值，改动后按7天复核平滑过渡（每次价格最多±10%），单店可在店铺详情里覆盖。贸易行：卖价（或买价）相对成本加运费的利润率达到门槛才成交；门槛越高成交越少。进口门槛不得低于出口：只调高出口时进口门槛会被联动抬到相同，调低进口低于出口则拒绝。</div>
    </div></details>`;
}

// 银行与国债的利率、准备金率、发行控件都在银行建筑面板；政策页只留一行摘要和跳转按钮。
function bankPolicyCard(view) {
  const stats = view.policy?.bankStats || {};
  const activeBonds = view.policy?.bondStats?.activeCount || 0;
  return `<div class="cardlet policy-bank"><div class="row"><span class="label">银行</span><strong class="value">存款 ${numberMax(stats.depositRateAnnualPercent ?? 2, 2)}% · 贷款 ${numberMax(stats.loanRateAnnualPercent ?? 6, 2)}% · 国债 ${number(activeBonds)} 笔</strong></div>
      <div class="subtle">利率、准备金率与国债发行在银行面板。</div>
      <button class="secondary wide" data-bank-open>前往银行</button></div>`;
}

export function renderPolicy(view) {
  const policy = view.policy.unemploymentBenefit;
  const last = view.policy.lastDay || {};
  const agriculture = view.agriculturePolicy;
  const industries = industryTypeIds(CONTENT).map(id => [id, CONTENT.buildings[id].name]);
  const privateTaxes = industries.map(([id, name]) => `<div class="row"><span class="label">${name}</span><div class="setting-input">${renderNumericInput(view, { key: `private-tax:${id}`, kind: "private-tax-rate", target: id, value: view.policy.privateProductionTaxPercent?.[id] ?? 10, label: `${name}民营生产税率`, minimum: 0, maximum: 80, className: "setting-editor" })}<b>%</b></div></div>`).join("");
  // 建筑门控（0.1.11 补回）：无相关建筑时不渲染对应卡片
  const buildingTypeIds = new Set((view.buildings || []).map(b => b.typeId));
  const hasCommerce = buildingTypeIds.has("commercial_street") || buildingTypeIds.has("trade_center") || buildingTypeIds.has("public_housing") || (view.shops || []).length > 0;
  const hasIndustry = industries.some(([id]) => buildingTypeIds.has(id));
  const hasStall = buildingTypeIds.has("times_square");
  const shopTax = (view.shops || []).reduce((sum, row) => sum + (row.lastTaxVoucher || 0), 0);
  const relief = view.relief || {};
  const reform = view.monetaryReform;
  const moneyUnit = reform.stage === "wheat" ? "斤小麦" : "粮券";
  const reformAction = `<button class="primary wide" data-reform-start ${reform.hasBankAccess ? "" : "disabled"}>启动货币改革</button><div class="subtle">${reform.hasBankAccess ? "启动后立即改用粮券：镇库按小麦存量印制等额粮券。" : "需先建成银行后才能启动。"}</div>`;
  // 货币改革：小麦阶段（旧档）仍是折叠块带启动按钮；粮券阶段（开局即是）改为默认可见的一行，入口在银行面板。
  const reformCard = (reform.stage === "wheat" && !reform.hasBankAccess)
    ? `<div class="cardlet subtle">货币改革：建成银行后可启动。</div>`
    : reform.stage === "wheat"
      ? `<details class="detail-block" data-detail-key="policy-reform"><summary>货币改革</summary><div class="detail-body">
      <div class="row"><span class="label">当前制度</span><strong class="value">${reform.stageName}</strong></div>
      ${reform.legacyBankAccess && !reform.hasPhysicalBank ? `<div class="subtle">旧存档兼容银行入口已启用，不占用地图地块。</div>` : ""}
      ${reformAction}
    </div></details>`
      : `<div class="cardlet policy-reform"><div class="row"><span class="label">货币改革</span><strong class="value">${reform.stageName}</strong></div>
      ${reform.hasBankAccess
        ? `<div class="subtle">印券、以粮换券与国债在银行管理。</div><button class="secondary wide" data-bank-open>进入银行管理</button>`
        : `<div class="subtle">粮券已是开局制度；印券、以粮换券与国债需先建成银行。</div>`}
      ${reform.legacyBankAccess && !reform.hasPhysicalBank ? `<div class="subtle">旧存档兼容银行入口已启用，不占用地图地块。</div>` : ""}
    </div>`;
  return `${reformCard}
    ${marginPolicyCard(view)}
    ${hasCommerce ? `<details class="detail-block" data-detail-key="policy-commerce"><summary>家庭与商业</summary><div class="detail-body">` : `<div class="cardlet policy-commerce">`}
      <div class="row"><span class="label">营业店铺日租</span><div class="setting-input">${renderNumericInput(view, { key: "shop-rent", kind: "shop-rent", target: "shops", value: view.policy.shopRentVoucher ?? 1, label: "每间营业店铺每日租金", minimum: 0, maximum: 100000, className: "setting-editor" })}<b>${moneyUnit}</b></div></div>
      ${hasStall ? `<div class="row"><span class="label">摊位日租</span><div class="setting-input">${renderNumericInput(view, { key: "stall-rent", kind: "stall-rent", target: "stalls", value: view.policy.stallRentVoucher ?? 2, label: "每摊每日摊租", minimum: 0, maximum: 100000, className: "setting-editor" })}<b>${moneyUnit}</b></div></div>
      <div class="row"><span class="label">允许摆摊人数</span><div class="setting-input">${renderNumericInput(view, { key: "stall-limit", kind: "stall-limit", target: "stalls", value: view.policy.stallKeeperLimit ?? 50, label: "允许摆摊人数", integer: true, minimum: 0, maximum: 100000, className: "setting-editor" })}<b>人</b></div></div>` : ""}
      <div class="row"><span class="label">商业利润税</span><div class="setting-input">${renderNumericInput(view, { key: "shop-tax", kind: "shop-profit-tax", target: "shops", value: view.policy.shopProfitTaxPercent ?? 10, label: "商业利润税", minimum: 0, maximum: 80, className: "setting-editor" })}<b>%</b></div></div>
      
      <div class="row"><span class="label">今日住宅实收租金</span><strong class="value">${number(view.housing.lastRentDay?.collectedVoucher || 0,1)}${moneyUnit}</strong></div>
      <div class="row"><span class="label">最近店铺利润税</span><strong class="value">${number(shopTax,1)}${moneyUnit}</strong></div>
      
    ${hasCommerce ? "</div></details>" : "</div>"}
    <details class="detail-block" data-detail-key="policy-welfare"><summary>工资与福利</summary><div class="detail-body">
      <label class="toggle"><input id="benefitEnabled" type="checkbox" ${policy.enabled ? "checked" : ""}><span>失业金</span></label>
      <div class="row"><span class="label">每名待业者每日</span><div class="setting-input">${renderNumericInput(view, { key: "unemployment-rate", kind: "unemployment-rate", target: "unemployment", value: policy.dailyPerWorkerJin, label: "每名待业者每日失业金", minimum: 0, maximum: 100000, className: "setting-editor" })}<b>${moneyUnit}</b></div></div>
      <div class="row"><span class="label">符合 / 已覆盖 / 未覆盖</span><strong class="value">${number(last.eligible ?? view.policy.unemployed)} / ${number(last.paidPeople||0)} / ${number(last.uncoveredPeople||0)}人</strong></div>
      <div class="row"><span class="label">应发 / 实发</span><strong class="value">${number(last.expectedVoucher||0,1)} / ${number(last.paidVoucher||0,1)}${moneyUnit}</strong></div>
      ${policy.enabled && (last.shortWheatJin || 0) > 0 ? `<div class="shortage-banner visible">今日少发 ${number(last.shortWheatJin)}${moneyUnit}</div>` : ""}
    </div></details>
    <details class="detail-block" data-detail-key="policy-wage"><summary>工资调控</summary><div class="detail-body">
      <div class="row"><span class="label">公务员类系数（政务/警察/银行/交易所/社保）</span><div class="setting-input">${renderNumericInput(view, { key: "wage-control-civil", kind: "wage-control-civil", target: "wageControl", value: view.policy.wageControl?.civil ?? 1, label: "公务员类工资系数", minimum: 0, maximum: 10, className: "setting-editor" })}<b>×</b></div></div>
      <div class="row"><span class="label">镇营产业类系数（其余镇营岗位）</span><div class="setting-input">${renderNumericInput(view, { key: "wage-control-industry", kind: "wage-control-industry", target: "wageControl", value: view.policy.wageControl?.industry ?? 1, label: "镇营产业类工资系数", minimum: 0, maximum: 10, className: "setting-editor" })}<b>×</b></div></div>
      <div class="row"><span class="label">今日镇营工资应发</span><strong class="value">${number(view.policy.wageLastDay?.expectedVoucher || 0, 1)}${moneyUnit}</strong></div>
      <div class="subtle">岗位日薪 = 基础日薪 × 系数，月薪 = 日薪 × ${view.monthDays || 30}；不影响公司自定工资。工资按月计提，镇营${payDayText(5)}，店铺、民营、公司的发薪日（5—25号）按盈利排定。</div>
    </div></details>
    <details class="detail-block" data-detail-key="policy-villa"><summary>别墅</summary><div class="detail-body">
      <div class="row"><span class="label">别墅定价</span><div class="setting-input">${renderNumericInput(view, { key: "villa-price", kind: "villa-price", target: "villa", value: view.policy.villa?.priceWheatJin ?? 10000, label: "别墅定价", minimum: 0, maximum: 1000000000, className: "setting-editor" })}<b>小麦等值</b></div></div>
      <div class="row"><span class="label">房产税率（每年1月1日征收）</span><div class="setting-input">${renderNumericInput(view, { key: "villa-tax-rate", kind: "villa-tax-rate", target: "villa", value: view.policy.villa?.taxRatePercent ?? 0.5, label: "别墅房产税率", minimum: 0, maximum: 100, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">别墅群 / 已售 / 空置</span><strong class="value">${number(view.policy.villaStats?.complexes || 0)}座 / ${number(view.policy.villaStats?.sold || 0)}栋 / ${number(view.policy.villaStats?.vacant || 0)}栋</strong></div>
      <div class="row"><span class="label">累计购房款（已入镇库）</span><strong class="value">${number(view.policy.villaStats?.revenueWheatJin || 0, 1)}小麦等值</strong></div>
      <div class="row"><span class="label">累计房产税 / 欠税</span><strong class="value">${number(view.policy.villaStats?.taxCollectedWheatJin || 0, 1)} / ${number(view.policy.villaStats?.taxArrearsWheatJin || 0, 1)}小麦等值</strong></div>
      
    </div></details>
    ${reform.hasBankAccess ? bankPolicyCard(view) : ""}
    ${reform.stage === "voucher" && !reform.hasBankAccess ? `<div class="cardlet subtle">国债：建成银行后可发行。</div>` : ""}
    <details class="detail-block" data-detail-key="policy-agritax"><summary>农业税</summary><div class="detail-body">
      <div class="row"><span class="label">当前税率</span><div class="setting-input">${renderNumericInput(view, { key: "agriculture-tax", kind: "agriculture-tax", target: "agriculture", value: agriculture.currentPercent, label: "农业税率", minimum: 0, maximum: 80, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">预计秋收分粮</span><strong class="value">镇库${number(agriculture.townShareJin)} / 居民${number(agriculture.residentShareJin)}斤</strong></div>
      <div class="subtle">${agriculture.lastHarvest ? `上次秋收实际：镇库${number(agriculture.lastHarvest.townJin)} / 居民${number(agriculture.lastHarvest.residentJin)}斤` : "尚未到秋收结算；税率按农事日累计。"}</div>
    </div></details>
    <details class="detail-block" data-detail-key="policy-relief"><summary>救济</summary><div class="detail-body"><div class="row"><span class="label">需救济 / 已拨家庭</span><strong class="value">${number(relief.eligibleHouseholds||0)} / ${number(relief.servedHouseholds||0)}户</strong></div><div class="row"><span class="label">今日正常兑付 / 救济</span><strong class="value">${number((relief.redeemedWheatUnits||0)/view.inventoryUnitsPerJin,1)} / ${number((relief.movedQeqUnits||0)/view.qeqUnitsPerJin,1)}斤</strong></div>${(relief.missingQeqUnits||0)>0?`<div class="shortage-banner visible">镇库不足，尚缺 ${number(relief.missingQeqUnits/view.qeqUnitsPerJin,1)}斤口粮</div>`:""}<label class="toggle"><input id="autoRelief" type="checkbox" ${view.autoRelief ? "checked" : ""}><span>开启救济</span></label><div class="subtle">口粮不足7天的家庭补到14天；社保基金开启时由基金承担。</div></div></details>
    ${hasIndustry ? `<details class="detail-block" data-detail-key="policy-privatetax"><summary>民营生产税</summary><div class="detail-body">${privateTaxes}</div></details>` : ""}
    ${wealthTaxCard(view)}
    ${inheritanceTaxCard(view)}
    <details class="detail-block" data-detail-key="policy-detail"><summary>政策详情</summary><div class="detail-body">
      <div class="row"><span class="label">本季农业税平均</span><strong class="value">${number(agriculture.accumulatedAveragePercent, 2)}%</strong></div>
      <div class="row"><span class="label">预计结算税率</span><strong class="value">${number(agriculture.projectedSettlementPercent, 2)}%</strong></div>
      <div class="row"><span class="label">本日失业金已发 / 少发</span><strong class="value">${number(last.paidWheatJin || 0)} / ${number(last.shortWheatJin || 0)}${moneyUnit}</strong></div>
      <div class="row"><span class="label">预计年度失业金</span><strong class="value">${number(view.policy.annualExpectedWheatJin)}${moneyUnit}</strong></div>
    </div></details>`;
}
