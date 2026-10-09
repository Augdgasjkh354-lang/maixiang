// 发薪日：每月 5/10/15/20/25 号，由雇主每月 1 号按盈利能力定（盈利越强越早发）。镇库固定 5 号。
// 盈利能力 = 近 30 天日均利润 ÷ 人手（店铺、民营建筑、公司分别读各自的利润记录）；
// （岗位键直接拼，免得 selectors/labor.js → payroll.js → paydays.js 循环依赖）按全镇雇主排名分五档，前 20% 5 号、……、最后 20% 与不赚钱的 25 号。结果存 state.payroll.payDays。
import { jobCount } from "./households.js";
import { dayOfMonth } from "./employer.js";

export const PAY_DAYS = Object.freeze([5, 10, 15, 20, 25]);
const TOWN_PAY_DAY = 5;
const LOW_PAY_DAY = 25;
const WINDOW_DAYS = 30;

export function payDayFor(state, employerKey) {
  if (employerKey === "town") return TOWN_PAY_DAY;
  const day = state.payroll?.payDays?.[employerKey];
  return PAY_DAYS.includes(day) ? day : LOW_PAY_DAY;
}

function recentProfit(rows) {
  const recent = (rows || []).slice(-WINDOW_DAYS);
  if (!recent.length) return 0;
  return recent.reduce((sum, row) => sum + (Number(row.profitVoucherUnits) || 0), 0) / recent.length;
}

function employerRows(state, content) {
  const rows = [];
  for (const shop of Object.values(state.shops || {})) {
    if (shop.status !== "open") continue;
    const staff = Math.max(1, jobCount(state, `shop:${shop.id}:clerk`) + jobCount(state, `shop:${shop.id}:merchant`));
    rows.push({ key: `shop:${shop.id}`, score: recentProfit(shop.history) / staff });
  }
  for (const building of state.buildings || []) {
    if (!((building.ownership?.privateLevels || 0) > 0)) continue;
    const job = content.buildings[building.typeId]?.jobs?.[0];
    const staff = Math.max(1, job ? jobCount(state, `${building.id}::${job.id}::private`) : 0);
    rows.push({ key: `private:${building.id}`, score: recentProfit(building.privateProfitHistory) / staff });
  }
  for (const company of Object.values(state.companies || {})) {
    const job = content.buildings[company.typeId]?.jobs?.[0];
    const staff = Math.max(1, job ? jobCount(state, `${company.buildingId}::${job.id}::listed`) : 0);
    rows.push({ key: `company:${company.id}`, score: recentProfit(company.history) / staff });
  }
  return rows;
}

// 每月 1 号（或还没定过时）重新排一次发薪日。
export function assignPayDays(state, content) {
  state.payroll ||= {};
  if (state.payroll.payDays && dayOfMonth(state, content) !== 1) return null;
  const rows = employerRows(state, content);
  const profitable = rows.filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const payDays = {};
  profitable.forEach((row, index) => {
    payDays[row.key] = PAY_DAYS[Math.min(PAY_DAYS.length - 1, Math.floor(index * PAY_DAYS.length / profitable.length))];
  });
  for (const row of rows) if (!(row.key in payDays)) payDays[row.key] = LOW_PAY_DAY;
  state.payroll.payDays = payDays;
  return payDays;
}
