import { escapeHtml, number } from "./format.js";

// 地图经济迷你面板（用户 0.1.11 原 iz/rz/Q4/r5）：摘要显示失业率，
// 展开显示失业率/公职店员均薪/小麦批发价/镇库小麦/居民口粮 + 近N日走势线。
function sparkline(history, key, label, decimals) {
  const values = history.map(row => row[key]).filter(value => Number.isFinite(value));
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return "";
  const width = 120;
  const height = 32;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 0 : index / (values.length - 1) * width;
    const y = height - (value - min) / (max - min) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<figure class="econ-spark"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg><figcaption>${escapeHtml(label)}近${values.length}日走势：${number(values[0], decimals)} → ${number(values[values.length - 1], decimals)}</figcaption></figure>`;
}

function moodNote(mood) {
  if (mood === "slack") return "失业多，商店压工资";
  if (mood === "tight") return "人手紧，高薪岗位会挖人";
  return "行情平稳";
}

export function econMiniSummary() {
  // 并入宏观面板后作为小节标题；失业率已在宏观摘要常显。
  return "劳动力与走势";
}

export function renderEconMini(view) {
  const market = view.laborMarket;
  const economy = view.economy || {};
  const history = economy.history || [];
  if (!market) return "";
  const last = history[history.length - 1] || {};
  const poach = economy.poachYear > 0 && economy.recentPoach?.[0]
    ? `<div class="econ-note">今年跳槽${number(economy.poachYear)}人（最近：${escapeHtml(economy.recentPoach[0].from || "")}→${escapeHtml(economy.recentPoach[0].to || "")}）</div>`
    : "";
  // 失业率、小麦价、镇库小麦已在宏观部分列出，这里只留走势与宏观里没有的项。
  return `<div class="econ-note">${moodNote(market.mood)} · 待业${number(market.idle)}人</div>
    ${sparkline(history, "unemploymentPercent", "失业率%", 1)}
    <div class="econ-row"><span>公职 / 店员均薪</span><strong>${number(market.referenceWage, 1)} / ${last.shopWage == null ? "—" : number(last.shopWage, 1)}</strong></div>
    ${sparkline(history, "shopWage", "店员均薪", 1)}
    ${sparkline(history, "wheatPrice", "小麦价", 2)}
    ${sparkline(history, "townWheatJin", "镇库小麦", 0)}
    <div class="econ-row"><span>居民口粮</span><strong>${last.residentFoodDays == null ? "—" : `${number(last.residentFoodDays, 0)}天`}</strong></div>
    ${poach}`;
}
