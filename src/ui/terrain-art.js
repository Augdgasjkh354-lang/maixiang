/**
 * src/ui/art.js
 * 麦乡 (Maixiang) 地图精细化美术渲染器
 * 包含：自然地块边缘融合、等距立体阴影建筑、动态风吹麦浪与水纹环境动效
 */

// 预定义田园自然色系（草地底色改由 GRASS_RAMP 连续插值，不再使用固定双色）
const PALETTE = {
  farmlandSoil: '#6F4E37',
  farmlandFurrow: '#5C3E28',
  farmlandWheatBase: '#E5A93C',
  farmlandWheatTip: '#F7D070',
  farmlandWheatHighlight: '#FFE494',

  waterDeep: '#3F88C5',
  waterShallow: '#64A5DC',
  waterHighlight: '#A0D3F8',
  sandShore: '#E4C988',

  pathBase: '#CBB282',
  pathPebble: '#AD9568',

  stone: '#8E9297',
  timber: '#7C4F2A',
  thatch: '#D3A248',
  roofRed: '#B85042',
  wallWhite: '#F4EAD4',
};

/**
 * 确定性哈希函数，保证相同格子的花草、碎石等装饰物固定，不产生每帧闪烁
 */
function tileHash(x, y, seed = 0) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * 平滑二维数值噪声（值噪声 + 五次插值）。以世界坐标为输入，跨格连续，
 * 因此草地不会出现棋盘格或整块重复图案，只有缓慢起伏的自然色变。
 */
