import { escapeHtml, number, moneyUnit, monthlyWageValue, payDayText } from "./format.js";

// 交易所与上市（docs/OWNERSHIP.md）的界面：
// - 交易所建筑面板：摘要卡 + 四个标签页（挂牌 / 民营申请 / 公司 / 状态）；
// - 公司所在建筑面板：公司状态、经营控件（工资、用工、售价、注资、清算）与账目；
// - 经营面板只留一行摘要，入口见 panel-enterprises.js。
// 数据全部来自 dashboard 视图（ipo / companies / stockExchange），这里不写 state。
// 按钮的 data-* 属性由 app.js 的点击委托处理；UI 状态（当前标签页、展开的建筑）由 app.js 传入视图。

export const EXCHANGE_TABS = [
  { id: "listing", name: "挂牌" },
  { id: "applications", name: "民营申请" },
  { id: "companies", name: "公司" },
  { id: "status", name: "状态" }
];

function draftValue(view, key, fallback) {
  return escapeHtml(view.numericDrafts?.[key]?.value ?? String(fallback ?? ""));
}

export function stagedInput(view, { key, label, value = 0, integer = false, minimum = 0, maximum = 100000000, positive = false }) {
  return `<input type="text" inputmode="${integer ? "numeric" : "decimal"}" enterkeyhint="done" autocomplete="off" spellcheck="false"
    value="${draftValue(view, key, value)}" aria-label="${escapeHtml(label)}" data-draft-key="${escapeHtml(key)}"
    data-draft-kind="stage" data-draft-label="${escapeHtml(label)}" data-draft-minimum="${minimum}"
    data-draft-maximum="${maximum}" data-draft-integer="${integer}" data-draft-positive="${positive}">`;
}

function inventoryText(rows) {
  if (!rows?.length) return "暂无";
  return rows.map(row => `${escapeHtml(row.name)} ${number(row.quantity, 2)}斤`).join(" · ");
}

function itemRowsText(rows, empty = "暂无") {
  if (!rows?.length) return empty;
  return rows.map(row => `${escapeHtml(row.name)} ${number(row.quantity, 2)}${escapeHtml(row.unit)}`).join(" · ");
}

// 镇营整栋上市的候选行：镇营产业且尚未成立公司（已挂牌的公司在「公司」里）。
export function townListingRows(view) {
  return (view.ipo?.buildings || []).filter(row => row.owner === "town" && !row.companyId);
}

// 交易所摘要：已上市公司数、待批申请数、可上市建筑数、总市值（现价 × 总股本，粮券）。
export function exchangeTotals(view) {
  const companies = view.companies || [];
  const listed = companies.filter(company => company.listing?.listed);
  return {
    companyCount: companies.length,
    listedCount: listed.length,
    applicationCount: (view.ipo?.applications || []).length,
    listableCount: townListingRows(view).filter(row => row.canList).length,
    marketCapVoucher: listed.reduce((sum, company) => sum + (company.sharePriceVoucher || 0) * (company.totalShares || 0), 0)
  };
}

export function exchangeBuildingOf(view) {
  return (view.buildings || []).find(row => row.typeId === "stock_exchange") || null;
}

// 公司对应的建筑：公司只绑定一栋（company.buildingId）；建筑上的 companyId 与之一致。
// 找不到（建筑已不在）时返回 null，界面显示“建筑缺失”。
export function companyForBuilding(view, building) {
  const companies = view.companies || [];
  if (building.companyId) return companies.find(row => row.id === building.companyId) || null;
  return companies.find(row => row.buildingId === building.id) || null;
}

function renderCooldownLine(view) {
  const ipo = view.ipo || {};
  const cooldowns = (ipo.cooldowns || []).filter(row => row.active);
  if (!cooldowns.length) return "";
  return `<div class="subtle">冷却中：${cooldowns.map(row => `${escapeHtml(row.householdName)}约${number(Math.max(0, row.untilSerial - (ipo.serial || 0)))}日后可再申请`).join("；")}。</div>`;
}

