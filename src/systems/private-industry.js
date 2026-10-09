import { inOpeningPeriod, reviewStaffing } from "./employment-contracts.js";
import { payDayFor } from "./paydays.js";
import { accountQeqUnits, atomicInventoryTransaction, quantityToUnits, qeqUnitsForInventoryUnits } from "../economy/inventory.js";
import { laborBatches, nextCarry } from "../economy/productivity.js";
import { industryTypeIds, isIndustryType } from "../content/buildings.js";
import { bookAdd, bookAddMap } from "../economy/books.js";
import { recordEvent } from "../economy/ledger.js";
import { privateJobKeyForBuilding, readJobCount, selectJobRows } from "../selectors/labor.js";
import { setPrivateWorkers } from "./employment.js";
import { addTownCostBasis } from "../economy/business.js";
import { currencyScale } from "../economy/currency.js";
import { plannedBatchesForProducer, plannedWorkersForProducer } from "../economy/operating-plan.js";
import { currentUnitPrice } from "../economy/prices.js";
import { buyWholesaleForOwner, depositProductionTaxToWholesale, readWholesalePurchasePrice, runWholesaleIntake } from "./wholesale-market.js";
import { householdConvertibleWheatUnits, householdFoodQeqUnits, householdList, householdReserveQeqUnits, syncResidentAggregates, jobAssignments, isActiveHousehold, creditHouseholdInventory } from "./households.js";
import { spendableVoucherUnits } from "../economy/payment.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";
import { valueUnitsOfGoods, daySerialOf } from "./ownership.js";

import { privateWageRate } from "./payroll.js";
import { accrueWages, hireToward, payWages, productionTaxUnits, wageArrears, wageBook } from "./employer.js";

function targetBatches(state, building) {
  return plannedBatchesForProducer(state, `private:${building.id}`);
}

function productionAvailableUnits(state, household, itemId, content) {
  const stock = Math.max(0, household.inventory?.[itemId] || 0);
  const item = content.items[itemId];
  if (!item?.edible) return stock;
  const reserve = qeqReserveForOwner(state, household.id, content);
  const food = householdFoodQeqUnits(state, household, content);
  const perUnit = qeqUnitsForInventoryUnits(item, 1, content);
  if (perUnit <= 0) return stock;
  return Math.max(0, Math.min(stock, Math.floor((food - reserve) / perUnit)));
}

function purchaseUnitsNeededForProduction(state, household, itemId, wantedUnits, content) {
  const stock = Math.max(0, household.inventory?.[itemId] || 0);
  const item = content.items[itemId];
  const directShortage = Math.max(0, wantedUnits - stock);
  if (!item?.edible) return directShortage;

  // Edible raw materials share the household food reserve. Buying only the recipe
  // quantity can still leave every newly bought unit protected as household food.
  // Buy enough to preserve the reserve *and* leave the planned recipe input usable.
  const reserve = qeqReserveForOwner(state, household.id, content);
  const food = householdFoodQeqUnits(state, household, content);
  const perUnit = qeqUnitsForInventoryUnits(item, 1, content);
  if (perUnit <= 0) return directShortage;
  const qeqShortageUnits = Math.max(0, Math.ceil((reserve + wantedUnits * perUnit - food) / perUnit));
  return Math.max(directShortage, qeqShortageUnits);
}

function buyMissingPrivateInputs(state, household, definition, recipe, batches, content) {
  const purchases = [];
  const shortages = [];
  for (const input of recipe.inputs || []) {
    const perBatch = quantityToUnits(input.quantity, content);
    const wantedUnits = perBatch * batches;
    let availableUnits = productionAvailableUnits(state, household, input.itemId, content);
    const missingUnits = purchaseUnitsNeededForProduction(state, household, input.itemId, wantedUnits, content);
    if (missingUnits > 0) {
      const purchase = buyWholesaleForOwner(
        state, `household:${household.id}`, input.itemId, missingUnits, content,
        `${household.name}为经营${definition.name}从批发市场采购${content.items[input.itemId]?.name || input.itemId}`
      );
      if (purchase.boughtUnits > 0) creditHouseholdInventory(state, household.id, input.itemId, purchase.boughtUnits, content);
      const purchaseReason = purchase.reason || "批发市场可售量不足";
      purchases.push({ itemId: input.itemId, requestedUnits: missingUnits, purchasedUnits: purchase.boughtUnits || 0, paidVoucherUnits: purchase.paidVoucherUnits || 0, reason: purchaseReason, sellerRows: purchase.sellerRows || [] });
      availableUnits = productionAvailableUnits(state, household, input.itemId, content);
      if (availableUnits < wantedUnits) shortages.push({
        itemId: input.itemId, missingUnits: wantedUnits - availableUnits, reason: purchaseReason
      });
    }
  }
  return { purchases, shortages };
}


