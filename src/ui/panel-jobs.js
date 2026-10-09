import { escapeHtml, number, moneyUnit, moneyMixHint } from "./format.js";
import { renderNumericInput } from "./numeric-drafts.js";

// 就业分组（纯展示层，减少长滚动；分组展开状态由 details[data-detail-key] 自动记住）。
const JOB_GROUPS = [
  { id: "industry", name: "镇营产业", match: row => row.scope === "building" && row.globalDemandKind !== "public_service" },
  { id: "public", name: "公共服务", match: row => row.globalDemandKind === "public_service" },
  { id: "farming", name: "务农", match: row => row.roleId === "farmers" },
  { id: "core", name: "营造及其他", match: row => row.scope === "core" && row.roleId !== "farmers" },
  { id: "market", name: "民营与企业", match: row => row.scope === "private" || row.scope === "listed" }
];

function jobRow(view, row, idle) {
  const unit = moneyUnit(view);
  const disabled = row.capacity <= 0;
  const workerKey = `workers:${row.key}`;
  const shownCount = row.roleId === "farmers" ? (row.targetCount ?? row.count) : row.count;
  const workerControl = renderNumericInput(view, {
    key: workerKey,
    kind: "employment",
    target: row.key,
    value: shownCount,
    label: `${row.name}人数`,
    integer: true,
    minimum: 0,
    maximum: row.maxAssignable,
    disabled,
    confirmLabel: "✓",
    className: "worker-editor"
  });
  const wageControl = row.roleId === "farmers"
    ? `<span class="badge">秋收分粮</span>`
    : row.wageKind !== "company-wage"
      ? `<span class="badge">日薪 ${number(row.effectiveWagePerWorkerDay, 2)}${escapeHtml(unit)}</span>`
      : `<div class="wage-setting"><span>薪</span>${renderNumericInput(view, {
        key: row.wageKind === "company-wage" ? `company:${row.wageTarget}:wage` : `wage:${row.roleId}`,
        kind: row.wageKind || "wage",
        target: row.wageTarget || row.roleId,
        value: row.wagePerWorkerDay,
        label: `${row.name}日薪`,
        minimum: 0,
        maximum: 100000,
        disabled: row.wageKind === "company-wage" && !row.wageTarget,
        confirmLabel: "✓",
        className: "wage-editor"
      })}<span>${escapeHtml(unit)}</span></div>`;
  const note = row.roleId === "farmers"
    ? (row.targetShortage > 0 ? `目标${row.targetCount ?? row.count} · 缺${row.targetShortage}` : `目标${row.targetCount ?? row.count}`)
    : row.globalDemandKind === "public_service"
      ? `全镇需${row.globalDemand} · 缺${row.globalShortage}`
      : row.scope === "listed" ? "公司自动用工" : row.scope === "private" ? "民营自动用工" : "";
  return `<div class="job-row">
    <div class="job-row-head"><div class="job-name">${escapeHtml(row.buildingName ? row.buildingName + " · " + row.name : row.name)}</div><span class="badge">${number(row.count)} / ${number(row.capacity)}</span></div>
    ${note ? `<div class="job-note">${escapeHtml(note)}</div>` : ""}
    <div class="job-edit-row"><div class="job-controls"><button class="step-btn" data-job="${escapeHtml(row.key)}" data-step="-1" aria-label="减少${escapeHtml(row.name)}" ${shownCount <= 0 ? "disabled" : ""}>−</button>${workerControl}<button class="step-btn" data-job="${escapeHtml(row.key)}" data-step="1" aria-label="增加${escapeHtml(row.name)}" ${shownCount >= row.maxAssignable || (row.roleId !== "farmers" && (idle + (row.poachable || 0)) <= 0) ? "disabled" : ""}>＋</button></div><div class="job-wage">${wageControl}</div></div>
  </div>`;
}

export function renderJobs(view) {
  const last = view.payroll?.lastDay || {};
  const unit = moneyUnit(view);
  const rows = view.labor.rows.filter(row => row.scope !== "shop");
  const sections = JOB_GROUPS
    .map(group => ({ ...group, rows: rows.filter(group.match) }))
    .filter(section => section.rows.length > 0);
  const rest = rows.filter(row => !JOB_GROUPS.some(group => group.match(row)));
  if (rest.length) sections.push({ id: "other", name: "其他", rows: rest });
  const defaultOpenId = sections.find(section => section.id === "industry")?.id || sections[0]?.id;
  const sectionHtml = sections.map(section => {
    const inPost = section.rows.reduce((sum, row) => sum + (row.count || 0), 0);
    const capacity = section.rows.reduce((sum, row) => sum + (row.capacity || 0), 0);
    return `<details class="detail-block" data-detail-key="jobs:${section.id}"${section.id === defaultOpenId ? " open" : ""}><summary>${escapeHtml(section.name)} · ${number(inPost)} / ${number(capacity)}人</summary><div class="detail-body"><div class="job-list">${section.rows.map(row => jobRow(view, row, view.labor.idle)).join("")}</div></div></details>`;
  }).join("");
  return `<h2>就业</h2>
    <div class="cardlet job-summary"><div class="row"><span class="label">劳动 / 就业 / 待业</span><strong class="value">${number(view.labor.workingAge)} / ${number(view.labor.employed)} / ${number(view.labor.idle)}人</strong></div><div class="row"><span class="label">每日工资</span><strong class="value">约${number(view.labor.dailyWageExpectedWheatJin)}${escapeHtml(unit)}</strong></div>${(last.arrearsBalanceWheatJin || 0) > 0 ? `<div class="shortage-banner visible">欠薪 ${number(last.arrearsBalanceWheatJin)}小麦等值</div>` : ""}</div>
    ${sectionHtml}
    <details class="detail-block" data-detail-key="payroll-detail"><summary>工资账</summary><div class="detail-body">
      <div class="row"><span class="label">今日应付 / 已付</span><strong class="value">${number(last.expectedWheatJin || 0)} / ${number(last.currentPaidWheatJin || 0)}小麦等值</strong></div>
      <div class="row"><span class="label">偿还旧欠薪</span><strong class="value">${number(last.arrearsPaidWheatJin || 0)}小麦等值</strong></div>
      <div class="subtle">${moneyMixHint(view)}。旧欠薪保留形成时的支付构成。</div>
    </div></details>`;
}
