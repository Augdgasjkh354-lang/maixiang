/**
 * src/ui/jiangnan-art.js
 * 麦乡 · 江南舆图景观模块（ESM 版本，由朋友的 CJS 模块转换而来）
 *
 * 职责：只负责地图外观——底层纸墨景观、静态站点（民居/古井）符号、舆图小地图。
 * 不涉及任何玩法数值、结算逻辑或存档结构。
 *
 * 导出（函数名保持不变）：
 *   houseArt(type?, scale?)        → 江南风格民居/建筑符号
 *   wellArt()                      → 江南风格古井符号
 *   townLandscape(occupiedIds?)    → 整幅地图底层景观；道路只随已用地块生长
 *   roadNetwork(plots)             → 隐藏巷道图：由地块生成的支路与巷道路径
 *   miniMap()                      → 可点击定位的舆图小地图
 */

import { PLOTS } from "../content/world.js";
import { renderBuildingArt } from "./building-art.js";

// 贯穿全图的河道走势，被底层景观与小地图共用。
const river = 'M35 -80 C115 120 -20 320 12 520 S-50 770 -20 950 S160 1210 90 1450 S40 1710 100 1900';
// 与上面的 river 路径等价的三次贝塞尔分段（S 指令已展开），用于采样河岸。
const RIVER_SEGMENTS = [
  [[35, -80], [115, 120], [-20, 320], [12, 520]],
  [[12, 520], [44, 720], [-50, 770], [-20, 950]],
  [[-20, 950], [10, 1130], [160, 1210], [90, 1450]],
  [[90, 1450], [20, 1690], [40, 1710], [100, 1900]]
];

// 主路与巷道的几何常量。世界坐标：地块 x*12、y*10。
const ROAD_Y = 400;
const MAIN_ROAD = 'M70 405Q280 385 480 405T780 383Q970 420 1170 400Q1200 398 1218 404';
// 粮仓 / 村舍门前的短径：开局只有这两条和主路。
const HOUSE_PATHS = ['M548 396Q558 350 552 314', 'M786 398Q792 372 782 352'];
// 巷道：每列地块之间的竖向小路，弯度固定（deterministic）。
const WEST_LANE = 190;
const TRUNK_LANES = [336, 480, 768, 1056];
const LANE_XS = [WEST_LANE, ...TRUNK_LANES];
const LANE_BEND = { 190: -8, 336: 7, 480: -9, 768: 8, 1056: -7 };
// 村落区：除两三棵零星树外保持空旷。
const VILLAGE = { x0: 220, x1: 1180, y0: 440, y1: 960 };
// 南林：围绕伐木点与盐矿的密林椭圆。
const FOREST = { cx: 330, cy: 1010, rx: 380, ry: 250 };
// 郊野小林：位置固定。
const COUNTRY_GROVES = [
  [1380, 190, 7], [1930, 470, 8], [2210, 760, 7], [1480, 720, 5], [1880, 1080, 9],
  [2150, 1400, 8], [1430, 1490, 8], [960, 1560, 7], [1250, 1700, 6], [620, 1620, 6]
];
// 郊野小径：从主路东端延伸，以及池塘南侧的一条。
const COUNTRY_PATHS = [
  'M1214 404C1300 430 1330 520 1420 540S1560 470 1640 500S1820 620 1900 580S2150 520 2400 560',
  'M1496 1800C1466 1690 1566 1600 1528 1500S1606 1372 1676 1336'
];

export function houseArt(type = 'housing', scale = 1) {
  return renderBuildingArt(type, { scale });
}

export function wellArt() {
  return `<g stroke="#777864" stroke-width="1.5"><ellipse cy="24" rx="27" ry="10" fill="#b9bca5" opacity=".4"/><path d="M-18 5v15Q0 32 18 20V5Z" fill="#c9cab8"/><ellipse cy="5" rx="18" ry="10" fill="#8eaaa1"/><ellipse cy="5" rx="12" ry="6" fill="#658982"/><path d="M-22 8v-42m44 42v-42M-22-31h44M0-31v30" fill="none" stroke="#867657" stroke-width="4"/><path d="M-7-2H7L5 9H-5Z" fill="#a99166"/></g>`;
}

