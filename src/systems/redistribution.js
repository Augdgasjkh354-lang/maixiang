// 再分配工具箱（docs/REDISTRIBUTION.md 第 1、2 条）：富人税、遗产税、家产归公，以及贫富基尼统计。
//
// 征税口径（家底，全口径）= 粮券 + 银行存款 + 超出口粮储备的小麦（householdWealthUnits）
//                 + 股票市值（household.shares × 公司实时股价）+ 名下民营建筑估值（operating-rights 整栋估值）
//                 + 名下存续国债本金（bonds.js 的 holdings，按户汇总）。贫富统计（基尼、最富占比）同口径。
// - 富人税：每 30 天（日序号 % 30 === 0）按人均家底超额累进；年税率 ÷ 12 作为当月应纳。
//   付款顺序由支付层决定：粮券 → 存款 → 小麦；小麦不动口粮储备；付不起的当月免征，不卖股、不卖楼。
// - 遗产税：年终人口结算时，有成年人去世的家庭按去世份额征收，超过第一档门槛 × 去世人数的部分按税率计。
// - 家产归公：家庭人口归零（整户失效）时，粮券、存款、库存、股票、民营建筑全部归镇库 / 镇营，不受税率影响。
//   存款取回 = 银行现金不够时镇库垫付（银行欠镇库），取不回的部分留在存款台账，由每日 escheat 步骤再试。
//
// 富人税与遗产税的付款都经 settleMonetaryPayment，镇库是收款方；家产归公走 transferVouchers / 镇库库存直接入账。

import { currencyScale, transferVouchers } from "../economy/currency.js";
import { currentPaymentComposition, depositWithdrawableUnits, settleMonetaryPayment } from "../economy/payment.js";
import { withdrawFromBank } from "../economy/deposits.js";
import { addTownCostBasis, quoteTownCostRemoval } from "../economy/business.js";
import { recordEvent, recordLedger, makeTransactionId } from "../economy/ledger.js";
import { bookAdd, ensureBook } from "../economy/books.js";
import { qeqUnitsForInventoryUnits } from "../economy/inventory.js";
import { householdList, householdPopulation, isActiveHousehold, householdConvertibleWheatUnits, syncResidentAggregates, withDeferredHouseholdSync } from "./households.js";
import { daysUntilHarvest, householdWealthUnits } from "./household-budget.js";
import { wholesalePrice } from "./wholesale-price.js";
import { householdBondPrincipalMap } from "./bonds.js";
import { buildingOwner, ownershipWatch, transferBuildingOwnership, valueUnitsOfGoods } from "./ownership.js";
import { transferWageClaimsToTown, wageBook } from "./employer.js";
import { jobKeyForBuilding } from "../selectors/labor.js";
import { selectOperatingRightPreview } from "../selectors/operating-rights.js";
import { ensureVillaState } from "./villas.js";
import { shopsAwaitingSuccession, succeedShopsOfHousehold } from "./shops.js";

// 政策默认值（政策页可调；写在这里，内容规则里可用 content.rules 覆盖）。
const DEFAULT_WEALTH_TAX_THRESHOLDS = [300, 1000, 3000];
const DEFAULT_WEALTH_TAX_RATES_PERCENT = [0, 0, 0];
const WEALTH_TAX_RATE_MAX_PERCENT = 20;
const INHERITANCE_TAX_RATE_MAX_PERCENT = 50;
const DEFAULT_INHERITANCE_TAX_PERCENT = 0;

export function wealthTaxPeriodDays(content) {
  return content.rules.wealthTaxPeriodDays ?? 30;
}

export function giniHistoryLimit(content) {
  return content.rules.giniHistoryLimit ?? 50;
}

export function wealthTaxPolicy(state) {
  const policy = state.policy?.wealthTax || {};
  const thresholds = Array.isArray(policy.thresholds) && policy.thresholds.length === DEFAULT_WEALTH_TAX_THRESHOLDS.length
    ? policy.thresholds.map(Number) : DEFAULT_WEALTH_TAX_THRESHOLDS.slice();
  const ratesPercent = Array.isArray(policy.ratesPercent) && policy.ratesPercent.length === thresholds.length
    ? policy.ratesPercent.map(Number) : DEFAULT_WEALTH_TAX_RATES_PERCENT.slice();
  return { thresholds, ratesPercent };
}

