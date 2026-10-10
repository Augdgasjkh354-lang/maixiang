// 民间贷款的界面与数据展示：银行面板的闲置现金与住户贷款、居民资金合计、家庭详情的贷款余额与月供。
// selector 只读；这里只检查派生数据与渲染结果。
import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { bankLoanableVoucherUnits, ensureBankState } from "../src/systems/bank.js";
import { householdList } from "../src/systems/households.js";
import { voucherBalance } from "../src/economy/currency.js";
import { renderSite } from "../src/ui/panel-site.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;

function bankState(seed) {
  const state = simulation.createInitialState({ seed });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({ id: "bank-ui", typeId: "bank", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  return state;
}

// 给第一户加一笔在贷住户贷款（600 券余额、50 券月供、欠 1 期），并给银行存一笔存款。
function addHouseholdLoan(state) {
  const household = householdList(state)[0];
  const bank = ensureBankState(state);
  bank.loans.push({
    id: "loan-ui-1", borrowerKind: "household", borrowerId: household.id, purpose: "shop", status: "active",
    principalVoucherUnits: 1000 * V, outstandingVoucherUnits: 600 * V, instalmentVoucherUnits: 50 * V,
    missedInstalments: 1, termMonths: 24, rateAnnualPercent: 5, nextDueDayIndex: 40, overdueDays: 0
  });
  bank.deposits[household.id] = 300 * V;
  return household;
}

test("银行面板：闲置现金与住户贷款两行（笔数 / 余额 / 有欠期）", () => {
  const state = bankState(9301);
  addHouseholdLoan(state);
  const html = renderSite(simulation.selectDashboard(state, { panel: "site", site: "building:bank-ui" }));
  assert.ok(html.includes('<span class="label">闲置现金</span>'), "银行面板应有闲置现金行");
  assert.ok(html.includes("住户贷款（笔数 / 余额 / 有欠期）"), "银行面板应有住户贷款行");
  assert.match(html, /1笔 \/ 600[\d.,]*券 \/ 有欠期1笔/, "住户贷款行应给出笔数、余额与欠期笔数");
  assert.doesNotMatch(html, /小麦结算|货币改革|当前制度/, "文案不应出现已废弃的说法");
});

test("银行面板：闲置现金 = 可贷额度（只读口径与 bankLoanableVoucherUnits 一致）", () => {
  const state = bankState(9302);
  addHouseholdLoan(state);
  const view = simulation.selectDashboard(state, { panel: "site", site: "building:bank-ui" });
  const expected = bankLoanableVoucherUnits(state) / V;
  assert.equal(view.policy.bankStats.idleCashJin, expected);
  assert.equal(view.policy.bankStats.loanableVoucher, expected);
  assert.deepEqual(
    { count: view.policy.bankStats.householdLoans.count, overdueCount: view.policy.bankStats.householdLoans.overdueCount },
    { count: 1, overdueCount: 1 }
  );
  assert.equal(view.policy.bankStats.householdLoans.outstandingJin, 600);
  assert.equal(view.policy.bankStats.householdLoans.instalmentTotalJin, 50);
});

test("居民资金：手头 + 存款合计，拆分可读", () => {
  const state = bankState(9303);
  addHouseholdLoan(state);
  const view = simulation.selectDashboard(state, { panel: "site", site: "building:bank-ui" });
  const hv = view.headerVoucher;
  assert.equal(hv.residentFunds.handJin, voucherBalance(state, "residents") / V);
  assert.equal(hv.residentFunds.depositJin, 300);
  assert.equal(hv.residentFundsJin, hv.residentFunds.handJin + hv.residentFunds.depositJin);
  assert.equal(view.currency.residentFundsJin, hv.residentFundsJin);
  const html = renderSite(view);
  assert.ok(html.includes("镇库 / 居民资金"), "银行面板应显示居民资金合计");
  assert.ok(!html.includes("镇库 / 居民粮券"), "银行面板不应再单独写居民粮券");
});

test("家庭详情：每户带贷款余额、月供与欠期；无贷款的户为 0", () => {
  const state = bankState(9304);
  const borrower = addHouseholdLoan(state);
  const details = simulation.selectDashboard(state, { panel: "residents" }).households.details;
  const row = details.find(item => item.id === borrower.id);
  assert.equal(row.loanBalanceJin, 600);
  assert.equal(row.loanInstalmentJin, 50);
  assert.equal(row.loanMissedInstalments, 1);
  const other = details.find(item => item.id !== borrower.id);
  assert.equal(other.loanBalanceJin, 0);
  assert.equal(other.loanInstalmentJin, 0);
  assert.equal(other.loanMissedInstalments, 0);
});

test("家庭详情：已还清（repaid）的贷款不计入余额与欠期", () => {
  const state = bankState(9305);
  const borrower = addHouseholdLoan(state);
  ensureBankState(state).loans[0].status = "repaid";
  const view = simulation.selectDashboard(state, { panel: "residents" });
  const row = view.households.details.find(item => item.id === borrower.id);
  assert.equal(row.loanBalanceJin, 0);
  assert.equal(view.households.loans.count, 0);
});