function tree(x, y, s = 1, willow = false) {
  return `<g transform="translate(${x} ${y}) scale(${s})" pointer-events="none"><ellipse cy="10" rx="23" ry="7" fill="#777d60" opacity=".08"/><path d="M0 9Q4-13 0-37M2-13l-13-17M2-21l12-19" fill="none" stroke="#8b8a70" stroke-width="2.4"/>${willow ? '<path d="M-22-37Q-11-69 10-49Q30-51 27-26Q21-42 19-6Q12-23 12-40Q5-17 6 0Q-3-15 0-40Q-10-25-11-4Q-17-23-14-35Q-25-10-26-18Z" fill="#9eae87" stroke="#849678" stroke-width=".8"/>' : '<g fill="#a7b597" stroke="#829879" stroke-width=".6"><path d="M-25-33Q-32-50-14-53Q-15-69 1-63Q18-71 23-51Q38-37 19-27Q-1-19-8-30Q-20-21-25-33Z"/><path d="M-13-53Q0-37 14-49M-11-30Q-4-45 0-59" fill="none" opacity=".4"/></g>'}</g>`;
}

// 小种子 LCG：每一层各用一个独立种子，互不牵连，结果可复现。
function makeRandom(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function hashId(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function plotWorld(plot) {
  return { x: plot.x * 12, y: plot.y * 10 };
}

// 地块归属的巷道：西侧一条专供村外地块与资源点；其余按最近的竖向巷道。
function laneX(plot) {
  const { x } = plotWorld(plot);
  if (x < 200) return WEST_LANE;
  return TRUNK_LANES.reduce((best, lane) => Math.abs(lane - x) < Math.abs(best - x) ? lane : best, TRUNK_LANES[0]);
}

// 由地块集合生成巷道网络：每个地块一条横向支路，巷道只画到最深的用到地块。
export function roadNetwork(plots) {
  const laneDepth = new Map();
  const spurs = [];
  for (const plot of plots) {
    const { x: px, y: py } = plotWorld(plot);
    const lx = laneX(plot);
    const wobble = (hashId(plot.id) % 9) - 4;
    const ex = px > lx ? px - 48 : px + 48;
    spurs.push(`M${lx} ${py}Q${((lx + ex) / 2).toFixed(1)} ${py + wobble} ${ex} ${py}`);
    laneDepth.set(lx, Math.max(laneDepth.get(lx) ?? 0, py));
  }
  const lanes = [...laneDepth].map(([lx, depth]) =>
    `M${lx} ${ROAD_Y}Q${lx + LANE_BEND[lx]} ${((ROAD_Y + depth) / 2).toFixed(1)} ${lx} ${depth}`);
  return { lanes, spurs };
}

// 河岸采样：用于树木避让与河岸柳树。
const RIVER_POINTS = (() => {
  const pts = [];
  for (const [p0, p1, p2, p3] of RIVER_SEGMENTS) {
    for (let i = 0; i < 30; i++) {
      const t = i / 30, u = 1 - t;
      pts.push({
        x: u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        y: u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
      });
    }
  }
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y, len = Math.hypot(tx, ty) || 1;
    return { x: p.x, y: p.y, nx: -ty / len, ny: tx / len };
  });
})();

function riverDistance(x, y) {
  let best = Infinity;
  for (const p of RIVER_POINTS) best = Math.min(best, Math.hypot(p.x - x, p.y - y));
  return best;
}

