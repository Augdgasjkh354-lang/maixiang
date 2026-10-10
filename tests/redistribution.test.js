import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { legacyVoucherState } from "./helpers-monetary.js";
import { issueTownVouchers, validateCurrencyInvariant } from "../src/economy/currency.js";
import { grantResidentVouchers, richestHousehold } from "./helpers-v16.js";
import { formCompany } from "./helpers-ipo.js";
import { SAVE_KEY, exportState, importState } from "../src/persistence/storage.js";
import { settleWealthTax, wealthTaxPerCapitaPerYear, snapshotEstates, settleYearEstates, settleEscheat, giniCoefficient, recordYearGini, householdTaxableWealthUnits, wealthDistributionRows, resetRedistributionYear, topWealthSharePercent } from "../src/systems/redistribution.js";
import { householdWealth } from "../src/systems/wealth-stats.js";
import { householdWealthUnits } from "../src/systems/household-budget.js";
import { householdList, householdPopulation, isActiveHousehold, householdConvertibleWheatUnits, syncResidentAggregates } from "../src/systems/households.js";
import { transferBuildingOwnership, buildingOwner } from "../src/systems/ownership.js";
import { selectInequality } from "../src/selectors/inequality.js";
import { ensureBankState, depositToBank } from "../src/systems/bank.js";
import { DAILY_STEPS } from "../src/systems/daily.js";

const SCALE = CONTENT.precision.currencyUnitsPerVoucher;
const TH = [300, 1000, 3000];

function memoryStorage() {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    key: index => [...store.keys()][index] ?? null,
    get length() { return store.size; }
  };
}

// 把一户的小麦清零（只算粮券与存款的测试用），并保证粮券是正式发行的。
function clearWheat(state, household) {
  household.inventory.wheat = 0;
  syncResidentAggregates(state, CONTENT);
}

// 让其他家户没有可征税的家底，使本测试的合计只来自目标户。
function isolate(state, household) {
  for (const other of householdList(state)) {
    if (other.id === household.id) continue;
    other.voucherUnits = 0;
    other.inventory.wheat = 0;
  }
  syncResidentAggregates(state, CONTENT);
}

function voucherState(seed = 6101) {
  const state = legacyVoucherState({ seed });
  return state;
}

test("日结流水线：富人税、家产归公排在金融之后、翻日之前", () => {
  const ids = DAILY_STEPS.map(step => step.id);
  const at = id => ids.indexOf(id);
  assert.ok(at("wealthTax") > at("finance"));
  assert.ok(at("escheat") > at("finance"));
  assert.ok(at("wealthTax") < at("harvest"));
  assert.ok(at("escheat") < at("harvest"));
});

test("富人税累进：只对超过门槛的部分按该档税率计", () => {
  const rates = [10, 20, 30];
  assert.equal(wealthTaxPerCapitaPerYear(200, TH, rates), 0, "低于第一档门槛免征");
  assert.equal(wealthTaxPerCapitaPerYear(300, TH, rates), 0, "门槛处恰好为零");
  assert.ok(Math.abs(wealthTaxPerCapitaPerYear(500, TH, rates) - 20) < 1e-9, "300—1000 档：(500-300)×10%");
  assert.ok(Math.abs(wealthTaxPerCapitaPerYear(1500, TH, rates) - 170) < 1e-9, "70 + (1500-1000)×20%");
  assert.ok(Math.abs(wealthTaxPerCapitaPerYear(4000, TH, rates) - 770) < 1e-9, "70 + 400 + (4000-3000)×30%");
  assert.equal(wealthTaxPerCapitaPerYear(4000, TH, [0, 0, 0]), 0, "税率为 0 不征");
});

test("富人税按户：应纳 = 人口 × 人均年税 ÷ 12，只从粮券付（粮券足够时全额入镇库）", () => {
  const state = voucherState();
  simulation.setWealthTax(state, { thresholds: TH, ratesPercent: [10, 10, 10] });
  const household = richestHousehold(state);
  clearWheat(state, household);
  isolate(state, household);
  const people = householdPopulation(household);
  assert.equal(grantResidentVouchers(state, 6000, CONTENT, household.id).ok, true);
  const voucherBefore = household.voucherUnits;
  const perCapita = voucherBefore / SCALE / people;
  const expected = Math.floor(people * wealthTaxPerCapitaPerYear(perCapita, TH, [10, 10, 10]) / 12 * SCALE + 1e-9);
  assert.ok(expected > 0, "这户应纳税");
  settleWealthTax(state, CONTENT);
  assert.equal(voucherBefore - household.voucherUnits, expected, "按户应纳 = 人口 × 人均年税 ÷ 12");
  assert.equal(state.redistribution.cumulative.wealthTaxUnits, expected, "只有这一户有应纳额");
});

