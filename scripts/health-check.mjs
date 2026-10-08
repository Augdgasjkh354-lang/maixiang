// scripts/health-check.mjs
// 十年经济体检：搭一座完整的镇子（粮券阶段、批发市场、商业街综合商店与服务店、加工业、
// 养殖基地、时代广场），然后让它自己跑 N 年，每年年末（以及第 1 年第 180 天）记录一次体检指标，
// 看经济能否自我维持、在哪里崩。只读取模拟状态，不改 src/。
//
// 用法：
//   node scripts/health-check.mjs [years=10] [--seed 91] [--json out.json]
//
// 起点（只在开局发生一次，之后不再注资）：
//   - 镇库 50000 斤木材（开局建造用，与 demand-probe 相同）；
//   - 建筑直接按 2 级（商业街 3 级）建成，不走施工；
//   - 切到粮券阶段，居民获得 200000 券作为起始资本，综合商店镇库拨 8000 券作为起始流动资金；
//   - 其余建筑按 demand-probe 的岗位数配人（磨坊/面包房 10，盐场/伐木场 12，酒坊 6，棉田 8，织坊 6）。
//
// 玩家策略（每年年初、第 1 天开工前执行一次，确定性，不随机）：
//   1. 保持镇营生产岗位满员：每个镇营生产建筑（带 industryTier 的 mill/bakery/saltworks/lumberyard/
//      winery/cotton_field/weaving_mill）的每个岗位都有一个"计划人数"，初始为开局配人数。
//      每年若在岗人数低于计划人数（且不超过岗位产能），就补到计划人数；从不主动裁员。
//      若建筑升级后等级提高，计划人数改为升级后的满额产能（新岗位要招满）。
//   2. 磨坊、面包房每年升一级：若该建筑没有在建工程、未达最高等级（10 级）、且 selectUpgradePreview
//      显示材料可付（镇库木材不足时允许从批发市场采购，由镇库付券），就调用真实的 upgradeBuilding 命令。
//      其他建筑不升级。
//   3. 其余一律保持政策默认值（工资、价格、税率、店铺定价、批发价等都不动）。
//
// 观测口径：
//   - 人口/户数/满意度：年末（翻年后）状态；满意度与缺粮天数另记年内日均与累计。
//   - 缺粮天数：runDay 返回的 shortageQeq > 0 的天数（年内累计）。
//   - 货币：镇库、居民（家庭粮券之和）、店铺、公司、社保基金、银行持有的粮券之和。
//   - 家底：householdWealthUnits（粮券 + 可折算余粮），按人口加权取 p10/p50/p90，单位为人均粮券。
//   - 年收支：来自年报（report.fiscal / report.financialFlows.year.town）。
//   - 店铺利润、农场、时代广场：年报里的店铺年账（年末）或实时年账（第 180 天）。
//   - 日用品履约 = 年内用上量 / 年内需求量；服务履约 = 年内服务人次 / 年内想用人次。

import { writeFile } from "node:fs/promises";
import { simulation, CONTENT } from "../src/engine.js";
import { grantResidentVouchers } from "../tests/helpers-v16.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { householdList, householdPopulation, isActiveHousehold, residentVoucherUnits } from "../src/systems/households.js";
import { householdWealthUnits, householdBudgets } from "../src/systems/household-budget.js";
import { populationStats, selectJobRows } from "../src/selectors/labor.js";
import { shopSummaries, stallSquareSummaries } from "../src/systems/shops.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const MID_DAY = 180;
const PRODUCER_TYPES = ["mill", "bakery", "saltworks", "lumberyard", "winery", "cotton_field", "weaving_mill"];
const UPGRADE_TYPES = ["mill", "bakery"];
const PRICE_ITEMS = ["flour", "bread", "salt", "wood", "wine", "cloth", "pork"];
const OUTSIDE_TOWN_IDS = Object.keys(CONTENT.outsideTowns || {});

function parseArgs(argv) {
  const opts = { years: 10, seed: 91, json: null, wealthTax: null, inheritance: null, employerShare: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") opts.seed = Number(argv[++i]);
    else if (a === "--json") opts.json = argv[++i];
    // 再分配政策（docs/REDISTRIBUTION.md）：--wealth-tax 1,3,5（三档年税率%）、--inheritance 30、--employer-share 100
    else if (a === "--wealth-tax") opts.wealthTax = argv[++i].split(",").map(Number);
    else if (a === "--inheritance") opts.inheritance = Number(argv[++i]);
    else if (a === "--employer-share") opts.employerShare = Number(argv[++i]);
    else if (/^\d+$/.test(a)) opts.years = Number(a);
    else throw new Error(`未知参数：${a}`);
  }
  if (!(opts.years >= 1)) throw new Error("years 必须 >= 1");
  if (!Number.isFinite(opts.seed)) throw new Error("seed 必须是数字");
  return opts;
}

