// 民间贷款欠期计数与国债持仓的整户无人处理回归测试：
// 1) 部分还款后欠期按实际未还期数递减（不再只增不减）；2) 还清欠期后归零，富户不被多收；
// 3) 整户无人时国债持仓转为镇库自持，不再打进死户钱包，台账与粮券守恒；4) townOwesBankVoucherUnits 已删，旧档照常读。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { householdList, isActiveHousehold, syncResidentAggregates } from "../src/systems/households.js";
import { issueTownVouchers, totalVoucherBalances, transferVouchers } from "../src/economy/currency.js";
import { ensureBankState, bankLedgerInvariant } from "../src/systems/bank.js";
import { issueHouseholdLoan, householdFoodReserveVoucherUnits, householdLiquidValueUnits, settleHouseholdLoanRepayDay, quoteHouseholdLoan } from "../src/systems/household-loans.js";
import { issueGovernmentBond, settleBondsDay, ensureBondState, bondOutstandingVoucherUnits, householdBondPrincipalMap, transferBondHoldingsToTown } from "../src/systems/bonds.js";
import { settleEscheat } from "../src/systems/redistribution.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { setHouseholdVoucherUnits } from "./helpers-monetary.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;
const DAYS = CONTENT.rules.daysPerYear || 360;

