import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { householdList, householdIdleWorkers, householdPopulation, syncResidentAggregates, releaseJobFromHousehold, setHouseholdJobCount, householdExchangeAllowanceUnits, householdFoodQeqUnits } from "../src/systems/households.js";
import { transferVouchers } from "../src/economy/currency.js";
import { accountQeqUnits, totalQeqUnits } from "../src/economy/inventory.js";
import { applyAutomaticRelief, redeemEssentialFoodForHouseholds } from "../src/systems/finance.js";
import { ensureHouseholdLife, householdRecentTotals } from "../src/systems/household-life.js";
import { exportState, importState } from "../src/persistence/storage.js";
import { grantResidentVouchers, setHouseholdInventoryJin } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot);
  const building = { id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  const jobs = CONTENT.buildings[typeId].jobs || [];
  return building;
}

function clearFamilyFood(state, household) {
  for (const [itemId, item] of Object.entries(CONTENT.items)) if (item.edible) household.inventory[itemId] = 0;
  syncResidentAggregates(state, CONTENT);
}

function cloneInitial(seed = 1201) { return legacyVoucherState({ seed }); }

test("0.1.2农业税对照：只改变税率，秋收家庭实物收入与镇库税粮方向相反", () => {
  const low = cloneInitial(1201), high = cloneInitial(1201);
  simulation.setAgricultureTax(low, 20); simulation.setAgricultureTax(high, 70);
  simulation.advanceDays(low, CONTENT.rules.growingDays); simulation.advanceDays(high, CONTENT.rules.growingDays);
  const l = low.agriculture.taxHistory.at(-1), h = high.agriculture.taxHistory.at(-1);
  assert.ok(l.residentUnits > h.residentUnits); assert.ok(l.townUnits < h.townUnits);
  assert.ok(householdList(low).reduce((s,x)=>s+(x.life?.year?.inKindIncomeQeqUnits||0),0) > householdList(high).reduce((s,x)=>s+(x.life?.year?.inKindIncomeQeqUnits||0),0));
});

test("0.1.2工资对照：提高工资增加员工应收与雇主成本，资金不足形成具体家庭欠薪", () => {
  const low = cloneInitial(1202), high = cloneInitial(1202); addBuilding(low,"mill","wage-mill"); addBuilding(high,"mill","wage-mill");
  simulation.setEmployment(low,"wage-mill::millers",2); simulation.setEmployment(high,"wage-mill::millers",2);
  simulation.setWageRate(low,"millers",5); simulation.setWageRate(high,"millers",20);
  simulation.advanceDay(low); simulation.advanceDay(high);
  assert.ok(high.payroll.lastDay.expectedVoucher > low.payroll.lastDay.expectedVoucher);
  assert.ok(Object.values(high.payroll.creditorClaims["wage-mill::millers"]||{}).reduce((a,b)=>a+b,0) > Object.values(low.payroll.creditorClaims["wage-mill::millers"]||{}).reduce((a,b)=>a+b,0));
});

test("0.1.2失业金对照：实际失业劳动力获得家庭到账，镇库不足明确显示未覆盖人数", () => {
  const off=cloneInitial(1203), on=cloneInitial(1203); simulation.issueGrainVouchers(on,"town",50); simulation.setUnemploymentPolicy(on,{enabled:true,dailyPerWorkerJin:1});
  const before=on.currency.balances.town; simulation.advanceDay(off); simulation.advanceDay(on);
  assert.ok(on.policy.lastDay.paidPeople>0); assert.ok(on.policy.lastDay.uncoveredPeople>0); assert.ok(on.currency.balances.town<before);
  assert.equal(off.policy.lastDay.paidPeople,0);
});

