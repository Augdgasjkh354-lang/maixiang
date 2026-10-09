import { escapeHtml, number, numberMax, moneyUnit } from "./format.js";
import { MODS } from "../mods/registry.js";
import { wholesaleItemIds } from "../content/assemble.js";
import { CONTENT } from "../content/index.js";
import { isIndustryType } from "../content/buildings.js";
import { villaCapacityOf } from "../systems/villas.js";
import { renderNumericInput } from "./numeric-drafts.js";
import { renderShopPricing } from "./panel-shop-pricing.js";

// 商业街能开的店：综合商店与服务类（无宿主建筑，或宿主为商业街），排除旧别名。新增服务店自动出现在按钮里。
const COMMERCIAL_STREET_SHOP_TYPES = Object.values(CONTENT.rules.shopTypes || {})
  .filter(def => !def.aliasOf && (def.kind === "retail" || def.kind === "service")
    && (!def.hostBuildingTypeId || def.hostBuildingTypeId === "commercial_street"));

// 地块标签人性化（0.1.11 _2() 补回）："空地 3" → "3号地"
function humanizePlotLabel(view, building) {
  const label = view.plots?.find(p => p.id === building.plotId)?.label;
  if (!label) return building.id;
  return label.replace(/^空地\s*(\d+)$/, "$1号地").replace(/空地$/, "") || label;
}

function outputLines(map, names, units, scale) {
  const rows = Object.entries(map || {}).filter(([, quantity]) => quantity > 0);
  return rows.map(([id, quantity]) =>
    escapeHtml(names[id] || id) + " " + number(quantity / scale) + escapeHtml(units[id] || "单位")
  ).join(" · ") || "暂无产出";
}

function workerControl(view, job, idle) {
  const unit = moneyUnit(view);
  const poachable = job.poachable || 0;
  const maximum = job.workers + Math.min(Math.max(0, job.capacity - job.workers), idle + poachable);
  return `<div class="site-worker-control"><span>${escapeHtml(job.name)} · ${number(job.workers)}/${number(job.capacity)}人 · 日薪${number(job.effectiveWagePerWorkerDay, 2)}${escapeHtml(unit)}</span><div class="site-worker-actions"><button class="step-btn" data-job="${escapeHtml(job.key)}" data-step="-1" aria-label="减少${escapeHtml(job.name)}" ${job.workers <= 0 ? "disabled" : ""}>−</button>${renderNumericInput(view, { key: `workers:${job.key}`, kind: "employment", target: job.key, value: job.workers, label: `${job.name}人数`, integer: true, minimum: 0, maximum, confirmLabel: "✓", className: "worker-editor site-worker-editor" })}<button class="step-btn" data-job="${escapeHtml(job.key)}" data-step="1" aria-label="增加${escapeHtml(job.name)}" ${job.workers >= maximum || (idle + poachable) <= 0 ? "disabled" : ""}>＋</button></div></div>`;
}


function buildingStaffingMarkup(view, building) {
  const jobs = (building?.jobs || []).map(job => ({ ...job, key: `${building.id}::${job.id}` }));
  if (!jobs.length) return "";
  const controls = jobs.map(job => workerControl(view, job, view.labor.idle)).join("");
  const wage = jobs[0];
  return `<h3>人员</h3>${controls}<div class="row"><span class="label">日薪（政策页系数调节）</span><strong class="value">${number(wage.effectiveWagePerWorkerDay, 2)}${escapeHtml(moneyUnit(view))}</strong></div>`;
}

// 用户 0.1.11：镇营目标日产量。仅有主产出品且镇营仍占级数的建筑显示；
// 0 表示按人手满产，>0 时每日产量封顶，用不上的人手仍照常领工资。
function outputTargetMarkup(view, building) {
  if (!building.mainOutputItemId || !(building.ownership?.townLevels > 0)) return "";
  const itemName = view.itemNames?.[building.mainOutputItemId] || building.mainOutputItemId;
  const itemUnit = view.itemUnits?.[building.mainOutputItemId] || "斤";
  const target = building.outputTargetJin || 0;
  return `<div class="row"><span class="label">镇营目标日产量</span><div class="setting-input">${renderNumericInput(view, { key: `output-target:${building.id}`, kind: "output-target", target: building.id, value: target, label: `${itemName}目标日产量`, minimum: 0, maximum: 1000000000, className: "setting-editor" })}<b>${escapeHtml(itemUnit)}</b></div></div><div class="subtle">${target > 0 ? `每天最多产${escapeHtml(itemName)}${number(target)}${escapeHtml(itemUnit)}；用不上的人手仍照常领工资，可在下方减人。` : "0 表示按人手满产。"}</div>`;
}

function stagedBankInput(view, key, label, value) {  const shown = view.numericDrafts?.[key]?.value ?? String(value ?? "");
  return `<input type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" spellcheck="false"
    value="${escapeHtml(shown)}" aria-label="${escapeHtml(label)}" data-draft-key="${escapeHtml(key)}"
    data-draft-kind="stage" data-draft-label="${escapeHtml(label)}" data-draft-minimum="0" data-draft-maximum="1000000000"
    data-draft-integer="false" data-draft-positive="true">`;
}

const EMPLOYER_KIND_NAMES = { town: "镇营", private: "民营", company: "公司", shop: "店铺" };

// 最近一日社保缴费的雇主 / 家庭拆分，以及雇主欠缴（按类别与前 5 名欠款方）。只读。
function socialSecurityContributionMarkup(ss) {
  const last = ss.lastContribution || {};
  const byKind = ss.employerArrearsByKindJin || {};
  const kinds = Object.keys(EMPLOYER_KIND_NAMES).map(kind => `${EMPLOYER_KIND_NAMES[kind]} ${number(byKind[kind] || 0, 1)}`).join(" / ");
  const debtors = (ss.topEmployerDebtors || []).map(row =>
    `<div class="row"><span class="label">${escapeHtml(row.name || row.owner)} · ${escapeHtml(EMPLOYER_KIND_NAMES[row.kind] || row.kind)}</span><strong class="value">${number(row.arrearsJin, 1)}斤</strong></div>`
  ).join("");
  return `<div class="cardlet">
      <div class="setting-title">社保缴费拆分（今日）</div>
      <div class="row"><span class="label">雇主应缴 / 已缴</span><strong class="value">${number(last.employerDueJin, 1)} / ${number(last.employerCollectedJin, 1)}斤</strong></div>
      <div class="row"><span class="label">家庭应缴 / 已缴</span><strong class="value">${number(last.householdDueJin, 1)} / ${number(last.householdCollectedJin, 1)}斤</strong></div>
      <div class="row"><span class="label">雇主欠缴合计</span><strong class="value">${number(ss.employerArrearsJin, 1)}斤</strong></div>
      <div class="row"><span class="label">欠缴按类别</span><strong class="value">${kinds}</strong></div>
      ${debtors ? `<div class="subtle">欠缴最多的前 5 名</div>${debtors}` : `<div class="subtle">暂无雇主欠缴。</div>`}
    </div>`;
}

function socialSecurityMarkup(view) {
  const ss = view.socialSecurity;
  if (!ss) return "";
  const input = (key, kind, value, label, extra = {}) => renderNumericInput(view, { key, kind, target: "socialSecurity", value, label, minimum: 0, maximum: 1000000000, className: "setting-editor", ...extra });
  // 暂存输入：只记录草稿，由旁边的操作按钮提交。
  const staged = (key, value, label, integer = false) => `<input class="staged-input" type="text" inputmode="${integer ? "numeric" : "decimal"}" enterkeyhint="done" autocomplete="off" spellcheck="false" value="${escapeHtml(view.numericDrafts?.[key]?.value ?? String(value))}" aria-label="${escapeHtml(label)}" data-draft-key="${escapeHtml(key)}" data-draft-kind="stage" data-draft-label="${escapeHtml(label)}" data-draft-minimum="0" data-draft-maximum="1000000000" data-draft-integer="${integer}" data-draft-positive="true">`;
  const holdings = (ss.holdings || []).map(row => `<div class="cardlet"><div class="row"><strong>${escapeHtml(row.name)}</strong><span class="badge">股价 ${number(row.priceJin, 2)}</span></div>
      <div class="row"><span class="label">持股 / 市值</span><strong class="value">${number(row.shares)}股 / ${number(row.valueJin, 1)}斤</strong></div>
      <div class="row"><span class="label">镇库可售</span><strong class="value">${number(row.townAvailable)}股</strong></div>
      <div class="row"><span class="label">股数</span><div class="setting-input">${staged(`social-shares:${row.companyId}`, 100, `${row.name}交易股数`, true)}<button class="secondary" data-social-buy="${escapeHtml(row.companyId)}">买入</button><button class="secondary" data-social-sell="${escapeHtml(row.companyId)}">卖出</button></div></div></div>`).join("");
  return `<div class="cardlet">
      <label class="toggle"><input id="socialSecurityEnabled" type="checkbox" ${ss.enabled ? "checked" : ""}><span>开启社保基金</span></label>
      <div class="row"><span class="label">每劳动力每日缴纳</span><div class="setting-input">${input("social-daily", "social-daily", ss.dailyPerWorkerJin, "社保每日缴费")}<b>斤</b></div></div>
      <div class="row"><span class="label">每老人每日养老金</span><div class="setting-input">${input("social-pension", "social-pension", ss.pensionPerElderJin, "养老金标准")}<b>斤</b></div></div>
      <div class="row"><span class="label">雇主承担比例（替员工交社保）</span><div class="setting-input">${input("social-employer-share", "social-employer-share", ss.employerSharePercent ?? 100, "雇主承担比例", { maximum: 100 })}<b>%</b></div></div>
      <div class="subtle">开启后失业金也由基金发放；基金不够时镇库垫付，计入负债。雇主付不起的社保记为欠缴，之后有钱优先补缴。</div>
    </div>
    ${socialSecurityContributionMarkup(ss)}
    <div class="cardlet">
      <div class="row"><span class="label">基金现金</span><strong class="value">${number(ss.cashJin, 1)}斤</strong></div>
      <div class="row"><span class="label">股票市值</span><strong class="value">${number(ss.stockValueJin, 1)}斤</strong></div>
      <div class="row"><span class="label">欠国库</span><strong class="value">${number(ss.debtJin, 1)}斤</strong></div>
      <div class="row"><span class="label">注资（镇库→基金）</span><div class="setting-input">${staged("social-inject", 10000, "社保基金注资金额")}<button class="secondary" data-social-inject>注资</button></div></div>
      <div class="row"><span class="label">还款（基金→镇库）</span><div class="setting-input">${staged("social-repay", Math.max(0, Math.round(ss.debtJin)), "社保基金还款金额")}<button class="secondary" data-social-repay ${ss.debtJin > 0 ? "" : "disabled"}>还款</button></div></div>
    </div>
    <details class="detail-block" data-detail-key="social-totals"><summary>累计收支</summary><div class="detail-body">
      <div class="row"><span class="label">缴费收入 / 分红收入</span><strong class="value">${number(ss.totalCollectedJin, 1)} / ${number(ss.totalDividendJin, 1)}斤</strong></div>
      <div class="row"><span class="label">养老金与失业金支出</span><strong class="value">${number(ss.totalPaidJin, 1)}斤</strong></div>
      <div class="row"><span class="label">注资 / 镇库垫付 / 已还</span><strong class="value">${number(ss.totalInjectedJin, 1)} / ${number(ss.totalAdvancedJin, 1)} / ${number(ss.totalRepaidJin, 1)}斤</strong></div>
    </div></details>
    ${holdings ? `<h3>股票投资</h3>${holdings}` : `<div class="cardlet subtle">暂无上市公司可投资。</div>`}`;
}

