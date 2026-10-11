// 养牛场的小牛群（金银消费第三期）：纯函数，不依赖其他系统（shops.js、livestock.js、cattle.js 都可以引用，不成环）。
// farm.herd = [{ count（头，整数）, fedDays（已吃够的天数，可为小数）, costUnits（饲料成本基础，券值 × 库存单位口径） }]。
// 每头小牛每日吃 def.herd.feedPerCalfDayJin 斤小麦，养满 def.herd.growthDays 天出栏成耕牛。

export function herdHeads(farm) {
  let heads = 0;
  for (const cohort of farm?.herd || []) heads += Math.max(0, cohort.count || 0);
  return heads;
}

// 存栏小牛全部吃饱一天需要的小麦（库存单位）。
export function herdFeedNeedUnits(farm, def, content) {
  return Math.ceil(herdHeads(farm) * (def.herd?.feedPerCalfDayJin || 0) * content.precision.inventoryUnitsPerJin);
}

// 排产时预计明天要买的饲料：存栏 + 明天新开的小牛（startHeads 头）。
export function herdFeedPlanUnits(farm, def, startHeads, content) {
  return Math.ceil((herdHeads(farm) + Math.max(0, startHeads)) * (def.herd?.feedPerCalfDayJin || 0) * content.precision.inventoryUnitsPerJin);
}