// ── 搭镇（与 scripts/demand-probe.mjs 的 buildTown 同一套写法）──
function buildTown(seed) {
  const state = simulation.createInitialState({ seed });
  state.accounts.town.wood += 50000 * I;
  const freePlot = (feature = null) => state.plots.find(p => (feature ? p.feature === feature : !p.feature)
    && !state.buildings.some(b => b.plotId === p.id));
  const add = (typeId, level = 2, feature = null) => {
    const p = freePlot(feature);
    if (!p) { console.error("没有空地：", typeId); return null; }
    const id = `${typeId}-${state.buildings.length}`;
    state.buildings.push({ id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: p.id, x: p.x, y: p.y, materialInvestments: [], completed: { year: 1, day: 1 } });
    return id;
  };
  const staff = (id, n) => id && simulation.setEmployment(state, `${id}::${CONTENT.buildings[state.buildings.find(b => b.id === id).typeId].jobs[0].id}`, n);
  add("bank", 1);
  staff(add("wholesale_market"), 4);
  const street = add("commercial_street", 3);
  staff(add("mill"), 10); staff(add("bakery"), 10);
  staff(add("saltworks", 2, CONTENT.buildings.saltworks.requiredPlotFeature), 12);
  staff(add("lumberyard", 2, CONTENT.buildings.lumberyard.requiredPlotFeature), 12);
  staff(add("winery"), 6); staff(add("cotton_field"), 8); staff(add("weaving_mill"), 6);
  const base = add("livestock_base", 1);
  add("times_square", 1);
  simulation.startCurrencyReform(state);
  grantResidentVouchers(state, 200000);
  const store = simulation.openResidentShop(state, street, "general");
  issueTownVouchers(state, 8000 * V, CONTENT, "体检起始资本");
  transferVouchers(state, "town", `shop:${store.shopId}`, 8000 * V, CONTENT, "体检起始资本", "体检起始资本");
  simulation.configureShopClerks(state, store.shopId, 15);
  for (const t of ["haircut", "tea", "restaurant", "repair"]) simulation.openResidentShop(state, street, t);
  for (const t of ["chicken_farm", "duck_farm", "goose_farm", "pig_farm"]) simulation.openResidentShop(state, base, t);
  return state;
}

// ── 玩家策略 ──
// plan: jobKey -> 计划人数。levelSeen: buildingId -> 上次见到的镇营等级。
function isTownProducer(building) {
  if (!PRODUCER_TYPES.includes(building.typeId)) return false;
  const own = building.ownership || {};
  return (own.townLevels || 0) > 0 && !(own.privateLevels > 0) && !(own.listedLevels > 0);
}

function initPlan(state) {
  const plan = {};
  const rows = selectJobRows(state, CONTENT).rows;
  for (const row of rows) {
    const b = state.buildings.find(x => x.id === row.buildingId);
    if (b && isTownProducer(b) && row.scope === "building") plan[row.key] = row.count;
  }
  return plan;
}

function yearStartPolicy(state, plan, levelSeen) {
  const log = { upgrades: [], refills: 0, upgradeRejects: [] };
  // 1) 升级已完成的建筑：计划人数改为满额产能。
  let rows = selectJobRows(state, CONTENT).rows;
  for (const b of state.buildings) {
    if (!isTownProducer(b)) continue;
    const lvl = b.ownership?.townLevels || 0;
    if (levelSeen[b.id] !== undefined && lvl > levelSeen[b.id]) {
      for (const row of rows.filter(r => r.buildingId === b.id && r.scope === "building")) plan[row.key] = row.capacity;
    }
    levelSeen[b.id] = lvl;
  }
  // 2) 补员：只补到计划人数（不超过产能），从不裁员。
  rows = selectJobRows(state, CONTENT).rows;
  for (const row of rows) {
    if (!(row.key in plan)) continue;
    const want = Math.min(row.capacity, plan[row.key]);
    if (row.count < want) {
      const r = simulation.setEmployment(state, row.key, want);
      if (r && r.ok !== false) log.refills++;
    }
  }
  // 3) 磨坊、面包房升一级（若材料可付且无在建工程）。
  for (const b of state.buildings) {
    if (!UPGRADE_TYPES.includes(b.typeId) || !isTownProducer(b)) continue;
    const preview = simulation.selectUpgradePreview(state, b.id);
    if (!preview.available) continue;
    if (!preview.materialsAffordable) { log.upgradeRejects.push(`${b.id}:材料不足`); continue; }
    const res = simulation.upgradeBuilding(state, b.id);
    if (res.ok) log.upgrades.push(`${b.id}->${preview.nextLevel}级`);
    else log.upgradeRejects.push(`${b.id}:${res.reason}`);
  }
  return log;
}

