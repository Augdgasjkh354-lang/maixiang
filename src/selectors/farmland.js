// 农田的只读口径（金银消费第三期）：耕牛覆盖、铁犁牛耕改革的岗位容量与上限、每亩与全镇产量。只读，不写 state。
//
// 每亩产量（非改革地块）= yieldPerAcre + 农具加成 × 农具覆盖率 + 牛耕加成 × 牛耕覆盖率。
// 改革地块（ironPlowAcres，且有牛有农具）每亩 = 基础 + 农具 + 牛（1000）。两者的覆盖率都是"剩余资源摊到剩余耕地"：
//   先算改革地块用掉的牛与农具（每 50 亩一头牛、一件农具），其余的再摊到非改革地块。
// 没有牛、没有改革时，每亩产量与第二期逐位一致（牛耕覆盖率为 0）。
import { householdList, isActiveHousehold } from "../systems/households.js";
import { durableGoodsConfig, durableTargetContext, durableTargetPieces, selectDurableCoverage } from "./durable-goods.js";

// 耕牛效力：欠养（当日未付全额维护费）超过宽限天数后按比例下降，付上即恢复（rules.oxMaintenanceGraceDays / oxEfficiencyRecoveryDays）。
export function oxEfficiency(household, content) {
  const gap = Math.max(0, Number(household?.oxGapDays) || 0);
  const grace = content.rules.oxMaintenanceGraceDays ?? 30;
  if (gap <= grace) return 1;
  const recovery = Math.max(1, content.rules.oxEfficiencyRecoveryDays ?? 360);
  return Math.max(0, 1 - (gap - grace) / recovery);
}

// 实际生效的改革亩数：不超过已开荒耕地。
export function ironPlowAcresOf(state, content) {
  const acres = Math.max(0, Math.floor(Number(state.agriculture?.reclaimedAcres) || 0));
  const plow = Math.max(0, Math.floor(Number(state.agriculture?.ironPlowAcres) || 0));
  return Math.min(plow, acres);
}

// 农田岗位容量（农人人数）：非改革亩按 acresPerFarmer 亩 1 人，改革亩按 plowAcresPerFarmer 亩 1 人。
// exact = true 时不取整（供农业预测、面板的分数口径用）；未改革时两者都等于 亩数 ÷ acresPerFarmer（取整与否）。
export function farmerCapacityOf(state, content, { exact = false } = {}) {
  const acres = Math.max(0, Math.floor(Number(state.agriculture?.reclaimedAcres) || 0));
  const plow = ironPlowAcresOf(state, content);
  const per = content.agriculture.acresPerFarmer;
  const perPlow = content.agriculture.plowAcresPerFarmer || per;
  if (exact) return (acres - plow) / per + plow / perPlow;
  return Math.floor((acres - plow) / per) + Math.floor(plow / perPlow);
}

