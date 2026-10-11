// 贵金属 mod · 行为。银条、金条的产量与库存由 systems/outside-town.js 的矿产扩展（good.mine）每天结算；
// 买卖走核心手动外贸（付小麦，镇库小麦不得低于口粮储备线；买到的矿产直接入批发市场库存）。本 mod 只做只读视图、经营页卡片与校验，
// 不写 state，不登记命令。
import { defineMod } from "../api.js";
import { currentPrice } from "../../systems/outside-town.js";

const ITEMS = ["silver_bar", "gold_bar"];

const fmt = (value, digits = 0) => (Number(value) || 0).toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const isNonNegative = value => Number.isFinite(value) && value >= 0;

// 每座矿产（外镇 × 矿产商品）一行。全部只读。
function mineRows(state, content) {
  const scale = content.precision.inventoryUnitsPerJin;
  const rows = [];
  for (const [townId, profile] of Object.entries(content.outsideTowns || {})) {
    const town = state.outsideTowns?.[townId] || null;
    for (const [itemId, good] of Object.entries(profile.goods || {})) {
      if (!good.mine) continue;
      const annualOutputJin = Number(town?.mines?.[itemId]?.annualOutputJin ?? good.mine.annualOutputJin) || 0;
      const stockJin = Number(town?.stocks?.[itemId]) || 0;
      const stat = town?.stats?.byItem?.[itemId] || {};
      rows.push({
        townId,
        townName: profile.name,
        itemId,
        name: content.items[itemId]?.name || itemId,
        unit: content.items[itemId]?.unit || "斤",
        annualOutputJin,
        stockJin,
        stockYears: annualOutputJin > 0 ? stockJin / annualOutputJin : null,
        // 买价：外镇卖给我们（我们付小麦）；卖价：外镇收购我们的（它付小麦）。单位：斤小麦/斤。
        buyPrice: currentPrice(state, content, townId, itemId, "buy"),
        sellPrice: currentPrice(state, content, townId, itemId, "sell"),
        ourStockJin: (Number(state.accounts?.town?.[itemId]) || 0) / scale,
        boughtJin: Number(stat.importJin) || 0,
        soldJin: Number(stat.exportJin) || 0
      });
    }
  }
  return rows;
}

export default defineMod({
  id: "precious_metals",

  select(state, content) {
    return { mines: mineRows(state, content) };
  },

  ui: {
    economySection: {
      title: "特色矿产（银条 · 金条）",
      render(view, mine) {
        const rows = mine?.mines || [];
        if (rows.length === 0) return `<div class="subtle">暂无矿产。</div>`;
        const body = rows.map(row => `<div class="row"><span class="label">${row.townName}·${row.name}</span>`
          + `<strong class="value">年产${fmt(row.annualOutputJin)}斤 · 外镇库存${fmt(row.stockJin)}斤 · 我镇${fmt(row.ourStockJin, 2)}斤</strong></div>`
          + `<div class="row"><span class="label">买 / 卖（小麦斤/${row.unit}）</span>`
          + `<strong class="value">${fmt(row.buyPrice, 2)} / ${fmt(row.sellPrice, 2)} · 累计买${fmt(row.boughtJin, 2)}斤 卖${fmt(row.soldJin, 2)}斤</strong></div>`).join("");
        return `<div class="cardlet">${body}</div><div class="subtle">银条、金条用小麦在外贸面板买卖；买到的入批发市场库存（冶炼厂原料），贸易行与长期协定不做。</div>`;
      }
    }
  },

  // 校验：矿产的年产量、库存为非负有限数；镇库的银条金条为非负整数单位（精度见 precision.inventoryUnitsPerJin）。
  validate(state, content) {
    const errors = [];
    for (const [townId, profile] of Object.entries(content.outsideTowns || {})) {
      const town = state.outsideTowns?.[townId];
      if (!town) continue;
      for (const [itemId, good] of Object.entries(profile.goods || {})) {
        if (!good.mine) continue;
        const name = `${profile.name}${content.items[itemId]?.name || itemId}`;
        const mine = town.mines?.[itemId];
        if (!mine || !isNonNegative(mine.annualOutputJin)) errors.push(`${name}的年产量无效`);
        if (!mine || !Number.isFinite(mine.lastYear)) errors.push(`${name}的产量年份无效`);
        if (!isNonNegative(town.stocks?.[itemId])) errors.push(`${name}的库存无效（${town.stocks?.[itemId]}）`);
      }
    }
    for (const itemId of ITEMS) {
      const units = state.accounts?.town?.[itemId] ?? 0;
      if (!Number.isInteger(units) || units < 0) errors.push(`镇库${content.items[itemId]?.name || itemId}数量无效（${units}）`);
    }
    return errors;
  }
});
