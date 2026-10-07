/**
 * src/ui/jiangnan-art.js
 * 麦乡 · 江南舆图景观模块（ESM 版本，由朋友的 CJS 模块转换而来）
 *
 * 职责：只负责地图外观——底层纸墨景观、静态站点（民居/古井）符号、舆图小地图。
 * 不涉及任何玩法数值、结算逻辑或存档结构。
 *
 * 导出（函数名与签名保持不变）：
 *   houseArt(type?, scale?)  → 江南风格民居/建筑符号
 *   wellArt()                → 江南风格古井符号
 *   townLandscape()          → 整幅地图底层景观（含树木避让地块逻辑）
 *   miniMap()                → 可点击定位的舆图小地图
 */

import { PLOTS } from "../content/world.js";
import { renderBuildingArt } from "./building-art.js";

// 贯穿全图的河道走势，被底层景观与小地图共用。
const river = 'M35 -80 C115 120 -20 320 12 520 S-50 770 -20 950 S160 1210 90 1450 S40 1710 100 1900';

export function houseArt(type = 'housing', scale = 1) {
  return renderBuildingArt(type, { scale });
}

export function wellArt() {
  return `<g stroke="#777864" stroke-width="1.5"><ellipse cy="24" rx="27" ry="10" fill="#b9bca5" opacity=".4"/><path d="M-18 5v15Q0 32 18 20V5Z" fill="#c9cab8"/><ellipse cy="5" rx="18" ry="10" fill="#8eaaa1"/><ellipse cy="5" rx="12" ry="6" fill="#658982"/><path d="M-22 8v-42m44 42v-42M-22-31h44M0-31v30" fill="none" stroke="#867657" stroke-width="4"/><path d="M-7-2H7L5 9H-5Z" fill="#a99166"/></g>`;
}

function tree(x, y, s = 1, willow = false) {
  return `<g transform="translate(${x} ${y}) scale(${s})" pointer-events="none"><ellipse cy="10" rx="23" ry="7" fill="#777d60" opacity=".08"/><path d="M0 9Q4-13 0-37M2-13l-13-17M2-21l12-19" fill="none" stroke="#8b8a70" stroke-width="2.4"/>${willow ? '<path d="M-22-37Q-11-69 10-49Q30-51 27-26Q21-42 19-6Q12-23 12-40Q5-17 6 0Q-3-15 0-40Q-10-25-11-4Q-17-23-14-35Q-25-10-26-18Z" fill="#9eae87" stroke="#849678" stroke-width=".8"/>' : '<g fill="#a7b597" stroke="#829879" stroke-width=".6"><path d="M-25-33Q-32-50-14-53Q-15-69 1-63Q18-71 23-51Q38-37 19-27Q-1-19-8-30Q-20-21-25-33Z"/><path d="M-13-53Q0-37 14-49M-11-30Q-4-45 0-59" fill="none" opacity=".4"/></g>'}</g>`;
}

let landscape = '';

