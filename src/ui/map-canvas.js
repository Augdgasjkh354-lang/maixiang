/**
 * src/ui/map-canvas.js
 *
 * 江南舆图版本：整幅地图已由 SVG 景观（jiangnan-art.js 的 townLandscape）
 * 与江南建筑库（building-art.js）覆盖，逐格 canvas 地形不再需要。
 *
 * 这里保留同名导出，让 app.js 的调用点与 canvas 元素继续有效，
 * 但不绘制任何内容。terrain-art.js 文件本身保持不动，供其他引用继续使用。
 */
export function drawVillageMapCanvas() {
  // 无操作：地形与建筑改由 SVG 渲染。
}
