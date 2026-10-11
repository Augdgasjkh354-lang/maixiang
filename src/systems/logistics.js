import { jobCount } from "./households.js";
import { educationBonus, experienceBonus, levelBonus, productivityFactor } from "../economy/productivity.js";

// 运力（docs/TRADE.md「运力」「运费」）：对外镇的货（镇长手动买卖、长期协定、将来的私人贸易行）都要从运力池里扣斤数。
//   日运力 = 外贸房在岗的基础运力 + Σ 物流中心在岗人数 × logisticsJinPerWorker × 生产率系数 + Σ 码头在岗人数 × dockJinPerWorker × 生产率系数。
//   生产率系数 = 等级加成 × 熟练度加成 × 教育加成（economy/productivity.js 的 productivityFactor，按每栋建筑自己的等级算）。
//   池子每日按日运力补充，最多攒 freightPoolMaxDays 天的量。
//   运费只给私人贸易行（镇里自己的货不付运费）：按基础运力加权平均；单价 = 人力成本（工人日薪 ÷ 每人日基础运力）。
//   运费不随生产率系数变：否则等级越高运费越低，改变运费设计（见 CHANGELOG「标准开局」一节）。
// 运力是斤数（不是粮券）；所有读取都不写 state，只有日结步骤和 take/refund 写池子。

const HISTORY_LIMIT = 30;
const PORTER_TYPE = "logistics_center";
const PORTER_JOB = "porters";
const DOCK_TYPE = "dock";
const DOCK_JOB = "dockers";

// 浮点误差清理：运力池按百万分之一斤保留，避免累计出现 0.1+0.2 式的尾数。
const clean = value => Math.round(value * 1e6) / 1e6;
const nonNegative = value => Math.max(0, Number(value) || 0);

export function ensureLogistics(state) {
  state.logistics ||= { poolJin: 0, usedToday: 0, history: [] };
  return state.logistics;
}

// 在岗人数：岗位键与 selectors/labor.js 的 jobKeyForBuilding 同格式（jobCount 读的就是这个键）。这里不 import labor.js / outside-town.js，
// 否则 outside-town.js → logistics.js → labor.js → … → outside-town.js 成循环依赖（打包会拒绝）。

// 外贸房在岗：与 outside-town.js 的 buildingOperational 同口径（同样不 import 它）。
function foreignTradeHouseOperational(state) {
  const house = (state.buildings || []).find(row => row.typeId === "foreign_trade_house");
  return Boolean(house) && jobCount(state, `${house.id}::trade_staff`) >= 1;
}

const sumOf = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0);

// 每栋物流中心 / 码头：在岗人数 × 每人日基础运力 × 该栋的生产率系数（等级按这栋建筑，熟练度与教育按全镇）。
function freightBuildingRows(state, content, typeId, jobId, perWorkerJin) {
  return (state.buildings || [])
    .filter(building => building.typeId === typeId)
    .map(building => {
      const workers = jobCount(state, `${building.id}::${jobId}`);
      const factor = productivityFactor(state, typeId, building.level || 1);
      return { workers, baseJin: workers * perWorkerJin, effectiveJin: workers * perWorkerJin * factor };
    });
}

// 各来源的日运力（斤，含等级 / 熟练度 / 教育加成）：按在岗人数算，不是按等级或岗位数算。外贸房基础运力不变。
export function dailyCapacityBySource(state, content) {
  return {
    foreignTradeHouse: foreignTradeHouseOperational(state) ? content.rules.tradeBaseCapacityJin : 0,
    logisticsCenter: sumOf(freightBuildingRows(state, content, PORTER_TYPE, PORTER_JOB, content.rules.logisticsJinPerWorker), "effectiveJin"),
    dock: sumOf(freightBuildingRows(state, content, DOCK_TYPE, DOCK_JOB, content.rules.dockJinPerWorker), "effectiveJin")
  };
}