test("富人税税率为 0 时不收任何钱，但仍记录评估", () => {
  const state = voucherState();
  const household = richestHousehold(state);
  grantResidentVouchers(state, 20000, CONTENT, household.id);
  const before = household.voucherUnits;
  const result = settleWealthTax(state, CONTENT);
  assert.equal(result.collectedUnits, 0);
  assert.equal(result.dueUnits, 0);
  assert.equal(household.voucherUnits, before);
  assert.equal(state.redistribution.cumulative.wealthTaxUnits, 0);
  assert.ok(state.redistribution.lastRun, "lastRun 仍然记录（给面板看税档人家数）");
});

test("富人税每 30 天一次（日序号 % 30 === 0），其他日子不收", () => {
  const state = voucherState();
  simulation.setWealthTax(state, { ratesPercent: [10, 10, 10] });
  grantResidentVouchers(state, 5000, CONTENT, richestHousehold(state).id);
  const runs = [];
  for (let i = 0; i <= 61; i += 1) {
    const before = state.redistribution.lastRun;
    simulation.advanceDay(state);
    const ran = state.redistribution.lastRun !== before;
    runs.push({ serial: i, ran });
  }
  for (const { serial, ran } of runs) assert.equal(ran, serial % 30 === 0, `第 ${serial} 天`);
});

test("富人税付不起的部分当月免征，不卖股票、不动口粮", () => {
  const state = voucherState();
  simulation.setWealthTax(state, { ratesPercent: [20, 20, 20] });
  const household = richestHousehold(state);
  clearWheat(state, household);
  isolate(state, household);
  // 家底全在股票上（粮券为 0）：股票不能拿来付税。
  const { company, companyId } = listedFixture(state, 50);
  company.townShares -= 200; company.residentShares += 200;
  company.householdShares = { [household.id]: 200 };
  household.shares = { [companyId]: 200 };
  household.voucherUnits = 0;
  const shares = household.shares[companyId];
  const result = settleWealthTax(state, CONTENT);
  assert.ok(result.dueUnits > 0, "有应纳额");
  assert.equal(result.collectedUnits, 0, "付不起，实收为 0");
  assert.equal(state.redistribution.year.wealthTaxWaivedUnits, result.dueUnits, "全部免征");
  assert.equal(household.shares[companyId], shares, "股票一股不卖");
  assert.equal(company.householdShares[household.id], 200);
});

test("富人税：存款可以被取回付税；存款不足时取到现金为止", () => {
  const state = voucherState();
  simulation.setWealthTax(state, { ratesPercent: [20, 20, 20] });
  const household = richestHousehold(state);
  clearWheat(state, household);
  isolate(state, household);
  // 手头 10 券，存款 5000 券，银行现金充足。银行台账按券额记账（测试直接设置）。
  issueToTown(state, 5000);
  household.voucherUnits = 10 * SCALE;
  ensureBankState(state);
  state.bank.deposits[household.id] = 5000 * SCALE;
  state.bank.cashVoucherUnits = 5000 * SCALE;
  state.currency.balances.town -= 5000 * SCALE;
  const townBefore = state.currency.balances.town;
  const result = settleWealthTax(state, CONTENT);
  assert.ok(result.dueUnits > 10 * SCALE, "应纳超过手头粮券，必须动存款");
  assert.equal(result.collectedUnits, result.dueUnits, "存款够，全额缴清");
  assert.equal(state.bank.deposits[household.id], 5000 * SCALE - (result.dueUnits - 10 * SCALE), "存款只减少差额");
  assert.equal(household.voucherUnits, 0);
  assert.equal(state.currency.balances.town - townBefore, result.dueUnits);
});

test("富人税：银行现金不足时镇库垫付，存款全额取回付税，缺口记为银行欠镇库", () => {
  const state = voucherState();
  simulation.setWealthTax(state, { ratesPercent: [20, 20, 20] });
  const household = richestHousehold(state);
  clearWheat(state, household);
  isolate(state, household);
  household.voucherUnits = 0;
  issueToTown(state, 50000);
  ensureBankState(state);
  state.bank.deposits[household.id] = 50000 * SCALE;
  state.bank.cashVoucherUnits = 100 * SCALE;
  state.currency.balances.town -= 100 * SCALE;
  const result = settleWealthTax(state, CONTENT);
  assert.ok(result.dueUnits > 100 * SCALE, "应纳超过银行现金");
  assert.equal(result.collectedUnits, result.dueUnits, "镇库垫付后全额收到（银行现金不再是上限）");
  assert.equal(state.bank.deposits[household.id], 50000 * SCALE - result.dueUnits, "存款只减去已付税额");
  assert.equal(state.bank.debtToTownUnits, result.dueUnits - 100 * SCALE, "垫付 = 应纳 − 银行原有现金");
  assert.equal(state.redistribution.year.wealthTaxWaivedUnits || 0, 0);
});

