// 煤矿、铁矿与冶炼厂（金银消费第一期 A）：矿产日产、需求闸门、冶炼产能分配、民营与公司路径、
// 银条金条改批发品（贸易行不做、手动外贸入批发市场、旧档转入）、标准开局与旧档地块。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { processBuilding } from "../src/systems/production.js";
import { processPrivateBuilding } from "../src/systems/private-industry.js";
import { processListedCompany } from "../src/systems/companies.js";
import { setJobCount, householdList, householdIdleWorkers } from "../src/systems/households.js";
import { townOutputTargetUnits, depositWholesalePurchasedInventory, ensureWholesaleMarket, wholesaleMonopolyItemIds } from "../src/systems/wholesale-market.js";
import { flexAllocate, flexPlan, flexRoomUnits } from "../src/systems/flex-recipe.js";
import { laborBatches, productivityFactor } from "../src/economy/productivity.js";
import { productionStatus } from "../src/selectors/production.js";
import { listedJobKeyForBuilding } from "../src/selectors/labor.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { signTradeAgreement } from "../src/systems/trade-agreements.js";
import { ensureOutsideTowns, tradeWithOutsideTown } from "../src/systems/outside-town.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { formCompany } from "./helpers-ipo.js";
import { grantResidentVouchers } from "./helpers-v16.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;
const PRODUCTS = ["iron_farm_tool", "iron_tool", "gold_jewelry", "silver_jewelry"];

function valid(state, label = "") {
  const v = simulation.validateState(state);
  assert.equal(v.valid, true, `${label} ${v.errors.join("；")}`);
}

