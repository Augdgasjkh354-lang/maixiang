import { escapeHtml } from "./format.js";

// 镇报的报纸式版面（只读，数据来自 selectDashboard 的 gazette）：刊头、头条、分栏。
export function gazetteSheetMarkup(issue) {
  const columns = issue.sections.map(section => `<section class="gazette-col${section.kind ? ` gazette-${section.kind}` : ""}">
      <h3>${escapeHtml(section.title)}</h3>
      ${section.lines.map(line => `<p>${escapeHtml(line)}</p>`).join("")}
    </section>`).join("");
  return `<article class="gazette-sheet" aria-label="麦乡镇报第${issue.year}期">
    <header class="gazette-masthead">
      <span class="gazette-issue">第${issue.year}期 · ${issue.year}年</span>
      <h2>麦乡镇报</h2>
      <p class="gazette-headline">${escapeHtml(issue.headline)}</p>
    </header>
    <div class="gazette-body">${columns}</div>
  </article>`;
}

// 镇报面板：最近各期（新的在前），默认显示最新一期；点期号翻阅。
export function renderGazettePanel(view, selectedYear = null) {
  const archive = view?.gazette?.archive || [];
  if (!archive.length) {
    return `<section class="gazette-empty"><p>镇报还未出版。头一期要等头一年年终才印。</p></section>`;
  }
  const chosen = archive.find(issue => issue.year === selectedYear) || archive[0];
  const tabs = archive.map(issue => `<button type="button" class="gazette-tab${issue === chosen ? " active" : ""}" data-gazette-issue="${issue.year}" aria-pressed="${issue === chosen}">第${issue.year}期</button>`).join("");
  return `<nav class="gazette-archive" aria-label="往期镇报">${tabs}</nav>${gazetteSheetMarkup(chosen)}`;
}