test("富人税：口粮储备不动，小麦最多付到储备以外的部分，付不完的免征", () => {
  // 股票市值大、小麦只有一点储备以外的余量：税付不完。小麦阶段只付小麦。
  const state = legacyVoucherState({ seed: 6108 });
  const { company, companyId } = listedFixture(state, 50);
  state.monetaryReform.stage = "wheat";
  simulation.setWealthTax(state, { ratesPercent: [20, 20, 20] });
  const holder = householdList(state).find(row => householdPopulation(row) > 0);
  isolate(state, holder);
  holder.voucherUnits = 0;
  company.townShares -= 200; company.residentShares += 200;
  company.householdShares = { [holder.id]: 200 };
  holder.shares = { [companyId]: 200 };
  // 小麦：储备（30 日口粮）之上只留 10 斤。储备量 = 足够多的小麦减去可换出的小麦。
  holder.inventory.wheat = 1e9;
  syncResidentAggregates(state, CONTENT);
  const reserveOnly = 1e9 - householdConvertibleWheatUnits(state, holder, CONTENT);
  holder.inventory.wheat = reserveOnly + 10 * CONTENT.precision.inventoryUnitsPerJin;
  syncResidentAggregates(state, CONTENT);
  const convertible = householdConvertibleWheatUnits(state, holder, CONTENT);
  assert.equal(convertible, 10 * CONTENT.precision.inventoryUnitsPerJin, "储备以外只有 10 斤");
  const wheatBefore = holder.inventory.wheat;
  const result = settleWealthTax(state, CONTENT);
  assert.ok(result.dueUnits > convertible, "应纳远超可付小麦");
  assert.equal(result.collectedUnits <= convertible, true, "付的小麦不超过储备以外的部分");
  assert.ok(holder.inventory.wheat >= wheatBefore - convertible, "口粮储备不动");
  assert.ok(holder.inventory.wheat >= reserveOnly, "小麦不低于口粮储备");
  assert.equal(state.redistribution.year.wealthTaxWaivedUnits > 0, true, "付不完的免征");
  assert.equal(holder.shares[companyId], 200, "股票不卖");
});

test("家底口径：粮券 + 存款 + 超出口粮储备的小麦 + 股票市值 + 民营建筑估值", () => {
  const state = voucherState();
  const household = richestHousehold(state);
  clearWheat(state, household);
  household.voucherUnits = 1000 * SCALE;
  const base = householdWealthUnits(state, household, CONTENT);
  assert.equal(base, 1000 * SCALE, "基础：粮券");
  ensureBankState(state);
  state.bank.deposits[household.id] = 500 * SCALE;
  state.bank.cashVoucherUnits = 500 * SCALE;
  assert.equal(householdWealthUnits(state, household, CONTENT), 1500 * SCALE, "存款计入家底");
  // 股票：200 股，每股 2 券。
  const { company, companyId } = listedFixture(state, 2);
  company.townShares -= 200; company.residentShares += 200;
  company.householdShares = { [household.id]: 200 };
  household.shares = { [companyId]: 200 };
  assert.equal(householdTaxableWealthUnits(state, household, CONTENT) - householdWealthUnits(state, household, CONTENT), 200 * company.sharePriceVoucherUnits, "股票按实时股价计入");
  // 民营建筑：把一栋盐场整栋划给该户，估值计入家底。
  const salt = addSaltworks(state, 2, 10);
  transferBuildingOwnership(state, salt, { kind: "household", id: household.id }, CONTENT);
  assert.equal(buildingOwner(state, salt).kind, "household");
  const quote = simulation.selectOperatingRightPreview(state, salt.id);
  const valuation = Math.round(quote.referencePriceWheatJin * SCALE);
  assert.ok(valuation > 0, "民营建筑有估值");
  const taxable = householdTaxableWealthUnits(state, household, CONTENT);
  assert.equal(taxable, 1500 * SCALE + 200 * company.sharePriceVoucherUnits + valuation, "整栋估值计入家底");
});