// 农田全貌（只读）。total 为全镇最高产量（斤，未乘教育加成、未扣税，与秋收的 maximum 同口径）。
export function selectFarmland(state, content) {
  const acres = Math.max(0, Math.floor(Number(state.agriculture?.reclaimedAcres) || 0));
  const plowAcres = ironPlowAcresOf(state, content);
  const scale = content.precision.inventoryUnitsPerJin;
  const oxId = content.agriculture.oxItemId;
  const oxCfg = durableGoodsConfig(content, oxId);
  const oxAcresPerPiece = content.agriculture.oxAcres || 50;
  const plowPerOx = content.agriculture.plowAcresPerFarmer || oxAcresPerPiece;
  const toolId = content.agriculture.farmToolItemId;
  const base = content.agriculture.yieldPerAcre;
  const toolBonus = toolId && content.agriculture.farmToolYieldBonusPerAcre > 0 ? content.agriculture.farmToolYieldBonusPerAcre : 0;
  const oxBonus = oxId && content.agriculture.oxYieldBonusPerAcre > 0 ? content.agriculture.oxYieldBonusPerAcre : 0;
  // 耕牛：全镇持有头数、在役头数（持有 × 效力）、目标头数。耕牛在全镇汇总封顶（不按户封顶）：
  // 农民被裁后，原来那户多出的牛仍可调剂给其他耕地，不会因为"户的目标变小"而白白不计。
  const ctx = durableTargetContext(state, content, oxCfg);
  let oxHeld = 0;
  let oxInService = 0;
  let oxTarget = 0;
  if (oxCfg) {
    for (const household of householdList(state)) {
      const held = Math.max(0, household.inventory?.[oxId] || 0) / scale;
      const efficiency = held > 0 ? oxEfficiency(household, content) : 1;
      oxHeld += held;
      oxInService += held * efficiency;
      if (isActiveHousehold(household)) oxTarget += durableTargetPieces(household, oxCfg, ctx);
    }
  }
  const oxCountedEff = Math.min(oxInService, oxTarget);
  const tool = toolId ? selectDurableCoverage(state, content, toolId) : { coverage: 0, heldPieces: 0, countedPieces: 0, targetPieces: 0 };
  const oxAcresCounted = oxCountedEff * oxAcresPerPiece;
  const oxAcresInService = oxInService * oxAcresPerPiece;
  const toolAcresHeld = tool.heldPieces * oxAcresPerPiece;
  // 改革上限：在役耕牛与全镇农具各按 50 亩 1 件，取小；不超过已开荒耕地。
  const plowCapOx = Math.min(acres, Math.floor(oxAcresInService + 1e-9));
  const plowCapTools = Math.min(acres, Math.floor(toolAcresHeld + 1e-9));
  const plowCap = Math.min(plowCapOx, plowCapTools);
  // 实际用于改革地块的亩数：不超过设定值，也不超过当下牛与农具（耕牛死亡、欠养后自动降级，不会凭空算产量）。
  const plowEffectiveAcres = Math.min(plowAcres, oxAcresCounted, tool.countedPieces * oxAcresPerPiece);
  const restAcres = acres - plowEffectiveAcres;
  // 其余耕地的覆盖率：扣掉改革地块用掉的牛与农具后的剩余。未改革且无牛时，农具覆盖率与第二期的 coverage 逐位一致。
  const toolRestTarget = Math.max(0, tool.targetPieces - plowEffectiveAcres / plowPerOx);
  const toolRestCounted = Math.max(0, tool.countedPieces - plowEffectiveAcres / plowPerOx);
  const toolRestCoverage = toolRestTarget > 0 ? Math.min(1, toolRestCounted / toolRestTarget) : 0;
  const oxRestCoverage = restAcres > 0 ? Math.min(1, Math.max(0, oxAcresCounted - plowEffectiveAcres) / restAcres) : 0;
  const restYield = base + toolBonus * toolRestCoverage + oxBonus * oxRestCoverage;
  const plowYield = base + toolBonus + oxBonus;
  const total = plowEffectiveAcres * plowYield + restAcres * restYield;
  return {
    acres,
    plowAcres,
    plowEffectiveAcres,
    restAcres,
    plowCap,
    plowCapOx,
    plowCapTools,
    farmerCapacity: farmerCapacityOf(state, content),
    farmerCapacityExact: farmerCapacityOf(state, content, { exact: true }),
    oxHeld,
    oxInService,
    oxTarget,
    oxAcresCounted,
    oxCoverage: acres > 0 ? Math.min(1, oxAcresCounted / acres) : 0,
    oxRestCoverage,
    oxBonus,
    toolHeld: tool.heldPieces,
    toolCounted: tool.countedPieces,
    toolTarget: tool.targetPieces,
    toolCoverage: tool.coverage,
    toolRestCoverage,
    baseYield: base,
    toolBonus,
    plowYield,
    totalJin: total,
    // 平均每亩产量（斤）：面板显示用；没有耕地时为基础产量。
    yieldPerAcre: acres > 0 ? total / acres : base
  };
}

// 全镇最高产量（斤，未乘教育加成）：各地块按上面的口径加总。
export function farmTotalOutputJin(state, content) {
  return selectFarmland(state, content).totalJin;
}

// 每亩产量（斤）：全镇最高产量 ÷ 亩数；没有耕地时为基础产量。保留给只看每亩数字的界面与旧调用。
export function farmYieldPerAcre(state, content) {
  return selectFarmland(state, content).yieldPerAcre;
}
