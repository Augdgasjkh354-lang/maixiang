// 正式员工：雇主辞退员工的规则（店铺、民营、公司由雇主自己决定；镇营由镇长在就业面板减人）。
//
// - 入职满 rules.dismissalMinTenureDays（30）天的人才能辞退；先辞退入职最久的。
// - 辞退时付 rules.severanceWageDays（30）天日薪作补偿，由雇主付给被辞退者的家庭；付不起的部分记进雇主的工资债权
//   （即欠薪，之后照常偿付）。
// - 被挖走、退休、去世、店铺暂停这类不是辞退，不付补偿（它们直接走 setHouseholdJobCount / releaseJobFromHousehold）。
import { currencyScale } from "../economy/currency.js";
import { currentPaymentComposition, addPaymentObligation, maximumPayableValueUnits, settleMonetaryPayment } from "../economy/payment.js";
import { householdList, jobTenureDays, setHouseholdJobCount, withDeferredHouseholdSync } from "./households.js";
import { wageBook } from "./employer.js";

export function minTenureDays(content) {
  return Math.max(0, Math.floor(content.rules.dismissalMinTenureDays ?? 30));
}

// 某岗位现在能辞退几个人（入职满期限的）。
export function dismissibleCount(state, jobKey, content) {
  const minimum = minTenureDays(content);
  let count = 0;
  for (const household of householdList(state)) {
    if (!(household.jobs?.[jobKey] > 0)) continue;
    count += jobTenureDays(state, household, jobKey).filter(days => days >= minimum).length;
  }
  return count;
}

// 辞退 count 人（只辞退满期限的，入职最久的先走），付补偿。
// payer：付款账户（"town"、"shop:x"、"company:x"、"household:x"）或 { id, maxWheatUnits }；
// dailyWage：被辞退者的日薪（粮券）；book：雇主的工资债权簿，付不起的补偿记在这里。
// 返回 { dismissed, severanceVoucherUnits, paidVoucherUnits, rows }。
export function dismissWorkers(state, jobKey, count, { payer, dailyWage, book = null, reason = "辞退补偿" }, content) {
  const minimum = minTenureDays(content);
  const severancePerWorker = Math.round(Math.max(0, dailyWage || 0) * Math.max(0, content.rules.severanceWageDays ?? 30) * currencyScale(content));
  const payerRow = typeof payer === "string" ? { id: payer } : payer;
  // 候选：每户能辞退的人数，按"最久的入职天数"从长到短排，确定性。
  const candidates = householdList(state)
    .filter(household => household.jobs?.[jobKey] > 0)
    .map(household => {
      const tenure = jobTenureDays(state, household, jobKey);
      return { household, eligible: tenure.filter(days => days >= minimum).length, longest: tenure[0] ?? 0 };
    })
    .filter(row => row.eligible > 0)
    .sort((a, b) => b.longest - a.longest || a.household.id.localeCompare(b.household.id));
  let left = Math.max(0, Math.floor(count));
  const rows = [];
  let paidTotal = 0;
  withDeferredHouseholdSync(state, content, () => {
    for (const row of candidates) {
      if (left <= 0) break;
      const cut = Math.min(left, row.eligible);
      const before = row.household.jobs[jobKey] || 0;
      setHouseholdJobCount(state, row.household.id, jobKey, before - cut, null, { removeOldest: true });
      left -= cut;
      const severance = severancePerWorker * cut;
      let paid = 0;
      if (severance > 0 && payerRow?.id) {
        const result = settleMonetaryPayment(state, payerRow.id, `household:${row.household.id}`, currentPaymentComposition(state, severance), content,
          "severance_payment", `${reason}：${row.household.name}${cut}人`, { requireFull: false, maxWheatUnits: payerRow.maxWheatUnits });
        paid = result.paidValueUnits || 0;
      }
      const unpaid = severance - paid;
      if (unpaid > 0 && book) {
        wageBook(book);
        book.claimsVoucherUnits[row.household.id] = (book.claimsVoucherUnits[row.household.id] || 0) + unpaid;
        book.claimsPayment[row.household.id] = addPaymentObligation(book.claimsPayment[row.household.id], currentPaymentComposition(state, unpaid));
      }
      paidTotal += paid;
      rows.push({ householdId: row.household.id, count: cut, severanceVoucherUnits: severance, paidVoucherUnits: paid });
    }
  });
  const dismissed = rows.reduce((sum, row) => sum + row.count, 0);
  return { dismissed, severanceVoucherUnits: severancePerWorker * dismissed, paidVoucherUnits: paidTotal, rows };
}

// 开张期：雇主开张（开店、转民营、成立公司）后 rules.openingPeriodDays（30）天内，每天都可按需求招够人。
// since = { year, day }（day 为当年第几天，1 起或 0 起都行，差一天无妨）；没有记录（旧存档）不算开张期。
export function inOpeningPeriod(state, content, since) {
  if (!since || !Number.isFinite(since.year) || !Number.isFinite(since.day)) return false;
  const now = (Math.max(1, state.year || 1) - 1) * content.rules.daysPerYear + (state.day || 0);
  const start = (Math.max(1, since.year) - 1) * content.rules.daysPerYear + since.day;
  return now - start < Math.max(0, content.rules.openingPeriodDays ?? 30);
}

// 雇主每月 1 号审核一次用工（店铺、民营、公司共用）：
// desired 是按需求算出的人数；人手不够就招一人（有待业的话），多了就辞退一个满期限的人并付补偿。
// immediateHire：玩家手动设的目标人数（公司），招人立即补到目标，减人仍走辞退规则。返回剩余待业人数。
// losing：近期亏损的雇主可以一次辞退到需要的人数（平时每月最多一人）。
export function reviewStaffing(state, content, { jobKey, current, desired, idle, hire, payer, dailyWage, book, reason, immediateHire = false, opening = false, losing = false }) {
  if (desired > current) {
    const fast = immediateHire || opening;
    if (!fast && dayOfMonthOf(state, content) !== 1) return idle;
    const add = fast ? Math.min(desired - current, idle) : Math.min(1, idle);
    if (add > 0) hire(current + add);
    return idle - add;
  }
  if (desired < current && (immediateHire || dayOfMonthOf(state, content) === 1)) {
    let cut = immediateHire || losing ? current - desired : 1;
    // 付得起补偿才辞退：钱不够时先留人（留一个月的工钱与一个月补偿差不多），免得补偿变成欠薪把雇主拖垮。
    const perWorker = Math.round(Math.max(0, dailyWage || 0) * Math.max(0, content.rules.severanceWageDays ?? 30) * currencyScale(content));
    const payerId = typeof payer === "string" ? payer : payer?.id;
    if (perWorker > 0 && payerId) {
      const affordable = Math.floor(maximumPayableValueUnits(state, payerId, content, { maxWheatUnits: payer?.maxWheatUnits }) / perWorker);
      cut = Math.min(cut, affordable);
    }
    if (cut <= 0) return idle;
    const result = dismissWorkers(state, jobKey, Math.min(cut, dismissibleCount(state, jobKey, content)), { payer, dailyWage, book, reason }, content);
    return idle + result.dismissed;
  }
  return idle;
}

function dayOfMonthOf(state, content) {
  return ((state.day || 0) % (content.rules.monthDays || 30)) + 1;
}
