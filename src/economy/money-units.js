function divRound(numerator, denominator, mode) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d <= 0n || n < 0n) throw new RangeError("货币单位换算参数无效");
  let q = n / d;
  const r = n % d;
  if (r !== 0n) {
    if (mode === "ceil") q += 1n;
    else if (mode === "round" && r * 2n >= d) q += 1n;
  }
  const value = Number(q);
  if (!Number.isSafeInteger(value)) throw new RangeError("货币单位换算超过安全整数范围");
  return value;
}

export function voucherUnitsForWheatUnits(wheatUnits, content, mode = "floor") {
  if (!Number.isSafeInteger(wheatUnits) || wheatUnits < 0) throw new RangeError("小麦单位无效");
  return divRound(BigInt(wheatUnits) * BigInt(content.precision.currencyUnitsPerVoucher),
    content.precision.inventoryUnitsPerJin, mode);
}

export function wheatUnitsForVoucherUnits(voucherUnits, content, mode = "ceil") {
  if (!Number.isSafeInteger(voucherUnits) || voucherUnits < 0) throw new RangeError("粮券单位无效");
  return divRound(BigInt(voucherUnits) * BigInt(content.precision.inventoryUnitsPerJin),
    content.precision.currencyUnitsPerVoucher, mode);
}

export function voucherAmountToUnits(amount, content) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new RangeError("货币金额无效");
  const units = Math.round((value + Number.EPSILON) * content.precision.currencyUnitsPerVoucher);
  if (!Number.isSafeInteger(units)) throw new RangeError("货币金额超过安全整数范围");
  return units;
}

export function wheatAmountToUnits(amount, content) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new RangeError("小麦金额无效");
  const units = Math.round((value + Number.EPSILON) * content.precision.inventoryUnitsPerJin);
  if (!Number.isSafeInteger(units)) throw new RangeError("小麦金额超过安全整数范围");
  return units;
}
