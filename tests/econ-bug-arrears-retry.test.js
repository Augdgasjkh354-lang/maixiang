// 复现：欠薪应"之后每天补付"（见 systems/employer.js 文件头），但 payWages 在发薪日之前一律早退，
// 导致上月 5 号形成的欠薪在下月 1—4 号（发薪日之前）也不补付。
import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { addInventory, transferItem } from "../src/economy/inventory.js";
import { transferVouchers } from "../src/economy/currency.js";
import { payWages, wageArrears, dayOfMonth as employerDayOfMonth } from "../src/systems/employer.js";
import { householdList, householdPopulation } from "../src/systems/households.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const dayOfMonth = state => employerDayOfMonth(state, CONTENT);

function bookOf(state, key) {
  const payroll = state.payroll;
  return {
    claimsVoucherUnits: payroll.creditorClaims?.[key] || {},
    claimsPayment: payroll.creditorPaymentClaims?.[key] || {},
    pendingByMonth: payroll.creditorPending?.[key] || {}
  };
}

function fundTown(state, jin) {
  transferItem(state, "residents", "town", "wheat", jin, "测试补充镇库小麦", CONTENT);
  assert.equal(simulation.issueGrainVouchers(state, "town", jin).ok, true);
}

test("欠薪每天补付：下月 1—4 号（发薪日前）镇库有钱时，欠薪也应补付", () => {
  const state = legacyVoucherState({ seed: 12 });
  addInventory(state, "town", "wood", 600, "测试木材", "test", CONTENT);
  const start = simulation.buildAt(state, "mill", "east");
  assert.ok(start, "需要能建磨坊");
  assert.equal(simulation.issueGrainVouchers(state, "town", 5000).ok, true);
  simulation.advanceDays(state, 40);
  const key = `${start.instanceId}::millers`;
  assert.equal(simulation.setEmployment(state, key, 2).ok, true);
  simulation.setWageRate(state, "millers", 5);
  for (let i = 0; i < 120 && Object.keys(state.payroll.creditorClaims || {}).some(k => k.startsWith("builders::") && wageArrears(bookOf(state, k)) > 0); i += 1) {
    simulation.advanceDay(state);
  }
  simulation.toggleAutomaticRelief(state, false);
  assert.equal(transferVouchers(state, "town", "residents", state.currency.balances.town, CONTENT, "test_drain", "测试：镇库没钱").ok, true);
  const book = () => bookOf(state, key);
  // 推进到 5 号当天之后：5 号起镇库没钱，欠薪形成。
  while (dayOfMonth(state) !== 5) simulation.advanceDay(state);
  simulation.advanceDay(state);
  const owed = wageArrears(book());
  assert.ok(owed > 0, "5 号应形成欠薪");
  // 推进到下月 1 号（当天结算前）：期间镇库一直没钱，欠薪保持。
  while (dayOfMonth(state) !== 1) simulation.advanceDay(state);
  assert.equal(wageArrears(book()), owed, "月末前欠薪应保持不变");
  // 下月 1 号开始镇库有钱：欠薪应当天补付（发薪日 5 号之前也要补付已到期的欠薪）。
  // 镇库给够所有工种的欠薪（建造工的欠薪排在前面，不能只给磨坊工）。
  const allArrears = Object.keys(state.payroll.creditorClaims).reduce((sum, k) => sum + wageArrears(bookOf(state, k)), 0);
  fundTown(state, Math.ceil(allArrears / CONTENT.precision.currencyUnitsPerVoucher) + 10);
  simulation.advanceDay(state);
  assert.ok(wageArrears(book()) < owed, "下月 1 号镇库有钱，欠薪应补付而不是等到 5 号");
});

// 复现：已无人的户（人口为 0）的工资债权不应被镇库付给空户（空户随后家产归公会把钱原样收回镇库，等于镇库付给镇库）。
test("空户的工资债权不付：镇库有钱也不付给无人家庭，债权留账", () => {
  const state = simulation.createInitialState({ seed: 130105 });
  const empty = householdList(state)[0];
  for (const band of Object.keys(empty.ageBands)) empty.ageBands[band] = 0;
  assert.equal(householdPopulation(empty), 0);
  const book = { claimsVoucherUnits: { [empty.id]: 9 * CONTENT.precision.currencyUnitsPerVoucher }, claimsPayment: {}, pendingByMonth: {} };
  const townBefore = state.currency.balances.town;
  assert.ok(townBefore > 0, "测试前镇库应有粮券");
  const result = payWages(state, book, "town", CONTENT, "wage_payment", "测试", {});
  assert.equal(result.paid, 0);
  assert.equal(book.claimsVoucherUnits[empty.id], 9 * CONTENT.precision.currencyUnitsPerVoucher, "空户债权保留");
  assert.equal(state.currency.balances.town, townBefore, "镇库粮券不变");
});
