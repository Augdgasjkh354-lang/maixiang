import { MAP_HEIGHT, MAP_WIDTH } from "./map.js";

const MIN_ZOOM = 0.42;
const MAX_ZOOM = 1.55;

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function createMapCamera(stage, world) {
  const pointers = new Map();
  let scale = 1;
  let x = 0;
  let y = 0;
  let gesture = null;
  let suppressClick = false;
  let suppressTimer = null;
  let velocityX = 0;
  let velocityY = 0;
  let initialized = false;
  let disposed = false;

  function clampScale(value) {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
  }

  function bounds() {
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const drawnWidth = MAP_WIDTH * scale;
    const drawnHeight = MAP_HEIGHT * scale;
    const minX = Math.min(0, stageWidth - drawnWidth);
    const maxX = Math.max(0, (stageWidth - drawnWidth) / 2);
    const minY = Math.min(0, stageHeight - drawnHeight);
    const maxY = Math.max(0, (stageHeight - drawnHeight) / 2);
    x = Math.max(minX, Math.min(maxX, x));
    y = Math.max(minY, Math.min(maxY, y));
  }

  function apply() {
    if (disposed) return;
    bounds();
    world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    // 舆图视口指示框：随平移与缩放同步。
    const rect = document.getElementById("miniViewport");
    if (rect) {
      rect.setAttribute("x", -x / scale);
      rect.setAttribute("y", -y / scale);
      rect.setAttribute("width", stage.clientWidth / scale);
      rect.setAttribute("height", stage.clientHeight / scale);
    }
  }

  // 初始视野：以小镇为中心（小镇位于地图西部；东侧与东南新增空地在这个矩形内，南端河岸空地需平移查看）。
  const TOWN_FRAME = { x: 0, y: 60, width: 1650, height: 1440, centerX: 825, centerY: 780 };
  // 窄屏（手机竖屏）用的近景框：整镇框得太小时，改取建筑更清楚的一块。
  const NARROW_FRAME = { x: 180, y: 200, width: 970, height: 760, centerX: 650, centerY: 560 };
  // 整镇框随地块扩大而变大，可读下限相应放低；过低时仍改用近景框。
  const READABLE_TOWN_SCALE = 0.5;

  function fitInitial() {
    if (!stage.clientWidth || !stage.clientHeight) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const fitScale = (frame) => Math.min(sw / frame.width, sh / frame.height) * .94;
    let frame = TOWN_FRAME;
    if (clampScale(fitScale(TOWN_FRAME)) < READABLE_TOWN_SCALE) frame = NARROW_FRAME;
    scale = clampScale(fitScale(frame));
    x = sw / 2 - frame.centerX * scale;
    y = sh / 2 - frame.centerY * scale;
    initialized = true;
    apply();
  }

  function pointInsideStage(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function zoomAt(nextScale, screenPoint) {
    const point = screenPoint || { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
    const worldX = (point.x - x) / scale;
    const worldY = (point.y - y) / scale;
    scale = clampScale(nextScale);
    velocityX = 0;
    velocityY = 0;
    x = point.x - worldX * scale;
    y = point.y - worldY * scale;
    apply();
  }

  function zoomBy(amount, screenPoint) {
    zoomAt(scale * (amount > 0 ? 1.2 : 1 / 1.2), screenPoint);
  }

  function reset() {
    fitInitial();
    pointers.clear();
    gesture = null;
    velocityX = 0;
    velocityY = 0;
  }

  function setPointerCapture(pointerId) {
    try { stage.setPointerCapture(pointerId); } catch {}
  }

  function onPointerDown(event) {
    if (event.target.closest?.("button, input, [data-panel-surface]") && !event.target.closest?.("[data-plot], [data-site]")) return;
    const point = pointInsideStage(event.clientX, event.clientY);
    pointers.set(event.pointerId, point);
    stage.classList.add("map-drag-ready");
    if (pointers.size === 1) {
      velocityX = 0;
      velocityY = 0;
      gesture = {
        mode: "pan",
        pointerId: event.pointerId,
        start: point,
        last: point,
        originX: x,
        originY: y,
        moved: false
      };
      return;
    }
    if (pointers.size >= 2) {
      const points = Array.from(pointers.values()).slice(0, 2);
      const center = midpoint(points[0], points[1]);
      gesture = {
        mode: "pinch",
        center,
        distance: Math.max(1, distance(points[0], points[1])),
        scale,
        worldX: (center.x - x) / scale,
        worldY: (center.y - y) / scale,
        moved: false
      };
      velocityX = 0;
      velocityY = 0;
      for (const id of pointers.keys()) setPointerCapture(id);
    }
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    const point = pointInsideStage(event.clientX, event.clientY);
    pointers.set(event.pointerId, point);
    if (!gesture) return;
    if (gesture.mode === "pinch" && pointers.size >= 2) {
      const points = Array.from(pointers.values()).slice(0, 2);
      const center = midpoint(points[0], points[1]);
      const nextScale = clampScale(gesture.scale * distance(points[0], points[1]) / gesture.distance);
      scale = nextScale;
      x = center.x - gesture.worldX * scale;
      y = center.y - gesture.worldY * scale;
      gesture.moved = true;
      event.preventDefault();
      stage.classList.add("is-dragging");
      apply();
      return;
    }
    if (gesture.mode === "pan" && gesture.pointerId === event.pointerId) {
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 5) return;
      gesture.moved = true;
      velocityX = Math.max(-34, Math.min(34, point.x - gesture.last.x));
      velocityY = Math.max(-34, Math.min(34, point.y - gesture.last.y));
      gesture.last = point;
      setPointerCapture(event.pointerId);
      x = gesture.originX + dx;
      y = gesture.originY + dy;
      event.preventDefault();
      stage.classList.add("is-dragging");
      apply();
    }
  }

  function markClickSuppressed() {
    suppressClick = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppressClick = false; }, 350);
  }

  function onPointerUp(event) {
    const moved = Boolean(gesture?.moved);
    pointers.delete(event.pointerId);
    try { stage.releasePointerCapture(event.pointerId); } catch {}
    if (moved) markClickSuppressed();
    if (pointers.size === 1) {
      const [pointerId, point] = pointers.entries().next().value;
      gesture = { mode: "pan", pointerId, start: point, last: point, originX: x, originY: y, moved: false };
      velocityX = 0;
      velocityY = 0;
    } else {
      gesture = null;
      if (moved && event.pointerType === "touch" && pointers.size === 0 && Math.abs(velocityX) < 1 && Math.abs(velocityY) < 1) {
        velocityX = 0;
        velocityY = 0;
      }
    }
    if (!pointers.size) stage.classList.remove("is-dragging", "map-drag-ready");
  }

  function onWheel(event) {
    event.preventDefault();
    const point = pointInsideStage(event.clientX, event.clientY);
    zoomAt(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), point);
  }

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove, { passive: false });
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("wheel", onWheel, { passive: false });
  // 舆图小地图：点击任意位置，把地图中心移到该处。
  const mini = document.getElementById("townMini");
  function onMiniMapClick(event) {
    const rect = mini.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    x = stage.clientWidth / 2 - ((event.clientX - rect.left) / rect.width) * MAP_WIDTH * scale;
    y = stage.clientHeight / 2 - ((event.clientY - rect.top) / rect.height) * MAP_HEIGHT * scale;
    velocityX = 0;
    velocityY = 0;
    apply();
  }
  if (mini) mini.addEventListener("click", onMiniMapClick);
  const resizeObserver = new ResizeObserver(() => {
    if (!initialized) fitInitial();
    else apply();
  });
  resizeObserver.observe(stage);
  fitInitial();

  return {
    zoomBy,
    reset,
    step() {
      if (disposed || pointers.size || (Math.abs(velocityX) < .22 && Math.abs(velocityY) < .22)) {
        velocityX = Math.abs(velocityX) < .22 ? 0 : velocityX;
        velocityY = Math.abs(velocityY) < .22 ? 0 : velocityY;
        return false;
      }
      const nextX = x + velocityX;
      const nextY = y + velocityY;
      x = nextX;
      y = nextY;
      bounds();
      if (x !== nextX) velocityX = 0;
      else velocityX *= .88;
      if (y !== nextY) velocityY = 0;
      else velocityY *= .88;
      apply();
      return true;
    },
    consumeSuppressedClick() {
      if (!suppressClick) return false;
      suppressClick = false;
      clearTimeout(suppressTimer);
      return true;
    },
    destroy() {
      disposed = true;
      resizeObserver.disconnect();
      clearTimeout(suppressTimer);
      if (mini) mini.removeEventListener("click", onMiniMapClick);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerUp);
      stage.removeEventListener("wheel", onWheel);
    }
  };
}
