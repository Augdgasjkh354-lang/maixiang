// scripts/simulate.mjs
// 数值模拟 harness（简报思路 A 通用版）：读场景 JSON，跑 headless 模拟，输出关键指标。
//
// 用法：
//   node scripts/simulate.mjs <场景.json> [--out <结果路径>] [--format csv|json]
//
// 场景 JSON 示例：
// {
//   "name": "baseline-10y",
//   "seed": 42,
//   "years": 10,
//   "daysPerYear": 365,                 // 可选，默认取 content.rules.daysPerYear
//   "metrics": ["population_total"],    // 可选，默认输出全部指标
//   "script": [
//     { "year": 1, "action": "setWageRate", "args": { "roleId": "millers", "dailyJin": 12 } },
//     { "year": 2, "action": "buildAt", "args": { "typeId": "mill", "plotId": "auto" } },
//     { "year": 3, "action": "setUnemploymentPolicy", "args": { "enabled": true, "dailyPerWorkerJin": 2 } },
//     { "year": 5, "action": "toggleAutomaticRelief", "args": { "enabled": false } }
//   ]
// }
//
// 动作在指定年份"年初"（推进当年天数之前）按顺序执行；指标在每年年末采集。
// 只新增本文件，不改 src/ 下任何游戏逻辑与数值。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSimulation, CONTENT } from "../src/engine.js";
import { APP_VERSION } from "../src/content/version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { populationStats, selectJobRows } = await import(path.join(root, "src", "selectors", "labor.js"));
const householdModule = await import(path.join(root, "src", "systems", "households.js"));
const { householdList, householdFoodQeqUnits, householdIdleWorkers, householdPopulation, syncResidentAggregates } = householdModule;
const { computeLaborMarket } = await import(path.join(root, "src", "systems", "labor-market.js"));
const { shopTradePrices } = await import(path.join(root, "src", "economy", "operating-plan.js"));
const currencyModule = await import(path.join(root, "src", "economy", "currency.js"));
const { computeWealthStats } = await import(path.join(root, "src", "systems", "wealth-stats.js"));

const QEQ = CONTENT.precision.qeqUnitsPerJin;
const INV_JIN = CONTENT.precision.inventoryUnitsPerJin;
const VOUCHER = CONTENT.precision.currencyUnitsPerVoucher; // 粮券单位 -> 斤（与 panel-ledger 口径一致）
const qeqToJin = (qeqUnits) => (Number(qeqUnits) || 0) / QEQ;
const voucherToJin = (voucherUnits) => (Number(voucherUnits) || 0) / VOUCHER;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// ---------------------------------------------------------------- 动作注册表
// 每个动作：{ desc, run(sim, state, args, ctx) -> {ok, reason?} }
// 新增动作时只需在这里加一行，场景 JSON 即可直接使用。参数不足/非法时返回 ok:false。
function pickAutoPlot(sim, state, typeId) {
  const used = new Set([
    ...state.buildings.map((b) => b.plotId),
    ...(state.projects || []).map((p) => p.plotId),
  ]);
  const plots = state.plots || CONTENT.plots || [];
  const reasons = new Map(); // reason -> count
  for (const plot of plots) {
    if (used.has(plot.id)) continue;
    const res = sim.buildAt(state, typeId, plot.id);
    if (res && res.ok) return { ok: true, plotId: plot.id, detail: res };
    // startConstruction 先校验后落子：失败不改状态，可安全换地块重试
    const reason = (res && res.reason) || "未知原因";
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  if (reasons.size === 0) return { ok: false, reason: "没有可用空地" };
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
  return { ok: false, reason: top[0] + (reasons.size > 1 ? `（另有${reasons.size - 1}种失败原因）` : "") };
}

function ensureSocialOffice(state) {
  if (state.buildings.some(b => b.typeId === "social_security_office")) return true;
  const plot = state.plots.find(p => !p.feature && !state.buildings.some(b => b.plotId === p.id) && !(state.projects || []).some(pr => pr.plotId === p.id));
  if (!plot) return true;
  state.buildings.push({ id: "social-office-sim", typeId: "social_security_office", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: state.day + 1 } });
  return true;
}

