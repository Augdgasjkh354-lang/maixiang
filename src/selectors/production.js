import { jobKeyForBuilding, populationStats, readJobCount } from "./labor.js";
import { itemQeqUnitsPerInventoryUnit } from "../economy/inventory.js";
import { hasWholesaleMarket, townOutputMarketRoomUnits, wholesaleMonopolyItemIds } from "../systems/wholesale-market.js";
import { laborBatches } from "../economy/productivity.js";

// 镇营口粮储备（库存单位）：全镇人口 × 日口粮 × 储备天数。镇营磨坊/酒坊不得把镇库小麦压到这条线以下。
export function townWheatReserveUnits(state, content) {
  const people = populationStats(state).total;
  return Math.round(people * content.rules.foodPerPersonDay * (content.rules.townWheatReserveDays ?? 180) * content.precision.inventoryUnitsPerJin);
}

// 镇营产出的市场闸门（批次数）：加工配方（有投入）的主产出若是批发市场商品，按市场余量最多能开几批。
// 采集类（伐木、采盐、种棉）不设闸门：开局木材库存就高于最低备货，设闸门会让伐木场永久停产、起步路线断掉。
// 无市场、非统购品时返回 Infinity。
export function townOutputMarketBatchCap(state, recipe, content) {
  const main = recipe?.outputs?.[0];
  if (!main || !(recipe.inputs || []).length || !wholesaleMonopolyItemIds(content).includes(main.itemId)) return Number.POSITIVE_INFINITY;
  const room = townOutputMarketRoomUnits(state, main.itemId, content);
  if (!Number.isFinite(room)) return Number.POSITIVE_INFINITY;
  const perBatch = Math.max(1, Math.round(main.quantity * content.precision.inventoryUnitsPerJin));
  return Math.max(0, Math.ceil(room / perBatch));
}

// 镇营小麦投入的口粮储备上限（批次数）：只有镇库小麦超出储备的部分能用；没有小麦投入时 Infinity。
export function townWheatReserveBatchCap(state, recipe, content) {
  const wheat = (recipe?.inputs || []).find(input => input.itemId === "wheat");
  if (!wheat) return Number.POSITIVE_INFINITY;
  const perBatch = Math.max(1, Math.round(wheat.quantity * content.precision.inventoryUnitsPerJin));
  const spare = Math.max(0, (state.accounts?.town?.wheat || 0) - townWheatReserveUnits(state, content));
  return Math.floor(spare / perBatch);
}

// 两道闸门合并：wanted 是人手与目标产量封顶后的批次数。marketBinding / reserveBinding 表示该闸门是唯一的最紧约束。
export function townOutputGate(state, recipe, wanted, content) {
  const marketCap = townOutputMarketBatchCap(state, recipe, content);
  const reserveCap = townWheatReserveBatchCap(state, recipe, content);
  return {
    batches: Math.max(0, Math.min(wanted, marketCap, reserveCap)),
    marketCap,
    reserveCap,
    marketBinding: marketCap < Math.min(wanted, reserveCap),
    reserveBinding: reserveCap < Math.min(wanted, marketCap)
  };
}

// 闸门是否是最终实际投产批次数的限制因素：返回 "market_capped" / "wheat_reserve" / null。
export function townGateCap(gate, batches) {
  if (gate.marketBinding && batches === gate.marketCap) return "market_capped";
  if (gate.reserveBinding && batches === gate.reserveCap) return "wheat_reserve";
  return null;
}

// 与 processBuilding 同口径的纯函数预估：镇营生产经批发市场采购原料，
// 镇库余粮不能绕过批发市场直接投产（"镇营生产原料必须经过批发市场"）。
// 注意 processBuilding 会真实扣减，此处只读 state、不产生副作用。
function wholesaleBatches(state, recipe, workers, content, building) {
  const market = state.wholesaleMarket;
  if (!hasWholesaleMarket(state) || !market) {
    return { batches: 0, reason: "尚未建成批发市场" };
  }
  const wanted = laborBatches(state, building.typeId, building.level, workers, recipe.batchesPerWorkerDay, building.productivityCarry).batches;
  const gate = townOutputGate(state, recipe, wanted, content);
  let batches = gate.batches;
  let shortestName = null;
  for (const input of recipe.inputs || []) {
    const perBatch = Math.round(input.quantity * content.precision.inventoryUnitsPerJin);
    // 小麦由镇库直管：可用量读镇库（口粮储备已由 gate 扣除）
    const marketUnits = input.itemId === "wheat"
      ? Math.max(0, state.accounts?.town?.wheat || 0)
      : Math.max(0, market.inventory?.[input.itemId] || 0);
    const byItem = Math.min(batches, Math.floor(marketUnits / Math.max(1, perBatch)));
    if (byItem < batches) {
      batches = byItem;
      shortestName = content.items[input.itemId]?.name || input.itemId;
    }
  }
  if (batches <= 0) {
    const cap = townGateCap(gate, 0);
    if (cap) return { batches: 0, reason: null, cap };
    return { batches: 0, reason: `批发市场${shortestName || "原料"}缺货，待镇库调拨` };
  }
  return { batches, reason: null, cap: townGateCap(gate, batches) };
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

const CAP_LABELS = Object.freeze({ market_capped: "市场积压，减产", wheat_reserve: "保留口粮储备，减产" });

export function productionStatus(state, building, content) {
  const result = recipeCapacity(state, building, content);
  const definition = content.buildings[building.typeId];
  if (!definition || !definition.recipeId || result.status === "no_recipe") {
    // 用户 0.1.11：无配方建筑按在岗情况显示已落成/运作中/待安排人手。
    // 商业街、养殖基地、时代广场：人手归各店铺管，按有没有店在营业显示。
    if (definition?.shopHost) {
      const open = Object.values(state.shops || {}).some(shop => shop.buildingId === building.id && shop.status === "open");
      return { ...result, label: open ? "营业中" : "待入驻" };
    }
    const jobs = definition?.jobs || [];
    const workers = jobs.reduce((sum, job) => sum + readJobCount(state, jobKeyForBuilding(building.id, job.id)), 0);
    return { ...result, label: !jobs.length ? "已落成" : workers > 0 ? "运作中" : "待安排人手" };
  }
  if (result.status === "no_workers") return { ...result, label: "缺人停工" };
  // 镇营生产的实际投产量以批发市场可领用量为准（processBuilding 同口径），
  // 镇库有粮不等于能开工：避免显示"正在加工"、实际却零产出误导玩家。
  const wholesale = wholesaleBatches(state, result.recipe, result.workers, content, building);
  if (wholesale.batches <= 0 && wholesale.cap) {
    return { ...result, status: wholesale.cap, batches: 0, label: CAP_LABELS[wholesale.cap], reason: null };
  }
  if (wholesale.batches <= 0) {
    return {
      ...result,
      status: "no_materials",
      batches: 0,
      label: wholesale.reason === "尚未建成批发市场" ? "缺料停工（未建批发市场）" : "缺料停工（待镇库调拨）",
      reason: wholesale.reason
    };
  }
  if (wholesale.cap) {
    return { ...result, batches: wholesale.batches, status: wholesale.cap, label: CAP_LABELS[wholesale.cap], reason: null };
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
