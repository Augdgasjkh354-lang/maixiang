import { escapeHtml, number } from "./format.js";
import { renderNumericInput } from "./numeric-drafts.js";

// 一样商品的库存状态：库存远低于/远高于目标天数时标出来，方便判断价格走向。
function stockBadge(good) {
  if (good.stockDays == null || !good.targetDays) return "";
  const ratio = good.stockDays / good.targetDays;
  if (ratio < 0.5) return ` <span class="badge red">紧缺</span>`;
  if (ratio > 1.5) return ` <span class="badge">充足</span>`;
  return "";
}

// 草稿键带上外镇 id，免得两个外镇的输入框互相串值。
function draftKey(townId, name, itemId) {
  return itemId === undefined ? `${name}:${townId}` : `${name}:${townId}:${itemId}`;
}

function goodCard(view, townId, good) {
  const unit = escapeHtml(good.unit);
  const name = escapeHtml(good.name);
  const id = escapeHtml(townId);
  const days = good.stockDays == null ? "—" : `${number(good.stockDays)}天`;
  const buyText = good.buyPrice == null ? "—" : number(good.buyPrice, 2);
  const canBuy = good.sellsToUs;
  return `<div class="cardlet">
      <div class="row"><span class="label">${name}</span>
        <strong class="value">库存${number(good.stock)}${unit} · ${days}（目标${number(good.targetDays)}天）${stockBadge(good)}</strong></div>
      <div class="row"><span class="label">日耗 / 日产</span>
        <strong class="value">${number(good.dailyNeed, 1)} / ${number(good.dailyProduce, 1)}${unit} · 供应${number(good.supply)}%</strong></div>
      <div class="row"><span class="label">收购 / 出售</span>
        <strong class="value">收购${number(good.sellPrice, 2)} · 出售${buyText} <span class="subtle">小麦斤/${unit}</span></strong></div>
      <div class="row"><span class="label">我镇库存</span>
        <strong class="value">${number(good.ourStock, 1)}${unit}${canBuy ? ` <span class="subtle">可外卖${number(good.sellable, 1)}${unit}</span>` : ""}</strong></div>
      <div class="row"><span class="label">数量</span><div class="setting-input">${renderNumericInput(view, { key: draftKey(townId, "outside-qty", good.itemId), kind: "outside-trade-qty", target: good.itemId, value: "", label: `${name}交易数量`, minimum: 0, maximum: 100000, className: "setting-editor" })}<b>${unit}</b>
        <button class="secondary" data-outside-sell="${escapeHtml(good.itemId)}" data-town="${id}">卖出</button>
        ${canBuy ? `<button class="secondary" data-outside-buy="${escapeHtml(good.itemId)}" data-town="${id}">买入</button>` : ""}</div></div>
    </div>`;
}

function relationsNote(relations) {
  if (relations >= 70) return "关系融洽（长协价×1.05、违约金减半）";
  if (relations < 20) return "关系破裂边缘（可能断交）";
  if (relations < 40) return "关系紧张（拒签新长协）";
  return "关系一般";
}

function agreementRow(agreement) {
  const statusText = agreement.status === "active" ? "履行中"
    : agreement.status === "expired" ? "已到期"
    : agreement.status === "terminated" ? "已解约" : agreement.status;
  const breachText = agreement.breachCount > 0 ? ` · 违约${agreement.breachCount}次` : "";
  // 长协自带 townId，解约只需要协定 id；data-town 仅作一致性标记。
  const terminateButton = agreement.status === "active"
    ? `<button class="secondary" data-agreement-terminate="${escapeHtml(agreement.id)}" data-town="${escapeHtml(agreement.townId || "")}">解约</button>` : "";
  return `<div class="row"><span class="label">${escapeHtml(agreement.itemName || agreement.itemId)}</span>
    <strong class="value">年${number(agreement.annualJin)}${escapeHtml(agreement.unit || "斤")} · 月${number(agreement.monthlyJin)} · 单价${number(agreement.pricePerUnit, 2)} · 余${agreement.yearsLeft}/${agreement.yearsTotal}年 · ${statusText}${breachText}</strong>${terminateButton}</div>`;
}

function populationText(ot) {
  const change = ot.lastYear?.populationChange || 0;
  const sign = change > 0 ? "+" : "";
  return `${number(ot.population)}人 <span class="subtle">（去年${sign}${number(change)}）</span>`;
}

