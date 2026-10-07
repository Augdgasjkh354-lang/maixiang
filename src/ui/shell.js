import { uiIcon } from "./art.js";
import { renderMiniMap } from "./map.js";

export const SHELL_HTML = `<main class="shell">
  <header class="hud">
    <div class="resource-bar" aria-label="小镇资源">
      <button class="resource-pill" data-resource="residents" aria-label="查看小镇人口"><span class="resource-icon">${uiIcon("people")}</span><span><span class="resource-label">人口</span> <b id="populationStat">1,000</b></span></button>
      <button class="resource-pill" data-resource="residents" aria-label="查看待业人数"><span class="resource-icon idle-icon">${uiIcon("idle")}</span><span><span class="resource-label">待业</span> <b id="idleStat">200</b></span></button>
      <button class="resource-pill" data-resource="business" aria-label="查看居民口粮"><span class="resource-icon grain-icon">${uiIcon("grain")}</span><span><span class="resource-label">居民</span> <b id="residentStat">73万</b></span></button>
      <button class="resource-pill" data-resource="business" aria-label="查看镇库储备"><span class="resource-icon store-icon">${uiIcon("store")}</span><span><span class="resource-label">镇库</span> <b id="townStat">73万</b></span></button>
    </div>
    <div class="time-row">
      <div class="date-block" aria-live="polite"><div class="brand-title">麦乡 <span>镇务簿</span></div><strong id="dateLabel">第1年 · 春 · 第1天</strong><span id="timeLabel">时光暂停</span></div>
      <div class="time-controls" role="group" aria-label="日期与时光速度">
        <button id="pauseBtn" class="time-button selected" aria-pressed="true" aria-label="暂停">${uiIcon("pause")}<span>停</span></button>
        <button data-speed="1" class="time-button" aria-pressed="false" aria-label="1倍速度">1×</button>
        <button data-speed="4" class="time-button" aria-pressed="false" aria-label="4倍速度">4×</button>
        <button data-speed="16" class="time-button" aria-pressed="false" aria-label="16倍速度">16×</button>
        <button id="settingsBtn" class="time-button settings-button" aria-label="设置">${uiIcon("settings")}</button>
      </div>
    </div>
  </header>

  <section class="game-frame" aria-label="麦乡镇务">
    <section class="map-stage" id="mapStage" data-season="spring" role="region" aria-label="可拖动和缩放的麦乡俯视地图">
      <div class="map-world" id="mapWorld"></div>
      ${renderMiniMap()}
      <div class="map-topline">
        <span class="map-ribbon">秋收预估 <b id="forecastMap">1,600,000斤</b><i></i> 口粮可吃 <b id="daysMap">365天</b></span>
      </div>
      <div class="map-hint" id="mapHint" hidden></div>
      <div class="map-side">
        <details class="macro-panel" id="macroPanel"><summary id="macroSummary">宏观</summary><div class="macro-body" id="macroBody"></div><div class="econ-title" id="econSummary">劳动力与走势</div><div class="econ-body" id="econBody"></div></details>
      </div>
      <div class="map-zoom" role="group" aria-label="地图缩放">
        <button data-map-zoom="1" aria-label="放大地图">＋</button><button data-map-reset aria-label="复位地图">${uiIcon("reset")}</button><button data-map-zoom="-1" aria-label="缩小地图">−</button>
      </div>
      <div class="event-float" id="eventFloat"><button id="eventToggle" class="event-toggle" aria-expanded="false">镇上近事 <span id="latestEvent">新任镇长上任</span></button><button class="event-close" id="eventClose" aria-label="收起事件">${uiIcon("close")}</button><div class="event-history" id="eventHistory" hidden></div></div>
      <aside class="panel-surface" id="panelSurface" data-panel-surface hidden aria-label="镇务面板">
        <div class="panel-grip" aria-hidden="true"><span></span></div>
        <div class="panel-heading"><span class="panel-kicker" id="panelKicker">镇务</span><button id="panelClose" class="panel-close" aria-label="关闭面板">${uiIcon("close")}</button></div>
        <div class="panel" id="panel" aria-live="polite"></div>
      </aside>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </section>
    <nav class="bottom-nav" aria-label="镇务入口">
      <button class="tab" data-panel="build">${uiIcon("build")}<span>建设</span></button>
      <button class="tab" data-panel="residents">${uiIcon("residents")}<span>镇民</span></button>
      <button class="tab" data-panel="business">${uiIcon("market")}<span>经营</span></button>
      <button class="tab" data-panel="policy">${uiIcon("policy")}<span>政策</span></button>
    </nav>
  </section>
</main>`;
