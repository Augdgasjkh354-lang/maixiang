// 镇 GDP（只读，由年报估算，收入法，单位：券，1 券 ≈ 1 斤小麦）：
//   GDP = 农业产出（秋收）+ 劳动报酬（全年应计工资，含镇营）+ 经营利润（店铺与公司，含已缴利润税，亏损抵减但总和不低于 0）
//         + 镇营盈余（镇营产出按市价折算的增加值 − 镇营工资，不低于 0；年报 townProduction，旧年报没有则为 0）
// 民营建筑的产出暂未单独计价（其收入已在居民收入里，不在经营利润里）；这是估算口径，用来看规模与同比，不是会计恒等式。
export function gdpOfReport(report, content) {
  if (!report) return null;
  const scale = content.precision.currencyUnitsPerVoucher;
  const agriculture = Math.max(0, (report.harvestQeq || 0) / content.precision.qeqUnitsPerJin);
  const wages = Math.max(0, (report.payroll?.accruedVoucherUnits || 0) / scale);
  let profit = 0;
  for (const row of [...Object.values(report.shops || {}), ...Object.values(report.companies || {})]) {
    const accounts = row?.accounts || {};
    profit += ((accounts.profitVoucherUnits || 0) + (accounts.taxExpenseVoucherUnits || 0)) / scale;
  }
  profit = Math.max(0, profit);
  const tp = report.townProduction || {};
  const townSurplus = Math.max(0, (tp.valueAddedVoucher || 0) - (tp.wagesVoucher || 0));
  const total = agriculture + wages + profit + townSurplus;
  const people = Number(report.populationAfterAging) || 0;
  return { agriculture, wages, profit, townSurplus, total, perCapita: people > 0 ? total / people : null };
}