// 顶部切换条：每个外镇一个按钮，显示名称与人口 · 繁荣度 · 关系分。
function townSwitch(view, selectedId) {
  const towns = view.outsideTowns || [];
  if (towns.length < 2) return "";
  return `<div class="build-tabs outside-town-switch" role="group" aria-label="选择外镇">${towns.map(town => {
    const active = town.id === selectedId;
    return `<button type="button" class="build-tab${active ? " selected" : ""}" data-outside-town="${escapeHtml(town.id)}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(town.name)}<br><small>人口${number(town.population)} · 繁荣${number(town.prosperity)} · 关系${number(town.relations)}</small></button>`;
  }).join("")}</div>`;
}

export function renderOutsideTown(view) {
  const ot = view.outsideTown;
  if (!ot) return `<div class="subtle">外贸数据不可用。</div>`;
  const townId = ot.id;
  const id = escapeHtml(townId);
  const ta = view.tradeAgreements || { agreements: [], activeCount: 0, capacity: 0, relations: ot.relations ?? 60, trusted: false, distrusted: false, staff: 0 };
  const goods = ot.goods || [];
  const eventText = ot.event ? `${escapeHtml(ot.event.type)}（${number(ot.event.year)}年）` : "无";
  const tradeClosedLine = ot.tradeClosed
    ? `<div class="row"><span class="label">商路</span><strong class="value">中断中（今年无法贸易）</strong></div>`
    : "";
  const staffLine = ot.foreignTradeOperational
    ? `<div class="row"><span class="label">外贸房</span><strong class="value">在岗 ${number(ot.foreignTradeStaff)}人 · 可同时跟 ${number(ot.foreignTradeCapacity)}笔长协</strong></div>`
    : `<div class="row"><span class="label">外贸房</span><strong class="value">无人值守（无法贸易与签约）</strong></div>`;
  const relations = ot.relations ?? 60;
  const signHint = !ot.foreignTradeOperational
    ? `<div class="subtle">外贸房无人值守，无法签约。</div>`
    : (ta.distrusted ? `<div class="subtle">${escapeHtml(ot.name)}不信任你（关系分<40），拒绝签约。</div>`
      : (ta.activeCount >= ta.capacity ? `<div class="subtle">长协容量已满（在岗${number(ta.staff)}人 × 2笔）。</div>` : ""));
  const activeLoans = (ot.loans || []).filter(l => l.status === "active");
  const loanRows = activeLoans.length > 0
    ? activeLoans.map(l => `<div class="row"><span class="label">${l.issueYear}年放贷</span><strong class="value">本金${number(l.principalJin)}斤 · 欠${number(l.outstandingJin)}斤 · 息${number(l.accruedInterestJin, 1)}斤 · 年利率${number(l.annualRatePercent, 1)}%</strong></div>`).join("")
    : `<div class="subtle">暂无未还贷款。</div>`;
  const agreementRows = (ta.agreements || []).length > 0
    ? ta.agreements.map(agreementRow).join("")
    : `<div class="subtle">暂无长期协定。外贸房有人值守即可签约。</div>`;
  const signDisabled = !ot.foreignTradeOperational ? "disabled" : "";
  const agreementItems = goods.map(good => `<option value="${escapeHtml(good.itemId)}">${escapeHtml(good.name)}（${escapeHtml(good.unit)}）</option>`).join("");

  return `${townSwitch(view, townId)}
    <h2>外贸 · ${escapeHtml(ot.name)}</h2>
    <div class="cardlet">
      <div class="row"><span class="label">执政</span><strong class="value">${ot.rulers.map(escapeHtml).join("、")}</strong></div>
      <div class="row"><span class="label">人口</span><strong class="value">${populationText(ot)}</strong></div>
      <div class="row"><span class="label">耕地</span><strong class="value">${number(ot.landMu)}亩 <span class="subtle">（+${number(ot.landGrowthMuPerYear)}亩/年）</span></strong></div>
      <div class="row"><span class="label">繁荣度</span><strong class="value">${number(ot.prosperity, 1)} / 100</strong></div>
      <div class="row"><span class="label">小麦库存</span><strong class="value">${number(ot.wheatStockJin)}斤 ${ot.wheatDays == null ? "" : `<span class="subtle">· 约${number(ot.wheatDays)}天口粮</span>`} · 口粮供应${number(ot.foodSupply)}%</strong></div>
      <div class="row"><span class="label">可用于贸易的余粮</span><strong class="value">${number(ot.payableWheatJin)}斤 <span class="subtle">（超出90天口粮储备的部分）</span></strong></div>
      <div class="row"><span class="label">去年收成</span><strong class="value">${number(ot.lastYear?.harvestJin)}斤</strong></div>
      <div class="row"><span class="label">今年大事</span><strong class="value">${eventText}</strong></div>
      ${tradeClosedLine}
      <div class="subtle">${escapeHtml(ot.description)}</div>
    </div>
    <div class="cardlet"><h3>商品行情</h3>
      <div class="subtle">价格随对方库存变化；大单越卖越便宜。</div>
    </div>
    ${goods.map(good => goodCard(view, townId, good)).join("")}
    <div class="cardlet"><h3>对外关系</h3>
      <div class="row"><span class="label">关系分</span><strong class="value">${number(relations, 1)} / 100 · ${relationsNote(relations)}</strong></div>
      <div class="row"><span class="label">价差</span><strong class="value">${number(ot.spreadPercent, 1)}%</strong></div>
      ${staffLine}
      <div class="subtle">关系分：外贸房在岗每日+0.1、无人值守每日−0.3；每成交约2万斤小麦+1（单笔最多+1）；违约扣分。关系越好，价差越窄。</div>
    </div>
    <div class="cardlet"><h3>长期贸易协定</h3>
      <div class="row"><span class="label">占用</span><strong class="value">${number(ta.activeCount || 0)} / ${number(ta.capacity || 0)} 笔</strong></div>
      ${signHint}
      ${agreementRows}
      <div class="row"><span class="label">品类</span><div class="setting-input">
        <select data-draft-key="${draftKey(townId, "trade-agreement-item")}" data-draft-kind="trade-agreement-item" data-draft-target="tradeAgreement" data-draft-label="长协品类" class="setting-editor">
          ${agreementItems}
        </select></div></div>
      <div class="row"><span class="label">年供货量</span><div class="setting-input">${renderNumericInput(view, { key: draftKey(townId, "trade-agreement-annual"), kind: "trade-agreement-annual", target: "tradeAgreement", value: "", label: "长协年供货量", minimum: 0, maximum: 5000000, className: "setting-editor", disabled: !ot.foreignTradeOperational })}<b>单位</b></div></div>
      <div class="row"><span class="label">年限</span><div class="setting-input">${renderNumericInput(view, { key: draftKey(townId, "trade-agreement-years"), kind: "trade-agreement-years", target: "tradeAgreement", value: "", label: "长协年限", minimum: 1, maximum: 5, integer: true, className: "setting-editor", disabled: !ot.foreignTradeOperational })}<b>年</b>
        <button class="secondary" data-agreement-sign="1" data-town="${id}" ${signDisabled}>签约</button></div></div>
      <div class="subtle">签约按当前收购价锁定单价（关系融洽时×1.05）；每月交付1/12，从批发市场扣货；货不足即我方违约，赔年货值10%并扣关系分（融洽时减半），连续3次对方解约。</div>
    </div>
    <div class="cardlet"><h3>小麦贷款</h3>
      <div class="subtle">天灾欠收时可放贷解急。每年年结计息，${escapeHtml(ot.name)}用结余小麦先息后本偿还。</div>
      ${loanRows}
      <div class="row"><span class="label">累计放贷 / 收息</span><strong class="value">${number(ot.loanStats?.totalIssuedJin || 0)} / ${number(ot.loanStats?.totalInterestJin || 0, 1)}斤</strong></div>
      <div class="row"><span class="label">放贷斤数</span><div class="setting-input">${renderNumericInput(view, { key: draftKey(townId, "wheat-loan-principal"), kind: "wheat-loan-principal", target: "wheatLoan", value: "", label: "小麦贷款斤数", minimum: 0, maximum: 1000000, className: "setting-editor" })}<b>斤</b></div></div>
      <div class="row"><span class="label">年利率</span><div class="setting-input">${renderNumericInput(view, { key: draftKey(townId, "wheat-loan-rate"), kind: "wheat-loan-rate", target: "wheatLoan", value: "", label: "小麦贷款年利率", minimum: 0, maximum: 50, className: "setting-editor" })}<b>%</b>
      <button class="secondary" data-wheat-loan-issue="1" data-town="${id}">发放贷款</button></div></div>
    </div>`;
}
