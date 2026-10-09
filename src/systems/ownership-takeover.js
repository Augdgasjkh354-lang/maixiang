// 镇里收回（docs/OWNERSHIP.md 第 3 条）：民营/公司欠薪连续超过宽限天数，整栋收回镇营。
// 日结步骤 ownershipTakeover 每天调用 settleOwnershipTakeovers。
//
// 民营：先用业主名下这栋楼配方里的原料/产品存货抵欠薪（按批发收购价折算，抵掉的货进批发市场）；
//       余额由镇库偿付给工人；业主拿不到补偿；建筑整栋回镇营。
// 公司：清算（见 companies.js liquidateCompanyForArrears），股份作废、建筑回镇营。

import { recordEvent } from "../economy/ledger.js";
import { currencyScale } from "../economy/currency.js";
import { jobKeyForBuilding } from "../selectors/labor.js";
import { syncResidentAggregates } from "./households.js";
import { offsetWageClaims, payWages, transferWageClaimsToTown, wageArrears, wageBook } from "./employer.js";
import { depositWholesalePurchasedInventory, readWholesalePurchasePrice } from "./wholesale-market.js";
import { liquidateCompanyForArrears } from "./companies.js";
import { ownershipWatch, transferBuildingOwnership, valueUnitsOfGoods } from "./ownership.js";

function takeoverPrivateBuilding(state, building, content, days) {
  const definition = content.buildings[building.typeId];
  const recipe = content.recipes[definition.recipeId];
  const scale = content.precision.inventoryUnitsPerJin;
  const household = building.privateOwners?.[0] ? state.households?.byId?.[building.privateOwners[0]] : null;
  const book = wageBook(state.privateEconomy.payrollByBuilding[building.id] ||= { arrearsVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0, cumulativePaidVoucherUnits: 0 });
  const arrearsBefore = wageArrears(book);
  // 1. 业主存货（配方内的原料与产品）按收购价抵欠薪。
  const itemIds = [...new Set([...recipe.inputs, ...recipe.outputs].map(row => row.itemId))];
  let inKindValueUnits = 0;
  const goods = [];
  if (household) {
    for (const itemId of itemIds) {
      if (wageArrears(book) <= 0) break;
      const price = readWholesalePurchasePrice(state, itemId, content);
      const stock = Math.max(0, household.inventory?.[itemId] || 0);
      if (price <= 0 || stock <= 0) continue;
      const remaining = wageArrears(book);
      const unitsNeeded = Math.ceil(remaining * scale / (price * currencyScale(content)));
      const take = Math.min(stock, unitsNeeded);
      if (take <= 0) continue;
      const value = valueUnitsOfGoods(take, price, content);
      household.inventory[itemId] = stock - take;
      depositWholesalePurchasedInventory(state, itemId, take, value, content);
      inKindValueUnits += offsetWageClaims(state, book, value, content);
      goods.push({ itemId, units: take, valueUnits: value });
    }
  }
  // 2. 余额由镇库偿付；仍付不起的部分转入镇库的历史工资债权，之后由镇库照常偿付。
  const beforeTown = wageArrears(book);
  if (beforeTown > 0) payWages(state, book, "town", content, "private_takeover_town_advance", `${definition.name}收回后镇库偿付欠薪`);
  const townAdvanceUnits = beforeTown - wageArrears(book);
  const job = definition.jobs?.[0];
  const transferredClaimsUnits = job ? transferWageClaimsToTown(state, book, jobKeyForBuilding(building.id, job.id), content) : 0;
  delete state.privateEconomy.payrollByBuilding[building.id];
  // 3. 建筑整栋回镇营（岗位人数搬到镇营岗位键，经营权价格与利润记录作废）。
  const moved = transferBuildingOwnership(state, building, { kind: "town", id: null }, content);
  if (state.market?.operatingRightPrices) delete state.market.operatingRightPrices[building.id];
  delete building.privateProfitHistory;
  delete ownershipWatch(state).arrearsDaysByBuilding[building.id];
  syncResidentAggregates(state, content);
  const ownerName = household?.name || "业主";
  const voucherUnits = content.precision.currencyUnitsPerVoucher;
  recordEvent(state, `${ownerName}经营的${definition.name}连续欠薪超过${days - 1}天，整栋收回镇营：存货抵欠薪${Math.round(inKindValueUnits / voucherUnits)}券，镇库垫付${Math.round(townAdvanceUnits / voucherUnits)}券，业主不再得到补偿。`, content, { day: state.day + 1 });
  return {
    kind: "private", buildingId: building.id, ownerHouseholdId: household?.id || null, days,
    arrearsBeforeUnits: arrearsBefore, inKindValueUnits, townAdvanceUnits, transferredClaimsUnits,
    goods, movedWorkers: moved.movedWorkers
  };
}

// 日结步骤：更新欠薪连续天数，超过宽限的民营建筑收回，超过宽限的公司清算。
export function settleOwnershipTakeovers(state, content) {
  const threshold = content.rules.ownershipTakeoverArrearsDays ?? 30;
  const watch = ownershipWatch(state);
  const rows = [];
  for (const building of state.buildings.slice()) {
    if (!((building.ownership?.privateLevels || 0) > 0)) {
      delete watch.arrearsDaysByBuilding[building.id];
      continue;
    }
    const arrears = wageArrears(state.privateEconomy?.payrollByBuilding?.[building.id]);
    const days = arrears > 0 ? (watch.arrearsDaysByBuilding[building.id] || 0) + 1 : 0;
    if (days > 0) watch.arrearsDaysByBuilding[building.id] = days;
    else delete watch.arrearsDaysByBuilding[building.id];
    if (days > threshold) rows.push(takeoverPrivateBuilding(state, building, content, days));
  }
  for (const companyId of Object.keys(state.companies || {})) {
    const company = state.companies[companyId];
    if (!company) continue;
    const arrears = wageArrears(company.payroll);
    const days = arrears > 0 ? (watch.arrearsDaysByCompany[companyId] || 0) + 1 : 0;
    if (days > 0) watch.arrearsDaysByCompany[companyId] = days;
    else delete watch.arrearsDaysByCompany[companyId];
    if (days > threshold) {
      const result = liquidateCompanyForArrears(state, companyId, content);
      delete watch.arrearsDaysByCompany[companyId];
      rows.push({ kind: "company", days, ...result });
    }
  }
  return rows;
}
