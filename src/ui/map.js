import { escapeHtml, number } from "./format.js";
import { renderBuildingArt } from "./building-art.js";
import { townLandscape, houseArt, wellArt, miniMap } from "./jiangnan-art.js";

export const MAP_WIDTH = 2400;
export const MAP_HEIGHT = 1800;

// 兼容：优先读多个在建工程，旧调用方只给单工程 view.project 时也能渲染。
function viewProjects(view) {
  if (Array.isArray(view.projects)) return view.projects;
  return view.project ? [view.project] : [];
}

function mapLabel(name, detail = "") {
  return `<g class="map-label"><rect x="-64" y="-15" width="128" height="26" rx="13"/><text y="3">${escapeHtml(name)}${detail ? ` · ${escapeHtml(detail)}` : ""}</text></g>`;
}

function staticSite(siteId, title, x, y, symbol, selected) {
  return `<g class="map-site static-site ${siteId}${selected ? " selected" : ""}" data-site="${siteId}" role="button" tabindex="0" aria-label="查看${escapeHtml(title)}" transform="translate(${x} ${y})">
    <ellipse class="map-hit" cx="0" cy="0" rx="74" ry="61"/>${symbol}${selected ? mapLabel(title) : ""}
  </g>`;
}

function staticSites(view) {
  // 粮仓 / 村舍 / 古井：沿用江南建筑库与古井符号重绘，
  // 但保留 data-site 点击区与选中标签，panel-site.js 的面板逻辑不受影响。
  const granarySymbol = `<g class="granary-art ink-site">${houseArt("granary", 1.05)}</g>`;
  const housesSymbol = `<g class="houses-art ink-site">
    <g transform="translate(-34 6) scale(.62)">${houseArt("housing", 1)}</g>
    <g transform="translate(30 12) scale(.52)">${houseArt("housing", 1)}</g>
  </g>`;
  const wellSymbol = `<g class="well-art ink-site">${wellArt()}</g>`;
  return [
    `<g class="map-site static-site field${view.selectedSite === "field" ? " selected" : ""}" data-site="field" role="button" tabindex="0" aria-label="查看镇有麦田"><ellipse class="map-hit" cx="270" cy="250" rx="205" ry="145"/>${view.selectedSite === "field" ? `<g transform="translate(270 135)">${mapLabel("镇有麦田")}</g>` : ""}</g>`,
    staticSite("granary", "共用粮仓", 550, 284, granarySymbol, view.selectedSite === "granary"),
    staticSite("houses", "村舍", 779, 349, housesSymbol, view.selectedSite === "houses"),
    staticSite("well", "古井", 502, 380, wellSymbol, view.selectedSite === "well")
  ].join("");
}

function loggingShape() {
  return '<g class="resource-pile">' +
    '<ellipse class="resource-stump" cx="20" cy="16" rx="15" ry="8"/>' +
    '<rect class="resource-log" x="-44" y="-6" width="84" height="22" rx="11"/>' +
    '<rect class="resource-log" x="-30" y="-27" width="70" height="21" rx="10"/>' +
    '<rect class="resource-log" x="-17" y="-46" width="42" height="19" rx="9"/>' +
    '<ellipse class="resource-log-end" cx="-36" cy="5" rx="7" ry="11"/>' +
    '<ellipse class="resource-log-end" cx="-22" cy="-16" rx="6" ry="10"/>' +
    '<ellipse class="resource-log-end" cx="-11" cy="-36" rx="5" ry="9"/>' +
    '<path class="resource-axe-handle" d="M22 12L44-34"/>' +
    '<path class="resource-axe-head" d="M38-38Q56-52 60-34L52-30Q48-42 40-34Z"/>' +
    "</g>";
}

function saltShape() {
  return '<g class="resource-pile">' +
    '<ellipse class="resource-ground" cx="0" cy="22" rx="60" ry="10"/>' +
    '<path class="resource-rock" d="M-54 22Q-46-12-18-22Q2-30 20-20Q46-8 54 22Z"/>' +
    '<path class="resource-rock-shade" d="M-4-24Q20-14 20 22H54Q46-8 20-20Q6-26-4-24Z"/>' +
    '<path class="resource-crystal" d="M-26-6L-20-34L-12-8Z"/>' +
    '<path class="resource-crystal" d="M-12-10L-2-50L8-12Z"/>' +
    '<path class="resource-crystal" d="M6-10L16-40L24-8Z"/>' +
    '<path class="resource-vein" d="M-2-58v8M-6-54h8M22-48v6M19-45h6"/>' +
    "</g>";
}