const ACTIONS = {
  // 调工资
  setWageRate: {
    desc: "调整某工种日薪 {roleId, dailyJin}",
    run: (sim, state, a) => {
      if (!a.roleId || !Number.isFinite(Number(a.dailyJin))) return { ok: false, reason: "需要 roleId 与 dailyJin" };
      return sim.setWageRate(state, a.roleId, Number(a.dailyJin));
    },
  },
  // 开关失业金及金额
  setUnemploymentPolicy: {
    desc: "失业金政策 {enabled, dailyPerWorkerJin?}",
    run: (sim, state, a) => sim.setUnemploymentPolicy(state, {
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
      ...(a.dailyPerWorkerJin !== undefined ? { dailyPerWorkerJin: a.dailyPerWorkerJin } : {}),
    }),
  },
  // 建指定建筑（plotId 可为 "auto" 自动选空地）
  buildAt: {
    desc: "建造建筑 {typeId, plotId|auto}",
    run: (sim, state, a) => {
      if (!a.typeId) return { ok: false, reason: "需要 typeId" };
      if (a.plotId && a.plotId !== "auto") return sim.buildAt(state, a.typeId, a.plotId);
      return pickAutoPlot(sim, state, a.typeId);
    },
  },
  // ---- 开关政策类 ----
  setAgricultureTax: {
    desc: "农业税率 {percent}",
    run: (sim, state, a) => sim.setAgricultureTax(state, a.percent),
  },
  setPrivateProductionTax: {
    desc: "民营生产税 {typeId, percent}",
    run: (sim, state, a) => sim.setPrivateProductionTax(state, a.typeId, a.percent),
  },
  setBreadPrice: {
    desc: "面包售价 {wheatPerBreadJin}（每个面包折小麦斤数）",
    run: (sim, state, a) => {
      if (!Number.isFinite(Number(a.wheatPerBreadJin))) return { ok: false, reason: "需要 wheatPerBreadJin（正数）" };
      return sim.setBreadPrice(state, Number(a.wheatPerBreadJin));
    },
  },
  toggleAutomaticRelief: {
    desc: "自动救济开关 {enabled}（底层返回布尔值，此处统一包成 ok）",
    run: (sim, state, a) => {
      const enabled = a.enabled !== undefined ? Boolean(a.enabled) : true;
      sim.toggleAutomaticRelief(state, enabled);
      return { ok: true, enabled: state.autoRelief };
    },
  },
  sendRelief: {
    desc: "一次性发放救济 {amountJin}",
    run: (sim, state, a) => sim.sendRelief(state, a.amountJin),
  },
  startCurrencyReform: {
    desc: "启动货币改革 {}",
    run: (sim, state) => sim.startCurrencyReform(state),
  },
  setShopRent: {
    desc: "商铺日租金 {voucher}（每间营业店铺每日，粮券单位）",
    run: (sim, state, a) => sim.setShopRent(state, a.voucher),
  },
  setShopProfitTax: {
    desc: "商铺利润税 {value}",
    run: (sim, state, a) => sim.setShopProfitTax(state, a.value),
  },
  configureServicePrice: {
    desc: "服务价格 {serviceId, value}",
    run: (sim, state, a) => sim.configureServicePrice(state, a.serviceId, a.value),
  },
  setEmploymentExchangeQuota: {
    desc: "就业交易所配额 {value}",
    run: (sim, state, a) => sim.setEmploymentExchangeQuota(state, a.value),
  },
  // 别墅政策
  setVillaPolicy: {
    desc: "别墅政策 {priceWheatJin?, taxRatePercent?}",
    run: (sim, state, a) => sim.setVillaPolicy(state, {
      ...(a.priceWheatJin !== undefined ? { priceWheatJin: a.priceWheatJin } : {}),
      ...(a.taxRatePercent !== undefined ? { taxRatePercent: a.taxRatePercent } : {}),
    }),
  },
  // 人员安排
  setEmployment: {
    desc: "安排岗位人数 {jobKey, count}",
    run: (sim, state, a) => {
      if (!a.jobKey || !Number.isFinite(Number(a.count))) return { ok: false, reason: "需要 jobKey 与 count" };
      return sim.setEmployment(state, a.jobKey, Number(a.count));
    },
  },
  setProjectWorkers: {
    desc: "调整在建工程人数 {projectId|auto, workers}",
    run: (sim, state, a) => {
      if (a.projectId && a.projectId !== "auto") {
        return sim.setProjectWorkers(state, a.projectId, Number(a.workers));
      }
      // auto: 给所有在建工程都安排人数
      let total = 0;
      for (const proj of (state.projects || []).filter((p) => p.kind !== "upgrade")) {
        const r = sim.setProjectWorkers(state, proj.instanceId, Number(a.workers));
        if (r.ok) total += r.assigned || 0;
      }
      return total > 0 ? { ok: true, assigned: total } : { ok: false, reason: "没有在建工程" };
    },
  },
  // 工资调控
  setWageControl: {
    desc: "工资调控系数 {civil?, industry?}",
    run: (sim, state, a) => sim.setWageControl(state, {
      ...(a.civil !== undefined ? { civil: a.civil } : {}),
      ...(a.industry !== undefined ? { industry: a.industry } : {}),
    }),
  },
  // 按建筑类型安排生产工人
  assignBuildingWorkers: {
    desc: "安排建筑工人 {typeId, jobId, count}",
    run: (sim, state, a) => {
      const buildings = (state.buildings || []).filter((b) => b.typeId === a.typeId);
      if (!buildings.length) return { ok: false, reason: "没有该类型建筑" };
      let total = 0;
      for (const b of buildings) {
        const r = sim.setEmployment(state, b.id + "::" + a.jobId, Number(a.count));
        if (r.ok) total += r.assigned || 0;
      }
      return { ok: true, assigned: total };
    },
  },
  // 社保基金（场景捷径：没有社保局时直接放一座建成的，免得每个场景都排工期）
  setSocialSecurityPolicy: {
    desc: "社保基金政策 {enabled?, dailyPerWorkerJin?, pensionPerElderJin?}",
    run: (sim, state, a) => ensureSocialOffice(state) && sim.setSocialSecurityPolicy(state, {
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
      ...(a.dailyPerWorkerJin !== undefined ? { dailyPerWorkerJin: a.dailyPerWorkerJin } : {}),
      ...(a.pensionPerElderJin !== undefined ? { pensionPerElderJin: a.pensionPerElderJin } : {}),
    }),
  },
  injectSocialSecurity: {
    desc: "社保基金注资 {amountJin}",
    run: (sim, state, a) => {
      if (!Number.isFinite(Number(a.amountJin))) return { ok: false, reason: "需要 amountJin" };
      ensureSocialOffice(state);
      return sim.injectSocialSecurity(state, Number(a.amountJin));
    },
  },
  // 外贸
  setTradeTariffRate: {
    desc: "出口关税税率 {percent}",
    run: (sim, state, a) => {
      if (!Number.isFinite(Number(a.percent))) return { ok: false, reason: "需要 percent" };
      return sim.setTradeTariffRate(state, Number(a.percent));
    },
  },
  tradeOutside: {
    desc: "与外镇贸易 {direction: sell|buy, itemId, quantityJin}",
    run: (sim, state, a) => {
      if (!a.direction || !a.itemId || !Number.isFinite(Number(a.quantityJin))) {
        return { ok: false, reason: "需要 direction、itemId、quantityJin" };
      }
      return sim.tradeWithOutsideTown(state, a.direction, a.itemId, Number(a.quantityJin));
    },
  },
  // 测试辅助：直接给镇库发放材料（仅用于场景测试）
  grantTownMaterial: {    desc: "镇库发放材料 {itemId, quantity}",
    run: (sim, state, a) => {
      if (!a.itemId || !CONTENT.items[a.itemId]) return { ok: false, reason: "未知物品" };
      const qty = Number(a.quantity);
      if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "数量无效" };
      state.accounts ||= {};
      state.accounts.town ||= {};
      state.accounts.town[a.itemId] = (state.accounts.town[a.itemId] || 0) + Math.round(qty * CONTENT.precision.inventoryUnitsPerJin);
      return { ok: true };
    },
  },
  // ---- 0.2.3 流通改革 ----
  setWholesalePurchasePrice: {
    desc: "批发市场收购价 {itemId, value}",
    run: (sim, state, a) => sim.configureWholesalePurchasePrice(state, a.itemId, Number(a.value)),
  },
  setWholesaleSalePrice: {
    desc: "批发市场售价 {itemId, value}",
    run: (sim, state, a) => sim.configureWholesalePrice(state, a.itemId, Number(a.value)),
  },
  setShopTargetMargin: {
    desc: "综合商店目标利润率 {percent}（全镇统一）",
    run: (sim, state, a) => sim.configureAllShopsTargetMargin(state, Number(a.percent)),
  },
  issueTownVouchers: {
    desc: "镇库印券 {amountVoucher}",
    run: (sim, state, a) => sim.issueGrainVouchers(state, "town", Number(a.amountVoucher)),
  },
  // 场景辅助（仅模拟用）：直接把货币制度推进到粮券阶段。商业街零售、商店动态加价与
  // 批发市场销售回款只在粮券经济下才完整运转；这条不是游戏内政策命令，
  // 不建银行也能直接进入粮券阶段（不印钞），供只关心粮券阶段的场景使用。
  forceVoucherStage: {
    desc: "直接进入粮券阶段 {}（仅模拟用）",
    run: (sim, state) => {
      state.monetaryReform ||= {};
      state.monetaryReform.stage = "voucher";
      state.monetaryReform.legacyBankAccess = true;
      state.monetaryReform.completed ||= { year: state.year, day: Math.max(1, state.day + 1), simulated: true };
      return { ok: true, stage: state.monetaryReform.stage };
    },
  },
  // 场景辅助（仅模拟用）：开一家综合商店（需要商业街已建成、有合格业主家庭）。
  openGeneralStore: {
    desc: "在已建成商业街开综合商店 {buildingId|auto}",
    run: (sim, state, a) => {
      const street = a.buildingId && a.buildingId !== "auto"
        ? state.buildings.find(b => b.id === a.buildingId)
        : (state.buildings || []).find(b => b.typeId === "commercial_street");
      if (!street) return { ok: false, reason: "没有已建成的商业街" };
      return sim.openResidentShop(state, street.id, "general", null);
    },
  },
  // 场景辅助（仅模拟用）：镇库发行粮券（银行以小麦为准备换券的等价操作）。
  // 这是镇库在粮券经济下的真实财力来源，用来验证批发市场能长期覆盖镇营工资。
  convertTownWheatToVouchers: {
    desc: "镇库发行粮券 {amountVoucher}",
    run: (sim, state, a) => sim.issueGrainVouchers(state, "town", Number(a.amountVoucher)),
  },
  // 场景辅助（仅模拟用）：给最近开的综合商店雇店员（新店需人工开张，与游戏内一致）。
  hireShopClerks: {
    desc: "给综合商店雇店员 {count}",
    run: (sim, state, a) => {
      const shops = Object.values(state.shops || {}).filter(s => s.typeId === "general" && s.status === "open");
      if (!shops.length) return { ok: false, reason: "没有营业中的综合商店" };
      let total = 0;
      for (const shop of shops) {
        const r = sim.configureShopClerks(state, shop.id, Number(a.count) || 6);
        if (r.ok) total += r.assigned || 0;
      }
      return { ok: true, assigned: total };
    },
  },
  // 场景辅助（仅模拟用）：给若干富裕家庭分别发放开店启动资金（集中发放，
  // 避免全体平均分配后没有单个家庭达到启动门槛）。
  fundShopOwners: {
    desc: "给有闲置劳力的家庭各发开店资金 {amountVoucherPerHousehold, count}",
    run: (sim, state, a) => {
      const per = Math.round(Number(a.amountVoucherPerHousehold) * CONTENT.precision.currencyUnitsPerVoucher);
      const count = Math.max(1, Math.floor(Number(a.count) || 2));
      if (!Number.isSafeInteger(per) || per <= 0) return { ok: false, reason: "启动资金无效" };
      const { householdList: list, householdIdleWorkers: idle } = householdModule;
      const candidates = list(state).filter(h => !h.shopIds?.length).slice().sort((x, y) => idle(y) - idle(x) || x.id.localeCompare(y.id)).slice(0, count);
      const issued = sim.issueGrainVouchers(state, "town", (per * candidates.length) / CONTENT.precision.currencyUnitsPerVoucher);
      if (!issued.ok) return issued;
      const { transferVouchers } = currencyModule;
      let funded = 0;
      for (const household of candidates) {
        const r = transferVouchers(state, "town", `household:${household.id}`, per, CONTENT, "scenario_capital", "场景：开店启动资金");
        if (r.ok) funded += 1;
      }
      return { ok: funded > 0, funded };
    },
  },
  // 场景辅助（仅模拟用）：把家庭口粮压缩到 N 天，制造每日零售需求。
  trimHouseholdFood: {
    desc: "把家庭口粮压缩到每人 {days} 天",
    run: (sim, state, a) => {
      const days = Math.max(0, Number(a.days ?? 3));
      const { householdList: list, householdPopulation: pop, syncResidentAggregates: sync } = householdModule;
      const perPersonUnits = days * CONTENT.rules.foodPerPersonDay * CONTENT.precision.inventoryUnitsPerJin;
      for (const household of list(state)) household.inventory.wheat = Math.round(pop(household) * perPersonUnits);
      sync(state, CONTENT);
      return { ok: true, days };
    },
  },
  // 场景辅助（仅模拟用）：把镇库某商品投放进批发市场，用于验证"市场有货即可销售回款"。
  seedWholesaleStock: {
    desc: "镇库商品投放批发市场 {itemId, quantityJin}",
    run: (sim, state, a) => {
      const qty = Number(a.quantityJin);
      if (!CONTENT.items[a.itemId] || !Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "参数无效" };
      const units = Math.round(qty * CONTENT.precision.inventoryUnitsPerJin);
      state.accounts.town[a.itemId] = (state.accounts.town[a.itemId] || 0) + units;
      return sim.releaseWholesale(state, a.itemId, qty);
    },
  },
  // 场景辅助（仅模拟用）：给全体居民发放粮券（制造消费能力）。
  grantResidentVouchers: {
    desc: "给居民发放粮券 {amountVoucher}",
    run: (sim, state, a) => {
      const units = Math.round(Number(a.amountVoucher) * CONTENT.precision.currencyUnitsPerVoucher);
      if (!Number.isSafeInteger(units) || units <= 0) return { ok: false, reason: "数量无效" };
      const issued = sim.issueGrainVouchers(state, "town", Number(a.amountVoucher));
      if (!issued.ok) return issued;
      const { transferVouchers } = currencyModule;
      return transferVouchers(state, "town", "residents", units, CONTENT, "scenario_income", "场景：居民收入");
    },
  },
  // 场景辅助（仅模拟用）：抽干全体家庭的存粮（保留粮券），迫使居民每日向商店购买主食，
  // 用来验证"居民零售 → 综合商店进货 → 批发市场销售回款 → 市场发镇营工资"这条完整链路。
  drainAllHouseholdFood: {
    desc: "抽干全体家庭存粮 {}（仅模拟用）",
    run: (sim, state) => {
      const { householdList: list } = householdModule;
      let drained = 0;
      for (const household of list(state)) {
        household.inventory = {};
        drained += 1;
      }
      return { ok: true, drained };
    },
  },
  // ---- 调试类（仅模拟用）：制造缺粮家庭，验证邻里互助/救济 ----
  drainHouseholdFood: {
    desc: "抽干 N 个最穷家庭的存粮与粮券 {count}（制造邻里互助受助方）",
    run: (sim, state, a) => {
      const n = Math.max(1, Math.floor(Number(a.count) || 5));
      const rows = householdList(state)
        .map((h) => ({ h, food: householdFoodQeqUnits(state, h, CONTENT) }))
        .sort((x, y) => x.food - y.food)
        .slice(0, n);
      for (const { h } of rows) {
        h.inventory = {};
        h.voucherUnits = 0;
      }
      return { ok: true, drained: rows.length };
    },
  },
};

