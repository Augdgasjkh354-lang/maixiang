export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, function (character) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character];
  });
}

export function number(value, digits) {
  const precision = digits ?? 0;
  return Number(value || 0).toLocaleString("zh-CN", {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision
  });
}


export function numberMax(value, digits = 1) {
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

export function shortageJin(qeqUnits, qeqUnitsPerJin) {
  const jin = Number(qeqUnits || 0) / Number(qeqUnitsPerJin || 1);
  if (jin > 0 && jin < 0.01) return "不足0.01斤";
  return numberMax(jin, 2) + "斤";
}

export function compact(value) {
  const n = Number(value || 0);
  if (n >= 1000000) return number(n / 10000, 1) + "万";
  if (n >= 10000) return number(n / 10000, 1) + "万";
  return number(n);
}

export function percent(value) {
  return number(Math.max(0, Math.min(100, value)), 0) + "%";
}

export function accountLines(account) {
  return Object.values(account.items)
    .filter(function (item) { return item.quantity > 0; })
    .map(function (item) {
      return escapeHtml(item.name) + " " + number(item.quantity) + escapeHtml(item.unit || "斤");
    }).join(" · ") || "暂无库存";
}

export function moneyUnit(view) {
  const stage = view?.monetaryReform?.stage || "voucher";
  return stage === "wheat" ? "斤小麦" : stage === "voucher" ? "粮券" : "小麦等值";
}

export function moneyMixHint(view) {
  const reform = view?.monetaryReform;
  if (!reform || reform.stage === "wheat") return "新交易以小麦结算";
  if (reform.stage === "voucher") return "新交易以粮券结算";
  return `新交易目标${number(reform.targetPercent, 2)}%粮券，其余小麦；缺券部分可由付款人自有小麦补付`;
}

// 镇营岗位实际日薪（基础日薪 × 公务员类/产业类系数）。
export function effectiveTownWage(view, roleId, baseWage) {
  const control = view.wageControl || { civil: 1, industry: 1, civilRoleIds: [] };
  const factor = (control.civilRoleIds || []).includes(roleId) ? control.civil : control.industry;
  return (Number(baseWage) || 0) * (Number.isFinite(Number(factor)) ? Number(factor) : 1);
}