function smoothNoise(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(xf);
  const v = fade(yf);
  const n00 = tileHash(xi, yi, seed);
  const n10 = tileHash(xi + 1, yi, seed);
  const n01 = tileHash(xi, yi + 1, seed);
  const n11 = tileHash(xi + 1, yi + 1, seed);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

/**
 * 多倍频叠加噪声：低频决定大块明暗，高频补充细碎颗粒，形成自然草地底色。
 */
function grassNoise(x, y) {
  return smoothNoise(x * 0.045, y * 0.045, 3) * 0.55 +
    smoothNoise(x * 0.13, y * 0.13, 11) * 0.3 +
    smoothNoise(x * 0.42, y * 0.42, 23) * 0.15;
}

// 草地色阶：从偏冷的深绿到偏暖的黄绿，按噪声值连续混色，避免整格跳色。
const GRASS_RAMP = [
  { t: 0, c: [124, 158, 84] },
  { t: 0.35, c: [146, 179, 96] },
  { t: 0.62, c: [163, 193, 106] },
  { t: 1, c: [180, 204, 118] }
];

function grassColorAt(t) {
  const value = Math.max(0, Math.min(1, t));
  for (let i = 1; i < GRASS_RAMP.length; i++) {
    const right = GRASS_RAMP[i];
    if (value > right.t) continue;
    const left = GRASS_RAMP[i - 1];
    const span = right.t - left.t || 1;
    const mix = (value - left.t) / span;
    const r = Math.round(left.c[0] + (right.c[0] - left.c[0]) * mix);
    const g = Math.round(left.c[1] + (right.c[1] - left.c[1]) * mix);
    const b = Math.round(left.c[2] + (right.c[2] - left.c[2]) * mix);
    return `rgb(${r},${g},${b})`;
  }
  const last = GRASS_RAMP[GRASS_RAMP.length - 1].c;
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

/**
 * 绘制单个地块（含边缘融合与微动效）
 */
export function drawTerrainTile(ctx, x, y, size, tile, world, time = 0) {
  const px = x * size;
  const py = y * size;
  const terrain = tile?.terrain || 'grass';

  // 1. 底层基色绘制
  if (terrain === 'water') {
    drawWaterTile(ctx, px, py, size, x, y, time);
  } else if (terrain === 'farmland') {
    drawFarmlandTile(ctx, px, py, size, x, y, time, tile);
  } else if (terrain === 'forest') {
    drawForestTile(ctx, px, py, size, x, y);
  } else if (terrain === 'path') {
    drawPathTile(ctx, px, py, size, x, y);
  } else {
    drawGrassTile(ctx, px, py, size, x, y);
  }

  // 2. 自然边缘过渡（检测周围相邻地块）
  if (world?.tiles) {
    drawTileBorders(ctx, px, py, size, x, y, terrain, world.tiles);
  }
  if (tile?.resourceFeature) drawResourceMark(ctx, px, py, size, tile.resourceFeature, time);
}

function drawResourceMark(ctx, px, py, size, feature) {
  ctx.save();
  ctx.translate(px + size / 2, py + size / 2);
  if (feature === 'salt_mine') {
    ctx.fillStyle = '#d9ddcb';
    ctx.strokeStyle = '#867d68';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-8, 5); ctx.lineTo(-5, -5); ctx.lineTo(1, -8);
    ctx.lineTo(8, -3); ctx.lineTo(9, 5); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#fff7d9';
    ctx.beginPath(); ctx.moveTo(-3, 2); ctx.lineTo(1, -4); ctx.lineTo(5, 3); ctx.stroke();
  } else {
    ctx.fillStyle = '#ad7944';
    ctx.fillRect(-8, 1, 15, 5);
    ctx.fillStyle = '#dfb86f';
    ctx.beginPath(); ctx.ellipse(-8, 3.5, 2.2, 2.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#487042';
    ctx.beginPath(); ctx.arc(7, -6, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/**
 * 草地：连续噪声底色 + 细碎颗粒 + 草叶簇与零星野花。
 * 底色由世界坐标上的多倍频噪声决定，跨格平滑过渡，不使用棋盘格交替。
 */
function drawGrassTile(ctx, px, py, size, x, y) {
  const centerX = x * size + size / 2;
  const centerY = y * size + size / 2;

  // 1. 连续渐变底色（取四角与中心采样后取均值，进一步柔化格边）
  const tone = (grassNoise(px, py) + grassNoise(px + size, py) +
    grassNoise(px, py + size) + grassNoise(px + size, py + size) +
    grassNoise(centerX, centerY) * 2) / 6;
  ctx.fillStyle = grassColorAt(tone);
  ctx.fillRect(px, py, size, size);

  // 2. 细微噪点颗粒：模拟草皮的细碎明暗，避免大块纯色
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, size, size);
  ctx.clip();
  const speckles = 16;
  for (let i = 0; i < speckles; i++) {
    const sx = px + tileHash(x, y, 40 + i) * size;
    const sy = py + tileHash(x, y, 60 + i) * size;
    const shade = tileHash(x, y, 80 + i);
    ctx.fillStyle = shade > 0.5
      ? `rgba(96, 126, 66, ${0.06 + shade * 0.07})`
      : `rgba(226, 236, 178, ${0.05 + (1 - shade) * 0.07})`;
    ctx.beginPath();
    ctx.arc(sx, sy, 0.7 + tileHash(x, y, 100 + i) * 1.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3. 草叶簇：位置与朝向随格子确定性变化，密度由噪声决定，疏密自然
  const density = 0.35 + grassNoise(centerX * 1.6, centerY * 1.6) * 0.5;
  const tufts = Math.round(density * 5);
  for (let i = 0; i < tufts; i++) {
    const gx = px + 4 + tileHash(x, y, 120 + i) * (size - 8);
    const gy = py + 6 + tileHash(x, y, 140 + i) * (size - 10);
    const height = 3.5 + tileHash(x, y, 160 + i) * 3.5;
    const lean = (tileHash(x, y, 180 + i) - 0.5) * 2.4;
    ctx.strokeStyle = `rgba(101, 132, 66, ${0.42 + tileHash(x, y, 200 + i) * 0.3})`;
    ctx.lineWidth = 1 + tileHash(x, y, 220 + i) * 0.5;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.quadraticCurveTo(gx + lean * 0.4, gy - height * 0.6, gx + lean, gy - height);
    ctx.stroke();
    // 三叶小草：主叶旁补一枚短叶，形成草丛轮廓
    if (tileHash(x, y, 240 + i) > 0.45) {
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx - lean * 0.5 - 2, gy - height * 0.5, gx - 2 - lean, gy - height * 0.75);
      ctx.stroke();
    }
  }

  // 4. 零星野花：白雏菊与淡黄小花，概率很低，避免出现规则花纹
  for (let i = 0; i < 2; i++) {
    const roll = tileHash(x, y, 260 + i);
    if (roll < 0.82) continue;
    const fx = px + 5 + tileHash(x, y, 280 + i) * (size - 10);
    const fy = py + 5 + tileHash(x, y, 300 + i) * (size - 10);
    const warm = tileHash(x, y, 320 + i) > 0.5;
    ctx.fillStyle = warm ? '#F4E27A' : '#FBFBF3';
    for (let petal = 0; petal < 4; petal++) {
      const angle = petal * Math.PI / 2 + roll;
      ctx.beginPath();
      ctx.arc(fx + Math.cos(angle) * 1.3, fy + Math.sin(angle) * 1.3, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = warm ? '#E0A93F' : '#F2C64B';
    ctx.beginPath();
    ctx.arc(fx, fy, 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawForestTile(ctx, px, py, size, x, y) {
  // 林地底色同样用连续噪声，避免棋盘格；树冠层再做单株变化。
  const tone = grassNoise(px + size * 0.5, py + size * 0.5);
  const shade = Math.round(96 + tone * 22);
  ctx.fillStyle = `rgb(${shade - 26},${shade + 8},${shade - 44})`;
  ctx.fillRect(px, py, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, size, size);
  ctx.clip();
  for (let i = 0; i < 8; i++) {
    const sx = px + tileHash(x, y, 340 + i) * size;
    const sy = py + tileHash(x, y, 360 + i) * size;
    ctx.fillStyle = tileHash(x, y, 380 + i) > 0.5 ? 'rgba(58, 82, 46, .32)' : 'rgba(140, 168, 96, .22)';
    ctx.beginPath();
    ctx.arc(sx, sy, 1 + tileHash(x, y, 400 + i) * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  const seed = tileHash(x, y, 34);
  const cx = px + size * (0.25 + seed * 0.5);
  const cy = py + size * (0.28 + tileHash(x, y, 35) * 0.38);
  ctx.fillStyle = '#795b3b';
  ctx.fillRect(cx - 2, cy + 5, 4, size * 0.28);
  ctx.fillStyle = seed > 0.5 ? '#486b42' : '#547746';
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#789452';
  ctx.beginPath();
  ctx.arc(cx - size * 0.07, cy - size * 0.07, size * 0.17, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 农田：湿润泥土耕垄 + 随风摇曳的麦浪
 */
function drawFarmlandTile(ctx, px, py, size, x, y, time, tile) {
  // 泥土基底
  ctx.fillStyle = PALETTE.farmlandSoil;
  ctx.fillRect(px, py, size, size);

  // 耕垄阴影
  ctx.strokeStyle = PALETTE.farmlandFurrow;
  ctx.lineWidth = 1.5;
  const rows = 4;
  const rowSpacing = size / rows;
  for (let i = 1; i < rows; i++) {
    const ry = py + i * rowSpacing;
    ctx.beginPath();
    ctx.moveTo(px + 2, ry);
    ctx.lineTo(px + size - 2, ry);
    ctx.stroke();
  }

  const stage = tile?.growthStage || 'autumn';
  const growth = stage === 'spring' ? 0.45 : stage === 'summer' ? 0.78 : stage === 'winter' ? 0 : 1;
  if (growth === 0) {
    ctx.strokeStyle = 'rgba(74, 50, 32, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, size - 1, size - 1);
    return;
  }

  // 麦浪动效计算（正弦风波）
  // 结合世界坐标与时间，形成自西北向东南拂过的连绵麦浪
  const wind = Math.sin(time * 2.8 + x * 0.65 + y * 0.5) * 3.5;
  const waveShine = (Math.sin(time * 2.0 + x * 0.4 + y * 0.3) + 1) * 0.5; // 0 ~ 1 阳光反光度

  // 麦穗株簇
  const stalksPerRow = 5;
  for (let r = 0; r < rows; r++) {
    const baseY = py + (r + 0.75) * rowSpacing;
    for (let c = 0; c < stalksPerRow; c++) {
      const baseX = px + (c + 0.5) * (size / stalksPerRow) + (tileHash(x + c, y + r) - 0.5) * 4;
      const sway = wind * (0.8 + (r / rows) * 0.4);

      // 麦秆
      ctx.strokeStyle = stage === 'spring' ? '#8faa55' : PALETTE.farmlandWheatBase;
      ctx.lineWidth = stage === 'spring' ? 1.2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.quadraticCurveTo(baseX + sway * 0.4, baseY - 6 * growth, baseX + sway, baseY - 11 * growth);
      ctx.stroke();

      // 麦穗金黄头部
      ctx.fillStyle = stage === 'spring' ? '#a7bd67'
        : waveShine > 0.65 ? PALETTE.farmlandWheatHighlight : PALETTE.farmlandWheatTip;
      ctx.beginPath();
      ctx.ellipse(baseX + sway, baseY - 11 * growth, 2.2 * growth, 3.5 * growth, (sway * Math.PI) / 180, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 农田外围小围垄边框
  ctx.strokeStyle = 'rgba(74, 50, 32, 0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, size - 1, size - 1);
}

/**
 * 水体：微光荡漾与波纹涟漪
 */
function drawWaterTile(ctx, px, py, size, x, y, time) {
  ctx.fillStyle = PALETTE.waterDeep;
  ctx.fillRect(px, py, size, size);

  // 动态涟漪反光
  const rippleOffset = Math.sin(time * 2.2 + x * 1.2 + y * 0.8) * 3;
  ctx.strokeStyle = PALETTE.waterHighlight;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(px + size * 0.35 + rippleOffset, py + size * 0.4, size * 0.2, 0.2, Math.PI * 0.8);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(px + size * 0.7 - rippleOffset, py + size * 0.75, size * 0.15, 0.3, Math.PI * 0.75);
  ctx.stroke();
}

/**
 * 泥土路：轻微砂砾纹理与碎石
 */
function drawPathTile(ctx, px, py, size, x, y) {
  ctx.fillStyle = PALETTE.pathBase;
  ctx.fillRect(px, py, size, size);

  // 散落碎石
  ctx.fillStyle = PALETTE.pathPebble;
  for (let i = 0; i < 3; i++) {
    const hx = tileHash(x, y, 10 + i);
    const hy = tileHash(x, y, 20 + i);
    ctx.beginPath();
    ctx.arc(px + 4 + hx * (size - 8), py + 4 + hy * (size - 8), 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * 自然边缘过渡：在与水、田地、道路相邻的边界上绘制平滑的泥沙带或软边缘
 */
function drawTileBorders(ctx, px, py, size, x, y, currentTerrain, tiles) {
  // 仅在非水地块靠近水时，画浅沙滩过渡；或道路靠近草地时柔和过渡
  if (currentTerrain !== 'water') {
    const neighbors = [
      { dir: 'N', t: tiles[`${x},${y - 1}`]?.terrain },
      { dir: 'S', t: tiles[`${x},${y + 1}`]?.terrain },
      { dir: 'W', t: tiles[`${x - 1},${y}`]?.terrain },
      { dir: 'E', t: tiles[`${x + 1},${y}`]?.terrain },
    ];

    neighbors.forEach(({ dir, t }) => {
      if (t === 'water') {
        ctx.fillStyle = PALETTE.sandShore;
        if (dir === 'N') ctx.fillRect(px, py, size, 3.5);
        if (dir === 'S') ctx.fillRect(px, py + size - 3.5, size, 3.5);
        if (dir === 'W') ctx.fillRect(px, py, 3.5, size);
        if (dir === 'E') ctx.fillRect(px + size - 3.5, py, 3.5, size);
      }
    });
  }
}

/**
 * 立体阴影建筑绘制系统
 */
export function drawBuilding(ctx, x, y, size, building, time = 0) {
  const px = x * size;
  const py = y * size;
  const type = (building.type || building.id || '').toLowerCase();

  ctx.save();

  // 1. 全局柔和地表投影（向右下方倾斜投影，形成高度感）
  drawBuildingShadow(ctx, px, py, size, type);

  // 2. 根据建筑类型分化立体造型
  if (type.includes('bank')) {
    drawBank(ctx, px, py, size);
  } else if (type.includes('stock_exchange')) {
    drawStockExchange(ctx, px, py, size);
  } else if (type.includes('town_hall') || type.includes('social_security')) {
    drawTownHall(ctx, px, py, size);
  } else if (type.includes('police')) {
    drawPoliceStation(ctx, px, py, size);
  } else if (type.includes('wholesale')) {
    drawWholesaleMarket(ctx, px, py, size);
  } else if (type.includes('commercial')) {
    drawCommercialStreet(ctx, px, py, size);
  } else if (type.includes('bakery') || type.includes('bake')) {
    drawBakery(ctx, px, py, size, building.working ? time : 0, Boolean(building.working));
  } else if (type.includes('lumber')) {
    drawLumberyard(ctx, px, py, size, building.working ? time : 0, Boolean(building.working));
  } else if (type.includes('salt')) {
    drawSaltworks(ctx, px, py, size, building.working ? time : 0, Boolean(building.working));
  } else if (type.includes('public')) {
    drawPublicHousing(ctx, px, py, size);
  } else if (type.includes('mill') || type.includes('wind')) {
    drawWindmill(ctx, px, py, size, building.working ? time : 0);
  } else if (type.includes('granary') || type.includes('store') || type.includes('ware')) {
    drawGranary(ctx, px, py, size);
  } else if (type.includes('work') || type.includes('smith')) {
    drawWorkshop(ctx, px, py, size, building.working ? time : 0, Boolean(building.working));
  } else {
    drawCottage(ctx, px, py, size);
  }

  const level = Math.max(1, Math.min(10, Math.floor(building.level || 1)));
  if (level > 1) {
    ctx.save();
    for (let i = 0; i < Math.min(level, 5) - 1; i++) { // 5 级以上沿用 5 级的标记数（再多就画出地块了）
      const ax = px + size * (.24 + i * .13);
      const ay = py + size * .82;
      ctx.fillStyle = i % 2 ? "#b7773f" : "#d49a53";
      ctx.strokeStyle = "#694b30";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ax - size * .055, ay);
      ctx.lineTo(ax, ay - size * .045);
      ctx.lineTo(ax + size * .055, ay);
      ctx.lineTo(ax + size * .048, ay + size * .045);
      ctx.lineTo(ax - size * .048, ay + size * .045);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  // 3. 施工中脚手架指示（若建筑未完工）
  if (building.progress !== undefined && building.progress < 1) {
    drawConstructionScaffolding(ctx, px, py, size, building.progress);
  }

  ctx.restore();
}

function drawLumberyard(ctx, px, py, size, time, working) {
  drawWorkshop(ctx, px, py, size, time, false);
  ctx.save();
  ctx.fillStyle = '#86582f';
  ctx.strokeStyle = '#5a4029';
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const x = px + size * .17 + i * size * .19;
    const y = py + size * .72 - (i % 2) * size * .045;
    ctx.fillRect(x, y, size * .27, size * .09);
    ctx.beginPath();
    ctx.ellipse(x, y + size * .045, size * .035, size * .045, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#bf8b4b';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#86582f';
  }
  ctx.strokeStyle = '#d9b56b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px + size * .78, py + size * .52);
  ctx.lineTo(px + size * .78 + Math.sin(time * 4) * (working ? 3 : 0), py + size * .69);
  ctx.stroke();
  if (working) {
    ctx.fillStyle = 'rgba(237, 214, 157, .72)';
    for (let i = 0; i < 3; i++) {
      const age = (time * 2 + i * .37) % 1;
      ctx.beginPath();
      ctx.arc(px + size * (.73 + age * .06), py + size * (.65 + age * .15), 1.1 + age, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawSaltworks(ctx, px, py, size, time, working) {
  drawCottage(ctx, px, py, size);
  ctx.save();
  const kilnX = px + size * .64;
  const kilnY = py + size * .55;
  ctx.fillStyle = '#a69673';
  ctx.strokeStyle = '#66543e';
  ctx.lineWidth = 2;
  ctx.fillRect(kilnX, kilnY, size * .23, size * .29);
  ctx.beginPath();
  ctx.arc(kilnX + size * .115, kilnY + size * .03, size * .12, Math.PI, 0);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#563b2c';
  ctx.beginPath();
  ctx.ellipse(kilnX + size * .115, kilnY + size * .2, size * .075, size * .065, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f2eee0';
  ctx.beginPath();
  ctx.moveTo(px + size * .12, py + size * .83);
  ctx.lineTo(px + size * .16, py + size * .66);
  ctx.lineTo(px + size * .32, py + size * .66);
  ctx.lineTo(px + size * .36, py + size * .83);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#c9c1a4';
  ctx.stroke();
  if (working) {
    ctx.fillStyle = 'rgba(222, 235, 229, .58)';
    for (let i = 0; i < 3; i++) {
      const age = (time * 1.2 + i * .45) % 2.2;
      const x = kilnX + size * (.1 + age * .025);
      const y = kilnY - size * (.03 + age * .11);
      ctx.beginPath();
      ctx.arc(x, y, size * (.018 + age * .018), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawPublicHousing(ctx, px, py, size) {
  const house = (x, y, scale, roof) => {
    const w = size * scale;
    const h = size * scale * .56;
    const bx = px + x;
    const by = py + y;
    ctx.fillStyle = '#eadfc9';
    ctx.strokeStyle = '#72533a';
    ctx.lineWidth = 2;
    ctx.fillRect(bx, by, w, h);
    ctx.strokeRect(bx, by, w, h);
    ctx.fillStyle = roof;
    ctx.beginPath();
    ctx.moveTo(bx - 3, by + 2);
    ctx.lineTo(bx + w / 2, by - h * .4);
    ctx.lineTo(bx + w + 3, by + 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#614632';
    ctx.fillRect(bx + w * .43, by + h * .55, w * .16, h * .45);
  };
  house(size * .05, size * .35, .39, '#a95340');
  house(size * .31, size * .12, .42, '#c47748');
  house(size * .56, size * .36, .39, '#8f6244');
}


function drawInstitutionBase(ctx, px, py, size, wall, roof) {
  ctx.save();
  ctx.fillStyle = wall; ctx.strokeStyle = '#5e513f'; ctx.lineWidth = 2;
  ctx.fillRect(px + size * .14, py + size * .39, size * .72, size * .48);
  ctx.strokeRect(px + size * .14, py + size * .39, size * .72, size * .48);
  ctx.fillStyle = roof;
  ctx.beginPath(); ctx.moveTo(px + size * .08, py + size * .4); ctx.lineTo(px + size * .5, py + size * .16); ctx.lineTo(px + size * .92, py + size * .4); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawBank(ctx, px, py, size) {
  drawInstitutionBase(ctx, px, py, size, '#eee7d2', '#667f58');
  ctx.save(); ctx.strokeStyle = '#675d49'; ctx.fillStyle = '#d8cfb7'; ctx.lineWidth = 2;
  for (const x of [.25,.4,.6,.75]) { ctx.fillRect(px + size * x, py + size * .47, size * .07, size * .34); ctx.strokeRect(px + size * x, py + size * .47, size * .07, size * .34); }
  ctx.fillStyle = '#5b4737'; ctx.fillRect(px + size * .45, py + size * .65, size * .1, size * .22);
  ctx.fillStyle = '#d7b04d'; ctx.beginPath(); ctx.arc(px + size * .5, py + size * .32, size * .075, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawStockExchange(ctx, px, py, size) {
  drawInstitutionBase(ctx, px, py, size, '#e7e2d8', '#7d5e4b');
  ctx.save(); ctx.strokeStyle = '#486b62'; ctx.lineWidth = 3; ctx.beginPath();
  ctx.moveTo(px + size * .24, py + size * .72); ctx.lineTo(px + size * .39, py + size * .59); ctx.lineTo(px + size * .52, py + size * .64); ctx.lineTo(px + size * .72, py + size * .47); ctx.stroke();
  ctx.fillStyle = '#486b62'; ctx.beginPath(); ctx.moveTo(px + size * .72, py + size * .47); ctx.lineTo(px + size * .66, py + size * .49); ctx.lineTo(px + size * .7, py + size * .55); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#694c38'; ctx.fillRect(px + size * .44, py + size * .7, size * .12, size * .17); ctx.restore();
}

function drawTownHall(ctx, px, py, size) {
  drawInstitutionBase(ctx, px, py, size, '#f1e5c9', '#9a5d42');
  ctx.save(); ctx.fillStyle = '#79513d'; ctx.strokeStyle = '#5c4636';
  ctx.fillRect(px + size * .45, py + size * .61, size * .1, size * .26);
  ctx.fillStyle = '#d9c59b'; for (const x of [.25,.67]) ctx.fillRect(px + size * x, py + size * .52, size * .1, size * .12);
  ctx.fillStyle = '#c7a449'; ctx.beginPath(); ctx.arc(px + size * .5, py + size * .36, size * .045, 0, Math.PI*2); ctx.fill(); ctx.restore();
}

function drawPoliceStation(ctx, px, py, size) {
  drawInstitutionBase(ctx, px, py, size, '#e5e9e4', '#536f72');
  ctx.save(); ctx.fillStyle = '#4b5f63'; ctx.fillRect(px + size * .43, py + size * .62, size * .14, size * .25);
  ctx.strokeStyle = '#6b7d7f'; ctx.lineWidth = 2; for (let i=0;i<3;i++){ const x=px+size*(.22+i*.22); ctx.strokeRect(x,py+size*.5,size*.1,size*.12); ctx.beginPath(); ctx.moveTo(x+size*.033,py+size*.5);ctx.lineTo(x+size*.033,py+size*.62);ctx.moveTo(x+size*.066,py+size*.5);ctx.lineTo(x+size*.066,py+size*.62);ctx.stroke(); }
  ctx.restore();
}

function drawCommercialStreet(ctx, px, py, size) {
  ctx.save(); ctx.strokeStyle='#624c38'; ctx.lineWidth=2;
  const shop=(x,roof)=>{ ctx.fillStyle='#efe2c8';ctx.fillRect(px+size*x,py+size*.43,size*.31,size*.42);ctx.strokeRect(px+size*x,py+size*.43,size*.31,size*.42);ctx.fillStyle=roof;ctx.fillRect(px+size*(x-.025),py+size*.36,size*.36,size*.1);ctx.fillStyle='#6a4c36';ctx.fillRect(px+size*(x+.12),py+size*.66,size*.08,size*.19);ctx.fillStyle='#c8d5c1';ctx.fillRect(px+size*(x+.035),py+size*.52,size*.08,size*.08);};
  shop(.13,'#ad5848'); shop(.56,'#557765');
  ctx.fillStyle='#d7bd79';ctx.fillRect(px+size*.08,py+size*.34,size*.39,size*.045);ctx.fillRect(px+size*.51,py+size*.34,size*.39,size*.045);ctx.restore();
}

function drawWholesaleMarket(ctx, px, py, size) {
  ctx.save();
  ctx.strokeStyle = '#5a4938'; ctx.lineWidth = 1.8;
  ctx.fillStyle = '#d7c4a2';
  ctx.fillRect(px + size * .12, py + size * .34, size * .76, size * .48);
  ctx.strokeRect(px + size * .12, py + size * .34, size * .76, size * .48);
  ctx.fillStyle = '#7f6951';
  ctx.beginPath();
  ctx.moveTo(px + size * .08, py + size * .34);
  ctx.lineTo(px + size * .5, py + size * .18);
  ctx.lineTo(px + size * .92, py + size * .34);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#efe0b6';
  ctx.fillRect(px + size * .18, py + size * .43, size * .64, size * .1);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? '#9a5b3d' : '#d8b65d';
    ctx.fillRect(px + size * (.18 + i * .16), py + size * .43, size * .16, size * .1);
  }
  ctx.fillStyle = '#855f3a';
  ctx.fillRect(px + size * .2, py + size * .64, size * .16, size * .13);
  ctx.fillRect(px + size * .64, py + size * .62, size * .16, size * .15);
  ctx.strokeRect(px + size * .2, py + size * .64, size * .16, size * .13);
  ctx.strokeRect(px + size * .64, py + size * .62, size * .16, size * .15);
  ctx.restore();
}

function drawBakery(ctx, px, py, size, time, working) {
  drawCottage(ctx, px, py, size);
  ctx.save(); ctx.fillStyle='#86614a';ctx.strokeStyle='#5e4436';ctx.lineWidth=2;ctx.fillRect(px+size*.69,py+size*.2,size*.1,size*.31);ctx.strokeRect(px+size*.69,py+size*.2,size*.1,size*.31);
  ctx.fillStyle='#4e382e';ctx.beginPath();ctx.arc(px+size*.35,py+size*.7,size*.13,Math.PI,0);ctx.lineTo(px+size*.48,py+size*.82);ctx.lineTo(px+size*.22,py+size*.82);ctx.closePath();ctx.fill();
  ctx.strokeStyle='#d6a65a';ctx.lineWidth=3;ctx.beginPath();ctx.arc(px+size*.35,py+size*.74,size*.07,Math.PI,0);ctx.stroke();
  if (working) { ctx.fillStyle='rgba(230,230,220,.55)'; for(let i=0;i<3;i++){const age=(time*1.3+i*.5)%2;ctx.beginPath();ctx.arc(px+size*(.74+age*.02),py+size*(.18-age*.08),size*(.018+age*.015),0,Math.PI*2);ctx.fill();}}
  ctx.restore();
}

/**
 * 统一柔和地表阴影
 */
function drawBuildingShadow(ctx, px, py, size, type) {
  ctx.fillStyle = 'rgba(25, 30, 20, 0.22)';
  ctx.beginPath();
  // 底部椭圆阴影，略微向下偏
  const cx = px + size / 2 + 3;
  const cy = py + size * 0.88;
  ctx.ellipse(cx, cy, size * 0.42, size * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 标准乡村民居（Cottage）
 */
function drawCottage(ctx, px, py, size) {
  const bx = px + 6;
  const by = py + 14;
  const bw = size - 12;
  const bh = size - 18;

  // 墙体基底（暖白土坯）
  ctx.fillStyle = PALETTE.wallWhite;
  ctx.fillRect(bx, by, bw, bh);

  // 墙体木构立柱（左侧受光浅，右侧背光深）
  ctx.fillStyle = PALETTE.timber;
  ctx.fillRect(bx, by, 3, bh);
  ctx.fillRect(bx + bw - 3, by, 3, bh);

  // 木门
  ctx.fillStyle = '#653818';
  ctx.fillRect(bx + bw / 2 - 4, by + bh - 10, 8, 10);

  // 瓦红人字形屋顶（具有立体坡面）
  // 左坡面（受光）
  ctx.fillStyle = '#C85A4B';
  ctx.beginPath();
  ctx.moveTo(px + size / 2, py + 3);
  ctx.lineTo(bx - 3, by);
  ctx.lineTo(px + size / 2, by + 4);
  ctx.closePath();
  ctx.fill();

  // 右坡面（阴影面）
  ctx.fillStyle = '#9C3E30';
  ctx.beginPath();
  ctx.moveTo(px + size / 2, py + 3);
  ctx.lineTo(bx + bw + 3, by);
  ctx.lineTo(px + size / 2, by + 4);
  ctx.closePath();
  ctx.fill();
}

/**
 * 粮仓（Granary）：加高双层、带有防潮高脚垫石与圆拱仓顶
 */
function drawGranary(ctx, px, py, size) {
  const bx = px + 7;
  const by = py + 10;
  const bw = size - 14;
  const bh = size - 15;

  // 底部石质防潮墩
  ctx.fillStyle = PALETTE.stone;
  ctx.fillRect(bx + 1, by + bh - 4, 5, 5);
  ctx.fillRect(bx + bw - 6, by + bh - 4, 5, 5);

  // 仓身原木条板
  ctx.fillStyle = '#B47B44';
  ctx.fillRect(bx, by, bw, bh - 3);

  // 木纹分界线
  ctx.strokeStyle = '#8E5928';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx, by + bh * 0.45);
  ctx.lineTo(bx + bw, by + bh * 0.45);
  ctx.stroke();

  // 茅草大弧顶
  ctx.fillStyle = PALETTE.thatch;
  ctx.beginPath();
  ctx.arc(px + size / 2, by + 4, bw * 0.58, Math.PI, 0);
  ctx.fill();

  // 粮仓通风天窗
  ctx.fillStyle = '#422812';
  ctx.fillRect(px + size / 2 - 3, by + 2, 6, 6);
}

/**
 * 磨坊（Windmill）：八角塔身 + 随时间匀速旋转的风车叶片动效
 */
function drawWindmill(ctx, px, py, size, time) {
  const cx = px + size / 2;
  const cy = py + size * 0.6;

  // 塔身梯形柱体
  ctx.fillStyle = '#E8DEC8';
  ctx.beginPath();
  ctx.moveTo(cx - 7, py + 12);
  ctx.lineTo(cx + 7, py + 12);
  ctx.lineTo(cx + 12, py + size - 5);
  ctx.lineTo(cx - 12, py + size - 5);
  ctx.closePath();
  ctx.fill();

  // 磨坊锥顶
  ctx.fillStyle = '#8B4513';
  ctx.beginPath();
  ctx.moveTo(cx, py + 4);
  ctx.lineTo(cx - 9, py + 13);
  ctx.lineTo(cx + 9, py + 13);
  ctx.closePath();
  ctx.fill();

  // 旋转风车四片叶片（按时间持续旋转）
  const rotorX = cx;
  const rotorY = py + 14;
  const angle = time * 2.2; // 旋转角速度

  ctx.save();
  ctx.translate(rotorX, rotorY);
  ctx.rotate(angle);

  // 轴心中心轮
  ctx.fillStyle = '#3E2723';
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();

  // 4 个十字木质风车叶片
  const bladeLen = size * 0.42;
  ctx.strokeStyle = '#5D4037';
  ctx.lineWidth = 1.8;
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(bladeLen, 0);
    ctx.stroke();

    // 叶片帆布格网
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fillRect(bladeLen * 0.3, 1, bladeLen * 0.65, 4.5);
  }

  ctx.restore();
}

/**
 * 作坊（Workshop）：带烟囱与缓缓升起的炊烟微动效
 */
function drawWorkshop(ctx, px, py, size, time, working) {
  drawCottage(ctx, px, py, size);

  // 石砖烟囱
  const chimX = px + size - 14;
  const chimY = py + 4;
  ctx.fillStyle = PALETTE.stone;
  ctx.fillRect(chimX, chimY, 5, 10);

  // 停工时不绘制烟气；工作动画由界面的现实时间驱动。
  if (!working) return;

  // 飘散的微缕青烟（正弦飘动 + 渐淡）
  ctx.fillStyle = 'rgba(230, 230, 235, 0.45)';
  for (let i = 0; i < 3; i++) {
    const smokeAge = ((time * 1.5 + i * 0.7) % 2.5); // 0 ~ 2.5 秒生命周期
    const sy = chimY - smokeAge * 7;
    const sx = chimX + 2 + Math.sin(time * 2 + i) * 3 + smokeAge * 2;
    const sRad = 2 + smokeAge * 2;
    ctx.beginPath();
    ctx.arc(sx, sy, sRad, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * 未完工建筑的木架施工反馈
 */
function drawConstructionScaffolding(ctx, px, py, size, progress) {
  ctx.strokeStyle = 'rgba(215, 160, 60, 0.85)';
  ctx.lineWidth = 1.5;
  // 简易脚手架对角交叉线
  ctx.beginPath();
  ctx.moveTo(px + 4, py + 8);
  ctx.lineTo(px + size - 4, py + size - 6);
  ctx.moveTo(px + size - 4, py + 8);
  ctx.lineTo(px + 4, py + size - 6);
  ctx.stroke();

  // 施工进度圆环胶囊
  const pct = Math.round(progress * 100);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.beginPath();
  ctx.roundRect(px + size / 2 - 16, py + size / 2 - 8, 32, 16, 8);
  ctx.fill();

  ctx.fillStyle = '#FFD54F';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${pct}%`, px + size / 2, py + size / 2);
}

/**
 * 建造吸附模式虚影
 */
export function drawBuildGhost(ctx, x, y, size, isValid) {
  const px = x * size;
  const py = y * size;

  ctx.save();
  if (isValid) {
    ctx.fillStyle = 'rgba(76, 175, 80, 0.38)';
    ctx.strokeStyle = '#2E7D32';
  } else {
    ctx.fillStyle = 'rgba(239, 83, 80, 0.38)';
    ctx.strokeStyle = '#C62828';
  }

  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(px + 2, py + 2, size - 4, size - 4, 6);
  ctx.fill();
  ctx.stroke();

  // 中心状态图标
  ctx.fillStyle = isValid ? '#1B5E20' : '#B71C1C';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isValid ? '✓' : '✕', px + size / 2, py + size / 2);

  ctx.restore();
}

/**
 * 悬停信息气泡胶囊
 */
export function drawHoverBadge(ctx, screenX, screenY, tile, coord) {
  const padding = 10;
  let label = `地块 (${coord.x}, ${coord.y})`;
  let sub = tile?.terrain ? `地貌: ${tile.terrain}` : '';
  if (tile?.building) {
    label = `【${tile.building.name || tile.building.type || '建筑'}】`;
    sub = tile.building.level ? `等级: Lv.${tile.building.level}` : '运转正常';
  }

  ctx.save();
  ctx.font = 'bold 12px sans-serif';
  const w1 = ctx.measureText(label).width;
  ctx.font = '10px sans-serif';
  const w2 = ctx.measureText(sub).width;
  const width = Math.max(w1, w2) + padding * 2;
  const height = 36;

  const bx = screenX + 14;
  const by = screenY - 42;

  // 半透明柔和阴影气泡
  ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;

  ctx.fillStyle = 'rgba(33, 37, 41, 0.9)';
  ctx.beginPath();
  ctx.roundRect(bx, by, width, height, 6);
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#FFD54F';
  ctx.font = 'bold 11px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(label, bx + padding, by + 6);

  ctx.fillStyle = '#D6D8DB';
  ctx.font = '10px sans-serif';
  ctx.fillText(sub, bx + padding, by + 20);

  ctx.restore();
}