// ---------------------------------------------------------------- 指标注册表
// 指标名全局稳定：跨场景、跨版本可比。新增指标只追加，不改名、不改口径。
function gini(values) {
  const xs = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return 0;
  const total = xs.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let cum = 0, acc = 0;
  for (const x of xs) { cum += x; acc += cum; }
  return Math.max(0, Math.min(1, (2 * acc) / (n * total) - (n + 1) / n));
}

const METRICS = [
  { key: "year", compute: (ctx) => ctx.year },
  { key: "population_total", compute: (ctx) => ctx.pop.total },
  { key: "population_children", compute: (ctx) => ctx.pop.children },
  { key: "population_workers", compute: (ctx) => ctx.pop.workers },
  { key: "population_elders", compute: (ctx) => ctx.pop.elders },
  { key: "births", compute: (ctx) => ctx.report?.births || 0 },
  { key: "deaths", compute: (ctx) => ctx.report?.deaths || 0 },
  { key: "town_balance_jin", compute: (ctx) => round2(ctx.sim.accountQeq(ctx.state, "town")) },
  { key: "residents_balance_jin", compute: (ctx) => round2(ctx.sim.accountQeq(ctx.state, "residents")) },
  {
    key: "unemployment_rate",
    compute: (ctx) => {
      const employed = ctx.jobRows.reduce((a, r) => a + (r.count || 0), 0);
      const labor = ctx.pop.workers;
      return labor > 0 ? round2(Math.max(0, labor - employed) / labor) : 0;
    },
  },
  {
    key: "gini_household_vouchers",
    compute: (ctx) => round2(gini(householdList(ctx.state).map((h) => h.voucherUnits || 0))),
  },
  // 注意：yearTotals.wagePaidQeq / unemploymentPaidQeq 在源码中从未被累加（恒为 0），
  // 工资与失业金的真实口径在 state.payroll.year（年报 payroll 段），与 panel-ledger 一致。
  { key: "wage_paid_jin", compute: (ctx) => round2(voucherToJin(ctx.report?.payroll?.paidVoucherUnits)) },
  { key: "wage_arrears_jin", compute: (ctx) => round2(voucherToJin(ctx.report?.payroll?.unpaidVoucherUnits)) },
  { key: "unemployment_paid_jin", compute: (ctx) => round2(voucherToJin(ctx.report?.payroll?.unemploymentPaidVoucherUnits)) },
  { key: "consumption_jin", compute: (ctx) => round2(qeqToJin(ctx.report?.consumptionQeq)) },
  { key: "harvest_jin", compute: (ctx) => round2(qeqToJin(ctx.report?.harvestQeq)) },
  {
    key: "agriculture_tax_jin",
    compute: (ctx) => round2(
      (ctx.report?.agricultureTax || []).reduce((a, r) => a + (r.townUnits || 0), 0) / INV_JIN
    ),
  },
  { key: "satisfaction", compute: (ctx) => round2(ctx.state.satisfaction) },
  // 动态劳动力市场（用户 0.1.11）
  {
    key: "labor_unemployment_rate",
    compute: (ctx) => round2(computeLaborMarket(ctx.state, CONTENT).unemploymentRate),
  },
  {
    key: "labor_mood",
    compute: (ctx) => computeLaborMarket(ctx.state, CONTENT).mood,
  },
  {
    key: "labor_reference_wage",
    compute: (ctx) => round2(computeLaborMarket(ctx.state, CONTENT).referenceWage),
  },
  {
    key: "labor_target_shop_wage",
    compute: (ctx) => round2(computeLaborMarket(ctx.state, CONTENT).targetShopWage),
  },
  {
    key: "labor_poach_year",
    compute: (ctx) => ctx.state.laborCompetition?.year?.moves || 0,
  },
  {
    key: "wealth_poor10_per_capita",
    compute: (ctx) => round2(computeWealthStats(ctx.state, CONTENT)?.poorWealthPerCapita),
  },
  {
    key: "wealth_rich10_per_capita",
    compute: (ctx) => round2(computeWealthStats(ctx.state, CONTENT)?.richWealthPerCapita),
  },
  {
    key: "wealth_rich10_share_pct",
    compute: (ctx) => round2(computeWealthStats(ctx.state, CONTENT)?.richWealthSharePercent),
  },
  // 别墅
  {
    key: "villa_sold",
    compute: (ctx) => (ctx.state.villas?.sold || []).length,
  },
  {
    key: "villa_revenue_jin",
    compute: (ctx) => round2(voucherToJin(ctx.state.villas?.stats?.revenueValueUnits || 0)),
  },
  {
    key: "villa_tax_jin",
    compute: (ctx) => round2(voucherToJin(ctx.state.villas?.stats?.taxCollectedValueUnits || 0)),
  },
  {
    key: "top10_household_assets_jin",
    compute: (ctx) => {
      const scale = CONTENT.precision.currencyUnitsPerVoucher;
      const invScale = CONTENT.precision.inventoryUnitsPerJin;
      const assets = householdList(ctx.state).map((h) => {
        let v = h.voucherUnits || 0;
        for (const [itemId, units] of Object.entries(h.inventory || {})) {
          const price = CONTENT.rules.marketPricesVoucherPerUnit?.[itemId] ?? 0;
          v += Math.round((units / invScale) * price * scale);
        }
        for (const villa of h.villaAssets || []) v += Math.max(0, Number(villa.priceValueUnits) || 0);
        return v / scale;
      }).sort((a, b) => b - a);
      return round2(assets.slice(0, 10).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(10, assets.length)));
    },
  },
  // 工资调控
  {
    key: "wage_control_civil",
    compute: (ctx) => ctx.state.policy?.wageControl?.civil ?? 1,
  },
  {
    key: "wage_control_industry",
    compute: (ctx) => ctx.state.policy?.wageControl?.industry ?? 1,
  },
  // 社保基金
  {
    key: "social_fund_jin",
    compute: (ctx) => round2(((ctx.state.socialSecurity?.cashVoucherUnits || 0) + (ctx.state.socialSecurity?.cashWheatUnits || 0)) / CONTENT.precision.currencyUnitsPerVoucher),
  },
  {
    key: "social_collected_jin",
    compute: (ctx) => round2((ctx.state.socialSecurity?.totalCollectedUnits || 0) / CONTENT.precision.currencyUnitsPerVoucher),
  },
  {
    key: "social_paid_jin",
    compute: (ctx) => round2((ctx.state.socialSecurity?.totalPaidUnits || 0) / CONTENT.precision.currencyUnitsPerVoucher),
  },
  {
    key: "social_injected_jin",
    compute: (ctx) => round2((ctx.state.socialSecurity?.totalInjectedUnits || 0) / CONTENT.precision.currencyUnitsPerVoucher),
  },
  // 外贸·四地主镇
  {
    key: "outside_wheat_stock_jin",
    compute: (ctx) => round2(ctx.state.outsideTown?.wheatStockJin || 0),
  },
  {
    key: "outside_prosperity",
    compute: (ctx) => round2(ctx.state.outsideTown?.prosperity ?? 0),
  },
  {
    key: "outside_population",
    compute: (ctx) => Math.round(ctx.state.outsideTown?.population || 0),
  },
  {
    key: "outside_buy_salt",
    compute: (ctx) => round2(ctx.state.outsideTown?.buyPrices?.salt ?? 0),
  },
  {
    key: "outside_buy_wheat",
    compute: (ctx) => round2(ctx.state.outsideTown?.buyPrices?.wheat ?? 0),
  },
  {
    key: "outside_sell_wheat",
    compute: (ctx) => round2(ctx.state.outsideTown?.sellPrices?.wheat ?? 0),
  },
  {
    key: "trade_export_jin",
    compute: (ctx) => round2(ctx.state.outsideTown?.stats?.exportJin || 0),
  },
  {
    key: "trade_import_jin",
    compute: (ctx) => round2(ctx.state.outsideTown?.stats?.importJin || 0),
  },
  {
    key: "trade_tariff_jin",
    compute: (ctx) => round2(ctx.state.outsideTown?.stats?.tariffJin || 0),
  },
  {
    key: "trade_count",
    compute: (ctx) => ctx.state.outsideTown?.stats?.trades || 0,
  },
  // 邻里互助（用户 0.1.11；用累计口径，年桶在跨年结算时已清零）
  {
    key: "neighbor_aid_jin",
    compute: (ctx) => round2(qeqToJin(ctx.state.neighborAid?.cumulative?.movedQeqUnits || 0)),
  },
  {
    key: "neighbor_aid_helped",
    compute: (ctx) => ctx.state.neighborAid?.cumulative?.helpedHouseholds || 0,
  },
  {
    key: "neighbor_aid_needy_today",
    compute: (ctx) => ctx.state.neighborAid?.lastDay?.needyHouseholds || 0,
  },
  // ---- 0.2.3 流通改革：批发市场做市商 ----
  {
    key: "monetary_stage",
    compute: (ctx) => ctx.state.monetaryReform?.stage || "wheat",
  },
  {
    key: "wholesale_purchase_flour",
    compute: (ctx) => {
      const market = ctx.state.wholesaleMarket || {};
      const reference = Number(market.purchasePriceReferenceVoucherPerUnit?.flour || 0);
      const stock = Number(market.inventory?.flour || 0);
      const target = Math.max(1, (CONTENT.rules.wholesalePurchasePriceReferenceJin || 2000) * CONTENT.precision.inventoryUnitsPerJin);
      const elasticity = Number(CONTENT.rules.wholesalePurchasePriceElasticity ?? 1);
      const ratio = Math.max(0, stock / target - 1);
      const feedback = 1 / (1 + elasticity * ratio);
      return round2(reference * Math.max(0.25, feedback));
    },
  },
  {
    key: "wholesale_purchase_wood",
    compute: (ctx) => {
      const market = ctx.state.wholesaleMarket || {};
      const reference = Number(market.purchasePriceReferenceVoucherPerUnit?.wood || 0);
      const stock = Number(market.inventory?.wood || 0);
      const target = Math.max(1, (CONTENT.rules.wholesalePurchasePriceReferenceJin || 2000) * CONTENT.precision.inventoryUnitsPerJin);
      const elasticity = Number(CONTENT.rules.wholesalePurchasePriceElasticity ?? 1);
      const ratio = Math.max(0, stock / target - 1);
      const feedback = 1 / (1 + elasticity * ratio);
      return round2(reference * Math.max(0.25, feedback));
    },
  },
  {
    key: "wholesale_inventory_flour_jin",
    compute: (ctx) => round2((ctx.state.wholesaleMarket?.inventory?.flour || 0) / CONTENT.precision.inventoryUnitsPerJin),
  },
  // ---- 0.2.3 流通改革：镇营统购统销 ----
  {
    key: "wholesale_sales_jin",
    compute: (ctx) => round2((ctx.state.wholesaleMarket?.cumulative?.salesVoucherUnits || 0) / CONTENT.precision.currencyUnitsPerVoucher),
  },
  {
    key: "wholesale_purchases_jin",
    compute: (ctx) => round2((ctx.state.wholesaleMarket?.cumulative?.purchaseVoucherUnits || 0) / CONTENT.precision.currencyUnitsPerVoucher),
  },
  {
    key: "wholesale_value_sales_jin",
    compute: (ctx) => round2((ctx.state.wholesaleMarket?.valueFlow?.cumulative?.sales || 0) / CONTENT.precision.currencyUnitsPerVoucher),
  },
  {
    key: "wholesale_value_purchases_jin",
    compute: (ctx) => round2((ctx.state.wholesaleMarket?.valueFlow?.cumulative?.purchases || 0) / CONTENT.precision.currencyUnitsPerVoucher),
  },
  {
    // 现金流是否长期失血：最近一年净现金流（销售 − 收购 − 工资，价值口径）。
    key: "wholesale_year_net_jin",
    compute: (ctx) => {
      const flow = ctx.state.wholesaleMarket?.valueFlow?.year || {};
      const net = (flow.sales || 0) - (flow.purchases || 0) - (flow.wages || 0);
      return round2(net / CONTENT.precision.currencyUnitsPerVoucher);
    },
  },
  {
    // 欠薪按岗位键拆分，便于定位是哪一类岗位（镇营建筑 / 营造 / 公职）在累积。
    key: "wage_arrears_keys",
    compute: (ctx) => Object.entries(ctx.state.payroll?.arrearsVoucherUnits || {})
      .filter(([, v]) => (v || 0) > 0)
      .map(([k, v]) => `${k}=${Math.round(v / CONTENT.precision.currencyUnitsPerVoucher)}`)
      .sort()
      .join(";"),
  },
  {
    key: "town_wage_arrears_jin",
    compute: (ctx) => round2((ctx.state.payroll?.arrearsVoucherUnits
      ? Object.values(ctx.state.payroll.arrearsVoucherUnits).reduce((a, b) => a + (b || 0), 0) : 0) / CONTENT.precision.currencyUnitsPerVoucher),
  },
  // ---- 0.2.3 流通改革：综合商店动态加价 ----
  {
    key: "shop_avg_target_margin",
    compute: (ctx) => {
      const shops = Object.values(ctx.state.shops || {}).filter(s => s.typeId === "general" && s.status !== "closed");
      if (!shops.length) return 0;
      const total = shops.reduce((sum, s) => sum + Number(s.pricing?.targetMarginPercent ?? CONTENT.rules.generalStoreMarkupPercent ?? 20), 0);
      return round2(total / shops.length);
    },
  },
  {
    key: "shop_promotion_count",
    compute: (ctx) => Object.values(ctx.state.shops || {}).filter(s => s.pricing?.promotion).length,
  },
  {
    key: "shop_bread_retail",
    compute: (ctx) => {
      const shop = Object.values(ctx.state.shops || {}).find(s => s.typeId === "general" && s.status !== "closed");
      if (!shop) return 0;
      return round2(shopTradePrices(ctx.state, shop.typeId, CONTENT, "bread", shop)?.retailVoucherPerUnit || 0);
    },
  },
  {
    key: "shop_open_count",
    compute: (ctx) => Object.values(ctx.state.shops || {}).filter(s => s.typeId === "general" && s.status === "open").length,
  },
  {
    // 综合商店总数（含暂停/清算），用于观察定价设置是否生效。
    key: "shop_general_count",
    compute: (ctx) => Object.values(ctx.state.shops || {}).filter(s => s.typeId === "general" && s.status !== "closed").length,
  },
  {
    // 全部综合商店本年零售额（粮券），用于判断零售需求是否真实存在。
    key: "shop_year_revenue_jin",
    compute: (ctx) => {
      const total = Object.values(ctx.state.shops || {})
        .filter(s => s.typeId === "general")
        .reduce((sum, s) => sum + (s.accounts?.year?.revenueVoucherUnits || 0), 0);
      return round2(total / CONTENT.precision.currencyUnitsPerVoucher);
    },
  },
  {
    key: "shop_bread_margin_pct",
    compute: (ctx) => {
      const shop = Object.values(ctx.state.shops || {}).find(s => s.typeId === "general" && s.status !== "closed");
      const pricing = shop?.pricing;
      if (!pricing) return 0;
      const revenue = pricing.itemRevenue?.bread || 0;
      if (revenue <= 0) return 0;
      const cogs = pricing.itemCogs?.bread || 0;
      const wage = pricing.itemWageCost?.bread || 0;
      return round2((revenue - cogs - wage) / revenue * 100);
    },
  },
  {
    // 工资—物价螺旋监测：零售面包价（动态加价结果）
    key: "spiral_bread_retail_price",
    compute: (ctx) => {
      const shop = Object.values(ctx.state.shops || {}).find(s => s.typeId === "general" && s.status !== "closed");
      if (!shop) return 0;
      return round2(shopTradePrices(ctx.state, shop.typeId, CONTENT, "bread", shop)?.retailVoucherPerUnit || 0);
    },
  },
  {
    // 工资—物价螺旋监测：综合商店店员日薪
    key: "spiral_clerk_wage",
    compute: (ctx) => {
      const shop = Object.values(ctx.state.shops || {}).find(s => s.typeId === "general" && s.status !== "closed");
      return shop ? round2(shop.clerkWageVoucher || 0) : 0;
    },
  },
  {
    // 工资—物价螺旋监测：批发市场面包售价（成本端）
    key: "spiral_wholesale_bread_price",
    compute: (ctx) => round2(ctx.state.wholesaleMarket?.pricesVoucherPerUnit?.bread || 0),
  },
];