export function inheritanceTaxPercent(state) {
  const value = Number(state.policy?.inheritanceTaxPercent ?? DEFAULT_INHERITANCE_TAX_PERCENT);
  return Number.isFinite(value) ? value : DEFAULT_INHERITANCE_TAX_PERCENT;
}

// 账本：day / year / cumulative 三段（books.js 约定）。lastRun 记最近一次富人税评估（给面板看税档人家数）。
export function blankRedistributionRow() {
  return {
    wealthTaxDueUnits: 0, wealthTaxUnits: 0, wealthTaxWaivedUnits: 0, wealthTaxPayers: 0,
    inheritanceTaxUnits: 0, inheritancePayers: 0,
    escheatUnits: 0, escheatHouseholds: 0, escheatShares: 0, escheatBuildings: 0, escheatVillas: 0
  };
}

export function ensureRedistribution(state) {
  state.redistribution ||= {};
  ensureBook(state.redistribution, blankRedistributionRow);
  if (state.redistribution.lastRun === undefined) state.redistribution.lastRun = null;
  if (!Array.isArray(state.redistribution.giniHistory)) state.redistribution.giniHistory = [];
  return state.redistribution;
}

export function resetRedistributionDay(state) {
  ensureRedistribution(state).day = blankRedistributionRow();
}

export function resetRedistributionYear(state) {
  ensureRedistribution(state).year = blankRedistributionRow();
}

function daySerialOf(state, content) {
  return (Math.max(1, state.year || 1) - 1) * (content.rules.daysPerYear || 365) + (state.day || 0);
}

// 每 30 天收一次富人税（日序号 % 30 === 0）。日结步骤 wealthTax 的 when。
export function isWealthTaxDay(state, content) {
  return daySerialOf(state, content) % wealthTaxPeriodDays(content) === 0;
}

// 单户征税口径（内部单位）：粮券 + 存款 + 超额小麦 + 股票市值 + 民营建筑估值 + 国债本金。给面板与测试用；富人税、遗产税与贫富统计共用同一口径。
export function householdTaxableWealthUnits(state, household, content) {
  return taxBaseUnits(state, household, content, wealthContext(state, content));
}

// 年度累进：一户人均家底 w（券）下的年应纳税（券／人）。
// 第 k 档覆盖 [thresholds[k], thresholds[k+1]) 且税率 ratesPercent[k]；最后一档无上限。
export function wealthTaxPerCapitaPerYear(perCapitaVouchers, thresholds, ratesPercent) {
  let tax = 0;
  for (let k = 0; k < thresholds.length; k += 1) {
    const upper = k + 1 < thresholds.length ? thresholds[k + 1] : Infinity;
    const band = Math.max(0, Math.min(perCapitaVouchers, upper) - thresholds[k]);
    tax += band * (ratesPercent[k] || 0) / 100;
  }
  return tax;
}

// 家底里的私有建筑估值：每栋民营建筑按整栋估值（operating-rights 的参考价，粮券）折成券值，按业主家庭汇总。
// 每次调用只算一遍（选择器较重）。
function privateBuildingValuations(state, content) {
  const byHousehold = new Map();
  const scale = currencyScale(content);
  for (const building of state.buildings || []) {
    if (!((building.ownership?.privateLevels || 0) > 0)) continue;
    const owner = buildingOwner(state, building);
    if (owner.kind !== "household" || !owner.id) continue;
    const quote = selectOperatingRightPreview(state, building.id, content, null);
    const units = Math.max(0, Math.round((Number(quote?.referencePriceWheatJin) || 0) * scale));
    if (units > 0) byHousehold.set(owner.id, (byHousehold.get(owner.id) || 0) + units);
  }
  return byHousehold;
}

