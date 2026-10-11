// 耐用品的只读口径（金银消费第二期 A / 第三期）：覆盖率、全镇持有件数、年更新需求件数、目标持有。只读，不写 state。农田产量见 selectors/farmland.js。
import { householdList, isActiveHousehold } from "../systems/households.js";

export function durableGoodsConfig(content, itemId) {
  return content.rules.durableGoods?.[itemId] || null;
}

// 目标口径的上下文（只算一次，给 durableTargetPieces 用）：
//   acres：已开荒耕地亩数；totalFarmers：全镇在岗持有者（活户）人数；acresPerPiece：一件耐用品管的亩数（耕牛 agriculture.oxAcres）。
// 只有 targetBy "acres" 的物品用到；按人数口径的物品传不传都行。
export function durableTargetContext(state, content, cfg) {
  if (!cfg || cfg.targetBy !== "acres") return null;
  let totalFarmers = 0;
  for (const household of householdList(state)) {
    if (isActiveHousehold(household)) totalFarmers += Math.max(0, household.jobs?.[cfg.holderJobId] || 0);
  }
  return {
    acres: Math.max(0, Number(state.agriculture?.reclaimedAcres) || 0),
    totalFarmers,
    acresPerPiece: Number(content.agriculture?.oxAcres) || 1
  };
}

// 一户的目标持有件数。
// - 按人数（默认）：持有者人数 × perFarmer。
// - 按亩数（targetBy "acres"，如耕牛）：全镇亩数 ÷ acresPerPiece 件，按该户持有者人数占全镇比例分摊（户级耕地不单设，按农民摊）。
export function durableTargetPieces(household, cfg, ctx = null) {
  const holders = Math.max(0, household.jobs?.[cfg.holderJobId] || 0);
  if (cfg.targetBy === "acres") {
    if (!ctx || !(ctx.totalFarmers > 0)) return 0;
    return holders / ctx.totalFarmers * ctx.acres / ctx.acresPerPiece;
  }
  return holders * cfg.perFarmer;
}

// 覆盖率 = 全镇持有者按户计入的持有件数 ÷ 持有者总人数，封顶 1（每户计入至多等于其目标，多出的农具不算）。
// 没有持有者时覆盖率为 0。heldPieces 为全镇实际持有件数（含非持有者家庭）。
export function selectDurableCoverage(state, content, itemId) {
  const cfg = durableGoodsConfig(content, itemId);
  const scale = content.precision.inventoryUnitsPerJin;
  if (!cfg) return { itemId, coverage: 0, heldPieces: 0, countedPieces: 0, targetPieces: 0, annualReplacementPieces: 0 };
  const ctx = durableTargetContext(state, content, cfg);
  let heldPieces = 0;
  let countedPieces = 0;
  let targetPieces = 0;
  for (const household of householdList(state)) {
    const pieces = Math.max(0, household.inventory?.[itemId] || 0) / scale;
    heldPieces += pieces;
    if (!isActiveHousehold(household)) continue;
    const target = durableTargetPieces(household, cfg, ctx);
    targetPieces += target;
    countedPieces += Math.min(pieces, target);
  }
  return {
    itemId,
    coverage: targetPieces > 0 ? Math.min(1, countedPieces / targetPieces) : 0,
    heldPieces,
    countedPieces,
    targetPieces,
    // 稳态下每年需要更新的件数 = 目标持有 ÷ 寿命（线性折旧，每年损耗 1/寿命）。
    annualReplacementPieces: cfg.lifeYears > 0 ? targetPieces / cfg.lifeYears : 0
  };
}
