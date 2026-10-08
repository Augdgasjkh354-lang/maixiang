// 茶叶 mod · 行为。只读写 state.mods.tea；卖给外镇走核心外贸面板（外镇档案里有茶叶就自动出现）。
import { defineMod, modState } from "../api.js";

const ITEM = "tea_leaf";
const TOWNS = ["minzhen", "wangzhen"];

const fmtJin = (value, digits = 0) => (Number(value) || 0).toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const toJin = (units, content) => (Number(units) || 0) / content.precision.inventoryUnitsPerJin;

// ---------------------------------------------------------------- 茶园美术（约 120 宽，底部中心在 0,36）
// 坡地上三四排茶树，右上角一间茅草小棚；配色取自 ui/building-art.js 的江南palette。
function teaRows(level) {
  const rowCount = level >= 3 ? 4 : 3;
  let out = "";
  for (let r = 0; r < rowCount; r += 1) {
    const yLeft = 32 - r * 12;
    const yRight = 8 - r * 12;
    const at = t => [-46 + 62 * t, yLeft + (yRight - yLeft) * 0.78 * t];
    const [x0, y0] = at(0), [x1, y1] = at(1);
    out += `<path d="M${x0} ${y0}L${x1} ${y1}" fill="none" stroke="#a9a57c" stroke-width="1.2" stroke-dasharray="3 2"/>`;
    for (let k = 0; k < 4; k += 1) {
      const [x, y] = at(0.12 + k * 0.25);
      out += `<ellipse cx="${x.toFixed(1)}" cy="${(y - 1).toFixed(1)}" rx="7" ry="4.2" fill="#6f8f5a" stroke="#4d6a40"/>`;
      out += `<circle cx="${(x - 2.5).toFixed(1)}" cy="${(y - 2.6).toFixed(1)}" r="1.1" fill="#b7cc97"/><circle cx="${(x + 2.8).toFixed(1)}" cy="${(y - 1.4).toFixed(1)}" r="0.9" fill="#b7cc97"/>`;
    }
  }
  return out;
}

function teaSlope() {
  return `<path d="M-62 38L-40-26Q-16-32 10-30L62 0L0 50Z" fill="#c9c99c" stroke="#8f8a64"/>`
    + `<path d="M-62 38L0 50L62 0" fill="none" stroke="#a7a27a" stroke-width="1.2"/>`;
}

function teaShed(x, y, s) {
  return `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 0L62 22V-8L0-30Z" fill="#f4f0df"/><path d="M62 22L93 3V-27L62-8Z" fill="#d5dbcc"/><path d="M0-30L62-8 77.5-27.5 15.5-49.5Z" fill="#c9b985"/><path d="M62-8L93-27 77.5-27.5Z" fill="#b3a474"/><path d="M18.6 6.6L34.1 12.1V-5.9L18.6-11.4Z" fill="#967e5d"/><path d="M-4 24h70" stroke="#b8ad88" stroke-width="3" fill="none"/></g>`;
}

function teaGardenArt({ level = 1 } = {}) {
  return `<g>${teaSlope()}${teaRows(level)}${teaShed(22, 4, 0.5)}`
    + `<path d="M46 12l4 0" stroke="#7b7c66" stroke-width="2"/></g>`;
}