function shareValueUnits(state, household) {
  let total = 0;
  for (const [companyId, count] of Object.entries(household.shares || {})) {
    const shares = Math.max(0, Math.floor(Number(count) || 0));
    const company = state.companies?.[companyId];
    if (!shares || !company?.listing?.listed) continue;
    total += shares * Math.max(0, company.sharePriceVoucherUnits || 0);
  }
  return total;
}

// 全口径家底所需的全镇一次性汇总（只读）：民营建筑估值（按户）与国债本金（按户）。每次调用只算一遍。
function wealthContext(state, content) {
  return { valuations: privateBuildingValuations(state, content), bonds: householdBondPrincipalMap(state) };
}

// 征税口径（单位：内部货币单位）。
function taxBaseUnits(state, household, content, ctx) {
  return householdWealthUnits(state, household, content)
    + shareValueUnits(state, household)
    + (ctx.valuations.get(household.id) || 0)
    + (ctx.bonds.get(household.id) || 0);
}

function ownedPrivateBuildings(state, householdId) {
  return (state.buildings || []).filter(building =>
    (building.ownership?.privateLevels || 0) > 0 && building.privateOwners?.[0] === householdId);
}

// 付款：每户按应纳额付给镇库；付不起的部分免征。返回实收与缴纳户数。
function collectFromHouseholds(state, content, rows, type, label) {
  let collected = 0;
  let payers = 0;
  withDeferredHouseholdSync(state, content, () => {
    for (const { household, dueUnits } of rows) {
      const result = settleMonetaryPayment(state, `household:${household.id}`, "town",
        currentPaymentComposition(state, dueUnits), content, type, `${household.name}${label}`,
        {
          requireFull: false,
          // 只动"到下次秋收再加 30 天"以外的余粮（和家底口径一致），不让收税吃掉下一季口粮。
          maxWheatUnits: householdConvertibleWheatUnits(state, household, content,
            daysUntilHarvest(state, content) + (content.rules.householdBudget?.harvestBufferDays ?? 30))
        });
      const paid = result.paidValueUnits || 0;
      collected += paid;
      if (paid > 0) payers += 1;
    }
  });
  return { collected, payers };
}

// 富人税：日结步骤 wealthTax（isWealthTaxDay 为真时运行）。
export function settleWealthTax(state, content) {
  const scale = currencyScale(content);
  const { thresholds, ratesPercent } = wealthTaxPolicy(state);
  const ctx = wealthContext(state, content);
  // brackets[0] 为免征档（人均家底低于第一档门槛），brackets[k] 为第 k 档（税率 ratesPercent[k-1]）。
  const brackets = Array.from({ length: thresholds.length + 1 }, (_, index) => ({ index, households: 0, people: 0 }));
  const rows = [];
  let activeHouseholds = 0;
  let dueTotal = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    activeHouseholds += 1;
    const people = householdPopulation(household);
    const perCapita = taxBaseUnits(state, household, content, ctx) / scale / people;
    const bracket = thresholds.filter(threshold => perCapita >= threshold).length;
    brackets[bracket].households += 1;
    brackets[bracket].people += people;
    const annualVouchers = people * wealthTaxPerCapitaPerYear(perCapita, thresholds, ratesPercent);
    const dueUnits = Math.floor(annualVouchers / 12 * scale + 1e-9);
    if (dueUnits > 0) { rows.push({ household, dueUnits }); dueTotal += dueUnits; }
  }
  const { collected, payers } = collectFromHouseholds(state, content, rows, "wealth_tax", "缴纳富人税");
  const book = ensureRedistribution(state);
  bookAdd(book, "wealthTaxDueUnits", dueTotal);
  bookAdd(book, "wealthTaxUnits", collected);
  bookAdd(book, "wealthTaxWaivedUnits", dueTotal - collected);
  bookAdd(book, "wealthTaxPayers", payers);
  book.lastRun = {
    year: state.year, day: state.day + 1, households: activeHouseholds,
    dueUnits: dueTotal, collectedUnits: collected, payers,
    thresholds: thresholds.slice(), ratesPercent: ratesPercent.slice(), brackets
  };
  if (dueTotal > 0) {
    recordEvent(state, `富人税本月应纳${Math.round(dueTotal / scale)}券，实收${Math.round(collected / scale)}券，${payers}户缴纳，付不起的部分免征。`, content, { day: state.day + 1 });
  }
  return { dueUnits: dueTotal, collectedUnits: collected, payers, brackets };
}

