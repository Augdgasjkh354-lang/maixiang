// 陶器 mod · 行为。内容之外只做两件事：只读视图（陶窑数、批发库存）与美术。
// 陶土坑、陶窑的产出、用工、收付钱货全部由核心系统按 content.js 的定义完成。
import { defineMod } from "../api.js";

const KILN_ART_BODY = `
<g stroke="#7a5a43" stroke-width="1">
  <path d="M-42 34V6Q-42-26 2-28Q46-26 46 6V34Z" fill="#b08462"/>
  <path d="M-42 6Q-30-18 2-20Q34-18 46 6" fill="none" stroke="#8c6548" stroke-width="1.2"/>
  <g fill="none" stroke="#8c6548" stroke-width="1" opacity=".75">
    <path d="M-40 16h80M-41 26h82"/>
    <path d="M-22-4v12M-6-14v12M10-14v12M26-4v12"/>
    <path d="M-30-10v10M-14-20v8M2-22v6M18-20v8M34-10v10"/>
  </g>
  <path d="M-12 34V16Q-12 6 2 6Q16 6 16 16V34Z" fill="#4a2e22" stroke="#3b2418"/>
  <path d="M-8 34V20Q-8 14 2 14Q10 14 10 20V34Z" fill="#c2622f" stroke="none" opacity=".85"/>
  <path d="M-22-40Q-28-46-22-52Q-16-58-22-64" fill="none" stroke="#b9b5a8" stroke-width="3" stroke-linecap="round" opacity=".7"/>
  <path d="M-30-30Q-36-36-30-42" fill="none" stroke="#c9c5b8" stroke-width="2.5" stroke-linecap="round" opacity=".55"/>
  <path d="M-16-60Q-10-66-16-72" fill="none" stroke="#c9c5b8" stroke-width="2.5" stroke-linecap="round" opacity=".45"/>
  <g fill="#8c6548" stroke="#6b4a36" stroke-width=".8">
    <path d="M-38 36l0-6 8-4 6 4v6Z"/><path d="M28 36l0-6 8-4 6 4v6Z"/>
  </g>
</g>`;

const CLAY_PIT_ART_BODY = `
<g stroke="#7a5a43" stroke-width="1">
  <ellipse cx="0" cy="22" rx="58" ry="18" fill="#8f6a4c" stroke="#6b4a36"/>
  <ellipse cx="0" cy="20" rx="46" ry="13" fill="#4f3828" stroke="#3b2a1e"/>
  <path d="M-46 22Q-46 14 -34 12" fill="none" stroke="#c9a77e" stroke-width="2"/>
  <g fill="#b08462" stroke="#7a5a43">
    <path d="M-34 14Q-30 2-18 4Q-10-4 0 2Q10-6 20 4Q32 2 36 14Q28 22 12 22Q-4 24-16 22Q-30 22-34 14Z"/>
    <path d="M-26 22Q-22 14-12 14Q-4 12 2 16Q-6 22-26 22Z" fill="#9a7052"/>
  </g>
  <g fill="#c9a77e" stroke="#7a5a43" stroke-width=".8">
    <ellipse cx="-44" cy="30" rx="10" ry="5"/><ellipse cx="46" cy="28" rx="9" ry="4.5"/>
    <ellipse cx="22" cy="34" rx="8" ry="4"/>
  </g>
  <g transform="translate(30 4) rotate(18)">
    <path d="M0-44V2" stroke="#8c6548" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M-5-44h10" stroke="#8c6548" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M-6 0h12v8q-6 7-12 0Z" fill="#9aa0a0" stroke="#5f6566"/>
  </g>
  <g transform="translate(-50 10)">
    <path d="M-8 0h16l-2 14h-12Z" fill="#a3835a" stroke="#6b4a36"/>
    <path d="M-8 0q8-6 16 0" fill="#c9a77e" stroke="#7a5a43"/>
  </g>
  <g fill="none" stroke="#8c6548" stroke-width="1" opacity=".6"><path d="M-10 26h10M18 28h12"/></g>
</g>`;

export default defineMod({
  id: "pottery",

  // 只读视图：陶窑数量（全镇建筑）与批发市场陶器库存（件）。
  select(state, content) {
    const perUnit = content.precision.inventoryUnitsPerJin;
    const kilnCount = (state.buildings || []).filter(row => row.typeId === "kiln").length;
    const potteryUnits = (state.accounts?.town?.pottery || 0) + (state.wholesaleMarket?.inventory?.pottery || 0);
    return {
      kilnCount,
      potteryStockPieces: potteryUnits / perUnit
    };
  },

  ui: {
    economySection: {
      title: "陶器",
      render: (view, mine) => `<div class="cardlet">
        <div class="row"><span class="label">陶窑</span><strong class="value">${mine?.kilnCount ?? 0} 座</strong></div>
        <div class="row"><span class="label">镇库与批发市场陶器库存</span><strong class="value">${Math.floor(mine?.potteryStockPieces ?? 0)} 件</strong></div></div>
        <div class="subtle">陶土坑采土，陶窑以陶土加木柴烧制陶器；陶器居民日用，民镇、王镇也来买。</div>`
    }
  },

  // 建筑美术：返回 SVG 片段（坐标与 ui/building-art.js 一致，约 120 宽、底部中心在 0,36）。
  art: {
    kiln: () => `<g class="pottery-kiln">${KILN_ART_BODY}</g>`,
    clay_pit: () => `<g class="pottery-clay-pit">${CLAY_PIT_ART_BODY}</g>`
  },

  validate() {
    return [];
  }
});
