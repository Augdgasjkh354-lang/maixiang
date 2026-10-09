// 旧存档换算（docs/OWNERSHIP.md「旧存档换算」）：读档时把按等级拆开的建筑整栋交给一个主人。
//
// 调用位置：src/persistence/migrations.js 的 migrateSave，存档合并到底板、派生数据重算之后，校验之前。
// 幂等：已经整栋（恰好一个主人、等级对得上）的建筑是空操作；换算后的存档再读一次不会再动。
// 单栋换算失败：回到该栋换算前的快照，整栋划归镇里（不付任何补偿），并写进读档报告。绝不抛错。
//
// 估值口径：
//   每级估值 = 经营权估值（selectOperatingRightPreview 的 referencePriceWheatJin，整栋价）÷ 等级；
//   经营权估值为 0（无利润资料且理论估算不为正）时，改用建造 + 历次升级的材料按当前批发价折算（÷ 等级）。
// 股份口径：公司清算时居民与社保基金的股份按当前股价由镇库回购；镇库付不起的股份注销，并记事件。
//
// 与 docs/OWNERSHIP.md 的两处补充（文档没写明，这里定死）：
//   - 等级平手归镇里：镇里与公司或民营并列最多时归镇里；公司与民营并列（镇里更少）也归镇里。
//   - 民营胜出时，镇营等级并入民营业主不另付钱（文档只写"同理并入"，按字面执行）。

import { ensureProjectAccessor } from "../core/state.js";
import { addTownCostBasis } from "../economy/business.js";
import { recordEvent } from "../economy/ledger.js";
import { currencyScale } from "../economy/currency.js";
import { currentUnitPrice } from "../economy/prices.js";
import { currentPaymentComposition, maximumFullyPayableValueUnits, maximumPayableValueUnits, settleMonetaryPayment } from "../economy/payment.js";
import { takeStock } from "../economy/trade.js";
import { jobKeyForBuilding } from "../selectors/labor.js";
import { selectOperatingRightPreview } from "../selectors/operating-rights.js";
import { payWages, transferWageClaimsToTown, wageArrears, wageBook } from "./employer.js";
import { syncResidentAggregates } from "./households.js";
import { buildingMaterialValueUnits, companyOfBuilding, syncOwnershipLevels, transferBuildingOwnership } from "./ownership.js";

const SOCIAL = "social";

function clampInt(value) {
  const n = Math.floor(Number(value) || 0);
  return n > 0 ? n : 0;
}

function voucherText(units, content) {
  return String(Math.round(units / currencyScale(content) * 10) / 10);
}

function snapshot(state) {
  return JSON.parse(JSON.stringify(state));
}

function restore(state, saved) {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, saved);
  ensureProjectAccessor(state);
}

// 整栋：恰好一个非零主人且等级等于建筑等级；民营须恰好一户存在的业主；公司须有对应公司且等级一致。
export function isWholeBuilding(state, building) {
  const ownership = building.ownership || {};
  const level = Math.max(1, building.level || 1);
  const values = [ownership.townLevels || 0, ownership.privateLevels || 0, ownership.listedLevels || 0];
  const nonZero = values.filter(value => value > 0);
  if (nonZero.length !== 1 || nonZero[0] !== level) return false;
  // 有公司对象的建筑，公司等级必须就是整栋等级（否则公司是孤儿，须随换算清算）。
  const company = companyOfBuilding(state, building.id);
  if (company && !((ownership.listedLevels || 0) === level && company.listedLevels === level)) return false;
  if ((ownership.privateLevels || 0) > 0) {
    const owners = building.privateOwners || [];
    return owners.length === 1 && Boolean(state.households?.byId?.[owners[0]]);
  }
  if ((ownership.listedLevels || 0) > 0) return Boolean(company);
  return true;
}