export function townLandscape() {
  if (landscape) return landscape;
  let greenery = '';
  let seed = 28;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // 树木避让：所有地块（PLOTS）及粮仓/村舍周边、左上角留白区域都不种树，
  // 避免景观遮挡可点击地块。这段逻辑必须保留。
  for (let i = 0; i < 250; i++) {
    let x = random() * 2400, y = random() * 1800;
    if (PLOTS.some(p => Math.hypot(p.x * 12 - x, p.y * 10 - y) < 88) ||
        Math.hypot(x - 550, y - 284) < 140 || Math.hypot(x - 779, y - 349) < 100 ||
        (x < 450 && y < 410)) continue;
    greenery += tree(x, y, .55 + random() * .65, i % 4 === 0);
  }
  const roads = ['M70 405Q280 385 480 405T780 383Q970 420 1170 400L2390 420', 'M480 400Q470 660 480 850L520 1740', 'M768 400Q785 650 768 900L805 1800', 'M1056 400L1060 1720', 'M1250 310L2300 310', 'M1250 540L2300 540', 'M1250 770L2300 770', 'M1250 990L2300 990', 'M200 1310L2330 1310', 'M200 1590L2310 1590', 'M1430 100L1430 1710', 'M1960 100L1960 1710'];
  landscape = `<defs><pattern id="papergrain" width="83" height="71" patternUnits="userSpaceOnUse"><path d="M3 6h2m21 13h1m31 38h2M11 52h1m54-44h1" stroke="#a6aa8b" opacity=".21"/><path d="M12 22l2-4 1 4m40 12 2-4 1 5" stroke="#9bab85" opacity=".22" fill="none"/></pattern><pattern id="seedlings" width="14" height="15" patternUnits="userSpaceOnUse"><path d="M7 13V5M7 10L3 6m4 2 4-6" stroke="#879976" stroke-width="1.5" fill="none"/></pattern></defs>
<rect width="2400" height="1800" fill="#e7e7ce"/><path d="M0 0H2400V160Q1700 280 1150 120T0 140Z" fill="#dbe0c8"/><path d="M900 1100Q1200 830 1600 1090T2400 1010V1800H800Z" fill="#dde2cb" opacity=".55"/>
<rect width="2400" height="1800" fill="url(#papergrain)"/>
<path d="${river}" fill="none" stroke="#c5cbb2" stroke-width="82"/><path d="${river}" fill="none" stroke="#8fb6b0" stroke-width="70"/><path d="${river}" fill="none" stroke="#aac8bd" stroke-width="45" opacity=".6"/><path d="${river}" fill="none" stroke="#d7e4d3" stroke-width="1.5" stroke-dasharray="15 36 28 67"/>
<path d="M130 126L387 94 472 302 187 346Z" fill="#c4cc9a" stroke="#b5b990" stroke-width="6"/><path d="M130 126L387 94 472 302 187 346Z" fill="url(#seedlings)"/><path d="M170 216L430 177" stroke="#e1d7ae" stroke-width="8"/>
<path d="M1680 30L2220 30 2300 192 1720 192Z" fill="#cbd2a7" stroke="#b5b990" stroke-width="5"/><path d="M1680 30L2220 30 2300 192 1720 192Z" fill="url(#seedlings)"/>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">${roads.map(d => `<path d="${d}" stroke="#c9c8ab" stroke-width="29"/><path d="${d}" stroke="#eee4c9" stroke-width="24"/><path d="${d}" stroke="#f5ecd5" stroke-width="13" opacity=".45"/>`).join('')}</g>
<g transform="translate(25 403) rotate(-4)" stroke="#9b9e8a"><path d="M-63-15Q0-38 65-15V17Q0-1-63 17Z" fill="#d7d7be"/><path d="M-63 2Q0-22 65 2M-63-15Q0-38 65-15" fill="none" stroke-width="4"/>${[-60, -40, -20, 0, 20, 40, 60].map(x => `<path d="M${x} -14v-17" stroke-width="4"/>`).join('')}</g>
${greenery}
<g fill="#899275" font-family="serif" font-size="19" letter-spacing="5" opacity=".85"><text x="930" y="160">溪 畔</text><text x="1550" y="650">东 坊</text><text x="600" y="1110">南 林</text><text x="1600" y="1680">远 郊</text></g>`;
  return landscape;
}

export function miniMap() {
  return `<svg id="townMini" viewBox="0 0 2400 1800" aria-label="点击舆图定位地图" role="img"><rect width="2400" height="1800" fill="#e3e5ce"/><path d="${river}" fill="none" stroke="#8eb4ac" stroke-width="135"/><g fill="#a9af91">${PLOTS.map(p => `<rect x="${p.x * 12 - 30}" y="${p.y * 10 - 25}" width="60" height="50" rx="3"/>`).join('')}</g><path d="M480 400H2350M480 400V1700M1060 400V1700M200 1310H2330" stroke="#f8efd7" stroke-width="25" fill="none"/><rect id="miniViewport" x="300" y="100" width="600" height="750" fill="#fff" fill-opacity=".08" stroke="#a35643" stroke-width="20"/></svg>`;
}
