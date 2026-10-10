import { currencyScale } from "../economy/currency.js";
import { currentPaymentComposition, maximumPayableValueUnits, normalizePaymentObligation, settleMonetaryPayment } from "../economy/payment.js";
import { makeTransactionId, recordLedger } from "../economy/ledger.js";
import { syncResidentAggregates, householdList, isActiveHousehold, householdConvertibleWheatUnits } from "./households.js";

// 社保基金：独立钱包（支付账户 "social"），粮券存 cashVoucherUnits。
// - 收缴：每人每天按人头缴费；雇主承担 employerSharePercent%（默认全额），其余由员工家庭自付（见 collectSocialContributions）。
// - 发放：养老金、失业金、农民补贴（基金开启时）由基金支付；基金不足时镇库垫付，垫付额记入基金对国库的负债。
// - 镇库注资同样记为负债；基金可主动还款给镇库。
// - 基金可在交易所买卖上市公司股份（company.fundShares），按持股比例参与年度利润分配。
// - 设置与操作入口在社保局建筑；未建社保局时不能调整，旧档已开启的基金照常运转。

export const SOCIAL_OWNER = "social";
export const DEFAULT_SS_DAILY_JIN = 1;
export const DEFAULT_SS_PENSION_JIN = 2;
export const DEFAULT_SS_FARMER_SUBSIDY_JIN = 0;
export const DEFAULT_EMPLOYER_SHARE_PERCENT = 100;

export function ensureSocialSecurity(state) {
  state.socialSecurity ||= {};
  const ss = state.socialSecurity;
  ss.enabled ??= false;
  ss.dailyPerWorkerJin ??= DEFAULT_SS_DAILY_JIN;
  ss.pensionPerElderJin ??= DEFAULT_SS_PENSION_JIN;
  ss.farmerSubsidyPerFarmerJin ??= DEFAULT_SS_FARMER_SUBSIDY_JIN;
  ss.cashVoucherUnits ??= 0;
  delete ss.cashWheatUnits;
  ss.debtToTownUnits ??= 0;
  ss.totalInjectedUnits ??= 0;
  ss.totalAdvancedUnits ??= 0;
  ss.totalRepaidUnits ??= 0;
  ss.totalCollectedUnits ??= 0;
  ss.totalPaidUnits ??= 0;
  ss.totalDividendUnits ??= 0;
  ss.totalSubsidyUnits ??= 0;
  ss.employerSharePercent ??= DEFAULT_EMPLOYER_SHARE_PERCENT;
  ss.employerArrears ||= {};
  return ss;
}

export function hasSocialSecurityOffice(state) {
  return (state.buildings || []).some(building => building.typeId === "social_security_office");
}

function requireOffice(state) {
  return hasSocialSecurityOffice(state) ? null : { ok: false, reason: "需先建成社保局" };
}


export function fundValueUnits(state, content) {
  return maximumPayableValueUnits(state, SOCIAL_OWNER, content);
}

// 政策命令：开关 / 缴费标准 / 养老金标准 / 农民补贴标准。
export function setSocialSecurityPolicy(state, patch) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const ss = ensureSocialSecurity(state);
  if (patch.enabled !== undefined) ss.enabled = Boolean(patch.enabled);
  if (patch.dailyPerWorkerJin !== undefined) {
    const value = Number(patch.dailyPerWorkerJin);
    if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "每日缴费须为有限的非负数" };
    ss.dailyPerWorkerJin = value;
  }
  if (patch.pensionPerElderJin !== undefined) {
    const value = Number(patch.pensionPerElderJin);
    if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "养老金须为有限的非负数" };
    ss.pensionPerElderJin = value;
  }
  if (patch.farmerSubsidyPerFarmerJin !== undefined) {
    const value = Number(patch.farmerSubsidyPerFarmerJin);
    if (!Number.isFinite(value) || value < 0 || value > 100000) return { ok: false, reason: "农民补贴须为有限的非负数" };
    ss.farmerSubsidyPerFarmerJin = value;
  }
  return { ok: true, socialSecurity: {
    enabled: ss.enabled, dailyPerWorkerJin: ss.dailyPerWorkerJin, pensionPerElderJin: ss.pensionPerElderJin,
    farmerSubsidyPerFarmerJin: ss.farmerSubsidyPerFarmerJin
  } };
}

