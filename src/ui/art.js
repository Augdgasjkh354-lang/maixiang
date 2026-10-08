import { MODS } from "../mods/registry.js";
import { modArt } from "../mods/api.js";
import { renderBuildingArt } from "./building-art.js";
// 运力建筑的卡片图标直接用地图上的同款绘制（缩小），免得建造面板里退回通用民居。
const SHARED_ART_CARD_TYPES = new Set(["logistics_center", "dock", "trade_center"]);
export function uiIcon(name, className = "ui-icon") {
  const paths = {
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c.5-3.4 2.4-5 6-5s5.5 1.6 6 5M16 5.4a3 3 0 0 1 0 5.8M17 15c2.3.4 3.6 2 4 5"/>',
    idle: '<path d="M5 7h14l-1 14H6L5 7Z"/><path d="M8 7V5a4 4 0 0 1 8 0v2M9 12h6"/>',
    grain: '<path d="M12 22V3M12 7C7 7 5 4 5 2c4 0 7 2 7 5Zm0 5c5 0 7-3 7-5-4 0-7 2-7 5Zm0 1c-5 0-7-3-7-5 4 0 7 2 7 5Zm0 5c5 0 7-3 7-5-4 0-7 2-7 5Z"/>',
    store: '<path d="M3 10 5 4h14l2 6M4 10v10h16V10M3 10c0 2 3 2 4 0 1 2 4 2 5 0 1 2 4 2 5 0 1 2 4 2 4 0M9 20v-5h6v5"/>',
    build: '<path d="M3 21h18M5 21V9l7-5 7 5v12M9 21v-7h6v7M3 9h18"/>',
    residents: '<circle cx="12" cy="7" r="3"/><path d="M5 21c.4-4.5 2.7-7 7-7s6.6 2.5 7 7M5 9H3m18 0h-2"/>',
    market: '<path d="M4 11c0-4 3.6-7 8-7s8 3 8 7H4Z"/><path d="M5 11v7c0 2 2 3 7 3s7-1 7-3v-7M9 15h6"/>',
    policy: '<path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.5 2.6-1.7-.6a8 8 0 0 1-1.7 1l-.3 1.8h-3l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.6-1.5-2.6 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.5-2.6 1.7.6a8 8 0 0 1 1.7-1l.3-1.8h3l.3 1.8a8 8 0 0 1 1.7 1l1.7-.6 1.5 2.6-1.4 1.1a7 7 0 0 1 0 2Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.8M4 4v5h5"/>'
  };
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.grain}</svg>`;
}

export function buildingSymbol(type, state = "idle", ghost = false) {
  const classes = `building-art ${type} ${state}${ghost ? " ghost" : ""}`;
  // mod 建筑：用 mod 提供的地图美术缩小成卡片图标。
  const fromMod = modArt(MODS, type);
  if (fromMod) return `<g class="${classes}"><g transform="translate(50 64) scale(.5)">${fromMod({ level: 1 })}</g></g>`;
  if (SHARED_ART_CARD_TYPES.has(type)) return `<g class="${classes}"><g transform="translate(50 64) scale(.5)">${renderBuildingArt(type, { level: 1 })}</g></g>`;
  if (type === "mill") {
    return `<g class="${classes}">
      <ellipse class="building-shadow" cx="50" cy="101" rx="38" ry="7"/>
      <path class="mill-body" d="M22 48 50 31l28 17v45H22Z"/>
      <path class="mill-roof" d="M14 51 50 28l36 23H14Z"/>
      <path class="wood-line" d="M23 54h54M29 60v31M70 60v31"/>
      <rect class="mill-door" x="42" y="69" width="16" height="24" rx="7"/>
      <rect class="mill-window" x="29" y="62" width="8" height="10" rx="3"/><rect class="mill-window" x="63" y="62" width="8" height="10" rx="3"/>
      <g class="mill-sails"><path d="M47 4h6l3 27h-12Z"/><path d="M76 30v6L56 54l-4-9Z"/><path d="M47 57h6l-3 27h-6Z"/><path d="M24 30v6l20 18 4-9Z"/><circle cx="50" cy="44" r="6"/></g>
      <path class="mill-support" d="M47 48 36 91m17-43 11 43"/>
    </g>`;
  }
  if (type === "bakery") {
    return `<g class="${classes}">
      <ellipse class="building-shadow" cx="50" cy="101" rx="39" ry="7"/>
      <path class="bakery-body" d="M17 50 50 34l34 16v42H17Z"/>
      <path class="bakery-roof" d="M11 51 50 28l41 23v7H11Z"/>
      <path class="roof-tile" d="M20 50 50 33l31 17M27 54l28-16m-5 16 29-16"/>
      <rect class="chimney" x="67" y="15" width="11" height="23"/><path class="chimney-cap" d="M65 15h15"/>
      <path class="smoke" d="M72 10c-7-7 4-7 0-14m8 13c-6-5 4-8 0-13"/>
      <rect class="oven-mouth" x="28" y="62" width="23" height="22" rx="10"/><path class="oven-glow" d="M32 77c4-9 11-9 15 0"/>
      <rect class="bakery-door" x="62" y="68" width="12" height="24" rx="6"/>
      <path class="bread-shelf" d="M26 89h29m-23-8c2-4 7-4 9 0m2 0c2-4 7-4 9 0"/>
    </g>`;
  }
  if (type === "lumberyard") {
    return `<g class="${classes}">
      <ellipse class="building-shadow" cx="50" cy="101" rx="39" ry="7"/>
      <path class="bakery-body" d="M18 51 50 35l32 16v40H18Z"/>
      <path class="bakery-roof" d="M12 52 50 28l39 24v6H12Z"/>
      <path class="wood-line" d="M25 59h50M31 59v32M69 59v32"/>
      <path class="timber-stack" d="M21 83h30v6H21Zm4-8h30v6H25Zm4-8h30v6H29Z"/>
      <path class="axe-handle" d="m66 68 13 19"/><path class="axe-head" d="m65 66 8-5 5 6-8 5Z"/>
    </g>`;
  }
  if (type === "saltworks") {
    return `<g class="${classes}">
      <ellipse class="building-shadow" cx="50" cy="101" rx="39" ry="7"/>
      <path class="bakery-body" d="M16 50 50 33l34 17v43H16Z"/>
      <path class="bakery-roof" d="M10 51 50 26l41 25v7H10Z"/>
      <path class="wood-line" d="M21 57h58M26 58v34M74 58v34"/>
      <rect class="salt-kiln" x="57" y="61" width="22" height="31" rx="3"/>
      <path class="salt-mouth" d="M63 83c3-8 8-8 11 0"/>
      <path class="salt-sack" d="m20 88 3-19h19l4 19-6 6H26Z"/>
      <path class="salt-mark" d="M32 75v12m0-8c-5 0-6-3-6-5 4 0 6 2 6 5m0 3c4 0 6-3 6-5-4 0-6 2-6 5Z"/>
      <path class="salt-steam" d="M65 56c-8-8 5-9 0-17m9 16c-6-6 4-9 0-15"/>
    </g>`;
  }
  if (type === "winery") {
    const jar = (cx, cy) => `<path class="wine-jar" d="M${cx - 4} ${cy - 9}h8l1.5 4q3 3 2.5 7h-14q-.5-4 2.5-7Z"/><path class="wine-mouth" d="M${cx - 4.5} ${cy - 9}h9"/>`;
    return `<g class="${classes}">
      <ellipse class="building-shadow" cx="50" cy="101" rx="39" ry="7"/>
      <path class="whitewash" d="M16 50 50 34l34 16v42H16Z"/>
      <path class="grey-tile" d="M10 51 50 27l40 24v7H10Z"/>
      <path class="grey-tile-line" d="M18 52 50 36l32 16M26 57l24-12m-4 12 28-13"/>
      <path class="wood-line" d="M24 60h52"/>
      <rect class="bakery-door" x="44" y="66" width="12" height="26" rx="6"/>
      <rect class="home-window" x="24" y="66" width="10" height="10" rx="3"/><rect class="home-window" x="70" y="66" width="10" height="10" rx="3"/>
      ${jar(24, 92)}${jar(40, 95)}${jar(74, 95)}
      <path class="wood-line" d="M84 18v70"/><path class="wine-banner" d="M84 18l14 4-4 7 4 7-14-4Z"/>
    </g>`;
  }
  if (type === "cotton_field") {
    const bush = (x, y) => `<ellipse class="cotton-bush" cx="${x}" cy="${y}" rx="5.5" ry="3.6"/><circle class="cotton-boll" cx="${x - 2.4}" cy="${y - 1.8}" r="1.7"/><circle class="cotton-boll" cx="${x + 2.4}" cy="${y - 1.2}" r="1.7"/>`;
    return `<g class="${classes}">
      <ellipse class="building-shadow" cx="50" cy="101" rx="42" ry="8"/>
      <path class="cotton-soil" d="M8 74 50 52l42 22-42 24Z"/>
      <path class="cotton-row" d="M22 76l30-15M30 84l28-14M42 92l26-13"/>
      ${bush(31, 71.5)}${bush(40, 67)}${bush(49, 62.5)}${bush(37, 80.5)}${bush(44, 77)}${bush(51, 73.5)}${bush(48.5, 88.5)}${bush(55, 85.5)}${bush(61, 82)}
      <path class="wood-line" d="M8 74 50 98 92 74"/>
      <path class="thatch-wall" d="M61 67v-9h14v9Z"/><path class="thatch" d="M57 60 68 50l11 10-11 3Z"/><rect class="home-door" x="66" y="61" width="4" height="6"/>
    </g>`;
  }
  if (type === "weaving_mill") {
    return `<g class="${classes}">
      <ellipse class="building-shadow" cx="50" cy="101" rx="42" ry="7"/>
      <path class="whitewash" d="M16 50 50 34l34 16v42H16Z"/>
      <path class="grey-tile" d="M10 51 50 27l40 24v7H10Z"/>
      <path class="grey-tile-line" d="M18 52 50 36l32 16M26 57l24-12m-4 12 28-13"/>
      <rect class="loom-bay" x="24" y="66" width="22" height="26" rx="2"/>
      <path class="loom-thread" d="M28 68v22M33 68v22M38 68v22M43 68v22M27 75h18"/>
      <rect class="bakery-door" x="54" y="68" width="10" height="24" rx="5"/>
      <path class="wood-line" d="M76 62v30M92 62v30M76 62h16"/>
      <path class="indigo-cloth" d="M79 62h4v24l-2 3-2-3Z"/><path class="indigo-cloth" d="M85 62h4v18l-2 3-2-3Z"/>
    </g>`;
  }
  if (type === "public_housing") {
    return `<g class="${classes}">
      <ellipse class="building-shadow" cx="50" cy="101" rx="42" ry="8"/>
      <g transform="translate(7 38) scale(.43)"><path class="home-body" d="M8 15 50-4l42 19v55H8Z"/><path class="home-roof" d="M0 18 50-12l50 30-7 8-43-25L7 26Z"/><rect class="home-door" x="43" y="42" width="14" height="28"/><rect class="home-window" x="18" y="31" width="12" height="12"/></g>
      <g transform="translate(33 23) scale(.47)"><path class="home-body" d="M8 15 50-4l42 19v55H8Z"/><path class="home-roof" d="M0 18 50-12l50 30-7 8-43-25L7 26Z"/><rect class="home-door" x="43" y="42" width="14" height="28"/><rect class="home-window" x="18" y="31" width="12" height="12"/></g>
      <g transform="translate(60 40) scale(.39)"><path class="home-body" d="M8 15 50-4l42 19v55H8Z"/><path class="home-roof" d="M0 18 50-12l50 30-7 8-43-25L7 26Z"/><rect class="home-door" x="43" y="42" width="14" height="28"/><rect class="home-window" x="18" y="31" width="12" height="12"/></g>
    </g>`;
  }
  return `<g class="${classes}"><ellipse class="building-shadow" cx="50" cy="101" rx="39" ry="7"/>
    <path class="home-body" d="M15 47 50 25l35 22v47H15Z"/><path class="home-roof" d="M9 48 50 20l42 28-6 8-36-23-35 23Z"/>
    <rect class="home-door" x="42" y="66" width="16" height="28" rx="8"/><rect class="home-window" x="23" y="59" width="11" height="12" rx="4"/><rect class="home-window" x="66" y="59" width="11" height="12" rx="4"/>
    <path class="wood-line" d="M18 94h65"/>
  </g>`;
}
