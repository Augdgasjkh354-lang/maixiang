// 工资的只读派生字段（界面用）：发薪日、可辞退人数、待发工资、欠薪。只读 state，不写回。
import { payDayFor } from "../systems/paydays.js";
import { dismissibleCount } from "../systems/employment-contracts.js";
import { pendingWages, wageArrears } from "../systems/employer.js";
import { currencyScale } from "../economy/currency.js";

function voucherOf(units, content) {
  return (Number(units) || 0) / currencyScale(content);
}

// 镇库、民营、公司的工资债权簿（与 systems 里的读写位置一致）。
function townBookFor(state, jobKey) {
  return { claimsVoucherUnits: state.payroll?.creditorClaims?.[jobKey] || {}, pendingByMonth: state.payroll?.creditorPending?.[jobKey] || {} };
}

export function employerBookTotals(state, content, book) {
  return {
    pendingWagesVoucher: voucherOf(pendingWages(book || {}), content),
    wageArrearsVoucher: voucherOf(wageArrears(book || {}), content)
  };
}

// 镇营岗位行：可辞退人数（只数满期限的）。
export function decorateTownLaborRows(state, content, rows) {
  for (const row of rows) {
    row.dismissible = row.scope === "building" && row.count > 0 ? dismissibleCount(state, row.key, content) : 0;
    row.payDay = row.scope === "building" ? payDayFor(state, "town")
      : row.scope === "private" ? payDayFor(state, `private:${row.buildingId}`)
      : row.scope === "listed" && row.wageTarget ? payDayFor(state, `company:${row.wageTarget}`)
      : null;
  }
  return rows;
}

// 镇营建筑（整栋）的待发/欠薪：各岗位债权簿相加。
export function townBuildingWageTotals(state, content, building, definition) {
  let pending = 0;
  let arrears = 0;
  for (const job of definition?.jobs || []) {
    const book = townBookFor(state, `${building.id}::${job.id}`);
    pending += pendingWages(book);
    arrears += wageArrears(book);
  }
  return { pendingWagesVoucher: voucherOf(pending, content), wageArrearsVoucher: voucherOf(arrears, content), payDay: payDayFor(state, "town") };
}

export function privateBuildingWageTotals(state, content, buildingId) {
  return { ...employerBookTotals(state, content, state.privateEconomy?.payrollByBuilding?.[buildingId]), payDay: payDayFor(state, `private:${buildingId}`) };
}

export function companyWageTotals(state, content, company) {
  return { ...employerBookTotals(state, content, company?.payroll), payDay: payDayFor(state, `company:${company.id}`) };
}

export function shopPayTotals(state, content, shop) {
  return { pendingWagesVoucher: voucherOf(pendingWages(shop?.liabilities || {}), content), payDay: payDayFor(state, shop?.town ? "town" : `shop:${shop.id}`) };
}