function resourceSite(plot, selected) {
  const x = plot.x * 12;
  const y = plot.y * 10;
  const salt = plot.feature === "salt_mine";
  const title = salt ? "盐矿资源点" : "伐木资源点";
  const tag = salt ? "盐矿" : "伐木点";
  const shape = salt ? saltShape() : loggingShape();
  return '<g class="map-site resource-site ' + (salt ? "salt" : "forest") +
    (selected ? " selected" : "") + '" data-site="resource:' + escapeHtml(plot.id) +
    '" role="button" tabindex="0" aria-label="查看' + title + '" transform="translate(' +
    x + " " + y + ')"><ellipse class="map-hit" cx="0" cy="2" rx="48" ry="38"/>' +
    shape +
    '<g class="resource-tag"><rect x="-40" y="30" width="80" height="21" rx="10.5"/><text x="0" y="45">' + tag + "</text></g>" +
    (selected ? '<g transform="translate(0 -78)">' + mapLabel(title) + "</g>" : "") + "</g>";
}

function renderParcel(plot) {
  const x = plot.x * 12;
  const y = plot.y * 10;
  return `<rect class="plot-parcel" x="${x - 48}" y="${y - 36}" width="96" height="72" rx="12" fill="#f3f1dc" fill-opacity=".5" stroke="#9fa687" stroke-opacity=".7" stroke-width="2" stroke-dasharray="10 7"/>`;
}

function walkingPeople() {
  const people = [
    { x: 456, y: 467, cls: "walker-one", coat: "#5e6c53" },
    { x: 647, y: 445, cls: "walker-two", coat: "#9a5742" },
    { x: 811, y: 470, cls: "walker-three", coat: "#4f7480" },
    { x: 621, y: 484, cls: "walker-four", coat: "#b08945" }
  ];
  return `<g class="villagers" aria-hidden="true">${people.map(person => `<g class="villager ${person.cls}" transform="translate(${person.x} ${person.y})"><g class="villager-walk"><circle class="villager-head" r="6" cy="-8"/><path class="villager-coat" d="M-6-3Q0-8 6-3l4 16H-10Z" fill="${person.coat}"/><path class="villager-leg" d="M-3 12-5 20m8-8 3 8"/><path class="villager-bundle" d="M6-1q8 0 7 10H7Z"/></g></g>`).join("")}</g>`;
}

function workState(building) {
  return ["ready", "limited_materials"].includes(building.status?.status) ? "working" : "idle";
}

function renderBuilding(building, plot, selected) {
  const x = (Number.isFinite(building.x) ? building.x : plot.x) * 12;
  const y = (Number.isFinite(building.y) ? building.y : plot.y) * 10;
  const state = workState(building);
  const workers = building.jobs.reduce((sum, job) => sum + job.workers, 0);
  return `<g class="map-site production-site ${building.typeId} ${state}${selected ? " selected" : ""}" data-site="building:${escapeHtml(building.id)}" data-building-id="${escapeHtml(building.id)}" role="button" tabindex="0" aria-label="查看${escapeHtml(building.name)}，${escapeHtml(building.status.label)}" transform="translate(${x} ${y})">
    <ellipse class="map-hit" cx="0" cy="0" rx="56" ry="58"/><ellipse class="site-halo" cx="0" cy="17" rx="62" ry="45"/>
    ${renderBuildingArt(building.typeId,{level:building.level,scale:1})}<circle class="status-dot" cx="43" cy="-44" r="8"/>${selected ? `<text class="worker-count" x="0" y="60">${number(workers)}工</text>` : ""}
    ${selected ? mapLabel(building.name, building.status.label) : ""}
  </g>`;
}

function renderProject(project, plot, selected) {
  if (!project || !plot) return "";
  const x = plot.x * 12;
  const y = plot.y * 10;
  const offset = 339 * (1 - (project.percent || 0) / 100);
  const siteId = project.kind === "upgrade" ? `building:${project.buildingId}` : `project:${project.instanceId}`;
  const title = project.kind === "upgrade" ? `${project.name}扩建中` : `${project.name}施工中`;
  return `<g class="map-site project-site selected${project.kind === "upgrade" ? " upgrade-site" : ""}" data-site="${escapeHtml(siteId)}" data-project-id="${escapeHtml(project.instanceId)}" role="button" tabindex="0" aria-label="查看${escapeHtml(title)} ${number(project.percent, 0)}%" transform="translate(${x} ${y})">
    <ellipse class="map-hit" cx="0" cy="0" rx="58" ry="60"/><ellipse class="worksite-ground" cx="0" cy="17" rx="59" ry="39"/>
    ${project.kind === "upgrade" ? "" : renderBuildingArt(project.typeId,{status:"construction",progress:(project.percent||0)/100})}<circle class="project-ring" cx="0" cy="15" r="54" stroke-dasharray="339" stroke-dashoffset="${offset}"/>
    <text class="project-tag" x="0" y="76">${project.kind === "upgrade" ? "扩建" : "营造中"} ${number(project.percent, 0)}%</text>${selected ? mapLabel(project.name, project.kind === "upgrade" ? "扩建中" : "营造中") : ""}
  </g>`;
}