// 树木避让：地块、粮仓/村舍/古井、桥、主路与巷道、河道中心线、西北角留白，都不种树。
function treeBlocked(x, y, { willow = false, allowVillage = false } = {}) {
  const inVillage = x >= VILLAGE.x0 && x <= VILLAGE.x1 && y >= VILLAGE.y0 && y <= VILLAGE.y1;
  if (inVillage && !allowVillage) return true;
  if (PLOTS.some(p => Math.hypot(p.x * 12 - x, p.y * 10 - y) < 90)) return true;
  if (Math.hypot(x - 550, y - 284) < 140 || Math.hypot(x - 779, y - 349) < 100 || Math.hypot(x - 502, y - 380) < 80) return true;
  if (Math.hypot(x - 25, y - 403) < 80) return true;
  if (x > 60 && x < 1230 && Math.abs(y - ROAD_Y) < 36) return true;
  if (y > ROAD_Y && y < 980 && LANE_XS.some(lx => Math.abs(lx - x) < 30)) return true;
  if (x > 120 && x < 480 && y > 90 && y < 350) return true;
  if (x < 475 && y < 410 && !willow) return true;
  const d = riverDistance(x, y);
  if (d < (willow ? 52 : 62)) return true;
  if (willow && d > 88) return true;
  return false;
}

function treeLayer() {
  const random = makeRandom(28);
  const parts = [];
  // 河岸柳：沿两岸每隔一段种一排。
  for (let i = 0; i < RIVER_POINTS.length; i += 3) {
    const p = RIVER_POINTS[i];
    for (const side of [-1, 1]) {
      const off = side * (62 + random() * 14);
      const x = p.x + p.nx * off, y = p.y + p.ny * off;
      const s = 0.8 + random() * 0.35;
      if (!treeBlocked(x, y, { willow: true })) parts.push(tree(x.toFixed(1), y.toFixed(1), s.toFixed(2), true));
    }
  }
  // 南林：抖动格点 + 中心密、边缘疏的椭圆分布。
  for (let gy = 740; gy < 1260; gy += 40) {
    for (let gx = -40; gx < 740; gx += 44) {
      const x = gx + (random() - 0.5) * 30, y = gy + (random() - 0.5) * 26;
      const d = Math.hypot((x - FOREST.cx) / FOREST.rx, (y - FOREST.cy) / FOREST.ry);
      const keep = random();
      const scale = 0.72 + random() * 0.5;
      const willowy = random() < 0.12;
      if (d > 1 || keep > (d < 0.78 ? 0.92 : 0.55)) continue;
      if (treeBlocked(x, y)) continue;
      parts.push(tree(x.toFixed(1), y.toFixed(1), scale.toFixed(2), willowy));
    }
  }
  // 郊野小林：每处十来棵，半径内随机落点。
  for (const [gx, gy, n] of COUNTRY_GROVES) {
    for (let k = 0; k < n; k++) {
      const a = random() * Math.PI * 2, r = Math.sqrt(random()) * 70;
      const x = gx + Math.cos(a) * r, y = gy + Math.sin(a) * r * 0.6;
      const s = 0.62 + random() * 0.5;
      if (!treeBlocked(x, y)) parts.push(tree(x.toFixed(1), y.toFixed(1), s.toFixed(2), random() < 0.1));
    }
  }
  // 村落区：至多两棵零星树。
  let singles = 0;
  for (let k = 0; k < 80 && singles < 2; k++) {
    const x = VILLAGE.x0 + random() * (VILLAGE.x1 - VILLAGE.x0);
    const y = VILLAGE.y0 + random() * (VILLAGE.y1 - VILLAGE.y0);
    if (random() < 0.12 && !treeBlocked(x, y, { allowVillage: true })) {
      parts.push(tree(x.toFixed(1), y.toFixed(1), (0.7 + random() * 0.3).toFixed(2)));
      singles++;
    } else random();
  }
  return parts.join("");
}

