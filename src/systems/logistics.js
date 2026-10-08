import { jobCount } from "./households.js";

// 运力（docs/TRADE.md「运力」「运费」）：对外镇的货（镇长手动买卖、长期协定、将来的私人贸易行）都要从运力池里扣斤数。
//   日运力 = 外贸房在岗的基础运力 + 物流中心脚夫 × logisticsJinPerWorker + 码头工 × dockJinPerWorker。
//   池子每日按日运力补充，最多攒 freightPoolMaxDays 天的量。
//   运费只给私人贸易行（镇里自己的货不付运费）：按日运力加权平均，码头运力部分用 dockFreightVoucherPerJin。
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

// 在岗人数：岗位键与 selectors/labor.js 的 jobKeyForBuilding 同格式。这里不 import labor.js / outside-town.js，
// 否则 outside-town.js → logistics.js → labor.js → … → outside-town.js 成循环依赖（打包会拒绝）。
function staffedWorkers(state, typeId, jobId) {
  return (state.buildings || [])
    .filter(building => building.typeId === typeId)
    .reduce((sum, building) => sum + jobCount(state, `${building.id}::${jobId}`), 0);
}

// 外贸房在岗：与 outside-town.js 的 buildingOperational 同口径（同样不 import 它）。
function foreignTradeHouseOperational(state) {
  const house = (state.buildings || []).find(row => row.typeId === "foreign_trade_house");
  return Boolean(house) && jobCount(state, `${house.id}::trade_staff`) >= 1;
}

// 各来源的日运力（斤）：按在岗人数算，不是按等级或岗位数算。
export function dailyCapacityBySource(state, content) {
  return {
    foreignTradeHouse: foreignTradeHouseOperational(state) ? content.rules.tradeBaseCapacityJin : 0,
    logisticsCenter: staffedWorkers(state, PORTER_TYPE, PORTER_JOB) * content.rules.logisticsJinPerWorker,
    dock: staffedWorkers(state, DOCK_TYPE, DOCK_JOB) * content.rules.dockJinPerWorker
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

function freightPriceFromSources(sources, content) {
  const trunkJin = sources.foreignTradeHouse + sources.logisticsCenter;
  const totalJin = trunkJin + sources.dock;
  if (totalJin <= 0) return content.rules.freightVoucherPerJin;
  return (trunkJin * content.rules.freightVoucherPerJin + sources.dock * content.rules.dockFreightVoucherPerJin) / totalJin;
}

// 私人贸易行每运一斤的运费（券/斤）：按日运力加权；没有运力时取物流中心的单价。
export function freightVoucherPerJin(state, content) {
  return freightPriceFromSources(dailyCapacityBySource(state, content), content);
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
    freightVoucherPerJin: freightPriceFromSources(sources, content),
    history: (Array.isArray(state.logistics?.history) ? state.logistics.history : []).map(row => ({ ...row }))
  };
}