test("遗产税：有成年人去世的家庭，超过第一档门槛 × 去世人数的部分按税率计", () => {
  const state = voucherState();
  simulation.setInheritanceTax(state, 10);
  const household = richestHousehold(state);
  clearWheat(state, household);
  household.ageBands = { children: 0, workers: 2, elders: 0 };
  household.voucherUnits = 3000 * SCALE;
  household.jobs = {};
  syncResidentAggregates(state, CONTENT);
  const snapshot = snapshotEstates(state, CONTENT);
  // 一名成年人去世：份额 = 3000 × 1/2 = 1500 券，免征额 300 券，应税 1200 券，税 120 券。
  household.ageBands.workers = 1;
  const town = state.currency.balances.town;
  const result = settleYearEstates(state, CONTENT, snapshot, { [household.id]: 1 });
  assert.equal(result.inheritance.taxUnits, 120 * SCALE);
  assert.equal(state.redistribution.year.inheritanceTaxUnits, 120 * SCALE);
  assert.equal(state.currency.balances.town - town, 120 * SCALE);
});

test("遗产税：份额低于免征额（第一档门槛 × 去世人数）时不征", () => {
  const state = voucherState();
  simulation.setInheritanceTax(state, 50);
  const household = richestHousehold(state);
  clearWheat(state, household);
  household.ageBands = { children: 0, workers: 2, elders: 0 };
  household.voucherUnits = 500 * SCALE;
  syncResidentAggregates(state, CONTENT);
  const snapshot = snapshotEstates(state, CONTENT);
  household.ageBands.workers = 1;
  // 份额 = 500 × 1/2 = 250 券 < 免征额 300 券。
  const result = settleYearEstates(state, CONTENT, snapshot, { [household.id]: 1 });
  assert.equal(result.inheritance.taxUnits, 0);
  assert.equal(household.voucherUnits, 500 * SCALE);
});

test("整户失效：粮券、存款、库存、股票、民营建筑全部归镇库 / 镇营，股票总量守恒", () => {
  const state = voucherState();
  const household = richestHousehold(state);
  ensureBankState(state);
  // 粮券 + 存款（银行现金足够，台账守恒）。
  grantResidentVouchers(state, 400, CONTENT, household.id);
  state.bank.deposits[household.id] = 300 * SCALE;
  state.bank.cashVoucherUnits = 300 * SCALE;
  state.currency.balances.town -= 300 * SCALE;
  household.inventory.wheat = 50 * CONTENT.precision.inventoryUnitsPerJin;
  household.inventory.salt = 4 * CONTENT.precision.inventoryUnitsPerJin;
  household.jobs = {};
  const { company, companyId } = listedFixture(state, 3);
  company.townShares -= 100; company.residentShares += 100;
  company.householdShares = { [household.id]: 100 };
  household.shares = { [companyId]: 100 };
  const salt = addSaltworks(state, 2, 10);
  transferBuildingOwnership(state, salt, { kind: "household", id: household.id }, CONTENT);
  const townWheatBefore = state.accounts.town.wheat;
  const townVouchersBefore = state.currency.balances.town;
  // 整户去世：人口归零，职务清空。
  household.ageBands = { children: 0, workers: 0, elders: 0 };
  const totalShares = company.totalShares;
  const result = settleEscheat(state, CONTENT);
  assert.ok(result, "有家产需要归公");
  assert.equal(household.voucherUnits, 0);
  assert.equal(state.bank.deposits[household.id], 0, "存款取回并划走");
  assert.equal(state.accounts.town.wheat - townWheatBefore, 50 * CONTENT.precision.inventoryUnitsPerJin, "小麦归镇库");
  assert.equal(state.accounts.town.salt >= 4 * CONTENT.precision.inventoryUnitsPerJin, true, "食盐归镇库");
  assert.equal(Object.values(household.inventory).every(units => units === 0), true);
  assert.deepEqual(household.shares, {});
  assert.equal(company.householdShares[household.id], undefined);
  assert.equal(company.townShares + company.residentShares + (company.fundShares || 0), totalShares, "股票总量守恒");
  assert.equal(Object.values(company.householdShares).reduce((sum, value) => sum + value, 0), company.residentShares, "逐户持股与居民持股一致");
  assert.equal(company.townShares >= 100, true, "股份转入镇库");
  assert.equal(buildingOwner(state, salt).kind, "town", "民营建筑收归镇营");
  assert.equal(state.currency.balances.town - townVouchersBefore, 700 * SCALE, "粮券与存款进镇库");
  assert.equal(state.redistribution.year.escheatHouseholds, 1);
  assert.equal(state.redistribution.year.escheatBuildings, 1);
  // 人口 cohort 没有随测试改动，这里只核对货币总账。
  assert.equal(validateCurrencyInvariant(state, CONTENT).valid, true, "粮券总账守恒");
});

