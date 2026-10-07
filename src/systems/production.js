import { atomicInventoryTransaction } from "../economy/inventory.js";
import { commitProductionAccounting, planProductionAccounting } from "../economy/business.js";
import { recipeCapacity } from "../selectors/production.js";
import { jobKeyForBuilding, readJobCount } from "../selectors/labor.js";
import { procureTownInputFromWholesale, transferTownToWholesale } from "./wholesale-market.js";

function recipeDeltas(recipe, batches, content) {
  const inputs = [];
  for (const input of recipe.inputs) {
    inputs.push({
      owner: "town",
      itemId: input.itemId,
      quantityJin: input.quantity * batches
    });
  }
  const outputs = [];
  for (const output of recipe.outputs) {
    outputs.push({
      owner: "town",
      itemId: output.itemId,
      quantityJin: output.quantity * batches
    });
  }
  const losses = recipe.losses.map(function (loss) {
    return { itemId: loss.itemId, quantityJin: loss.quantity * batches };
  });
  return { inputs, outputs, losses };
}

export function processBuilding(state, building, content) {
  const definition = content.buildings[building.typeId];
  const recipeDef = definition?.recipeId ? content.recipes[definition.recipeId] : null;
  const role = (definition?.jobs || []).find(job => job.id === definition.productionRoleId);
  const workers = role ? readJobCount(state, jobKeyForBuilding(building.id, role.id)) : 0;
  // 用户 0.1.11：镇营目标日产量（outputTargetJin，斤）。>0 时按"目标斤数/每批产量"向上取整
  // 封顶每日批次数；用不上的人手仍照常领工资。用 0 表示取消（按人手满产）。
  const targetCap = targetBatchCap(building, recipeDef);
  let wholesaleBatchCap = Number.POSITIVE_INFINITY;
  const procuredInputs = [];
  if (recipeDef && workers > 0 && (recipeDef.inputs || []).length) {
    const wantedBatches = Math.min(workers * (recipeDef.batchesPerWorkerDay || 0), targetCap);
    wholesaleBatchCap = wantedBatches;
    for (const input of recipeDef.inputs || []) {
      const perBatch = Math.round(input.quantity * content.precision.inventoryUnitsPerJin);
      const required = perBatch * wantedBatches;
      const purchase = procureTownInputFromWholesale(state, input.itemId, required, content, `${definition.name}从批发市场领用${content.items[input.itemId]?.name || input.itemId}`);
      const boughtUnits = purchase.boughtUnits || 0;
      procuredInputs.push({ itemId: input.itemId, boughtUnits, perBatch });
      wholesaleBatchCap = Math.min(wholesaleBatchCap, Math.floor(boughtUnits / Math.max(1, perBatch)));
    }
  }
  const capacity = recipeCapacity(state, building, content);
  const allowedBatches = Number.isFinite(wholesaleBatchCap)
    ? Math.min(capacity.batches || 0, wholesaleBatchCap, targetCap)
    : Math.min(capacity.batches || 0, targetCap);
  // 多输入配方：把因其他输入不足而多领的部分退回批发市场，避免烂在镇库。
  // 单输入时该输入恒为瓶颈（镇库只增不减，capacity.batches ≥ wholesaleBatchCap，故
  // allowedBatches === floor(boughtUnits/perBatch)），退回量恒为 0，行为不变。
  if (procuredInputs.length > 1) {
    for (const row of procuredInputs) {
      if (Math.floor(row.boughtUnits / Math.max(1, row.perBatch)) <= allowedBatches) continue;
      const excess = row.boughtUnits - row.perBatch * allowedBatches;
      if (excess > 0) {
        transferTownToWholesale(state, row.itemId, excess, content,
          `${definition?.name || "生产"}多领退回${content.items[row.itemId]?.name || row.itemId}`);
      }
    }
  }
  if (!definition || !definition.recipeId || capacity.status === "no_workers" || allowedBatches <= 0) {
    return { buildingId: building.id, status: capacity.status === "no_workers" ? "no_workers" : "no_materials", batches: 0 };
  }
  const recipe = capacity.recipe;
  const prepared = recipeDeltas(recipe, allowedBatches, content);
  const accounting = planProductionAccounting(state, building, recipe, allowedBatches, content);
  const transaction = atomicInventoryTransaction(state, {
    inputs: prepared.inputs,
    outputs: prepared.outputs,
    losses: prepared.losses,
    reason: definition.name + "生产：" + recipe.name,
    lossReason: recipe.name + "加工损耗（未作为口粮）"
  }, content);
  if (!transaction.ok) {
    return {
      buildingId: building.id,
      status: "no_materials",
      batches: 0,
      reason: transaction.reason
    };
  }
  commitProductionAccounting(state, accounting);
  return {
    buildingId: building.id,
    status: allowedBatches >= targetCap
      ? "target_capped"
      : allowedBatches < (capacity.batches || 0) ? "limited_materials" : capacity.status,
    batches: allowedBatches,
    transactionId: transaction.transactionId,
    outputUnits: accounting.outputs.reduce(function (totals, output) {
      totals[output.itemId] = (totals[output.itemId] || 0) + output.quantityUnits;
      return totals;
    }, {})
  };
}

// 用户 0.1.11：镇营目标日产量换算为每日最大批次数。未设置（<=0）或配方无主产出时返回 Infinity（不限）。
export function targetBatchCap(building, recipeDef) {
  const targetJin = Number(building?.outputTargetJin || 0);
  const perBatch = recipeDef?.outputs?.[0]?.quantity || 0;
  if (!(targetJin > 0) || !(perBatch > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil(targetJin / perBatch);
}

// 用户 0.1.11：设置镇营建筑目标日产量（斤，保留 3 位小数）。传 0 表示取消（按人手满产）。
export function setBuildingOutputTarget(state, buildingId, quantityJin, content) {
  const building = (state.buildings || []).find(row => row.id === buildingId);
  if (!building) return { ok: false, reason: "找不到这座建筑" };
  if (!content.buildings[building.typeId]?.recipeId) return { ok: false, reason: "这座建筑没有生产配方" };
  const value = Number(quantityJin);
  if (!Number.isFinite(value) || value < 0 || value > 1e9) return { ok: false, reason: "目标日产量须为非负数" };
  if (value > 0) building.outputTargetJin = Math.round(value * 1000) / 1000;
  else delete building.outputTargetJin;
  return { ok: true, buildingId, quantityJin: building.outputTargetJin || 0 };
}

export function processAllBuildings(state, content) {
  return state.buildings.map(function (building) {
    return processBuilding(state, building, content);
  });
}