// 政策命令：雇主承担社保的比例（0–100，整数或一位小数）。
export function setEmployerSocialSharePercent(state, percent) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const raw = typeof percent === "string" ? percent.trim() : percent;
  const value = typeof raw === "number" || (typeof raw === "string" && raw !== "") ? Number(raw) : NaN;
  const tenths = value * 10;
  if (!Number.isFinite(value) || value < 0 || value > 100 || Math.abs(tenths - Math.round(tenths)) > 1e-9) {
    return { ok: false, reason: "雇主承担比例须为0–100之间的整数或一位小数" };
  }
  const ss = ensureSocialSecurity(state);
  ss.employerSharePercent = Math.round(tenths) / 10;
  return { ok: true, employerSharePercent: ss.employerSharePercent };
}

// 镇库注资：真实转账到基金钱包，并记为基金欠国库的负债。
export function injectSocialSecurity(state, amountJin, content) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const ss = ensureSocialSecurity(state);
  const requested = Math.round(Math.max(0, Number(amountJin) || 0) * currencyScale(content));
  if (!Number.isSafeInteger(requested) || requested <= 0) return { ok: false, reason: "注资金额必须大于0" };
  const amount = Math.min(requested, maximumPayableValueUnits(state, "town", content));
  if (amount <= 0) return { ok: false, reason: "镇库可用资金不足" };
  const result = settleMonetaryPayment(state, "town", SOCIAL_OWNER, currentPaymentComposition(state, amount), content,
    "social_security_inject", "镇库向社保基金注资（计为基金负债）", { requireFull: false });
  const paid = result.paidValueUnits || 0;
  if (paid <= 0) return { ok: false, reason: result.reason || "注资失败" };
  ss.totalInjectedUnits += paid;
  ss.debtToTownUnits += paid;
  return { ok: true, injectedValueUnits: paid, injectedJin: paid / currencyScale(content) };
}

// 基金还款给镇库：最多还清负债。
export function repaySocialSecurityDebt(state, amountJin, content) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const ss = ensureSocialSecurity(state);
  if ((ss.debtToTownUnits || 0) <= 0) return { ok: false, reason: "基金没有欠国库的钱" };
  const requested = Math.round(Math.max(0, Number(amountJin) || 0) * currencyScale(content));
  if (!Number.isSafeInteger(requested) || requested <= 0) return { ok: false, reason: "还款金额必须大于0" };
  const amount = Math.min(requested, ss.debtToTownUnits, fundValueUnits(state, content));
  if (amount <= 0) return { ok: false, reason: "基金可用资金不足" };
  const result = settleMonetaryPayment(state, SOCIAL_OWNER, "town", currentPaymentComposition(state, amount), content,
    "social_security_repay", "社保基金向镇库还款", { requireFull: false });
  const paid = result.paidValueUnits || 0;
  if (paid <= 0) return { ok: false, reason: result.reason || "还款失败" };
  ss.debtToTownUnits = Math.max(0, ss.debtToTownUnits - paid);
  ss.totalRepaidUnits += paid;
  return { ok: true, repaidValueUnits: paid, repaidJin: paid / currencyScale(content), debtJin: ss.debtToTownUnits / currencyScale(content) };
}