// 整栋上市表单：镇营产业整栋放入新公司挂牌（docs/OWNERSHIP.md 第 2 条）。数值走暂存草稿，按钮提交。
function renderTownListingForm(view, row) {
  const unit = moneyUnit(view);
  const id = escapeHtml(row.buildingId);
  const key = suffix => `ipo:${row.buildingId}:${suffix}`;
  return `<div class="exchange-form">
    <div class="business-form-grid">
      <label>股票代码（可空）<input type="text" inputmode="numeric" maxlength="3" autocomplete="off" value="" placeholder="自动" data-ipo-ticker="${id}"></label>
      <label>公司名称<input type="text" maxlength="30" autocomplete="off" value="${escapeHtml(`${row.name}公司`)}" data-ipo-name="${id}"></label>
      <label>总股本${stagedInput(view, { key: key("total"), label: "总股本", value: row.suggestedTotalShares, integer: true, minimum: 1 })}<small>股</small></label>
      <label>卖出比例${stagedInput(view, { key: key("offer"), label: "卖出比例", value: row.suggestedOfferPercent, minimum: 0, maximum: 100 })}<small>%</small></label>
      <label>每股价格${stagedInput(view, { key: key("price"), label: "每股价格", value: row.suggestedPriceVoucherPerShare ?? 1, positive: true })}<small>${escapeHtml(unit)}</small></label>
    </div>
    ${row.reason ? `<div class="shortage-banner visible">${escapeHtml(row.reason)}</div>` : `<div class="subtle">整栋放入新公司挂牌；镇库保留未卖出的股份，股款归镇库。卖出比例填 0 就是先不卖，之后到交易所「公司」里自己设出售股数，居民不会自动买走没挂出的股份。</div>`}
    <button class="primary wide" data-ipo-list="${id}" ${row.canList ? "" : "disabled"}>整栋上市</button>
  </div>`;
}

function renderTownListingRow(view, row, expanded) {
  const unit = moneyUnit(view);
  const id = escapeHtml(row.buildingId);
  const gate = view.ipo?.gateReason || null;
  const reason = row.reason && row.reason !== gate ? row.reason : null;
  return `<div class="cardlet exchange-row${expanded ? " is-open" : ""}">
    <div class="row"><strong>${escapeHtml(row.name)} · ${id}</strong><span class="badge">镇营${number(row.level)}级</span></div>
    <div class="row"><span class="label">估值 / 建议发行价</span><strong class="value">${row.valuationVoucher == null ? "—" : number(row.valuationVoucher, 2)} / ${row.suggestedPriceVoucherPerShare == null ? "—" : number(row.suggestedPriceVoucherPerShare, 2)}${escapeHtml(unit)}</strong></div>
    ${!expanded && reason ? `<div class="subtle">${escapeHtml(reason)}</div>` : ""}
    <div class="settings-actions"><button class="${expanded ? "secondary" : "primary"}" data-ipo-expand="${id}" aria-expanded="${expanded ? "true" : "false"}">${expanded ? "收起" : "上市"}</button></div>
    ${expanded ? renderTownListingForm(view, row) : ""}
  </div>`;
}

// 民营业主的上市申请：镇长可改卖出比例与每股价后批准，或驳回（驳回后业主有冷却期）。
function renderIpoApplication(view, row) {
  const unit = moneyUnit(view);
  const id = escapeHtml(row.buildingId);
  const key = suffix => `ipo-app:${row.buildingId}:${suffix}`;
  return `<div class="cardlet"><div class="row"><strong>${escapeHtml(row.buildingName)} · ${escapeHtml(row.householdName)}</strong><span class="badge">已等待${number(row.daysPending)}日</span></div>
    <div class="row"><span class="label">整栋估值</span><strong class="value">${number(row.valuationVoucher, 2)}${escapeHtml(unit)}</strong></div>
    <div class="business-form-grid">
      <label>股票代码（可空）<input type="text" inputmode="numeric" maxlength="3" autocomplete="off" value="" placeholder="自动" data-ipo-app-ticker="${id}"></label>
      <label>总股本${stagedInput(view, { key: key("total"), label: "总股本", value: row.suggestedTotalShares, integer: true, minimum: 1 })}<small>股</small></label>
      <label>卖出比例${stagedInput(view, { key: key("offer"), label: "卖出比例", value: row.suggestedOfferPercent, positive: true, maximum: 100 })}<small>%</small></label>
      <label>每股价格${stagedInput(view, { key: key("price"), label: "每股价格", value: row.suggestedPriceVoucherPerShare ?? 1, positive: true })}<small>${escapeHtml(unit)}</small></label>
    </div>
    ${row.blockedReason ? `<div class="shortage-banner visible">${escapeHtml(row.blockedReason)}</div>` : ""}
    <div class="business-sticky-actions"><button class="secondary" data-ipo-reject="${id}">驳回</button><button class="primary" data-ipo-approve="${id}" ${row.valid && !row.blockedReason ? "" : "disabled"}>批准上市</button></div>
  </div>`;
}