test("整户失效的存款：银行现金与镇库都不够时留在台账，之后每日再取", () => {
  const state = voucherState();
  const household = richestHousehold(state);
  ensureBankState(state);
  state.bank.deposits[household.id] = 200 * SCALE;
  state.bank.cashVoucherUnits = 0;
  // 镇库没有粮券（legacy 夹具镇库为 0）：取不回，存款暂留。
  assert.equal(state.currency.balances.town, 0);
  household.ageBands = { children: 0, workers: 0, elders: 0 };
  settleEscheat(state, CONTENT);
  assert.equal(state.bank.deposits[household.id], 200 * SCALE, "现金与镇库都不够，存款暂留");
  // 镇库拿到 200 券后（镇库垫付），整户家产归镇库。
  state.currency.balances.town += 200 * SCALE;
  settleEscheat(state, CONTENT);
  assert.equal(state.bank.deposits[household.id], 0);
  assert.equal(settleEscheat(state, CONTENT), null, "没有剩余家产时不再处理");
});

test("日结：整户失效的家产每日扫描，年末人口结算也会归公", () => {
  const state = voucherState();
  const household = richestHousehold(state);
  household.ageBands = { children: 0, workers: 0, elders: 0 };
  household.voucherUnits = 77 * SCALE;
  syncResidentAggregates(state, CONTENT);
  const townBefore = state.currency.balances.town;
  simulation.advanceDay(state);
  assert.equal(household.voucherUnits, 0);
  assert.equal(state.currency.balances.town - townBefore, 77 * SCALE);
});

test("基尼系数：完全平均为 0；一户占全部家底约为 1 − 1/n", () => {
  const equal = Array.from({ length: 10 }, (_, index) => ({ householdId: "h" + index, people: 2, wealth: 500 }));
  assert.ok(Math.abs(giniCoefficient(equal)) < 1e-9);
  const one = Array.from({ length: 10 }, (_, index) => ({ householdId: "h" + index, people: 1, wealth: index === 9 ? 1000 : 0 }));
  assert.ok(Math.abs(giniCoefficient(one) - (1 - 1 / 10)) < 1e-9);
  // 两户各 1 人，财富 [0, 2]：基尼 0.5。
  assert.ok(Math.abs(giniCoefficient([{ people: 1, wealth: 0 }, { people: 1, wealth: 2 }]) - 0.5) < 1e-9);
  // 人口加权：一户 3 人人均 1、一户 1 人人均 5 → 人均不同，结果与直接公式一致。
  const weighted = giniCoefficient([{ people: 3, wealth: 3 }, { people: 1, wealth: 5 }]);
  // 按人计算：[1,1,1,5]，μ=2，G = Σ|xi-xj|/(2n²μ) = (3·4·2)/(2·16·2) = 24/64 = 0.375
  assert.ok(Math.abs(weighted - 0.375) < 1e-9);
});

test("选择器基尼：全部家户人均相等为 0，一户占全部家底为 1 − 1/n", () => {
  const state = simulation.createInitialState({ seed: 7001 });
  const holders = householdList(state);
  for (const household of holders) {
    household.ageBands = { children: 0, workers: 1, elders: 0 };
    household.voucherUnits = 0;
    for (const itemId of Object.keys(household.inventory)) household.inventory[itemId] = 0;
  }
  const flat = selectInequality(state, CONTENT);
  assert.equal(flat.households, holders.length);
  assert.equal(flat.gini, 0);
  holders[0].voucherUnits = 1000 * SCALE;
  const unequal = selectInequality(state, CONTENT);
  assert.equal(unequal.gini, Math.round((1 - 1 / holders.length) * 10000) / 10000);
  assert.equal(unequal.top1SharePercent, 100, "最富的 1% 人口（1 户/250 户）占全部家底");
  assert.equal(unequal.top10SharePercent, 100);
});

test("逐年基尼由系统写入 giniHistory（年末），选择器只读", () => {
  const state = simulation.createInitialState({ seed: 7002 });
  simulation.advanceDays(state, CONTENT.rules.daysPerYear);
  assert.equal(state.redistribution.giniHistory.length, 1);
  assert.equal(state.redistribution.giniHistory[0].year, 1);
  const gini = state.redistribution.giniHistory[0].gini;
  assert.ok(gini >= 0 && gini <= 1);
  const before = JSON.stringify(state.redistribution.giniHistory);
  selectInequality(state, CONTENT);
  assert.equal(JSON.stringify(state.redistribution.giniHistory), before, "选择器不写 state");
  assert.equal(selectInequality(state, CONTENT).giniHistory.length, 1);
});

