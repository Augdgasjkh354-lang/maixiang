import { escapeHtml, number } from "./format.js";
import { renderNumericInput } from "./numeric-drafts.js";

const ITEM_META = {
  wheat: { name: "小麦", unit: "斤" },
  flour: { name: "面粉", unit: "斤" },
  bread: { name: "面包", unit: "斤" },
  salt: { name: "食盐", unit: "斤" },
  wood: { name: "木材", unit: "单位" }
};
const SELL_ITEMS = ["flour", "bread", "salt", "wood"];
const BUY_ITEMS = ["flour", "bread"];
const AGREEMENT_ITEMS = [
  { id: "salt", name: "食盐", unit: "斤" },
  { id: "wood", name: "木材", unit: "单位" },
  { id: "flour", name: "面粉", unit: "斤" },
  { id: "bread", name: "面包", unit: "斤" }
];

function tradeRow(view, itemId) {
  const ot = view.outsideTown;
  const meta = ITEM_META[itemId];
  const buyPrice = ot.buyPrices?.[itemId];
  const sellPrice = ot.sellPrices?.[itemId];
  const stock = ot.townStock?.[itemId] ?? 0;
  const canBuy = BUY_ITEMS.includes(itemId);
  // 警戒线恐慌加价时把加成标出来，方便玩家判断该不该现在卖。
  const panic = (itemId === "salt" && ot.saltWarning) || (itemId === "wood" && ot.woodWarning);
  return `<div class="cardlet"><div class="row"><span class="label">${meta.name}</span>
      <strong class="value">收购 ${number(buyPrice, 2)}${canBuy ? ` / 售价 ${number(sellPrice, 2)}` : ""} <span class="subtle">小麦斤/${meta.unit}</span>${panic ? ' <span class="subtle">⚠ 缺货加价中</span>' : ""}</strong></div>
    <div class="row"><span class="label">镇库存</span><strong class="value">${number(stock)}${meta.unit}</strong></div>
    <div class="row"><span class="label">数量</span><div class="setting-input">${renderNumericInput(view, { key: `outside-qty:${itemId}`, kind: "outside-trade-qty", target: itemId, value: "", label: `${meta.name}交易数量`, minimum: 0, maximum: 100000, className: "setting-editor" })}<b>${meta.unit}</b>
      <button class="secondary" data-outside-sell="${itemId}">卖出</button>
      ${canBuy ? `<button class="secondary" data-outside-buy="${itemId}">买入</button>` : ""}</div></div>
  </div>`;
}

// 民镇盐/木材库存与警戒线：零自产，全靠我方出口。
function stockRow(view, kind) {
  const ot = view.outsideTown;
  const isSalt = kind === "salt";
  const stock = isSalt ? ot.saltStockJin : ot.woodStockUnits;
  const annual = isSalt ? ot.annualSaltJin : ot.annualWoodUnits;
  const warning = isSalt ? ot.saltWarningJin : ot.woodWarningUnits;
  const unit = isSalt ? "斤" : "单位";
  const days = annual > 0 ? Math.round(stock / annual * 365) : 0;
  return `<div class="row"><span class="label">${isSalt ? "食盐" : "木材"}库存</span>
    <strong class="value">${number(stock)}${unit} <span class="subtle">（约${days}天 · 年耗${number(annual)}${unit} · 警戒线${number(warning)}${unit}）</span></strong></div>`;
}

function agreementRow(agreement) {
  const statusText = agreement.status === "active" ? "履行中"
    : agreement.status === "expired" ? "已到期"
    : agreement.status === "terminated" ? "已解约" : agreement.status;
  const breachText = agreement.breachCount > 0 ? ` · 违约${agreement.breachCount}次` : "";
  const terminateButton = agreement.status === "active"
    ? `<button class="secondary" data-agreement-terminate="${escapeHtml(agreement.id)}">解约</button>` : "";
  return `<div class="row"><span class="label">${escapeHtml(agreement.itemName || agreement.itemId)}</span>
    <strong class="value">年${number(agreement.annualJin)}${escapeHtml(agreement.unit || "斤")} · 月${number(agreement.monthlyJin)} · 单价${number(agreement.pricePerUnit, 2)} · 余${agreement.yearsLeft}/${agreement.yearsTotal}年 · ${statusText}${breachText}</strong>${terminateButton}</div>`;
}

