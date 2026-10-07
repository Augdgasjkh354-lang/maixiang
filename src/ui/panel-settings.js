import { escapeHtml } from "./format.js";
import { APP_VERSION, BUILD_ID } from "../content/version.js";

function savedTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";
}

function bytes(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function slotCard(slot) {
  const id = escapeHtml(slot.id);
  return `<div class="save-slot${slot.current ? " is-current" : ""}">
    <div class="save-slot-heading"><strong>${escapeHtml(slot.name)}</strong>${slot.current ? `<span class="current-badge">正在游玩</span>` : ""}</div>
    <p class="subtle">${slot.damaged ? "数据无法读取" : `第${slot.year}年 · 第${slot.day}天　人口 ${slot.population?.toLocaleString("zh-CN") ?? "—"}`}<br>保存于 <time data-slot-time="${id}">${savedTime(slot.savedAt)}</time>${slot.recovered ? " · 已从备份读取" : ""}</p>
    <div class="save-slot-actions">
      <button class="secondary" data-load-slot="${id}" ${slot.current || slot.damaged ? "disabled" : ""}>读取</button>
      <button class="secondary" data-export-slot="${id}" ${slot.damaged ? "disabled" : ""}>导出</button>
      <details data-detail-key="rename-${id}" class="rename-detail"><summary>重命名</summary>
        <div class="save-input-row"><input data-rename-input="${id}" maxlength="36" aria-label="新存档名称" value="${escapeHtml(slot.name)}"><button class="secondary" data-rename-slot="${id}">确定</button></div>
      </details>
    </div>
    <div class="save-danger-row"><button class="danger-button" data-delete-slot="${id}">删除此存档</button></div>
  </div>`;
}

function diagnosticsMarkup(issue, stats) {
  if (!issue && !stats) return "";
  const idb = issue?.storageUsage?.indexedDB || stats?.indexedDB;
  const rows = [];
  if (issue?.step) rows.push(`失败步骤：${escapeHtml(issue.step)}`);
  if (Number.isFinite(issue?.pendingBytes)) rows.push(`待写入：${bytes(issue.pendingBytes)}`);
  if (idb) rows.push(`IndexedDB：主档 ${bytes(idb.primaryBytes)}；轮换备份 ${bytes(idb.backupBytes)}；合计 ${bytes(idb.totalBytes)}`);
  if (issue?.originalName) rows.push(`原始异常：${escapeHtml(issue.originalName)}${issue.originalMessage ? `：${escapeHtml(issue.originalMessage)}` : ""}`);
  return rows.length ? `<details class="cardlet" data-detail-key="storage-diagnostics"><summary>${issue ? "存储故障详情" : "存储详情"}</summary><p class="subtle">${rows.join("<br>")}</p><p class="subtle">这里只记录步骤与字节占用，不显示存档正文。</p></details>` : "";
}

function recoveryMarkup(view, ui) {
  const issue = ui.persistenceIssue;
  if (!issue && !ui.transientMode && !ui.persistenceBusy) return "";
  const reason = ui.persistenceBusy ? "正在验证 IndexedDB 持久存储的写入、读回与删除。" : (issue?.message || "当前为临时游玩。");
  return `<div class="cardlet save-recovery">
    <div class="setting-title">存储恢复</div>
    <p class="subtle">${escapeHtml(reason)}</p>
    ${ui.transientMode ? `<p class="subtle">当前进度只存在于本页内存中，刷新或关闭页面后不会保留。</p>` : ""}
    <div class="settings-actions">
      <button class="secondary" data-retry-storage ${ui.persistenceBusy ? "disabled" : ""}>真实写入探测</button>
      ${view ? `<button class="secondary" data-export-current>导出当前进度</button>` : ""}
      ${ui.transientMode && view ? `<button class="primary" data-persist-temporary ${ui.persistenceBusy ? "disabled" : ""}>保存到本机</button>` : ""}
      ${!view ? `<button class="primary" data-start-temporary>临时游玩</button>` : ""}
    </div>
  </div>`;
}

function buildIdentityMarkup(ui) {
  return `<div class="cardlet build-identity"><div class="setting-title">当前运行版本</div><p class="subtle">麦乡 ${escapeHtml(ui.appVersion || APP_VERSION)} · 构建 ${escapeHtml(ui.buildId || BUILD_ID)}<br>页面：${escapeHtml(ui.pageAddress || "未知")}</p></div>`;
}

export function renderSettings(view, error = null, ui = {}) {
  const slots = ui.slots || [];
  const managing = ui.managerOpen || !view;
  const status = ui.saveStatus || "尚未保存";
  const pending = ui.pending;
  const confirmation = pending ? `<div class="save-confirm" role="group" aria-label="确认操作"><strong>${escapeHtml(pending.title)}</strong>
    <p>${escapeHtml(pending.message)}</p><div class="settings-actions"><button class="primary" data-confirm-save-action>确认</button><button class="secondary" data-cancel-save-action>取消</button></div></div>` : "";
  const visibleError = error || ui.warning;
  return `<h2>${managing ? (view ? "存档管理" : "选择存档") : "设置"}</h2>
    ${visibleError ? `<div class="notice notice-error" role="alert">${escapeHtml(visibleError)}</div>` : ""}
    ${confirmation}
    ${recoveryMarkup(view, ui)}
    ${diagnosticsMarkup(ui.persistenceIssue, ui.storageStats)}
    ${managing ? `<div class="save-manager">
      <p class="subtle" id="saveStatus" role="status">${escapeHtml(status)}</p>
      ${view ? `<div class="settings-actions">${ui.transientMode ? `<button class="primary" data-persist-temporary ${ui.persistenceBusy ? "disabled" : ""}>保存到本机</button>` : `<button class="primary" data-save-current ${ui.persistenceBusy ? "disabled" : ""}>保存当前进度</button>`}<button class="secondary" data-export-current>导出当前进度</button><button class="secondary" data-close-save-manager>返回设置</button></div>
        ${ui.transientMode ? "" : `<div class="save-input-row"><input id="saveAsName" maxlength="36" placeholder="新存档名称" aria-label="另存为名称"><button class="secondary" data-save-as ${ui.persistenceBusy ? "disabled" : ""}>另存为新存档</button></div>`}` : ""}
      <div class="settings-actions"><button class="primary" data-new-game ${ui.persistenceBusy ? "disabled" : ""}>新游戏</button><button class="secondary" data-import-save ${ui.persistenceIssue || ui.persistenceBusy ? "disabled" : ""}>导入存档文件</button><input id="saveImportFile" type="file" accept="application/json,.json" hidden></div>
      <h3>IndexedDB 本机存档</h3><div class="save-list">${slots.length ? slots.map(slotCard).join("") : `<p class="subtle">暂无可读取的持久存档。</p>`}</div>
    </div>` : `<div class="cardlet"><div class="setting-title">新游戏</div><p class="subtle">当前进度将保存，新局使用独立存档。</p><button class="primary" data-new-game ${ui.persistenceBusy ? "disabled" : ""}>新游戏</button></div>
      <div class="cardlet"><div class="setting-title">存档管理</div><p class="subtle" id="saveStatus" role="status">${escapeHtml(status)}</p><button class="secondary" data-open-save-manager>打开存档管理</button></div>
      <div class="cardlet"><div class="setting-title">音效</div><button class="secondary" id="soundToggle" aria-pressed="${Boolean(ui.soundMuted)}">${ui.soundMuted ? "开启音效" : "关闭音效"}</button></div>
      <div class="cardlet"><div class="setting-title">自动存档</div><p class="subtle">按游戏时间自动保存当前进度。</p><div class="settings-actions">${[["1", "每月"], ["3", "每3月"], ["6", "每半年"]].map(([value, label]) => `<button class="secondary" data-autosave-months="${value}" ${(view?.policy?.autosaveMonths ?? 1) === Number(value) ? "disabled" : ""}>${label}</button>`).join("")}</div></div>`}
    ${buildIdentityMarkup(ui)}`;
}