// 批发市场（2 人）+ 一座指定类型的建筑（可指定矿点特征、等级、人数）。
function world(seed, { typeId = "coal_mine", feature = null, level = 1, workers = 10, role = null } = {}) {
  const state = simulation.createInitialState({ seed });
  const used = new Set(state.buildings.map(b => b.plotId));
  const plotFor = f => state.plots.find(p => (f ? p.feature === f : !p.feature) && !used.has(p.id));
  const add = (type, lvl, id, plot) => {
    used.add(plot.id);
    state.buildings.push({ id, typeId: type, level: lvl, ownership: { townLevels: lvl, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
    return id;
  };
  add("wholesale_market", 1, "mkt", plotFor(null));
  simulation.setEmployment(state, `mkt::${CONTENT.buildings.wholesale_market.jobs[0].id}`, 2);
  const id = add(typeId, level, "prod", plotFor(feature || CONTENT.buildings[typeId].requiredPlotFeature || null));
  const jobId = role || CONTENT.buildings[typeId].productionRoleId;
  simulation.setEmployment(state, `${id}::${jobId}`, workers);
  return { state, id };
}

const bld = (state, id) => state.buildings.find(b => b.id === id);
const marketOf = state => ensureWholesaleMarket(state, CONTENT);

// ---------------------------------------------------------------- 矿产

test("煤矿、铁矿：1 级无加成时人均日产 10 斤；矿点与标准开局的配置", () => {
  for (const [typeId, itemId, feature] of [["coal_mine", "coal", "coal_mine"], ["iron_mine", "iron_ore", "iron_mine"]]) {
    const { state, id } = world(9501, { typeId, workers: 10 });
    const r = processBuilding(state, bld(state, id), CONTENT);
    assert.equal(r.status, "ready", typeId);
    assert.equal(r.batches, 10, `${typeId} 10 人一批一人 = 10 批`);
    assert.equal(state.accounts.town[itemId], 100 * I, `${typeId} 产出 100 斤（10 人 × 10 斤）`);
    assert.equal(CONTENT.buildings[typeId].maxInstances, 6);
    assert.equal(CONTENT.buildings[typeId].upgrade.maxLevel, 10, "煤矿、铁矿最高 10 级");
    assert.equal(CONTENT.buildings[typeId].jobs[0].slots, 10, "每级 10 个矿工岗位");
    assert.equal(CONTENT.buildings[typeId].jobs[0].wagePerWorkerDay, 5);
    assert.equal(CONTENT.buildings[typeId].industryTier, 0);
    assert.equal(state.plots.filter(p => p.feature === feature).length, 3, "至少 3 块矿点");
    valid(state, typeId);
  }
});

test("矿产：等级、熟练度、教育加成乘进产量（与产业同一 productivityFactor）", () => {
  const base = world(9502, { typeId: "coal_mine", level: 3, workers: 10 });
  const expected = laborBatches(base.state, "coal_mine", 3, 10, 1, 0).batches;
  assert.equal(expected, Math.floor(10 * productivityFactor(base.state, "coal_mine", 3)), "3 级约 ×1.2");
  assert.equal(processBuilding(base.state, bld(base.state, base.id), CONTENT).batches, expected);
  // 熟练度（工日累计）与教育加成都会抬高产量。
  const exp = world(9503, { typeId: "coal_mine", workers: 10 });
  exp.state.industryExperience.coal_mine = 60000;
  assert.ok(processBuilding(exp.state, bld(exp.state, exp.id), CONTENT).batches > 10, "熟练度加成");
  const edu = world(9504, { typeId: "iron_mine", workers: 10 });
  edu.state.education = { ...(edu.state.education || {}), schoolDays: 360 * 30 };
  assert.ok(processBuilding(edu.state, bld(edu.state, edu.id), CONTENT).batches > 10, "教育加成");
});

test("矿产需求闸门：批发市场存够 360 天需求（目标库存）时停产，不产出", () => {
  const { state, id } = world(9505, { typeId: "coal_mine", workers: 10 });
  marketOf(state).inventory.coal = Math.round(townOutputTargetUnits(state, "coal", CONTENT));
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.equal(r.batches, 0);
  assert.equal(r.status, "market_capped");
  assert.equal(state.accounts.town.coal || 0, 0, "没有产出");
  valid(state, "需求闸门");
});

// ---------------------------------------------------------------- 冶炼厂

test("冶炼厂：8 人（80 产能点）按四种产品的缺口分配；产出与投入扣减正确", () => {
  const { state, id } = world(9510, { typeId: "smelter", workers: 8 });
  const m = marketOf(state);
  m.inventory.iron_ore = 5000 * I; m.inventory.coal = 5000 * I; m.inventory.gold_bar = 2 * I; m.inventory.silver_bar = 20 * I;
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.equal(r.status, "ready");
  assert.equal(r.batches, 8, "80 点 ÷ 10 点每批");
  // 缺口（件）相同（目标 200 件）时，缺口按产能点计：农具 800 点、工具 400 点、金、银各 200 点，占比 4:2:1:1。
  // 80 点分配：农具 40 点（10 件）、工具 20 点（10 件）、金、银各 10 点（10 件）。
  for (const itemId of PRODUCTS) assert.equal(state.accounts.town[itemId], 10 * I, `${itemId} 10 件`);
  // 投入：铁矿石 10 × 10 + 4 × 10 = 140 斤；煤 5 × 10 + 2 × 10 + 0.2 × 20 = 74 斤；金条、银条各 0.1 斤。
  assert.equal(m.inventory.iron_ore, 5000 * I - 140 * I);
  assert.equal(m.inventory.coal, 5000 * I - 74 * I);
  assert.equal(m.inventory.gold_bar, 2 * I - Math.round(0.1 * I));
  assert.equal(m.inventory.silver_bar, 20 * I - Math.round(0.1 * I));
  assert.equal(state.accounts.town.iron_ore || 0, 0, "领来的矿石全部投料");
  valid(state, "冶炼分配");
});

test("冶炼厂：全部产品缺口为 0 时停产，不领料、不耗料", () => {
  const { state, id } = world(9511, { typeId: "smelter", workers: 8 });
  const m = marketOf(state);
  m.inventory.iron_ore = 5000 * I; m.inventory.coal = 5000 * I; m.inventory.gold_bar = 2 * I; m.inventory.silver_bar = 2 * I;
  for (const itemId of PRODUCTS) m.inventory[itemId] = Math.round(townOutputTargetUnits(state, itemId, CONTENT));
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.equal(r.batches, 0);
  assert.equal(r.status, "market_capped");
  assert.equal(m.inventory.iron_ore, 5000 * I, "矿石没动");
  valid(state, "全满停产");
});

test("冶炼厂：铁矿石不足时只缩用矿石的农具与工具（同比例），金银珠宝不受影响", () => {
  const { state, id } = world(9512, { typeId: "smelter", workers: 8 });
  const m = marketOf(state);
  m.inventory.iron_ore = 70 * I; m.inventory.coal = 5000 * I; m.inventory.gold_bar = 2 * I; m.inventory.silver_bar = 2 * I;
  const r = processBuilding(state, bld(state, id), CONTENT);
  // 满产农具、工具需要 140 斤矿石（每件农具 10 斤、工具 4 斤），只有 70 斤：两者各缩一半（10 件 → 5 件）。
  assert.equal(state.accounts.town.iron_farm_tool, 5 * I, "农具缩到 5 件");
  assert.equal(state.accounts.town.iron_tool, 5 * I, "工具缩到 5 件");
  assert.equal(state.accounts.town.gold_jewelry, 10 * I, "金珠宝不用矿石，照常 10 件");
  assert.equal(state.accounts.town.silver_jewelry, 10 * I, "银珠宝照常 10 件");
  assert.equal(m.inventory.iron_ore, 0, "矿石用到头");
  assert.equal(r.status, "limited_materials");
  valid(state, "缺料缩减");
});

test("冶炼厂：完全没有矿石时，农具、工具停产，产能让给金银珠宝（不整批停工）", () => {
  const { state, id } = world(9513, { typeId: "smelter", workers: 8 });
  const m = marketOf(state);
  m.inventory.coal = 5000 * I; m.inventory.gold_bar = 2 * I; m.inventory.silver_bar = 2 * I;
  const r = processBuilding(state, bld(state, id), CONTENT);
  assert.equal(state.accounts.town.iron_farm_tool || 0, 0);
  assert.equal(state.accounts.town.iron_tool || 0, 0);
  // 80 点全部给金、银珠宝（各 200 点缺口，平分）：各 40 件。
  assert.equal(state.accounts.town.gold_jewelry, 40 * I);
  assert.equal(state.accounts.town.silver_jewelry, 40 * I);
  assert.equal(r.batches, 8);
  valid(state, "无矿石只做珠宝");
});

test("冶炼厂：金银条都没有时，只有珠宝停产，农具、工具照做", () => {
  const { state, id } = world(9514, { typeId: "smelter", workers: 8 });
  const m = marketOf(state);
  m.inventory.iron_ore = 5000 * I; m.inventory.coal = 5000 * I;
  processBuilding(state, bld(state, id), CONTENT);
  assert.equal(state.accounts.town.gold_jewelry || 0, 0, "没有金条，不做金珠宝");
  assert.equal(state.accounts.town.silver_jewelry || 0, 0, "没有银条，不做银珠宝");
  assert.ok((state.accounts.town.iron_farm_tool || 0) > 0 && (state.accounts.town.iron_tool || 0) > 0, "农具、工具照做");
  valid(state, "无金银条");
});

test("冶炼厂：成本账平（市场内部调拨的成本随料转入，产出吸收投入成本，合计不增不减）", () => {
  const { state, id } = world(9515, { typeId: "smelter", workers: 8 });
  const m = marketOf(state);
  depositWholesalePurchasedInventory(state, "iron_ore", 5000 * I, 5000 * I, CONTENT);
  depositWholesalePurchasedInventory(state, "coal", 5000 * I, 5000 * I, CONTENT);
  depositWholesalePurchasedInventory(state, "gold_bar", 2 * I, 2000, CONTENT);
  depositWholesalePurchasedInventory(state, "silver_bar", 20 * I, 2000, CONTENT);
  const total = () => Object.values(state.business.inventoryCostWheatUnits.town).reduce((s, v) => s + (v || 0), 0)
    + Object.values(m.inventoryCostVoucherUnits).reduce((s, v) => s + (v || 0), 0);
  const before = total();
  processBuilding(state, bld(state, id), CONTENT);
  assert.ok(Math.abs(total() - before) <= 50, `成本合计变化 ${total() - before}（只允许取整误差）`);
  valid(state, "成本账平");
});

test("冶炼厂分配：弹性配方的缺口按产能点计（农具 4 点/件、工具 2 点/件、珠宝 1 点/件）", () => {
  const { state } = world(9515, { typeId: "smelter", workers: 8 });
  const recipe = CONTENT.recipes.smelter_work;
  const rooms = flexRoomUnits(state, recipe, CONTENT);
  assert.equal(rooms.iron_farm_tool, Math.round(townOutputTargetUnits(state, "iron_farm_tool", CONTENT)) * 4, "农具缺口 × 4 点");
  assert.equal(rooms.iron_tool, Math.round(townOutputTargetUnits(state, "iron_tool", CONTENT)) * 2, "工具缺口 × 2 点");
  const alloc = flexAllocate({ a: 100, b: 100 }, 60);
  assert.equal(alloc.a + alloc.b, 60);
  const plan = flexPlan(recipe, { iron_farm_tool: 4000, iron_tool: 0, gold_jewelry: 0, silver_jewelry: 0 }, 2000, null, CONTENT);
  assert.equal(plan.units.iron_farm_tool, Math.floor(2000 / 4), "只剩一种产品时全部给它（按件 4 点）");
});

test("冶炼厂经营计划与产能预览：有料有缺口时预览为正在加工，全满为市场饱和", () => {
  const { state, id } = world(9516, { typeId: "smelter", workers: 8 });
  const m = marketOf(state);
  m.inventory.iron_ore = 5000 * I; m.inventory.coal = 5000 * I; m.inventory.gold_bar = 2 * I; m.inventory.silver_bar = 2 * I;
  const status = productionStatus(state, bld(state, id), CONTENT);
  assert.equal(status.label, "正在加工");
  for (const itemId of PRODUCTS) m.inventory[itemId] = Math.round(townOutputTargetUnits(state, itemId, CONTENT));
  const full = productionStatus(state, bld(state, id), CONTENT);
  assert.equal(full.status, "market_capped");
  assert.equal(full.label, "市场积压，减产");
});

test("民营冶炼厂：有业主时按产能缺口分配、从批发市场采购投入、产出进业主家庭，validateState 通过", () => {
  const state = simulation.createInitialState({ seed: 9520 });
  const plots = state.plots.filter(p => !p.feature);
  const hid = Object.keys(state.households.byId)[0];
  state.buildings.push({ id: "mkt-p", typeId: "wholesale_market", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plots[0].id, x: plots[0].x, y: plots[0].y, materialInvestments: [], completed: { year: 1, day: 1 } });
  state.buildings.push({ id: "smelter-p", typeId: "smelter", level: 1, ownership: { townLevels: 0, privateLevels: 1, listedLevels: 0 }, plotId: plots[1].id, x: plots[1].x, y: plots[1].y, materialInvestments: [], completed: { year: 1, day: 1 }, privateOwners: [hid] });
  simulation.setEmployment(state, "mkt-p::" + CONTENT.buildings.wholesale_market.jobs[0].id, 2);
  setJobCount(state, "smelter-p::smelters::private", 8, CONTENT);
  grantResidentVouchers(state, 20000, CONTENT, hid);
  const m = marketOf(state);
  m.inventory.iron_ore = 5000 * I; m.inventory.coal = 5000 * I; m.inventory.gold_bar = 2 * I; m.inventory.silver_bar = 2 * I;
  const oreBefore = m.inventory.iron_ore;
  const r = processPrivateBuilding(state, state.buildings.find(b => b.id === "smelter-p"), CONTENT);
  assert.ok(r.batches > 0, `民营冶炼厂应开工：${r.status} ${r.reason || ""}`);
  assert.ok(m.inventory.iron_ore < oreBefore, "投入从批发市场买");
  const inv = state.households.byId[hid].inventory;
  const made = PRODUCTS.filter(id => (inv[id] || 0) > 0);
  assert.ok(made.length >= 2, `业主家庭应收到多种产品：${made.join("、") || "无"}`);
  valid(state, "民营冶炼厂");
});

test("公司冶炼厂：按缺口买料（付钱进公司库存）、按产能分配产出，validateState 通过", () => {
  const state = simulation.createInitialState({ seed: 9521 });
  const plots = state.plots.filter(p => !p.feature);
  state.buildings.push({ id: "mkt-c", typeId: "wholesale_market", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plots[0].id, x: plots[0].x, y: plots[0].y, materialInvestments: [], completed: { year: 1, day: 1 } });
  state.buildings.push({ id: "smelter-c", typeId: "smelter", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plots[1].id, x: plots[1].x, y: plots[1].y, materialInvestments: [], completed: { year: 1, day: 1 } });
  simulation.setEmployment(state, "mkt-c::" + CONTENT.buildings.wholesale_market.jobs[0].id, 2);
  const formed = formCompany(state, "smelter-c", { name: "冶炼公司", levels: 1, operatingCapitalVoucher: 20000, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  const company = state.companies[formed.companyId];
  setJobCount(state, listedJobKeyForBuilding("smelter-c", "smelters"), 8, CONTENT);
  const m = marketOf(state);
  m.inventory.iron_ore = 5000 * I; m.inventory.coal = 5000 * I; m.inventory.gold_bar = 2 * I; m.inventory.silver_bar = 2 * I;
  const r = processListedCompany(state, company, CONTENT);
  assert.ok(r.batches > 0, `公司冶炼厂应开工：${r.status}`);
  assert.equal(company.inventory.iron_ore || 0, 0, "领到的矿石全部投料");
  const made = PRODUCTS.filter(id => (company.inventory[id] || 0) > 0);
  assert.ok(made.length >= 2, `公司应产出多种产品：${made.join("、") || "无"}`);
  valid(state, "公司冶炼厂");
});

// ---------------------------------------------------------------- 银条金条改批发品

test("银条、金条：批发品（不上货架），售价 1100 / 11000，收购价 880 / 8800；贸易行与长协不做", () => {
  for (const itemId of ["silver_bar", "gold_bar"]) {
    const item = CONTENT.items[itemId];
    assert.equal(item.wholesale, true, itemId);
    assert.ok(!item.retail && !item.storeOnly, `${itemId} 不上货架`);
    assert.equal(item.tradeHouseExcluded, true, `${itemId} 贸易行不交易`);
  }
  assert.ok(wholesaleMonopolyItemIds(CONTENT).includes("silver_bar"));
  const state = simulation.createInitialState({ seed: 9530 });
  const m = ensureWholesaleMarket(state, CONTENT);
  assert.equal(m.pricesVoucherPerUnit.silver_bar, 1100);
  assert.equal(m.pricesVoucherPerUnit.gold_bar, 11000);
  assert.equal(m.purchasePricesVoucherPerUnit.silver_bar, 880);
  assert.equal(m.purchasePricesVoucherPerUnit.gold_bar, 8800);
});

// 外贸房在岗、批发市场、民镇一镇（与 trade-margin-floor 的夹具同口径）。
function tradeFixture(seed) {
  const state = simulation.createInitialState({ seed });
  const used = new Set(state.buildings.map(row => row.plotId));
  const free = () => { const p = state.plots.find(row => !row.feature && !used.has(row.id)); used.add(p.id); return p; };
  const add = (id, typeId) => { const p = free(); state.buildings.push({ id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: p.id, x: p.x, y: p.y, materialInvestments: [], completed: { year: 1, day: 1 } }); };
  add("ftrade", "foreign_trade_house");
  add("wm1", "wholesale_market");
  add("tc1", "trade_center");
  simulation.setEmployment(state, "ftrade::trade_staff", 8);
  simulation.setEmployment(state, "wm1::wholesale_workers", 3);
  grantResidentVouchers(state, 300000);
  issueTownVouchers(state, 50000 * V, CONTENT, "测试：镇库付货款");
  state.wholesaleMarket.inventory.salt = 5000 * I;
  state.logistics.poolJin = 300;
  const owner = householdList(state).find(h => householdIdleWorkers(h) > 0);
  assert.equal(grantResidentVouchers(state, 5000, CONTENT, owner.id).ok, true);
  const opened = simulation.openResidentShop(state, "tc1", "trading_house", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  simulation.configureShopClerks(state, opened.shopId, 10);
  transferVouchers(state, "town", `shop:${opened.shopId}`, 20000 * V, CONTENT, "test", "测试：贸易行周转金");
  ensureOutsideTowns(state, CONTENT).wangzhen.tradeClosed = true;
  return { state, shop: state.shops[opened.shopId] };
}

test("贸易行：银条金条即使批发市场有货、外镇有需求也不做买卖（盐照做，作对照）", () => {
  const { state, shop } = tradeFixture(9531);
  const m = marketOf(state);
  m.inventory.silver_bar = 500 * I;
  m.inventory.gold_bar = 50 * I;
  for (let d = 0; d < 4; d += 1) simulation.advanceDay(state);
  const rows = shop.tradeLog || [];
  const traded = rows.some(row => (row.exportJin?.salt || 0) > 0 || (row.importJin?.salt || 0) > 0);
  assert.ok(traded, "对照：贸易行应做盐的买卖");
  for (const row of rows) {
    assert.equal(row.exportJin?.silver_bar || 0, 0);
    assert.equal(row.importJin?.silver_bar || 0, 0);
    assert.equal(row.exportJin?.gold_bar || 0, 0);
    assert.equal(row.importJin?.gold_bar || 0, 0);
  }
  assert.equal(m.inventory.silver_bar, 500 * I, "市场银条没动");
  valid(state, "贸易行不做银金");
});

test("长期协定：银条（民镇）、金条（王镇）都不能签约", () => {
  const { state } = tradeFixture(9532);
  ensureOutsideTowns(state, CONTENT).wangzhen.tradeClosed = false;
  const cases = [["silver_bar", "minzhen"], ["gold_bar", "wangzhen"]];
  for (const [itemId, townId] of cases) {
    const r = signTradeAgreement(state, { itemId, annualJin: 100, years: 1, content: CONTENT, townId });
    assert.equal(r.ok, false, itemId);
    assert.match(r.reason, /不能签约/, `${itemId}：${r.reason}`);
  }
});

test("手动外贸买入银条：入批发市场库存（成本基础 = 所付小麦），镇库不留存；卖回时从市场出", () => {
  const { state } = tradeFixture(9533);
  const m = marketOf(state);
  const wheatBefore = state.accounts.town.wheat;
  const buy = tradeWithOutsideTown(state, "buy", "silver_bar", 2, CONTENT, "minzhen");
  assert.equal(buy.ok, true, buy.reason);
  assert.equal(m.inventory.silver_bar, Math.round(2 * I), "2 斤银条入批发市场");
  assert.equal(state.accounts.town.silver_bar || 0, 0, "镇库不留存");
  assert.ok(m.inventoryCostVoucherUnits.silver_bar > 0, "成本基础 = 所付小麦");
  assert.ok(Math.abs(m.inventoryCostVoucherUnits.silver_bar - Math.round(buy.valueJin * I)) <= 1, "成本基础 = 所付小麦（库存单位）");
  assert.ok(state.accounts.town.wheat < wheatBefore, "付了小麦");
  const sell = tradeWithOutsideTown(state, "sell", "silver_bar", 1, CONTENT, "minzhen");
  assert.equal(sell.ok, true, sell.reason);
  assert.ok(m.inventory.silver_bar < Math.round(2 * I), "卖回从市场出");
  valid(state, "手动外贸银条");
});

test("旧档：镇库里的银条金条读档时转入批发市场库存；没有批发市场则留在镇库；地块从内容补齐", () => {
  const fresh = simulation.createInitialState({ seed: 9534 });
  const raw = JSON.parse(JSON.stringify(fresh));
  // 老档：没有矿点，镇库有银条金条，有批发市场。
  raw.plots = raw.plots.filter(p => !String(p.feature || "").endsWith("_mine") || p.feature === "salt_mine");
  raw.buildings.push({ id: "mkt-old", typeId: "wholesale_market", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: raw.plots.find(p => !p.feature).id, x: 0, y: 0, materialInvestments: [], completed: { year: 1, day: 1 } });
  raw.accounts.town.silver_bar = 300 * I;
  raw.accounts.town.gold_bar = 4 * I;
  const loaded = migrateSave(raw, CONTENT);
  assert.equal(loaded.accounts.town.silver_bar || 0, 0, "镇库不再留银条");
  assert.equal(loaded.accounts.town.gold_bar || 0, 0);
  assert.equal(loaded.wholesaleMarket.inventory.silver_bar, 300 * I);
  assert.equal(loaded.wholesaleMarket.inventory.gold_bar, 4 * I);
  assert.equal(loaded.plots.filter(p => p.feature === "coal_mine").length, 3, "旧档缺的矿点由内容补齐");
  assert.equal(loaded.plots.filter(p => p.feature === "iron_mine").length, 3);
  valid(loaded, "旧档银金");
  // 没有批发市场：留在镇库。
  const raw2 = JSON.parse(JSON.stringify(fresh));
  raw2.accounts.town.silver_bar = 7 * I;
  const kept = migrateSave(raw2, CONTENT);
  assert.equal(kept.accounts.town.silver_bar, 7 * I, "无市场时留在镇库");
});

// ---------------------------------------------------------------- 标准开局与空白开局

test("标准开局含 1 级煤矿、铁矿（不派工）；空白开局不含", () => {
  const std = simulation.createInitialState({ seed: 9540, opening: "standard" });
  const coal = std.buildings.find(b => b.typeId === "coal_mine");
  const iron = std.buildings.find(b => b.typeId === "iron_mine");
  assert.ok(coal && coal.level === 1 && coal.plotId === "forest-coal-01");
  assert.ok(iron && iron.level === 1 && iron.plotId === "forest-iron-01");
  valid(std, "标准开局");
  const blank = simulation.createInitialState({ seed: 9541 });
  assert.equal(blank.buildings.some(b => b.typeId === "coal_mine" || b.typeId === "iron_mine" || b.typeId === "smelter"), false);
});

test("标准开局推进数日：煤矿、铁矿在不派工时无产出、无报错", () => {
  const state = simulation.createInitialState({ seed: 9542, opening: "standard" });
  for (let d = 0; d < 3; d += 1) simulation.advanceDay(state);
  assert.equal(state.accounts.town.coal || 0, 0);
  assert.equal(state.accounts.town.iron_ore || 0, 0);
  valid(state, "标准开局推进");
});