test("逐年基尼最多保留 50 条", () => {
  const state = simulation.createInitialState({ seed: 7003 });
  for (let year = 1; year <= 60; year += 1) recordYearGini(state, CONTENT, year);
  assert.equal(state.redistribution.giniHistory.length, 50);
  assert.equal(state.redistribution.giniHistory[0].year, 11);
  assert.equal(state.redistribution.giniHistory.at(-1).year, 60);
});

test("年账与日账：年末翻年清空年账，累计保留", () => {
  const state = voucherState();
  simulation.setWealthTax(state, { ratesPercent: [10, 10, 10] });
  grantResidentVouchers(state, 5000, CONTENT, richestHousehold(state).id);
  settleWealthTax(state, CONTENT);
  const cumulative = state.redistribution.cumulative.wealthTaxUnits;
  assert.ok(cumulative > 0);
  resetRedistributionYear(state);
  assert.equal(state.redistribution.year.wealthTaxUnits, 0, "年账翻年清零");
  assert.equal(state.redistribution.cumulative.wealthTaxUnits, cumulative, "累计保留");
});

test("命令校验：富人税门槛递增、三档；税率 0–20；遗产税率 0–50", () => {
  const state = simulation.createInitialState({ seed: 7004 });
  assert.equal(simulation.setWealthTax(state, { thresholds: [1000, 300, 3000] }).ok, false, "门槛须递增");
  assert.equal(simulation.setWealthTax(state, { thresholds: [300, 1000] }).ok, false, "门槛须 3 个");
  assert.equal(simulation.setWealthTax(state, { thresholds: [-1, 1000, 3000] }).ok, false, "门槛须为正");
  assert.equal(simulation.setWealthTax(state, { ratesPercent: [25, 0, 0] }).ok, false, "税率不超过 20");
  assert.equal(simulation.setWealthTax(state, { ratesPercent: [-1, 0, 0] }).ok, false, "税率不为负");
  assert.equal(simulation.setWealthTax(state, { ratesPercent: [1, 2] }).ok, false, "税率须 3 档");
  assert.deepEqual(state.policy.wealthTax, { thresholds: [300, 1000, 3000], ratesPercent: [0, 0, 0] }, "失败不改政策");
  const ok = simulation.setWealthTax(state, { thresholds: [400, 1200, 4000], ratesPercent: [5, 10, 20] });
  assert.equal(ok.ok, true);
  assert.deepEqual(state.policy.wealthTax, { thresholds: [400, 1200, 4000], ratesPercent: [5, 10, 20] });
  assert.equal(simulation.setInheritanceTax(state, 51).ok, false);
  assert.equal(simulation.setInheritanceTax(state, -0.1).ok, false);
  assert.equal(simulation.setInheritanceTax(state, Number.NaN).ok, false);
  assert.equal(simulation.setInheritanceTax(state, 50).ok, true);
  assert.equal(state.policy.inheritanceTaxPercent, 50);
});

test("validateState：新开局与政策修改后通过；坏政策会报错", () => {
  const state = voucherState();
  simulation.setWealthTax(state, { thresholds: TH, ratesPercent: [1, 2, 3] });
  simulation.setInheritanceTax(state, 5);
  simulation.advanceDays(state, 40);
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
  const broken = structuredClone(state);
  broken.policy.wealthTax.ratesPercent = [25, 0, 0];
  assert.equal(simulation.validateState(broken).valid, false);
  const brokenInheritance = structuredClone(state);
  brokenInheritance.policy.inheritanceTaxPercent = 80;
  assert.equal(simulation.validateState(brokenInheritance).valid, false);
});

test("存档往返：政策、年账、基尼历史读回一致", () => {
  const state = voucherState();
  simulation.setWealthTax(state, { thresholds: [400, 1200, 4000], ratesPercent: [5, 10, 15] });
  simulation.setInheritanceTax(state, 12);
  grantResidentVouchers(state, 6000, CONTENT, richestHousehold(state).id);
  simulation.advanceDays(state, CONTENT.rules.daysPerYear + 3);
  const storage = memoryStorage();
  const json = exportState(state);
  const imported = importState(storage, json, CONTENT);
  assert.deepEqual(imported.policy.wealthTax, state.policy.wealthTax);
  assert.equal(imported.policy.inheritanceTaxPercent, 12);
  assert.deepEqual(imported.redistribution.giniHistory, state.redistribution.giniHistory);
  assert.deepEqual(imported.redistribution.cumulative, state.redistribution.cumulative);
  assert.equal(imported.redistribution.lastRun.year, state.redistribution.lastRun.year);
  assert.ok(storage.getItem(SAVE_KEY) !== null);
});