// 郊野农田：四片田庄。每片是一组同向排列的田块（像真的阡陌），田块之间留出田埂缝，
// 整片轻微旋转；田庄之间是大片草甸。颜色比镇有麦田更淡，作远景。
function patchwork() {
  const random = makeRandom(71);
  const palette = ["#d5dab5", "#cfd5ac", "#dbdbb6", "#d7d3a8"];
  const patches = [
    { x: 1560, y: 620, rows: 3, cols: 3, angle: 6 },
    { x: 2060, y: 860, rows: 2, cols: 3, angle: -9 },
    { x: 1360, y: 1440, rows: 3, cols: 2, angle: 12 },
    { x: 2060, y: 1330, rows: 2, cols: 3, angle: -4 }
  ];
  let out = "";
  for (const patch of patches) {
    const rowHeights = Array.from({ length: patch.rows }, () => 46 + random() * 30);
    const totalH = rowHeights.reduce((sum, h) => sum + h, 0) + 9 * (patch.rows - 1);
    let y = -totalH / 2;
    let fields = "";
    for (const h of rowHeights) {
      const widths = Array.from({ length: patch.cols }, () => 70 + random() * 80);
      const totalW = widths.reduce((sum, w) => sum + w, 0) + 9 * (patch.cols - 1);
      let x = -totalW / 2 + (random() - 0.5) * 30;
      for (const w of widths) {
        if (random() < 0.12) { x += w + 9; continue; } // 偶尔空一块，留作草地
        const fill = palette[Math.floor(random() * palette.length)];
        const rect = `x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3"`;
        fields += `<rect ${rect} fill="${fill}" opacity=".8"/>`;
        if (random() < 0.45) fields += `<rect ${rect} fill="url(#seedlings)" opacity=".3"/>`;
        x += w + 9;
      }
      y += h + 9;
    }
    out += `<g transform="translate(${patch.x} ${patch.y}) rotate(${patch.angle})" pointer-events="none">${fields}</g>`;
  }
  return out;
}

// 远郊小户：两三处极小的屋顶，淡色、不可点击，示意聚落的存在。
function hamlet() {
  const spots = [[2270, 1222], [2312, 1236], [2236, 1244]];
  return `<g class="hamlet" aria-hidden="true" pointer-events="none" opacity=".45">${spots.map(([x, y]) => `<g transform="translate(${x} ${y})">${houseArt("housing", 0.42)}</g>`).join("")}</g>`;
}

const hills = '<path d="M1280 0H2400V120Q2250 60 2120 100Q1990 140 1880 90Q1760 40 1640 96Q1480 150 1280 110Z" fill="#d2d9bf" opacity=".85"/>' +
  '<path d="M1700 0H2400V60Q2280 40 2160 70Q2040 100 1930 60Q1820 30 1700 60Z" fill="#c7cfb2" opacity=".7"/>' +
  '<path d="M2400 520Q2300 600 2340 700Q2280 800 2400 900Z" fill="#d0d7bc" opacity=".7"/>';

const pond = '<path d="M1566 1268Q1600 1214 1680 1226Q1756 1240 1744 1300Q1728 1356 1652 1346Q1572 1336 1566 1268Z" fill="#b9cdc2" stroke="#97b2a6" stroke-width="3"/>' +
  '<path d="M1610 1282Q1650 1262 1700 1280" fill="none" stroke="#e5efe5" stroke-width="2" opacity=".8"/>';

// 道路分三层描边（先所有外沿、再内芯、最后高光），避免接缝。
function roadStrokes(main, minor) {
  const layer = (color, mainW, minorW, extra = "") =>
    `<g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round"${extra}>` +
    main.map(d => `<path d="${d}" stroke-width="${mainW}"/>`).join("") +
    minor.map(d => `<path d="${d}" stroke-width="${minorW}"/>`).join("") + "</g>";
  return layer("#c9c8ab", 29, 19) + layer("#eee4c9", 24, 15) + layer("#f5ecd5", 13, 7, ' opacity=".45"');
}

const landscapeCache = new Map();
let greeneryMarkup = null;

