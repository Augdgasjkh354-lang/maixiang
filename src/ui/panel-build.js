import { buildingSymbol } from "./art.js";
import { escapeHtml, number, percent, moneyUnit } from "./format.js";
import { renderNumericInput } from "./numeric-drafts.js";

// 建筑分类页签（纯展示层状态，刷新页面后回到默认）。
const BUILD_CATEGORIES = [
  { id: "production", name: "生产", types: ["mill", "bakery", "lumberyard", "saltworks"] },
  { id: "commercial", name: "商业", types: ["wholesale_market", "commercial_street", "bank", "stock_exchange", "foreign_trade_house"] },
  { id: "government", name: "政务", types: ["town_hall", "police_station", "diplomacy_house"] },
  { id: "housing", name: "住宅", types: ["public_housing", "villa_complex"] }
];
let activeBuildCategory = "production";
export function setBuildCategory(id) {
  if (BUILD_CATEGORIES.some(category => category.id === id)) activeBuildCategory = id;
}

function materialShortageText(materials) {
  return (materials || []).filter(row => row.missing > 0)
    .map(row => `还缺${number(row.missing)}${escapeHtml(row.name)}`)
    .join("、");
}

// 在建工程列表：每个工程各自显示名称/进度/投入人数/预计工期与工资，可逐个调整人数。
function projectCard(project, view, unit) {
  const key = `project-workers:${project.instanceId}`;
  const percentValue = project.workRequired ? project.workDone / project.workRequired * 100 : 0;
  const kindLabel = project.kind === "upgrade" ? "扩建" : "新建";
  return `<div class="cardlet project-card" data-project-card="${escapeHtml(project.instanceId)}">
    <div class="row"><span class="label">${escapeHtml(project.name)} · ${kindLabel}</span><strong class="value">${percent(percentValue)}</strong></div>
    <div class="meter"><span style="width:${percent(percentValue)}"></span></div>
    <div class="row"><span class="label">投入建筑工</span><strong class="value">${number(project.workers)}人</strong></div>
    <div class="row"><span class="label">预计剩余工期 / 工资</span><strong class="value">${project.estimatedDays ? `约${number(project.estimatedDays)}天 / 约${number(project.estimatedWageJin)}${escapeHtml(unit)}` : "缺建筑工"}</strong></div>
    <div class="site-worker-actions"><button class="step-btn" data-project-step="${escapeHtml(project.instanceId)}" data-step="-1" aria-label="减少${escapeHtml(project.name)}建筑工" ${project.workers <= 0 ? "disabled" : ""}>−</button>${renderNumericInput(view, { key, kind: "project-workers", target: project.instanceId, value: project.workers, label: `${project.name}投入建筑工人数`, integer: true, minimum: 0, maximum: view.labor.idle + project.workers, confirmLabel: "✓", className: "worker-editor site-worker-editor" })}<button class="step-btn" data-project-step="${escapeHtml(project.instanceId)}" data-step="1" aria-label="增加${escapeHtml(project.name)}建筑工" ${view.labor.idle <= 0 ? "disabled" : ""}>＋</button></div>
  </div>`;
}

function materialSummary(option) {
  if (!option.materials?.length) return "无需材料";
  return option.materials.map(row => {
    const purchase = row.marketPurchasable > 0 ? ` · 企业可购${number(row.marketPurchasable)}${escapeHtml(row.unit)}` : "";
    const shortage = row.missing > 0 ? ` · 还缺${number(row.missing)}${escapeHtml(row.unit)}` : "";
    return `${escapeHtml(row.name)} ${number(row.required)}${escapeHtml(row.unit)}（现有${number(row.available)}${purchase}${shortage}）`;
  }).join("<br>");
}

function buildCard(option, selectedBuild, wageRates, unit) {
  const planned = option.project;
  const status = planned
    ? `施工中 ${number(option.pendingCount)}处 · ${percent(planned.workDone / planned.workRequired * 100)}`
    : option.count + option.pendingCount >= option.maxInstances
      ? `${number(option.count)}座 · 已达上限`
      : option.availablePlotCount <= 0
        ? `${number(option.count)}座 · 无可用资源地`
        : `${number(option.count)}座 · 可建`;
  const isSelected = selectedBuild === option.id;
  const jobs = (option.jobs || []).map(job =>
    `${escapeHtml(job.name)} ${number(job.slots)}人 · 日薪${number(wageRates[job.id] ?? job.wagePerWorkerDay ?? 5, 1)}${unit}`
  ).join("<br>");
  const jobsHtml = jobs || "无固定岗位";
  const location = option.requiredPlotFeature
    ? (option.requiredPlotFeature === "salt_mine" ? "盐矿资源点" : "南部森林资源点")
    : "任一空地";
  const shortage = materialShortageText(option.materials);
  const action = planned
    ? `<div class="meter"><span style="width:${percent(planned.workDone / planned.workRequired * 100)}"></span></div><div class="subtle">在建${number(option.pendingCount)}处 · 建筑工${number(planned.workers)}人 · ${planned.estimatedDays ? `预计${number(planned.estimatedDays)}天完工` : "缺建筑工"}</div>`
    : `<button class="${isSelected ? "secondary" : "primary"} wide choose-build" data-build="${escapeHtml(option.id)}" ${option.unavailable ? "disabled" : ""}>${option.count + option.pendingCount >= option.maxInstances ? "已达数量上限" : option.availablePlotCount <= 0 ? "资源地块已占用" : isSelected ? "取消选址" : "选择地块"}</button>`;
  return `<div class="building-option building-compact${isSelected ? " chosen" : ""}">
    <div class="building-compact-head"><svg class="building-symbol" viewBox="0 0 100 110" aria-hidden="true">${buildingSymbol(option.id, "idle")}</svg><div class="building-compact-title"><b>${escapeHtml(option.name)}</b><span class="badge">${status}</span></div></div>
    ${action}
    <details class="detail-block" data-detail-key="build:${escapeHtml(option.id)}"><summary>材料与岗位</summary><div class="detail-body">
      <div class="row"><span class="label">预计工期 / 工资</span><strong class="value">${option.waitingForWorkers ? `等待用工 / 0${unit}` : `约${number(option.constructionCrewDays)}天 / ${number(option.estimatedWageJin)}${unit}`}</strong></div>
      <div class="row"><span class="label">选址</span><strong class="value">${location}</strong></div>
      <div class="row"><span class="label">施工量</span><strong class="value">${number(option.workDays)}工日</strong></div>
      <div class="subtle"><b>材料：</b>${materialSummary(option)}${shortage ? `<br><span class="text-danger">${shortage}</span>` : ""}</div>
      <div class="subtle"><b>岗位：</b><br>${jobsHtml}</div>
    </div></details>
  </div>`;
}

