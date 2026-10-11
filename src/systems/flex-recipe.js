// 弹性配方（动态产品）：一批总产能 flex.totalJin（酒坊为斤；冶炼厂为产能点），按各产品的批发市场缺口分配。
// 镇营（production.js）、民营（private-industry.js）、公司（companies.js）共用这里的分配，不各写一套。
//
// 产品每件（每斤）占用的产能 flex.capacityPerJin[id]（缺省 1：酒坊每斤酒占 1 斤产能；冶炼厂农具 4 点、工具 2 点、珠宝 1 点）。
// 产品每件（每斤）耗用的投入 flex.inputsPerJin[id] = { 投入物品: 每件数量 }（斤，按件计的产品同样用斤数表示每件耗量）。
//
// 缺口 room_i = max(0, 目标库存_i − 现存_i)，目标库存见 wholesale-market.js 的 townOutputTargetUnits，现存 = 批发市场 + 镇库（库存单位）。
// 换算成产能：room_i × 每件占用（产能单位 = 库存单位 × 点数，与总产能同单位）。
// 总产能 C = 批次数 × totalJin × 库存单位换算。按缺口占比分配 C，单品不超过缺口；剩余产能按剩余缺口再分，最多 4 轮。
// 单品产出 = 分到的产能 ÷ 每件占用（向下取整）。所有缺口都为 0 时当日不开工（和单品市场闸门一致）。
// 投入不足时（小麦受口粮储备线，其余受库存）：缺某项投入的产品不参与分配，其余产品按它们用到的最紧投入同比例缩减。
import { hasWholesaleMarket, townOutputTargetUnits } from "./wholesale-market.js";

const ALLOCATION_ROUNDS = 4;

export function flexOf(recipe) {
  return recipe?.flex || null;
}

// 以下辅助函数的参数都是弹性配置 flex（即 recipe.flex，见 flexOf）。
export function flexCapacityPerUnit(flex, itemId) {
  return Number(flex.capacityPerJin?.[itemId]) || 1;
}

export function flexInputsOf(flex, itemId) {
  return flex.inputsPerJin?.[itemId] || {};
}

// 各产品的产能缺口（产能单位）。没有批发市场时缺口为无限，按份额平分产能。
export function flexRoomUnits(state, recipe, content) {
  const rooms = {};
  const market = hasWholesaleMarket(state);
  for (const itemId of recipe.flex.itemIds) {
    if (!market) { rooms[itemId] = Number.POSITIVE_INFINITY; continue; }
    const stock = Math.max(0, state.wholesaleMarket?.inventory?.[itemId] || 0) + Math.max(0, state.accounts?.town?.[itemId] || 0);
    rooms[itemId] = Math.max(0, townOutputTargetUnits(state, itemId, content) - stock) * flexCapacityPerUnit(recipe.flex, itemId);
  }
  return rooms;
}

// 投入上限：数字 = 小麦上限（旧调用口径）；对象 = { 投入物品: 上限（库存单位）}；未给的物品不设上限。
export function normalizeInputCaps(inputCaps) {
  if (typeof inputCaps === "number") return { wheat: Math.max(0, Math.floor(inputCaps || 0)) };
  const caps = {};
  for (const [itemId, cap] of Object.entries(inputCaps || {})) caps[itemId] = Math.max(0, Math.floor(Number(cap) || 0));
  return caps;
}

// 一批的投入需求（库存单位）：Σ 各产品产出 × 每件投入，产出按 floor 取整（与旧版小麦口径一致）。
function inputNeeds(flex, units) {
  const need = {};
  for (const itemId of flex.itemIds) {
    for (const [inputId, perJin] of Object.entries(flexInputsOf(flex, itemId))) {
      need[inputId] = (need[inputId] || 0) + Math.floor(units[itemId] * perJin);
    }
  }
  return need;
}