// ---------------------------------------------------------------- 主流程
function fail(message) {
  console.error("simulate 失败：" + message);
  process.exit(1);
}

const argv = process.argv.slice(2);
// 取第一个非选项参数为场景路径（跳过 --out/--format 的值）
let scenarioPath = null;
{
  const skipNext = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (skipNext.has(i)) continue;
    const a = argv[i];
    if ((a === "--out" || a === "--format") && argv[i + 1]) { skipNext.add(i + 1); continue; }
    if (!a.startsWith("--") && scenarioPath === null) scenarioPath = a;
  }
}
if (!scenarioPath) fail("用法: node scripts/simulate.mjs <场景.json> [--out <路径>] [--format csv|json]");
let outPath = null;
let format = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out" && argv[i + 1]) outPath = path.resolve(argv[++i]);
  else if (argv[i] === "--format" && argv[i + 1]) format = argv[++i];
}
if (!format) format = outPath && outPath.endsWith(".json") ? "json" : "csv";
if (!["csv", "json"].includes(format)) fail("format 须为 csv 或 json");

let scenario;
try {
  scenario = JSON.parse(await readFile(path.resolve(scenarioPath), "utf8"));
} catch (e) {
  fail(`场景文件读取/解析失败：${e.message}`);
}
const seed = scenario.seed ?? 1;
const years = Number(scenario.years ?? 10);
const daysPerYear = Number(scenario.daysPerYear ?? CONTENT.rules.daysPerYear);
if (!Number.isInteger(years) || years < 1 || years > 200) fail("years 须为 1—200 的整数");
if (!Number.isInteger(daysPerYear) || daysPerYear < 1) fail("daysPerYear 须为正整数");