// 公司经营控件（工资、用工、售价、注资、清算）：放在公司所在建筑的面板里。
export function renderCompanyOperations(view, company) {
  const unit = moneyUnit(view);
  const wageKey = `company:${company.id}:wage`;
  const targetKey = `company:${company.id}:target`;
  const capitalKey = `company:${company.id}:capital`;
  const products = company.productRows || [];
  return `<h4>独立经营</h4>
    <div class="business-form-grid">
      <label>日薪${stagedInput(view, { key: wageKey, label: "公司日薪", value: company.settings?.wagePerWorkerDay ?? 5, minimum: 0 })}<small>${escapeHtml(unit)}/人日 · 月薪${monthlyWageValue(view, company.settings?.wagePerWorkerDay ?? 5, 1)}${escapeHtml(unit)}</small></label>
      <label>目标用工${stagedInput(view, { key: targetKey, label: "公司目标用工", value: company.plannedWorkers, integer: true, minimum: 0, maximum: company.capacity })}<small>人</small></label>
    </div>
    <div class="business-sticky-actions"><button class="secondary" data-company-wage="${escapeHtml(company.id)}">设置工资</button><button class="secondary" data-company-target="${escapeHtml(company.id)}">设置用工</button></div>
    <div class="row"><span class="label">${escapeHtml(payDayText(company.wages?.payDay) || "发薪日")} · 待发 / 欠薪</span><strong class="value">${number(company.wages?.pendingWagesVoucher || 0, 2)} / ${number(company.wages?.wageArrearsVoucher || 0, 2)}${escapeHtml(unit)}</strong></div>
    ${products.map(row => `<div class="business-form-row"><label>${escapeHtml(row.name)}售价${stagedInput(view, { key: `company:${company.id}:price:${row.itemId}`, label: `${row.name}售价`, value: row.salePrice, positive: true })}<small>${escapeHtml(unit)}/斤</small></label><button class="secondary" data-company-price="${escapeHtml(company.id)}" data-item-id="${escapeHtml(row.itemId)}">设置</button></div>`).join("")}
    <div class="business-form-row"><label>追加注资${stagedInput(view, { key: capitalKey, label: "追加经营资金（小麦等值）", value: 1000, positive: true })}</label><button class="secondary" data-company-capital="${escapeHtml(company.id)}">注资</button></div>
    <div class="business-sticky-actions"><button class="secondary danger" data-company-liquidate="${escapeHtml(company.id)}">全部划回并清算</button></div>`;
}

// 公司的状态摘要行（建筑面板里显示）。
export function renderCompanyStatus(view, company) {
  const unit = moneyUnit(view);
  const statusNeedsAttention = !["运营中", "生产中", "原料有限", "按订单生产"].includes(company.status || "");
  return `<div class="row"><span class="label">上市 / 经营状态</span><span><span class="badge">${company.listing?.listed ? `${escapeHtml(company.listing.ticker || "---")} · 已上市` : "未上市"}</span> <span class="badge${statusNeedsAttention ? " red" : ""}">${escapeHtml(company.status || "运营中")}</span></span></div>
    <div class="row"><span class="label">公司等级 / 在岗 / 目标</span><strong class="value">${number(company.listedLevels)}级 · ${number(company.workers)} / ${number(company.plannedWorkers)}人</strong></div>
    <div class="row"><span class="label">可支付资金 / 欠薪</span><strong class="value">${number(company.cashVoucher, 2)}粮券 / ${number(company.arrearsVoucher, 2)}${escapeHtml(unit)}</strong></div>
    <div class="row"><span class="label">近期日均销量 / 实际利润</span><strong class="value">${company.averageDailySales > 0 ? number(company.averageDailySales, 2) : "暂无销量"} / ${number(company.averageDailyProfitVoucher, 2)}${escapeHtml(unit)}</strong></div>
    <div class="row"><span class="label">库存</span><strong class="value">${inventoryText(company.inventoryRows)}</strong></div>`;
}