test("0.1.2店租对照：同店同销量只提高店租会增加实际成本并压低商人经营结果", () => {
  const make=(rent)=>{ const s=cloneInitial(1204); const street=addBuilding(s,"commercial_street","street"); const owner=householdList(s).find(h=>householdIdleWorkers(h)>0); grantResidentVouchers(s,1000,CONTENT,owner.id); simulation.setShopRent(s,rent); const opened=simulation.openResidentShop(s,street.id,"bakery",owner.id); assert.ok(opened.ok); return {s,shop:s.shops[opened.shopId]}; };
  const low=make(1), high=make(20); simulation.advanceDay(low.s); simulation.advanceDay(high.s);
  assert.ok(high.shop.accounts.day.rentExpenseVoucherUnits > low.shop.accounts.day.rentExpenseVoucherUnits);
  assert.ok(high.shop.accounts.day.profitVoucherUnits < low.shop.accounts.day.profitVoucherUnits);
});

test("0.1.2就业兑换额度0/2/4严格约束实际存粮换券，工资福利不占额度", () => {
  const results=[];
  for (const quota of [0,2,4]) { const s=cloneInitial(1205); const h=householdList(s)[0]; simulation.setEmploymentExchangeQuota(s,quota);
  // 基线清理：住户换券的粮券由"镇库现有余额支付"（currency.js 设计），须先印制发行，镇库有余额换券路径才可用。
  assert.equal(simulation.issueGrainVouchers(s,"town",100).ok, true);
  const before=h.voucherUnits; const allowance=householdExchangeAllowanceUnits(s,h.id,CONTENT); if (allowance>0) simulation.issueGrainVouchers(s,`household:${h.id}`,allowance/I); results.push({quota,gain:h.voucherUnits-before}); }
  assert.equal(results[0].gain,0); assert.ok(results[1].gain>0); assert.ok(results[2].gain>=results[1].gain);
});

test("0.1.2全镇有粮但个别家庭缺粮时，自动救济按户到达而不是被全镇平均掩盖", () => {
  const s=cloneInitial(1206); const h=householdList(s)[0]; clearFamilyFood(s,h); h.voucherUnits=0; syncResidentAggregates(s,CONTENT); simulation.advanceDay(s);
  assert.ok((s.relief.lastDay?.servedHouseholds || 0) >= 1);
  assert.equal(s.shortageQeq,0);
  assert.ok((h.life?.day?.reliefQeqUnits||0) > 0);
});

test("0.1.2家庭有券无食物时先按1:1正常兑付，避免虚假饥饿且不消耗就业换券额度", () => {
  const s=cloneInitial(1207); const h=householdList(s)[0]; clearFamilyFood(s,h); simulation.issueGrainVouchers(s,"town",100); transferVouchers(s,"town",`household:${h.id}`,20*V,CONTENT,"unemployment_benefit","测试已有收入");
  const usedBefore=s.households.exchange?.usedByHousehold?.[h.id]||0;
  // 1券兑1斤的正常兑付本身：有券无粮时先自费兑付，而不是直接吃免费救济。
  const essential = redeemEssentialFoodForHouseholds(s, CONTENT);
  assert.ok(essential.redeemedUnits > 0, "有券无粮家庭应按1:1自费兑付");
  // 日循环里：有券家庭先自费兑付，不够的部分由救济补足；不出现饥饿，也不占用就业换券额度。
  const s2=cloneInitial(1207); const h2=householdList(s2)[0]; clearFamilyFood(s2,h2); simulation.issueGrainVouchers(s2,"town",100); transferVouchers(s2,"town",`household:${h2.id}`,20*V,CONTENT,"unemployment_benefit","测试已有收入");
  const usedBefore2=s2.households.exchange?.usedByHousehold?.[h2.id]||0;
  simulation.advanceDay(s2);
  assert.equal(s2.shortageQeq,0);
  assert.ok((s2.relief.lastDay?.redeemedWheatUnits||0) > 0, "有券无粮家庭应先自费兑付");
  assert.equal(s2.households.exchange.usedByHousehold[h2.id]||0,usedBefore2);
  assert.equal(usedBefore, usedBefore2);
});

