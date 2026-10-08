import { currentPaymentComposition, settleMonetaryPayment } from "../economy/payment.js";
import { recordEvent } from "../economy/ledger.js";
import { selectOperatingRightPreview } from "../selectors/operating-rights.js";
import { householdConvertibleWheatUnits } from "./households.js";
import { buildingOwner, transferBuildingOwnership } from "./ownership.js";

// 整栋卖给民营（镇长操作，docs/OWNERSHIP.md 第 1 条）。
// 要价 = options.priceVoucher（镇长改过的价）；未给时用预览价（已存的要价，或整栋估值）。
// 买家 = 付得起整栋价格的家庭中家底（粮券 + 可换小麦）最多的一户，不合资。钱付给镇库。
export function sellBuildingToPrivate(state, buildingId, options = {}, content) {
  const requested = options?.priceVoucher;
  if (requested !== undefined && !(Number.isFinite(Number(requested)) && Number(requested) > 0)) {
    return { ok: false, reason: "要价须为正的有限数值" };
  }
  const preview = selectOperatingRightPreview(state, buildingId, content, requested === undefined ? undefined : Number(requested));
  if (!preview.available) return { ok: false, reason: preview.reason, preview };
  const building = state.buildings.find(row => row.id === buildingId);
  const definition = content.buildings[building.typeId];
  const moneyScale = content.precision.currencyUnitsPerVoucher;
  const priceUnits = Math.round(preview.priceWheatJin * moneyScale);
  const buyer = preview.buyer;
  if (!buyer) return { ok: false, reason: "即使家底最多的一户也付不起整栋价格", preview };
  const household = state.households?.byId?.[buyer.householdId];
  if (!household) return { ok: false, reason: `${buyer.householdName}已不存在，成交失败`, preview };
  const maxWheatUnits = householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30);
  const payment = settleMonetaryPayment(state, `household:${household.id}`, "town",
    currentPaymentComposition(state, priceUnits), content,
    "operating_right_sale", `${household.name}整栋购入${definition.name}（民营经营）`,
    { requireFull: true, maxWheatUnits });
  if (!payment.ok) return { ok: false, reason: payment.reason || "买家付款失败", preview };
  const moved = transferBuildingOwnership(state, building, { kind: "household", id: household.id }, content);
  const period = state.privateEconomy.rightSales;
  period.dayWheatUnits += priceUnits;
  period.yearWheatUnits += priceUnits;
  period.cumulativeWheatUnits += priceUnits;
  if (state.market?.operatingRightPrices) delete state.market.operatingRightPrices[buildingId];
  recordEvent(state, `${household.name}以${preview.priceWheatJin.toLocaleString("zh-CN")}斤小麦等值整栋购入${definition.name}（${building.level}级），由民营经营。`, content, { day: state.day + 1 });
  return {
    ok: true, preview, buildingId, ownerHouseholdId: household.id, priceVoucherUnits: priceUnits,
    transactionId: payment.transactionId, movedWorkers: moved.movedWorkers
  };
}

// 旧命令名保留：整栋出售的别名（旧版按级出售已废止）。
export function sellOperatingLevel(state, buildingId, content) {
  return sellBuildingToPrivate(state, buildingId, {}, content);
}

// 镇里收购（镇长操作，可选）：按整栋估值向民营业主买回，钱由镇库付给业主。
export function buyBuildingBackFromPrivate(state, buildingId, content) {
  const building = state.buildings.find(row => row.id === buildingId);
  if (!building) return { ok: false, reason: "建筑不存在" };
  const owner = buildingOwner(state, building);
  if (owner.kind !== "household" || !owner.id) return { ok: false, reason: "这栋建筑不是民营经营，无需回购" };
  if ((state.projects || []).some(project => project.buildingId === buildingId || project.plotId === building.plotId)) {
    return { ok: false, reason: "施工或升级期间不能回购" };
  }
  const preview = selectOperatingRightPreview(state, buildingId, content);
  const moneyScale = content.precision.currencyUnitsPerVoucher;
  const priceUnits = Math.round(preview.valuationWheatJin * moneyScale);
  if (!(priceUnits > 0)) return { ok: false, reason: "整栋没有正估值，无法回购", preview };
  const definition = content.buildings[building.typeId];
  const household = state.households?.byId?.[owner.id];
  const payment = settleMonetaryPayment(state, "town", `household:${owner.id}`,
    currentPaymentComposition(state, priceUnits), content,
    "operating_right_buyback", `镇库按估值回购${definition.name}经营权`, { requireFull: true });
  if (!payment.ok) return { ok: false, reason: payment.reason || "镇库资金不足，无法回购", preview };
  const moved = transferBuildingOwnership(state, building, { kind: "town", id: null }, content);
  if (state.market?.operatingRightPrices) delete state.market.operatingRightPrices[buildingId];
  recordEvent(state, `镇库以${preview.valuationWheatJin.toLocaleString("zh-CN")}斤小麦等值向${household?.name || "业主"}回购${definition.name}，整栋收回镇营。`, content, { day: state.day + 1 });
  return { ok: true, buildingId, priceVoucherUnits: priceUnits, transactionId: payment.transactionId, movedWorkers: moved.movedWorkers };
}
