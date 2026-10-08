// scripts/demand-probe.mjs
// 居民需求探针：搭一座较完整的镇子（银行、批发、商业街、加工业、养殖基地、时代广场），
// 切到粮券、跑 N 天，取最后 60 天的日均值，报告人口、主食、盐、日用品、修缮、服务、现金分布、满意度构成与人均收支。
// 只读取模拟状态，不改 src/。
//
// 用法：
//   node scripts/demand-probe.mjs [days=365] [--seed 91] [--json out.json]
//   node scripts/demand-probe.mjs --compare a.json b.json     对比两次 --json 输出

import { readFile, writeFile } from "node:fs/promises";
import { simulation, CONTENT } from "../src/engine.js";
import { grantResidentVouchers } from "../tests/helpers-v16.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { householdList, householdPopulation, isActiveHousehold } from "../src/systems/households.js";

const WINDOW = 60;
const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const Q = CONTENT.precision.qeqUnitsPerJin;

function parseArgs(argv) {
  const opts = { days: 365, seed: 91, json: null, compare: null };
  if (argv[0] === "--compare") return { ...opts, compare: [argv[1], argv[2]] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") opts.seed = Number(argv[++i]);
    else if (a === "--json") opts.json = argv[++i];
    else if (/^\d+$/.test(a)) opts.days = Number(a);
    else throw new Error(`未知参数：${a}`);
  }
  if (!(opts.days >= 1)) throw new Error("days 必须 >= 1");
  return opts;
}

// 搭镇：与 tests/ 的夹具保持同一套建筑与岗位写法。
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
  issueTownVouchers(state, 8000 * V, CONTENT, "探针");
  transferVouchers(state, "town", `shop:${store.shopId}`, 8000 * V, CONTENT, "探针", "探针");
  simulation.configureShopClerks(state, store.shopId, 15);
  for (const t of ["haircut", "tea", "restaurant", "repair"]) simulation.openResidentShop(state, street, t);
  for (const t of ["chicken_farm", "duck_farm", "goose_farm", "pig_farm"]) simulation.openResidentShop(state, base, t);
  return { state, storeId: store.shopId };
}

// 递归取数值叶子（跳过数组），用于 householdBudget 这类尚在演化的结构。
function numericLeaves(obj, prefix, out = []) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" && Number.isFinite(v)) out.push([path, v]);
    else if (v && typeof v === "object") numericLeaves(v, path, out);
  }
  return out;
}