function buildLandscape(net) {
  const greenery = greeneryMarkup ??= treeLayer();
  const countryRoads = `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${COUNTRY_PATHS.map(d => `<path d="${d}" stroke="#d9d2b3" stroke-width="16" opacity=".6"/>`).join("")}${COUNTRY_PATHS.map(d => `<path d="${d}" stroke="#ece5cb" stroke-width="9" opacity=".8"/>`).join("")}</g>`;
  return `<defs><pattern id="papergrain" width="83" height="71" patternUnits="userSpaceOnUse"><path d="M3 6h2m21 13h1m31 38h2M11 52h1m54-44h1" stroke="#a6aa8b" opacity=".21"/><path d="M12 22l2-4 1 4m40 12 2-4 1 5" stroke="#9bab85" opacity=".22" fill="none"/></pattern><pattern id="seedlings" width="14" height="15" patternUnits="userSpaceOnUse"><path d="M7 13V5M7 10L3 6m4 2 4-6" stroke="#879976" stroke-width="1.5" fill="none"/></pattern></defs>
<rect width="2400" height="1800" fill="#e7e7ce"/><path d="M0 0H2400V160Q1700 280 1150 120T0 140Z" fill="#dbe0c8"/>
<rect width="2400" height="1800" fill="url(#papergrain)"/>
<g class="countryside">${patchwork()}${hamlet()}<ellipse cx="${FOREST.cx}" cy="${FOREST.cy}" rx="350" ry="236" fill="#9eae87" opacity=".2"/>${hills}${pond}${countryRoads}</g>
<path d="${river}" fill="none" stroke="#c5cbb2" stroke-width="82"/><path d="${river}" fill="none" stroke="#8fb6b0" stroke-width="70"/><path d="${river}" fill="none" stroke="#aac8bd" stroke-width="45" opacity=".6"/><path d="${river}" fill="none" stroke="#d7e4d3" stroke-width="1.5" stroke-dasharray="15 36 28 67"/>
<path d="M130 126L387 94 472 302 187 346Z" fill="#c4cc9a" stroke="#b5b990" stroke-width="6"/><path d="M130 126L387 94 472 302 187 346Z" fill="url(#seedlings)"/><path d="M170 216L430 177" stroke="#e1d7ae" stroke-width="8"/>
<g class="town-roads">${roadStrokes([MAIN_ROAD], [...net.lanes, ...net.spurs, ...HOUSE_PATHS])}</g>
<g transform="translate(25 403) rotate(-4)" stroke="#9b9e8a"><path d="M-63-15Q0-38 65-15V17Q0-1-63 17Z" fill="#d7d7be"/><path d="M-63 2Q0-22 65 2M-63-15Q0-38 65-15" fill="none" stroke-width="4"/>${[-60, -40, -20, 0, 20, 40, 60].map(x => `<path d="M${x} -14v-17" stroke-width="4"/>`).join('')}</g>
<g class="greenery">${greenery}</g>
<g fill="#55634a" font-family="serif" font-size="30" letter-spacing="9" text-anchor="middle" stroke="#e7e7ce" stroke-width="6" paint-order="stroke" opacity=".92"><text x="200" y="72">溪 畔</text><text x="1300" y="650">东 坊</text><text x="420" y="1120">南 林</text><text x="1880" y="1500">远 郊</text></g>`;
}

export function townLandscape(occupiedIds) {
  const ids = [...new Set(occupiedIds ?? [])].map(String).sort();
  const key = ids.join("|");
  if (landscapeCache.has(key)) return landscapeCache.get(key);
  if (landscapeCache.size > 20) landscapeCache.clear();
  const occupied = new Set(ids);
  const net = roadNetwork(PLOTS.filter(plot => occupied.has(plot.id)));
  const markup = buildLandscape(net);
  landscapeCache.set(key, markup);
  return markup;
}

export function miniMap() {
  const net = roadNetwork(PLOTS);
  return `<svg id="townMini" viewBox="0 0 2400 1800" aria-label="点击舆图定位地图" role="img"><rect width="2400" height="1800" fill="#e3e5ce"/><path d="${river}" fill="none" stroke="#8eb4ac" stroke-width="135"/><g fill="#a9af91">${PLOTS.map(p => `<rect x="${p.x * 12 - 30}" y="${p.y * 10 - 25}" width="60" height="50" rx="3"/>`).join("")}</g><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke="#f8efd7"><path d="${MAIN_ROAD}" stroke-width="25"/>${[...net.lanes, ...net.spurs, ...HOUSE_PATHS].map(d => `<path d="${d}" stroke-width="13"/>`).join("")}</g><rect id="miniViewport" x="300" y="100" width="600" height="750" fill="#fff" fill-opacity=".08" stroke="#a35643" stroke-width="20"/></svg>`;
}