export function renderOutsideTown(view) {
  const ot = view.outsideTown;
  if (!ot) return `<div class="subtle">外贸数据不可用。</div>`;
  const ta = view.tradeAgreements || { agreements: [], capacity: 0, relations: ot.relations ?? 60 };
  const eventText = ot.event ? `${escapeHtml(ot.event.type)}（${ot.event.year}年）` : "无";
  const statusLine = ot.tradeClosed
    ? `<div class="row"><span class="label">商路</span><strong class="value">中断中（今年无法贸易）</strong></div>`
    : "";
  // 关键按键进建筑：外贸房没人值守时的提示。
  const staffLine = ot.foreignTradeOperational
    ? `<div class="row"><span class="label">外贸房</span><strong class="value">在岗 ${number(ot.foreignTradeStaff)}人 · 可同时跟 ${number(ot.foreignTradeCapacity)}笔长协</strong></div>`
    : `<div class="row"><span class="label">外贸房</span><strong class="value">无人值守（需至少1名外贸职员，否则无法贸易与签约）</strong></div>`;
  const diplomacyLine = ot.diplomacyOperational
    ? `<div class="row"><span class="label">关系维护</span><strong class="value">外贸房在岗 ${number(ot.diplomacyStaff)}人 · 关系分回升中</strong></div>`
    : `<div class="row"><span class="label">关系维护</span><strong class="value">外贸房无人值守（关系分每日下滑）</strong></div>`;
  const relations = ot.relations ?? 60;
  const relationsNote = relations >= 70 ? "关系融洽（长协价×0.95、违约金减半）"
    : relations < 20 ? "关系破裂边缘（可能断交）"
    : relations < 40 ? "关系紧张（拒签新长协）" : "关系一般";
  const activeLoans = (ot.loans || []).filter(l => l.status === "active");
  const loanRows = activeLoans.length > 0
    ? activeLoans.map(l => `<div class="row"><span class="label">${l.issueYear}年放贷</span><strong class="value">本金${number(l.principalJin)}斤 · 欠${number(l.outstandingJin)}斤 · 息${number(l.accruedInterestJin, 1)}斤 · 年利率${number(l.annualRatePercent, 1)}%</strong></div>`).join("")
    : `<div class="subtle">暂无未还贷款。</div>`;
  const agreementRows = (ta.agreements || []).length > 0
    ? ta.agreements.map(agreementRow).join("")
    : `<div class="subtle">暂无长期协定。外贸房有人值守即可签约。</div>`;
  const signDisabled = !ot.foreignTradeOperational ? "disabled" : "";
  const signHint = !ot.foreignTradeOperational
    ? `<div class="subtle">外贸房无人值守，无法签约。</div>`
    : (ta.distrusted ? `<div class="subtle">民镇不信任你（关系分<40），拒绝签约。</div>`
      : (ta.activeCount >= ta.capacity ? `<div class="subtle">长协容量已满（在岗${number(ta.staff)}人 × 2笔）。</div>` : ""));
  return `<h2>外贸 · ${escapeHtml(ot.name)}</h2>
    <div class="cardlet">
      <div class="row"><span class="label">执政</span><strong class="value">${ot.rulers.map(escapeHtml).join("、")}</strong></div>
      <div class="row"><span class="label">耕地 / 劳动力</span><strong class="value">${number(ot.landMu)}亩 / ${number(ot.laborers)}人</strong></div>
      <div class="row"><span class="label">人口 / 繁荣度</span><strong class="value">${number(ot.population)}人 / ${number(ot.prosperity, 1)}</strong></div>
      <div class="row"><span class="label">小麦库存</span><strong class="value">${number(ot.wheatStockJin)}斤</strong></div>
      <div class="row"><span class="label">去年收成 / 消耗</span><strong class="value">${number(ot.lastYearProductionJin)} / ${number(ot.lastYearConsumptionJin)}斤</strong></div>
      <div class="row"><span class="label">今年大事</span><strong class="value">${eventText}</strong></div>
      ${statusLine}
      <div class="subtle">农业小镇，盛产小麦；盐、木材零自产，按人按年消耗，全靠我方出口。所有价格以小麦斤计价、实物小麦结算。</div>
    </div>
    <div class="cardlet"><h3>民镇库存与消耗</h3>
      ${stockRow(view, "salt")}
      ${stockRow(view, "wood")}
      <div class="row"><span class="label">断供惩罚</span><strong class="value">食盐归零 → 繁荣−15、人口−3%；木材归零 → 繁荣−8</strong></div>
    </div>
    ${SELL_ITEMS.map(itemId => tradeRow(view, itemId)).join("")}
    <div class="cardlet"><h3>对外关系</h3>
      <div class="row"><span class="label">外交关系分</span><strong class="value">${number(relations, 1)} / 100 · ${relationsNote}</strong></div>
      ${staffLine}
      ${diplomacyLine}
      <div class="subtle">外贸房在岗 ≥1 人关系分每日 +0.2；无人值守每日 −0.5。</div>
    </div>
    <div class="cardlet"><h3>长期贸易协定</h3>
      <div class="row"><span class="label">占用</span><strong class="value">${number(ta.activeCount || 0)} / ${number(ta.capacity || 0)} 笔</strong></div>
      ${signHint}
      ${agreementRows}
      <div class="row"><span class="label">品类</span><div class="setting-input">
        <select data-draft-key="trade-agreement-item" data-draft-kind="trade-agreement-item" data-draft-target="tradeAgreement" data-draft-label="长协品类" class="setting-editor">
          ${AGREEMENT_ITEMS.map(item => `<option value="${item.id}">${item.name}（${item.unit}）</option>`).join("")}
        </select></div></div>
      <div class="row"><span class="label">年供货量</span><div class="setting-input">${renderNumericInput(view, { key: "trade-agreement-annual", kind: "trade-agreement-annual", target: "tradeAgreement", value: "", label: "长协年供货量", minimum: 0, maximum: 5000000, className: "setting-editor", disabled: !ot.foreignTradeOperational })}<b>单位</b></div></div>
      <div class="row"><span class="label">年限</span><div class="setting-input">${renderNumericInput(view, { key: "trade-agreement-years", kind: "trade-agreement-years", target: "tradeAgreement", value: "", label: "长协年限", minimum: 1, maximum: 5, integer: true, className: "setting-editor", disabled: !ot.foreignTradeOperational })}<b>年</b>
        <button class="secondary" data-agreement-sign="1" ${signDisabled}>签约</button></div></div>
      <div class="subtle">签约按当时现货收购价锁定单价；每月自动交付 1/12（只从批发市场扣货）；货不足即我方违约，赔年货值10%并扣关系分，连续3次对方解约。</div>
    </div>
    <div class="cardlet"><div class="row"><span class="label">出口关税税率</span><div class="setting-input">${renderNumericInput(view, { key: "trade-tariff-rate", kind: "trade-tariff-rate", target: "tradeTariff", value: ot.tariffRate ?? 5, label: "出口关税税率", minimum: 0, maximum: 30, className: "setting-editor" })}<b>%</b></div></div>
      <div class="row"><span class="label">本年出口 / 关税</span><strong class="value">${number(ot.stats?.yearExportJin || 0)} / ${number(ot.stats?.yearTariffJin || 0, 1)}斤</strong></div>
      <div class="row"><span class="label">累计关税</span><strong class="value">${number(ot.stats?.tariffJin || 0, 1)}斤</strong></div>
    </div>
    <div class="cardlet"><h3>小麦贷款</h3>
      <div class="subtle">天灾欠收时可放贷解急。每年年结计息，民镇用结余小麦先息后本偿还。</div>
      ${loanRows}
      <div class="row"><span class="label">累计放贷 / 收息</span><strong class="value">${number(ot.loanStats?.totalIssuedJin || 0)} / ${number(ot.loanStats?.totalInterestJin || 0, 1)}斤</strong></div>
      <div class="row"><span class="label">放贷斤数</span><div class="setting-input">${renderNumericInput(view, { key: "wheat-loan-principal", kind: "wheat-loan-principal", target: "wheatLoan", value: "", label: "小麦贷款斤数", minimum: 0, maximum: 1000000, className: "setting-editor" })}<b>斤</b></div></div>
      <div class="row"><span class="label">年利率</span><div class="setting-input">${renderNumericInput(view, { key: "wheat-loan-rate", kind: "wheat-loan-rate", target: "wheatLoan", value: "", label: "小麦贷款年利率", minimum: 0, maximum: 50, className: "setting-editor" })}<b>%</b>
      <button class="secondary" data-wheat-loan-issue="1">发放贷款</button></div></div>
    </div>`;
}
