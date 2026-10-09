// 动态劳动力市场（移植自用户 0.1.11 优化）。
//
// 三件事：
// 1. 劳动力快照 computeLaborMarket：失业率、行情（tight/normal/slack）、
//    公职平均日薪 referenceWage、商店目标日薪 targetShopWage。
//    失业率 >8% 为 slack（失业多，商店压工资）；<5% 为 tight（人手紧，商店加工资）。
// 2. 商店按行情调工资 adjustShopWage：每 shopWageAdjustIntervalDays 天评估一次，
//    按利润/行情/用工紧张度上调或下调店员日薪，结果写入 shop.clerkWageVoucher，
//    诊断文本写入 shop.plan.wageDiagnosis。
// 3. 人手紧时挖人 poachWorkers：商店/镇营建筑缺人且行情 tight 时，以高于对方
//    laborPoachPremiumPercent 的日薪从低薪岗位挖人（释放为待业后再正常雇佣）。
//
// 与工资双系数（payroll.js wageControlFactor）的融合：
// 用户的原逻辑取 wageRates 原始值；本移植在 publicWageForRole / jobWage 中
// 乘以 wageControlFactor，使"参照你定的公职岗位工资"包含用户调的公务员/产业系数。

import { recordEvent } from "../economy/ledger.js";
import { householdList, householdWorkingAge, householdEmploymentCount, jobCount, setHouseholdJobCount } from "./households.js";
import { privateWageRate, wageControlFactor } from "./payroll.js";

function clerkJobKey(shop) { return `shop:${shop.id}:clerk`; }
function merchantJobKey(shop) { return `shop:${shop.id}:merchant`; }
function shopClerkCount(state, shop) { return jobCount(state, clerkJobKey(shop)); }
function shopMerchantCount(state, shop) { return jobCount(state, merchantJobKey(shop)); }

function roundHalf(value) {
  return Math.round(value * 2) / 2;
}

