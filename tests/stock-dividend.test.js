import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { companySummary, exRightsOffsetUnits, injectCompanyCapital, payListedDividends } from "../src/systems/companies.js";
import { shareTick, totalVoucherBalances, voucherBalance } from "../src/economy/currency.js";
import { V, assertValid, giveHoldings, listedState } from "./helpers-stock.js";
import { householdList } from "../src/systems/households.js";

// 季度分红与除权（docs/STOCK.md）：每 90 天按近一季净利润 × 分红比例发放，按持股入账；除权日股价下调一股分红额，业绩锚同额下移并逐日回升。

const DAYS_IN_QUARTER = 90;

// 一家盈利的上市公司：近一季每天利润 1000 粮券单位×V，镇库控股 700 股，两户居民 300 股；公司现金充足，无营运资金储备。
function profitableState({ profitPerDay = 1000 } = {}) {
  const { state, company } = listedState({ offer: 0, price: 2, seed: 9911, totalShares: 1000 });
  const [a, b] = householdList(state);
  giveHoldings(state, company, { [a.id]: 200, [b.id]: 100 });
  assert.equal(injectCompanyCapital(state, company.id, 5000, CONTENT).ok, true);
  company.settings.targetWorkers = 0;
  company.history = [];
  for (let serial = 0; serial < DAYS_IN_QUARTER - 1; serial += 1) {
    company.history.push({ serial, soldUnits: 0, producedUnits: 0, revenueVoucherUnits: 0, inputPurchaseVoucherUnits: 0, wageExpenseVoucherUnits: 0, profitVoucherUnits: profitPerDay });
  }
  company.retainedEarningsVoucherUnits = 10000000;
  state.year = 1;
  state.day = DAYS_IN_QUARTER - 1; // 第 90 天
  return { state, company, a, b };
}

test("分红：按近一季净利润 × 分红比例，按持股入账（居民、镇库）", () => {
  const { state, company, a, b } = profitableState();
  assert.equal(company.payoutPercent, undefined, "未设置时用民营默认 60%");
  const profit = (DAYS_IN_QUARTER - 1) * 1000;
  const target = Math.floor(profit * CONTENT.rules.sharePayoutDefaultPercent / 100);
  const perShare = Math.floor(target / company.totalShares);
  const retainedBefore = company.retainedEarningsVoucherUnits;
  const aBefore = voucherBalance(state, `household:${a.id}`);
  const bBefore = voucherBalance(state, `household:${b.id}`);
  const townBefore = voucherBalance(state, "town");
  const companyBefore = voucherBalance(state, `company:${company.id}`);
  const totalBefore = totalVoucherBalances(state);
  const rows = payListedDividends(state, CONTENT);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.perShareVoucherUnits, perShare);
  assert.equal(row.payoutPercent, 60);
  assert.equal(voucherBalance(state, `household:${a.id}`) - aBefore, 200 * perShare, "户 A 按 200 股入账");
  assert.equal(voucherBalance(state, `household:${b.id}`) - bBefore, 100 * perShare, "户 B 按 100 股入账");
  assert.equal(voucherBalance(state, "town") - townBefore, 700 * perShare, "镇库按 700 股入账");
  assert.equal(companyBefore - voucherBalance(state, `company:${company.id}`), 1000 * perShare, "公司只付出每股分红的总额");
  assert.equal(company.retainedEarningsVoucherUnits, retainedBefore - 1000 * perShare, "未分配利润相应减少");
  assert.equal(totalVoucherBalances(state), totalBefore, "分红只是转移，粮券总量守恒");
  assert.equal(company.quarterlyDividends.at(-1).perShareVoucherUnits, perShare);
  assertValid(state, "季度分红后");
});

test("分红日判定：只在第 90/180/270/360 天（每 90 天）分红", () => {
  const { state } = profitableState();
  state.day = 88; // 第 89 天
  assert.deepEqual(payListedDividends(state, CONTENT), []);
  state.day = 89;
  assert.equal(payListedDividends(state, CONTENT).length, 1);
});

test("除权：分红日股价下调一股分红额（至少一档），业绩锚同额下移", () => {
  const { state, company } = profitableState();
  const priceBefore = company.sharePriceVoucherUnits;
  const [row] = payListedDividends(state, CONTENT);
  const tick = shareTick(CONTENT);
  const drop = Math.max(tick, Math.round(row.perShareVoucherUnits / tick) * tick);
  assert.equal(row.exDropVoucherUnits, drop);
  assert.equal(company.sharePriceVoucherUnits, priceBefore - drop, "除权日股价下调");
  assert.equal(company.stockMarket.exRights.offsetUnits, drop, "业绩锚下移额 = 除权额");
  assert.equal(row.priceAfterVoucherUnits, company.sharePriceVoucherUnits);
});