// 基础日运力（斤，不含生产率系数）：只用于运费加权，让运费保持按基础每人日运力算。
function baseCapacityBySource(state, content) {
  return {
    foreignTradeHouse: foreignTradeHouseOperational(state) ? content.rules.tradeBaseCapacityJin : 0,
    logisticsCenter: sumOf(freightBuildingRows(state, content, PORTER_TYPE, PORTER_JOB, content.rules.logisticsJinPerWorker), "baseJin"),
    dock: sumOf(freightBuildingRows(state, content, DOCK_TYPE, DOCK_JOB, content.rules.dockJinPerWorker), "baseJin")
  };
}

export function dailyCapacityJin(state, content) {
  const sources = dailyCapacityBySource(state, content);
  return sources.foreignTradeHouse + sources.logisticsCenter + sources.dock;
}

export function freightPoolJin(state) {
  return clean(nonNegative(state.logistics?.poolJin));
}

// 池子里能整单位发出的量（库存单位），向下取整，保证四舍五入后不超出池子。
export function freightCapacityUnits(state, content) {
  return Math.floor(freightPoolJin(state) * content.precision.inventoryUnitsPerJin + 1e-6);
}

// 从池子里扣 jin 斤，返回实际批准的斤数（不超过池子余量）。
// 调用方应在交易确认成功之后再扣；失败要退回时用 refundFreightCapacity。
export function takeFreightCapacity(state, jin, content) {
  void content;
  const logistics = ensureLogistics(state);
  const pool = freightPoolJin(state);
  const granted = clean(Math.min(nonNegative(jin), pool));
  logistics.poolJin = clean(pool - granted);
  logistics.usedToday = clean(nonNegative(logistics.usedToday) + granted);
  return granted;
}

// 失败回滚：把已扣的运力还回池子。
export function refundFreightCapacity(state, jin) {
  const logistics = ensureLogistics(state);
  const amount = clean(nonNegative(jin));
  logistics.poolJin = clean(freightPoolJin(state) + amount);
  logistics.usedToday = clean(Math.max(0, nonNegative(logistics.usedToday) - amount));
  return amount;
}

// 运费 = 搬一斤货的人力成本（用多少人力就付多少钱）：工人日薪 ÷ 每人日运力。
// 走物流中心与外贸房运力的部分按脚夫的人力成本（5 ÷ 60 ≈ 0.0833 券/斤），走码头的部分按码头工（5 ÷ 120 ≈ 0.0417 券/斤）。
// 工资和运力都来自内容定义，改工资或运力运费自动跟着变。
function jobWage(content, typeId, jobId) {
  return Number(content.buildings?.[typeId]?.jobs?.find(job => job.id === jobId)?.wagePerWorkerDay) || 0;
}
export function trunkFreightRate(content) {
  return jobWage(content, PORTER_TYPE, PORTER_JOB) / Math.max(1, content.rules.logisticsJinPerWorker);
}
export function dockFreightRate(content) {
  return jobWage(content, DOCK_TYPE, DOCK_JOB) / Math.max(1, content.rules.dockJinPerWorker);
}

function freightPriceFromSources(sources, content) {
  const trunkJin = sources.foreignTradeHouse + sources.logisticsCenter;
  const totalJin = trunkJin + sources.dock;
  if (totalJin <= 0) return trunkFreightRate(content);
  return (trunkJin * trunkFreightRate(content) + sources.dock * dockFreightRate(content)) / totalJin;
}

// 私人贸易行每运一斤的运费（券/斤）：按日运力加权；没有运力时取物流中心的单价。
export function freightVoucherPerJin(state, content) {
  return freightPriceFromSources(baseCapacityBySource(state, content), content);
}