// 每日采样：把当天数值累加进 acc（Map：指标名 -> 合计）。非有限值跳过，缺失的指标最终显示为 —。
function sampleDay(state, storeId, acc) {
  const add = (k, v) => { if (Number.isFinite(v)) acc.set(k, (acc.get(k) || 0) + v); };
  const hs = householdList(state).filter(isActiveHousehold);
  const people = hs.reduce((s, h) => s + householdPopulation(h), 0);
  add("people", people);
  add("satisfaction", state.satisfaction);
  add("shortage", (state.shortageQeq || 0) / Q);

  for (const r of state.market?.staplesLastDay?.rows || []) {
    add(`staple.${r.itemId}.target`, r.targetQeqJin);
    add(`staple.${r.itemId}.bought`, r.purchasedJin);
    add(`staple.${r.itemId}.paid`, r.paidVoucher);
  }

  const salt = state.salt?.day;
  add("salt.demand", salt?.demandUnits / I);
  add("salt.bought", salt?.purchasedUnits / I);
  add("salt.used", salt?.satisfiedUnits / I);
  add("salt.paid", salt?.paidWheatUnits / V);

  const goods = state.goodsDemand?.day;
  for (const k of Object.keys(CONTENT.rules.householdGoods)) {
    add(`goods.${k}.demand`, (goods?.demandUnits?.[k] || 0) / I);
    add(`goods.${k}.bought`, (goods?.purchasedUnits?.[k] || 0) / I);
    add(`goods.${k}.used`, (goods?.consumedUnits?.[k] || 0) / I);
    add(`goods.${k}.paid`, (goods?.paidVoucherUnits?.[k] || 0) / V);
  }

  const wood = state.housing?.lastRepairWoodDay;
  add("wood.target", wood?.targetUnits / I);
  add("wood.bought", wood?.purchasedUnits / I);
  add("wood.paid", wood?.paidVoucherUnits / V);

  const svc = state.services?.day;
  for (const k of Object.keys(CONTENT.rules.serviceTypes)) {
    add(`svc.${k}.attempt`, svc?.attemptedUses?.[k] || 0);
    add(`svc.${k}.served`, svc?.servedUses?.[k] || 0);
    add(`svc.${k}.unaff`, svc?.unaffordableUses?.[k] || 0);
    add(`svc.${k}.cap`, svc?.capacityUnmetUses?.[k] || 0);
  }
  add("svc.spend", svc?.spendingVoucherUnits / V);

  const shopDay = state.shops?.[storeId]?.accounts?.day;
  add("store.customers", shopDay?.customerCount);
  add("store.rejected", shopDay?.rejectedCustomerCount);

  // 现金分布（人均粮券）与各日用品门槛覆盖率。
  const cashPC = hs.map(h => (h.voucherUnits || 0) / V / Math.max(1, householdPopulation(h))).sort((a, b) => a - b);
  if (cashPC.length) {
    const q = p => cashPC[Math.floor(p * (cashPC.length - 1))];
    add("cash.p10", q(0.1)); add("cash.p50", q(0.5)); add("cash.p90", q(0.9));
    for (const [k, cfg] of Object.entries(CONTENT.rules.householdGoods)) {
      const min = cfg?.minCashVoucherPerCapita;
      if (Number.isFinite(min)) add(`cashGate.${k}`, cashPC.filter(c => c >= min).length / cashPC.length);
    }
  }
  add("households", hs.length);

  // 满意度构成：按人口加权的各数值字段（跳过对象与 householdId）。
  const rows = state.satisfactionFactors?.rows || [];
  const popSum = rows.reduce((s, r) => s + (r.people || 0), 0);
  if (popSum > 0) {
    const sums = new Map();
    for (const r of rows) for (const [k, v] of Object.entries(r)) {
      if (k === "people" || k === "householdId" || typeof v !== "number" || !Number.isFinite(v)) continue;
      sums.set(k, (sums.get(k) || 0) + v * (r.people || 0));
    }
    for (const [k, s] of sums) add(`factor.${k}`, s / popSum);
  }

  // 人均日收支（人口加权：总额 / 总人口，观察窗口滚动 14 天）。
  let inc = 0, exp = 0, pop = 0;
  for (const h of hs) {
    const obs = h.life?.observation;
    const days = Math.max(1, obs?.rows?.length || 1);
    const p = householdPopulation(h);
    inc += (obs?.totals?.incomeVoucherUnits || 0) / V / days;
    exp += (obs?.totals?.lifeExpenseVoucherUnits || 0) / V / days;
    pop += p;
  }
  if (pop > 0) { add("perCapita.income", inc / pop); add("perCapita.expense", exp / pop); }

  // 家庭预算：若存在 state.householdBudget.day，则把数值叶子按原路径收集。
  for (const [path, v] of numericLeaves(state.householdBudget?.day, "budget")) add(path, v);
}

function avgOf(acc, n) {
  const out = {};
  for (const [k, v] of acc) out[k] = v / n;
  return out;
}

// 取平均值；缺失则 null，显示为 —。
const fmt = (m, k, d = 1) => (m[k] == null || !Number.isFinite(m[k]) ? "—" : m[k].toFixed(d));
const keysMatching = (m, re) => [...new Set(Object.keys(m).map(k => k.match(re)?.[1]).filter(Boolean))];