// 民营招工不能超过业主付得起的工资：日工资总额 ≤ 业主可动用资金 / 7。
// 可动用资金 = 粮券（含存款取回）+ 可换小麦折算的粮券（与付款口径一致）。
export function privateHireCapByOwnerMoney(state, building, role, content) {
  const ownerId = privateOwners(building, state)[0];
  const owner = ownerId ? state.households?.byId?.[ownerId] : null;
  if (!owner || !isActiveHousehold(owner)) return 0;
  const owners = `household:${ownerId}`;
  const maxWheat = householdConvertibleWheatUnits(state, owner, content, content.rules.householdFoodReserveDays ?? 30);
  const money = spendableVoucherUnits(state, owners) + voucherUnitsForWheatUnits(maxWheat, content, "floor");
  const rate = privateWageRate(state, building, role, content);
  const perWorkerDayUnits = rate * currencyScale(content);
  if (!(perWorkerDayUnits > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(money / 7 / perWorkerDayUnits));
}

export function arrangePrivateWorkers(state, content) {
  // 下游先招工：经营计划按下游需求倒推上游。
  const downstreamFirst = industryTypeIds(content).reverse();
  const rows = selectJobRows(state, content);
  let idle = rows.idle;
  const buildings = state.buildings.filter(row => isIndustryType(content, row.typeId) && (row.ownership?.privateLevels || 0) > 0)
    .sort((a, b) => downstreamFirst.indexOf(a.typeId) - downstreamFirst.indexOf(b.typeId) || a.id.localeCompare(b.id));
  for (const building of buildings) {
    const definition = content.buildings[building.typeId];
    const role = definition.jobs[0];
    const key = privateJobKeyForBuilding(building.id, role.id);
    const cap = role.slots * building.ownership.privateLevels;
    const plannedWorkers = plannedWorkersForProducer(state, `private:${building.id}`);
    const ownerCap = privateHireCapByOwnerMoney(state, building, role, content);
    const desired = Math.min(cap, ownerCap, plannedWorkers == null ? readJobCount(state, key) : plannedWorkers);
    // 正式员工：每月 1 号审核，不够招一人、多了辞退一人（满 30 天，业主付一个月补偿）。
    const ownerId = privateOwners(building, state)[0];
    const owner = ownerId ? state.households?.byId?.[ownerId] : null;
    const payer = owner ? { id: `household:${ownerId}`, maxWheatUnits: householdConvertibleWheatUnits(state, owner, content, content.rules.householdFoodReserveDays ?? 30) } : null;
    state.privateEconomy ||= {}; state.privateEconomy.payrollByBuilding ||= {};
    const book = wageBook(state.privateEconomy.payrollByBuilding[building.id] ||= { arrearsVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0, cumulativePaidVoucherUnits: 0 });
    idle = reviewStaffing(state, content, { jobKey: key, current: readJobCount(state, key), desired, idle,
      hire: next => setPrivateWorkers(state, building.id, role.id, next, content),
      payer, dailyWage: privateWageRate(state, building, role, content), book, reason: `${definition.name}民营辞退补偿`,
      opening: inOpeningPeriod(state, content, building.privateSince),
      losing: (building.privateProfitHistory || []).slice(-30).reduce((sum, row) => sum + (row.profitVoucherUnits || 0), 0) < 0 });
  }
}

function qeqReserveForOwner(state, ownerHouseholdId, content) {
  const household = state.households?.byId?.[ownerHouseholdId];
  return household ? householdReserveQeqUnits(state, household, content, content.rules.breadBasicReserveDays || 30) : 0;
}

// 整栋民营只有一个业主家庭（docs/OWNERSHIP.md）：privateOwners 长度恰好为 1；缺失时按户号补一户。
function privateOwners(building, state) {
  const hasOwnerLevels = Math.max(0, building.ownership?.privateLevels || 0) > 0;
  building.privateOwners ||= [];
  if (!hasOwnerLevels) return [];
  if (building.privateOwners.length > 1) building.privateOwners.length = 1;
  if (building.privateOwners.length === 0) {
    const candidates = householdList(state).filter(isActiveHousehold).sort((a, b) => a.id.localeCompare(b.id));
    const fallback = candidates[0];
    if (fallback) building.privateOwners.push(fallback.id);
  }
  return building.privateOwners.slice();
}

function ownerCapacity(state, building, content) {
  const definition = content.buildings[building.typeId];
  const job = definition.jobs[0];
  const workers = readJobCount(state, privateJobKeyForBuilding(building.id, job.id));
  const labor = laborBatches(state, building.typeId, building.level, workers, content.recipes[definition.recipeId].batchesPerWorkerDay, building.privateProductivityCarry);
  return { workers, batches: labor.batches, exact: labor.exact };
}

export function payPrivateIndustryWages(state, content) {
  state.privateEconomy ||= {}; state.privateEconomy.payrollByBuilding ||= {};
  const results = []; const scale = currencyScale(content);
  for (const building of state.buildings.filter(row => isIndustryType(content, row.typeId) && (row.ownership?.privateLevels || 0) > 0)) {
    const definition = content.buildings[building.typeId]; const job = definition?.jobs?.[0]; if (!job) continue;
    const key = privateJobKeyForBuilding(building.id, job.id); const workers = readJobCount(state, key);
    const rate = privateWageRate(state, building, job, content); const due = Math.round(workers * rate * scale);
    const payroll = wageBook(state.privateEconomy.payrollByBuilding[building.id] ||= { arrearsVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0, cumulativePaidVoucherUnits: 0 });
    accrueWages(state, payroll, jobAssignments(state, key), due, content);
    payroll.cumulativeAccruedVoucherUnits += due;
    // 业主家庭轮流付工资（已消亡家庭跳过），付款时给业主留够口粮。
    const ownerIds = [...new Set(privateOwners(building, state))].filter(ownerId => { const owner = state.households?.byId?.[ownerId]; return Boolean(owner) && isActiveHousehold(owner); });
    const payers = ownerIds.map(ownerId => ({
      id: `household:${ownerId}`,
      maxWheatUnits: householdConvertibleWheatUnits(state, state.households.byId[ownerId], content, content.rules.householdFoodReserveDays ?? 30)
    }));
    const paid = payWages(state, payroll, payers, content, "private_wage_payment", `${definition.name}民营业主偿付具体债权家庭工资`,
      { payDay: payDayFor(state, `private:${building.id}`) }).paid;
    payroll.arrearsVoucherUnits = wageArrears(payroll); payroll.cumulativePaidVoucherUnits += paid;
    payroll.lastDueVoucherUnits = due;
    results.push({ buildingId: building.id, workers, dueVoucherUnits: due, paidVoucherUnits: paid, arrearsVoucherUnits: payroll.arrearsVoucherUnits });
  }
  return results;
}

// 欠薪旁路标记：只表示"这栋还欠工人工资"，不改变生产状态。
function arrearsFlag(state, buildingId) {
  return (state.privateEconomy?.payrollByBuilding?.[buildingId]?.arrearsVoucherUnits || 0) > 0;
}

export function processPrivateBuilding(state, building, content) {
  const definition = content.buildings[building.typeId];
  const recipe = content.recipes[definition.recipeId];
  const { workers, batches: capacity, exact: laborExact } = ownerCapacity(state, building, content);
  const target = targetBatches(state, building);
  const planned = Math.min(capacity, target == null ? capacity : target);
  if (workers <= 0 || planned <= 0) return { buildingId: building.id, status: workers <= 0 ? "no_workers" : "no_demand", arrears: arrearsFlag(state, building.id), batches: 0 };
  const owners = privateOwners(building, state);
  if (!owners.length) return { buildingId: building.id, status: "no_owner", arrears: arrearsFlag(state, building.id), batches: 0, reason: "缺少家庭所有者" };
  const ownerLevels = new Map();
  for (const id of owners) ownerLevels.set(id, (ownerLevels.get(id) || 0) + 1);
  let batchesLeft = planned;
  let completed = 0;
  const taxRows = [];
  const transactionIds = [];
  const inputPurchases = [];
  const inputShortages = [];
  const ownerEntries = [...ownerLevels.entries()];
  for (let index = 0; index < ownerEntries.length; index += 1) {
    const [ownerHouseholdId, levels] = ownerEntries[index];
    const household = state.households?.byId?.[ownerHouseholdId];
    if (!household) continue;
    let ownerPlanned = index === ownerEntries.length - 1 ? batchesLeft : Math.floor(planned * levels / owners.length);
    ownerPlanned = Math.min(ownerPlanned, batchesLeft);
    if (ownerPlanned <= 0) continue;
    const supply = buyMissingPrivateInputs(state, household, definition, recipe, ownerPlanned, content);
    for (const row of supply.purchases) inputPurchases.push({ ownerHouseholdId, ...row });
    for (const row of supply.shortages) inputShortages.push({ ownerHouseholdId, ...row });
    let batches = ownerPlanned;
    for (const input of recipe.inputs) {
      const perBatch = quantityToUnits(input.quantity, content);
      batches = Math.min(batches, Math.floor(productionAvailableUnits(state, household, input.itemId, content) / perBatch));
    }
    if (batches <= 0) continue;
    const outputs = [];
    const localTaxRows = [];
    const carryAfter = {};
    for (const output of recipe.outputs) {
      const totalUnits = quantityToUnits(output.quantity * batches, content);
      const carryKey = `${building.typeId}|${building.id}|${ownerHouseholdId}|${output.itemId}`;
      const tax = productionTaxUnits(state, building.typeId, state.privateEconomy.taxRemainders, carryKey, totalUnits, content);
      const taxUnits = tax.taxUnits;
      carryAfter[carryKey] = tax.carryAfter;
      const residentUnits = totalUnits - taxUnits;
      if (residentUnits > 0) outputs.push({ owner: `household:${ownerHouseholdId}`, itemId: output.itemId, quantityUnits: residentUnits, type: "private_production_output", source: "private_production" });
      if (taxUnits > 0) outputs.push({ owner: "town", itemId: output.itemId, quantityUnits: taxUnits, type: "private_production_tax", source: "private_production", destination: "town" });
      localTaxRows.push({ itemId: output.itemId, totalUnits, taxUnits, residentUnits, ownerHouseholdId, carryKey });
    }
    const inputs = recipe.inputs.map(input => ({ owner: `household:${ownerHouseholdId}`, itemId: input.itemId, quantityUnits: quantityToUnits(input.quantity * batches, content) }));
    const losses = recipe.losses.map(loss => ({ owner: `household:${ownerHouseholdId}`, itemId: loss.itemId, quantityUnits: quantityToUnits(loss.quantity * batches, content) }));
    const transaction = atomicInventoryTransaction(state, {
      inputs, outputs, losses, protectedOwner: `household:${ownerHouseholdId}`, minEndingQeqUnits: qeqReserveForOwner(state, ownerHouseholdId, content),
      inputType: "private_process_input", inputDestination: "private_processing",
      outputType: "private_production_output", outputSource: "private_production",
      reason: `${household.name}经营${definition.name}：${recipe.name}`, lossReason: recipe.name + "民营加工损耗"
    }, content);
    if (!transaction.ok) continue;
    for (const [key, value] of Object.entries(carryAfter)) state.privateEconomy.taxRemainders[key] = value;
    for (const row of localTaxRows) {
      const unitCost = content.items[row.itemId]?.openingCostWheatPerJin ?? 0;
      const costUnits = Math.round(row.taxUnits * unitCost);
      // 统购品税货直接入批发市场（从镇库扣回，成本随货带入）；没有批发市场时仍留在镇库。
      const intake = depositProductionTaxToWholesale(state, row.itemId, row.taxUnits, costUnits, content,
        { fromTown: true, source: "private_production", reason: `${definition.name}民营实物税入批发市场` });
      if (!intake.ok) addTownCostBasis(state, row.itemId, costUnits);
      taxRows.push(row);
    }
    for (const row of localTaxRows) {
      bookAddMap(state.privateEconomy, "producedUnits", row.itemId, row.totalUnits);
      bookAddMap(state.privateEconomy, "taxedUnits", row.itemId, row.taxUnits);
      bookAddMap(state.privateEconomy, "outputUnits", row.itemId, row.residentUnits);
    }
    for (const input of inputs) bookAddMap(state.privateEconomy, "inputUnits", input.itemId, input.quantityUnits);
    transactionIds.push(transaction.transactionId);
    completed += batches;
    batchesLeft -= batches;
  }
  syncResidentAggregates(state, content);
  // 满负荷生产才把零头留到明天。
  building.privateProductivityCarry = nextCarry(laborExact, completed, completed >= capacity);
  if (!building.privateProductivityCarry) delete building.privateProductivityCarry;
  if (completed <= 0) {
    const first = inputShortages[0];
    const itemName = first ? (content.items[first.itemId]?.name || first.itemId) : "原料";
    return { buildingId: building.id, status: "no_materials", arrears: arrearsFlag(state, building.id), batches: 0,
      reason: first ? `缺${itemName}：${first.reason}` : "经营家庭没有可用于生产的原料", inputPurchases, inputShortages };
  }
  const internalLaborCostWheatUnits = Math.round(workers * (state.employment.wageRates[definition.productionRoleId] || 0) * content.precision.inventoryUnitsPerJin);
  bookAdd(state.privateEconomy, "internalLaborCostWheatUnits", internalLaborCostWheatUnits);
  const arrears = state.privateEconomy?.payrollByBuilding?.[building.id]?.arrearsVoucherUnits || 0;
  const firstShortage = inputShortages[0];
  const shortageReason = firstShortage ? `缺${content.items[firstShortage.itemId]?.name || firstShortage.itemId}：${firstShortage.reason}` : null;
  // 欠薪只作为旁路标记 arrears，不覆盖真实生产状态（界面要同时看到"缺料"与"欠薪"）。
  const status = completed < planned ? "limited_materials" : (planned < capacity ? "limited_demand" : "ready");
  return { buildingId: building.id, status, arrears: arrears > 0,
    reason: completed < planned ? shortageReason : null, workers, batches: completed, plannedBatches: planned, transactionIds, taxRows, inputPurchases, inputShortages, wageArrearsVoucherUnits: arrears };
}

// 民营业主的日利润（估算）：产出按收购价计入（扣税后）－ 当日原料采购 － 当日应计工资。
// 只为"每 30 天自主升级"的盈利判断服务；保留最近 ownerUpgradeProfitDays 天。
function recordPrivateDayProfit(state, building, row, content) {
  const income = (row.taxRows || []).reduce((sum, taxRow) => {
    const price = readWholesalePurchasePrice(state, taxRow.itemId, content);
    return sum + valueUnitsOfGoods(taxRow.residentUnits || 0, price, content);
  }, 0);
  const inputCost = (row.inputPurchases || []).reduce((sum, purchase) => sum + (purchase.paidVoucherUnits || 0), 0);
  const wages = state.privateEconomy?.payrollByBuilding?.[building.id]?.lastDueVoucherUnits || 0;
  const profitVoucherUnits = Math.round(income - inputCost - wages);
  const serial = daySerialOf(state, content);
  building.privateProfitHistory ||= [];
  if (building.privateProfitHistory.at(-1)?.serial === serial) building.privateProfitHistory.pop();
  building.privateProfitHistory.push({ serial, profitVoucherUnits, workers: row.workers || 0 });
  const keep = Math.max(60, content.rules.ownerUpgradeProfitDays || 60) + 2;
  if (building.privateProfitHistory.length > keep) building.privateProfitHistory.splice(0, building.privateProfitHistory.length - keep);
}

export function processPrivateIndustries(state, content) {
  const rows = [];
  // 上游先生产，下游才买得到原料。
  // 每栋民营建筑产出后立即按收购价入批发市场（同镇营统购的时点），下游同日就能买到上游民营产出。
  const order = industryTypeIds(content);
  const ordered = state.buildings.slice().sort((a, b) => order.indexOf(a.typeId) - order.indexOf(b.typeId));
  for (const building of ordered) {
    if (!isIndustryType(content, building.typeId) || !(building.ownership?.privateLevels || 0)) continue;
    const row = processPrivateBuilding(state, building, content);
    row.intake = runWholesaleIntake(state, [], [row], content, { includeTownAllocation: false }).intakeUnits;
    recordPrivateDayProfit(state, building, row, content);
    rows.push(row);
  }
  state.privateEconomy.lastDay = rows;
  return rows;
}

export function resetPrivateDaily(state) {
  state.privateEconomy.day = { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 };
  state.privateEconomy.rightSales.dayWheatUnits = 0;
}

export function resetPrivateYear(state) {
  state.privateEconomy.year = { producedUnits: {}, taxedUnits: {}, outputUnits: {}, inputUnits: {}, internalLaborCostWheatUnits: 0 };
  state.privateEconomy.rightSales.yearWheatUnits = 0;
}