function bankManagementMarkup(view, physical = true) {
  const reform = view.monetaryReform;
  const c = view.currency;
  const preview = view.currencyPreview;
  const previewMarkup = preview ? `<div class="operation-preview">
    <strong>${preview.type === "issue" ? "印制发行确认" : "注销确认"}</strong>
    <div class="row"><span class="label">数量</span><strong class="value">${number(preview.amount, 2)}粮券</strong></div>
    <div class="row"><span class="label">操作后镇库粮券</span><strong class="value">${number(preview.afterTownVoucher, 2)}粮券</strong></div>
    <div class="business-sticky-actions"><button class="secondary" data-currency-preview-cancel>取消</button><button class="primary" data-currency-confirm="${preview.type}">确认${preview.type === "issue" ? "印制发行" : "注销"}</button></div>
  </div>` : "";
  const controls = reform.stage === "wheat"
    ? `<div class="subtle">启动货币改革后立即改用粮券结算：镇库按小麦存量印制等额粮券，居民可随时以粮换券。</div><button class="secondary wide" data-go="policy">前往政策</button>`
    : `<div class="row"><span class="label">每名就业者每日换券额度</span><div class="setting-input">${renderNumericInput(view, { key: "employment-exchange", kind: "employment-exchange", target: "households", value: reform.employmentExchangeJin, label: "每名就业者每日换券额度", minimum: reform.employmentExchangeMinimumJin, maximum: reform.employmentExchangeMaximumJin, className: "setting-editor" })}<b>斤</b></div></div>
      <h3>粮券印制与注销</h3>
      <div class="row"><span class="label">镇库 / 居民粮券</span><strong class="value">${number(c.townVoucher, 2)} / ${number(c.residentVoucher, 2)}粮券</strong></div>
      <div class="row"><span class="label">流通粮券</span><strong class="value">${number(c.circulationVoucher, 2)}粮券</strong></div>
      <div class="business-form-row"><label>数量${stagedBankInput(view, "currency-amount", "发行或兑付数量", 1000)}</label><div class="settings-actions"><button class="secondary" data-currency-preview="issue">印制粮券</button><button class="secondary" data-currency-preview="redeem">注销粮券</button></div></div>
      ${previewMarkup}`;
  return `<div class="status-strip"><span class="status-light working"></span><strong>${physical ? "银行" : "兼容银行入口"}</strong><span>${reform.stageName}</span></div>
    <div class="row"><span class="label">当前制度</span><strong class="value">${reform.stageName}</strong></div>
    ${controls}`;
}

function reclaimSection(view) {
  const reclaim = view.reclaim;
  if (!reclaim || !view.reclaim) return "";
  const unit = moneyUnit(view);
  const draftKey = "reclaim-acres";
  const last = reclaim.last;
  const recent = (reclaim.history || []).map(row =>
    `${number(row.year)}年${number(row.day)}日 开${number(row.acres)}亩 · ${number(row.workDays)}工日 · 付${number(row.paidVoucherUnits / view.currencyUnitsPerVoucher, 2)}${escapeHtml(unit)}`
  ).join("<br>") || "尚无开荒记录";
  const disabled = reclaim.canReclaim ? "" : "disabled";
  return `<h3>开荒</h3>
    <div class="row"><span class="label">已开荒 / 上限</span><strong class="value">${number(reclaim.current)} / ${number(reclaim.maximum)}亩</strong></div>
    <div class="row"><span class="label">可开垦余量</span><strong class="value">${number(reclaim.remaining)}亩</strong></div>
    <div class="row"><span class="label">开荒比例</span><strong class="value">${number(reclaim.workDaysPerBatch)}工日 / ${number(reclaim.batchAcres)}亩</strong></div>
    <div class="row"><span class="label">开荒工日薪</span><strong class="value">${number(reclaim.wagePerWorkerDay)}${escapeHtml(unit)}/工日</strong></div>
    <div class="row"><span class="label">本次 ${number(reclaim.nextAcres)}亩 预计</span><strong class="value">${number(reclaim.nextWorkDays)}工日 · 约${number(reclaim.nextVoucher)}${escapeHtml(unit)}</strong></div>
    ${reclaim.canReclaim ? `<div class="setting-input"><label>本次开荒亩数</label>${renderNumericInput(view, { key: draftKey, kind: "reclaim-acres", target: "field", value: reclaim.nextAcres, label: "本次开荒亩数", integer: true, minimum: 1, maximum: reclaim.remaining, className: "setting-editor" })}<b>亩</b></div>
    <div class="business-form-row"><label>投入开荒人数<input type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off" spellcheck="false" value="${escapeHtml(view.numericDrafts?.["reclaim-workers"]?.value ?? String(Math.max(1, reclaim.nextWorkDays)))}" aria-label="投入开荒人数" data-draft-key="reclaim-workers" data-draft-kind="reclaim-workers" data-draft-target="field" data-draft-label="投入开荒人数" data-draft-minimum="1" data-draft-maximum="100000" data-draft-integer="true" data-draft-positive="true"></label><button class="primary" data-reclaim-submit ${disabled}>开荒</button></div>
    <div class="subtle">开荒工资由镇库承担，按实际工日结算并逐笔记账；已开荒耕地按每${number(view.acresPerFarmer)}亩 1 人提升可耕种人数上限。</div>` : `<div class="subtle">耕地已达开荒上限 ${number(reclaim.maximum)}亩。</div>`}
    <details class="detail-block" data-detail-key="reclaim-history"><summary>开荒账目</summary><div class="detail-body"><div class="row"><span class="label">今日 / 本年 / 累计</span><strong class="value">${number(reclaim.day?.acres)} / ${number(reclaim.year?.acres)} / ${number(reclaim.cumulative?.acres)}亩</strong></div><div class="row"><span class="label">累计工日</span><strong class="value">${number(reclaim.cumulative?.workDays)}工日</strong></div><div class="row"><span class="label">镇库累计开荒工资</span><strong class="value">${number(reclaim.cumulative?.paidVoucher, 2)}${escapeHtml(unit)}</strong></div>${last ? `<div class="row"><span class="label">上次开荒</span><strong class="value">${number(last.year)}年${number(last.day)}日 · ${number(last.acres)}亩 / ${number(last.workDays)}工日</strong></div>` : ""}<div class="subtle">${recent}</div></div></details>`;
}

// 养殖基地：每座养殖场一张卡，结构同商业街店铺卡。
const FARM_TYPE_IDS = ["chicken_farm", "duck_farm", "goose_farm", "pig_farm"];