// 基金向家庭付款：基金先付，不足部分镇库垫付并记为基金负债。
export function payFromFund(state, householdId, dueUnits, content, type, reason) {
  const ss = ensureSocialSecurity(state);
  const target = `household:${householdId}`;
  const fundResult = settleMonetaryPayment(state, SOCIAL_OWNER, target, currentPaymentComposition(state, dueUnits), content,
    type, reason, { requireFull: false });
  const fromFund = fundResult.paidValueUnits || 0;
  let fromTown = 0;
  if ((fundResult.remainingValueUnits || 0) > 0) {
    const townResult = settleMonetaryPayment(state, "town", target, normalizePaymentObligation(fundResult.remainingComposition, state), content,
      type, `${reason}（镇库垫付，计入基金负债）`, { requireFull: false });
    fromTown = townResult.paidValueUnits || 0;
    ss.debtToTownUnits += fromTown;
    ss.totalAdvancedUnits += fromTown;
  }
  ss.totalPaidUnits += fromFund + fromTown;
  return { paidValueUnits: fromFund + fromTown, fromFund, fromTown };
}

// 救济口粮由镇库实物拨付；基金开启时按口粮价值向镇库结算，付不起的部分计入基金负债。
export function chargeFundForRelief(state, valueUnits, content) {
  const ss = ensureSocialSecurity(state);
  if (!ss.enabled || valueUnits <= 0) return { fromFund: 0, owed: 0 };
  const result = settleMonetaryPayment(state, SOCIAL_OWNER, "town", currentPaymentComposition(state, valueUnits), content,
    "relief_reimbursement", "社保基金承担救济口粮", { requireFull: false });
  const fromFund = result.paidValueUnits || 0;
  const owed = Math.max(0, valueUnits - fromFund);
  ss.debtToTownUnits += owed;
  ss.totalAdvancedUnits += owed;
  ss.totalPaidUnits += valueUnits;
  return { fromFund, owed };
}

// ---------------------------------------------------------------- 雇主缴社保（docs/REDISTRIBUTION.md 第 3 节）
//
// 每人每天 dailyPerWorkerJin；雇主替员工承担 employerSharePercent%（默认 100），其余由员工所在家庭自付。
// 雇主按岗位键认定（岗位键构造见 selectors/labor.js）：
//   `${建筑}::${岗位}`             按建筑当前主人（buildingOwner）：镇营 → 镇库；民营 → 业主家庭；公司 → 公司
//   `${建筑}::${岗位}::private`    民营 → 业主家庭
//   `${建筑}::${岗位}::listed`     公司 → 该建筑的公司
//   `shop:${店铺}:merchant|clerk`  店铺 → 店铺；业主本人在自家店里当商人 = 自雇；集体摊位（时代广场）商人不领工资 = 自雇
//   务农（无 "::" 的岗位键）及认不出的键 → 自雇，全额由家庭自己交
// 雇主（或自雇的家庭）付不起的雇主部分记入 ss.employerArrears[雇主]：不算欠薪、不触发收回；下次有钱时先补缴。

export const SOCIAL_EMPLOYER_TOWN = "town";
const SHOP_JOB_KEY = /^shop:([^:]+):(merchant|clerk)$/;
const SELF_EMPLOYED = Object.freeze({ employer: null, kind: "self" });

function employerSharePercent(ss) {
  const value = Number(ss?.employerSharePercent ?? DEFAULT_EMPLOYER_SHARE_PERCENT);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : DEFAULT_EMPLOYER_SHARE_PERCENT;
}

function shopCanEmploy(record) {
  return Boolean(record) && !record.collective && record.status !== "closed";
}

// 雇主账户名是否仍然存在："town" | "household:<id>" | "company:<id>" | "shop:<id>"。
function employerExists(state, owner) {
  if (owner === SOCIAL_EMPLOYER_TOWN) return true;
  const id = owner.slice(owner.indexOf(":") + 1);
  if (owner.startsWith("household:")) return isActiveHousehold(state.households?.byId?.[id]);
  if (owner.startsWith("company:")) return Boolean(state.companies?.[id]);
  if (owner.startsWith("shop:")) return shopCanEmploy(state.shops?.[id]);
  return false;
}

