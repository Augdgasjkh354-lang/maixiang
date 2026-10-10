export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, function (character) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character];
  });
}

// Intl.NumberFormat 实例按精度缓存：toLocaleString 每次都会重新解析 locale 与选项，界面每帧调用成百上千次。
// 输出与 Number#toLocaleString 逐字一致（toLocaleString 本身就是 new Intl.NumberFormat(...).format）。
const fixedFormats = new Map();
const maxFormats = new Map();

function cachedFormat(cache, key, options) {
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("zh-CN", options);
    cache.set(key, formatter);
  }
  return formatter;
}

export function number(value, digits) {
  const precision = digits ?? 0;
  return cachedFormat(fixedFormats, precision, {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision
  }).format(Number(value || 0));
}


export function numberMax(value, digits = 1) {
  return cachedFormat(maxFormats, digits, { maximumFractionDigits: digits }).format(Number(value || 0));
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

export function moneyUnit() {
  return "粮券";
}

export function moneyMixHint() {
  return "交易以粮券结算";
}

// 镇营岗位实际日薪（基础日薪 × 公务员类/产业类系数）。
export function effectiveTownWage(view, roleId, baseWage) {
  const control = view.wageControl || { civil: 1, industry: 1, civilRoleIds: [] };
  const factor = (control.civilRoleIds || []).includes(roleId) ? control.civil : control.industry;
  return (Number(baseWage) || 0) * (Number.isFinite(Number(factor)) ? Number(factor) : 1);
}

// 工资一律按月显示：月薪 = 日薪 × monthDays，括号里附日薪（输入框仍按日薪）。
export function monthlyWageText(view, dailyWage, digits = 1) {
  const days = Number(view?.monthDays) || 30;
  const daily = Number(dailyWage) || 0;
  return `月薪 ${number(daily * days, digits)}${moneyUnit(view)}（日薪 ${number(daily, digits)}）`;
}

export function monthlyWageValue(view, dailyWage, digits = 1) {
  return number((Number(dailyWage) || 0) * (Number(view?.monthDays) || 30), digits);
}

// 发薪日文字；没有发薪日信息时返回空串。
export function payDayText(day) {
  return Number.isFinite(day) ? `每月${day}号发薪` : "";
}