// 每批（满产时）各投入的斤数，按各产品的产能占比折算：供经营权预览与经营计划估算。
export function flexBatchInputsJin(flex, shares) {
  const batchJin = flex.totalJin;
  const perBatch = {};
  for (const itemId of flex.itemIds) {
    const jinOfItem = batchJin * (shares[itemId] || 0) / flexCapacityPerUnit(flex, itemId);
    for (const [inputId, perJin] of Object.entries(flexInputsOf(flex, itemId))) {
      perBatch[inputId] = (perBatch[inputId] || 0) + jinOfItem * perJin;
    }
  }
  return Object.entries(perBatch).map(([itemId, quantity]) => ({ itemId, quantity }));
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

// 一日的分配结果：
//   units（各产品件数/斤数，库存单位）、points（各产品占用的产能，产能单位）、totalPoints（产能合计）、
//   inputUnits（各投入的用量，库存单位）、wheatUnits（小麦用量，旧字段）、totalUnits（产品合计）、
//   batchEquiv（折算批次，供生产率零头结转）。
// inputCaps：各投入可用量上限（库存单位），见 normalizeInputCaps；null/undefined 不设上限（用于计算需求）。
export function flexPlan(recipe, rooms, capacityUnits, inputCaps, content) {
  const flex = recipe.flex;
  const scale = content.precision.inventoryUnitsPerJin;
  const ids = flex.itemIds;
  const caps = inputCaps == null ? null : normalizeInputCaps(inputCaps);
  // 缺某项投入（上限为 0）的产品不参与分配，产能让给能做的产品（如冶炼厂没有金条时金珠宝不参与，产能给其余产品）。
  const feasibleRooms = Object.fromEntries(ids.map(id => {
    const blocked = caps && Object.entries(flexInputsOf(flex, id)).some(([inputId, perJin]) => perJin > 0 && Object.hasOwn(caps, inputId) && caps[inputId] <= 0);
    return [id, blocked ? 0 : rooms[id]];
  }));
  const points = flexAllocate(feasibleRooms, capacityUnits);
  const unitsOf = (source) => Object.fromEntries(ids.map(id => [id, Math.floor(source[id] / flexCapacityPerUnit(flex, id))]));
  let units = unitsOf(points);
  let limitedBy = null;
  if (caps) {
    // 投入不足：每种产品按它用到的最紧投入缩减（同比例）。共用的投入（如小麦、煤）让所有用它的产品同比例缩减；
    // 只用某种稀缺投入的产品（如金条）只缩它自己。缩减后各投入都不超过上限。
    const need = inputNeeds(flex, units);
    const ratio = {};
    for (const [inputId, amount] of Object.entries(need)) {
      if (amount > 0 && Object.hasOwn(caps, inputId)) ratio[inputId] = caps[inputId] / amount;
    }
    for (const [inputId, value] of Object.entries(ratio)) {
      if (value < 1 && (limitedBy === null || value < ratio[limitedBy])) limitedBy = inputId;
    }
    units = Object.fromEntries(ids.map(id => {
      let factor = 1;
      for (const [inputId, perJin] of Object.entries(flexInputsOf(flex, id))) {
        if (perJin > 0 && Object.hasOwn(ratio, inputId)) factor = Math.min(factor, ratio[inputId]);
      }
      return [id, Math.floor(units[id] * Math.max(0, Math.min(1, factor)))];
    }));
  }
  const usedPoints = Object.fromEntries(ids.map(id => [id, units[id] * flexCapacityPerUnit(flex, id)]));
  const totalPoints = ids.reduce((sum, id) => sum + usedPoints[id], 0);
  const totalUnits = ids.reduce((sum, id) => sum + units[id], 0);
  const inputUnits = inputNeeds(flex, units);
  const perBatchPoints = flex.totalJin * scale;
  return {
    units, points: usedPoints, totalPoints, totalUnits, inputUnits, wheatUnits: inputUnits.wheat || 0, capacityUnits, limitedBy,
    batchEquiv: perBatchPoints > 0 ? totalPoints / perBatchPoints : 0
  };
}

// 供 planProductionAccounting 使用的一批“实际配方”：一批的投入与产出就是本日的分配结果（batches 取 1）。
export function flexAccountingRecipe(recipe, plan, content) {
  const scale = content.precision.inventoryUnitsPerJin;
  return {
    ...recipe,
    inputs: Object.entries(plan.inputUnits || {}).filter(([, units]) => units > 0).map(([itemId, units]) => ({ itemId, quantity: units / scale })),
    outputs: recipe.flex.itemIds.filter(id => plan.units[id] > 0).map(id => ({ itemId: id, quantity: plan.units[id] / scale })),
    losses: [],
    batchesPerWorkerDay: 1
  };
}
