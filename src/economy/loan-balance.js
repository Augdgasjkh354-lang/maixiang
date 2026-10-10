// 住户在银行的贷款余额（只读汇总）。单独成模块：household-budget 要用，而 household-loans 又依赖 household-budget，放一起会成环。

export function householdLoanBalanceUnits(state, householdId) {
  let total = 0;
  for (const loan of state.bank?.loans || []) {
    if (loan.borrowerKind === "household" && loan.status === "active" && loan.borrowerId === householdId) {
      total += loan.outstandingVoucherUnits || 0;
    }
  }
  return total;
}

// 全镇一次性汇总：住户 id → 余额（O(贷款数)，供逐户计算的循环使用）。
export function householdLoanBalanceMap(state) {
  const map = new Map();
  for (const loan of state.bank?.loans || []) {
    if (loan.borrowerKind !== "household" || loan.status !== "active") continue;
    map.set(loan.borrowerId, (map.get(loan.borrowerId) || 0) + (loan.outstandingVoucherUnits || 0));
  }
  return map;
}