function employerKindOf(owner) {
  if (owner === SOCIAL_EMPLOYER_TOWN) return "town";
  if (owner.startsWith("household:")) return "private";
  if (owner.startsWith("company:")) return "company";
  if (owner.startsWith("shop:")) return "shop";
  return null;
}

function employerName(state, owner) {
  if (owner === SOCIAL_EMPLOYER_TOWN) return "镇库";
  const id = owner.slice(owner.indexOf(":") + 1);
  if (owner.startsWith("household:")) return state.households?.byId?.[id]?.name || id;
  if (owner.startsWith("company:")) return state.companies?.[id]?.name || id;
  if (owner.startsWith("shop:")) return state.shops?.[id]?.name || id;
  return owner;
}

// 一天内的雇主认定缓存：楼栋索引只建一次，岗位键按键缓存（同一键对所有家庭的结果相同）。
function socialEmployerContext(state) {
  const buildingsById = new Map();
  for (const building of state.buildings || []) buildingsById.set(building.id, building);
  const companyByBuilding = new Map();
  for (const company of Object.values(state.companies || {})) {
    if (company?.buildingId && !companyByBuilding.has(company.buildingId)) companyByBuilding.set(company.buildingId, company);
  }
  return { buildingsById, companyByBuilding, byKey: new Map() };
}

function employerInfo(state, owner, extra = {}) {
  return employerExists(state, owner) ? { employer: owner, kind: employerKindOf(owner), ...extra } : SELF_EMPLOYED;
}

function resolveSocialEmployerUncached(state, jobKey, ctx) {
  const shop = SHOP_JOB_KEY.exec(jobKey);
  if (shop) {
    const record = state.shops?.[shop[1]];
    // 镇营综合商店：雇主是镇库（工资与社保都由镇库承担）。
    if (record?.town && record.status !== "closed" && record.status !== "liquidating") return employerInfo(state, SOCIAL_EMPLOYER_TOWN);
    return shopCanEmploy(record)
      ? { employer: `shop:${shop[1]}`, kind: "shop", ownerHouseholdId: record.ownerHouseholdId || null }
      : SELF_EMPLOYED;
  }
  const parts = String(jobKey).split("::");
  if (parts.length !== 2 && parts.length !== 3) return SELF_EMPLOYED;
  const building = ctx.buildingsById.get(parts[0]);
  if (!building) return SELF_EMPLOYED;
  if (parts.length === 3) {
    if (parts[2] === "private") {
      const id = (building.privateOwners || [])[0];
      return id ? employerInfo(state, `household:${id}`) : SELF_EMPLOYED;
    }
    if (parts[2] === "listed") {
      const company = ctx.companyByBuilding.get(building.id);
      return company ? employerInfo(state, `company:${company.id}`) : SELF_EMPLOYED;
    }
    return SELF_EMPLOYED;
  }
  // 整栋一个主人（docs/OWNERSHIP.md）。这里直接读 ownership，不引 systems/ownership.js，免得
  // selectors/labor → … → social-security → ownership → selectors/labor 形成循环依赖。
  if ((building.ownership?.privateLevels || 0) > 0) {
    const ownerId = (building.privateOwners || [])[0];
    return ownerId ? employerInfo(state, `household:${ownerId}`) : SELF_EMPLOYED;
  }
  if ((building.ownership?.listedLevels || 0) > 0) {
    const company = ctx.companyByBuilding.get(building.id);
    return company ? employerInfo(state, `company:${company.id}`) : SELF_EMPLOYED;
  }
  return employerInfo(state, SOCIAL_EMPLOYER_TOWN);
}

function resolveSocialEmployer(state, jobKey, ctx) {
  let info = ctx.byKey.get(jobKey);
  if (!info) {
    info = resolveSocialEmployerUncached(state, jobKey, ctx);
    ctx.byKey.set(jobKey, info);
  }
  return info;
}