// 公司账目与年度结算（可折叠）。
export function renderCompanyAccounts(view, company) {
  const unit = moneyUnit(view);
  const annual = company.lastAnnualSettlement || {};
  const scale = view.currencyUnitsPerVoucher;
  return `<details class="detail-block" data-detail-key="company-detail:${escapeHtml(company.id)}"><summary>账目与年度结算</summary><div class="detail-body">
      <div class="row"><span class="label">今日产出 / 售出</span><strong class="value">${itemRowsText(company.producedRowsDay)} / ${itemRowsText(company.soldRowsDay)}</strong></div>
      <div class="row"><span class="label">今日收入 / 净利润</span><strong class="value">${number(company.revenueDayVoucher, 2)} / ${number(company.profitDayVoucher, 2)}${escapeHtml(unit)}</strong></div>
      <div class="row"><span class="label">今日成本</span><strong class="value">已售${number(company.cogsDayVoucher, 2)} · 工资${number(company.wagesDayVoucher, 2)} · 税${number(company.taxCostDayVoucher, 2)} · 损耗${number(company.processingLossDayVoucher, 2)}${escapeHtml(unit)}</strong></div>
      <div class="row"><span class="label">360日周转金目标</span><strong class="value">${number(company.workingCapitalReserveVoucher, 2)}${escapeHtml(unit)}</strong></div>
      <div class="row"><span class="label">上年净利润 / 实际分配</span><strong class="value">${number((annual.lastYearNetProfitVoucherUnits || 0) / scale, 2)} / ${number((annual.distributedVoucherUnits || 0) / scale, 2)}${escapeHtml(unit)}</strong></div>
      <div class="row"><span class="label">未分配利润</span><strong class="value">${number(company.retainedEarningsVoucher, 2)}${escapeHtml(unit)}</strong></div>
    </div></details>`;
}

// 公司所在建筑面板的“公司”分组。没有公司却标了公司（或有上市等级）时给出提示，不报错。
export function renderCompanySection(view, building, { wageRow = "" } = {}) {
  const company = companyForBuilding(view, building);
  if (!company) {
    return building.companyId || building.ownership?.listedLevels > 0
      ? `<h3>公司</h3><div class="shortage-banner visible">这栋建筑的公司数据暂缺，请到交易所面板核对。</div>`
      : "";
  }
  const listed = Boolean(company.listing?.listed);
  return `<h3>公司 · ${number(company.listedLevels)}级 · ${listed ? `${escapeHtml(company.listing.ticker || "---")} · 已上市` : "未上市"}</h3>
    ${renderCompanyStatus(view, company)}
    ${wageRow}
    ${renderCompanyOperations(view, company)}
    ${renderCompanyAccounts(view, company)}
    <div class="subtle">公司由业主自主经营；上市、售股与回购在交易所面板管理。</div>`;
}