// 遗产税第一步：年终人口变动之前，记下每户的家底与成年人数（只有税率 > 0 时才需要）。
export function snapshotEstates(state, content) {
  if (!(inheritanceTaxPercent(state) > 0)) return null;
  const ctx = wealthContext(state, content);
  const snapshot = new Map();
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    snapshot.set(household.id, {
      wealthUnits: taxBaseUnits(state, household, content, ctx),
      adultsBefore: Math.max(0, household.ageBands?.workers || 0) + Math.max(0, household.ageBands?.elders || 0)
    });
  }
  return snapshot;
}

// 遗产税第二步：份额 = 家底 × 去世成年人数 ÷ 去世前成年人数；超过 第一档门槛 × 去世人数 的部分按税率计。
// 整户失效的家庭不在这里征税（全部归镇库，见 settleEscheat）。
function settleInheritanceTax(state, content, snapshot, deathsByHousehold) {
  const percent = Math.min(INHERITANCE_TAX_RATE_MAX_PERCENT, Math.max(0, inheritanceTaxPercent(state)));
  if (!(percent > 0) || !snapshot) return { taxUnits: 0, payers: 0 };
  const scale = currencyScale(content);
  const { thresholds } = wealthTaxPolicy(state);
  const rows = [];
  let dueTotal = 0;
  for (const [householdId, deaths] of Object.entries(deathsByHousehold || {})) {
    const household = state.households?.byId?.[householdId];
    const before = snapshot.get(householdId);
    if (!household || !before || before.adultsBefore <= 0 || deaths <= 0) continue;
    if (!isActiveHousehold(household)) continue;
    const share = before.wealthUnits * deaths / before.adultsBefore;
    const exempt = thresholds[0] * scale * deaths;
    const dueUnits = Math.floor(Math.max(0, share - exempt) * percent / 100);
    if (dueUnits > 0) { rows.push({ household, dueUnits }); dueTotal += dueUnits; }
  }
  const { collected, payers } = collectFromHouseholds(state, content, rows, "inheritance_tax", "缴纳遗产税");
  const book = ensureRedistribution(state);
  bookAdd(book, "inheritanceTaxUnits", collected);
  bookAdd(book, "inheritancePayers", payers);
  if (dueTotal > 0) {
    recordEvent(state, `遗产税本年实收${Math.round(collected / scale)}券，${payers}户缴纳。`, content, { day: state.day + 1 });
  }
  return { taxUnits: collected, dueUnits: dueTotal, payers };
}

// 家产归公的一户：有无可归公的东西（粮券、存款、库存、股票、民营建筑、民营工资债）。
function householdHasEscheatableAssets(state, household) {
  if ((household.voucherUnits || 0) > 0) return true;
  if ((state.bank?.deposits?.[household.id] || 0) > 0) return true;
  if (Object.values(household.inventory || {}).some(units => units > 0)) return true;
  if (Object.values(household.shares || {}).some(count => count > 0)) return true;
  if ((state.villas?.sold || []).some(row => row.householdId === household.id)) return true;
  // 店铺在等业主更替（无人接手时也算，直到有人接手或店铺关闭）。
  if (shopsAwaitingSuccession(state, household.id).length > 0) return true;
  return ownedPrivateBuildings(state, household.id).length > 0;
}

