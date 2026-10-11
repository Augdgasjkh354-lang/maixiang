import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { settleHouseholdStockBuying } from "../src/systems/stock-exchange.js";
import { voucherBalance, totalVoucherBalances } from "../src/economy/currency.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { V, assertValid, giveHoldings, listedState, onlyBudget } from "./helpers-stock.js";
import { householdList } from "../src/systems/households.js";

// 印花税（docs/STOCK.md）：二级市场每笔成交按成交额由卖方承担，交镇库；镇库自己卖出不征；一级发行与回购不征。

test("印花税：居民卖方承担，税额归镇库，买方付全额，粮券总量守恒", () => {
  const { state, company } = listedState({ offer: 0, price: 2 });
  const [seller, buyer] = householdList(state);
  giveHoldings(state, company, { [seller.id]: 300 });
  company.shareSale.sellerOwner = seller.id;
  company.shareSale.offeredShares = 100;
  assert.equal(grantResidentVouchers(state, 1000, CONTENT, buyer.id).ok, true);
  onlyBudget(state, buyer.id, 1000 * V);
  const cost = 100 * company.shareSale.sharePriceVoucherUnits;
  const duty = Math.round(cost * CONTENT.rules.stampDutyDefaultPercent / 100);
  assert.equal(state.policy.stampDutyPercent, CONTENT.rules.stampDutyDefaultPercent, "开局默认印花税率");
  const sellerBefore = voucherBalance(state, `household:${seller.id}`);
  const buyerBefore = voucherBalance(state, `household:${buyer.id}`);
  const townBefore = voucherBalance(state, "town");
  const totalBefore = totalVoucherBalances(state);
  const trade = settleHouseholdStockBuying(state, CONTENT);
  assert.equal(trade.shares, 100);
  assert.equal(buyerBefore - voucherBalance(state, `household:${buyer.id}`), cost, "买方付全额股款");
  assert.equal(voucherBalance(state, `household:${seller.id}`) - sellerBefore, cost - duty, "卖方收到股款减印花税");
  assert.equal(voucherBalance(state, "town") - townBefore, duty, "印花税归镇库");
  assert.equal(totalVoucherBalances(state), totalBefore, "粮券总量不变（只是转移）");
  assert.equal(state.stampDuty.day.stampDutyUnits, duty);
  assert.equal(state.stampDuty.year.stampDutyUnits, duty);
  assert.equal(state.stampDuty.cumulative.stampDutyUnits, duty);
  assertValid(state, "居民卖方印花税后");
});

test("印花税：镇库卖出（发行池为镇库）不征", () => {
  const { state, company } = listedState({ offer: 300, price: 2 });
  const buyer = householdList(state)[0];
  assert.equal(grantResidentVouchers(state, 1000, CONTENT, buyer.id).ok, true);
  onlyBudget(state, buyer.id, 1000 * V);
  const cost = 300 * company.shareSale.sharePriceVoucherUnits;
  const townBefore = voucherBalance(state, "town");
  const trade = settleHouseholdStockBuying(state, CONTENT);
  assert.equal(trade.shares, 300, "预算 1000 券够买下 300 股发行池");
  assert.equal(trade.stampDutyVoucherUnits, 0);
  assert.equal(voucherBalance(state, "town") - townBefore, cost, "镇库只收股款，不收税");
  assert.equal(state.stampDuty.cumulative.stampDutyUnits || 0, 0, "印花税账不记镇库卖出");
  assertValid(state, "镇库卖出后");
});

test("印花税率：政策可调 0—5，两位小数；越界或非数拒绝；0% 时不征", () => {
  const { state, company } = listedState({ offer: 100, price: 2 });
  assert.equal(simulation.setStampDuty(state, 0.256).value, 0.26, "两位小数取整");
  assert.equal(state.policy.stampDutyPercent, 0.26);
  assert.equal(simulation.setStampDuty(state, 5).ok, true, "上限 5% 可设");
  assert.equal(simulation.setStampDuty(state, 5.01).ok, false);
  assert.equal(simulation.setStampDuty(state, -0.1).ok, false);
  assert.equal(simulation.setStampDuty(state, "abc").ok, false);
  assert.equal(simulation.setStampDuty(state, "").ok, false);
  assert.equal(simulation.setStampDuty(state, null).ok, false);
  assert.equal(state.policy.stampDutyPercent, 5, "拒绝的设置不改政策");
  assert.equal(simulation.setStampDuty(state, 0).ok, true);
  const seller = householdList(state)[0];
  giveHoldings(state, company, { [seller.id]: 100 });
  company.shareSale.sellerOwner = seller.id;
  company.shareSale.offeredShares = 50;
  const buyer = householdList(state)[1];
  assert.equal(grantResidentVouchers(state, 500, CONTENT, buyer.id).ok, true);
  onlyBudget(state, buyer.id, 500 * V);
  const sellerBefore = voucherBalance(state, `household:${seller.id}`);
  const trade = settleHouseholdStockBuying(state, CONTENT);
  assert.equal(trade.shares, 50);
  assert.equal(voucherBalance(state, `household:${seller.id}`) - sellerBefore, 50 * company.shareSale.sharePriceVoucherUnits, "税率 0 时卖方收全额");
  assert.equal(state.stampDuty.cumulative.stampDutyUnits || 0, 0);
  assertValid(state, "零税率成交后");
});

test("印花税不适用一级：镇库回购股份不征", () => {
  const { state, company } = listedState({ offer: 0, price: 1 });
  const seller = householdList(state)[0];
  giveHoldings(state, company, { [seller.id]: 100 });
  const sellerBefore = voucherBalance(state, `household:${seller.id}`);
  const result = simulation.buybackCompanyShares(state, company.id, { shares: 50, priceVoucherPerShare: 1 });
  assert.equal(result.ok, true, result.reason);
  assert.equal(voucherBalance(state, `household:${seller.id}`) - sellerBefore, 50 * V, "回购全额付给居民");
  assert.equal(state.stampDuty.cumulative.stampDutyUnits || 0, 0, "回购不征印花税");
  assertValid(state, "回购后");
});