// 交易所面板的单家公司：上市 / 售股 / 回购的表单与预览（沿用原 data-* 属性，app.js 处理）。
function renderListing(view, company) {
  const scale = view.currencyUnitsPerVoucher;
  const gate = !view.stockExchange?.available ? "尚未建成交易所" : null;
  if (!company.listing?.listed) {
    const preview = view.stockListingPreview?.companyId === company.id ? view.stockListingPreview : null;
    const sharesKey = `stock-list:${company.id}:total`;
    const offeredKey = `stock-list:${company.id}:offered`;
    const priceKey = `stock-list:${company.id}:price`;
    return `<h4>交易所上市</h4>
      ${gate ? `<div class="subtle">${escapeHtml(gate)}。公司仍可继续独立经营。</div>` : `<div class="business-form-grid">
        <label>三位代码<input type="text" inputmode="numeric" maxlength="3" autocomplete="off" value="${escapeHtml(preview?.ticker || "001")}" data-stock-ticker="${escapeHtml(company.id)}"></label>
        <label>总股本${stagedInput(view, { key: sharesKey, label: "总股本", value: 2520, integer: true, minimum: 1 })}</label>
        <label>每股价格${stagedInput(view, { key: priceKey, label: "每股价格", value: 1, positive: true })}<small>粮券</small></label>
        <label>本次出售${stagedInput(view, { key: offeredKey, label: "本次出售股数", value: 0, integer: true, minimum: 0 })}</label>
      </div>
      <button class="secondary wide" data-stock-list-preview="${escapeHtml(company.id)}">预览上市</button>
      ${preview ? `<div class="operation-preview"><strong>${escapeHtml(preview.ticker)} · 上市确认</strong>
        <div class="row"><span class="label">公司等级 / 总股本</span><strong class="value">${number(company.listedLevels)}级 / ${number(preview.totalShares)}股</strong></div>
        <div class="row"><span class="label">总估值 / 计划出售收入</span><strong class="value">${number(preview.totalValue, 2)} / ${number(preview.plannedProceeds, 2)}粮券</strong></div>
        <div class="row"><span class="label">计划出售后镇库持股</span><strong class="value">${number(preview.townPercentAfter, 2)}%</strong></div>
        ${preview.reason ? `<div class="shortage-banner visible">${escapeHtml(preview.reason)}</div>` : ""}
        <div class="business-sticky-actions"><button class="secondary" data-stock-list-cancel>取消</button><button class="primary" data-stock-list-confirm="${escapeHtml(company.id)}" ${preview.reason ? "disabled" : ""}>确认挂牌</button></div>
      </div>` : ""}`}
    `;
  }

  const sub = company.subscription || {};
  const previewOpen = view.sharePreviewCompanyId === company.id;
  const listedShares = company.shareSale?.offeredShares || 0;
  const sharePrice = company.sharePriceVoucher || 0;
  const askPrice = company.askPriceVoucher || sharePrice;
  const subscribed = sub.subscribedShares || 0;
  const proceeds = (sub.proceedsVoucherUnits || 0) / scale;
  const afterTownShares = company.townShares - subscribed;
  const afterTownPercent = company.totalShares ? afterTownShares / company.totalShares * 100 : 0;
  const ref = company.stockReference || {};
  return `<h4>交易所 · ${escapeHtml(company.listing.ticker || "---")}</h4>
    <div class="row"><span class="label">总股本 / 镇库 / 居民</span><strong class="value">${number(company.totalShares)} / ${number(company.townShares)} / ${number(company.residentShares)}股</strong></div>
    <div class="row"><span class="label">实际累计售股收入</span><strong class="value">${number(company.shareSaleProceedsVoucher, 2)}粮券 · 归镇库</strong></div>
    <div class="business-form-grid two">
      <label>出售股数${stagedInput(view, { key: `share:${company.id}:count`, label: "出售股数", value: listedShares, integer: true, minimum: 0, maximum: company.townShares })}</label>
      <label>每股价格${stagedInput(view, { key: `share:${company.id}:price`, label: "每股售价", value: askPrice || 1, positive: true })}<small>粮券</small></label>
    </div>
    <div class="row"><span class="label">按现价的年利润率</span><strong class="value">${number(company.priceYieldPercent || 0, 2)}%${(company.priceYieldPercent || 0) > 0 && company.priceYieldPercent < 3 ? " · 偏贵" : ""}</strong></div>
    <div class="subtle">年利润÷现价；4%左右算合理，跌到3%、2%、1%越低泡沫越大。</div>
    <div class="row"><span class="label">现价 / 你定的售价</span><strong class="value">${number(sharePrice, 2)} / ${number(askPrice, 2)}粮券</strong></div>
    <div class="subtle">只有你挂出的股数才会被居民买走，且现价不低于你定的售价才成交（按现价）。${listedShares > 0 && sharePrice < askPrice ? "现价低于售价，暂不成交。" : ""}</div>
    <button class="secondary wide" data-share-preview="${escapeHtml(company.id)}">预览居民认购</button>
    ${previewOpen ? `<div class="operation-preview"><strong>本次售股</strong>
      <div class="row"><span class="label">计划收入 / 预计实际收入</span><strong class="value">${number(listedShares * sharePrice, 2)} / ${number(proceeds, 2)}粮券</strong></div>
      <div class="row"><span class="label">预计成交 / 成交后镇库持股</span><strong class="value">${number(subscribed)}股 / ${number(afterTownPercent, 2)}%</strong></div>
      ${sub.reason ? `<div class="shortage-banner visible">${escapeHtml(sub.reason)}</div>` : ""}
      <div class="business-sticky-actions"><button class="secondary" data-share-cancel>取消</button><button class="primary" data-share-confirm="${escapeHtml(company.id)}" ${!sub.available ? "disabled" : ""}>确认售股</button></div>
    </div>` : ""}
    <div class="business-form-grid two"><label>回购股数${stagedInput(view, { key: `buyback:${company.id}:count`, label: "镇库回购股数", value: 100, integer: true, minimum: 1 })}</label><label>回购价${stagedInput(view, { key: `buyback:${company.id}:price`, label: "镇库回购每股价格", value: Math.max(0.01, Math.round((ref.referencePerShareVoucherUnits || 0) / scale * 100) / 100), positive: true })}<small>粮券</small></label></div>
    <button class="secondary wide" data-company-buyback-preview="${escapeHtml(company.id)}">预览镇库回购</button>
    ${view.buybackPreview?.companyId === company.id ? `<div class="operation-preview"><strong>回购预览</strong>
      <div class="row"><span class="label">申请 / 居民愿售</span><strong class="value">${number(view.buybackPreview.preview?.requestedShares || 0)} / ${number(view.buybackPreview.preview?.willingShares || 0)}股</strong></div>
      <div class="row"><span class="label">镇库可负担 / 预计成交</span><strong class="value">${number(view.buybackPreview.preview?.affordableShares || 0)} / ${number(view.buybackPreview.preview?.executableShares || 0)}股</strong></div>
      <div class="row"><span class="label">预计总成本</span><strong class="value">${number((view.buybackPreview.preview?.costVoucherUnits || 0) / scale, 2)}粮券</strong></div>
      ${view.buybackPreview.preview?.reason ? `<div class="shortage-banner visible">${escapeHtml(view.buybackPreview.preview.reason)}</div>` : ""}
      <div class="business-sticky-actions"><button class="secondary" data-company-buyback-cancel>取消</button><button class="primary" data-company-buyback-confirm="${escapeHtml(company.id)}" ${!view.buybackPreview.preview?.available ? "disabled" : ""}>确认回购</button></div>
    </div>` : ""}
    <details class="detail-block" data-detail-key="stock-ref:${escapeHtml(company.id)}"><summary>估值与业绩</summary><div class="detail-body">
      <div class="row"><span class="label">近一年利润（折年）</span><strong class="value">${ref.validProfitMethod ? `${number((ref.annualizedProfitVoucherUnits || 0) / scale, 2)}粮券` : (ref.observedDays ? "观察中/暂无正值" : "暂无业绩")}</strong></div>
      <div class="row"><span class="label">合理价（利润 ÷ 4%）</span><strong class="value">${ref.validProfitMethod ? `${number((ref.referencePerShareVoucherUnits || 0) / scale, 2)}粮券/股` : "暂无"}</strong></div>
      <div class="row"><span class="label">现价</span><strong class="value">${number(sharePrice, 2)}粮券/股</strong></div>
      <div class="row"><span class="label">观察</span><strong class="value">${number(ref.observedDays || 0)}日</strong></div>
      <div class="subtle">${escapeHtml(ref.basis || "经营资料待观察")}</div>
    </div></details>`;
}

