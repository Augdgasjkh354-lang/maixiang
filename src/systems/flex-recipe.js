// 弹性配方（动态酒品阀门）：一批总产能 flex.totalJin 斤，按各产出的批发市场缺口分配。
// 镇营（production.js）、民营（private-industry.js）、公司（companies.js）共用这里的分配，不各写一套。
//
// 缺口 room_i = max(0, 目标库存_i − 现存_i)，目标库存见 wholesale-market.js 的 townOutputTargetUnits，现存 = 批发市场 + 镇库（库存单位）。
// 总产能 C（库存单位）= 批次数 × totalJin × 每斤单位数。按缺口占比分配 C，单品不超过缺口；剩余产能按剩余缺口再分，最多 4 轮。
// 所有缺口都为 0 时当日不开工（和单品市场闸门一致）。小麦按各酒每斤的麦耗折算，超出可用小麦时按比例缩减各酒产出。
import { hasWholesaleMarket, townOutputTargetUnits } from "./wholesale-market.js";

const ALLOCATION_ROUNDS = 4;

export function flexOf(recipe) {
  return recipe?.flex || null;
}

// 各弹性产出的缺口（库存单位）。没有批发市场时缺口为无限，按份额平分产能。
export function flexRoomUnits(state, recipe, content) {
  const rooms = {};
  const market = hasWholesaleMarket(state);
  for (const itemId of recipe.flex.itemIds) {
    if (!market) { rooms[itemId] = Number.POSITIVE_INFINITY; continue; }
    const stock = Math.max(0, state.wholesaleMarket?.inventory?.[itemId] || 0) + Math.max(0, state.accounts?.town?.[itemId] || 0);
    rooms[itemId] = Math.max(0, townOutputTargetUnits(state, itemId, content) - stock);
  }
  return rooms;
}

// 按缺口占比分配产能（库存单位，整数）。rooms 只读。
export function flexAllocate(rooms, capacityUnits) {
  const ids = Object.keys(rooms);
  const alloc = Object.fromEntries(ids.map(id => [id, 0]));
  let remaining = Math.max(0, Math.floor(capacityUnits || 0));
  if (!ids.length || remaining <= 0) return alloc;
  if (ids.some(id => !Number.isFinite(rooms[id]))) {
    const share = Math.floor(remaining / ids.length);
    for (const id of ids) alloc[id] = share;
    alloc[ids[0]] += remaining - share * ids.length;
    return alloc;
  }
  for (let round = 0; round < ALLOCATION_ROUNDS && remaining > 0; round += 1) {
    const open = ids.filter(id => rooms[id] - alloc[id] > 0);
    const totalOpen = open.reduce((sum, id) => sum + (rooms[id] - alloc[id]), 0);
    if (totalOpen <= 0) break;
    const give = Math.min(remaining, totalOpen);
    let used = 0;
    for (const id of open) {
      const gap = rooms[id] - alloc[id];
      const add = Math.min(gap, Math.floor(give * gap / totalOpen));
      alloc[id] += add;
      used += add;
    }
    remaining -= used;
    if (used === 0) break;
  }
  return alloc;
}

// 一日的分配结果：units（各酒库存单位）、wheatUnits（小麦用量）、batchEquiv（折算批次，供生产率零头结转）。
// wheatCapUnits：可用于投料的小麦（库存单位），通常为镇库小麦减口粮储备线，或民营/公司自身库存。
export function flexPlan(recipe, rooms, capacityUnits, wheatCapUnits, content) {
  const flex = recipe.flex;
  const scale = content.precision.inventoryUnitsPerJin;
  const ids = flex.itemIds;
  const units = flexAllocate(rooms, capacityUnits);
  const wheatOf = id => Math.floor(units[id] * flex.wheatPerJin[id]);
  let wheatTotal = ids.reduce((sum, id) => sum + wheatOf(id), 0);
  const cap = Math.max(0, Math.floor(wheatCapUnits || 0));
  if (wheatTotal > cap) {
    const factor = wheatTotal > 0 ? cap / wheatTotal : 0;
    for (const id of ids) units[id] = Math.floor(units[id] * factor);
    wheatTotal = ids.reduce((sum, id) => sum + wheatOf(id), 0);
  }
  const wheatByItem = Object.fromEntries(ids.map(id => [id, wheatOf(id)]));
  const totalUnits = ids.reduce((sum, id) => sum + units[id], 0);
  const perBatchUnits = flex.totalJin * scale;
  return {
    units, wheatByItem, wheatUnits: wheatTotal, totalUnits, capacityUnits,
    batchEquiv: perBatchUnits > 0 ? totalUnits / perBatchUnits : 0
  };
}

// 供 planProductionAccounting 使用的一批“实际配方”：一批的投入与产出就是本日的分配结果（batches 取 1）。
export function flexAccountingRecipe(recipe, plan, content) {
  const scale = content.precision.inventoryUnitsPerJin;
  return {
    ...recipe,
    inputs: plan.wheatUnits > 0 ? [{ itemId: "wheat", quantity: plan.wheatUnits / scale }] : [],
    outputs: recipe.flex.itemIds.filter(id => plan.units[id] > 0).map(id => ({ itemId: id, quantity: plan.units[id] / scale })),
    losses: [],
    batchesPerWorkerDay: 1
  };
}
