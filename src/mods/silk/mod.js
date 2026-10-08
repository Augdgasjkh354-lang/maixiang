// 丝绸 mod · 行为。内容之外只做三件事：只读视图（桑园数、批发库存）、经济卡片与桑园美术。
// 桑园的产出、用工、收付钱货全部由核心系统按 content.js 的定义完成（tier 0 原料产业，无需 tally 步骤）。
import { defineMod } from "../api.js";

const fmtInt = value => Math.floor(Number(value) || 0).toLocaleString("zh-CN");

// ---------------------------------------------------------------- 桑园美术（约 120 宽，底部中心在 0,36）
// 坡地上三四排桑树（树冠圆、树干细），右上角一间小屋；配色取自 ui/building-art.js 的江南 palette。
function mulberryRows(level) {
  const rowCount = level >= 3 ? 4 : 3;
  let out = "";
  for (let r = 0; r < rowCount; r += 1) {
    const yLeft = 30 - r * 11;
    const yRight = 10 - r * 11;
    const at = t => [-46 + 80 * t, yLeft + (yRight - yLeft) * 0.78 * t];
    const [x0, y0] = at(0), [x1, y1] = at(1);
    out += `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)}L${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="#a9a57c" stroke-width="1.1" stroke-dasharray="3 2"/>`;
    for (let k = 0; k < 4; k += 1) {
      const [x, y] = at(0.12 + k * 0.24);
      out += `<path d="M${x.toFixed(1)} ${(y + 1).toFixed(1)}V${(y + 7).toFixed(1)}" stroke="#6b4a36" stroke-width="1.6" stroke-linecap="round"/>`;
      out += `<ellipse cx="${x.toFixed(1)}" cy="${(y - 3).toFixed(1)}" rx="7.5" ry="5.5" fill="#7fa35f" stroke="#4f6e3c"/>`;
      out += `<circle cx="${(x - 2.5).toFixed(1)}" cy="${(y - 4.5).toFixed(1)}" r="1.1" fill="#b9d19a"/><circle cx="${(x + 2.6).toFixed(1)}" cy="${(y - 2.4).toFixed(1)}" r="0.9" fill="#b9d19a"/>`;
    }
  }
  return out;
}

function mulberrySlope() {
  return `<path d="M-62 38L-40-26Q-16-32 10-30L62 0L0 50Z" fill="#cfd0a2" stroke="#8f8a64"/>`
    + `<path d="M-62 38L0 50L62 0" fill="none" stroke="#a7a27a" stroke-width="1.2"/>`;
}

// 小屋：白墙青瓦，门前挂着一只蚕匾（缫丝用的竹匾）。
function mulberryShed(x, y, s) {
  return `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 0L62 22V-8L0-30Z" fill="#f2eee0"/><path d="M62 22L93 3V-27L62-8Z" fill="#d6d3c0"/><path d="M0-30L62-8 77.5-27.5 15.5-49.5Z" fill="#8f9a86"/><path d="M62-8L93-27 77.5-27.5Z" fill="#6e7a6a"/><path d="M18.6 6.6L34.1 12.1V-5.9L18.6-11.4Z" fill="#8c6e4e"/><ellipse cx="-6" cy="-6" rx="7" ry="3.2" fill="#d9c27e" stroke="#9a7f4a" stroke-width=".8"/><path d="M-4 24h70" stroke="#b8ad88" stroke-width="3" fill="none"/></g>`;
}

function mulberryGardenArt({ level = 1 } = {}) {
  return `<g class="silk-mulberry">${mulberrySlope()}${mulberryRows(level)}${mulberryShed(22, 4, 0.5)}`
    + `<path d="M46 12l4 0" stroke="#7b7c66" stroke-width="2"/></g>`;
}

export default defineMod({
  id: "silk",

  // 只读视图：桑园数量（全镇建筑）与镇库、批发市场丝绸库存（斤）。
  select(state, content) {
    const perJin = content.precision.inventoryUnitsPerJin;
    const gardenCount = (state.buildings || []).filter(row => row.typeId === "mulberry_garden").length;
    const silkUnits = (state.accounts?.town?.silk || 0) + (state.wholesaleMarket?.inventory?.silk || 0);
    return {
      gardenCount,
      silkStockJin: silkUnits / perJin
    };
  },

  ui: {
    economySection: {
      title: "丝绸",
      render: (view, mine) => `<div class="cardlet">
        <div class="row"><span class="label">桑园</span><strong class="value">${mine?.gardenCount ?? 0} 座</strong></div>
        <div class="row"><span class="label">镇库与批发市场丝绸库存</span><strong class="value">${fmtInt(mine?.silkStockJin)} 斤</strong></div></div>
        <div class="subtle">桑园种桑缫丝，每人每日产丝绸 10 斤；丝绸是富户的日用品，穷户几乎不买，王镇、民镇也来进口。</div>`
    }
  },

  // 建筑美术：返回 SVG 片段（坐标与 ui/building-art.js 一致，约 120 宽、底部中心在 0,36）。
  art: {
    mulberry_garden: options => mulberryGardenArt(options)
  },

  validate() {
    return [];
  }
});