test("旧档没有再分配字段时读档补默认值", () => {
  const state = simulation.createInitialState({ seed: 7005 });
  const old = structuredClone(state);
  delete old.redistribution;
  delete old.policy.wealthTax;
  delete old.policy.inheritanceTaxPercent;
  const imported = importState(memoryStorage(), JSON.stringify(old), CONTENT);
  assert.deepEqual(imported.policy.wealthTax, { thresholds: [300, 1000, 3000], ratesPercent: [0, 0, 0] });
  assert.equal(imported.policy.inheritanceTaxPercent, 0);
  assert.ok(imported.redistribution);
});

test("税基口径：wealthDistributionRows 与选择器的人口一致", () => {
  const state = simulation.createInitialState({ seed: 7006 });
  const rows = wealthDistributionRows(state, CONTENT);
  assert.equal(rows.reduce((sum, row) => sum + row.people, 0), householdList(state).reduce((sum, h) => sum + householdPopulation(h), 0));
  assert.equal(selectInequality(state, CONTENT).people, rows.reduce((sum, row) => sum + row.people, 0));
});

// 构造一户"把钱全存银行 + 买国债"的富户：先印发 1000 券给富户，存入银行 900，余 100 粮券；另有国债本金 1000 券（住户持有）。
// 走正常的印券与存款路径，保证粮券总账与银行台账守恒（validateState 通过）。
function richBankBondState(seed) {
  const state = voucherState(seed);
  const rich = richestHousehold(state);
  clearWheat(state, rich);
  grantResidentVouchers(state, 1000, CONTENT, rich.id);
  ensureBankState(state);
  const deposited = depositToBank(state, rich.id, 900 * SCALE, CONTENT);
  assert.equal(deposited.ok, true, "存入银行");
  state.bonds = {
    seq: 1, townOwesBankVoucherUnits: 0,
    issues: [{
      id: "GB1", totalVoucherUnits: 1000 * SCALE, subscribedVoucherUnits: 1000 * SCALE, subscriptions: {},
      holdings: [{ holderKey: `household:${rich.id}`, principalVoucherUnits: 1000 * SCALE }],
      termDays: 360, couponRateAnnualPercent: 3, status: "active", issuedDayIndex: 0, lastCouponDayIndex: 0,
      extensions: 0, stats: { couponPaidVoucherUnits: 0, principalRepaidVoucherUnits: 0 }
    }]
  };
  syncResidentAggregates(state, CONTENT);
  return { state, rich };
}

test("全口径统计：存款与国债进入基尼/最富占比，旧口径（粮券+存粮）明显低估", () => {
  const { state, rich } = richBankBondState(6201);
  // 其余户压成人均 10 券（直接赋值只为构造对比，不做守恒校验）。
  for (const other of householdList(state)) {
    if (other.id === rich.id) continue;
    other.voucherUnits = 10 * SCALE;
    other.inventory.wheat = 0;
  }
  syncResidentAggregates(state, CONTENT);
  const oldRows = householdList(state).filter(isActiveHousehold).map(h => ({ people: householdPopulation(h), wealth: householdWealth(state, h, CONTENT) }));
  const oldTop1 = topWealthSharePercent(oldRows, 0.01);
  const oldTop10 = topWealthSharePercent(oldRows, 0.1);
  const after = selectInequality(state, CONTENT);
  assert.ok(after.top1SharePercent > oldTop1 * 3, `新口径 top1 ${after.top1SharePercent} 应显著高于旧口径 ${oldTop1}`);
  assert.ok(after.top10SharePercent > oldTop10, "新口径 top10 高于旧口径");
  // 富户全口径家底 = 粮券（余 100）+ 存款 900 + 国债本金 1000（券）。
  const richRow = wealthDistributionRows(state, CONTENT).find(row => row.householdId === rich.id);
  assert.equal(richRow.wealth, householdTaxableWealthUnits(state, rich, CONTENT), "统计行与征税口径一致");
  assert.equal(richRow.wealth - householdWealthUnits(state, rich, CONTENT), 1000 * SCALE, "国债本金计入");
  assert.equal(householdWealthUnits(state, rich, CONTENT), rich.voucherUnits + 900 * SCALE, "粮券 + 存款");
  assert.equal(Math.round(giniCoefficient(wealthDistributionRows(state, CONTENT)) * 10000) / 10000, after.gini, "选择器基尼与统计行同口径");
});