function farmCardMarkup(view, shop, unit) {
  const farm = shop.farm || {};
  const maxOwners = shop.maxMerchants || 4;
  const staffControls = shop.status === "open"
    ? `<div class="site-worker-actions"><button class="step-btn" data-shop-merchant="${escapeHtml(shop.id)}" data-step="-1" aria-label="减少养殖户" ${shop.merchants <= 1 ? "disabled" : ""}>−</button><strong>养殖户 ${number(shop.merchants)} / ${number(maxOwners)}</strong><button class="step-btn" data-shop-merchant="${escapeHtml(shop.id)}" data-step="1" aria-label="增加养殖户" ${shop.merchants >= maxOwners || view.labor.idle <= 0 ? "disabled" : ""}>＋</button></div>
      <div class="row"><span class="label">饲养员（自动增减）</span><strong class="value">${number(shop.clerks)} / ${number(shop.maxClerks || 20)}人${shop.staffingDiagnosis ? ` · ${escapeHtml(shop.staffingDiagnosis)}` : ""}</strong></div>`
    : "";
  const action = shop.status === "liquidating"
    ? `<button class="secondary" data-shop-fund="${escapeHtml(shop.id)}">业主补资清偿</button>`
    : `<button class="secondary" data-shop-close="${escapeHtml(shop.id)}">停业</button>`;
  return `<div class="cardlet"><div class="row"><strong>${escapeHtml(shop.name)} · ${escapeHtml(shop.typeName)}</strong><span class="badge">${escapeHtml(shop.statusReason)}</span></div>
    <div class="row"><span class="label">今日利润</span><strong class="value">${number(shop.profitDayVoucher, 2)}${escapeHtml(unit)}</strong></div>${staffControls}
    <div class="row"><span class="label">日产能 / 今日产量</span><strong class="value">${number(farm.capacityJin, 1)} / ${number(farm.producedDayJin, 1)}斤</strong></div>
    <div class="row"><span class="label">肉存货 / 饲料存量</span><strong class="value">${number(farm.productStockJin, 1)} / ${number(farm.feedStockJin, 1)}斤</strong></div>
    <div class="row"><span class="label">今日卖给商店</span><strong class="value">${number(farm.storeSoldDayJin, 1)}斤</strong></div>
    <div class="row"><span class="label">售价</span><strong class="value">${number(farm.priceVoucher, 2)}${escapeHtml(unit)}/斤</strong></div>
    <div class="subtle">每名饲养员日产${number(farm.outputPerWorkerDay)}斤${escapeHtml(farm.productName || "")}，每斤耗${number(farm.feedPerUnit, 1)}斤${escapeHtml(farm.feedName || "")}。</div>
    <details class="detail-block" data-detail-key="shop:${escapeHtml(shop.id)}"><summary>经营详情</summary><div class="detail-body">
      <div class="row"><span class="label">业主</span><strong class="value">${escapeHtml(shop.ownerName || shop.ownerHouseholdId)}</strong></div>
      <div class="row"><span class="label">饲养员日薪</span><strong class="value">${number(shop.clerkWageVoucher, 1)}${escapeHtml(unit)}${shop.wageTarget != null ? ` · 行情${number(shop.wageTarget, 1)}` : ""}${shop.wageDiagnosis ? ` · ${escapeHtml(shop.wageDiagnosis)}` : ""}</strong></div>
      <div class="row"><span class="label">可支付资金</span><strong class="value">${number(shop.cashVoucher, 2)}粮券 · ${number(shop.cashWheatJin || 0, 2)}斤小麦</strong></div>
      <div class="row"><span class="label">今日收入 / 成本</span><strong class="value">${number(shop.revenueDayVoucher, 2)} / ${number(shop.cogsDayVoucher + shop.wageDayVoucher + shop.rentDayVoucher, 2)}${escapeHtml(unit)}</strong></div>
      <div class="row"><span class="label">欠薪 / 欠租 / 欠税</span><strong class="value">${number(shop.wageArrearsVoucher, 2)} / ${number(shop.rentArrearsVoucher, 2)} / ${number(shop.taxArrearsVoucher, 2)}${escapeHtml(unit)}</strong></div>
      ${action}
    </div></details></div>`;
}

function livestockBaseMarkup(view, building, development) {
  const unit = moneyUnit(view);
  const farms = (view.shops || []).filter(shop => shop.buildingId === building.id && shop.status !== "closed");
  const slots = building.level * (CONTENT.buildings.livestock_base.shopHost?.slotsPerLevel || 4);
  const ownerCount = farms.reduce((sum, shop) => sum + (shop.merchants || 0), 0);
  const clerkCount = farms.reduce((sum, shop) => sum + (shop.clerks || 0), 0);
  const openButtons = farms.length < slots
    ? `<div class="site-actions">${FARM_TYPE_IDS.map(typeId => `<button class="secondary" data-shop-open="${typeId}" data-shop-building="${escapeHtml(building.id)}">开${escapeHtml(CONTENT.rules.shopTypes[typeId].name)}</button>`).join("")}</div>`
    : "";
  return `<div class="status-strip"><span class="status-light working"></span><strong>养殖基地</strong><span>${number(building.level)}级</span></div>
    <div class="row"><span class="label">场位 已用 / 总数</span><strong class="value">${number(farms.length)} / ${number(slots)}</strong></div>
    <div class="row"><span class="label">养殖户 / 饲养员</span><strong class="value">${number(ownerCount)} / ${number(clerkCount)}人</strong></div>
    ${openButtons}${farms.map(shop => farmCardMarkup(view, shop, unit)).join("") || `<div class="subtle">暂无养殖场，场位空着。</div>`}${developmentMarkup(view, building, development)}`;
}

function timesSquareMarkup(view, building, development) {
  const unit = moneyUnit(view);
  const square = (view.stallSquares || []).find(row => row.buildingId === building.id) || {};
  const slots = square.slots ?? building.level * (CONTENT.buildings.times_square.shopHost?.slotsPerLevel || 50);
  const stallLimit = view.policy?.stallKeeperLimit ?? square.keeperLimit ?? 50;
  const rentVoucher = view.policy?.stallRentVoucher ?? square.rentVoucher ?? 2;
  const payout = square.payout;
  const goods = (square.inventoryRows || []).map(row => `<div class="row"><span class="label">${escapeHtml(row.itemName)}</span><strong class="value">存${number(row.stock, 1)} · 日均售${number(row.averageDailySales, 1)} · 进${number(row.wholesaleVoucher, 2)} 售${number(row.retailVoucher, 2)}${escapeHtml(unit)}</strong></div>`).join("");
  const market = `<div class="cardlet"><div class="row"><strong>集市</strong><span class="badge">${escapeHtml(square.statusReason || "未开放摆摊")}</span></div>
    <div class="row"><span class="label">摆摊人数 / 上限</span><strong class="value">${number(square.keepers || 0)} / ${number(square.keeperCap ?? stallLimit)}人</strong></div>
    <div class="row"><span class="label">占用摊位 / 总数</span><strong class="value">${number(square.stallsUsed || 0)} / ${number(slots)}</strong></div>
    <div class="row"><span class="label">今日卖货 / 卖货能力</span><strong class="value">${number(square.soldDayJin || 0, 1)} / ${number(square.capacityJin || 0, 0)}斤</strong></div>
    <div class="row"><span class="label">今日收入 / 摊租</span><strong class="value">${number(square.revenueDayVoucher || 0, 2)} / ${number(square.rentDayVoucher || 0, 2)}${escapeHtml(unit)}</strong></div>
    <div class="row"><span class="label">今日利润 / 7日均</span><strong class="value">${number(square.profitDayVoucher || 0, 2)} / ${number(square.averageDailyProfitVoucher || 0, 2)}${escapeHtml(unit)}</strong></div>
    <div class="row"><span class="label">最近一次分红（每人）</span><strong class="value">${payout ? `${number(payout.min, 2)}—${number(payout.max, 2)}${escapeHtml(unit)} · ${number(payout.households)}户` : "—"}</strong></div>
    <div class="row"><span class="label">累计分给摆摊家庭</span><strong class="value">${number(square.distributedTotalVoucher || 0, 1)}${escapeHtml(unit)}</strong></div>
    ${(square.townAdvanceVoucher || 0) > 0 ? `<div class="row"><span class="label">待还镇库垫款</span><strong class="value">${number(square.townAdvanceVoucher, 1)}${escapeHtml(unit)}</strong></div>` : ""}
    ${goods ? `<details class="detail-block" data-detail-key="stall-goods:${escapeHtml(building.id)}"><summary>货品</summary><div class="detail-body">${goods}</div></details>` : ""}
  </div>`;
  return `<div class="status-strip"><span class="status-light working"></span><strong>时代广场</strong><span>${number(building.level)}级</span></div>
    ${market}
    <div class="cardlet"><div class="setting-title">摆摊政策</div>
      <div class="row"><span class="label">允许摆摊人数（全镇）</span><div class="setting-input">${renderNumericInput(view, { key: "stall-limit:square", kind: "stall-limit", target: "stalls", value: stallLimit, label: "允许摆摊人数", integer: true, minimum: 0, maximum: 100000, className: "setting-editor" })}<b>人</b></div></div>
      <div class="row"><span class="label">摊租（每摊每日）</span><div class="setting-input">${renderNumericInput(view, { key: "stall-rent:square", kind: "stall-rent", target: "stalls", value: rentVoucher, label: "每摊每日摊租", minimum: 0, maximum: 100000, className: "setting-editor" })}<b>${escapeHtml(unit)}</b></div></div>
      <div class="setting-title">免租${(square.rentFreeDaysLeft || 0) > 0 ? `（还剩${number(square.rentFreeDaysLeft)}天）` : ""}</div>
      <div class="settings-actions">${(square.rentFreeOptionsDays || []).map((days, index) => {
        const label = ["三个月", "半年", "一年", "三年"][index] || `${days}天`;
        return `<button class="secondary" data-stall-rent-free="${days}" data-label="${label}">${label}</button>`;
      }).join("")}${(square.rentFreeDaysLeft || 0) > 0 ? `<button class="secondary" data-stall-rent-free="0">取消免租</button>` : ""}</div>
      <div class="setting-title">批发特价（集市进货每斤少收）</div>
      <div class="settings-actions">${(square.discountTiers || [0]).map((cut, tier) =>
        `<button class="${tier === (square.discountTier || 0) ? "primary" : "secondary"}" data-stall-discount="${tier}">${tier === 0 ? "不打折" : `${["", "一", "二", "三"][tier] || tier}级 −${number(cut, 1)}斤`}</button>`).join("")}</div>
      <div class="row"><span class="label">累计免掉摊租 / 特价补贴</span><strong class="value">${number(square.rentWaivedTotalVoucher || 0, 1)} / ${number(square.subsidyTotalVoucher || 0, 1)}${escapeHtml(unit)}</strong></div>
      <div class="subtle">待业的人自动来摆，按销量增减人手；只卖日用品不卖主食，每人每日最多卖${number(square.perKeeperSalesJin || 25)}斤（一摊2人），售价比综合商店低一点（不低于进价）。每天的利润按人头分给摆摊家庭，各户随机多拿少拿两成。</div>
    </div>${developmentMarkup(view, building, development)}`;
}