// 查询某户某岗位键的雇主认定（供界面与测试）：{ employer, kind, self }；self 为真表示这户全额自付。
export function socialEmployerForJobKey(state, householdId, jobKey) {
  const household = state.households?.byId?.[householdId];
  const info = resolveSocialEmployerUncached(state, jobKey, socialEmployerContext(state));
  return { employer: info.employer, kind: info.kind, self: household ? isSocialSelfEmployed(info, household) : true };
}

// 该岗位的工人对这户来说是否"自雇"（没有雇主，或雇主就是这户自己）。
function isSocialSelfEmployed(info, household) {
  if (!info.employer) return true;
  if (info.employer === `household:${household.id}`) return true;
  return info.kind === "shop" && info.ownerHouseholdId === household.id;
}

// 每日社保缴费。在当天发完工资之后执行，分两段结算：
//   1. 雇主段：每个雇主汇总本日应缴的雇主部分，连同此前欠缴一并一次付清；付不起的记入 employerArrears。
//   2. 家庭段：各户自付部分（员工部分未被雇主承担的份额，加上自雇全额），付不起的当天免缴。
// 用粮券或小麦付；家庭作为雇主或自付方时不动口粮储备。
export function collectSocialContributions(state, content) {
  const ss = ensureSocialSecurity(state);
  if (!ss.enabled) return { collectedValueUnits: 0 };
  const perWorker = Math.round(Math.max(0, Number(ss.dailyPerWorkerJin) || 0) * currencyScale(content));
  if (perWorker <= 0) return { collectedValueUnits: 0 };
  const sharePercent = employerSharePercent(ss);
  const reserveDays = content.rules.householdFoodReserveDays ?? 30;
  const arrears = ss.employerArrears ||= {};
  for (const owner of Object.keys(arrears)) {
    if (!(arrears[owner] > 0) || !employerExists(state, owner)) delete arrears[owner];
  }

  const ctx = socialEmployerContext(state);
  const employerRows = new Map(); // 雇主账户名 → { due, workers }
  const householdSelf = new Map(); // 家庭 id → { units, employed }
  let workers = 0;
  let due = 0;
  let employerDue = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    let selfUnits = 0;
    let employed = 0;
    for (const [jobKey, raw] of Object.entries(household.jobs || {})) {
      const count = Math.max(0, Math.floor(Number(raw) || 0));
      if (count <= 0) continue;
      const amount = count * perWorker;
      employed += count;
      workers += count;
      due += amount;
      const info = resolveSocialEmployer(state, jobKey, ctx);
      if (isSocialSelfEmployed(info, household)) {
        selfUnits += amount;
        continue;
      }
      const share = Math.round(amount * sharePercent / 100);
      selfUnits += amount - share;
      employerDue += share;
      const row = employerRows.get(info.employer) || { due: 0, workers: 0 };
      row.due += share;
      row.workers += count;
      employerRows.set(info.employer, row);
    }
    if (selfUnits > 0) householdSelf.set(household.id, { units: selfUnits, employed });
  }

  const previousDefer = Boolean(state._deferHouseholdSync);
  state._deferHouseholdSync = true;

  // 1. 雇主段：本日应缴 + 此前欠缴，一次付清。
  let employerCollected = 0;
  let arrearsPaid = 0;
  const employerOwners = new Set([...employerRows.keys(), ...Object.keys(arrears)]);
  for (const owner of employerOwners) {
    const row = employerRows.get(owner) || { due: 0, workers: 0 };
    const before = arrears[owner] || 0;
    const owed = before + row.due;
    let paid = 0;
    if (owed > 0) {
      const payerId = owner.startsWith("household:") ? owner.slice("household:".length) : null;
      const payer = payerId ? state.households?.byId?.[payerId] : null;
      const reason = row.workers > 0
        ? `${employerName(state, owner)}为${row.workers}名员工缴纳社保`
        : `${employerName(state, owner)}补缴社保欠款`;
      const result = settleMonetaryPayment(state, owner, SOCIAL_OWNER, currentPaymentComposition(state, owed), content,
        "social_security_employer_contribution", reason,
        { requireFull: false, maxWheatUnits: payer ? householdConvertibleWheatUnits(state, payer, content, reserveDays) : undefined });
      paid = result.paidValueUnits || 0;
    }
    const fromArrears = Math.min(paid, before);
    const fromToday = paid - fromArrears;
    const shortfall = row.due - fromToday;
    const left = before - fromArrears + shortfall;
    if (left > 0) arrears[owner] = left;
    else delete arrears[owner];
    employerCollected += paid;
    arrearsPaid += fromArrears;
  }

  // 2. 家庭段：员工自付部分，付不起的当天免缴。
  let householdCollected = 0;
  for (const [householdId, { units, employed }] of householdSelf) {
    const household = state.households?.byId?.[householdId];
    if (!household) continue;
    const result = settleMonetaryPayment(state, `household:${householdId}`, SOCIAL_OWNER, currentPaymentComposition(state, units), content,
      "social_security_contribution", `${household.name}缴纳社保（${employed}名在岗劳动力的员工自付部分）`,
      { requireFull: false, maxWheatUnits: householdConvertibleWheatUnits(state, household, content, reserveDays) });
    householdCollected += result.paidValueUnits || 0;
  }

  state._deferHouseholdSync = previousDefer;
  if (!previousDefer) syncResidentAggregates(state, content);

  const collected = employerCollected + householdCollected;
  ss.totalCollectedUnits += collected;
  const arrearsTotal = Object.values(arrears).reduce((sum, value) => sum + Math.max(0, value || 0), 0);
  ss.lastContribution = {
    workers, dueValueUnits: due, collectedValueUnits: collected,
    employerDueValueUnits: employerDue, employerCollectedValueUnits: employerCollected, employerArrearsPaidValueUnits: arrearsPaid,
    householdDueValueUnits: due - employerDue, householdCollectedValueUnits: householdCollected,
    employerArrearsValueUnits: arrearsTotal
  };
  return { ...ss.lastContribution };
}