export default defineMod({
  id: "tea",

  dailySteps: [
    // 放在 history 之后：此时 day.production 是今日全部产出，市场当日销量也已结清。
    { id: "tally", after: "history", run(state, content, day) {
      const mine = modState(state, "tea");
      const producedToday = {};
      for (const row of day?.production || []) {
        const units = Number(row?.outputUnits?.[ITEM]) || 0;
        if (units <= 0) continue;
        producedToday[row.buildingId] = (producedToday[row.buildingId] || 0) + units;
      }
      const todayUnits = Object.values(producedToday).reduce((sum, value) => sum + value, 0);
      mine.todayProducedUnits = todayUnits;
      mine.producedUnits = (mine.producedUnits || 0) + todayUnits;
      mine.gardens ||= {};
      for (const [buildingId, units] of Object.entries(producedToday)) {
        mine.gardens[buildingId] = (mine.gardens[buildingId] || 0) + units;
      }
      // 批发市场当日售出（卖给综合商店、居民采购等）。
      const marketToday = Number(state.wholesaleMarket?.day?.soldUnits?.[ITEM]) || 0;
      mine.marketSoldUnits = (mine.marketSoldUnits || 0) + marketToday;
    } }
  ],

  select(state, content) {
    const mine = state.mods?.tea || {};
    const perJin = content.precision.inventoryUnitsPerJin;
    const gardens = Object.fromEntries(Object.entries(mine.gardens || {}).map(([id, units]) => [id, (Number(units) || 0) / perJin]));
    const towns = TOWNS.map(townId => {
      const profile = content.outsideTowns?.[townId];
      const town = state.outsideTowns?.[townId];
      return {
        id: townId,
        name: profile?.name || townId,
        basePrice: profile?.goods?.[ITEM]?.basePrice ?? null,
        stockJin: Number(town?.stocks?.[ITEM]) || 0
      };
    }).filter(row => row.basePrice !== null);
    return {
      todayProducedJin: toJin(mine.todayProducedUnits, content),
      producedJin: toJin(mine.producedUnits, content),
      marketSoldJin: toJin(mine.marketSoldUnits, content),
      gardens,
      towns
    };
  },

  ui: {
    economySection: {
      title: "茶叶",
      render(view, mine) {
        const v = mine || { todayProducedJin: 0, producedJin: 0, marketSoldJin: 0, towns: [] };
        const townRows = (v.towns || []).map(town => `<div class="row"><span class="label">${town.name}茶叶库存</span><strong class="value">${fmtJin(town.stockJin)}斤 · 基准价 ${fmtJin(town.basePrice, 1)}</strong></div>`).join("");
        return `<div class="cardlet">
          <div class="row"><span class="label">今日产量</span><strong class="value">${fmtJin(v.todayProducedJin, 1)}斤</strong></div>
          <div class="row"><span class="label">累计产量</span><strong class="value">${fmtJin(v.producedJin, 1)}斤</strong></div>
          <div class="row"><span class="label">批发市场累计售出</span><strong class="value">${fmtJin(v.marketSoldJin, 1)}斤</strong></div>
        </div>
        <div class="subtle">茶园采茶每人每日 2 斤；居民每年每人用 2 斤，喝茶加舒心值。王镇收价高两成，在外贸面板卖。</div>
        <div class="cardlet">${townRows}</div>`;
      }
    },
    buildingSections: {
      tea_garden(view, building, mine) {
        const gardenJin = mine?.gardens?.[building.id] ?? 0;
        return `<div class="cardlet"><div class="row"><span class="label">茶园等级</span><strong class="value">${building.level || 1} 级</strong></div>`
          + `<div class="row"><span class="label">本园累计产量</span><strong class="value">${fmtJin(gardenJin, 1)}斤</strong></div></div>`
          + `<div class="subtle">全镇今日产茶 ${fmtJin(mine?.todayProducedJin ?? 0, 1)} 斤。</div>`;
      }
    }
  },

  art: {
    tea_garden: teaGardenArt
  },

  validate(state) {
    const mine = state.mods?.tea;
    if (!mine) return [];
    const errors = [];
    const checks = [
      ["producedUnits", "累计产量"], ["marketSoldUnits", "商店售出"],
      ["todayProducedUnits", "今日产量"]
    ];
    for (const [key, label] of checks) {
      const value = mine[key] ?? 0;
      if (!Number.isFinite(value) || value < 0) errors.push(`${label}无效（${value}）`);
    }
    for (const [id, units] of Object.entries(mine.gardens || {})) {
      if (!Number.isFinite(units) || units < 0) errors.push(`茶园 ${id} 的累计产量无效（${units}）`);
    }
    return errors;
  }
});