// 把一户的家产全部划给镇库（粮券、存款、库存、股票）；民营建筑整栋收归镇营。
function escheatHousehold(state, household, content) {
  const id = household.id;
  const owner = `household:${id}`;
  const scale = currencyScale(content);
  const reason = `${household.name}整户失效，家产归镇库`;
  const totals = { voucherUnits: 0, inventoryValueUnits: 0, shareCount: 0, buildingCount: 0, villaCount: 0 };

  // 1. 存款：银行现金不够时镇库可垫付（记为银行欠镇库），两者都不够才取不回；取不回的留在存款台账，之后每日再试。
  const deposit = Math.max(0, state.bank?.deposits?.[id] || 0);
  const takeable = Math.min(deposit, depositWithdrawableUnits(state, owner));
  // 只剩取不回的存款：这一次什么也动不了，不记事件，等银行有现金再办。
  const movable = takeable > 0 || (household.voucherUnits || 0) > 0 || ownedPrivateBuildings(state, id).length > 0
    || Object.values(household.inventory || {}).some(units => units > 0)
    || Object.values(household.shares || {}).some(count => count > 0);
  // 别墅与店铺不取决于现金：即使其余家产动不了，也要交接（店铺）或空置（别墅）。
  const villaRows = (state.villas?.sold || []).filter(row => row.householdId === id);
  if (!movable && !villaRows.length && !shopsAwaitingSuccession(state, id).length) return null;
  if (takeable > 0) {
    const result = withdrawFromBank(state, id, takeable, content);
    if (!result.ok) throw new Error("家产归公取款预检后失败：" + result.reason);
  }

  // 2. 粮券（含刚取回的存款）→ 镇库。
  const vouchers = Math.max(0, household.voucherUnits || 0);
  if (vouchers > 0) {
    const result = transferVouchers(state, owner, "town", vouchers, content, "escheat_voucher", reason);
    if (!result.ok) throw new Error("家产归公粮券划转失败：" + result.reason);
    totals.voucherUnits = vouchers;
  }

  // 3. 库存 → 镇库库存。先按当前镇库存量初始化成本账，再加入库存，避免成本基数被跳过。
  for (const [itemId, units] of Object.entries(household.inventory || {})) {
    const amount = Math.max(0, Math.floor(units || 0));
    if (amount <= 0 || !content.items[itemId]) continue;
    quoteTownCostRemoval(state, itemId, 0, content);
    const value = valueUnitsOfGoods(amount, wholesalePrice(state, itemId, content), content);
    state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + amount;
    addTownCostBasis(state, itemId, value);
    totals.inventoryValueUnits += value;
    const transactionId = makeTransactionId(state);
    recordLedger(state, {
      type: "escheat", transactionId, source: owner, destination: "town", itemId, quantityUnits: amount,
      qeqUnits: qeqUnitsForInventoryUnits(content.items[itemId], amount, content), reason
    }, content);
    household.inventory[itemId] = 0;
  }

  // 4. 股票 → 镇库持股（逐户持股表与公司居民持股同步减，镇库持股同步加，总量守恒）。
  for (const [companyId, count] of Object.entries(household.shares || {})) {
    const company = state.companies?.[companyId];
    const shares = Math.max(0, Math.floor(Number(count) || 0));
    if (company && shares > 0) {
      const held = company.householdShares?.[id] || 0;
      const moved = Math.min(shares, held);
      if (moved > 0) {
        company.householdShares[id] = held - moved;
        if (company.householdShares[id] <= 0) delete company.householdShares[id];
        company.residentShares = Math.max(0, (company.residentShares || 0) - moved);
        company.townShares = (company.townShares || 0) + moved;
        totals.shareCount += moved;
      }
    }
    if (company?.shareSale?.sellerOwner === id) {
      // 发行池卖方是这户：卖方改为镇库，挂出股数不超过镇库持股。
      company.shareSale.sellerOwner = "town";
      company.shareSale.offeredShares = Math.min(company.shareSale.offeredShares || 0, company.townShares || 0);
    }
  }
  household.shares = {};

  // 5. 民营建筑 → 镇营。业主名下的民营工资债权转给镇库（与收回民营建筑一致），业主不再得到补偿。
  for (const building of ownedPrivateBuildings(state, id)) {
    const definition = content.buildings[building.typeId];
    const job = definition?.jobs?.[0];
    const book = state.privateEconomy?.payrollByBuilding?.[building.id];
    if (book && job) transferWageClaimsToTown(state, wageBook(book), jobKeyForBuilding(building.id, job.id), content);
    if (state.privateEconomy?.payrollByBuilding) delete state.privateEconomy.payrollByBuilding[building.id];
    transferBuildingOwnership(state, building, { kind: "town", id: null }, content);
    if (state.market?.operatingRightPrices) delete state.market.operatingRightPrices[building.id];
    delete building.privateProfitHistory;
    delete ownershipWatch(state).arrearsDaysByBuilding[building.id];
    totals.buildingCount += 1;
  }

  // 6. 别墅 → 空置：删掉售出记录（别墅重新进入空置名单，日结的别墅销售会再卖），欠税一并免除。
  if (villaRows.length) {
    const villas = ensureVillaState(state);
    villas.sold = villas.sold.filter(row => row.householdId !== id);
    delete villas.taxArrearsValueUnits[id];
    household.villaAssets = [];
    totals.villaCount = villaRows.length;
  }

  syncResidentAggregates(state, content);
  const valueUnits = totals.voucherUnits + totals.inventoryValueUnits;
  const villaText = totals.villaCount ? `，别墅${totals.villaCount}栋空置待售` : "";
  if (movable) {
    recordEvent(state, `${household.name}整户失效，家产归镇库：粮券与存款${Math.round(totals.voucherUnits / scale)}券、库存折${Math.round(totals.inventoryValueUnits / scale)}券、股票${totals.shareCount}股、民营建筑${totals.buildingCount}栋收归镇营${villaText}。`, content, { day: state.day + 1 });
  } else if (totals.villaCount) {
    recordEvent(state, `${household.name}整户失效，别墅${totals.villaCount}栋空置待售。`, content, { day: state.day + 1 });
  }

  // 7. 店铺 → 新业主（不关门、不清算）。无人可接手的店铺保持暂停，留待之后每日再试。
  succeedShopsOfHousehold(state, id, content);

  const book = ensureRedistribution(state);
  bookAdd(book, "escheatUnits", valueUnits);
  bookAdd(book, "escheatVillas", totals.villaCount);
  if (!householdHasEscheatableAssets(state, household)) bookAdd(book, "escheatHouseholds", 1);
  bookAdd(book, "escheatShares", totals.shareCount);
  bookAdd(book, "escheatBuildings", totals.buildingCount);
  return { householdId: id, ...totals, valueUnits };
}