function renderExchangeSummary(view) {
  const totals = exchangeTotals(view);
  const unit = moneyUnit(view);
  return `<div class="cardlet exchange-summary">
    <div class="row"><span class="label">已上市公司</span><strong class="value">${number(totals.listedCount)} / ${number(totals.companyCount)}家</strong></div>
    <div class="row"><span class="label">待批上市申请</span><strong class="value">${number(totals.applicationCount)}份</strong></div>
    <div class="row"><span class="label">可上市建筑</span><strong class="value">${number(totals.listableCount)}栋</strong></div>
    <div class="row"><span class="label">总市值</span><strong class="value">${number(totals.marketCapVoucher, 2)}${escapeHtml(unit)}</strong></div>
  </div>`;
}

function renderListingTab(view) {
  const rows = townListingRows(view);
  const expanded = view.ipoExpandedBuildingId || null;
  const gate = view.ipo?.gateReason ? `<div class="subtle">${escapeHtml(view.ipo.gateReason)}；建成交易所后可上市。</div>` : "";
  const list = rows.length
    ? rows.map(row => renderTownListingRow(view, row, row.buildingId === expanded)).join("")
    : `<div class="cardlet subtle">暂无镇营产业可整栋上市。</div>`;
  return `${gate}<div class="subtle">镇营产业整栋放入新公司挂牌。点「上市」展开该栋的表单，一次只展开一栋。</div>${list}${renderCooldownLine(view)}`;
}