test("0.1.2欠薪偿付进入原债权家庭，换岗后不把旧债转给后来上岗者", () => {
  const s=cloneInitial(1208); addBuilding(s,"mill","claim-mill"); simulation.setEmployment(s,"claim-mill::millers",1); simulation.advanceDay(s);
  const claims=s.payroll.creditorClaims["claim-mill::millers"]; const originalId=Object.keys(claims).find(id=>claims[id]>0); assert.ok(originalId); const oldDebt=claims[originalId];
  assert.equal(releaseJobFromHousehold(s,originalId,"claim-mill::millers",1),1);
  const replacement=householdList(s).find(h=>h.id!==originalId&&householdIdleWorkers(h)>0); assert.ok(replacement);
  assert.equal(setHouseholdJobCount(s,replacement.id,"claim-mill::millers",1,CONTENT).ok,true);
  const before=s.households.byId[originalId].voucherUnits; simulation.issueGrainVouchers(s,"town",100); simulation.advanceDay(s);
  assert.ok(s.households.byId[originalId].voucherUnits-before>=oldDebt); assert.ok((s.payroll.creditorClaims["claim-mill::millers"][originalId]||0)===0);
});

test("0.1.2家庭生活账区分收入、生活支出、消费、投资与资产兑换，不重复记账", () => {
  const s=cloneInitial(1209); const h=householdList(s)[0]; simulation.issueGrainVouchers(s,"town",100); transferVouchers(s,"town",`household:${h.id}`,10*V,CONTENT,"unemployment_benefit","福利");
  const income=h.life.cumulative.incomeVoucherUnits||0; assert.equal(income,10*V); simulation.redeemGrainVouchers(s,`household:${h.id}`,2); assert.equal(h.life.cumulative.incomeVoucherUnits||0,income); assert.equal(h.life.cumulative.assetExchangeVoucherUnits,2*V);
  simulation.advanceDay(s); assert.ok((h.life.cumulative.foodConsumedQeqUnits||0)>0); assert.equal(h.life.cumulative.lifeExpenseVoucherUnits||0,0);
});

test("0.1.2保存恢复保留家庭生活、舒心值、债权与政策记录，不伪造旧历史", () => {
  const s=cloneInitial(1210); addBuilding(s,"mill","save-mill"); simulation.setEmployment(s,"save-mill::millers",1); simulation.setUnemploymentPolicy(s,{enabled:true,dailyPerWorkerJin:1}); simulation.advanceDay(s);
  const restored=importState({getItem(){return null;},setItem(){}},exportState(s),CONTENT);
  assert.equal(restored.schemaVersion,CONTENT.rules.saveVersion); assert.equal(restored.satisfaction,s.satisfaction); assert.deepEqual(restored.payroll.creditorClaims,s.payroll.creditorClaims); assert.deepEqual(restored.policy.lastDay,s.policy.lastDay);
  const id=householdList(s)[0].id; assert.deepEqual(restored.households.byId[id].life.recent,s.households.byId[id].life.recent);
});


// 开局数值调整（8cf03ae）后户均人口从 4—5 人变为 13—14 人，不再存在固定 5 人家庭。
// 改为取第一户并把"14 日口粮目标"按实际人口推导，用例本身与人口规模解耦。
function makeReliefHouseholdState(seed, voucher = 0, townReliefJin = null) {
  const state = cloneInitial(seed);
  const household = householdList(state)[0];
  assert.ok(household, "测试需要一个家庭");
  const targetJin = householdPopulation(household) * CONTENT.rules.foodPerPersonDay * 14;
  clearFamilyFood(state, household);
  if (voucher > 0) {
    const grant = grantResidentVouchers(state, voucher, CONTENT, household.id);
    assert.equal(grant.ok, true, grant.reason);
  }
  if (townReliefJin !== null) {
    for (const [itemId, item] of Object.entries(CONTENT.items)) if (item.edible) state.accounts.town[itemId] = 0;
    state.accounts.town.wheat = Math.round(townReliefJin * I);
  }
  syncResidentAggregates(state, CONTENT);
  return { state, household, targetJin };
}