// 每日养老金：按老人人数发到所在家庭。
export function payPensions(state, content) {
  const ss = ensureSocialSecurity(state);
  if (!ss.enabled) return { paid: 0 };
  const perElder = Math.round(Math.max(0, Number(ss.pensionPerElderJin) || 0) * currencyScale(content));
  if (perElder <= 0) return { paid: 0 };
  let paid = 0;
  let fromFund = 0;
  let due = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const elders = Math.max(0, household.ageBands?.elders || 0);
    if (elders <= 0) continue;
    due += elders * perElder;
    const result = payFromFund(state, household.id, elders * perElder, content, "pension_payment", `社保基金发放养老金${elders}位老人`);
    paid += result.paidValueUnits;
    fromFund += result.fromFund;
  }
  if (paid > 0) {
    recordLedger(state, {
      type: "pension_payment", transactionId: makeTransactionId(state), source: "social_security_fund", destination: "residents",
      itemId: "money_value", quantityUnits: paid, qeqUnits: 0,
      reason: `本日发放养老金${paid}小麦等值单位（基金承担${fromFund}，镇库垫付${paid - fromFund}）`
    }, content);
    syncResidentAggregates(state, content);
  }
  return { paidValueUnits: paid, fromFundValueUnits: fromFund, dueValueUnits: due };
}

