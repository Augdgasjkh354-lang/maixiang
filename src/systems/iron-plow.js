// 铁犁牛耕改革（金银消费第三期）：玩家指定 ironPlowAcres 亩耕地改用铁犁牛耕。
//   - 改革地块每 plowAcresPerFarmer（50）亩 1 名农民（原 acresPerFarmer 10 亩 1 人），每亩产量满额（基础 + 农具 + 牛）。
//   - 上限 = min(在役耕牛头数 × 50, 全镇农具件数 × 50, 已开荒亩数)：一头牛、一件农具配 50 亩。
//   - 改小不受限（取消部分改革）；改小后该地块需要的农民增加，由待业者补岗（refillAgricultureToTarget）。
//   - 改大后，农田岗位数降低：超出的农民按现有"超岗释放"机制转为待业（setJobCount，不付辞退补偿、不凭空删人）。
import { recordEvent } from "../economy/ledger.js";
import { jobCount, setJobCount } from "./households.js";
import { farmerCapacityOf, ironPlowAcresOf, selectFarmland } from "../selectors/farmland.js";

const isWholeNonNegative = value => Number.isInteger(value) && value >= 0;

// 只读预览：改革到 acres 亩会怎样（确认前显示用）。ok = false 时 reason 写明原因。
export function previewIronPlowReform(state, content, acres) {
  const farmland = selectFarmland(state, content);
  const per = content.agriculture.acresPerFarmer;
  const perPlow = content.agriculture.plowAcresPerFarmer || per;
  const oxAcres = content.agriculture.oxAcres || 50;
  const reclaimed = farmland.acres;
  const jobs = jobCount(state, content.agriculture.farmerRoleId);
  const base = { requested: acres, current: ironPlowAcresOf(state, content), reclaimed, cap: farmland.plowCap,
    capacityBefore: farmland.farmerCapacity, jobs, ok: false, reason: null };
  if (!isWholeNonNegative(acres)) return { ...base, reason: "替代亩数须为非负整数" };
  if (acres > reclaimed) return { ...base, reason: `超过已开垦耕地 ${reclaimed} 亩` };
  const capacityAfter = Math.floor((reclaimed - acres) / per) + Math.floor(acres / perPlow);
  const released = Math.max(0, jobs - capacityAfter);
  const preview = { ...base, capacityAfter, released, unemployedAfter: released };
  if (acres <= base.current) return { ...preview, ok: true };
  // 增加的部分必须有牛、有农具：缺哪样说哪样，并给出还差多少。
  const needOx = Math.ceil(acres / oxAcres);
  const haveOx = Math.floor(farmland.oxInService + 1e-9);
  const needTools = Math.ceil(acres / oxAcres);
  const haveTools = Math.floor(farmland.toolHeld + 1e-9);
  const shortages = [];
  if (needOx > haveOx) shortages.push(`耕牛不足：替代 ${acres} 亩需在役耕牛 ${needOx} 头，现有 ${haveOx} 头，还差 ${needOx - haveOx} 头`);
  if (needTools > haveTools) shortages.push(`铁制农具不足：替代 ${acres} 亩需 ${needTools} 件，现有 ${haveTools} 件，还差 ${needTools - haveTools} 件`);
  if (shortages.length) return { ...preview, ok: false, reason: shortages.join("；") };
  return { ...preview, ok: true };
}

// 设定改革亩数：改大时超出岗位的农民转为待业；改小时目标用工随容量回升，待业者补岗。
export function setIronPlowReform(state, content, acres) {
  const preview = previewIronPlowReform(state, content, acres);
  if (!preview.ok) return { ok: false, reason: preview.reason, requested: acres };
  const roleId = content.agriculture.farmerRoleId;
  const capacityBefore = farmerCapacityOf(state, content);
  const previous = ironPlowAcresOf(state, content);
  state.agriculture.ironPlowAcres = acres;
  const capacityAfter = farmerCapacityOf(state, content);
  state.employment ||= { wageRates: {} };
  state.employment.targets ||= {};
  const oldTarget = Number.isFinite(state.employment.targets.farmers) ? Math.floor(state.employment.targets.farmers) : capacityBefore;
  // 目标用工按容量等比例调整（满员时直接等于新容量）。
  state.employment.targets.farmers = capacityBefore > 0
    ? Math.min(capacityAfter, Math.round(oldTarget * capacityAfter / capacityBefore))
    : Math.min(capacityAfter, oldTarget);
  const jobsBefore = jobCount(state, roleId);
  if (jobsBefore > capacityAfter) setJobCount(state, roleId, capacityAfter, content, { type: "town", id: "fields" });
  const released = Math.max(0, jobsBefore - jobCount(state, roleId));
  recordEvent(state, `铁犁牛耕改革：替代耕地 ${previous} → ${acres} 亩（上限 ${preview.cap} 亩）；农田岗位 ${capacityBefore} → ${capacityAfter} 人` +
    (released > 0 ? `，${released} 名农民转为待业。` : "。"), content, { gazette: { kind: "reform", weight: 3 } });
  return { ok: true, acres, previous, cap: preview.cap, capacityBefore, capacityAfter, released, reason: null };
}