function renderPlot(plot, preview) {
  const x = plot.x * 12;
  const y = plot.y * 10;
  return `<g class="plot-target${preview ? " preview" : ""}" data-plot="${escapeHtml(plot.id)}" role="button" tabindex="0" aria-label="选择${escapeHtml(plot.label)}开工" transform="translate(${x} ${y})">
    <ellipse class="plot-hit" cx="0" cy="0" rx="53" ry="44"/><ellipse class="plot-outline" cx="0" cy="0" rx="53" ry="41"/>
    <path class="plot-cross" d="M-9 0h18M0-9v18"/><text class="plot-name" x="0" y="58">${escapeHtml(plot.label)}</text>
  </g>`;
}

export function renderMap(view, nav) {
  const buildMode = nav.activePanel === "build" && nav.buildType;
  const selectedSite = nav.selectedSite;
  const buildingMarkup = view.buildings.map(building => {
    const plot = view.plots.find(item => item.id === building.plotId) || building;
    return renderBuilding(building, plot, selectedSite === `building:${building.id}`);
  }).join("");
  const projects = viewProjects(view);
  const occupied = new Set(view.buildings.map(building => building.plotId));
  for (const row of projects) occupied.add(row.plotId);
  const buildOption = buildMode
    ? view.constructionOptions.find(option => option.id === nav.buildType)
    : null;
  const plots = buildMode
    ? view.plots.filter(plot => !occupied.has(plot.id) &&
        (!buildOption?.allowedPlotIds || buildOption.allowedPlotIds.includes(plot.id)))
      .map(plot => renderPlot(plot, plot.id === nav.previewPlotId)).join("")
    : "";
  const resources = !buildMode
    ? view.plots.filter(plot => plot.feature).map(plot =>
        resourceSite(plot, selectedSite === "resource:" + plot.id)).join("")
    : "";
  // 每个在建工程各自标注各自地块。
  const project = projects.map(row => {
    const plot = view.plots.find(item => item.id === row.plotId);
    const selected = selectedSite === `project:${row.instanceId}` ||
      (row.kind === "upgrade" && selectedSite === `building:${row.buildingId}`);
    return renderProject(row, plot, selected || !selectedSite);
  }).join("");
  const parcels = !buildMode
    ? view.plots.filter(plot => !plot.feature && !occupied.has(plot.id)).map(renderParcel).join("")
    : "";
  return `<canvas id="mapTerrainCanvas" class="map-art-canvas" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" aria-hidden="true"></canvas><svg class="world-map" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="img" aria-label="麦乡俯视地图" data-season="${view.season.key}" data-paused="${view.paused}">
    ${townLandscape([...occupied])}<g class="plot-parcels" pointer-events="none" aria-hidden="true">${parcels}</g><g class="static-sites">${staticSites(view)}${resources}</g><g class="walker-layer">${walkingPeople()}</g>
    <g class="buildings-layer">${project}${buildingMarkup}</g><g class="build-sites" style="display:${buildMode ? "" : "none"}">${plots}</g>
    <g class="north-mark" transform="translate(1130 95)"><path d="M0 22V-12m0 0-8 13 8-4 8 4Z"/><text y="39">北</text></g>
  </svg>`;
}

// 舆图小地图：可折叠，交给 app.js 挂载到地图区域。
export function renderMiniMap() {
  return `<details class="town-minimap"><summary>舆图 <span>⌃</span></summary>${miniMap()}</details>`;
}

export function mapSignature(view, nav) {
  const buildMode = nav.activePanel === "build" && nav.buildType;
  const buildings = view.buildings.map(building => [
    building.id,
    building.typeId,
    building.plotId,
    building.level || 1,
    building.status?.status || "",
    building.status?.label || "",
    workState(building),
    building.jobs.map(job => `${job.id}:${job.workers}:${job.capacity}`).join(":")
  ].join(",")).join("|");
  const project = viewProjects(view).map(row => [
    row.instanceId,
    row.kind || "build",
    row.buildingId || "",
    row.typeId,
    row.plotId,
    row.workDone ?? "",
    row.workRequired ?? "",
    Number(row.percent || 0).toFixed(3)
  ].join(":")).join("|");
  return [
    view.season.key,
    buildings,
    project,
    nav.selectedSite || "",
    buildMode || "",
    buildMode ? nav.previewPlotId || "" : ""
  ].join(";");
}

export function updateMapMotion(world, view) {
  const svg = world.querySelector(".world-map");
  if (!svg) return;
  svg.dataset.paused = String(view.paused);
  // 多个在建工程：逐块更新进度环与标签。
  const siteProgress = new Map(viewProjects(view).map(row => [
    row.kind === "upgrade" ? `building:${row.buildingId}` : `project:${row.instanceId}`,
    row
  ]));
  for (const site of svg.querySelectorAll(".project-site[data-site]")) {
    const row = siteProgress.get(site.dataset.site);
    if (!row) continue;
    const ring = site.querySelector(".project-ring");
    if (ring) ring.setAttribute("stroke-dashoffset", String(339 * (1 - (row.percent || 0) / 100)));
    const tag = site.querySelector(".project-tag");
    if (tag) tag.textContent = `${row.kind === "upgrade" ? "扩建" : "营造中"} ${number(row.percent, 0)}%`;
  }
}