// ── 年内日累计（每天调用一次，只做加法）──
function newAcc() {
  return {
    days: 0, shortDays: 0, satSum: 0,
    goodsDemand: {}, goodsUsed: {}, goodsBought: {},
    svcAttempt: {}, svcServed: {}, svcUnaff: {}, svcCap: {}
  };
}

function accumulate(acc, state, ret) {
  acc.days++;
  if ((ret?.shortageQeq || 0) > 0) acc.shortDays++;
  acc.satSum += state.satisfaction || 0;
  const g = state.goodsDemand?.day;
  for (const k of Object.keys(CONTENT.rules.householdGoods)) {
    acc.goodsDemand[k] = (acc.goodsDemand[k] || 0) + (g?.demandUnits?.[k] || 0);
    acc.goodsUsed[k] = (acc.goodsUsed[k] || 0) + (g?.consumedUnits?.[k] || 0);
    acc.goodsBought[k] = (acc.goodsBought[k] || 0) + (g?.purchasedUnits?.[k] || 0);
  }
  const s = state.services?.day;
  for (const k of Object.keys(CONTENT.rules.serviceTypes)) {
    acc.svcAttempt[k] = (acc.svcAttempt[k] || 0) + (s?.attemptedUses?.[k] || 0);
    acc.svcServed[k] = (acc.svcServed[k] || 0) + (s?.servedUses?.[k] || 0);
    acc.svcUnaff[k] = (acc.svcUnaff[k] || 0) + (s?.unaffordableUses?.[k] || 0);
    acc.svcCap[k] = (acc.svcCap[k] || 0) + (s?.capacityUnmetUses?.[k] || 0);
  }
}

// 人口加权分位数（per-capita 值）。
function weightedPercentile(pairs, p) {
  // pairs: [{v, w}]，已按 v 升序
  const total = pairs.reduce((s, x) => s + x.w, 0);
  if (total <= 0) return null;
  let cum = 0;
  const target = total * p;
  for (const x of pairs) {
    cum += x.w;
    if (cum >= target) return x.v;
  }
  return pairs.at(-1).v;
}

const r1 = x => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