// 每日农民补贴：按在岗务农人数（household.jobs.farmers）发到所在家庭，与养老金同一套基金付款规则。
export function payFarmerSubsidies(state, content) {
  const ss = ensureSocialSecurity(state);
  if (!ss.enabled) return { paidValueUnits: 0, fromFundValueUnits: 0, dueValueUnits: 0 };
  const perFarmer = Math.round(Math.max(0, Number(ss.farmerSubsidyPerFarmerJin) || 0) * currencyScale(content));
  if (perFarmer <= 0) return { paidValueUnits: 0, fromFundValueUnits: 0, dueValueUnits: 0 };
  let paid = 0;
  let fromFund = 0;
  let due = 0;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const farmers = Math.max(0, Math.floor(Number(household.jobs?.farmers) || 0));
    if (farmers <= 0) continue;
    due += farmers * perFarmer;
    const result = payFromFund(state, household.id, farmers * perFarmer, content, "farmer_subsidy", `社保基金发放农民补贴${farmers}位农民`);
    paid += result.paidValueUnits;
    fromFund += result.fromFund;
  }
  if (paid > 0) {
    ss.totalSubsidyUnits += paid;
    recordLedger(state, {
      type: "farmer_subsidy", transactionId: makeTransactionId(state), source: "social_security_fund", destination: "residents",
      itemId: "money_value", quantityUnits: paid, qeqUnits: 0,
      reason: `本日发放农民补贴${paid}小麦等值单位（基金承担${fromFund}，镇库垫付${paid - fromFund}）`
    }, content);
    syncResidentAggregates(state, content);
  }
  return { paidValueUnits: paid, fromFundValueUnits: fromFund, dueValueUnits: due };
}

// ---------------------------------------------------------------- 股票

function listedCompany(state, companyId) {
  const company = state.companies?.[companyId];
  if (!company?.listing?.listed) return null;
  company.fundShares ??= 0;
  return company;
}

// 从镇库做市池按实时股价买入。
export function fundBuyShares(state, companyId, shares, content) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const company = listedCompany(state, companyId);
  if (!company) return { ok: false, reason: "公司未上市" };
  const count = Math.floor(Number(shares) || 0);
  if (count <= 0) return { ok: false, reason: "股数须大于0" };
  const price = company.sharePriceVoucherUnits || company.shareSale?.sharePriceVoucherUnits || 0;
  if (!(price > 0)) return { ok: false, reason: "暂无股价" };
  const available = (company.townShares || 0) - (company.shareSale?.offeredShares || 0);
  if (count > available) return { ok: false, reason: `镇库可售仅${Math.max(0, available)}股` };
  const cost = count * price;
  if (cost > fundValueUnits(state, content)) return { ok: false, reason: "基金资金不足" };
  const result = settleMonetaryPayment(state, SOCIAL_OWNER, "town", currentPaymentComposition(state, cost), content,
    "social_share_buy", `社保基金买入${company.name}${count}股`, { requireFull: true });
  if (!result.ok) return { ok: false, reason: result.reason || "支付失败" };
  company.townShares -= count;
  company.fundShares += count;
  return { ok: true, shares: count, costVoucherUnits: cost };
}

// 按实时股价卖回镇库。
export function fundSellShares(state, companyId, shares, content) {
  const blocked = requireOffice(state);
  if (blocked) return blocked;
  const company = listedCompany(state, companyId);
  if (!company) return { ok: false, reason: "公司未上市" };
  const count = Math.floor(Number(shares) || 0);
  if (count <= 0) return { ok: false, reason: "股数须大于0" };
  if (count > (company.fundShares || 0)) return { ok: false, reason: `基金仅持有${company.fundShares || 0}股` };
  const price = company.sharePriceVoucherUnits || company.shareSale?.sharePriceVoucherUnits || 0;
  if (!(price > 0)) return { ok: false, reason: "暂无股价" };
  const proceeds = count * price;
  const result = settleMonetaryPayment(state, "town", SOCIAL_OWNER, currentPaymentComposition(state, proceeds), content,
    "social_share_sell", `社保基金卖出${company.name}${count}股给镇库`, { requireFull: true });
  if (!result.ok) return { ok: false, reason: result.reason || "镇库资金不足，无法回购" };
  company.fundShares -= count;
  company.townShares += count;
  return { ok: true, shares: count, proceedsVoucherUnits: proceeds };
}