// 日结步骤 "logistics"：按在岗人数补充池子（封顶），清当日已用量，记一条历史。
// 历史行的 usedJin 是这一天（结算前）已经用掉的运力。
export function stepLogistics(state, content) {
  const logistics = ensureLogistics(state);
  const dailyJin = dailyCapacityJin(state, content);
  const usedJin = clean(nonNegative(logistics.usedToday));
  // 攒到 30 天日运力为止；日运力下降（如外贸房暂时没人）时不清掉已攒下的运力，只是不再往上加。
  const current = freightPoolJin(state);
  const cap = dailyJin * content.rules.freightPoolMaxDays;
  const poolJin = clean(current >= cap ? current : Math.min(current + dailyJin, cap));
  logistics.poolJin = poolJin;
  logistics.usedToday = 0;
  const history = Array.isArray(logistics.history) ? logistics.history : [];
  logistics.history = [...history, { year: state.year, day: state.day, capacityJin: dailyJin, poolJin, usedJin }].slice(-HISTORY_LIMIT);
  return { capacityJin: dailyJin, poolJin, usedJin };
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

// 运力类建筑的生产率展示（只读）：每人日运力 = 基础每人日运力 × 生产率系数。
// 系数按在岗人数加权（没人在岗时取建筑的平均等级系数，没有建筑时按 1 级）。
function freightTypeProductivity(state, content, typeId, jobId, perWorkerJin) {
  const rows = (state.buildings || []).filter(building => building.typeId === typeId)
    .map(building => ({ level: building.level || 1, workers: jobCount(state, `${building.id}::${jobId}`) }));
  const weighted = valueOf => {
    const workers = sumOf(rows, "workers");
    if (workers > 0) return rows.reduce((sum, row) => sum + row.workers * valueOf(row), 0) / workers;
    if (rows.length) return rows.reduce((sum, row) => sum + valueOf(row), 0) / rows.length;
    return valueOf({ level: 1, workers: 0 });
  };
  const factor = weighted(row => productivityFactor(state, typeId, row.level));
  return {
    perWorkerBaseJin: perWorkerJin,
    perWorkerJin: round(perWorkerJin * factor, 2),
    productivityFactor: round(factor, 2),
    levelBonusPercent: round((weighted(row => levelBonus(row.level)) - 1) * 100, 1),
    experiencePercent: round((experienceBonus(state, typeId) - 1) * 100, 1),
    educationPercent: round((educationBonus(state) - 1) * 100, 1)
  };
}

// 单座建筑的人均运力（只读，建筑面板用）：不是运力类建筑返回 null。
export function freightBuildingView(state, content, building) {
  const spec = freightSpec(content, building?.typeId);
  if (!spec) return null;
  const level = building.level || 1;
  const factor = productivityFactor(state, building.typeId, level);
  return {
    perWorkerBaseJin: spec.perWorkerJin,
    perWorkerJin: round(spec.perWorkerJin * factor, 2),
    productivityFactor: round(factor, 2),
    levelBonusPercent: round((levelBonus(level) - 1) * 100, 1),
    experiencePercent: round((experienceBonus(state, building.typeId) - 1) * 100, 1),
    educationPercent: round((educationBonus(state) - 1) * 100, 1)
  };
}

function freightSpec(content, typeId) {
  if (typeId === PORTER_TYPE) return { jobId: PORTER_JOB, perWorkerJin: content.rules.logisticsJinPerWorker };
  if (typeId === DOCK_TYPE) return { jobId: DOCK_JOB, perWorkerJin: content.rules.dockJinPerWorker };
  return null;
}

// 只读：界面与 selectDashboard 用。
export function selectLogisticsView(state, content) {
  const sources = dailyCapacityBySource(state, content);
  const dailyJin = sources.foreignTradeHouse + sources.logisticsCenter + sources.dock;
  return {
    dailyCapacityJin: dailyJin,
    capacityBySource: sources,
    poolJin: freightPoolJin(state),
    maxPoolJin: dailyJin * content.rules.freightPoolMaxDays,
    usedTodayJin: clean(nonNegative(state.logistics?.usedToday)),
    freightVoucherPerJin: freightPriceFromSources(baseCapacityBySource(state, content), content),
    // 物流中心 / 码头的人均运力（等级、熟练度、教育加成后）：界面展示用。
    productivity: {
      logisticsCenter: freightTypeProductivity(state, content, PORTER_TYPE, PORTER_JOB, content.rules.logisticsJinPerWorker),
      dock: freightTypeProductivity(state, content, DOCK_TYPE, DOCK_JOB, content.rules.dockJinPerWorker)
    },
    history: (Array.isArray(state.logistics?.history) ? state.logistics.history : []).map(row => ({ ...row }))
  };
}