export function renderSite(view) {
  const unit = moneyUnit(view);
  const site = view.selectedSite || "field";
  const buildingId = site.startsWith("building:") ? site.slice("building:".length) : null;
  const projectId = site.startsWith("project:") ? site.slice("project:".length) : null;
  const building = view.buildings.find(row => row.id === buildingId);
  const development = view.buildingDevelopment;
  const project = projectId ? (view.projects || []).find(row => row.instanceId === projectId) || null : null;
  let title = "小镇一隅";
  let body = "";
  let actions = "";

  if (site === "field") {
    const farmers = view.labor.rows.find(row => row.roleId === "farmers");
    body = `<div class="row"><span class="label">耕地</span><strong class="value">${number(view.farmAcres)}亩</strong></div><div class="row"><span class="label">农人在岗 / 目标</span><strong class="value">${number(farmers?.count || 0)} / ${number(farmers?.targetCount ?? farmers?.count ?? 0)}人</strong></div><div class="row"><span class="label">可耕种人数上限</span><strong class="value">${number(view.farmCapacity)}人</strong></div>${(farmers?.targetShortage || 0) > 0 ? `<div class="shortage-banner visible">农业缺员 ${number(farmers.targetShortage)}人</div>` : ""}<div class="row"><span class="label">今年农事</span><strong class="value">${number(view.farmWorkDays)} / ${number(view.growingDays)}农人日</strong></div><div class="meter"><span style="width:${number(view.farmWorkPercent, 1)}%"></span></div><div class="row"><span class="label">预计净收成</span><strong class="value">${number(view.forecast)}斤</strong></div>${reclaimSection(view)}`;
    actions = `<button class="secondary" data-go="residents">安排农人</button>`;
    title = "麦田";
  } else if (site === "granary") {
    title = "粮仓";
    body = `<div class="row"><span class="label">居民口粮</span><strong class="value">${number(view.accounts.residents.qeq)}斤</strong></div><div class="row"><span class="label">镇库口粮</span><strong class="value">${number(view.accounts.town.qeq)}斤</strong></div><div class="row"><span class="label">居民可吃</span><strong class="value">${numberMax(view.residentFoodDays, 1)}天</strong></div>`;
    actions = `<button class="secondary" data-go="business">查看经营</button>`;
  } else if (site === "houses") {
    title = "村舍与镇民";
    body = `<div class="row"><span class="label">人口 / 住房</span><strong class="value">${number(view.people.total)} / ${number(view.housingCapacity)}人</strong></div><div class="row"><span class="label">未成年 / 劳动年龄 / 老人</span><strong class="value">${number(view.people.children)} / ${number(view.people.workers)} / ${number(view.people.elders)}人</strong></div><div class="row"><span class="label">待业</span><strong class="value">${number(view.labor.idle)}人</strong></div>`;
    actions = `<button class="secondary" data-go="residents">查看镇民</button>`;
  } else if (site === "well") {
    title = "古井与村道";
    body = `<div class="subtle" style="margin-top:0">镇民沿主路往来，作坊和住宅围着麦田分布。</div>`;
  } else if (site.startsWith("resource:") && view.selectedResourcePlot) {
    const point = view.selectedResourcePlot;
    const isSalt = point.feature === "salt_mine";
    const kind = isSalt ? "saltworks" : "lumberyard";
    const option = view.constructionOptions.find(row => row.id === kind);
    title = isSalt ? "盐矿资源点" : "南林资源点";
    body = `<div class="row"><span class="label">资源</span><strong class="value">${isSalt ? "食盐矿脉" : "林木"}</strong></div><div class="row"><span class="label">已建设 / 可建</span><strong class="value">${number(view.buildings.filter(row => row.typeId === kind).length)} / ${number(option?.availablePlotCount || 0)}处</strong></div>`;
    actions = `<button class="secondary" data-go="build">去建设</button>`;
  } else if (site === "bank-compat" && view.monetaryReform.legacyBankAccess) {
    title = "银行 · 旧存档兼容入口";
    body = bankManagementMarkup(view, false);
    actions = `<button class="secondary" data-go="policy">返回政策</button>`;
  } else if (building?.typeId === "social_security_office") {
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    body = `${socialSecurityMarkup(view)}${buildingStaffingMarkup(view, building)}${developmentMarkup(view, building, development)}`;
  } else if (building?.typeId === "logistics_center" || building?.typeId === "dock") {
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    body = `${freightSiteMarkup(building)}${buildingStaffingMarkup(view, building)}${developmentMarkup(view, building, development)}`;
  } else if (building?.typeId === "bank") {
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    body = `${bankManagementMarkup(view, true)}${buildingStaffingMarkup(view, building)}${developmentMarkup(view, building, development)}`;
    actions = `<button class="secondary" data-go="policy">查看货币改革政策</button>`;
  } else if (building?.typeId === "wholesale_market") {
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    const market = view.wholesaleMarket || { inventory: {}, pricesVoucherPerUnit: {}, purchasePricesVoucherPerUnit: {}, dailyTownAllocation: {}, cashflow: null };
    const trends = view.wholesaleTrends || {};
    const tradeableIds = wholesaleItemIds(CONTENT);
    const autoBandPercent = CONTENT.rules.priceAdjust?.wholesaleBandPercent ?? 30;
    const marketRowsAll = tradeableIds.map(itemId => {
      const name = view.itemNames?.[itemId] || itemId;
      const itemUnit = view.itemUnits?.[itemId] || "斤";
      const moveKey = `wholesale-move:${itemId}`;
      // 自动调价只对批发市场做市的商品存在（见 wholesaleSummary 的 autoPricing 视图）；没有该行则不显示开关。
      const autoRow = market.autoPricing?.[itemId];
      const autoPriceRow = autoRow ? `<div class="row"><span class="label">自动调价</span><div class="setting-input"><button class="secondary" aria-pressed="${autoRow.enabled ? "true" : "false"}" data-wholesale-autoprice="${escapeHtml(itemId)}" data-next="${autoRow.enabled ? "false" : "true"}">${autoRow.enabled ? "自动调价：开" : "自动调价：关"}</button>${autoRow.enabled ? `<span class="subtle">锚定价 ${number(autoRow.anchorVoucherPerUnit, 3)}，浮动 ±${number(autoBandPercent)}%${autoRow.reason ? ` · ${escapeHtml(autoRow.reason)}` : ""}</span>` : ""}</div></div>` : "";
      const moveShown = view.numericDrafts?.[moveKey]?.value ?? "";
      const purchasePrice = market.purchasePricesVoucherPerUnit?.[itemId] ?? 0;
      const purchaseIndex = market.purchasePriceIndex?.[itemId] ?? 1;
      const feedbackText = purchaseIndex >= 0.999 ? "库存低位，收购价满额" : `库存偏高，收购价按反馈系数 ${number(purchaseIndex, 2)} 打折`;
      // 批发市场趋势（0.1.11 补回）：可售天数、7日均售、双走势线
      const trend = trends[itemId] || {};
      const stockDaysText = trend.stockDays == null ? "近7日无销量" : `约可售${number(trend.stockDays, 1)}天`;
      const trendSpark = (values, label) => {
        const vals = (values || []).filter(v => Number.isFinite(v));
        if (vals.length < 2) return "";
        const min = Math.min(...vals), max = Math.max(...vals);
        if (max === min) return "";
        const w = 100, h = 28;
        const pts = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - (v - min) / (max - min) * (h - 4) - 2).toFixed(1)}`).join(" ");
        return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="${escapeHtml(label)}走势"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
      };
      return `<div class="cardlet"><div class="row"><span class="label">${escapeHtml(name)}库存</span><strong class="value">${number(market.inventory?.[itemId] || 0, 2)}${escapeHtml(itemUnit)} · ${escapeHtml(stockDaysText)}</strong></div>
        <div class="row"><span class="label">7日均售 / 镇库存</span><strong class="value">${number(trend.avgSoldJin || 0, 2)} / ${number(trend.townStockJin || 0, 2)}${escapeHtml(itemUnit)}</strong></div>
        <div class="trend-pair">${trendSpark(trend.inventory, "库存")}${trendSpark(trend.price, "批发价")}</div>
        <div class="row"><span class="label">收购价（向公司/民营）</span><div class="setting-input">${renderNumericInput(view, { key: `wholesale-buy:${itemId}`, kind: "wholesale-purchase-price", target: itemId, value: market.purchasePriceReferenceVoucherPerUnit?.[itemId] ?? purchasePrice, label: `${name}收购价基准`, minimum: 0.001, maximum: 1000000, positive: true, className: "setting-editor" })}<b>${escapeHtml(unit)}/${escapeHtml(itemUnit)}</b></div></div>
        <div class="row"><span class="label">当前实际收购价</span><strong class="value">${number(purchasePrice, 3)} <span class="subtle">${escapeHtml(feedbackText)}</span></strong></div>
        <div class="row"><span class="label">售价（卖给综合商店）</span><div class="setting-input">${renderNumericInput(view, { key: `wholesale-price:${itemId}`, kind: "wholesale-price", target: itemId, value: market.pricesVoucherPerUnit?.[itemId] ?? 1, label: `${name}售价`, minimum: 0.001, maximum: 1000000, positive: true, className: "setting-editor" })}<b>${escapeHtml(unit)}/${escapeHtml(itemUnit)}</b></div></div>
        ${autoPriceRow}
        <div class="row"><span class="label">镇库每日固定调拨</span><div class="setting-input">${renderNumericInput(view, { key: `wholesale-allocation:${itemId}`, kind: "wholesale-allocation", target: itemId, value: market.dailyTownAllocation?.[itemId] || 0, label: `${name}每日调拨量`, minimum: 0, maximum: 1000000000, className: "setting-editor" })}<b>${escapeHtml(itemUnit)}/日</b></div></div>
        <div class="business-form-row"><label>单次调运<input type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" spellcheck="false" value="${escapeHtml(moveShown)}" aria-label="${escapeHtml(name)}单次调运量" data-draft-key="${escapeHtml(moveKey)}" data-draft-kind="stage" data-draft-label="${escapeHtml(name)}单次调运量" data-draft-minimum="0" data-draft-maximum="1000000000" data-draft-integer="false" data-draft-positive="true"></label><div class="settings-actions"><button class="secondary" data-wholesale-stockpile="${escapeHtml(itemId)}">收储入镇库</button><button class="secondary" data-wholesale-release="${escapeHtml(itemId)}">镇库投放</button></div></div></div>`;
    }).join("");
    const marketRows = marketRowsAll;
    const cumulative = (market.cashflow || {}).cumulative || {};
    const cashCard = `<div class="cardlet"><div class="row"><span class="label">累计销售 / 累计收购</span><strong class="value">${number(cumulative.salesVoucherUnits || 0, 0)} / ${number(cumulative.purchaseVoucherUnits || 0, 0)}${escapeHtml(unit)}</strong></div>
      <div class="subtle">收付款都走镇库；库存越多收购价自动越低。</div></div>`;
    body = `<div class="status-strip"><span class="status-light working"></span><strong>镇营批发市场 · 做市商</strong><span>${number(building.level)}级</span></div><div class="subtle">各方产品汇入这里，商店和生产者从这里进货；小麦由镇库直管。</div>${buildingStaffingMarkup(view, building)}${cashCard}${marketRows}${developmentMarkup(view, building, development)}`;
  } else if (building?.typeId === "commercial_street" || building?.typeId === "trade_center") {
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    const isTradeCenter = building.typeId === "trade_center";
    const tradeHouses = view.tradeHouses?.houses || [];
    const shops = (view.shops || []).filter(shop => shop.buildingId === building.id && shop.status !== "closed");
    const occupied = shops.filter(shop => shop.occupiesStreet);
    const capacity = building.level * 2;
    const merchantCount = shops.reduce((sum, shop) => sum + (shop.merchants || 0), 0);
    const clerkCount = shops.reduce((sum, shop) => sum + shop.clerks, 0);
    const shopCards = shops.map(shop => {
      if (shop.kind === "trade") return tradeShopCard(view, shop, tradeHouses.find(row => row.id === shop.id) || null, unit);
      const staff = (shop.merchants || 0) + shop.clerks;
      const staffControls = shop.status === "open"
        ? `<div class="site-worker-actions"><button class="step-btn" data-shop-merchant="${escapeHtml(shop.id)}" data-step="-1" ${shop.merchants <= 1 ? "disabled" : ""}>−</button><strong>商人 ${number(shop.merchants)} / ${number(shop.maxMerchants || 4)}</strong><button class="step-btn" data-shop-merchant="${escapeHtml(shop.id)}" data-step="1" ${shop.merchants >= (shop.maxMerchants || 4) || view.labor.idle <= 0 ? "disabled" : ""}>＋</button></div>
          <div class="row"><span class="label">店员（自动增减）</span><strong class="value">${number(shop.clerks)} / ${number(shop.maxClerks || 20)}人${shop.staffingDiagnosis ? ` · ${escapeHtml(shop.staffingDiagnosis)}` : ""}</strong></div>`
        : "";
      const action = shop.status === "liquidating"
        ? `<button class="secondary" data-shop-fund="${escapeHtml(shop.id)}">业主补资清偿</button>`
        : `<button class="secondary" data-shop-close="${escapeHtml(shop.id)}">停业</button>`;
      const activity = shop.kind === "service"
        ? `${shop.serviceId === "theater" ? `<div class="subtle">仅宽裕人家（宽裕度≥${escapeHtml(CONTENT.rules.serviceTypes?.theater?.minAffluence ?? 1.5)}）光顾</div>` : ""}<div class="row"><span class="label">在岗 / 服务能力</span><strong class="value">${number(staff)}人 / ${number(shop.serviceCapacity)}次/日</strong></div><div class="row"><span class="label">近期需求 / 成交 / 满足率</span><strong class="value">${number(shop.recentDemandUses, 2)} / ${number(shop.recentServedUses, 2)} / ${shop.serviceFulfillmentRate === null ? "—" : number(shop.serviceFulfillmentRate * 100, 1) + "%"}</strong></div>`
        : `<div class="row"><span class="label">在岗 / 接待能力</span><strong class="value">${number(staff)}人 / ${number(shop.customerCapacity || 0)}客流/日</strong></div><div class="row"><span class="label">近期顾客 / 日均销量</span><strong class="value">${number(shop.recentCustomers, 2)} / ${number(shop.averageDailySales, 2)}斤</strong></div>`;
      const stock = shop.kind === "retail" ? `<div class="shop-stock-grid">${(shop.inventoryRows || []).map(row => `<div class="row"><span class="label">${escapeHtml(row.itemName)}</span><strong class="value">库存${number(row.stock, 2)}${escapeHtml(view.itemUnits[row.itemId] || "单位")} · 售${number(row.retailVoucher, 2)}${escapeHtml(unit)}</strong></div>`).join("")}</div>` : "";
      const servicePriceControl = shop.serviceId === "school" ? `<div class="row"><span class="label">每日学费</span><div class="setting-input">${renderNumericInput(view, { key: "service-price:school", kind: "service-price", target: "school", value: view.servicePricesVoucherPerUse?.school ?? 1, label: "学堂每日学费", minimum: 0, maximum: 1000000, className: "setting-editor" })}<b>${escapeHtml(unit)}/儿童日</b></div></div>` : "";
      const serviceRule = shop.serviceId === "school" ? `<div class="subtle">每间学堂最多100名儿童；每50名儿童需要1名工作人员承载。</div>` : shop.serviceId === "restaurant" ? `<div class="subtle">每餐4${escapeHtml(unit)}，消耗2斤小麦；成功用餐可抵1人当日口粮需求，日需求约为人口20%。</div>` : "";
      const serviceDetail = shop.kind === "service" ? `<div class="row"><span class="label">服务类型</span><strong class="value">${escapeHtml(shop.serviceName || shop.typeName)}</strong></div>${servicePriceControl}${serviceRule}` : "";
      const pricingDetail = shop.pricing?.dynamic ? `<details class="detail-block" data-detail-key="shop-pricing:${escapeHtml(shop.id)}"><summary>动态加价（目标利润率定价）</summary><div class="detail-body">${renderShopPricing(view, shop)}</div></details>` : "";
      return `<div class="cardlet"><div class="row"><strong>${escapeHtml(shop.name)} · ${escapeHtml(shop.typeName)}</strong><span class="badge">${escapeHtml(shop.statusReason)}</span></div><div class="row"><span class="label">今日利润</span><strong class="value">${number(shop.profitDayVoucher, 2)}${escapeHtml(unit)}</strong></div>${activity}${staffControls}<details class="detail-block" data-detail-key="shop:${escapeHtml(shop.id)}"><summary>经营详情</summary><div class="detail-body"><div class="row"><span class="label">业主</span><strong class="value">${escapeHtml(shop.ownerName || shop.ownerHouseholdId)}</strong></div><div class="row"><span class="label">店员日薪</span><strong class="value">${number(shop.clerkWageVoucher, 1)}${escapeHtml(unit)}${shop.wageTarget != null ? ` · 行情${number(shop.wageTarget, 1)}` : ""}${shop.wageDiagnosis ? ` · ${escapeHtml(shop.wageDiagnosis)}` : ""}</strong></div>${stock}${serviceDetail}${shop.kind === "service" ? `<div class="row"><span class="label">未成交：没钱 / 容量不足</span><strong class="value">${number(shop.recentUnaffordableUses, 2)} / ${number(shop.recentCapacityUnmetUses, 2)}次</strong></div><div class="row"><span class="label">增1店员能力</span><strong class="value">+${number(shop.nextClerkServiceCapacity)}次/日</strong></div>` : ""}<div class="row"><span class="label">可支付资金</span><strong class="value">${number(shop.cashVoucher, 2)}粮券 · ${number(shop.cashWheatJin || 0, 2)}斤小麦</strong></div><div class="row"><span class="label">今日收入 / 成本</span><strong class="value">${number(shop.revenueDayVoucher, 2)} / ${number(shop.cogsDayVoucher + shop.wageDayVoucher + shop.rentDayVoucher, 2)}${escapeHtml(unit)}</strong></div><div class="row"><span class="label">欠薪 / 欠租 / 欠税</span><strong class="value">${number(shop.wageArrearsVoucher, 2)} / ${number(shop.rentArrearsVoucher, 2)} / ${number(shop.taxArrearsVoucher, 2)}${escapeHtml(unit)}</strong></div>${action}</div></details>${pricingDetail}</div>`;
    }).join("");
    const openButtons = occupied.length < capacity ? (isTradeCenter ? `<div class="site-actions"><button class="secondary" data-shop-open="trading_house" data-shop-building="${escapeHtml(building.id)}">开贸易行</button></div>` : `<div class="site-actions">${COMMERCIAL_STREET_SHOP_TYPES.map(def => `<button class="secondary" data-shop-open="${escapeHtml(def.id)}" data-shop-building="${escapeHtml(building.id)}">开${escapeHtml(def.name)}</button>`).join("")}</div>`) : "";
    body = `<div class="status-strip"><span class="status-light working"></span><strong>${isTradeCenter ? "贸易中心" : "商业街"}</strong><span>${number(building.level)}级</span></div><div class="row"><span class="label">占用店铺</span><strong class="value">${number(occupied.length)} / ${number(capacity)}间</strong></div><div class="row"><span class="label">商人 / 店员</span><strong class="value">${number(merchantCount)} / ${number(clerkCount)}人</strong></div>${openButtons}${shopCards || `<div class="subtle">暂无居民入驻。</div>`}${developmentMarkup(view, building, development)}`;
    actions = `<button class="secondary" data-go="policy">查看租税政策</button>`;
  } else if (building?.typeId === "livestock_base") {
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    body = livestockBaseMarkup(view, building, development);
  } else if (building?.typeId === "times_square") {
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    body = timesSquareMarkup(view, building, development);
  } else if (building?.typeId === "public_housing") {
    const home = building.housing;
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    body = `<div class="status-strip"><span class="status-light working"></span><strong>已落成</strong><span>${number(building.level)}级</span></div><div class="row"><span class="label">入住 / 容量 / 空位</span><strong class="value">${number(home?.occupied || 0)} / ${number(home?.capacity || 1000)} / ${number(home?.vacancies || 0)}人</strong></div><div class="row"><span class="label">租金已收 / 减免</span><strong class="value">${number(view.housing.lastRentDay?.collectedWheatJin || 0)} / ${number(view.housing.lastRentDay?.waivedWheatJin || 0)}${escapeHtml(unit)}</strong></div>${buildingStaffingMarkup(view, building)}${developmentMarkup(view, building, development)}`;
    actions = `<button class="secondary" data-go="residents">查看镇民</button>`;
  } else if (building?.typeId === "villa_complex") {
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    const perLevel = CONTENT.buildings.villa_complex.villaCapacity;
    body = `<div class="status-strip"><span class="status-light working"></span><strong>已落成</strong><span>${number(building.level)}级</span></div><div class="row"><span class="label">别墅栋数（本座）</span><strong class="value">${number(villaCapacityOf(building, CONTENT))}栋（每级${number(perLevel)}栋）</strong></div><div class="subtle">购房与房产税在政策页统一结算。</div>${developmentMarkup(view, building, development)}`;
  } else if (building) {
    title = `${building.name} · ${humanizePlotLabel(view, building)}`;
    const payroll = view.payroll?.lastDay?.workers?.find(row => row.buildingId === building.id);
    const jobs = building.jobs.map(job => ({ ...job, key: `${building.id}::${job.id}` }));
    const privateJobs = building.privateJobs.map(job => ({ ...job, key: `${building.id}::${job.id}::private` }));
    const staff = jobs.reduce((sum, job) => sum + job.workers, 0);
    const dailyCost = jobs.reduce((sum, job) => sum + job.workers * job.effectiveWagePerWorkerDay, 0);
    const publicService = jobs.find(job => job.globalDemandKind === "public_service");
    const wageUnpaid = payroll?.unpaidCurrentWheatJin || 0;
    const jobMarkup = jobs.map(job => workerControl(view, job, view.labor.idle)).join("");
    const output = jobs.map(job => job.outputToday).find(row => row && Object.keys(row).length) || {};
    const wage = jobs[0];
    // 整栋只有一个主人（docs/OWNERSHIP.md）：只有镇营才有镇里排班、镇营工资与镇库产量；
    // 民营/公司的用工由业主自动决定，地方详情只读展示业主状态。
    const townOwned = (building.ownership.townLevels || 0) > 0;
    // 公司名称从上市视图读取（site 面板的 dashboard 都带 ipo，局部视图与全量视图一致）。
    const companyRow = building.companyId ? (view.ipo?.buildings || []).find(row => row.buildingId === building.id) || null : null;
    const ownerExtras = view.ownershipExtras?.[building.id] || null;
    const ownerText = townOwned ? "镇里"
      : building.ownership.privateLevels > 0 ? (ownerExtras?.ownerName || "业主")
      : companyRow ? companyRow.ownerName : "公司";
    const listedWorkers = (building.listedJobs || []).reduce((sum, row) => sum + row.workers, 0);
    const listedCapacity = (building.listedJobs || []).reduce((sum, row) => sum + row.capacity, 0);
    const companySection = building.ownership.listedLevels > 0
      ? `<h3>公司 · ${number(building.ownership.listedLevels)}级</h3><div class="row"><span class="label">状态 / 用工</span><strong class="value">${number(listedWorkers)}/${number(listedCapacity)}人</strong></div><div class="subtle">公司由业主自主经营；工资、产品价与股票在经营与粮账面板管理。</div>`
      : "";
    // 人均产出：等级加成 × 熟练度加成，只对产业建筑显示。
    const productivityRow = building.productivityFactor == null ? "" : `<div class="row"><span class="label">人均产出</span><strong class="value">×${number(building.productivityFactor, 2)}（等级 +${numberMax(building.levelBonusPercent, 0)}% · 熟练 +${numberMax(building.experienceBonusPercent, 1)}%）</strong></div>`;
    const privateOutputText = building.privateOutputToday.map(row => `${escapeHtml(view.itemNames[row.itemId] || row.itemId)} ${number(row.residentUnits / view.inventoryUnitsPerJin)}${escapeHtml(view.itemUnits[row.itemId] || "单位")}`).join(" · ") || "暂无产出";
    // 民营原料从批发市场采购：展示采购价/市场存货（原料）与预期售价（产品），不再展示易误解的"居民/镇库"全局库存。
    const privateMarketRows = building.privateMarket || [];
    const privateMarketText = privateMarketRows.map(row => {
      const name = escapeHtml(view.itemNames[row.itemId] || row.itemId);
      const itemUnit = escapeHtml(view.itemUnits[row.itemId] || "斤");
      if (row.kind === "input") return `${name} 采购${number(row.priceVoucherPerJin, 2)}${escapeHtml(unit)}/${itemUnit} · 市场有货${number(row.marketStockJin, 0)}${itemUnit}`;
      return `${name} 预期${number(row.priceVoucherPerJin, 2)}${escapeHtml(unit)}/${itemUnit}`;
    }).join(" · ") || "未建批发市场";
    // 民营/公司的业主与欠薪（欠薪超过宽限天数由镇里整栋收回）；待批上市申请在企业面板处理。
    const extras = view.ownershipExtras?.[building.id] || null;
    const takeoverDays = CONTENT.rules.ownershipTakeoverArrearsDays ?? 30;
    const ipoApplication = (view.ipo?.applications || []).find(row => row.buildingId === building.id) || null;
    const privateOwnerMarkup = `${extras ? `<div class="row"><span class="label">业主</span><strong class="value">${escapeHtml(extras.ownerName)}</strong></div>` : ""}${extras?.arrears ? `<div class="shortage-banner visible">欠薪${number(extras.arrearsVoucher, 2)}${escapeHtml(unit)}，已欠${number(extras.arrearsDays)}天；欠薪超过${number(takeoverDays)}天将被镇里收回</div>` : ""}${ipoApplication ? `<div class="subtle">业主已递交上市申请，待镇长在企业面板批准。</div>` : ""}`;
    const privateSection = building.ownership.privateLevels > 0
      ? `<h3>民营 · ${number(building.ownership.privateLevels)}级${extras?.arrears ? ` <span class="badge red">欠薪</span>` : ""}</h3>${privateOwnerMarkup}<div class="row"><span class="label">状态 / 用工</span><strong class="value">${escapeHtml(building.privateReason || privateStatusLabel(building.privateStatus))} · ${number(privateJobs.reduce((sum, row) => sum + row.workers, 0))}/${number(privateJobs.reduce((sum, row) => sum + row.capacity, 0))}人</strong></div>${privateJobs.map(job => `<div class="row"><span class="label">${escapeHtml(job.name)}</span><strong class="value">日薪 ${number(job.effectiveWagePerWorkerDay, 2)}${escapeHtml(unit)}${job.wageDiagnosis ? ` · ${escapeHtml(job.wageDiagnosis)}` : ""}</strong></div>`).join("")}<div class="row"><span class="label">今日产出</span><strong class="value">${privateOutputText}</strong></div><details class="detail-block" data-detail-key="private-stock:${escapeHtml(building.id)}"><summary>原料与预期价格</summary><div class="detail-body"><div class="row"><span class="label">批发市场</span><strong class="value">${privateMarketText}</strong></div><div class="subtle">原料从批发市场按采购价购买；产品预期售价为批发市场当前收购价。</div></div></details>` : "";
    const right = building.operatingRight;
    // 民营建筑：镇里按估值收回（整栋回镇营，钱由镇库付给业主）。
    const buybackCard = building.ownership.privateLevels > 0 && right
      ? `<div class="cardlet"><h3>镇里按估值收回</h3><div class="row"><span class="label">整栋估值</span><strong class="value">${number(right.valuationWheatJin, 2)}${escapeHtml(unit)}</strong></div><div class="subtle">镇库按估值付给业主，建筑整栋回镇营；镇库现金不足时不能收回。</div>${right.valuationWheatJin > 0 ? "" : `<div class="shortage-banner visible">整栋暂无正估值，无法收回</div>`}<button class="secondary wide" data-buyback="${escapeHtml(building.id)}" ${right.valuationWheatJin > 0 ? "" : "disabled"}>镇里按估值收回</button></div>`
      : "";
    const townSaleCard = isIndustryType(CONTENT, building.typeId) && building.ownership.townLevels > 0
      ? view.rightSalePreviewId === building.id
        ? `<div class="cardlet"><h3>整栋卖给民营</h3><div class="row"><span class="label">要价 / 估值</span><strong class="value">${number(right.priceWheatJin, 2)} / ${number(right.valuationWheatJin, 2)}${escapeHtml(unit)}</strong></div><div class="row"><span class="label">预计参考收益</span><strong class="value">${number(right.estimatedAnnualReferenceReturn, 2)}${escapeHtml(unit)}${right.typeId === "lumberyard" ? "" : "/年"}</strong></div><div class="row"><span class="label">买家（家底最多且付得起的一户）</span><strong class="value">${right.buyer ? escapeHtml(right.buyer.householdName) : "暂无，家底不足以付整栋价"}</strong></div><div class="row"><span class="label">转入民营</span><strong class="value">${number(right.transferableWorkers)}人</strong></div>${right.reason ? `<div class="shortage-banner visible">${escapeHtml(right.reason)}</div>` : ""}<details class="detail-block" data-detail-key="right-detail:${escapeHtml(building.id)}"><summary>估值详情</summary><div class="detail-body"><div class="row"><span class="label">产品价 / 税率 / 工资</span><strong class="value">${number(right.itemPriceVoucher, 3)}${escapeHtml(unit)}/${escapeHtml(view.itemUnits[right.outputItemId] || "单位")} · ${number(right.taxPercent, 2)}% · ${number(right.wageRateVoucher, 2)}${escapeHtml(unit)}</strong></div><div class="row"><span class="label">需求 / 库存 / 缺口</span><strong class="value">${number(right.dailyDemandJin, 2)} / ${number(right.competitionStockJin, 2)} / ${number(right.unmetDemandJin, 2)}${escapeHtml(view.itemUnits[right.outputItemId] || "单位")}</strong></div><div class="row"><span class="label">预计满产满销人均日利润</span><strong class="value">${number(right.theoreticalFullSaleProfitPerWorkerVoucher, 2)}${escapeHtml(unit)}</strong></div><div class="row"><span class="label">岗位容量</span><strong class="value">镇营${number(right.townCapacityBefore)}→${number(right.townCapacityAfter)}</strong></div>${right.demandBasis ? `<div class="subtle">${escapeHtml(right.demandBasis)}</div>` : ""}<div class="subtle">成交后居民需保留90天基本口粮。</div></div></details><div class="business-sticky-actions"><button class="secondary" data-right-cancel>取消</button><button class="primary" data-right-confirm="${escapeHtml(building.id)}" ${right.available ? "" : "disabled"}>确认成交</button></div></div>`
        : `<div class="cardlet"><h3>整栋卖给民营</h3><div class="row"><span class="label">估值</span><strong class="value">${number(right.valuationWheatJin, 2)}${escapeHtml(unit)}</strong></div><div class="row"><span class="label">要价（默认=估值，可改）</span><strong class="value">${number(right.priceWheatJin, 2)}${escapeHtml(unit)}</strong></div>${renderNumericInput(view, { key: `right-price:${building.id}`, kind: "operating-right-price", target: building.id, value: right.priceWheatJin, label: "整栋要价", minimum: 0.01, maximum: 1000000000, positive: true, className: "setting-editor" })}<button class="secondary wide" data-right-preview="${escapeHtml(building.id)}">预览出售</button></div>`
      : "";
    const saleCard = buybackCard || townSaleCard;
    body = `<div class="status-strip"><span class="status-light ${["ready","limited_materials"].includes(building.status.status) || (["market_capped", "wheat_reserve"].includes(building.status.status) && (building.status.batches || 0) > 0) ? "working" : "idle"}"></span><strong>${escapeHtml(townOwned ? building.status.label : (building.ownership.privateLevels > 0 ? privateStatusLabel(building.privateStatus) : "公司经营"))}</strong><span>${number(building.level)}级</span></div>${!townOwned ? "" : publicService ? `<div class="row"><span class="label">全镇需求 / 在岗 / 缺员</span><strong class="value">${number(publicService.globalDemand)} / ${number(publicService.globalInPost)} / ${number(publicService.globalShortage)}人</strong></div>` : `<div class="row"><span class="label">人数 / 岗位</span><strong class="value">${number(staff)} / ${number(jobs.reduce((sum, job) => sum + job.capacity, 0))}人</strong></div>`}${productivityRow}${townOwned ? `<div class="row"><span class="label">今日产量</span><strong class="value">${outputLines(output, view.itemNames, view.itemUnits, view.inventoryUnitsPerJin)}</strong></div><div class="row"><span class="label">预计每日工资</span><strong class="value">${number(dailyCost)}${escapeHtml(unit)}</strong></div>${wageUnpaid > 0 ? `<div class="shortage-banner visible">新增欠薪 ${number(wageUnpaid)}${escapeHtml(unit)}</div>` : ""}<h3>镇营排班</h3>${jobMarkup}${outputTargetMarkup(view, building)}<div class="site-wage-edit"><span>日薪</span>${renderNumericInput(view, { key: `wage:${wage?.roleId || ""}`, kind: "wage", target: wage?.roleId || "", value: wage?.wagePerWorkerDay || 0, label: `${wage?.name || "作坊工人"}日薪`, minimum: 0, maximum: 100000, confirmLabel: "✓", className: "wage-editor" })}<span>${escapeHtml(unit)}</span></div>` : ""}<details class="detail-block" data-detail-key="ownership:${escapeHtml(building.id)}"><summary>产权详情</summary><div class="detail-body"><div class="row"><span class="label">主人</span><strong class="value">${escapeHtml(ownerText)}</strong></div><div class="row"><span class="label">等级</span><strong class="value">${number(building.level)}级（整栋一个主人）</strong></div></div></details>${privateSection}${companySection}${saleCard}${developmentMarkup(view, building, development)}`;
    actions = `<button class="secondary" data-go="residents">查看全部岗位</button>`;
  } else if (project) {
    title = `施工中 · ${project.name}`;
    const projectKey = `project-workers:${project.instanceId}`;
    body = `<div class="row"><span class="label">进度</span><strong class="value">${number(project.workDone)} / ${number(project.workRequired)}工日</strong></div><div class="meter"><span style="width:${number(project.percent, 1)}%"></span></div><div class="row"><span class="label">投入建筑工</span><strong class="value">${number(project.workers)}人</strong></div><div class="row"><span class="label">预计剩余工期</span><strong class="value">${project.estimatedDays ? `约${number(project.estimatedDays)}天` : "缺建筑工"}</strong></div><div class="row"><span class="label">预计工资</span><strong class="value">约${number(project.estimatedWageJin)}${escapeHtml(unit)}</strong></div><div class="site-worker-control"><span>投入建筑工 · 待业${number(view.labor.idle)}人</span><div class="site-worker-actions"><button class="step-btn" data-project-step="${escapeHtml(project.instanceId)}" data-step="-1" aria-label="减少建筑工" ${project.workers <= 0 ? "disabled" : ""}>−</button>${renderNumericInput(view, { key: projectKey, kind: "project-workers", target: project.instanceId, value: project.workers, label: "投入建筑工人数", integer: true, minimum: 0, maximum: view.labor.idle + project.workers, confirmLabel: "✓", className: "worker-editor site-worker-editor" })}<button class="step-btn" data-project-step="${escapeHtml(project.instanceId)}" data-step="1" aria-label="增加建筑工" ${view.labor.idle <= 0 ? "disabled" : ""}>＋</button></div></div>`;
    actions = `<button class="secondary" data-go="residents">查看全部岗位</button>`;
  } else {
    title = "空地";
    body = `<div class="subtle">尚未建设。</div>`;
    actions = `<button class="secondary" data-go="build">去建设</button>`;
  }
  // mod 给这种建筑追加的卡片（mod.js 的 ui.buildingSections）。
  const modSections = building ? MODS.map(mod => mod.ui?.buildingSections?.[building.typeId]?.(view, building, view.mods?.[mod.id]) || "").join("") : "";
  return `<button class="site-back" data-back>‹ 返回镇图</button><h2>${escapeHtml(title)}</h2><div class="cardlet">${body}${modSections}${actions ? `<div class="site-actions">${actions}</div>` : ""}</div>`;
}