function reliefSnapshot(state, household) {
  return {
    reserveWheatUnits: state.currency.reserveWheatUnits,
    issuedUnits: state.currency.issuedUnits,
    voucherUnits: household.voucherUnits,
    householdFoodQeqUnits: householdFoodQeqUnits(state, household, CONTENT),
    townFoodQeqUnits: accountQeqUnits(state, "town", CONTENT),
    totalFoodQeqUnits: totalQeqUnits(state, CONTENT),
    exchangeUsedUnits: state.households.exchange?.usedByHousehold?.[household.id] || 0
  };
}

function assertReliefConservation(before, after, result) {
  const redeemedQeq = result.redeemedWheatUnits * CONTENT.precision.qeqUnitsPerJin / I;
  assert.equal(before.reserveWheatUnits, 0, "r04不再维护独立兑付储备");
  assert.equal(after.reserveWheatUnits, 0, "兑回后仍不产生独立兑付储备");
  assert.equal(after.issuedUnits, before.issuedUnits, "家庭兑付的粮券交回镇库，不注销，发行总量不变");
  assert.equal(before.voucherUnits - after.voucherUnits, result.redeemedWheatUnits, "家庭粮券按实际兑付交出");
  assert.equal(after.householdFoodQeqUnits - before.householdFoodQeqUnits, redeemedQeq + result.movedQeqUnits, "家庭新增口粮=自费兑付+免费救济");
  assert.equal(before.townFoodQeqUnits - after.townFoodQeqUnits, redeemedQeq + result.movedQeqUnits, "兑回与免费救济都从镇库可用粮实际拨出");
  assert.equal(after.totalFoodQeqUnits, before.totalFoodQeqUnits, "兑付与救济不改变全镇总口粮");
  assert.equal(after.exchangeUsedUnits, before.exchangeUsedUnits, "兑付不占就业换券额度");
}

test("0.1.2-r02家庭近期汇总从0初始化：空历史、缺字段和多历史日均返回有限金额", () => {
  const s = cloneInitial(1211); const h = householdList(s)[0]; const life = ensureHouseholdLife(h, CONTENT);
  life.recent = [];
  let totals = householdRecentTotals(h, 14, CONTENT);
  assert.equal(totals.days, 0);
  for (const [key, value] of Object.entries(totals)) if (key !== "days") assert.equal(value, 0, `${key} 空历史应为0`);
  life.recent = [
    { year: 1, day: 1, incomeVoucherUnits: 7 * V },
    { year: 1, day: 2, lifeExpenseVoucherUnits: 2 * V, wageDueVoucherUnits: 5 * V },
    { year: 1, day: 3, incomeVoucherUnits: 3 * V, foodConsumedQeqUnits: 4 * CONTENT.precision.qeqUnitsPerJin }
  ];
  totals = householdRecentTotals(h, 14, CONTENT);
  assert.equal(totals.days, 3); assert.equal(totals.incomeVoucherUnits, 10 * V); assert.equal(totals.lifeExpenseVoucherUnits, 2 * V); assert.equal(totals.wageDueVoucherUnits, 5 * V);
  for (const value of Object.values(totals)) assert.equal(Number.isFinite(value), true);
  const detail = simulation.selectDashboard(s).households.details.find(row => row.id === h.id);
  for (const [key, value] of Object.entries(detail.recent)) assert.equal(Number.isFinite(value), true, `dashboard recent.${key} 必须是有限数值`);
});