// ── 年度快照 ──
// report: 刚结束的那一年的年报（年末快照）；为 null 时用实时年账（第 180 天）。
function snapshot(state, { year, day, report, acc, label, prevShopStatus, policy }) {
  const out = { label, year, day, mid: !report };
  // 人口与户数
  const hs = householdList(state).filter(isActiveHousehold);
  const people = populationStats(state);
  out.population = people.total;
  out.households = hs.length;
  out.satisfaction = r1(state.satisfaction);
  out.satisfactionYtdAvg = acc.days ? r1(acc.satSum / acc.days) : null;
  out.shortageDays = acc.shortDays;
  out.daysObserved = acc.days;

  // 货币存量（粮券）
  const town = (state.currency?.balances?.town || 0) / V;
  const residents = residentVoucherUnits(state) / V;
  const shopsCash = Object.values(state.shops || {}).reduce((s, x) => s + (x.cashVoucherUnits || 0), 0) / V;
  const companyCash = Object.values(state.companies || {}).reduce((s, x) => s + (x.cashVoucherUnits || 0), 0) / V;
  const social = (state.socialSecurity?.cashVoucherUnits || 0) / V;
  const bank = (state.bank?.cashVoucherUnits || 0) / V;
  out.money = { total: r1(town + residents + shopsCash + companyCash + social + bank), town: r1(town), residents: r1(residents),
    shops: r1(shopsCash), companies: r1(companyCash), social: r1(social), bank: r1(bank) };

  // 镇库：小麦与收支
  out.treasury = { wheatJin: r1((state.accounts?.town?.wheat || 0) / I), vouchers: r1(town) };
  // 镇库年收支（小麦计价的实物流）：收入 = 农业税/收成入库 + 租金 + 营业权 + 向居民卖粮盐 + 居民用小麦换券入库；
  // 支出 = 工资 + 营造工资 + 失业金 + 救济 + 磨坊/酒坊投入小麦 + 居民用券兑回小麦。
  // 年报里 financialFlows 已展开为 {residents, town}；换券/兑回/加工投入来自 economy/financial-flows.js 的账本映射。
  const flowsTown = report ? report.financialFlows?.town : state.financialFlows?.year?.town;
  const INCOME_KEYS = ["agricultureWheatUnits", "rentWheatUnits", "operatingRightWheatUnits", "breadPurchaseWheatUnits", "saltPurchaseWheatUnits", "wheatExchangeInUnits"];
  const SPEND_KEYS = ["wagesWheatUnits", "constructionWagesWheatUnits", "unemploymentWheatUnits", "reliefWheatUnits", "productionInputWheatUnits", "wheatRedeemedUnits"];
  const sumKeys = keys => keys.reduce((s, k) => s + (flowsTown?.[k] || 0), 0) / I;
  out.treasury.incomeWheatJin = r1(sumKeys(INCOME_KEYS));
  out.treasury.spendWheatJin = r1(sumKeys(SPEND_KEYS));
  out.treasury.productionInputJin = r1(sumKeys(["productionInputWheatUnits"]));
  out.treasury.exchangeInJin = r1(sumKeys(["wheatExchangeInUnits"]));
  out.treasury.redeemedJin = r1(sumKeys(["wheatRedeemedUnits"]));
  out.treasury.flowsTown = flowsTown || null;
  // 市场面包库存（批发市场账上，斤）：镇营面包房产出入市后没人买时在这里堆积。
  out.marketBreadJin = r1((state.wholesaleMarket?.inventory?.bread || 0) / I);

  // 家底分布：人均（粮券 + 可折算余粮），人口加权分位。
  const pcs = [];
  let wSum = 0, wealthSum = 0, peopleInHs = 0;
  for (const h of hs) {
    const p = Math.max(1, householdPopulation(h));
    const wealth = householdWealthUnits(state, h, CONTENT) / V;
    pcs.push({ v: wealth / p, w: p });
    wealthSum += wealth; peopleInHs += p;
  }
  pcs.sort((a, b) => a.v - b.v);
  // 基尼系数与最富 10% 占比（按人口加权，口径同上面的家底）。
  const totalW = pcs.reduce((sum, row) => sum + row.w, 0);
  const totalV = pcs.reduce((sum, row) => sum + row.v * row.w, 0);
  let cumW = 0, cumV = 0, area = 0;
  for (const row of pcs) { const prevV = cumV; cumW += row.w; cumV += row.v * row.w; area += row.w / totalW * ((prevV + cumV) / 2 / (totalV || 1)); }
  let topV = 0, topW = 0;
  for (let i = pcs.length - 1; i >= 0 && topW < totalW * 0.1; i--) { const take = Math.min(pcs[i].w, totalW * 0.1 - topW); topW += take; topV += pcs[i].v * take; }
  out.inequality = { gini: totalV > 0 ? r2(1 - 2 * area) : null, top10Share: totalV > 0 ? Math.round(topV / totalV * 1000) / 10 : null,
    wealthTaxJin: r1((state.redistribution?.cumulative?.wealthTaxUnits || 0) / V), inheritanceJin: r1((state.redistribution?.cumulative?.inheritanceTaxUnits || 0) / V) };
  out.wealth = {
    p10: r1(weightedPercentile(pcs, 0.1)), p50: r1(weightedPercentile(pcs, 0.5)), p90: r1(weightedPercentile(pcs, 0.9)),
    meanPerCapita: peopleInHs ? r1(wealthSum / peopleInHs) : null
  };
  const budgets = householdBudgets(state, CONTENT);
  let affW = 0, affP = 0;
  for (const row of budgets.values()) { affW += row.affluence * row.people; affP += row.people; }
  out.affluence = affP ? r2(affW / affP) : null;

  // 价格：批发售价（市场）与综合商店零售价（综合商店 general 的均值）。
  const wpv = state.wholesaleMarket?.pricesVoucherPerUnit || {};
  const summaries = shopSummaries(state, CONTENT);
  const generalRows = summaries.filter(s => s.typeId === "general");
  out.prices = { wholesale: {}, retail: {} };
  for (const id of PRICE_ITEMS) {
    out.prices.wholesale[id] = r2(wpv[id] ?? null);
    const vals = generalRows.map(s => s.inventoryRows?.find(r => r.itemId === id)?.retailVoucher).filter(Number.isFinite);
    out.prices.retail[id] = vals.length ? r2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }

  // 就业与工资
  const labor = selectJobRows(state, CONTENT);
  out.jobs = { employed: labor.employed, idle: labor.idle, workingAge: labor.workingAge };
  let wageW = 0, wageN = 0;
  // 只算有工资的岗位（农民等无工资岗位不计入）。
  for (const row of labor.rows) if (row.count > 0 && row.wagePerWorkerDay > 0) { wageW += row.wagePerWorkerDay * row.count; wageN += row.count; }
  out.jobs.avgWageJinPerDay = wageN ? r2(wageW / wageN) : null;
  out.jobs.unpaidWageJin = r1(((report ? report.payroll?.year : state.payroll?.year)?.unpaidWheatUnits || 0) / I);

  // 农业收成（斤）：年报 yearTotals.harvestQeq；中途为年初至今。
  out.harvestJin = r1(((report ? report.harvestQeq : state.yearTotals?.harvestQeq) || 0) / CONTENT.precision.qeqUnitsPerJin);
  // 镇营生产建筑状态与分行业产出
  const producers = state.buildings.filter(isTownProducer).map(b => {
    const rows = labor.rows.filter(r => r.buildingId === b.id && r.scope === "building");
    const count = rows.reduce((s, r) => s + r.count, 0);
    const capacity = rows.reduce((s, r) => s + r.capacity, 0);
    const status = count <= 0 ? "停工" : (count < capacity ? "缺员" : "满员");
    return { id: b.id, typeId: b.typeId, level: b.ownership?.townLevels || 0, count, capacity, status };
  });
  out.producers = {
    full: producers.filter(p => p.status === "满员").length,
    short: producers.filter(p => p.status === "缺员").length,
    idle: producers.filter(p => p.status === "停工").length,
    list: producers
  };
  // 产出口径：分行业账（report.industries / state.industries）+ 镇营账（report.business / state.business）。
  // 面粉、面包没有 accountingSector，产出记在 business（economy/business.js commitProductionAccounting），
  // 只读 industries 会得到 0。
  const sectorOut = {};
  for (const [sector, val] of Object.entries(report ? report.industries || {} : {})) {
    sectorOut[sector] = val?.producedUnits || {};
  }
  if (!report) for (const [sector, val] of Object.entries(state.industries || {})) sectorOut[sector] = val?.year?.producedUnits || {};
  sectorOut.business = report ? (report.business?.producedUnits || {}) : (state.business?.year?.producedUnits || {});
  out.output = {};
  for (const [sector, units] of Object.entries(sectorOut)) {
    const total = Object.values(units).reduce((s, x) => s + x, 0);
    out.output[sector] = { jin: r1(total / I), byItem: Object.fromEntries(Object.entries(units).map(([k, v]) => [k, r1(v / I)])) };
  }

  // 店铺：营业数、本年关停、利润（按店铺类型）
  const shopAcc = id => (report ? report.shops?.[id]?.accounts : state.shops?.[id]?.accounts?.year) || {};
  const byKind = {};
  const statusNow = {};
  let closedThisYear = 0, openedThisYear = 0;
  for (const s of summaries) {
    const acc2 = shopAcc(s.id);
    const profit = (acc2.profitVoucherUnits || 0) / V;
    const k = s.kind || "retail";
    byKind[k] ||= { count: 0, open: 0, profit: 0 };
    byKind[k].count++;
    if (s.status === "open") byKind[k].open++;
    byKind[k].profit += profit;
    statusNow[s.id] = s.status;
    if (prevShopStatus) {
      const before = prevShopStatus[s.id];
      if (before === undefined) openedThisYear++;
      else if ((before === "open" || before === "paused") && (s.status === "closed" || s.status === "liquidating")) closedThisYear++;
    }
  }
  out.shopStatusMap = statusNow;
  out.shops = {
    total: summaries.length,
    open: summaries.filter(s => s.status === "open").length,
    paused: summaries.filter(s => s.status === "paused").length,
    closed: summaries.filter(s => s.status === "closed" || s.status === "liquidating").length,
    closedThisYear, openedThisYear,
    profitByKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { ...v, profit: r1(v.profit) }])),
    profitTotal: r1(Object.values(byKind).reduce((s, v) => s + v.profit, 0))
  };

  // 养殖场
  const farms = summaries.filter(s => s.kind === "farm");
  out.farms = {
    count: farms.length,
    keepers: farms.reduce((s, f) => s + (f.merchants || 0), 0),
    hands: farms.reduce((s, f) => s + (f.clerks || 0), 0),
    profit: r1(farms.reduce((s, f) => s + (shopAcc(f.id).profitVoucherUnits || 0), 0) / V),
    productJinPerDayNow: r1(farms.reduce((s, f) => s + (f.farm?.producedDayJin || 0), 0))
  };

  // 时代广场（集体集市）
  const squares = stallSquareSummaries(state, CONTENT, summaries);
  const sq = squares[0] || null;
  const stallShop = sq?.shopId ? state.shops?.[sq.shopId] : null;
  out.timesSquare = sq ? {
    keepers: sq.keepers, keeperCap: sq.keeperCap, stallsUsed: sq.stallsUsed,
    profit: r1((shopAcc(sq.shopId).profitVoucherUnits || 0) / V),
    distributedToKeepers: r1((shopAcc(sq.shopId).distributedVoucherUnits || 0) / V),
    averageDailySalesJin: r1(sq.averageDailySalesJin ?? sq.averageDailySales ?? null),
    status: stallShop?.status || null, statusReason: stallShop?.statusReason || null
  } : null;

  // 日用品：年内（或截至当天）用上 / 需求
  out.goods = {};
  for (const k of Object.keys(CONTENT.rules.householdGoods)) {
    const d = acc.goodsDemand[k] || 0;
    out.goods[k] = {
      demandJin: r1(d / I), usedJin: r1((acc.goodsUsed[k] || 0) / I),
      fulfilPercent: d > 0 ? r1((acc.goodsUsed[k] || 0) / d * 100) : null
    };
  }
  // 服务：年内服务人次 / 想用人次
  out.services = {};
  for (const k of Object.keys(CONTENT.rules.serviceTypes)) {
    const att = acc.svcAttempt[k] || 0;
    out.services[k] = {
      attempted: Math.round(att), served: Math.round(acc.svcServed[k] || 0),
      unaffordable: Math.round(acc.svcUnaff[k] || 0), capacityUnmet: Math.round(acc.svcCap[k] || 0),
      servedPercent: att > 0 ? r1((acc.svcServed[k] || 0) / att * 100) : null
    };
  }

  // 外镇
  out.outsideTowns = Object.fromEntries(OUTSIDE_TOWN_IDS.map(id => {
    const t = state.outsideTowns?.[id] || {};
    return [id, { population: Math.round(t.population || 0), prosperity: r1(t.prosperity), wheatStockJin: r1(t.wheatStockJin), relations: r1(t.relations) }];
  }));

  // 玩家策略日志
  out.policy = policy || null;

  // 状态合法性
  const check = simulation.validateState(state);
  out.valid = !!check?.valid;
  out.validationErrors = check?.valid ? [] : (check?.errors || []).slice(0, 3);
  return out;
}

