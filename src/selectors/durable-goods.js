// 耐用品与铁制农具的只读口径（金银消费第二期 A）：覆盖率、全镇持有件数、年更新需求件数、每亩产量。只读，不写 state。
import { householdList, isActiveHousehold } from "../systems/households.js";

export function durableGoodsConfig(content, itemId) {
  return content.rules.durableGoods?.[itemId] || null;
}

// 一户的目标持有件数 = 持有者人数（如农民）× perFarmer。
export function durableTargetPieces(household, cfg) {
  return Math.max(0, household.jobs?.[cfg.holderJobId] || 0) * cfg.perFarmer;
}

// 覆盖率 = 全镇持有者按户计入的持有件数 ÷ 持有者总人数，封顶 1（每户计入至多等于其目标，多出的农具不算）。
// 没有持有者时覆盖率为 0。heldPieces 为全镇实际持有件数（含非持有者家庭）。
export function selectDurableCoverage(state, content, itemId) {
  const cfg = durableGoodsConfig(content, itemId);
  const scale = content.precision.inventoryUnitsPerJin;
  if (!cfg) return { itemId, coverage: 0, heldPieces: 0, countedPieces: 0, targetPieces: 0, annualReplacementPieces: 0 };
  let heldPieces = 0;
  let countedPieces = 0;
  let targetPieces = 0;
  for (const household of householdList(state)) {
    const pieces = Math.max(0, household.inventory?.[itemId] || 0) / scale;
    heldPieces += pieces;
    if (!isActiveHousehold(household)) continue;
    const target = durableTargetPieces(household, cfg);
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

// 铁制农具覆盖率决定的每亩产量：yieldPerAcre + farmToolYieldBonusPerAcre × 覆盖率（无农具时即 yieldPerAcre）。
export function farmYieldPerAcre(state, content) {
  const base = content.agriculture.yieldPerAcre;
  const itemId = content.agriculture.farmToolItemId;
  const bonus = Number(content.agriculture.farmToolYieldBonusPerAcre) || 0;
  if (!itemId || !(bonus > 0)) return base;
  return base + bonus * selectDurableCoverage(state, content, itemId).coverage;
}