function renderApplicationsTab(view) {
  const applications = view.ipo?.applications || [];
  const body = applications.length
    ? applications.map(row => renderIpoApplication(view, row)).join("")
    : `<div class="cardlet subtle">暂无待批的民营上市申请。</div>`;
  return `<div class="subtle">民营业主递交申请后在这里批准或驳回；驳回后业主有冷却期。</div>${body}${renderCooldownLine(view)}`;
}

function renderCompaniesTab(view) {
  const companies = view.companies || [];
  if (!companies.length) return `<div class="cardlet subtle">暂无独立公司。公司由镇营产业整栋上市产生，请在「挂牌」里操作。</div>`;
  return companies.map(company => {
    const id = escapeHtml(company.id);
    const listed = Boolean(company.listing?.listed);
    const building = (view.buildings || []).find(row => row.id === company.buildingId) || null;
    return `<details class="detail-block exchange-company" data-detail-key="exchange-company:${id}"><summary>${escapeHtml(company.name)} · ${listed ? `${escapeHtml(company.listing.ticker || "---")} · 已上市 · 现价${number(company.sharePriceVoucher || 0, 2)}粮券` : "未上市"}</summary><div class="detail-body">
      <div class="row"><span class="label">所在建筑</span><strong class="value">${building ? `${escapeHtml(building.name)} · ${number(company.listedLevels)}级` : "建筑缺失"}</strong></div>
      ${building ? `<div class="settings-actions"><button class="secondary" data-open-building="${escapeHtml(building.id)}">查看所在建筑</button></div>` : ""}
      ${renderListing(view, company)}
    </div></details>`;
  }).join("");
}

function renderStatusTab(view) {
  const exchange = view.stockExchange || {};
  const exchangeState = exchange.available
    ? (exchange.physical ? "交易所已建成" : "旧档兼容交易所入口")
    : "尚未建成交易所";
  return `<div class="cardlet">
    <div class="row"><span class="label">状态</span><strong class="value">${escapeHtml(exchangeState)}</strong></div>
    ${view.ipo?.gateReason ? `<div class="subtle">当前上市门槛：${escapeHtml(view.ipo.gateReason)}</div>` : ""}
    <div class="subtle">镇营整栋上市在「挂牌」，民营申请在「民营申请」，上市、售股与回购在「公司」。</div>
  </div>`;
}

// 交易所的主体：摘要卡 + 标签页。交易所建筑面板与旧档兼容入口共用。
export function renderExchangeBody(view) {
  const tab = EXCHANGE_TABS.some(row => row.id === view.exchangeTab) ? view.exchangeTab : "listing";
  const applicationCount = (view.ipo?.applications || []).length;
  const tabs = `<div class="settings-actions exchange-tabs" role="tablist">${EXCHANGE_TABS.map(row => {
    const active = row.id === tab;
    const label = row.id === "applications" && applicationCount > 0 ? `${row.name}（${number(applicationCount)}）` : row.name;
    return `<button class="${active ? "primary" : "secondary"}" role="tab" aria-selected="${active ? "true" : "false"}" data-exchange-tab="${row.id}">${escapeHtml(label)}</button>`;
  }).join("")}</div>`;
  const content = {
    listing: renderListingTab,
    applications: renderApplicationsTab,
    companies: renderCompaniesTab,
    status: renderStatusTab
  }[tab](view);
  return `${renderExchangeSummary(view)}${tabs}${content}`;
}

// 经营面板里的整栋上市 / 民营申请 / 交易所入口：一行摘要 + 前往交易所。
export function renderExchangeEntry(view) {
  const totals = exchangeTotals(view);
  const exchange = exchangeBuildingOf(view);
  const legacy = !exchange && Boolean(view.stockExchange?.legacyAccess);
  const button = exchange
    ? `<button class="secondary" data-open-building="${escapeHtml(exchange.id)}">前往交易所</button>`
    : legacy
      ? `<button class="secondary" data-site="exchange-compat">前往交易所</button>`
      : `<button class="secondary" data-go="build">去建设交易所</button>`;
  const gate = view.ipo?.gateReason ? `<div class="subtle">${escapeHtml(view.ipo.gateReason)}；建成交易所后可上市。</div>` : "";
  return `<div class="cardlet">
    <div class="row"><span class="label">可上市 ${number(totals.listableCount)} 栋 · 挂牌 ${number(totals.listedCount)} 家 · 待批 ${number(totals.applicationCount)} 份</span></div>
    <div class="settings-actions">${button}</div>
    ${gate}
  </div>`;
}
