import { escapeHtml, number, moneyUnit } from "./format.js";

function draftValue(view, key, fallback) {
  return escapeHtml(view.numericDrafts?.[key]?.value ?? String(fallback ?? ""));
}

function stagedInput(view, { key, label, value = 0, integer = false, minimum = 0, maximum = 100000000, positive = false }) {
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

function renderPrices(view) {
  const unit = moneyUnit(view);
  const prices = view.market.intermediatePricesVoucherPerUnit || {};
  return `<section class="enterprise-section"><h2>价格</h2><div class="cardlet">
    <div class="row"><span class="label">小麦 / 食盐</span><strong class="value">${number(view.market.pricesVoucherPerUnit?.wheat ?? 1, 3)} / ${number(view.market.pricesVoucherPerUnit?.salt ?? 10, 3)}${escapeHtml(unit)}/斤</strong></div>
    <div class="row"><span class="label">面粉</span><div class="business-inline-input">${stagedInput(view, { key: "intermediate:flour", label: "面粉价格", value: prices.flour ?? 1.8, positive: true })}<b>${escapeHtml(unit)}/斤</b><button class="secondary" data-intermediate-price="flour">设置</button></div></div>
    <div class="row"><span class="label">面包</span><div class="business-inline-input">${stagedInput(view, { key: "intermediate:bread", label: "面包价格", value: view.market.pricesVoucherPerUnit?.bread ?? 2, positive: true })}<b>${escapeHtml(unit)}/斤</b><button class="secondary" data-intermediate-price="bread">设置</button></div></div>
    <div class="row"><span class="label">木材</span><div class="business-inline-input">${stagedInput(view, { key: "intermediate:wood", label: "木材价格", value: prices.wood ?? 15, positive: true })}<b>${escapeHtml(unit)}/单位</b><button class="secondary" data-intermediate-price="wood">设置</button></div></div>
    <div class="subtle">均为批发价，商店零售另加价。</div>
  </div></section>`;
}

// 整栋上市表单：镇营产业整栋放入新公司挂牌（docs/OWNERSHIP.md 第 2 条）。数值走暂存草稿，按钮提交。
function renderTownListingForm(view, row) {
  const unit = moneyUnit(view);
  const id = escapeHtml(row.buildingId);
  const key = suffix => `ipo:${row.buildingId}:${suffix}`;
  return `<div class="cardlet"><div class="row"><strong>${escapeHtml(row.name)} · ${id}</strong><span class="badge">镇营${number(row.level)}级</span></div>
    <div class="business-form-grid">
      <label>股票代码（可空）<input type="text" inputmode="numeric" maxlength="3" autocomplete="off" value="" placeholder="自动" data-ipo-ticker="${id}"></label>
      <label>公司名称<input type="text" maxlength="30" autocomplete="off" value="${escapeHtml(`${row.name}公司`)}" data-ipo-name="${id}"></label>
      <label>总股本${stagedInput(view, { key: key("total"), label: "总股本", value: row.suggestedTotalShares, integer: true, minimum: 1 })}<small>股</small></label>
      <label>卖出比例${stagedInput(view, { key: key("offer"), label: "卖出比例", value: row.suggestedOfferPercent, positive: true, maximum: 100 })}<small>%</small></label>
      <label>每股价格${stagedInput(view, { key: key("price"), label: "每股价格", value: row.suggestedPriceVoucherPerShare ?? 1, positive: true })}<small>${escapeHtml(unit)}</small></label>
    </div>
    ${row.reason ? `<div class="shortage-banner visible">${escapeHtml(row.reason)}</div>` : `<div class="subtle">整栋放入新公司挂牌；镇库保留未卖出的股份，股款归镇库。</div>`}
    <button class="primary wide" data-ipo-list="${id}" ${row.canList ? "" : "disabled"}>整栋上市</button>
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

function renderOperationControls(view, company) {
  const unit = moneyUnit(view);
  const wageKey = `company:${company.id}:wage`;
  const targetKey = `company:${company.id}:target`;
  const capitalKey = `company:${company.id}:capital`;
  const products = company.productRows || [];
  return `<h4>独立经营</h4>
    <div class="business-form-grid">
      <label>日薪${stagedInput(view, { key: wageKey, label: "公司日薪", value: company.settings?.wagePerWorkerDay ?? 5, minimum: 0 })}<small>${escapeHtml(unit)}/人日</small></label>
      <label>目标用工${stagedInput(view, { key: targetKey, label: "公司目标用工", value: company.plannedWorkers, integer: true, minimum: 0, maximum: company.capacity })}<small>人</small></label>
    </div>
    <div class="business-sticky-actions"><button class="secondary" data-company-wage="${escapeHtml(company.id)}">设置工资</button><button class="secondary" data-company-target="${escapeHtml(company.id)}">设置用工</button></div>
    ${products.map(row => `<div class="business-form-row"><label>${escapeHtml(row.name)}售价${stagedInput(view, { key: `company:${company.id}:price:${row.itemId}`, label: `${row.name}售价`, value: row.salePrice, positive: true })}<small>${escapeHtml(unit)}/斤</small></label><button class="secondary" data-company-price="${escapeHtml(company.id)}" data-item-id="${escapeHtml(row.itemId)}">设置</button></div>`).join("")}
    <div class="business-form-row"><label>追加注资${stagedInput(view, { key: capitalKey, label: "追加经营资金（小麦等值）", value: 1000, positive: true })}</label><button class="secondary" data-company-capital="${escapeHtml(company.id)}">注资</button></div>
    <div class="business-sticky-actions"><button class="secondary danger" data-company-liquidate="${escapeHtml(company.id)}">全部划回并清算</button></div>`;
}

function renderListing(view, company) {
  const scale = view.currencyUnitsPerVoucher;
  const gate = !view.stockExchange?.available ? "尚未建成交易所" : !view.stockExchange?.reformComplete ? "须先完成货币改革" : null;
  if (!company.listing?.listed) {
    const preview = view.stockListingPreview?.companyId === company.id ? view.stockListingPreview : null;
    const sharesKey = `stock-list:${company.id}:total`;
    const offeredKey = `stock-list:${company.id}:offered`;
    const priceKey = `stock-list:${company.id}:price`;
    return `<h4>交易所上市</h4>
      ${gate ? `<div class="subtle">${escapeHtml(gate)}。公司仍可继续独立经营。</div>` : `<div class="business-form-grid">
        <label>三位代码<input type="text" inputmode="numeric" maxlength="3" autocomplete="off" value="${escapeHtml(preview?.ticker || "001")}" data-stock-ticker="${escapeHtml(company.id)}"></label>
        <label>总股本${stagedInput(view, { key: sharesKey, label: "总股本", value: Math.max(1000, company.listedLevels * 1000), integer: true, minimum: 1 })}</label>
        <label>每股价格${stagedInput(view, { key: priceKey, label: "每股价格", value: 1, positive: true })}<small>粮券</small></label>
        <label>本次出售${stagedInput(view, { key: offeredKey, label: "本次出售股数", value: Math.max(1, company.listedLevels * 100), integer: true, minimum: 0 })}</label>
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
      <label>每股价格${stagedInput(view, { key: `share:${company.id}:price`, label: "每股售价", value: sharePrice || 1, positive: true })}<small>粮券</small></label>
    </div>
    <button class="secondary wide" data-share-preview="${escapeHtml(company.id)}">预览居民认购</button>
    ${previewOpen ? `<div class="operation-preview"><strong>本次售股</strong>
      <div class="row"><span class="label">计划收入 / 预计实际收入</span><strong class="value">${number(listedShares * sharePrice, 2)} / ${number(proceeds, 2)}粮券</strong></div>
      <div class="row"><span class="label">预计成交 / 成交后镇库持股</span><strong class="value">${number(subscribed)}股 / ${number(afterTownPercent, 2)}%</strong></div>
      ${sub.reason ? `<div class="shortage-banner visible">${escapeHtml(sub.reason)}</div>` : ""}
      <div class="business-sticky-actions"><button class="secondary" data-share-cancel>取消</button><button class="primary" data-share-confirm="${escapeHtml(company.id)}" ${!sub.available ? "disabled" : ""}>确认售股</button></div>
    </div>` : ""}
    <div class="business-form-grid two"><label>回购股数${stagedInput(view, { key: `buyback:${company.id}:count`, label: "镇库回购股数", value: 100, integer: true, minimum: 1 })}</label><label>回购价${stagedInput(view, { key: `buyback:${company.id}:price`, label: "镇库回购每股价格", value: Math.max(1, (ref.referencePerShareVoucherUnits || 0) / scale), positive: true })}<small>粮券</small></label></div>
    <button class="secondary wide" data-company-buyback-preview="${escapeHtml(company.id)}">预览镇库回购</button>
    ${view.buybackPreview?.companyId === company.id ? `<div class="operation-preview"><strong>回购预览</strong>
      <div class="row"><span class="label">申请 / 居民愿售</span><strong class="value">${number(view.buybackPreview.preview?.requestedShares || 0)} / ${number(view.buybackPreview.preview?.willingShares || 0)}股</strong></div>
      <div class="row"><span class="label">镇库可负担 / 预计成交</span><strong class="value">${number(view.buybackPreview.preview?.affordableShares || 0)} / ${number(view.buybackPreview.preview?.executableShares || 0)}股</strong></div>
      <div class="row"><span class="label">预计总成本</span><strong class="value">${number((view.buybackPreview.preview?.costVoucherUnits || 0) / scale, 2)}粮券</strong></div>
      ${view.buybackPreview.preview?.reason ? `<div class="shortage-banner visible">${escapeHtml(view.buybackPreview.preview.reason)}</div>` : ""}
      <div class="business-sticky-actions"><button class="secondary" data-company-buyback-cancel>取消</button><button class="primary" data-company-buyback-confirm="${escapeHtml(company.id)}" ${!view.buybackPreview.preview?.available ? "disabled" : ""}>确认回购</button></div>
    </div>` : ""}
    <details class="detail-block" data-detail-key="stock-ref:${escapeHtml(company.id)}"><summary>估值与业绩</summary><div class="detail-body">
      <div class="row"><span class="label">业绩估值</span><strong class="value">${ref.validProfitMethod ? `${number((ref.referenceCompanyValueVoucherUnits || 0) / scale, 2)}粮券` : (ref.observedDays ? "观察中/暂无正值" : "暂无业绩")}</strong></div>
      <div class="row"><span class="label">观察 / 年化利润率</span><strong class="value">${number(ref.observedDays || 0)}日 / ${number((ref.annualizedProfitRateBps || 0) / 100, 2)}%</strong></div>
      <div class="subtle">${escapeHtml(ref.basis || "经营资料待观察")}</div>
    </div></details>`;
}

function renderCompany(view, company) {
  const unit = moneyUnit(view);
  const annual = company.lastAnnualSettlement || {};
  const scale = view.currencyUnitsPerVoucher;
  const statusNeedsAttention = !["运营中", "生产中", "原料有限", "按订单生产"].includes(company.status || "");
  return `<div class="company-card cardlet">
    <div class="row"><strong>${escapeHtml(company.name)}</strong><span><span class="badge">${company.listing?.listed ? `${escapeHtml(company.listing.ticker || "---")} · 已上市` : "未上市"}</span> <span class="badge${statusNeedsAttention ? " red" : ""}">${escapeHtml(company.status || "运营中")}</span></span></div>
    <div class="row"><span class="label">公司等级 / 在岗 / 目标</span><strong class="value">${number(company.listedLevels)}级 · ${number(company.workers)} / ${number(company.plannedWorkers)}人</strong></div>
    <div class="row"><span class="label">可支付资金 / 欠薪</span><strong class="value">${number(company.cashVoucher, 2)}粮券 + ${number(company.cashWheatJin || 0, 2)}斤小麦 / ${number(company.arrearsVoucher, 2)}${escapeHtml(unit)}</strong></div>
    <div class="row"><span class="label">近期日均销量 / 实际利润</span><strong class="value">${company.averageDailySales > 0 ? number(company.averageDailySales, 2) : "暂无销量"} / ${number(company.averageDailyProfitVoucher, 2)}${escapeHtml(unit)}</strong></div>
    <div class="row"><span class="label">库存</span><strong class="value">${inventoryText(company.inventoryRows)}</strong></div>
    ${renderOperationControls(view, company)}
    ${renderListing(view, company)}
    <details class="detail-block" data-detail-key="company-detail:${escapeHtml(company.id)}"><summary>账目与年度结算</summary><div class="detail-body">
      <div class="row"><span class="label">今日产出 / 售出</span><strong class="value">${itemRowsText(company.producedRowsDay)} / ${itemRowsText(company.soldRowsDay)}</strong></div>
      <div class="row"><span class="label">今日收入 / 净利润</span><strong class="value">${number(company.revenueDayVoucher, 2)} / ${number(company.profitDayVoucher, 2)}${escapeHtml(unit)}</strong></div>
      <div class="row"><span class="label">今日成本</span><strong class="value">已售${number(company.cogsDayVoucher, 2)} · 工资${number(company.wagesDayVoucher, 2)} · 税${number(company.taxCostDayVoucher, 2)} · 损耗${number(company.processingLossDayVoucher, 2)}${escapeHtml(unit)}</strong></div>
      <div class="row"><span class="label">360日周转金目标</span><strong class="value">${number(company.workingCapitalReserveVoucher, 2)}${escapeHtml(unit)}</strong></div>
      <div class="row"><span class="label">上年净利润 / 实际分配</span><strong class="value">${number((annual.lastYearNetProfitVoucherUnits || 0) / scale, 2)} / ${number((annual.distributedVoucherUnits || 0) / scale, 2)}${escapeHtml(unit)}</strong></div>
      <div class="row"><span class="label">未分配利润</span><strong class="value">${number(company.retainedEarningsVoucher, 2)}${escapeHtml(unit)}</strong></div>
    </div></details>
  </div>`;
}

export function renderEnterpriseFinance(view) {
  const ipo = view.ipo || null;
  const companies = view.companies || [];
  const townRows = (ipo?.buildings || []).filter(row => row.owner === "town" && !row.companyId);
  const applications = ipo?.applications || [];
  const cooldowns = (ipo?.cooldowns || []).filter(row => row.active);
  const exchangeState = view.stockExchange?.available
    ? (view.stockExchange.physical ? "交易所已建成" : "旧档兼容交易所入口")
    : "尚未建成交易所";
  return `${renderPrices(view)}
    <section class="enterprise-section"><h2>整栋上市</h2>
      ${ipo?.gateReason ? `<div class="subtle">${escapeHtml(ipo.gateReason)}；建成交易所并完成货币改革后可上市。</div>` : ""}
      ${townRows.length ? townRows.map(row => renderTownListingForm(view, row)).join("") : `<div class="cardlet subtle">暂无镇营产业可整栋上市。</div>`}
      ${applications.length ? `<h3>民营上市申请</h3>${applications.map(row => renderIpoApplication(view, row)).join("")}` : ""}
      ${cooldowns.length ? `<div class="subtle">冷却中：${cooldowns.map(row => `${escapeHtml(row.householdName)}约${number(Math.max(0, row.untilSerial - (ipo.serial || 0)))}日后可再申请`).join("；")}。</div>` : ""}
    </section>
    <section class="enterprise-section"><h2>独立公司</h2>
      ${companies.length ? companies.map(company => renderCompany(view, company)).join("") : `<div class="cardlet subtle">暂无独立公司。</div>`}
    </section>
    <section class="enterprise-section"><h2>交易所</h2><div class="cardlet"><div class="row"><span class="label">状态</span><strong class="value">${escapeHtml(exchangeState)}</strong></div><div class="row"><span class="label">新上市条件</span><strong class="value">${view.stockExchange?.reformComplete ? "货币改革已完成" : "须完成货币改革"}</strong></div></div></section>`;
}