// 家产归公：扫描所有人口归零但仍有家产的家庭。年终由 population 调用，日结 escheat 步骤每日再扫（处理取不回的存款）。
export function settleEscheat(state, content) {
  const pending = householdList(state).filter(household => !isActiveHousehold(household) && householdHasEscheatableAssets(state, household));
  const rows = [];
  for (const household of pending) {
    const row = escheatHousehold(state, household, content);
    if (row) rows.push(row);
  }
  return rows.length ? { households: rows.length, rows } : null;
}

// 年终人口结算后调用：先遗产税（用年初快照），再家产归公（整户失效）。
export function settleYearEstates(state, content, snapshot, deathsByHousehold) {
  const inheritance = settleInheritanceTax(state, content, snapshot, deathsByHousehold);
  const escheat = settleEscheat(state, content);
  return { inheritance, escheat };
}

// 镇长政策：富人税门槛与税率（门槛 3 个递增正数，税率 3 个 0–20）。
export function setWealthTaxPolicy(state, patch = {}) {
  const current = wealthTaxPolicy(state);
  let thresholds = current.thresholds;
  let ratesPercent = current.ratesPercent;
  if (patch.thresholds !== undefined) {
    const list = Array.isArray(patch.thresholds) ? patch.thresholds.map(Number) : null;
    if (!list || list.length !== DEFAULT_WEALTH_TAX_THRESHOLDS.length || list.some(value => !Number.isFinite(value) || value <= 0 || value > 1e9)) {
      return { ok: false, reason: "富人税门槛须为3个有限的正数（券）" };
    }
    if (!(list[0] < list[1] && list[1] < list[2])) return { ok: false, reason: "富人税门槛须从小到大递增" };
    thresholds = list;
  }
  if (patch.ratesPercent !== undefined) {
    const list = Array.isArray(patch.ratesPercent) ? patch.ratesPercent.map(Number) : null;
    if (!list || list.length !== DEFAULT_WEALTH_TAX_RATES_PERCENT.length) return { ok: false, reason: "富人税税率须为3档" };
    if (list.some(value => !Number.isFinite(value) || value < 0 || value > WEALTH_TAX_RATE_MAX_PERCENT)) {
      return { ok: false, reason: `富人税税率须在0%—${WEALTH_TAX_RATE_MAX_PERCENT}%之间` };
    }
    ratesPercent = list;
  }
  state.policy ||= {};
  state.policy.wealthTax = { thresholds: thresholds.slice(), ratesPercent: ratesPercent.slice() };
  return { ok: true, wealthTax: { thresholds: thresholds.slice(), ratesPercent: ratesPercent.slice() } };
}

