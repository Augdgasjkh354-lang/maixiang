// 某类建筑的最高等级：建筑定义里的 upgrade.maxLevel 优先，没写则用 rules.buildingMaxLevel（默认 10）。
export function buildingMaxLevel(content, typeId) {
  return content.buildings?.[typeId]?.upgrade?.maxLevel || content.rules?.buildingMaxLevel || 10;
}
