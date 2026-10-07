import { jobKeyForBuilding, readJobCount } from "./labor.js";
import { itemQeqUnitsPerInventoryUnit } from "../economy/inventory.js";
import { hasWholesaleMarket } from "../systems/wholesale-market.js";
import { laborBatches } from "../economy/productivity.js";

// 与 processBuilding 同口径的纯函数预估：镇营生产经批发市场采购原料，
// 镇库余粮不能绕过批发市场直接投产（"镇营生产原料必须经过批发市场"）。
// 注意 processBuilding 会真实扣减，此处只读 state、不产生副作用。
function wholesaleBatches(state, recipe, workers, content, building) {
  const market = state.wholesaleMarket;
  if (!hasWholesaleMarket(state) || !market) {
    return { batches: 0, reason: "尚未建成批发市场" };
  }
  const wanted = laborBatches(state, building.typeId, building.level, workers, recipe.batchesPerWorkerDay, building.productivityCarry).batches;
  let batches = wanted;
  let shortestName = null;
  for (const input of recipe.inputs || []) {
    const perBatch = Math.round(input.quantity * content.precision.inventoryUnitsPerJin);
    // 小麦由镇库直管：可用量读镇库
    const marketUnits = input.itemId === "wheat"
      ? Math.max(0, state.accounts?.town?.wheat || 0)
      : Math.max(0, market.inventory?.[input.itemId] || 0);
    const byItem = Math.min(wanted, Math.floor(marketUnits / Math.max(1, perBatch)));
    if (byItem < batches) {
      batches = byItem;
      shortestName = content.items[input.itemId]?.name || input.itemId;
    }
  }
  if (batches <= 0) {
    return { batches: 0, reason: `批发市场${shortestName || "原料"}缺货，待镇库调拨` };
  }
  return { batches, reason: null };
}

export function recipeCapacity(state, building, content) {
  const definition = content.buildings[building.typeId];
  if (!definition || !definition.recipeId) return { status: "no_recipe", batches: 0, workers: 0 };
  const recipe = content.recipes[definition.recipeId];
  if (!recipe) return { status: "no_recipe", batches: 0, workers: 0 };
  const role = (definition.jobs || []).find(function (job) {
    return job.id === definition.productionRoleId;
  });
  const workers = role ? readJobCount(state, jobKeyForBuilding(building.id, role.id)) : 0;
  if (workers <= 0) return { status: "no_workers", batches: 0, workers, recipe };
  const capacity = laborBatches(state, building.typeId, building.level, workers, recipe.batchesPerWorkerDay, building.productivityCarry).batches;
  let available = capacity;
  for (const input of recipe.inputs) {
    const perBatch = Math.round(input.quantity * content.precision.inventoryUnitsPerJin);
    available = Math.min(
      available,
      Math.floor((state.accounts.town[input.itemId] || 0) / perBatch)
    );
  }
  if (available <= 0) return { status: "no_materials", batches: 0, workers, recipe, capacity };
  if (available < capacity) {
    return { status: "limited_materials", batches: available, workers, recipe, capacity };
  }
  return { status: "ready", batches: available, workers, recipe, capacity };
}

export function productionStatus(state, building, content) {
  const result = recipeCapacity(state, building, content);
  const definition = content.buildings[building.typeId];
  if (!definition || !definition.recipeId || result.status === "no_recipe") {
    // 用户 0.1.11：无配方建筑按在岗情况显示已落成/运作中/待安排人手。
    const jobs = definition?.jobs || [];
    const workers = jobs.reduce((sum, job) => sum + readJobCount(state, jobKeyForBuilding(building.id, job.id)), 0);
    return { ...result, label: !jobs.length ? "已落成" : workers > 0 ? "运作中" : "待安排人手" };
  }
  if (result.status === "no_workers") return { ...result, label: "缺人停工" };
  // 镇营生产的实际投产量以批发市场可领用量为准（processBuilding 同口径），
  // 镇库有粮不等于能开工：避免显示"正在加工"、实际却零产出误导玩家。
  const wholesale = wholesaleBatches(state, result.recipe, result.workers, content, building);
  if (wholesale.batches <= 0) {
    return {
      ...result,
      status: "no_materials",
      batches: 0,
      label: wholesale.reason === "尚未建成批发市场" ? "缺料停工（未建批发市场）" : "缺料停工（待镇库调拨）",
      reason: wholesale.reason
    };
  }
  const limited = wholesale.batches < result.capacity;
  return {
    ...result,
    batches: wholesale.batches,
    status: limited ? "limited_materials" : "ready",
    label: limited ? "原料有限，正在加工" : "正在加工",
    reason: wholesale.batches < result.batches ? "部分原料待镇库向批发市场调拨" : null
  };
}

export function buildingJobCount(state, building, roleId) {
  return readJobCount(state, jobKeyForBuilding(building.id, roleId));
}

export function buildingRoleInputQeq(recipe, workers, content) {
  let input = 0;
  for (const row of recipe.inputs) {
    const item = content.items[row.itemId];
    const units = Math.round(row.quantity * content.precision.inventoryUnitsPerJin);
    input += itemQeqUnitsPerInventoryUnit(item, content) * units * workers;
  }
  return input;
}