export function recordFundDividend(state, units) {
  ensureSocialSecurity(state).totalDividendUnits += Math.max(0, units || 0);
}

export function selectSocialSecurityStats(state, content) {
  const ss = state.socialSecurity || {};
  const scale = currencyScale(content);
  const jin = value => (value || 0) / scale;
  const holdings = Object.values(state.companies || {})
    .filter(company => company.listing?.listed)
    .map(company => {
      const price = company.sharePriceVoucherUnits || company.shareSale?.sharePriceVoucherUnits || 0;
      return {
        companyId: company.id, name: company.name, shares: company.fundShares || 0,
        priceJin: price / scale, valueJin: (company.fundShares || 0) * price / scale,
        townAvailable: Math.max(0, (company.townShares || 0) - (company.shareSale?.offeredShares || 0))
      };
    });
  const arrearsByKind = { town: 0, private: 0, company: 0, shop: 0 };
  const debtors = [];
  for (const [owner, value] of Object.entries(ss.employerArrears || {})) {
    const kind = employerKindOf(owner);
    if (!kind || !(value > 0)) continue;
    arrearsByKind[kind] += value;
    debtors.push({ owner, kind, name: employerName(state, owner), arrearsJin: jin(value) });
  }
  debtors.sort((a, b) => b.arrearsJin - a.arrearsJin || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  const last = ss.lastContribution || {};
  return {
    hasOffice: hasSocialSecurityOffice(state),
    enabled: Boolean(ss.enabled),
    dailyPerWorkerJin: ss.dailyPerWorkerJin ?? DEFAULT_SS_DAILY_JIN,
    pensionPerElderJin: ss.pensionPerElderJin ?? DEFAULT_SS_PENSION_JIN,
    farmerSubsidyPerFarmerJin: ss.farmerSubsidyPerFarmerJin ?? DEFAULT_SS_FARMER_SUBSIDY_JIN,
    cashJin: jin(ss.cashVoucherUnits),
    voucherJin: jin(ss.cashVoucherUnits),
    debtJin: jin(ss.debtToTownUnits),
    stockValueJin: holdings.reduce((sum, row) => sum + row.valueJin, 0),
    holdings,
    totalInjectedJin: jin(ss.totalInjectedUnits),
    totalAdvancedJin: jin(ss.totalAdvancedUnits),
    totalRepaidJin: jin(ss.totalRepaidUnits),
    totalCollectedJin: jin(ss.totalCollectedUnits),
    totalPaidJin: jin(ss.totalPaidUnits),
    totalSubsidyJin: jin(ss.totalSubsidyUnits),
    totalDividendJin: jin(ss.totalDividendUnits),
    employerSharePercent: employerSharePercent(ss),
    employerArrearsJin: jin(Object.values(arrearsByKind).reduce((sum, value) => sum + value, 0)),
    employerArrearsByKindJin: Object.fromEntries(Object.entries(arrearsByKind).map(([kind, value]) => [kind, jin(value)])),
    topEmployerDebtors: debtors.slice(0, 5),
    lastContribution: {
      workers: last.workers || 0,
      dueJin: jin(last.dueValueUnits),
      collectedJin: jin(last.collectedValueUnits),
      employerDueJin: jin(last.employerDueValueUnits),
      employerCollectedJin: jin(last.employerCollectedValueUnits),
      employerArrearsPaidJin: jin(last.employerArrearsPaidValueUnits),
      householdDueJin: jin(last.householdDueValueUnits),
      householdCollectedJin: jin(last.householdCollectedValueUnits),
      employerArrearsJin: jin(last.employerArrearsValueUnits)
    }
  };
}
