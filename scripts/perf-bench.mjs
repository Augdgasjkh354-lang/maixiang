// scripts/perf-bench.mjs
// 日结性能基线：搭与 health-check 相同的镇子，固定种子跑 N 天，输出 state 的 sha256 与耗时。
// 纯性能优化必须保持哈希不变。用法：node scripts/perf-bench.mjs [days=90] [--seed 91] [--every 30]
import { createHash } from "node:crypto";
import { simulation, CONTENT } from "../src/engine.js";
import { grantResidentVouchers } from "../tests/helpers-v16.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";

const args = process.argv.slice(2);
const days = Number(args.find(a => /^\d+$/.test(a)) || 90);
const seedAt = args.indexOf("--seed");
const seed = seedAt >= 0 ? Number(args[seedAt + 1]) : 91;
const everyAt = args.indexOf("--every");
const every = everyAt >= 0 ? Number(args[everyAt + 1]) : 30;
const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function buildTown(seed) {
  const state = simulation.createInitialState({ seed });
  state.accounts.town.wood += 50000 * I;
  const freePlot = (feature = null) => state.plots.find(p => (feature ? p.feature === feature : !p.feature)
    && !state.buildings.some(b => b.plotId === p.id));
  const add = (typeId, level = 2, feature = null) => {
    const p = freePlot(feature);
    if (!p) return null;
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
  grantResidentVouchers(state, 200000);
  const store = simulation.openResidentShop(state, street, "general");
  issueTownVouchers(state, 8000 * V, CONTENT, "体检起始资本");
  transferVouchers(state, "town", `shop:${store.shopId}`, 8000 * V, CONTENT, "体检起始资本", "体检起始资本");
  simulation.configureShopClerks(state, store.shopId, 15);
  for (const t of ["haircut", "tea", "restaurant", "repair"]) simulation.openResidentShop(state, street, t);
  for (const t of ["chicken_farm", "duck_farm", "goose_farm", "pig_farm"]) simulation.openResidentShop(state, base, t);
  return state;
}

const hash = s => createHash("sha256").update(JSON.stringify(s)).digest("hex");
const state = buildTown(seed);
const t0 = performance.now();
const cpu0 = process.cpuUsage();
const marks = [];
for (let d = 1; d <= days; d++) {
  simulation.advanceDay(state);
  if (d % every === 0 || d === days) marks.push(`day ${d}: ${hash(state).slice(0, 16)}`);
}
const ms = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
const check = simulation.validateState ? simulation.validateState(state) : null;
console.log(marks.join("\n"));
console.log(`FINAL ${hash(state)}`);
console.log(`days=${days} seed=${seed} elapsed=${(ms / 1000).toFixed(2)}s cpu=${((cpu.user + cpu.system) / 1e6).toFixed(2)}s valid=${check ? JSON.stringify(check.valid ?? check.ok ?? check) : "n/a"}`);