// ── 表格输出（中文，宽度不齐时以空格对齐）──
const pad = (v, n) => { const s = v == null ? "—" : String(v); return s.padStart(n); };

function printTables(rows, meta) {
  const L = (s = "") => console.log(s);
  L(`麦乡经济体检：${meta.years} 年，seed ${meta.seed}，运行 ${meta.seconds} 秒，${meta.valid ? "全部年份状态合法" : "⚠ 有年份 validateState 未通过"}`);
  L("（年末快照；标 * 的行为第 1 年第 180 天的中途快照，缺粮/满意/履约为年初至今）\n");

  const tag = r => (r.mid ? "Y1D180*" : `${r.year}`);
  L("【一】人口、满意、家底");
  L([pad("年", 8), pad("人口", 7), pad("户", 5), pad("满意", 7), pad("缺粮天", 8), pad("家底p10", 9), pad("p50", 7), pad("p90", 7), pad("人均均值", 9), pad("富裕度", 7), pad("基尼", 6), pad("富10%占%", 9), pad("累计富人税", 11), pad("累计遗产税", 10)].join(""));
  for (const r of rows) L([pad(tag(r), 8), pad(r.population, 7), pad(r.households, 5), pad(r.satisfaction, 7), pad(r.shortageDays, 8),
    pad(r.wealth.p10, 9), pad(r.wealth.p50, 7), pad(r.wealth.p90, 7), pad(r.wealth.meanPerCapita, 9), pad(r.affluence, 7), pad(r.inequality?.gini, 6), pad(r.inequality?.top10Share, 9), pad(r.inequality?.wealthTaxJin, 11), pad(r.inequality?.inheritanceJin, 10)].join(""));

  L("\n【二】货币存量（粮券，万）与镇库");
  L([pad("年", 8), pad("总券", 9), pad("镇库", 9), pad("居民", 9), pad("店铺", 9), pad("公司", 9), pad("社保", 9), pad("银行", 9), pad("镇库麦(斤)", 12), pad("镇库收(斤)", 11), pad("镇库支(斤)", 11), pad("其中加工投入", 13), pad("市场面包(斤)", 14)].join(""));
  const wan = v => (v == null ? null : (v / 10000).toFixed(1));
  for (const r of rows) L([pad(tag(r), 8), pad(wan(r.money.total), 9), pad(wan(r.money.town), 9), pad(wan(r.money.residents), 9),
    pad(wan(r.money.shops), 9), pad(wan(r.money.companies), 9), pad(wan(r.money.social), 9), pad(wan(r.money.bank), 9),
    pad(r.treasury.wheatJin != null ? Math.round(r.treasury.wheatJin) : null, 12), pad(Math.round(r.treasury.incomeWheatJin), 11), pad(Math.round(r.treasury.spendWheatJin), 11),
    pad(Math.round(r.treasury.productionInputJin), 13), pad(Math.round(r.marketBreadJin), 14)].join(""));

  L("\n【三】批发售价（券/斤）与综合商店零售价");
  const items = PRICE_ITEMS;
  L([pad("年", 8), ...items.map(i => pad("批" + CONTENT.items[i].name.slice(0, 2), 7)), ...items.map(i => pad("零" + CONTENT.items[i].name.slice(0, 2), 7))].join(""));
  for (const r of rows) L([pad(tag(r), 8), ...items.map(i => pad(r.prices.wholesale[i], 7)), ...items.map(i => pad(r.prices.retail[i], 7))].join(""));

  L("\n【四】就业与镇营产业");
  L([pad("年", 8), pad("就业", 7), pad("闲置", 7), pad("工资", 7), pad("欠薪", 8), pad("生产满员", 9), pad("缺员", 6), pad("停工", 6), pad("收成", 9), pad("面粉", 9), pad("面包", 9), pad("盐", 8), pad("木", 9), pad("酒", 8), pad("布", 8)].join(""));
  for (const r of rows) {
    const o = r.output;
    const prod = item => {
      for (const sec of Object.values(o)) if (sec.byItem[item] != null) return sec.byItem[item];
      return 0;
    };
    L([pad(tag(r), 8), pad(r.jobs.employed, 7), pad(r.jobs.idle, 7), pad(r.jobs.avgWageJinPerDay, 7), pad(r.jobs.unpaidWageJin, 8),
      pad(r.producers.full, 9), pad(r.producers.short, 6), pad(r.producers.idle, 6),
      pad(Math.round(r.harvestJin || 0), 9), pad(Math.round(prod("flour")), 9), pad(Math.round(prod("bread")), 9),
      pad(Math.round(prod("salt")), 8), pad(Math.round(prod("wood")), 9), pad(Math.round(prod("wine")), 8), pad(Math.round(prod("cloth")), 8)].join(""));
  }

  L("\n【五】店铺、养殖、时代广场（利润单位：万券，年末为全年，中途为年初至今）");
  L([pad("年", 8), pad("店铺", 6), pad("营业", 6), pad("暂停", 6), pad("关停本年", 9), pad("开张本年", 9), pad("店利润", 9), pad("农场", 6), pad("农场利", 8), pad("广场摊", 8), pad("广场利", 8), pad("广场分红", 9)].join(""));
  for (const r of rows) {
    const k = r.shops.profitByKind;
    L([pad(tag(r), 8), pad(r.shops.total, 6), pad(r.shops.open, 6), pad(r.shops.paused, 6), pad(r.shops.closedThisYear, 9), pad(r.shops.openedThisYear, 9),
      pad(wan(r.shops.profitTotal), 9), pad(r.farms.count, 6), pad(wan(r.farms.profit), 8),
      pad(r.timesSquare?.keepers ?? "—", 8), pad(wan(r.timesSquare?.profit ?? null), 8), pad(wan(r.timesSquare?.distributedToKeepers ?? null), 9)].join(""));
  }

  L("\n【六】日用品履约（用上/需求，%）与服务履约（%）");
  const goodKeys = Object.keys(CONTENT.rules.householdGoods);
  L([pad("年", 8), ...goodKeys.map(k => pad(CONTENT.items[k]?.name?.slice(0, 2) || k, 7)), ...Object.keys(CONTENT.rules.serviceTypes).map(k => pad("服" + k.slice(0, 2), 7))].join(""));
  for (const r of rows) L([pad(tag(r), 8), ...goodKeys.map(k => pad(r.goods[k].fulfilPercent, 7)), ...Object.keys(CONTENT.rules.serviceTypes).map(k => pad(r.services[k].servedPercent, 7))].join(""));

  L("\n【七】外镇（人口 / 繁荣度）");
  L([pad("年", 8), ...OUTSIDE_TOWN_IDS.map(id => pad(id.slice(0, 4) + "人口", 11)), ...OUTSIDE_TOWN_IDS.map(id => pad(id.slice(0, 4) + "繁荣", 11))].join(""));
  for (const r of rows) L([pad(tag(r), 8), ...OUTSIDE_TOWN_IDS.map(id => pad(r.outsideTowns[id].population, 11)), ...OUTSIDE_TOWN_IDS.map(id => pad(r.outsideTowns[id].prosperity, 11))].join(""));

  L("\n【八】玩家策略日志（年初执行）");
  for (const r of rows.filter(x => !x.mid)) {
    const p = r.policy || {};
    L(`  ${r.year} 年：补员 ${p.refills ?? 0} 次；升级 ${p.upgrades?.join("、") || "无"}；未升级 ${p.upgradeRejects?.join("；") || "无"}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const state = buildTown(opts.seed);
  if (opts.wealthTax) {
    const r = simulation.setWealthTax(state, { thresholds: state.policy.wealthTax.thresholds, ratesPercent: opts.wealthTax });
    if (!r.ok) throw new Error("富人税设置失败：" + r.reason);
  }
  if (opts.inheritance != null) {
    const r = simulation.setInheritanceTax(state, opts.inheritance);
    if (!r.ok) throw new Error("遗产税设置失败：" + r.reason);
  }
  if (opts.employerShare != null) state.socialSecurity.employerSharePercent = opts.employerShare;
  const plan = initPlan(state);
  const levelSeen = {};
  const rows = [];
  // 店铺状态基线：开局时的状态，用来算"本年关停 / 开张"。
  let prevShopStatus = Object.fromEntries(Object.values(state.shops || {}).map(x => [x.id, x.status]));
  let midDone = false;
  // 起点快照（第 0 天）不记录，只记录年末与第 1 年第 180 天。
  for (let y = 1; y <= opts.years; y++) {
    const policy = yearStartPolicy(state, plan, levelSeen);
    const acc = newAcc();
    while (state.year === y) {
      const ret = simulation.advanceDay(state);
      accumulate(acc, state, ret);
      if (y === 1 && !midDone && state.day === MID_DAY) {
        rows.push(snapshot(state, { year: y, day: state.day, report: null, acc, label: "Y1D180", prevShopStatus: null, policy: null }));
        midDone = true;
      }
    }
    // 年终：刚进入 y+1，上一年报在 annualReports 末尾。
    const report = state.annualReports.at(-1) || null;
    const row = snapshot(state, { year: y, day: 0, report, acc, label: String(y), prevShopStatus, policy });
    prevShopStatus = row.shopStatusMap;
    delete row.shopStatusMap;
    rows.push(row);
    const line = `[${((Date.now() - started) / 1000).toFixed(0)}s] 第 ${y} 年完成：人口 ${row.population}，满意 ${row.satisfaction}，家底中位 ${row.wealth.p50}，总券 ${row.money.total}`;
    console.error(line);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const valid = rows.every(r => r.valid);
  for (const r of rows) delete r.shopStatusMap;
  const yearRows = rows.filter(r => !r.mid);
  const meta = { years: opts.years, seed: opts.seed, seconds, valid, generatedAt: new Date().toISOString() };
  printTables(rows, meta);
  if (opts.json) {
    await writeFile(opts.json, JSON.stringify({ meta, rows, yearRows: yearRows.length }, null, 2));
    console.log(`\n已写入 ${opts.json}`);
  }
}

main().catch(err => { console.error(err.stack || err.message || err); process.exit(1); });