test("0.1.2-r02足额粮券：无粮家庭自费兑到14日目标，不领取免费口粮", () => {
  const { state: s, household: h, targetJin } = makeReliefHouseholdState(1212, 1000);
  const before = reliefSnapshot(s, h); const result = applyAutomaticRelief(s, s.population, CONTENT); const after = reliefSnapshot(s, h);
  assert.equal(result.redeemedWheatUnits, targetJin * I); assert.equal(result.movedQeqUnits, 0); assert.equal(result.eligibleHouseholds, 0); assert.equal(result.servedHouseholds, 0);
  assert.equal(h.voucherUnits, (1000 - targetJin) * V); assertReliefConservation(before, after, result); assert.equal(simulation.validateCurrencyInvariant(s).valid, true);
});

test("0.1.2-r02部分粮券：先注销自有粮券兑付，再由镇库只补剩余救济缺口", () => {
  const { state: s, household: h, targetJin } = makeReliefHouseholdState(1213, 50);
  const before = reliefSnapshot(s, h); const result = applyAutomaticRelief(s, s.population, CONTENT); const after = reliefSnapshot(s, h);
  assert.equal(result.redeemedWheatUnits, 50 * I); assert.equal(result.movedQeqUnits, (targetJin - 50) * CONTENT.precision.qeqUnitsPerJin); assert.equal(result.eligibleHouseholds, 1); assert.equal(result.servedHouseholds, 1); assert.equal(h.voucherUnits, 0);
  assertReliefConservation(before, after, result); assert.equal(simulation.validateCurrencyInvariant(s).valid, true);
});

test("0.1.2-r02无粮券：不发生兑付，镇库按14日目标承担全部免费救济", () => {
  const { state: s, household: h, targetJin } = makeReliefHouseholdState(1214, 0);
  const before = reliefSnapshot(s, h); const result = applyAutomaticRelief(s, s.population, CONTENT); const after = reliefSnapshot(s, h);
  assert.equal(result.redeemedWheatUnits, 0); assert.equal(result.movedQeqUnits, targetJin * CONTENT.precision.qeqUnitsPerJin); assert.equal(result.eligibleHouseholds, 1); assert.equal(result.servedHouseholds, 1);
  assertReliefConservation(before, after, result); assert.equal(simulation.validateCurrencyInvariant(s).valid, true);
});

test("0.1.2-r02镇库救济粮不足：只拨实际库存并保留剩余缺口，守恒不透支", () => {
  const { state: s, household: h, targetJin } = makeReliefHouseholdState(1215, 0, 20);
  const before = reliefSnapshot(s, h); const result = applyAutomaticRelief(s, s.population, CONTENT); const after = reliefSnapshot(s, h);
  assert.equal(result.redeemedWheatUnits, 0); assert.equal(result.movedQeqUnits, 20 * CONTENT.precision.qeqUnitsPerJin); assert.equal(result.missingQeqUnits, (targetJin - 20) * CONTENT.precision.qeqUnitsPerJin); assert.equal(result.unmetHouseholds, 1);
  assertReliefConservation(before, after, result); assert.equal(simulation.validateCurrencyInvariant(s).valid, true);
});


test("社保基金开启时救济口粮由基金承担，基金不足部分计入欠国库", () => {
  const s=cloneInitial(1299); const h=householdList(s)[0]; clearFamilyFood(s,h); h.voucherUnits=0; syncResidentAggregates(s,CONTENT);
  const plot = s.plots.find(row => !row.feature);
  s.buildings.push({ id: "ss-t", typeId: "social_security_office", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  assert.equal(simulation.setSocialSecurityPolicy(s, { enabled: true }).ok, true);
  simulation.advanceDay(s);
  assert.ok((s.relief.lastDay?.servedHouseholds || 0) >= 1);
  const charged = (s.relief.lastDay.fundPaidValueUnits || 0) + (s.relief.lastDay.fundOwedValueUnits || 0);
  assert.ok(charged > 0, "救济应计到社保基金账上");
  assert.ok(s.socialSecurity.debtToTownUnits >= s.relief.lastDay.fundOwedValueUnits);
  assert.equal(simulation.validateState(s).valid, true);
});