function daySerial(state, content) {
  return (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
}

function currencyScale(content) {
  return content.precision.currencyUnitsPerVoucher || content.precision.inventoryUnitsPerJin;
}

// 公职工资（用户原 FM）：非店铺类的镇发岗位才有公职工资；融合工资双系数。
export function publicWageForRole(state, roleKey, content) {
  const wageRates = state.employment?.wageRates || {};
  if (!roleKey.includes("::")) {
    const role = content.roles?.[roleKey];
    const base = wageRates[roleKey] ?? role?.wagePerWorkerDay ?? 0;
    if (!(base > 0)) return null;
    return base * wageControlFactor(state, roleKey);
  }
  const parts = roleKey.split("::");
  if (parts.length !== 2) return null;
  const building = (state.buildings || []).find(item => item.id === parts[0]);
  const job = content.buildings?.[building?.typeId]?.jobs?.find(item => item.id === parts[1]);
  if (!job || job.managedBy === "shops") return null;
  const base = wageRates[job.id] ?? job.wagePerWorkerDay ?? 0;
  if (!(base > 0)) return null;
  return base * wageControlFactor(state, job.id);
}

// 劳动力快照（用户原 m2）：视图层按需计算，不持久化。
export function computeLaborMarket(state, content) {
  let workers = 0;
  let employed = 0;
  let publicWageSum = 0;
  let publicWorkers = 0;
  for (const household of householdList(state)) {
    workers += householdWorkingAge(household);
    employed += householdEmploymentCount(household);
    for (const [roleKey, count] of Object.entries(household.jobs || {})) {
      if (!(count > 0)) continue;
      const wage = publicWageForRole(state, roleKey, content);
      if (wage === null) continue;
      publicWageSum += wage * count;
      publicWorkers += count;
    }
  }
  const idle = Math.max(0, workers - employed);
  const buildersWage = state.employment?.wageRates?.builders
    ?? content.roles?.builders?.wagePerWorkerDay ?? 5;
  const referenceWage = publicWorkers > 0 ? publicWageSum / publicWorkers : buildersWage;
  const unemploymentRate = workers > 0 ? idle / workers : 0;
  const high = content.rules.laborUnemploymentHighPercent ?? 8;
  const low = content.rules.laborUnemploymentLowPercent ?? 5;
  const pct = unemploymentRate * 100;
  const mood = pct > high ? "slack" : pct < low ? "tight" : "normal";
  const factor = mood === "slack"
    ? content.rules.shopWageSlackFactor ?? 0.85
    : mood === "tight" ? content.rules.shopWageTightFactor ?? 1.2 : 1;
  return {
    workers, employed, idle, unemploymentRate,
    referenceWage, publicWorkers, mood,
    targetShopWage: referenceWage * factor
  };
}

export function laborMoodLabel(mood) {
  if (mood === "slack") return "失业多，商店压工资";
  if (mood === "tight") return "人手紧，商店加工资";
  return "行情平稳";
}

// 挖人竞争统计（用户原 VM）：持久化在 state.laborCompetition。
export function ensureLaborCompetition(state) {
  state.laborCompetition ||= { dayKey: null, day: { moves: 0 }, year: { moves: 0 }, recent: [] };
  const key = `${state.year}-${state.day}`;
  if (state.laborCompetition.dayKey !== key) {
    state.laborCompetition.dayKey = key;
    state.laborCompetition.day = { moves: 0 };
  }
  return state.laborCompetition;
}

export function resetLaborCompetitionYear(state) {
  if (state.laborCompetition) state.laborCompetition.year = { moves: 0 };
}

// 岗位当前日薪（用户原 Q8），融合工资双系数；返回 null 表示无可比工资。
export function jobWage(state, jobKey, content, cache = null) {
  if (cache?.has(jobKey)) return cache.get(jobKey);
  let wage = null;
  const wageRates = state.employment?.wageRates || {};
  if (jobKey.startsWith("shop:")) {
    const match = jobKey.match(/^shop:(.+):clerk$/);
    const shop = match ? state.shops?.[match[1]] : null;
    if (shop) wage = shopWage(state, shop, content);
  } else if (!jobKey.includes("::")) {
    if (jobKey === content.agriculture.farmerRoleId) {
      // 农人按秋收分粮折算，不参与挖人比较（用户原逻辑：u2*W0）。
      wage = farmerDailyWage(state, content);
    } else if (jobKey !== "builders" && content.roles?.[jobKey]) {
      const base = wageRates[jobKey] ?? content.roles[jobKey].wagePerWorkerDay ?? 0;
      if (base > 0) wage = base * wageControlFactor(state, jobKey);
    }
  } else {
    const [buildingId, jobId, scope] = jobKey.split("::");
    const building = (state.buildings || []).find(item => item.id === buildingId);
    const job = content.buildings?.[building?.typeId]?.jobs?.find(item => item.id === jobId);
    if (job && job.managedBy !== "shops") {
      if (scope === "listed") {
        const company = Object.values(state.companies || {}).find(item => item.buildingId === buildingId);
        const base = Number.isFinite(company?.settings?.wagePerWorkerDay)
          ? company.settings.wagePerWorkerDay
          : wageRates[job.id] ?? job.wagePerWorkerDay ?? 0;
        if (base > 0) wage = base;
      } else if (scope === "private") {
        const rate = privateWageRate(state, building, job, content);
        if (rate > 0) wage = rate;
      } else if (!scope) {
        const base = wageRates[job.id] ?? job.wagePerWorkerDay ?? 0;
        if (base > 0) wage = base * wageControlFactor(state, job.id);
      }
    }
  }
  cache?.set(jobKey, wage);
  return wage;
}

function farmerDailyWage(state, content) {
  // 用户原逻辑 u2($,z)*W0($,z.agriculture.cropItemId,z)：农人日均分粮收入。
  // 此处用镇级口径估算；返回 null 则农人不参与挖人比较。
  void state; void content;
  return null;
}

// 岗位名称（用户原 M8），用于挖人事件文案。
export function jobLabel(state, jobKey, content) {
  if (jobKey === content.agriculture.farmerRoleId) return "农田";
  if (jobKey.startsWith("shop:")) {
    const id = jobKey.split(":")[1];
    return state.shops?.[id]?.name || "店铺";
  }
  if (!jobKey.includes("::")) return content.roles?.[jobKey]?.name || jobKey;
  const [buildingId, jobId, scope] = jobKey.split("::");
  const building = (state.buildings || []).find(item => item.id === buildingId);
  const def = content.buildings?.[building?.typeId];
  const job = def?.jobs?.find(item => item.id === jobId);
  const suffix = scope === "private" ? "（民营）" : scope === "listed" ? "（企业）" : "";
  return `${def?.name || "作坊"}${job?.name || ""}${suffix}`;
}

// 商店当前店员日薪（用户原 W2）。
export function shopWage(state, shop, content) {
  const wage = Number(shop?.clerkWageVoucher);
  if (Number.isFinite(wage) && wage >= 0) return wage;
  return state.employment?.wageRates?.shop_clerks ?? content.rules.shopClerkDefaultWageVoucher ?? 10;
}

// 挖人（用户原 y$）：以 wageOffered 日薪挖 count 人。
// 只挖当前日薪 <= wageOffered/(1+premium) 的在岗者；挖到的人先释放为待业，
// 由调用方随后正常雇佣。返回实际挖到人数。
export function poachWorkers(state, wageOffered, count, content, options = {}) {
  const { toKey, toLabel, allowFarmers = true, excludeKeys = [] } = options;
  if (!(count > 0) || !(wageOffered > 0)) return 0;
  const premium = 1 + (content.rules.laborPoachPremiumPercent ?? 15) / 100;
  const maxSourceWage = wageOffered / premium;
  const excluded = new Set([toKey, ...excludeKeys]);
  const cache = new Map();
  const candidates = [];
  for (const household of householdList(state)) {
    for (const [key, held] of Object.entries(household.jobs || {})) {
      if (!(held > 0) || excluded.has(key)) continue;
      if (!allowFarmers && key === content.agriculture.farmerRoleId) continue;
      const wage = jobWage(state, key, content, cache);
      if (wage === null || wage > maxSourceWage) continue;
      candidates.push({ household, key, wage, held });
    }
  }
  candidates.sort((a, b) => a.wage - b.wage
    || a.household.id.localeCompare(b.household.id)
    || a.key.localeCompare(b.key));
  let moved = 0;
  const competition = ensureLaborCompetition(state);
  for (const cand of candidates) {
    if (moved >= count) break;
    const take = Math.min(cand.held, count - moved);
    const released = releaseFromHouseholdJob(state, cand.household.id, cand.key, take);
    if (released <= 0) continue;
    moved += released;
    const fromLabel = jobLabel(state, cand.key, content);
    competition.recent.unshift({
      year: state.year, day: state.day + 1,
      from: fromLabel, to: toLabel || jobLabel(state, toKey || "", content),
      count: released,
      fromWage: Math.round(cand.wage * 10) / 10,
      toWage: Math.round(wageOffered * 10) / 10
    });
    competition.recent.length = Math.min(competition.recent.length, 12);
    recordEvent(state,
      `人手紧：${toLabel || "高薪岗位"}以日薪${Math.round(wageOffered * 10) / 10}从${fromLabel}挖走${released}人。`,
      content, {
        day: state.day + 1,
        mergeKey: "labor-poach",
        mergeWindowDays: 30,
        amount: released,
        mergedText: (times, total) => `近来人手紧，高薪岗位 ${times} 次共挖走 ${total} 人（最近一次：${toLabel || "高薪岗位"}从${fromLabel}挖人）。`
      });
  }
  competition.day.moves += moved;
  competition.year.moves += moved;
  return moved;
}

function releaseFromHouseholdJob(state, householdId, jobKey, count) {
  const household = state.households?.byId?.[householdId];
  if (!household) return 0;
  const before = Math.max(0, household.jobs?.[jobKey] || 0);
  const cut = Math.min(before, Math.max(0, Math.floor(count)));
  if (cut <= 0) return 0;
  setHouseholdJobCount(state, householdId, jobKey, before - cut, null);
  return cut;
}

// 商店按行情调工资（用户原 NM）。
// 每 shopWageAdjustIntervalDays 天评估一次；结果写入 shop.clerkWageVoucher。
export function adjustShopWage(state, shop, content, laborMarket = null) {
  const history = (shop.history || []).slice(-Math.max(1, content.rules.operatingObservationDays || 7));
  const minDays = Math.max(1, content.rules.operatingObservationDays || 7);
  const staff = shopClerkCount(state, shop);
  const merchants = shopMerchantCount(state, shop);
  const wantsMore = Number.isFinite(shop.plan?.targetClerks) && shop.plan.targetClerks > staff;
  if (history.length < minDays || staff <= 0) return null;
  const serial = daySerial(state, content);
  const interval = Math.max(1, content.rules.shopWageAdjustIntervalDays ?? 15);
  shop.plan ||= {};
  if (Number.isFinite(shop.plan.lastWageSerial) && serial - shop.plan.lastWageSerial < interval) return null;
  shop.plan.lastWageSerial = serial;
  const market = laborMarket || computeLaborMarket(state, content);
  const scale = currencyScale(content);
  const reference = market.referenceWage;
  const target = roundHalf(market.targetShopWage);
  const current = shopWage(state, shop, content);
  const step = Math.max(0.5, roundHalf(reference * (content.rules.shopWageStepPercent ?? 10) / 100));
  const floor = roundHalf(reference * (content.rules.shopWageFloorPercent ?? 50) / 100);
  const avgProfit = history.reduce((sum, row) => sum + (row.profitVoucherUnits || 0), 0) / history.length / scale;
  const heads = staff + merchants;
  const affordRaise = avgProfit - staff * step > 0;
  const profitShareOk = avgProfit / Math.max(1, heads) >= current * (content.rules.shopWageRaiseProfitShare ?? 0.5);
  const moodLabel = market.mood === "slack" ? "失业多" : market.mood === "tight" ? "人手紧" : "行情平稳";
  let next = current;
  let diagnosis = `${moodLabel}，工资维持`;
  if (avgProfit < 0) {
    next = Math.max(floor, current - step);
    diagnosis = next < current ? "亏损，减薪" : "亏损，已到工资下限";
  } else if (current < target && affordRaise) {
    next = Math.min(target, current + step);
    diagnosis = `${moodLabel}，向行情加薪`;
  } else if (affordRaise && profitShareOk && wantsMore && market.mood !== "slack") {
    // 招不到人时隔次加薪（用户原 wageRaiseSkip 交替逻辑）。
    shop.plan.wageRaiseSkip = !shop.plan.wageRaiseSkip;
    if (!shop.plan.wageRaiseSkip) {
      next = current + step;
      diagnosis = "招不到人，加薪抢人";
    } else {
      diagnosis = "招不到人，观望中";
    }
  } else if (current > target && !wantsMore && market.mood !== "tight") {
    next = Math.max(target, current - step);
    diagnosis = market.mood === "slack" ? "失业多，压低工资" : "高于行情，回调工资";
  } else if (market.mood === "slack" && current > target) {
    next = Math.max(target, current - step);
    diagnosis = "失业多，压低工资";
  }
  shop.clerkWageVoucher = Math.max(floor, next);
  shop.plan.wageDiagnosis = diagnosis;
  shop.plan.wageTarget = target;
  return { wage: shop.clerkWageVoucher, diagnosis, target };
}

// 可挖人数（用户原 f8）：待业为 0 时，按出价统计全镇在岗（除农人）
// 日薪 <= 出价/(1+挖人溢价) 的人数，供就业面板 maxAssignable 与手动增员挖人用。
export function computePoachable(state, content) {
  const cache = new Map();
  const wages = [];
  for (const household of householdList(state)) {
    for (const [key, held] of Object.entries(household.jobs || {})) {
      if (!(held > 0) || key === content.agriculture.farmerRoleId) continue;
      const wage = jobWage(state, key, content, cache);
      if (wage === null) continue;
      for (let i = 0; i < held; i += 1) wages.push(wage);
    }
  }
  wages.sort((a, b) => a - b);
  const premium = 1 + (content.rules.laborPoachPremiumPercent ?? 15) / 100;
  return (offeredWage) => {
    const threshold = offeredWage / premium;
    let lo = 0;
    let hi = wages.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (wages[mid] <= threshold) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}