// 贸易行：没有零售货架，改为买卖情况（docs/TRADE.md「贸易中心与贸易行」）；店员与商人仍可手动增减。
function tradeShopCard(view, shop, house, unit) {
  const today = house?.today || { exportTotalJin: 0, importTotalJin: 0, freightVoucher: 0, profitVoucher: 0, usedJin: 0, trades: 0 };
  const week = house?.week || { exportTotalJin: 0, importTotalJin: 0, freightVoucher: 0, profitVoucher: 0 };
  const open = shop.status === "open";
  const statusText = !open ? escapeHtml(shop.statusReason || "未营业") : (today.trades > 0 ? "营业中" : "暂无可做的买卖");
  const staff = (shop.merchants || 0) + shop.clerks;
  const maxClerks = shop.maxClerks || 20;
  const maxMerchants = shop.maxMerchants || 4;
  const staffControls = open
    ? `<div class="site-worker-actions"><button class="step-btn" data-shop-merchant="${escapeHtml(shop.id)}" data-step="-1" ${shop.merchants <= 1 ? "disabled" : ""}>−</button><strong>商人 ${number(shop.merchants)} / ${number(maxMerchants)}</strong><button class="step-btn" data-shop-merchant="${escapeHtml(shop.id)}" data-step="1" ${shop.merchants >= maxMerchants || view.labor.idle <= 0 ? "disabled" : ""}>＋</button></div>
      <div class="site-worker-actions"><button class="step-btn" data-shop-clerk="${escapeHtml(shop.id)}" data-step="-1" ${shop.clerks <= 0 ? "disabled" : ""}>−</button><strong>店员 ${number(shop.clerks)} / ${number(maxClerks)}</strong><button class="step-btn" data-shop-clerk="${escapeHtml(shop.id)}" data-step="1" ${shop.clerks >= maxClerks || view.labor.idle <= 0 ? "disabled" : ""}>＋</button></div>`
    : "";
  const action = shop.status === "liquidating"
    ? `<button class="secondary" data-shop-fund="${escapeHtml(shop.id)}">业主补资清偿</button>`
    : `<button class="secondary" data-shop-close="${escapeHtml(shop.id)}">停业</button>`;
  const money = value => `${number(value, 2)}${escapeHtml(unit)}`;
  return `<div class="cardlet trade-shop"><div class="row"><strong>${escapeHtml(shop.name)} · ${escapeHtml(shop.typeName)}</strong><span class="badge">${statusText}</span></div>
    <div class="row"><span class="label">在岗 / 接待</span><strong class="value">${number(staff)}人 · 店员上限 ${number(maxClerks)}</strong></div>
    <div class="row"><span class="label">今日出口 / 进口</span><strong class="value">${number(today.exportTotalJin, 1)} / ${number(today.importTotalJin, 1)}斤</strong></div>
    <div class="row"><span class="label">近7日出口 / 进口</span><strong class="value">${number(week.exportTotalJin, 1)} / ${number(week.importTotalJin, 1)}斤</strong></div>
    <div class="row"><span class="label">运费 今日 / 近7日</span><strong class="value">${money(today.freightVoucher)} / ${money(week.freightVoucher)}</strong></div>
    <div class="row"><span class="label">利润 今日 / 近7日</span><strong class="value">${money(today.profitVoucher)} / ${money(week.profitVoucher)}</strong></div>
    <div class="row"><span class="label">持有小麦</span><strong class="value">${number(house?.wheatJin || 0, 1)}斤</strong></div>
    ${staffControls}
    <details class="detail-block" data-detail-key="shop:${escapeHtml(shop.id)}"><summary>经营详情</summary><div class="detail-body"><div class="row"><span class="label">业主</span><strong class="value">${escapeHtml(shop.ownerName || shop.ownerHouseholdId)}</strong></div><div class="row"><span class="label">运力份额 今日 / 用量</span><strong class="value">${number(house?.shareJin || 0, 1)} / ${number(today.usedJin, 1)}斤</strong></div><div class="row"><span class="label">今日预算</span><strong class="value">${number(house?.budgetJin || 0, 1)}斤</strong></div>${house?.cashVoucher != null ? `<div class="row"><span class="label">可支付资金</span><strong class="value">${money(house.cashVoucher)}</strong></div>` : ""}<div class="row"><span class="label">欠薪 / 欠租 / 欠税</span><strong class="value">${number(shop.wageArrearsVoucher || 0, 2)} / ${number(shop.rentArrearsVoucher || 0, 2)} / ${number(shop.taxArrearsVoucher || 0, 2)}${escapeHtml(unit)}</strong></div></div></details>
    <div class="site-actions">${action}</div></div>`;
}