test("国债本金计入富人税与遗产税税基：持有户应纳随国债增加，不能直接付税则免征", () => {
  const state = voucherState(6202);
  const holder = richestHousehold(state);
  isolate(state, holder);
  clearWheat(state, holder);
  holder.voucherUnits = 0;
  simulation.setWealthTax(state, { ratesPercent: [10, 10, 10] });
  simulation.setInheritanceTax(state, 10);
  syncResidentAggregates(state, CONTENT);
  const before = settleWealthTax(state, CONTENT);
  assert.equal(before.dueUnits, 0, "没有家底不征");
  ensureBankState(state);
  state.bonds = {
    seq: 1, townOwesBankVoucherUnits: 0,
    issues: [{
      id: "GB1", totalVoucherUnits: 5000 * SCALE, subscribedVoucherUnits: 5000 * SCALE, subscriptions: {},
      holdings: [{ holderKey: `household:${holder.id}`, principalVoucherUnits: 5000 * SCALE }],
      termDays: 360, couponRateAnnualPercent: 3, status: "active", issuedDayIndex: 0, lastCouponDayIndex: 0,
      extensions: 0, stats: { couponPaidVoucherUnits: 0, principalRepaidVoucherUnits: 0 }
    }]
  };
  assert.equal(householdTaxableWealthUnits(state, holder, CONTENT), 5000 * SCALE, "国债本金计入征税口径");
  const after = settleWealthTax(state, CONTENT);
  assert.ok(after.dueUnits > before.dueUnits, "持有国债后应纳富人税增加");
  assert.equal(after.collectedUnits, 0, "国债不能直接付税，无现金则免征");
  assert.equal(state.redistribution.lastRun.dueUnits, after.dueUnits);
  const snapshot = snapshotEstates(state, CONTENT);
  assert.equal(snapshot.get(holder.id).wealthUnits, 5000 * SCALE, "遗产税份额口径含国债");
  // 到期兑付后不再计入。
  state.bonds.issues[0].status = "matured";
  assert.equal(householdTaxableWealthUnits(state, holder, CONTENT), 0, "到期后国债不计入");
});

test("全口径统计：选择器不写 state，状态校验通过", () => {
  const { state } = richBankBondState(6203);
  assert.equal(simulation.validateState(state).valid, true, "构造状态合法（存款与印券走正常路径）");
  const before = JSON.stringify(state);
  selectInequality(state, CONTENT);
  wealthDistributionRows(state, CONTENT);
  assert.equal(JSON.stringify(state), before, "选择器与统计只读");
  assert.equal(simulation.validateState(state).valid, true);
});

// ---------------------------------------------------------------- 测试夹具

// 建一家上市公司（盐业）：1000 股，每股 price 券，全部在镇库。
function listedFixture(state, priceVouchers) {
  const plot = state.plots.find(row => !row.feature && !state.buildings.some(b => b.plotId === row.id));
  const id = "fixture-mill-" + state.buildings.length;
  state.buildings.push({ id, typeId: "mill", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } });
  state.stockExchange = { ...(state.stockExchange || {}), legacyAccess: true, rotation: 0 };
  assert.equal(simulation.issueGrainVouchers(state, "town", 50000).ok, true);
  const formed = formCompany(state, id, { name: "测试盐业", levels: 1, operatingCapitalVoucher: 10000, initialMaterialQuantity: 0 });
  assert.equal(formed.ok, true, formed.reason);
  const listed = simulation.listCompanyShares(state, formed.companyId, { ticker: "062", totalShares: 1000, priceVoucherPerShare: priceVouchers, offeredShares: 0 });
  assert.equal(listed.ok, true, listed.reason);
  return { company: state.companies[formed.companyId], companyId: formed.companyId };
}

// 测试用：给镇库印制粮券（正式发行，保证货币总账守恒）。
function issueToTown(state, vouchers) {
  const result = issueTownVouchers(state, vouchers * SCALE, CONTENT, "测试：印制粮券");
  assert.equal(result.ok, true, result.reason);
}

// 加一栋磨坊（镇营），返回建筑对象。
// 加一栋 2 级盐场（10 人岗位）。估值按批发收购价，需要批发市场建筑才有价格口径（同 ownership-tax 测试）。
function addSaltworks(state, level, workers) {
  if (!state.buildings.some(row => row.typeId === "wholesale_market")) {
    const market = state.plots.find(row => !row.feature && !state.buildings.some(b => b.plotId === row.id));
    state.buildings.push({ id: "tax-market", typeId: "wholesale_market", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: market.id, x: market.x, y: market.y, materialInvestments: [], completed: { year: state.year, day: 1 } });
  }
  const required = CONTENT.buildings.saltworks.requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  const building = { id: "tax-salt-" + state.buildings.length, typeId: "saltworks", level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  if (workers) simulation.setEmployment(state, `${building.id}::salt_workers`, workers);
  return building;
}