// 读出拆开的各方等级。业主列表里找不到的家庭，其等级并入镇里；等级对不上的差额也归镇里。
function readParts(state, building) {
  const ownership = building.ownership || {};
  const level = Math.max(1, building.level || 1);
  const company = companyOfBuilding(state, building.id);
  const privateLevels = clampInt(ownership.privateLevels);
  const counts = new Map();
  for (const id of building.privateOwners || []) {
    if (!state.households?.byId?.[id]) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  let remaining = privateLevels;
  const households = [];
  for (const [id, count] of counts) {
    const levels = Math.min(count, remaining);
    if (levels > 0) households.push({ id, levels });
    remaining -= levels;
  }
  const privateTotal = privateLevels - remaining;
  const companyLevels = company ? clampInt(ownership.listedLevels) : 0;
  // 镇里的等级 = 建筑等级减去公司与民营的等级（没有对应公司的公司等级、找不到业主的民营等级、对不上的差额都归镇里）。
  const town = level - companyLevels - privateTotal;
  if (town < 0) throw new Error("各方等级之和超过建筑等级");
  return { town, company: companyLevels, companyId: company?.id || null, privateTotal, households, level };
}

// 等级最多的一方胜出；并列（含公司与民营并列）归镇里。民营一侧按户：户内等级最多者，平手取数组中靠前的。
function chooseWinner(parts) {
  const candidates = [{ kind: "town", levels: parts.town }];
  if (parts.companyId) candidates.push({ kind: "company", levels: parts.company });
  if (parts.privateTotal > 0) candidates.push({ kind: "household", levels: parts.privateTotal });
  const top = Math.max(...candidates.map(row => row.levels));
  const tied = candidates.filter(row => row.levels === top);
  if (tied.length > 1) return { kind: "town", id: null };
  const winner = tied[0];
  if (winner.kind === "company") return { kind: "company", id: parts.companyId };
  if (winner.kind === "household") {
    let best = parts.households[0];
    for (const row of parts.households) if (row.levels > best.levels) best = row;
    return { kind: "household", id: best.id };
  }
  return { kind: "town", id: null };
}

// 每级估值（内部单位）。
function levelValue(state, building, content) {
  const level = Math.max(1, building.level || 1);
  let wholeUnits = 0;
  try {
    const preview = selectOperatingRightPreview(state, building.id, content);
    wholeUnits = Math.max(0, Math.round((Number(preview?.referencePriceWheatJin) || 0) * currencyScale(content)));
  } catch {
    wholeUnits = 0;
  }
  let source = "经营权估值";
  if (!(wholeUnits > 0)) {
    wholeUnits = buildingMaterialValueUnits(state, building, content);
    source = "材料估值";
  }
  return { perLevelUnits: Math.round(wholeUnits / level), source };
}

// 镇库付款：能付的部分全付（先算付得起的上限，再按构成结算），返回实付价值单位。
function payFromTown(state, payee, units, content, type, reason) {
  if (!(units > 0)) return 0;
  const affordable = Math.min(units, maximumFullyPayableValueUnits(state, "town", units, content));
  if (affordable <= 0) return 0;
  const result = settleMonetaryPayment(state, "town", payee, currentPaymentComposition(state, affordable), content, type, reason, { requireFull: true });
  return result.ok ? affordable : 0;
}

// 民营业主补偿：每户 = 其等级 × 每级估值，由镇库付。
function compensateHouseholds(state, rows, perLevelUnits, content, name) {
  const result = { count: 0, dueUnits: 0, paidUnits: 0, unpaidUnits: 0 };
  for (const row of rows) {
    const due = row.levels * perLevelUnits;
    if (!(due > 0)) continue;
    result.count += 1;
    result.dueUnits += due;
    result.paidUnits += payFromTown(state, `household:${row.id}`, due, content, "ownership_takeover_compensation", `${name}整栋归属换算补偿`);
  }
  result.unpaidUnits = result.dueUnits - result.paidUnits;
  return result;
}

// 公司股东回购：居民（逐户）与社保基金按当前股价由镇库回购；镇库付不起的股份注销。
function buyOutCompanyShares(state, company, content) {
  const out = { shares: 0, paidUnits: 0, unpaidShares: 0, unpaidUnits: 0 };
  if (!company.listing?.listed) return out;
  const price = Math.max(0, Math.floor(company.sharePriceVoucherUnits || company.shareSale?.sharePriceVoucherUnits || 0));
  const holders = Object.entries(company.householdShares || {}).map(([id, shares]) => ({
    payee: `household:${id}`, exists: Boolean(state.households?.byId?.[id]), shares: Math.max(0, Math.floor(shares || 0))
  }));
  holders.push({ payee: SOCIAL, exists: Boolean(state.socialSecurity), shares: Math.max(0, Math.floor(company.fundShares || 0)) });
  for (const holder of holders) {
    if (holder.shares <= 0) continue;
    out.shares += holder.shares;
    let buy = 0;
    if (holder.exists && price > 0) {
      const affordable = maximumFullyPayableValueUnits(state, "town", holder.shares * price, content);
      buy = Math.min(holder.shares, Math.floor(affordable / price));
    }
    if (buy > 0) {
      const result = settleMonetaryPayment(state, "town", holder.payee, currentPaymentComposition(state, buy * price), content,
        "ownership_takeover_share_buyout", `整栋归属换算：镇库按股价回购${company.name}股份`, { requireFull: true });
      if (!result.ok) buy = 0;
    }
    out.paidUnits += buy * price;
    out.unpaidShares += holder.shares - buy;
    out.unpaidUnits += (holder.shares - buy) * price;
  }
  return out;
}

// 公司债务与资产归镇库：先用现金偿付欠薪，余额由镇库垫付，仍付不起的债权转给镇库；现金与存货归镇库。
function settleCompanyAssets(state, company, content) {
  const book = wageBook(company.payroll ||= { arrearsVoucherUnits: 0, cumulativePaidVoucherUnits: 0, cumulativeAccruedVoucherUnits: 0 });
  if (wageArrears(book) > 0) payWages(state, book, `company:${company.id}`, content, "ownership_takeover_wage", `${company.name}整栋归属换算先偿付欠薪`);
  if (wageArrears(book) > 0) payWages(state, book, "town", content, "ownership_takeover_town_advance", `${company.name}欠薪由镇库垫付`);
  const job = content.buildings[company.typeId]?.jobs?.[0];
  if (job && wageArrears(book) > 0) transferWageClaimsToTown(state, book, jobKeyForBuilding(company.buildingId, job.id), content);
  company.payroll.arrearsVoucherUnits = wageArrears(book);
  const payerId = `company:${company.id}`;
  const cash = maximumFullyPayableValueUnits(state, payerId, maximumPayableValueUnits(state, payerId, content), content);
  if (cash > 0) {
    settleMonetaryPayment(state, payerId, "town", currentPaymentComposition(state, cash), content,
      "ownership_takeover_liquidation", `${company.name}整栋归属换算，现金归镇库`, { requireFull: true });
  }
  for (const itemId of Object.keys(content.items)) {
    const qty = company.inventory?.[itemId] || 0;
    if (qty <= 0) continue;
    const taken = takeStock(company, itemId, qty, { strict: true });
    state.accounts.town[itemId] = (state.accounts.town[itemId] || 0) + taken.units;
    addTownCostBasis(state, itemId, taken.costUnits);
  }
}

function dissolveCompany(state, company) {
  for (const household of Object.values(state.households?.byId || {})) if (household.shares) delete household.shares[company.id];
  delete state.companies[company.id];
}

function liquidateCompany(state, company, content) {
  const name = company.name;
  const shares = buyOutCompanyShares(state, company, content);
  settleCompanyAssets(state, company, content);
  dissolveCompany(state, company);
  return { name, shares };
}

// 合并镇营股份：公司胜出时，镇营并入的等级按（总股本 ÷ 原公司等级）折成股份给镇里，总股本取到新等级的整数倍。
function mergeTownShares(company, townLevels, newLevel) {
  if (!company.listing?.listed || !(company.totalShares > 0) || !(company.listedLevels > 0) || townLevels <= 0) return 0;
  const raw = company.totalShares + Math.round(townLevels * company.totalShares / company.listedLevels);
  const total = Math.ceil(raw / newLevel) * newLevel;
  const added = total - company.totalShares;
  company.totalShares = total;
  company.townShares = (company.townShares || 0) + added;
  return added;
}

function convertBuilding(state, building, content) {
  const name = content.buildings[building.typeId]?.name || building.typeId;
  const parts = readParts(state, building);
  const winner = chooseWinner(parts);
  const company = companyOfBuilding(state, building.id);
  const companyName = company?.name || "";
  const { perLevelUnits, source } = levelValue(state, building, content);

  // 1. 民营业主补偿：赢家以外的户，按各户等级 × 每级估值由镇库付。
  const displaced = parts.households.filter(row => !(winner.kind === "household" && row.id === winner.id));
  const compensation = compensateHouseholds(state, displaced, perLevelUnits, content, name);

  // 2. 公司：公司不是赢家则清算（股份回购、资产归镇库）。
  let liquidation = null;
  let shareAdded = 0;
  if (company && winner.kind !== "company") {
    liquidation = liquidateCompany(state, company, content);
  }
  // 3. 整栋归属与岗位搬移。公司胜出时先按镇营等级折股。
  let winnerText;
  if (winner.kind === "company") {
    shareAdded = mergeTownShares(company, parts.town, parts.level);
    transferBuildingOwnership(state, building, { kind: "company", id: company.id }, content);
    winnerText = `公司${companyName}`;
  } else if (winner.kind === "household") {
    transferBuildingOwnership(state, building, { kind: "household", id: winner.id }, content);
    winnerText = `民营户${state.households.byId[winner.id].name || "居民户" + winner.id}`;
  } else {
    transferBuildingOwnership(state, building, { kind: "town", id: null }, content);
    winnerText = "镇里";
  }
  // 归属字段以当前主人为准重算一遍（与 syncOwnershipLevels 同口径），再检查整栋不变量。
  syncOwnershipLevels(state, building);
  if (!isWholeBuilding(state, building)) throw new Error("换算后归属仍不整栋");
  syncResidentAggregates(state, content);

  const details = [];
  if (compensation.count > 0) {
    details.push(`补偿民营 ${compensation.count} 户 ${voucherText(compensation.paidUnits, content)} 粮券` +
      (compensation.unpaidUnits > 0 ? `，镇库付不起 ${voucherText(compensation.unpaidUnits, content)} 粮券` : ""));
  }
  if (liquidation) {
    const s = liquidation.shares;
    if (s.shares > 0) {
      details.push(`公司${liquidation.name}清算：股东回购 ${voucherText(s.paidUnits, content)} 粮券` +
        (s.unpaidShares > 0 ? `，${s.unpaidShares}股镇库付不起、注销（应付 ${voucherText(s.unpaidUnits, content)} 粮券）` : ""));
    } else {
      details.push(`公司${liquidation.name}清算（无居民股份）`);
    }
  }
  if (shareAdded > 0) details.push(`镇里增发 ${shareAdded} 股`);
  const line = `${name}整栋归属：${winnerText}` + (details.length ? `（${details.join("；")}）` : "");
  const eventText = `${line}。每级估值 ${voucherText(perLevelUnits, content)} 粮券（${source}）。` +
    (compensation.unpaidUnits > 0 ? `民营补偿还差 ${voucherText(compensation.unpaidUnits, content)} 粮券未付。` : "");
  recordEvent(state, eventText, content, { day: state.day + 1 });
  return line;
}

// 换算失败的兜底：整栋划归镇里，不付补偿；公司若存在，股份注销、现金与存货归镇库（这些是公司自己的资产，不是补偿）。
function forceTown(state, building, content) {
  const company = companyOfBuilding(state, building.id);
  if (company) {
    try { settleCompanyAssets(state, company, content); } catch { /* 兜底：资产转移失败则只注销 */ }
    dissolveCompany(state, company);
  }
  building.ownership = { townLevels: Math.max(1, building.level || 1), privateLevels: 0, listedLevels: 0 };
  delete building.privateOwners;
  transferBuildingOwnership(state, building, { kind: "town", id: null }, content);
}

// 转换整栋所有制。state 原地修改；report 来自 emptyLoadReport，每栋写一行到 report.ownership。返回换算的栋数。
export function convertSplitOwnership(state, content, report) {
  if (report && !Array.isArray(report.ownership)) report.ownership = [];
  let converted = 0;
  const ids = (state.buildings || []).map(row => row.id);
  for (const id of ids) {
    const building = (state.buildings || []).find(row => row.id === id);
    if (!building || isWholeBuilding(state, building)) continue;
    const name = content.buildings[building.typeId]?.name || building.typeId;
    const before = snapshot(state);
    let line;
    try {
      line = convertBuilding(state, building, content);
      converted += 1;
    } catch (error) {
      restore(state, before);
      const fresh = (state.buildings || []).find(row => row.id === id);
      try {
        forceTown(state, fresh, content);
      } catch {
        // 兜底也失败：只改归属字段，保证整栋不变量。
        const company = fresh ? companyOfBuilding(state, fresh.id) : null;
        if (company) dissolveCompany(state, company);
        if (!fresh) continue;
        fresh.ownership = { townLevels: Math.max(1, fresh.level || 1), privateLevels: 0, listedLevels: 0 };
        delete fresh.privateOwners;
      }
      converted += 1;
      line = `${name}整栋归属：无法换算（${error.message || "未知原因"}），整栋划归镇里，未付补偿`;
      try {
        recordEvent(state, line + "。", content, { day: state.day + 1 });
      } catch { /* 事件记录失败不影响读档 */ }
    }
    if (report) report.ownership.push(line);
  }
  return converted;
}