export function setInheritanceTaxPolicy(state, percent) {
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > INHERITANCE_TAX_RATE_MAX_PERCENT) {
    return { ok: false, reason: `遗产税率须在0%—${INHERITANCE_TAX_RATE_MAX_PERCENT}%之间` };
  }
  state.policy ||= {};
  state.policy.inheritanceTaxPercent = value;
  return { ok: true, value };
}

// ---------------------------------------------------------------- 贫富统计

// 每户的家底（全口径，与富人税征税口径一致，内部单位），按人口加权用。基尼、最富占比与逐年曲线都用它。
export function wealthDistributionRows(state, content) {
  const ctx = wealthContext(state, content);
  return householdList(state).filter(isActiveHousehold).map(household => ({
    householdId: household.id,
    people: householdPopulation(household),
    wealth: taxBaseUnits(state, household, content, ctx)
  }));
}

// 人口加权基尼系数（按人均家底排序，O(n log n)）。无人口返回 null；总家底为 0 时返回 0。
export function giniCoefficient(rows) {
  const valid = rows.filter(row => row.people > 0);
  const people = valid.reduce((sum, row) => sum + row.people, 0);
  if (!(people > 0)) return null;
  const total = valid.reduce((sum, row) => sum + row.wealth, 0);
  if (!(total > 0)) return 0;
  const sorted = valid.slice().sort((a, b) => a.wealth / a.people - b.wealth / b.people);
  let cumulative = 0;
  let previous = 0;
  let area = 0;
  for (const row of sorted) {
    cumulative += row.wealth;
    const share = cumulative / total;
    area += (row.people / people) * (previous + share);
    previous = share;
  }
  return Math.max(0, 1 - area);
}

// 最富 fraction 人口占全镇家底的百分比（按人均家底从高到低取人口）。
export function topWealthSharePercent(rows, fraction) {
  const valid = rows.filter(row => row.people > 0);
  const people = valid.reduce((sum, row) => sum + row.people, 0);
  const total = valid.reduce((sum, row) => sum + row.wealth, 0);
  if (!(people > 0) || !(total > 0)) return 0;
  const limit = people * fraction;
  const sorted = valid.slice().sort((a, b) => b.wealth / b.people - a.wealth / a.people);
  let cumulative = 0;
  let top = 0;
  for (const row of sorted) {
    const start = cumulative;
    cumulative += row.people;
    const overlap = Math.max(0, Math.min(cumulative, limit) - start);
    top += row.wealth / row.people * overlap;
  }
  return top / total * 100;
}

// 年终写入逐年基尼（由系统记录，选择器只读）。在年末人口结算之后、翻年之前调用。
export function recordYearGini(state, content, year) {
  const gini = giniCoefficient(wealthDistributionRows(state, content));
  if (gini === null) return null;
  const book = ensureRedistribution(state);
  const entry = { year, gini: Math.round(gini * 10000) / 10000 };
  book.giniHistory.push(entry);
  const limit = giniHistoryLimit(content);
  if (book.giniHistory.length > limit) book.giniHistory.splice(0, book.giniHistory.length - limit);
  return entry;
}