// 物流中心 / 码头：本座运力 = 在岗人数 × 每人每日运力（docs/TRADE.md「运力」），计入全镇日运力池。
function freightSiteMarkup(building) {
  const perWorker = building.typeId === "dock" ? CONTENT.rules.dockJinPerWorker : CONTENT.rules.logisticsJinPerWorker;
  const workers = (building.jobs || []).reduce((sum, job) => sum + (job.workers || 0), 0);
  const ready = building.status?.status === "ready";
  return `<div class="status-strip"><span class="status-light ${ready ? "working" : "idle"}"></span><strong>${escapeHtml(building.status?.label || "")}</strong></div>`
    + `<div class="row"><span class="label">本座运力</span><strong class="value">在岗${number(workers)}人 × ${number(perWorker)}斤 = ${number(workers * perWorker)}斤/日</strong></div>`
    + `<div class="subtle">运力计入全镇日运力池，外贸交易与长期协定都从池里扣；没有人在岗就没有运力。</div>`;
}

function developmentMarkup(view, building, development) {
  const unit = moneyUnit(view);
  if (!building || !development) return "";
  const upgrade = development.upgrade || {};
  const demolish = development.demolition || {};
  const activeUpgrade = (view.projects || []).find(row => row.kind === "upgrade" && row.buildingId === building.id) || null;
  const upgradeMaterials = (upgrade.materials || []).map(row =>
    `${escapeHtml(row.name)} ${number(row.required)}${escapeHtml(row.unit)}${row.missing ? `（还缺${number(row.missing)}）` : ""}`
  ).join(" · ") || "无需材料";
  const upgradeCard = activeUpgrade
    ? `<div class="cardlet"><div class="setting-title">升级施工中 · ${number(activeUpgrade.workDone)} / ${number(activeUpgrade.workRequired)}工日</div><div class="meter"><span style="width:${number(activeUpgrade.percent, 1)}%"></span></div><div class="subtle">投入建筑工${number(activeUpgrade.workers)}人 · ${activeUpgrade.estimatedDays ? `预计${number(activeUpgrade.estimatedDays)}天` : "缺建筑工"}</div></div>`
    : (building.ownership?.privateLevels || 0) > 0 || (building.ownership?.listedLevels || 0) > 0
    ? `<div class="subtle">业主自主升级（每30天评估）</div>`
    : view.upgradePreviewId === building.id
    ? `<div class="cardlet"><div class="setting-title">升级至${number(upgrade.nextLevel)}级</div><div class="row"><span class="label">预计工期 / 工资</span><strong class="value">${upgrade.waitingForWorkers ? `等待用工 / 0${escapeHtml(unit)}` : `约${number(upgrade.estimatedDays)}天 / ${number(upgrade.estimatedWageJin)}${escapeHtml(unit)}`}</strong></div><div class="subtle">材料：${upgradeMaterials}。升级期间原建筑继续生产。</div>${!upgrade.materialsAffordable ? `<div class="shortage-banner visible">材料不足</div>` : ""}<div class="settings-actions"><button class="primary" data-upgrade-start="${escapeHtml(building.id)}" ${upgrade.available && upgrade.materialsAffordable ? "" : "disabled"}>确认开工</button><button class="secondary" data-upgrade-cancel>取消</button></div></div>`
    : `<button class="primary" data-upgrade-preview="${escapeHtml(building.id)}" ${upgrade.available ? "" : "disabled"}>${upgrade.available ? `升级至${number(upgrade.nextLevel)}级` : escapeHtml(upgrade.reason || "不可升级")}</button>`;
  const refundText = (demolish.refund || []).map(row => `${escapeHtml(row.name)} ${number(row.quantity)}${escapeHtml(row.unit)}`).join(" · ") || "无材料返还";
  const demolitionCard = view.demolitionPreviewId === building.id
    ? `<div class="cardlet"><div class="setting-title">拆除确认</div><div class="row"><span class="label">返还材料</span><strong class="value">${refundText}</strong></div><div class="row"><span class="label">释放岗位</span><strong class="value">${number(demolish.workers)}人</strong></div>${demolish.housingShortage ? `<div class="shortage-banner visible">拆除后住房缺口 ${number(demolish.housingShortage)}人</div>` : ""}<div class="settings-actions"><button class="primary danger" data-demolish-confirm="${escapeHtml(building.id)}" ${demolish.available ? "" : "disabled"}>确认拆除</button><button class="secondary" data-demolish-cancel>取消</button></div></div>`
    : demolish.available
      ? `<button class="secondary" data-demolish-preview="${escapeHtml(building.id)}">拆除</button>`
      : `<div class="subtle">暂不能拆除：${escapeHtml(demolish.reason || "当前条件不允许")}</div>`;
  return `<h3>建筑管理</h3>${upgradeCard}<div class="site-actions">${demolitionCard}</div>`;
}

function privateStatusLabel(status) {
  return ({ ready: "经营中", limited_demand: "按需求限产", no_workers: "缺工人", no_demand: "暂无需求", no_materials: "缺原料", reserve_protected: "口粮储备不足" })[status] || "暂无经营";
}
