export const MAP_PRESENTATION = Object.freeze({
  width: 1200,
  height: 1000,
  tileSize: 40,
  columns: 30,
  rows: 25
});

function worldPoint(point) {
  return { x: Number(point.x) * 12, y: Number(point.y) * 10 };
}

function terrainAt(column, row) {
  const x = column * MAP_PRESENTATION.tileSize + MAP_PRESENTATION.tileSize / 2;
  const y = row * MAP_PRESENTATION.tileSize + MAP_PRESENTATION.tileSize / 2;

  // 西侧湖湾、麦田和南部林缘只是画面地形，不进入经营状态。
  // 麦田图形固定占据同一块椭圆区域：开荒只改变经营数据（亩数/人数上限），
  // 不改变地图图形大小，避免“亩数变大、地块变形”。
  const field = ((x - 270) / 205) ** 2 + ((y - 268) / 146) ** 2;
  if (field <= 1) return "farmland";
  if (y >= 105 && y <= 510) {
    const lakeEdge = 112 + 32 * Math.sin((y - 105) / 405 * Math.PI);
    if (x <= lakeEdge) return "water";
  }
  if (y >= 800) return "forest";
  return "grass";
}

export function createMapModel(view, navigation) {
  const plotsById = new Map((view.plots || []).map(plot => [plot.id, plot]));
  const buildings = (view.buildings || []).map(building => {
    const plot = plotsById.get(building.plotId);
    const point = worldPoint({
      x: Number.isFinite(building.x) ? building.x : plot?.x ?? 0,
      y: Number.isFinite(building.y) ? building.y : plot?.y ?? 0
    });
    return {
      instanceId: building.id,
      typeId: building.typeId,
      level: building.level || 1,
      plotId: building.plotId,
      x: point.x,
      y: point.y,
      status: building.status,
      working: ["ready", "limited_materials"].includes(building.status?.status) &&
        (building.jobs || []).some(job => job.workers > 0),
      jobs: (building.jobs || []).map(job => ({
        id: job.id,
        workers: job.workers,
        capacity: job.capacity
      }))
    };
  });

  const occupiedPlotIds = new Set(buildings.map(building => building.plotId));
  // 多个在建工程各自标注各自的地块；兼容只提供单工程 view.project 的旧调用方。
  const rawProjects = Array.isArray(view.projects)
    ? view.projects : (view.project ? [view.project] : []);
  const projectViews = rawProjects.filter(project => plotsById.has(project.plotId));
  for (const project of projectViews) occupiedPlotIds.add(project.plotId);
  const projects = projectViews.map(project => ({
    instanceId: project.instanceId,
    kind: project.kind || "build",
    buildingId: project.buildingId || null,
    typeId: project.typeId,
    plotId: project.plotId,
    plot: plotsById.get(project.plotId),
    x: worldPoint(plotsById.get(project.plotId)).x,
    y: worldPoint(plotsById.get(project.plotId)).y,
    progress: Math.max(0, Math.min(1, (project.percent || 0) / 100))
  }));
  // 兼容单工程访问器：地图旧路径仍可读首个工程。
  const project = projects.length ? projects[0] : null;

  const buildMode = navigation.activePanel === "build" && Boolean(navigation.buildType);
  const buildOption = buildMode
    ? (view.constructionOptions || []).find(option => option.id === navigation.buildType)
    : null;
  const plots = (view.plots || []).map(plot => ({
    ...plot,
    ...worldPoint(plot),
    occupied: occupiedPlotIds.has(plot.id)
  }));
  const world = {
    width: MAP_PRESENTATION.columns,
    height: MAP_PRESENTATION.rows,
    tileSize: MAP_PRESENTATION.tileSize,
    tiles: Object.create(null)
  };
  for (let row = 0; row < world.height; row++) {
    for (let column = 0; column < world.width; column++) {
      world.tiles[`${column},${row}`] = {
        terrain: terrainAt(column, row),
        growthStage: view.season?.key || "spring"
      };
    }
  }

  const buildingsByPlot = new Map(buildings.map(building => [building.plotId, building]));
  const projectsByPlot = new Map(projects.map(row => [row.plotId, row]));
  for (const plot of plots) {
    const column = Math.max(0, Math.min(world.width - 1, Math.floor(plot.x / world.tileSize)));
    const row = Math.max(0, Math.min(world.height - 1, Math.floor(plot.y / world.tileSize)));
    const tile = world.tiles[`${column},${row}`];
    tile.plotId = plot.id;
    tile.occupied = plot.occupied;
    tile.resourceFeature = plot.feature || null;
    tile.building = buildingsByPlot.get(plot.id) || null;
    tile.project = projectsByPlot.get(plot.id) || null;
  }

  return {
    world,
    buildings,
    project,
    projects,
    plots,
    buildMode,
    buildType: buildMode ? navigation.buildType : null,
    previewPlot: buildMode ? plots.find(plot => plot.id === navigation.previewPlotId) || null : null,
    freePlots: buildMode ? plots.filter(plot => !plot.occupied &&
      (!buildOption?.allowedPlotIds || buildOption.allowedPlotIds.includes(plot.id))) : [],
    season: view.season?.key || "spring",
    paused: Boolean(view.paused)
  };
}

export function canvasBackingSize(width, height, pixelRatio = 1) {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(3, pixelRatio) : 1;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    ratio
  };
}