const metricKeys = scenario.metrics || METRICS.map((m) => m.key);
for (const k of metricKeys) {
  if (!METRICS.some((m) => m.key === k)) fail(`未知指标：${k}（可用：${METRICS.map((m) => m.key).join(", ")}）`);
}
const script = scenario.script || [];
for (const step of script) {
  if (!ACTIONS[step.action]) fail(`未知动作：${step.action}（可用：${Object.keys(ACTIONS).join(", ")}）`);
  if (!Number.isInteger(step.year) || step.year < 1 || step.year > years) {
    fail(`动作 ${step.action} 的 year 须为 1—${years} 的整数`);
  }
}
const scriptByYear = new Map();
for (const step of script) {
  if (!scriptByYear.has(step.year)) scriptByYear.set(step.year, []);
  scriptByYear.get(step.year).push(step);
}

const sim = createSimulation(CONTENT);
const state = sim.createInitialState({ seed });
const events = [];
const rows = [];
const t0 = Date.now();
for (let year = 1; year <= years; year++) {
  for (const step of scriptByYear.get(year) || []) {
    let result;
    try {
      result = ACTIONS[step.action].run(sim, state, step.args || {});
    } catch (e) {
      result = { ok: false, reason: "异常：" + (e.message || e) };
    }
    const ev = { year, action: step.action, args: step.args || {}, ok: Boolean(result && result.ok) };
    if (!ev.ok) ev.reason = (result && result.reason) || "未知原因";
    events.push(ev);
    console.error(`[年 ${year}] ${step.action} ${JSON.stringify(step.args || {})} -> ${ev.ok ? "ok" : "失败：" + ev.reason}`);
  }
  sim.advanceDays(state, daysPerYear);
  const report = state.annualReports[state.annualReports.length - 1] || null;
  const pop = populationStats(state);
  const jobRows = selectJobRows(state, CONTENT).rows;
  const ctx = { sim, state, year, report, pop, jobRows };
  const row = {};
  for (const m of METRICS) {
    if (metricKeys.includes(m.key)) {
      try { row[m.key] = m.compute(ctx); }
      catch (e) { row[m.key] = null; console.error(`[年 ${year}] 指标 ${m.key} 计算异常：${e.message}`); }
    }
  }
  rows.push(row);
}
const elapsedSec = Math.round((Date.now() - t0) / 100) / 10;

const check = sim.validateState(state);
const result = {
  meta: {
    name: scenario.name || path.basename(scenarioPath, ".json"),
    seed, years, daysPerYear,
    appVersion: APP_VERSION,
    elapsedSec,
    stateValid: Boolean(check.valid),
    stateErrors: check.valid ? [] : (check.errors || []).slice(0, 10),
    actions: Object.keys(ACTIONS),
    metrics: metricKeys,
    generatedAt: new Date().toISOString(),
  },
  events,
  rows,
};

let output;
if (format === "json") {
  output = JSON.stringify(result, null, 2) + "\n";
} else {
  const header = metricKeys.join(",");
  const lines = rows.map((r) => metricKeys.map((k) => (r[k] === null || r[k] === undefined ? "" : r[k])).join(","));
  output = header + "\n" + lines.join("\n") + "\n";
}
if (outPath) {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, output, "utf8");
  console.error(`模拟完成：${years} 年（${elapsedSec}s），结果已写入 ${outPath}`);
} else {
  process.stdout.write(output);
}
if (!check.valid) {
  console.error("警告：最终状态 validateState 未通过：" + (check.errors || []).slice(0, 5).join("；"));
  process.exit(2);
}