export function renderBuild(view) {
  const unit = moneyUnit(view);
  const selected = view.selectedBuild;
  const preview = selected && view.selectedPlot
    ? view.constructionOptions.find(option => option.id === selected)
    : null;
  if (preview && view.selectedPlot) {
    const materials = preview.materials?.length
      ? preview.materials.map(row => `<div class="build-confirm-material${row.missing > 0 ? " missing" : ""}"><div><strong>${escapeHtml(row.name)}</strong><span>需要${number(row.required)}${escapeHtml(row.unit)} · 现有${number(row.available)}${escapeHtml(row.unit)}${row.marketPurchasable > 0 ? ` · 企业可购${number(row.marketPurchasable)}${escapeHtml(row.unit)}（约${number(row.marketCostVoucher, 2)}${unit}）` : ""}</span></div><b>${row.missing > 0 ? `还缺${number(row.missing)}${escapeHtml(row.unit)}` : "已备齐"}</b></div>`).join("")
      : `<div class="build-confirm-material"><div><strong>材料</strong><span>无需材料</span></div><b>已备齐</b></div>`;
    const shortage = materialShortageText(preview.materials);
    return `<div class="build-confirm-page">
      <h2>${escapeHtml(preview.name)} · 开工确认</h2>
      <div class="cardlet build-confirm-card">
        <div class="row"><span class="label">地块</span><strong class="value">${escapeHtml(view.selectedPlot.label)}</strong></div>
        <div class="row"><span class="label">预计工期</span><strong class="value">${preview.waitingForWorkers ? "等待用工" : `约${number(preview.constructionCrewDays)}天`}</strong></div>
        <div class="row"><span class="label">预计工资</span><strong class="value">${preview.waitingForWorkers ? "等待用工后计算" : `约${number(preview.estimatedWageJin)}${unit}`}</strong></div>
      </div>
      <div class="cardlet build-confirm-card">
        <div class="setting-title">所需材料</div>
        <div class="build-confirm-materials">${materials}</div>
        ${shortage ? `<div class="notice notice-error build-material-shortage">${shortage}</div>` : `<div class="subtle">材料已备齐。</div>`}
      </div>
      <div class="build-confirm-actions" data-build-confirm-actions>
        <button class="secondary" data-cancel-build>重新选址</button>
        <button class="primary" data-start-building ${preview.materialsAffordable ? "" : "disabled"}>确认开工</button>
      </div>
    </div>`;
  }

  const previewCard = selected
    ? `<div class="notice">已选${escapeHtml(view.constructionOptions.find(option => option.id === selected)?.name || "建筑")}，请点地图上的可用地块。</div>`
    : "";
  const existing = view.buildings.map(building => `<button class="secondary" data-open-building="${escapeHtml(building.id)}">${escapeHtml(building.name)} · ${number(building.level || 1)}级</button>`).join("");
  const projectList = (view.projects || []).length
    ? `<div class="cardlet"><div class="setting-title">在建工程 · ${number(view.projects.length)}处</div>${view.projects.map(project => projectCard(project, view, unit)).join("")}</div>`
    : "";
  const activeCategory = BUILD_CATEGORIES.find(category => category.id === activeBuildCategory) || BUILD_CATEGORIES[0];
  const allCategoryTypes = new Set(BUILD_CATEGORIES.flatMap(category => category.types));
  const categoryOptions = view.constructionOptions.filter(option => activeCategory.types.includes(option.id));
  const uncategorized = view.constructionOptions.filter(option => !allCategoryTypes.has(option.id));
  const tabs = `<div class="build-tabs" role="tablist" aria-label="建筑分类">${BUILD_CATEGORIES.map(category =>
    `<button class="build-tab${category.id === activeCategory.id ? " selected" : ""}" role="tab" aria-selected="${category.id === activeCategory.id}" data-build-category="${category.id}">${category.name}</button>`
  ).join("")}</div>`;
  return `    ${existing ? `<div class="cardlet"><div class="setting-title">已有建筑</div><div class="site-actions">${existing}</div></div>` : ""}
    ${projectList}
    ${previewCard}
    ${tabs}
    <div class="build-grid">${categoryOptions.map(option => buildCard(option, selected, view.wageRates, unit)).join("")}</div>
    ${uncategorized.length ? `<div class="build-grid">${uncategorized.map(option => buildCard(option, selected, view.wageRates, unit)).join("")}</div>` : ""}
    <details class="detail-block" data-detail-key="production-recipes"><summary>生产方式</summary><div class="detail-body"><div class="subtle">磨坊：100斤小麦→80斤面粉。面包房：100斤面粉→120斤面包。</div></div></details>`;
}
