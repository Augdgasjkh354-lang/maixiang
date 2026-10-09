// 分家：人口超过 householdSplitMaxPeople（8）人的家庭分出一户，直到每户都不超过上限。
// 每年年终（人口变动、遗产结算之后）与读旧存档时各跑一次；不用随机数，结果确定。
//
// 规则（与玩家约定）：
// - 人口：新户拿约一半人口，按年龄段同比例分；两户都至少 1 名劳动力（原户只有 1 名劳动力时不分）。
// - 钱粮：粮券、银行存款、全部库存按两户人口比例分（取整零头留原户），总量守恒。
// - 留原户（原户是家主）：股票、国债、名下建筑、开的店（店主与商人岗位）、经营权、别墅、欠薪债权、开店欠款、收入账。
// - 岗位：原户在自己劳动力范围内尽量保留（商人岗位永远留下），放不下的岗位随人去新户，不释放、不造成失业。
// - 新户生活账从零开始，满意度继承原户。
import { createHousehold, householdList, householdPopulation, householdWorkingAge, jobReleaseRank, releaseExcessHouseholdEmployment, syncResidentAggregates } from "./households.js";
import { invalidateHouseholdBudgets } from "./household-budget.js";
import { recordEvent } from "../economy/ledger.js";

function numericSuffix(id) {
  const match = String(id || "").match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function nextNumber(state) {
  const maxExisting = householdList(state).reduce((max, household) => Math.max(max, numericSuffix(household.id)), 0);
  return Math.max(Math.floor(state.households.nextHouseholdNumber || 0), maxExisting + 1);
}

// 新户的年龄段：共 take 人，按原户比例分，劳动力至少 1、且给原户至少留 1。
function splitBands(bands, take) {
  const total = bands.children + bands.workers + bands.elders;
  let workers = Math.round(bands.workers * take / total);
  workers = Math.max(1, Math.min(bands.workers - 1, workers, take));
  let rest = take - workers;
  let children = Math.min(bands.children, Math.round(bands.children * take / total));
  let elders = Math.min(bands.elders, rest - Math.min(children, rest));
  children = Math.min(children, rest);
  // 补足：人数不够时从余下的年龄段补（先孩子、再老人、最后劳动力），保证正好 take 人。
  let missing = take - workers - children - elders;
  const addFrom = (have, cap) => { const add = Math.max(0, Math.min(missing, cap - have)); missing -= add; return have + add; };
  children = addFrom(children, bands.children);
  elders = addFrom(elders, bands.elders);
  workers = addFrom(workers, bands.workers - 1);
  return missing === 0 ? { children, workers, elders } : null;
}

// 按比例分一个非负整数：新户拿 floor(units × share)，零头留原户。
function shareOf(units, share) {
  return Math.max(0, Math.floor(Math.max(0, units || 0) * share));
}

// 岗位：原户按"商人先、越难释放的越先留"保留到自己的劳动力，放不下的给新户。
function splitJobs(original, newHousehold) {
  const capacity = householdWorkingAge(original);
  const keys = Object.keys(original.jobs || {}).filter(key => (original.jobs[key] || 0) > 0)
    .sort((a, b) => jobReleaseRank(a) - jobReleaseRank(b) || a.localeCompare(b));
  let kept = 0;
  for (const key of keys) {
    const count = original.jobs[key];
    const keep = key.endsWith(":merchant") ? count : Math.max(0, Math.min(count, capacity - kept));
    kept += keep;
    const move = count - keep;
    if (move > 0) {
      original.jobs[key] = keep;
      newHousehold.jobs[key] = move;
      if (keep === 0) delete original.jobs[key];
    }
  }
}

function splitOne(state, original, number, content) {
  const bands = { children: 0, workers: 0, elders: 0, ...original.ageBands };
  const population = householdPopulation(original);
  const take = Math.floor(population / 2);
  const newBands = splitBands(bands, take);
  if (!newBands) return null;
  const household = createHousehold(number, content);
  const share = take / population;
  household.ageBands = newBands;
  original.ageBands = {
    children: bands.children - newBands.children,
    workers: bands.workers - newBands.workers,
    elders: bands.elders - newBands.elders
  };
  for (const itemId of Object.keys(household.inventory)) {
    const units = shareOf(original.inventory?.[itemId], share);
    if (units > 0) { original.inventory[itemId] -= units; household.inventory[itemId] = units; }
  }
  const vouchers = shareOf(original.voucherUnits, share);
  original.voucherUnits = (original.voucherUnits || 0) - vouchers;
  household.voucherUnits = vouchers;
  const deposits = state.bank?.deposits;
  if (deposits && deposits[original.id] > 0) {
    const moved = shareOf(deposits[original.id], share);
    if (moved > 0) { deposits[original.id] -= moved; deposits[household.id] = moved; }
  }
  splitJobs(original, household);
  const satisfaction = original.life?.satisfaction;
  if (Number.isFinite(satisfaction)) household.life = { satisfaction };
  return household;
}

// 返回分出的户数。content.rules.householdSplitMaxPeople 为上限（默认 8）。
export function splitOversizedHouseholds(state, content, { recordEvents = true } = {}) {
  if (!state.households?.byId) return { splits: 0, rows: [] };
  const maxPeople = Math.max(2, Math.floor(content.rules.householdSplitMaxPeople ?? 8));
  const added = [];
  const rows = [];
  let number = nextNumber(state);
  // 先排好原有家庭的顺序；新分出的户也会再检查（一户 30 人要分几轮）。
  const queue = householdList(state).filter(household => householdPopulation(household) > maxPeople);
  while (queue.length) {
    const original = queue.shift();
    if (householdPopulation(original) <= maxPeople || householdWorkingAge(original) < 2) continue;
    const household = splitOne(state, original, number, content);
    if (!household) continue;
    number += 1;
    added.push(household);
    rows.push({ from: original.id, to: household.id, people: householdPopulation(household) });
    if (householdPopulation(original) > maxPeople) queue.push(original);
    if (householdPopulation(household) > maxPeople) queue.push(household);
  }
  if (!added.length) return { splits: 0, rows };
  // 换掉 byId 对象：householdList 与岗位索引缓存都以它为键。
  state.households.byId = { ...state.households.byId, ...Object.fromEntries(added.map(household => [household.id, household])) };
  state.households.nextHouseholdNumber = number;
  // 兜底：原户名下店铺多、商人岗位超过分家后劳动力的极少数情况，按常规顺序释放超额岗位。
  releaseExcessHouseholdEmployment(state);
  syncResidentAggregates(state, content);
  invalidateHouseholdBudgets(state);
  if (recordEvents) recordEvent(state, `人口增多，${added.length}户人家分了家，全镇现有${householdList(state).length}户。`, content);
  return { splits: added.length, rows };
}
