import { createPaymentCapabilityContext, currentPaymentComposition, maximumFullyPayableValueUnits, settleMonetaryPayment } from "../economy/payment.js";
import { recordEvent } from "../economy/ledger.js";
import { selectOperatingRightPreview } from "../selectors/operating-rights.js";
import { householdConvertibleWheatUnits, setJobCount } from "./households.js";
import { readJobCount, jobKeyForBuilding, privateJobKeyForBuilding } from "../selectors/labor.js";

export function sellOperatingLevel(state, buildingId, content) {
  const preview = selectOperatingRightPreview(state, buildingId, content);
  if (!preview.available) return { ok: false, reason: preview.reason, preview };
  const building = state.buildings.find(row => row.id === buildingId);
  const definition = content.buildings[building.typeId];
  const job = definition.jobs[0];
  const priceUnits = Math.round(preview.priceWheatJin * content.precision.currencyUnitsPerVoucher);
  // 合资购买：preview 已按出资能力凑好买家团；成交时按精确可付额度逐户落实，
  // 某户精确额度不足就由后序户补上；全部精确额度加总仍不够则交易失败（不扣任何一户的钱）。
  const buyerGroup = preview.buyerGroup || [];
  if (!preview.groupCanPay || buyerGroup.length === 0) {
    return { ok: false, reason: "即使多户合资也买不起经营权", preview };
  }
  const householdById = state.households?.byId || {};
  const finalMembers = [];
  let remaining = priceUnits;
  for (const member of buyerGroup) {
    if (remaining <= 0) break;
    const household = householdById[member.householdId];
    if (!household) return { ok: false, reason: `${member.householdName}已不存在，合资失败`, preview };
    const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
    // 保守预检：不依赖镇库共享券池（多人结算时前一户可能耗掉券池，导致后一户预检通过但实扣失败、
    // 钱扣一半交易却失败）。实际结算时券池是 bonus，只会比预检更宽松。
    const conservativeCtx = createPaymentCapabilityContext(state, `household:${member.householdId}`, content, { maxWheatUnits });
    conservativeCtx.exchangeVoucherPoolUnits = 0;
    const preciseMax = maximumFullyPayableValueUnits(state, `household:${member.householdId}`, remaining, content, { paymentContext: conservativeCtx });
    const contribution = Math.min(preciseMax, remaining);
    if (contribution <= 0) continue;
    finalMembers.push({ household, householdId: member.householdId, householdName: member.householdName, contribution, maxWheatUnits });
    remaining -= contribution;
  }
  if (remaining > 0 || finalMembers.length === 0) {
    return { ok: false, reason: "合资各户精确出资额度不足，经营权未成交", preview };
  }
  const buyerNames = [];
  let firstTransactionId = null;
  for (const member of finalMembers) {
    const exchange = settleMonetaryPayment(state, `household:${member.householdId}`, "town",
      currentPaymentComposition(state, member.contribution), content,
      "operating_right_sale", `${member.householdName}合资购买${definition.name}一级经营权`,
      { requireFull: true, maxWheatUnits: member.maxWheatUnits });
    if (!exchange.ok) return { ok: false, reason: exchange.reason, preview };
    if (!firstTransactionId) firstTransactionId = exchange.transactionId;
    buyerNames.push(member.householdName);
    building.privateOwners ||= [];
    building.privateOwners.push(member.householdId);
    member.household.operatingRights ||= [];
    member.household.operatingRights.push({ buildingId, level: building.privateOwners.length });
  }
  const publicKey = jobKeyForBuilding(buildingId, job.id);
  const privateKey = privateJobKeyForBuilding(buildingId, job.id);
  const publicWorkers = readJobCount(state, publicKey);
  const publicCapacity = Math.max(0, (building.ownership?.townLevels || 1) - 1) * job.slots;
  const transferred = Math.max(0, publicWorkers - publicCapacity);
  setJobCount(state, publicKey, Math.min(publicWorkers, publicCapacity), content);
  const priorPrivate = readJobCount(state, privateKey);
  setJobCount(state, privateKey, Math.min(priorPrivate + transferred, ((building.ownership?.privateLevels || 0) + 1) * job.slots), content, { type: "private", id: buildingId });
  building.ownership ||= { townLevels: building.level || 1, privateLevels: 0, listedLevels: 0 };
  building.ownership.townLevels -= 1;
  building.ownership.privateLevels += 1;
  const period = state.privateEconomy.rightSales;
  period.dayWheatUnits += priceUnits;
  period.yearWheatUnits += priceUnits;
  period.cumulativeWheatUnits += priceUnits;
  if (state.market?.operatingPlan) state.market.operatingPlan.updatedSerial = -1;
  const buyerText = buyerNames.length <= 3 ? buyerNames.join("、") : `${buyerNames.slice(0, 3).join("、")}等${buyerNames.length}户`;
  recordEvent(state, `${buyerText}合资以${preview.priceWheatJin.toLocaleString("zh-CN")}斤小麦等值购入${definition.name}一级经营权。`, content, { day: state.day + 1 });
  return { ok: true, preview, ownerHouseholdIds: finalMembers.map(m => m.householdId), transferredWorkers: transferred, transactionId: firstTransactionId };
}