function printReport(m, meta, budgetKeys) {
  const L = (s = "") => console.log(s);
  L(`麦乡需求探针：${meta.days} 天，seed ${meta.seed}，取最后 ${meta.window} 天日均（${meta.valid ? "状态合法" : "⚠ validateState 未通过"}）`);
  L(`人口 ${fmt(m, "people", 0)}，满意度 ${fmt(m, "satisfaction")}，口粮缺口 ${fmt(m, "shortage")} 斤/日，家户 ${fmt(m, "households", 0)}`);

  L("\n主食（斤/日）：目标 / 买到 / 花券");
  for (const id of keysMatching(m, /^staple\.(.+)\.target$/)) {
    L(`  ${id}: ${fmt(m, `staple.${id}.target`, 0)} / ${fmt(m, `staple.${id}.bought`, 0)} / ${fmt(m, `staple.${id}.paid`, 0)}`);
  }
  L(`盐（斤/日）：需求 ${fmt(m, "salt.demand")} 买 ${fmt(m, "salt.bought")} 用 ${fmt(m, "salt.used")} 花 ${fmt(m, "salt.paid")} 券`);

  L("\n日用品（斤/日）：需求 / 买 / 用 / 花券 / 门槛覆盖率");
  for (const k of Object.keys(CONTENT.rules.householdGoods)) {
    const gate = m[`cashGate.${k}`] == null ? "—" : `${(m[`cashGate.${k}`] * 100).toFixed(0)}%`;
    L(`  ${k}: ${fmt(m, `goods.${k}.demand`)} / ${fmt(m, `goods.${k}.bought`)} / ${fmt(m, `goods.${k}.used`)} / ${fmt(m, `goods.${k}.paid`)} / ${gate}`);
  }

  L(`\n修缮木材（斤/日）：目标 ${fmt(m, "wood.target")} 买 ${fmt(m, "wood.bought")} 花 ${fmt(m, "wood.paid")} 券`);

  L("\n服务（人次/日）：想用 / 用上 / 没钱 / 没位");
  for (const k of Object.keys(CONTENT.rules.serviceTypes)) {
    L(`  ${k}: ${fmt(m, `svc.${k}.attempt`, 0)} / ${fmt(m, `svc.${k}.served`, 0)} / ${fmt(m, `svc.${k}.unaff`, 0)} / ${fmt(m, `svc.${k}.cap`, 0)}`);
  }
  L(`服务花费 ${fmt(m, "svc.spend")} 券/日`);

  L(`\n综合商店（人次/日）：客流 ${fmt(m, "store.customers")}，拒客 ${fmt(m, "store.rejected")}`);

  L(`\n人均现金（券）：10% ${fmt(m, "cash.p10")}  中位 ${fmt(m, "cash.p50")}  90% ${fmt(m, "cash.p90")}`);

  L("\n满意度构成（人口加权，窗口均值）：");
  for (const k of keysMatching(m, /^factor\.(.+)$/)) L(`  ${k}: ${fmt(m, `factor.${k}`, 2)}`);

  L(`\n人均日收入 ${fmt(m, "perCapita.income", 2)} 券，人均日生活支出 ${fmt(m, "perCapita.expense", 2)} 券`);

  if (budgetKeys.length) {
    L("\n家庭预算（state.householdBudget.day，数值叶子，窗口均值）：");
    for (const k of budgetKeys) L(`  ${k}: ${fmt(m, k, 2)}`);
  }
}

async function runProbe(opts) {
  const { state, storeId } = buildTown(opts.seed);
  const window = Math.min(WINDOW, opts.days);
  const acc = new Map();
  for (let d = 1; d <= opts.days; d++) {
    simulation.advanceDay(state);
    if (d > opts.days - window) sampleDay(state, storeId, acc);
  }
  const metrics = avgOf(acc, window);
  const valid = !!simulation.validateState(state)?.valid;
  const meta = { days: opts.days, seed: opts.seed, window, valid };
  const budgetKeys = Object.keys(metrics).filter(k => k.startsWith("budget."));
  printReport(metrics, meta, budgetKeys);
  if (opts.json) {
    await writeFile(opts.json, JSON.stringify({ meta, metrics }, null, 2));
    console.log(`\n已写入 ${opts.json}`);
  }
}

async function compare([fileA, fileB]) {
  if (!fileA || !fileB) throw new Error("用法：--compare a.json b.json");
  const a = JSON.parse(await readFile(fileA, "utf8"));
  const b = JSON.parse(await readFile(fileB, "utf8"));
  const keys = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])];
  console.log(`A: ${fileA}（${a.meta?.days} 天 seed ${a.meta?.seed}）`);
  console.log(`B: ${fileB}（${b.meta?.days} 天 seed ${b.meta?.seed}）`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad("指标", 30)}${pad("A", 14)}${pad("B", 14)}Δ(B-A)`);
  for (const k of keys) {
    const va = a.metrics[k], vb = b.metrics[k];
    const f = v => (typeof v === "number" ? v.toFixed(2) : "—");
    const d = typeof va === "number" && typeof vb === "number" ? (vb - va).toFixed(2) : "—";
    console.log(`${pad(k, 30)}${pad(f(va), 14)}${pad(f(vb), 14)}${d}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.compare) return compare(opts.compare);
  return runProbe(opts);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