test("除权：业绩锚下移额逐日线性回升，90 天后回到应有水平", () => {
  const { state, company } = profitableState();
  payListedDividends(state, CONTENT);
  const market = company.stockMarket;
  const absDay = (state.year - 1) * CONTENT.rules.daysPerYear + state.day;
  const full = market.exRights.offsetUnits;
  assert.equal(exRightsOffsetUnits(market, absDay, CONTENT), full, "除权当日整额");
  assert.ok(Math.abs(exRightsOffsetUnits(market, absDay + 45, CONTENT) - full / 2) <= 1, "45 天回到一半");
  assert.equal(exRightsOffsetUnits(market, absDay + 90, CONTENT), 0, "90 天回满");
  assert.equal(exRightsOffsetUnits(market, absDay + 200, CONTENT), 0);
});

test("分红比例：镇库控股公司由镇长设置（0—100），民营上市公司不可设", () => {
  const { state, company } = profitableState();
  assert.equal(simulation.configureDividend(state, company.id, 80).ok, true, "镇库持股 70%，可设");
  assert.equal(company.payoutPercent, 80);
  assert.equal(simulation.configureDividend(state, company.id, 101).ok, false);
  assert.equal(simulation.configureDividend(state, company.id, -1).ok, false);
  assert.equal(simulation.configureDividend(state, company.id, "abc").ok, false);
  // 把镇库持股降到一半以下：民营上市公司，镇长不能改。
  company.townShares = 300; company.residentShares = 700;
  assert.equal(simulation.configureDividend(state, company.id, 30).ok, false, "民营上市公司分红比例由公司自定");
  assert.equal(company.payoutPercent, 80, "被拒绝的设置不改比例");
});

test("分红：没有利润、欠薪或无可分配额时不分红、不除权", () => {
  const loss = profitableState({ profitPerDay: -500 });
  const priceLoss = loss.company.sharePriceVoucherUnits;
  assert.deepEqual(payListedDividends(loss.state, CONTENT), [], "亏损不分红");
  assert.equal(loss.company.sharePriceVoucherUnits, priceLoss, "不除权");

  const arrears = profitableState();
  arrears.company.payroll.arrearsVoucherUnits = 1;
  assert.deepEqual(payListedDividends(arrears.state, CONTENT), [], "欠薪不分红");

  const capped = profitableState();
  capped.company.retainedEarningsVoucherUnits = 0;
  assert.deepEqual(payListedDividends(capped.state, CONTENT), [], "未分配利润为零时不分红");
  assertValid(capped.state, "分红无可分配额");
});

test("分红：摘要给出分红比例、最近一次每股分红与股息率", () => {
  const { state, company } = profitableState();
  payListedDividends(state, CONTENT);
  company.sharePriceVoucherUnits = 100 * V;
  const summary = companySummary(state, company, CONTENT);
  assert.equal(summary.payoutPercent, 60);
  assert.equal(summary.payoutControllable, true);
  assert.equal(summary.lastDividend.perShareVoucher, company.quarterlyDividends.at(-1).perShareVoucherUnits / V);
  const expected = company.quarterlyDividends.at(-1).perShareVoucherUnits * 4 / (100 * V) * 100;
  assert.ok(Math.abs(summary.dividendYieldPercent - expected) < 1e-9, "股息率 = 每股分红 × 4 ÷ 股价");
});

test("旧档读取：没有印花税、分红比例、净流量字段的存档读入后可用", async () => {
  const { migrateSave } = await import("../src/persistence/migrations.js");
  const { state, company } = listedState({ offer: 0, price: 2 });
  delete state.stampDuty;
  delete state.policy.stampDutyPercent;
  company.stockMarket.flow = undefined;
  const raw = JSON.parse(JSON.stringify(state));
  const migrated = migrateSave(raw, CONTENT);
  assert.equal(migrated.policy.stampDutyPercent, CONTENT.rules.stampDutyDefaultPercent, "底板补默认印花税率");
  assert.ok(migrated.stampDuty, "底板补印花税账");
  assert.equal(migrated.companies[company.id].payoutPercent, undefined, "分红比例未设置时用默认");
  assertValid(migrated, "旧档读取后");
});
