// 民营工资：每栋民营建筑有自己的日薪（building.privateWage），业主按行情与经营自主调整。
//
// 参照价 = 镇营同岗位实际日薪（基础日薪 × 镇营产业类系数），所以镇长调系数会经劳动力市场传到民营。
// 没调过的建筑直接用参照价；每 privateWageAdjustIntervalDays 天评估一次：
//   欠薪或近期亏损 → 减薪（不低于参照价 × privateWageFloorPercent%）；
//   低于行情目标（参照价 × 失业松紧系数）且赚得起 → 向目标加薪；
//   招不满计划人数、人手紧且赚钱 → 高出行情加薪抢人；
//   高于目标且不缺人 → 回调。
// 换主人时清掉（ownership.js），新业主从参照价起步。

import { privateWageRate, townWageRate } from "./payroll.js";
import { computeLaborMarket } from "./labor-market.js";
import { privateJobKeyForBuilding, readJobCount } from "../selectors/labor.js";
import { plannedWorkersForProducer } from "../economy/operating-plan.js";
import { daySerialOf } from "./ownership.js";
import { isIndustryType } from "../content/buildings.js";
import { currencyScale } from "../economy/currency.js";

function roundHalf(value) {
  return Math.round(value * 2) / 2;
}

function recentPrivateProfitVoucher(state, building, days, content) {
  const serial = daySerialOf(state, content);
  const rows = (building.privateProfitHistory || []).filter(row => Number.isInteger(row.serial) && row.serial > serial - days && row.serial <= serial);
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + (row.profitVoucherUnits || 0), 0) / rows.length / currencyScale(content);
}

export function adjustPrivateWage(state, building, content, market = null) {
  const definition = content.buildings[building.typeId];
  const job = definition?.jobs?.[0];
  if (!job || !((building.ownership?.privateLevels || 0) > 0)) return null;
  const rules = content.rules;
  const interval = Math.max(1, rules.privateWageAdjustIntervalDays ?? 15);
  const serial = daySerialOf(state, content);
  const book = building.privateWage ||= {};
  if (!Number.isFinite(book.lastSerial)) { book.lastSerial = serial; return null; }
  if (serial - book.lastSerial < interval) return null;
  book.lastSerial = serial;

  const labor = market || computeLaborMarket(state, content);
  const reference = townWageRate(state, job.id, content);
  const moodFactor = labor.mood === "slack" ? rules.shopWageSlackFactor ?? 0.85 : labor.mood === "tight" ? rules.shopWageTightFactor ?? 1.2 : 1;
  const target = roundHalf(reference * moodFactor);
  const floor = roundHalf(reference * (rules.privateWageFloorPercent ?? 50) / 100);
  const step = Math.max(0.5, roundHalf(reference * (rules.privateWageStepPercent ?? 10) / 100));
  const current = privateWageRate(state, building, job, content);
  const workers = readJobCount(state, privateJobKeyForBuilding(building.id, job.id));
  const planned = plannedWorkersForProducer(state, `private:${building.id}`);
  const wantsMore = Number.isFinite(planned) && planned > workers;
  const arrears = (state.privateEconomy?.payrollByBuilding?.[building.id]?.arrearsVoucherUnits || 0) > 0;
  const profit = recentPrivateProfitVoucher(state, building, interval, content);
  const affordRaise = profit !== null && profit - Math.max(1, workers) * step > 0;

  let next = current;
  let diagnosis = "工资维持";
  if (arrears || (profit !== null && profit < 0)) {
    next = Math.max(floor, current - step);
    diagnosis = arrears ? (next < current ? "欠薪，减薪" : "欠薪，已到工资下限") : (next < current ? "亏损，减薪" : "亏损，已到工资下限");
  } else if (current < target && affordRaise) {
    next = Math.min(target, current + step);
    diagnosis = "向行情加薪";
  } else if (wantsMore && affordRaise && labor.mood !== "slack") {
    next = current + step;
    diagnosis = "招不到人，加薪抢人";
  } else if (current > target && !wantsMore) {
    next = Math.max(target, current - step);
    diagnosis = "高于行情，回调工资";
  }
  book.wagePerWorkerDay = Math.max(floor, next);
  book.target = target;
  book.diagnosis = diagnosis;
  return { buildingId: building.id, wage: book.wagePerWorkerDay, target, diagnosis };
}

export function adjustPrivateWages(state, content) {
  const buildings = (state.buildings || []).filter(row => isIndustryType(content, row.typeId) && (row.ownership?.privateLevels || 0) > 0);
  if (!buildings.length) return [];
  const market = computeLaborMarket(state, content);
  return buildings.map(building => adjustPrivateWage(state, building, content, market)).filter(Boolean);
}