function addBank(state) {
  const plot = state.plots.filter(row => !row.feature)[0];
  state.buildings.push({ id: "bank-fix", typeId: "bank", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  ensureBankState(state);
}

function bankState(seed) {
  const state = simulation.createInitialState({ seed });
  addBank(state);
  return state;
}

// 镇库注资银行，让银行有现金可放贷（台账守恒）。
function fundBank(state, units) {
  assert.equal(issueTownVouchers(state, units, CONTENT, "测试：注资").ok, true);
  assert.equal(transferVouchers(state, "town", "bank", units, CONTENT, "test_bank_capital", "测试：注资").ok, true);
  state.bank.retainedVoucherUnits += units;
}

function valid(state, tag = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${tag} ${(check.errors || []).join("；")}`);
}

// 放一笔启动资金贷款（夹具：给足收入，别让还款能力上限抢先）。
function issueLoan(state, household, gapUnits) {
  household.recentIncomeUnits = 1000 * V;
  const need = householdLiquidValueUnits(state, household, CONTENT) + gapUnits;
  const result = issueHouseholdLoan(state, household.id, "shop", need, CONTENT);
  assert.equal(result.ok, true, result.reason);
  return result.loan;
}

// 推进到贷款的下一个到期日，手头恰好给够 payInstalments 份月供（外加 30 天口粮钱），然后结算当日还款。
function dueWith(state, household, loan, payInstalments) {
  const day = loan.nextDueDayIndex;
  state.year = Math.floor((day - 1) / DAYS) + 1;
  state.day = ((day - 1) % DAYS) + 1;
  const reserve = householdFoodReserveVoucherUnits(state, household, CONTENT);
  setHouseholdVoucherUnits(state, household, payInstalments * loan.instalmentVoucherUnits + reserve);
  settleHouseholdLoanRepayDay(state, CONTENT);
  valid(state, `到期日 ${day}`);
  return loan;
}

function richHousehold(state) {
  const target = householdList(state)[3];
  for (const household of householdList(state)) {
    if (household.id !== target.id) setHouseholdVoucherUnits(state, household, 0);
    household.inventory.wheat = 0;
  }
  setHouseholdVoucherUnits(state, target, 2000 * V);
  syncResidentAggregates(state, CONTENT);
  return target;
}

test("欠期 部分还款后欠期递减：欠 2 期后只还 1 期，欠期降为 1（不再只增不减）", () => {
  const state = bankState(401);
  fundBank(state, 100000 * V);
  const target = richHousehold(state);
  const loan = issueLoan(state, target, 400 * V);
  // 第 1 期不还：欠 1 期。
  dueWith(state, target, loan, 0);
  assert.equal(loan.missedInstalments, 1, "第1期不还，欠1期");
  // 第 2 期只还 1 期月供：本期加原欠期共 2 期，还了 1 期，剩 1 期未还。
  dueWith(state, target, loan, 1);
  assert.equal(loan.missedInstalments, 1, "只还1期，欠期应为1而不是2");
  // 第 3 期还清 2 期月供：欠期归零。
  dueWith(state, target, loan, 2);
  assert.equal(loan.missedInstalments, 0, "还清欠期后归零");
});

test("欠期 还清 2 期后为 0，之后每期只收一期月供（富户不被多收）", () => {
  const state = bankState(402);
  fundBank(state, 100000 * V);
  const target = richHousehold(state);
  const loan = issueLoan(state, target, 400 * V);
  const instalment = loan.instalmentVoucherUnits;
  dueWith(state, target, loan, 0);
  dueWith(state, target, loan, 0);
  assert.equal(loan.missedInstalments, 2, "连续两期不还，欠2期");
  const before = loan.outstandingVoucherUnits;
  // 到期日本期加欠期共 3 期，富户一次付清：欠期清零。
  dueWith(state, target, loan, 3);
  assert.equal(loan.missedInstalments, 0, "还清全部欠期后欠期为0");
  assert.equal(before - loan.outstandingVoucherUnits, 3 * instalment, "这一期实还 3 期月供");
  // 之后每期只收一期月供：手头给 10 期，本期只扣 1 期。
  const beforeNext = loan.outstandingVoucherUnits;
  dueWith(state, target, loan, 10);
  assert.equal(beforeNext - loan.outstandingVoucherUnits, instalment, "无欠期时每期只收一期月供");
  assert.equal(loan.missedInstalments, 0);
});

test("欠期 欠期未清的户不予放贷；欠期还清后 quote 不再以欠期为由拒绝", () => {
  const state = bankState(403);
  fundBank(state, 100000 * V);
  const target = richHousehold(state);
  const loan = issueLoan(state, target, 400 * V);
  dueWith(state, target, loan, 0);
  assert.equal(loan.missedInstalments, 1);
  const blocked = quoteHouseholdLoan(state, target.id, "shop", householdLiquidValueUnits(state, target, CONTENT) + 100 * V, CONTENT);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /欠期/, "有欠期时拒绝放贷");
  // 到期日本期加欠期共 2 期，付清后欠期归零。
  dueWith(state, target, loan, 2);
  assert.equal(loan.missedInstalments, 0);
  const free = quoteHouseholdLoan(state, target.id, "shop", householdLiquidValueUnits(state, target, CONTENT) + 100 * V, CONTENT);
  assert.doesNotMatch(String(free.reason || ""), /欠期/, "欠期清零后不再因欠期拒绝");
});

test("国债 整户无人：持仓转为镇库自持，死户不再收息、不留持仓，台账与粮券守恒", () => {
  const state = bankState(501);
  const hhs = householdList(state);
  const holder = hhs[0];
  setHouseholdVoucherUnits(state, holder, 20000 * V);
  const r = issueGovernmentBond(state, { totalVoucher: 5000, termYears: 3, rateAnnualPercent: 5 }, CONTENT);
  assert.equal(r.ok, true, r.reason);
  const issue = state.bonds.issues[0];
  assert.equal(householdBondPrincipalMap(state).get(holder.id) > 0, true, "住户持有国债");
  // 整户无人。
  setHouseholdVoucherUnits(state, holder, 0);
  for (const band of ["children", "workers", "elders"]) hhs[7].ageBands[band] += holder.ageBands[band];
  holder.ageBands = { children: 0, workers: 0, elders: 0 };
  holder.jobs = {};
  const totalBefore = totalVoucherBalances(state);
  const result = settleEscheat(state, CONTENT);
  valid(state, "家产归公后");
  assert.equal(isActiveHousehold(holder), false);
  assert.ok(result && result.households >= 1, "只有国债持仓的死户也要归公");
  assert.equal(issue.holdings.some(h => h.holderKey === `household:${holder.id}`), false, "死户持仓已清出");
  assert.equal(issue.holdings.find(h => h.holderKey === "town:town")?.principalVoucherUnits, 5000 * V, "本金转入镇库自持");
  assert.equal(householdBondPrincipalMap(state).has(holder.id), false, "死户不再计入国债持有");
  assert.equal(bondOutstandingVoucherUnits(state) > 0, true, "国债余额不变（只是换了持有人）");
  assert.equal(totalVoucherBalances(state), totalBefore, "粮券总量守恒");
  // 跑一年：票息与本金只在镇库内部流转，死户粮券保持 0。
  state.year = 2;
  state.day = 10;
  const dayIndex = (state.year - 1) * DAYS + state.day;
  issue.lastCouponDayIndex = dayIndex - DAYS;
  const townBefore = totalVoucherBalances(state);
  settleBondsDay(state, CONTENT);
  valid(state, "付息后");
  assert.equal(holder.voucherUnits, 0, "死户钱包不收息");
  assert.equal(totalVoucherBalances(state), townBefore, "付息不改变粮券总量");
  assert.equal(bankLedgerInvariant(state).valid, true, "银行台账守恒");
});

test("国债 持仓转镇库自持后，同期已有镇库持仓时并入，不重复计", () => {
  const state = bankState(502);
  const holder = householdList(state)[0];
  setHouseholdVoucherUnits(state, holder, 20000 * V);
  assert.equal(issueGovernmentBond(state, { totalVoucher: 3000, termYears: 2, rateAnnualPercent: 4 }, CONTENT).ok, true);
  const issue = state.bonds.issues[0];
  const holdingUnits = issue.holdings.find(h => h.holderKey === `household:${holder.id}`).principalVoucherUnits;
  issue.holdings.push({ holderKey: "town:town", principalVoucherUnits: 7 });
  const totalHeld = issue.holdings.reduce((sum, h) => sum + h.principalVoucherUnits, 0);
  const amount = transferBondHoldingsToTown(state, holder.id);
  assert.equal(amount, holdingUnits);
  assert.equal(issue.holdings.length, 1, "镇库持仓并为一条");
  assert.equal(issue.holdings[0].holderKey, "town:town");
  assert.equal(issue.holdings[0].principalVoucherUnits, totalHeld, "本金合计不变");
  valid(state, "并入后");
});

test("国债 旧档含 townOwesBankVoucherUnits 字段照常读取；ensureBondState 不再创建该字段", () => {
  const state = bankState(503);
  const holder = householdList(state)[0];
  setHouseholdVoucherUnits(state, holder, 20000 * V);
  assert.equal(issueGovernmentBond(state, { totalVoucher: 1000, termYears: 2, rateAnnualPercent: 4 }, CONTENT).ok, true);
  const raw = JSON.parse(JSON.stringify(state));
  raw.bonds.townOwesBankVoucherUnits = 0;
  const read = migrateSave(raw, CONTENT);
  valid(read, "旧档读取");
  const fresh = bankState(504);
  const bonds = ensureBondState(fresh);
  assert.equal("townOwesBankVoucherUnits" in bonds, false, "新开局不再带该字段");
});
