import { RULES } from "../content/rules.js";

// 人均产出（劳动生产率）：每个工人每天能做的批次数 = 配方基准 × 生产率系数。
//
//   生产率系数 = 等级加成 × 熟练度加成 × 教育加成
//   等级加成   = 1 + 10% × (建筑等级 − 1)          升级不只加岗位，也让每个人干得更快
//   熟练度加成 = 1 + 50% × (1 − e^(−累计工日 / 2 万))  某产业全镇累计投入的工日越多越熟练，越往后涨得越慢
//   教育加成   = 1 + min(上限, 每办满 1 年的加成 × 累计办学天数 ÷ 360)，全镇所有产业与农业共用；
//                见 content/rules.js 的 educationBonusPerYear（1%）/ educationBonusMax（上限 30%，防止无限复利）。
//
// 产量不足一批的零头记在 carry 里，第二天接着累计，小作坊也能吃到加成。
// 本模块只做计算；累计工日由 systems/productivity.js 每天记账，累计办学天数同样在那里记账。

export const LEVEL_BONUS_PER_LEVEL = 0.1;
export const EXPERIENCE_BONUS_MAX = 0.5;
export const EXPERIENCE_SCALE_WORKER_DAYS = 20000;

export function educationBonus(state) {
  const schoolDays = Math.max(0, state.education?.schoolDays || 0);
  return 1 + Math.min(RULES.educationBonusMax, RULES.educationBonusPerYear * schoolDays / RULES.daysPerYear);
}

export function industryWorkerDays(state, typeId) {
  return Math.max(0, state.industryExperience?.[typeId] || 0);
}

export function levelBonus(level) {
  return 1 + LEVEL_BONUS_PER_LEVEL * (Math.max(1, Math.floor(level || 1)) - 1);
}

export function experienceBonus(state, typeId) {
  return 1 + EXPERIENCE_BONUS_MAX * (1 - Math.exp(-industryWorkerDays(state, typeId) / EXPERIENCE_SCALE_WORKER_DAYS));
}

export function productivityFactor(state, typeId, level = 1) {
  return levelBonus(level) * experienceBonus(state, typeId) * educationBonus(state);
}

// 当日可做批次（含昨天留下的零头）。返回 { batches, exact }：batches 取整，exact 留给 nextCarry。
export function laborBatches(state, typeId, level, workers, batchesPerWorkerDay, carry = 0) {
  if (!(workers > 0) || !(batchesPerWorkerDay > 0)) return { batches: 0, exact: 0 };
  const exact = workers * batchesPerWorkerDay * productivityFactor(state, typeId, level) + Math.max(0, carry || 0);
  return { batches: Math.floor(exact + 1e-9), exact };
}

// 满负荷生产时留下零头给明天；被原料或订单卡住时零头作废（没真干满）。
export function nextCarry(exact, producedBatches, laborLimited) {
  if (!laborLimited) return 0;
  return Math.max(0, Math.min(0.999, exact - producedBatches));
}
