import { qeqUnitsForInventoryUnits } from "../economy/inventory.js";
import { allocateIntegerByWeight } from "../core/allocation.js";

function emptyInventory(content) {
  return Object.fromEntries(Object.keys(content.items).map(itemId => [itemId, 0]));
}

const householdListCache = new WeakMap();

function numericSuffix(id) {
  const match = String(id || "").match(/(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function emptyHousehold(index, content) {
  return createHousehold(index + 1, content);
}

// 新建一户空家庭（编号 number → id household-N，名"第N户"）。分家也用它。
export function createHousehold(number, content) {
  return {
    id: `household-${number}`,
    name: `第${number}户`,
    ageBands: { children: 0, workers: 0, elders: 0 },
    jobs: {},
    inventory: emptyInventory(content),
    voucherUnits: 0,
    shares: {},
    shopIds: [],
    operatingRights: [],
    income: { dayVoucherUnits: 0, yearVoucherUnits: 0, cumulativeVoucherUnits: 0, history: [] },
    agricultureWorkUnits: 0
  };
}

export function householdPopulation(householdOrState, householdId = null) {
  const household = householdId === null
    ? householdOrState
    : householdOrState.households?.byId?.[householdId];
  if (!household) return 0;
  const bands = household.ageBands || {};
  return Math.max(0, bands.children || 0) + Math.max(0, bands.workers || 0) + Math.max(0, bands.elders || 0);
}

export function householdWorkingAge(household) {
  return Math.max(0, household?.ageBands?.workers || 0);
}

export function householdEmploymentCount(household) {
  return Object.values(household?.jobs || {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

export function householdIdleWorkers(household) {
  return Math.max(0, householdWorkingAge(household) - householdEmploymentCount(household));
}

export function isActiveHousehold(household) {
  return householdPopulation(household) > 0;
}

export function createInitialHouseholds(state, content) {
  // 开局户数：默认按人口 ÷ initialHouseholdSize（5 人一户）；initialHouseholdCount 可直接指定（规模测试用）。
  const population = state.cohorts.reduce((sum, cohort) => sum + cohort.m + cohort.f, 0);
  const householdCount = Math.max(1, Math.floor(content.rules.initialHouseholdCount
    ?? Math.round(population / Math.max(1, content.rules.initialHouseholdSize ?? 5))));
  const households = Array.from({ length: householdCount }, (_, index) => emptyHousehold(index, content));
  const totals = { children: 0, workers: 0, elders: 0 };
  for (const cohort of state.cohorts) {
    const count = cohort.m + cohort.f;
    if (cohort.age < 18) totals.children += count;
    else if (cohort.age < 65) totals.workers += count;
    else totals.elders += count;
  }
  // Keep the old opening distribution shape: two workers per household first, then extras.
  let workersLeft = totals.workers;
  for (let pass = 0; pass < 2 && workersLeft > 0; pass += 1) {
    for (const household of households) {
      if (workersLeft <= 0) break;
      household.ageBands.workers += 1;
      workersLeft -= 1;
    }
  }
  for (let index = 0; workersLeft > 0; index = (index + 1) % householdCount) {
    households[index].ageBands.workers += 1;
    workersLeft -= 1;
  }
  for (let i = 0; i < totals.children; i += 1) households[i % householdCount].ageBands.children += 1;
  for (let i = 0; i < totals.elders; i += 1) households[i % householdCount].ageBands.elders += 1;

  const initialResident = { ...(state.accounts?.residents || {}) };
  for (const [itemId, total] of Object.entries(initialResident)) {
    const allocation = allocateIntegerByWeight(total, households, household => householdPopulation(household));
    if (!allocation.ok) throw new Error("初始家庭库存分配失败：" + allocation.reason);
    for (const { recipient: household, units } of allocation.rows) household.inventory[itemId] = units;
  }
  state.households = {
    byId: Object.fromEntries(households.map(row => [row.id, row])),
    nextHouseholdNumber: householdCount + 1,
    exchange: { dayKey: null, eligibleByHousehold: {}, usedByHousehold: {} }
  };
  // Initial farmers use the same household-job allocation mechanism as later employment changes.
  // Do not open the daily exchange snapshot during new-game construction; the first real
  // exchange query snapshots the complete opening employment instead of a partial roster.
  const farmerCount = Math.max(0, Math.floor(content.initial.roleCounts?.farmers || 0));
  if (farmerCount) setJobCount(state, "farmers", farmerCount, null, { employerType: "farm", employerId: "fields" });
  syncResidentAggregates(state, content);
  return state.households;
}

export function hasHouseholds(state) {
  return Boolean(state.households?.byId);
}

export function householdList(state) {
  const byId = state.households?.byId;
  if (!byId) return [];
  let rows = householdListCache.get(byId);
  if (!rows) {
    rows = Object.values(byId).sort((a, b) => numericSuffix(a.id) - numericSuffix(b.id));
    householdListCache.set(byId, rows);
  }
  return rows;
}

export function activeHouseholds(state) {
  return householdList(state).filter(isActiveHousehold);
}

export function totalHouseholdAgeBands(state) {
  return householdList(state).reduce((totals, household) => {
    totals.children += household.ageBands?.children || 0;
    totals.workers += household.ageBands?.workers || 0;
    totals.elders += household.ageBands?.elders || 0;
    return totals;
  }, { children: 0, workers: 0, elders: 0 });
}

// 按岗位缓存"哪些家庭在这个岗位上、各几人"。家庭岗位只经 setHouseholdJobCount 改动，改动时清掉该岗位的缓存；
// 家庭增减会换掉 byId 对象，缓存随之失效（同 householdList）。返回的数组只读。
const jobIndexCache = new WeakMap();

function jobIndex(state) {
  const byId = state.households?.byId;
  if (!byId) return null;
  let index = jobIndexCache.get(byId);
  if (!index) { index = new Map(); jobIndexCache.set(byId, index); }
  return index;
}

export function jobAssignments(state, jobKey) {
  const index = jobIndex(state);
  const cached = index?.get(jobKey);
  if (cached) return cached.rows;
  const rows = Object.freeze(householdList(state)
    .map(household => ({ householdId: household.id, count: Math.max(0, household.jobs?.[jobKey] || 0) }))
    .filter(row => row.count > 0)
    .map(row => Object.freeze(row)));
  const count = rows.reduce((sum, row) => sum + row.count, 0);
  index?.set(jobKey, { rows, count });
  return rows;
}

export function jobCount(state, jobKey) {
  const cached = jobIndex(state)?.get(jobKey);
  if (cached) return cached.count;
  jobAssignments(state, jobKey);
  return jobIndex(state)?.get(jobKey)?.count ?? 0;
}

function currentDayKey(state) {
  return `${state.year}:${state.day}`;
}

export function ensureEmploymentExchangeDay(state, content) {
  if (!hasHouseholds(state)) return null;
  const exchange = state.households.exchange ||= { dayKey: null, eligibleByHousehold: {}, usedByHousehold: {}, peakEmploymentCount: 0 };
  const dayKey = currentDayKey(state);
  if (exchange.dayKey !== dayKey) {
    exchange.dayKey = dayKey;
    exchange.eligibleByHousehold = Object.fromEntries(householdList(state).map(household => [household.id, householdEmploymentCount(household)]));
    exchange.usedByHousehold = {};
    exchange.peakEmploymentCount = Object.values(exchange.eligibleByHousehold).reduce((sum, count) => sum + count, 0);
  } else if (!Number.isInteger(exchange.peakEmploymentCount) || exchange.peakEmploymentCount < 0) {
    exchange.peakEmploymentCount = Object.values(exchange.eligibleByHousehold || {}).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
  }
  return exchange;
}

export function touchHouseholdEmploymentEligibility(state, householdId, content) {
  const exchange = ensureEmploymentExchangeDay(state, content);
  const household = state.households?.byId?.[householdId];
  if (!exchange || !household) return;
  const totalEmployment = householdList(state).reduce((sum, row) => sum + householdEmploymentCount(row), 0);
  if (totalEmployment <= exchange.peakEmploymentCount) return;
  let additional = totalEmployment - exchange.peakEmploymentCount;
  // Same-day job churn must not mint a second exchange quota. Only a new all-town
  // employment high-water mark creates new eligible slots, first for the household
  // that received the added job and then, deterministically, for any other new slots.
  const preferred = [household, ...householdList(state).filter(row => row.id !== household.id)];
  for (const row of preferred) {
    if (additional <= 0) break;
    const eligible = Math.max(0, exchange.eligibleByHousehold?.[row.id] || 0);
    const employed = householdEmploymentCount(row);
    const room = Math.max(0, employed - eligible);
    if (room <= 0) continue;
    const add = Math.min(room, additional);
    exchange.eligibleByHousehold[row.id] = eligible + add;
    additional -= add;
  }
  exchange.peakEmploymentCount = totalEmployment;
}

export function setHouseholdJobCount(state, householdId, jobKey, requested, content = null) {
  const household = state.households?.byId?.[householdId];
  if (!household) return { ok: false, reason: "家庭不存在" };
  const target = Math.max(0, Math.floor(Number(requested) || 0));
  const current = Math.max(0, household.jobs?.[jobKey] || 0);
  const other = householdEmploymentCount(household) - current;
  // 只拦增岗：减岗（含劳动力减少后释放超额岗位、整户去世释放全部岗位）永远允许。
  if (target > current && other + target > householdWorkingAge(household)) return { ok: false, reason: "该家庭没有足够待业劳动力" };
  household.jobs ||= {};
  if (target > 0) household.jobs[jobKey] = target;
  else delete household.jobs[jobKey];
  if (target !== current) jobIndex(state)?.delete(jobKey);
  if (content && target > current) touchHouseholdEmploymentEligibility(state, householdId, content);
  return { ok: true, before: current, after: target };
}

export function setJobCount(state, jobKey, requested, content = null, employer = {}) {
  const target = Math.max(0, Math.floor(Number(requested) || 0));
  const households = householdList(state);
  let current = jobCount(state, jobKey);
  const released = [];
  const assigned = [];
  if (current > target) {
    let left = current - target;
    const holders = households.filter(household => (household.jobs?.[jobKey] || 0) > 0)
      .sort((a, b) => householdEmploymentCount(b) - householdEmploymentCount(a) || numericSuffix(b.id) - numericSuffix(a.id));
    for (const household of holders) {
      if (left <= 0) break;
      const before = household.jobs[jobKey] || 0;
      const cut = Math.min(before, left);
      setHouseholdJobCount(state, household.id, jobKey, before - cut, null);
      released.push({ householdId: household.id, count: cut });
      left -= cut;
    }
  } else if (current < target) {
    let left = target - current;
    const candidates = households.filter(household => householdIdleWorkers(household) > 0)
      .sort((a, b) => householdEmploymentCount(a) - householdEmploymentCount(b) || numericSuffix(a.id) - numericSuffix(b.id));
    for (const household of candidates) {
      if (left <= 0) break;
      const add = Math.min(left, householdIdleWorkers(household));
      if (add <= 0) continue;
      const before = household.jobs?.[jobKey] || 0;
      setHouseholdJobCount(state, household.id, jobKey, before + add, content);
      assigned.push({ householdId: household.id, count: add, employerType: employer.employerType || employer.type || null, employerId: employer.employerId || employer.id || null });
      left -= add;
    }
  }
  current = jobCount(state, jobKey);
  return { ok: current === target, target, assigned: current, assignedRows: assigned, releasedRows: released,
    reason: current === target ? null : "全镇没有足够待业劳动力" };
}

export function releaseJobFromHousehold(state, householdId, jobKey, count = Number.MAX_SAFE_INTEGER) {
  const household = state.households?.byId?.[householdId];
  if (!household) return 0;
  const before = Math.max(0, household.jobs?.[jobKey] || 0);
  const cut = Math.min(before, Math.max(0, Math.floor(count)));
  if (cut <= 0) return 0;
  setHouseholdJobCount(state, householdId, jobKey, before - cut, null);
  return cut;
}

export function jobReleaseRank(jobKey) {
  if (jobKey.endsWith(":clerk")) return 1000;
  if (jobKey.includes("::private")) return 800;
  if (jobKey.includes("::listed")) return 700;
  if (jobKey.includes("::")) return 600;
  if (jobKey === "builders") return 500;
  if (jobKey === "farmers") return 100;
  if (jobKey.endsWith(":merchant")) return 0;
  return 400;
}

export function releaseExcessHouseholdEmployment(state) {
  const changes = [];
  for (const household of householdList(state)) {
    let excess = householdEmploymentCount(household) - householdWorkingAge(household);
    if (excess <= 0) continue;
    const keys = Object.keys(household.jobs || {}).filter(key => household.jobs[key] > 0)
      .sort((a, b) => jobReleaseRank(b) - jobReleaseRank(a) || b.localeCompare(a));
    for (const jobKey of keys) {
      if (excess <= 0) break;
      const cut = Math.min(excess, household.jobs[jobKey] || 0);
      if (cut <= 0) continue;
      releaseJobFromHousehold(state, household.id, jobKey, cut);
      changes.push({ householdId: household.id, jobKey, count: cut });
      excess -= cut;
    }
    if (excess > 0) throw new Error("家庭就业释放失败：" + household.id);
  }
  return changes;
}

function constrainedAllocation(total, candidates, weightFn, capacityFn) {
  let left = Math.max(0, Math.floor(total));
  const result = new Map(candidates.map(row => [row.id, 0]));
  let eligible = candidates.filter(row => capacityFn(row) > 0);
  while (left > 0 && eligible.length) {
    const allocation = allocateIntegerByWeight(left, eligible, row => Math.max(0, weightFn(row)));
    if (!allocation.ok) {
      // Equal stable fallback when all weights are zero.
      for (const row of eligible) {
        if (left <= 0) break;
        const room = capacityFn(row) - (result.get(row.id) || 0);
        if (room <= 0) continue;
        result.set(row.id, (result.get(row.id) || 0) + 1);
        left -= 1;
      }
    } else {
      let moved = 0;
      for (const { recipient: row, units } of allocation.rows) {
        const room = Math.max(0, capacityFn(row) - (result.get(row.id) || 0));
        const amount = Math.min(room, units);
        if (amount <= 0) continue;
        result.set(row.id, (result.get(row.id) || 0) + amount);
        moved += amount;
      }
      left -= moved;
      if (moved <= 0) break;
    }
    eligible = eligible.filter(row => (result.get(row.id) || 0) < capacityFn(row));
  }
  if (left > 0) throw new Error("人口聚合分配超出家庭可用人数");
  return result;
}

function reduceBand(state, band, count) {
  const households = householdList(state);
  const allocation = constrainedAllocation(count, households, h => h.ageBands?.[band] || 0, h => h.ageBands?.[band] || 0);
  for (const household of households) household.ageBands[band] -= allocation.get(household.id) || 0;
  return allocation;
}

function moveBand(state, from, to, count) {
  const households = householdList(state);
  const allocation = constrainedAllocation(count, households, h => h.ageBands?.[from] || 0, h => h.ageBands?.[from] || 0);
  for (const household of households) {
    const amount = allocation.get(household.id) || 0;
    household.ageBands[from] -= amount;
    household.ageBands[to] += amount;
  }
  return allocation;
}

function addBirths(state, count) {
  if (count <= 0) return new Map();
  let candidates = householdList(state).filter(h => householdWorkingAge(h) > 0 && isActiveHousehold(h));
  if (!candidates.length) candidates = householdList(state).filter(isActiveHousehold);
  if (!candidates.length) candidates = householdList(state);
  const allocation = allocateIntegerByWeight(count, candidates, h => Math.max(1, householdWorkingAge(h)));
  if (!allocation.ok) throw new Error("新生人口分配失败：" + allocation.reason);
  const result = new Map();
  for (const { recipient: household, units } of allocation.rows) {
    household.ageBands.children += units;
    result.set(household.id, units);
  }
  return result;
}

export function applyHouseholdDemography(state, changes) {
  const before = totalHouseholdAgeBands(state);
  const childDeaths = Math.max(0, Math.floor(changes.childDeaths || 0));
  const workerDeaths = Math.max(0, Math.floor(changes.workerDeaths || 0));
  const elderDeaths = Math.max(0, Math.floor(changes.elderDeaths || 0));
  const adults = Math.max(0, Math.floor(changes.adults || 0));
  const retirees = Math.max(0, Math.floor(changes.retirees || 0));
  const births = Math.max(0, Math.floor(changes.births || 0));
  reduceBand(state, "children", childDeaths);
  const workerLoss = reduceBand(state, "workers", workerDeaths);
  const elderLoss = reduceBand(state, "elders", elderDeaths);
  moveBand(state, "workers", "elders", retirees);
  moveBand(state, "children", "workers", adults);
  addBirths(state, births);
  const employmentReleases = releaseExcessHouseholdEmployment(state);
  // 每户去世的成年人数（劳动力 + 老人），供遗产税与家产归公使用（docs/REDISTRIBUTION.md 第 2 条）。
  const adultDeathsByHousehold = {};
  for (const household of householdList(state)) {
    const count = (workerLoss.get(household.id) || 0) + (elderLoss.get(household.id) || 0);
    if (count > 0) adultDeathsByHousehold[household.id] = count;
  }
  return { before, after: totalHouseholdAgeBands(state), employmentReleases, adultDeathsByHousehold };
}

// 一批逐户收付（发工资、服务消费等）期间先不汇总居民账，结束时统一汇总一次。
export function withDeferredHouseholdSync(state, content, fn) {
  const previous = Boolean(state._deferHouseholdSync);
  state._deferHouseholdSync = true;
  try {
    return fn();
  } finally {
    state._deferHouseholdSync = previous;
    if (!previous && state._householdSyncDirty) syncResidentAggregates(state, content);
  }
}

export function syncResidentAggregates(state, content) {
  if (!hasHouseholds(state)) return;
  if (state._deferHouseholdSync) { state._householdSyncDirty = true; return; }
  state._householdSyncDirty = false;
  state.accounts ||= {};
  const itemIds = Object.keys(content.items);
  const totals = Object.fromEntries(itemIds.map(itemId => [itemId, 0]));
  let voucherUnits = 0;
  for (const household of householdList(state)) {
    voucherUnits += household.voucherUnits || 0;
    for (const itemId of itemIds) totals[itemId] += household.inventory?.[itemId] || 0;
  }
  state.accounts.residents ||= emptyInventory(content);
  for (const itemId of itemIds) state.accounts.residents[itemId] = totals[itemId];
  state.currency ||= {};
  state.currency.balances ||= { town: 0, residents: 0 };
  state.currency.balances.residents = voucherUnits;
}

export function residentInventoryUnits(state, itemId) {
  if (!hasHouseholds(state)) return state.accounts?.residents?.[itemId] || 0;
  if (state._deferHouseholdSync) return householdList(state).reduce((sum, household) => sum + (household.inventory?.[itemId] || 0), 0);
  return state.accounts?.residents?.[itemId] || 0;
}

export function residentVoucherUnits(state) {
  if (!hasHouseholds(state)) return state.currency?.balances?.residents || 0;
  if (state._deferHouseholdSync) return householdList(state).reduce((sum, household) => sum + (household.voucherUnits || 0), 0);
  return state.currency?.balances?.residents || 0;
}

// 按 content.items 缓存物品列表（每天被调用上百万次，不再每次 Object.entries 分配）。
// content 冻结后不变；mod 注册在开局前完成，新的 content.items 对象会得到新缓存。
const itemEntriesCache = new WeakMap();
function itemEntries(content) {
  let cached = itemEntriesCache.get(content.items);
  if (!cached) {
    const all = Object.entries(content.items);
    cached = { all, otherFood: all.filter(([itemId, item]) => itemId !== "wheat" && item.edible && item.qeq) };
    itemEntriesCache.set(content.items, cached);
  }
  return cached;
}

export function householdFoodQeqUnits(state, household, content) {
  let total = 0;
  for (const [itemId, item] of itemEntries(content).all) total += qeqUnitsForInventoryUnits(item, household.inventory?.[itemId] || 0, content);
  return total;
}

export function householdReserveQeqUnits(state, household, content, reserveDays = null) {
  const days = reserveDays ?? content.rules.householdFoodReserveDays ?? 30;
  return householdPopulation(household) * content.rules.foodPerPersonDay * days * content.precision.qeqUnitsPerJin;
}

export function householdConvertibleWheatUnits(state, household, content, reserveDays = null) {
  const wheat = household.inventory?.wheat || 0;
  if (wheat <= 0) return 0;
  const reserve = householdReserveQeqUnits(state, household, content, reserveDays);
  let otherFoodQeq = 0;
  for (const [itemId, item] of itemEntries(content).otherFood) {
    otherFoodQeq += qeqUnitsForInventoryUnits(item, household.inventory?.[itemId] || 0, content);
  }
  const wheatQeqPerUnit = qeqUnitsForInventoryUnits(content.items.wheat, 1, content);
  const requiredWheatUnits = Math.max(0, Math.ceil((reserve - otherFoodQeq) / Math.max(1, wheatQeqPerUnit)));
  return Math.max(0, wheat - requiredWheatUnits);
}

export function householdExchangeAllowanceUnits(state, householdId, content) {
  const exchange = ensureEmploymentExchangeDay(state, content);
  if (!exchange) return Number.MAX_SAFE_INTEGER;
  const policyJin = Math.max(content.rules.employmentExchangeMinimumJin ?? 0,
    Math.min(content.rules.employmentExchangeMaximumJin ?? 50, Number(state.policy?.employmentExchangeJin ?? content.rules.employmentExchangeDefaultJin ?? 5)));
  const employed = exchange.eligibleByHousehold?.[householdId] || 0;
  const gross = Math.round(employed * policyJin * content.precision.inventoryUnitsPerJin);
  const used = exchange.usedByHousehold[householdId] || 0;
  return Math.max(0, gross - used);
}

export function consumeHouseholdExchangeAllowance(state, householdId, units, content) {
  if (!Number.isSafeInteger(units) || units < 0) return false;
  const exchange = ensureEmploymentExchangeDay(state, content);
  if (!exchange) return true;
  if (householdExchangeAllowanceUnits(state, householdId, content) < units) return false;
  exchange.usedByHousehold[householdId] = (exchange.usedByHousehold[householdId] || 0) + units;
  return true;
}

export function maximumResidentExchangeWheatUnits(state, content, reserveDays = null) {
  if (!hasHouseholds(state)) return state.accounts?.residents?.wheat || 0;
  return householdList(state).reduce((sum, household) => sum + Math.min(
    householdConvertibleWheatUnits(state, household, content, reserveDays),
    householdExchangeAllowanceUnits(state, household.id, content)
  ), 0);
}

export function debitHouseholdInventory(state, householdId, itemId, units, content, { protectFoodDays = null } = {}) {
  const household = state.households?.byId?.[householdId];
  if (!household || !Number.isSafeInteger(units) || units < 0) return { ok: false, reason: "家庭库存请求无效" };
  const before = household.inventory?.[itemId] || 0;
  if (before < units) return { ok: false, reason: "家庭库存不足" };
  if (protectFoodDays !== null && content.items[itemId]?.edible) {
    const afterFood = householdFoodQeqUnits(state, household, content) - qeqUnitsForInventoryUnits(content.items[itemId], units, content);
    const reserve = householdReserveQeqUnits(state, household, content, protectFoodDays);
    if (afterFood < reserve) return { ok: false, reason: "需要保留家庭基本口粮" };
  }
  household.inventory[itemId] = before - units;
  syncResidentAggregates(state, content);
  return { ok: true, householdId, units };
}

export function creditHouseholdInventory(state, householdId, itemId, units, content) {
  const household = state.households?.byId?.[householdId];
  if (!household || !Number.isSafeInteger(units) || units < 0) return { ok: false, reason: "家庭库存请求无效" };
  const before = household.inventory?.[itemId] || 0;
  if (!Number.isSafeInteger(before + units)) return { ok: false, reason: "家庭库存超过安全范围" };
  household.inventory[itemId] = before + units;
  syncResidentAggregates(state, content);
  return { ok: true, householdId, units };
}

export function takeResidentInventory(state, itemId, units, content, options = {}) {
  if (!hasHouseholds(state)) return { ok: false, reason: "家庭账户未初始化" };
  if (!Number.isSafeInteger(units) || units < 0) return { ok: false, reason: "数量无效" };
  let left = units;
  const rows = [];
  const preferred = options.householdIds?.length ? options.householdIds.map(id => state.households.byId[id]).filter(Boolean) : householdList(state);
  const ordered = preferred.slice().sort((a, b) => (b.inventory?.[itemId] || 0) - (a.inventory?.[itemId] || 0) || numericSuffix(a.id) - numericSuffix(b.id));
  for (const household of ordered) {
    if (left <= 0) break;
    let available = household.inventory?.[itemId] || 0;
    if (options.protectFoodDays !== undefined && content.items[itemId]?.edible) {
      const reserve = householdReserveQeqUnits(state, household, content, options.protectFoodDays);
      const currentFood = householdFoodQeqUnits(state, household, content);
      const perUnit = qeqUnitsForInventoryUnits(content.items[itemId], 1, content);
      available = Math.min(available, Math.max(0, Math.floor((currentFood - reserve) / Math.max(1, perUnit))));
    }
    const move = Math.min(left, available);
    if (move <= 0) continue;
    household.inventory[itemId] -= move;
    rows.push({ householdId: household.id, units: move });
    left -= move;
  }
  if (left > 0) {
    for (const row of rows) state.households.byId[row.householdId].inventory[itemId] += row.units;
    syncResidentAggregates(state, content);
    return { ok: false, reason: options.protectFoodDays !== undefined ? "家庭可用库存不足" : "居民库存不足" };
  }
  syncResidentAggregates(state, content);
  return { ok: true, rows, units };
}

export function distributeResidentInventory(state, itemId, units, content, options = {}) {
  if (!hasHouseholds(state)) return { ok: false, reason: "家庭账户未初始化" };
  if (!Number.isSafeInteger(units) || units < 0) return { ok: false, reason: "数量无效" };
  let households = options.householdIds?.length ? options.householdIds.map(id => state.households.byId[id]).filter(Boolean) : householdList(state);
  if (options.activeOnly !== false) households = households.filter(isActiveHousehold);
  if (!households.length) return { ok: false, reason: "没有可接收的家庭" };
  const weights = options.weights || null;
  const allocation = allocateIntegerByWeight(units, households, household => {
    if (weights) return Math.max(0, weights[household.id] ?? 0);
    return Math.max(0, options.byMembers === false ? 1 : householdPopulation(household));
  });
  if (!allocation.ok) return { ok: false, reason: allocation.reason, rows: [], units: 0 };
  const rows = allocation.rows.map(({ recipient: household, units: amount }) => {
    household.inventory[itemId] = (household.inventory[itemId] || 0) + amount;
    return { householdId: household.id, units: amount };
  });
  syncResidentAggregates(state, content);
  return { ok: true, rows, units };
}

export function creditHouseholdVouchers(state, householdId, units, content, reason = "收入") {
  const household = state.households?.byId?.[householdId];
  if (!household || !Number.isSafeInteger(units) || units < 0) return { ok: false, reason: "家庭粮券请求无效" };
  if (!Number.isSafeInteger((household.voucherUnits || 0) + units)) return { ok: false, reason: "家庭粮券超过安全范围" };
  household.voucherUnits = (household.voucherUnits || 0) + units;
  household.income ||= { dayVoucherUnits: 0, yearVoucherUnits: 0, cumulativeVoucherUnits: 0, history: [] };
  household.income.dayVoucherUnits = (household.income.dayVoucherUnits || 0) + units;
  household.income.yearVoucherUnits = (household.income.yearVoucherUnits || 0) + units;
  household.income.cumulativeVoucherUnits = (household.income.cumulativeVoucherUnits || 0) + units;
  if (units > 0) {
    household.income.history ||= [];
    household.income.history.push({ year: state.year, day: state.day + 1, voucherUnits: units, reason });
    if (household.income.history.length > 120) household.income.history.splice(0, household.income.history.length - 120);
  }
  syncResidentAggregates(state, content);
  return { ok: true, householdId, units };
}

export function debitHouseholdVouchers(state, householdId, units, content) {
  const household = state.households?.byId?.[householdId];
  if (!household || !Number.isSafeInteger(units) || units < 0) return { ok: false, reason: "家庭粮券请求无效" };
  if ((household.voucherUnits || 0) < units) return { ok: false, reason: "家庭粮券不足" };
  household.voucherUnits -= units;
  syncResidentAggregates(state, content);
  return { ok: true, householdId, units };
}

export function takeResidentVouchers(state, units, content, options = {}) {
  if (!hasHouseholds(state)) return { ok: false, reason: "家庭账户未初始化" };
  if (!Number.isSafeInteger(units) || units < 0) return { ok: false, reason: "数量无效" };
  let left = units;
  const rows = [];
  const ordered = householdList(state).slice().sort((a, b) => (b.voucherUnits || 0) - (a.voucherUnits || 0) || numericSuffix(a.id) - numericSuffix(b.id));
  const reservePerCapita = Math.max(0, Number(options.reserveVoucherPerCapita || 0));
  for (const household of ordered) {
    if (left <= 0) break;
    const reserve = Math.round(householdPopulation(household) * reservePerCapita * content.precision.currencyUnitsPerVoucher);
    const available = Math.max(0, (household.voucherUnits || 0) - reserve);
    const move = Math.min(left, available);
    if (move <= 0) continue;
    household.voucherUnits -= move;
    rows.push({ householdId: household.id, units: move });
    left -= move;
  }
  if (left > 0) {
    for (const row of rows) state.households.byId[row.householdId].voucherUnits += row.units;
    syncResidentAggregates(state, content);
    return { ok: false, reason: "居民家庭可支配粮券不足" };
  }
  syncResidentAggregates(state, content);
  return { ok: true, rows, units };
}

export function distributeResidentVouchers(state, units, content, options = {}) {
  if (!hasHouseholds(state)) return { ok: false, reason: "家庭账户未初始化" };
  if (!Number.isSafeInteger(units) || units < 0) return { ok: false, reason: "数量无效" };
  let households = (options.householdIds?.length ? options.householdIds : householdList(state).map(h => h.id)).map(id => state.households.byId[id]).filter(Boolean);
  if (options.activeOnly !== false) households = households.filter(isActiveHousehold);
  if (!households.length) return { ok: false, reason: "没有可接收的家庭" };
  const weights = options.weights || null;
  const allocation = allocateIntegerByWeight(units, households, household => Math.max(0, weights ? (weights[household.id] ?? 0) : householdPopulation(household)));
  if (!allocation.ok) return { ok: false, reason: allocation.reason, rows: [], units: 0 };
  const rows = allocation.rows.map(({ recipient: household, units: amount }) => {
    household.voucherUnits = (household.voucherUnits || 0) + amount;
    return { householdId: household.id, units: amount };
  });
  syncResidentAggregates(state, content);
  return { ok: true, rows, units };
}

export function clearDailyHouseholdIncome(state) {
  for (const household of householdList(state)) if (household.income) household.income.dayVoucherUnits = 0;
}

export function resetYearHouseholdIncome(state) {
  for (const household of householdList(state)) if (household.income) household.income.yearVoucherUnits = 0;
}

export function occupationCounts(state, content) {
  const labels = {
    farmers: "农民", builders: "建筑工", millers: "作坊工", bakers: "作坊工",
    lumberjacks: "作坊工", salt_workers: "作坊工", civil_servants: "公务员", police: "警察"
  };
  const counts = { 待业: 0 };
  for (const household of householdList(state)) {
    counts.待业 += householdIdleWorkers(household);
    for (const [jobKey, count] of Object.entries(household.jobs || {})) {
      if (count <= 0) continue;
      let name = "就业者";
      if (jobKey.startsWith("shop:")) name = jobKey.endsWith(":merchant") ? "商人" : "店员";
      else {
        const direct = jobKey.split("::")[1] || jobKey;
        name = labels[direct] || labels[jobKey] || content.roles?.[jobKey]?.name || "就业者";
      }
      counts[name] = (counts[name] || 0) + count;
    }
  }
  return counts;
}

export function householdLivingSummary(state, content) {
  const scale = content.precision.currencyUnitsPerVoucher;
  const inventoryScale = content.precision.inventoryUnitsPerJin;
  const thresholds = content.rules.householdLiving;
  const rows = householdList(state).map(household => {
    const actualPeople = householdPopulation(household);
    const people = Math.max(1, actualPeople);
    const foodQeq = householdFoodQeqUnits(state, household, content);
    const foodDays = actualPeople > 0 ? foodQeq / content.precision.qeqUnitsPerJin / (actualPeople * content.rules.foodPerPersonDay) : Infinity;
    let valueVoucherUnits = household.voucherUnits || 0;
    for (const [itemId, units] of Object.entries(household.inventory || {})) {
      const price = content.rules.marketPricesVoucherPerUnit?.[itemId] ?? 0;
      valueVoucherUnits += Math.round(units / inventoryScale * price * scale);
    }
    // 别墅为非流动资产：计入家庭总资产，不可直接花费。
    for (const villa of household.villaAssets || []) {
      valueVoucherUnits += Math.max(0, Number(villa.priceValueUnits) || 0);
    }
    const perCapitaVoucher = actualPeople > 0 ? valueVoucherUnits / scale / people : valueVoucherUnits / scale;
    let tier = actualPeople === 0 ? "非活跃" : "温饱";
    if (actualPeople > 0 && (foodDays < thresholds.difficultFoodDays || perCapitaVoucher < thresholds.difficultPerCapitaVoucher)) tier = "困难";
    else if (actualPeople > 0 && foodDays >= thresholds.comfortableFoodDays && perCapitaVoucher >= thresholds.comfortablePerCapitaVoucher) tier = "富裕";
    return { householdId: household.id, name: household.name, people: actualPeople, foodDays, perCapitaVoucher, tier, voucher: (household.voucherUnits || 0) / scale };
  });
  const counts = { 困难: 0, 温饱: 0, 富裕: 0, 非活跃: 0 };
  for (const row of rows) counts[row.tier] = (counts[row.tier] || 0) + 1;
  return { rows, counts, thresholds };
}
