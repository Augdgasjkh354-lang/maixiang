// 上市视图（只读）：待批的民营上市申请，以及每栋产业建筑现在能否上市（及原因）。
// 不写 state；供界面与 selectDashboard 使用。

import { isIndustryType } from "../content/buildings.js";
import { buildingOwner, companyOfBuilding, daySerialOf } from "../systems/ownership.js";
import { buildingValuationVoucher, hasStockExchange, listingGate, suggestedSharePriceVoucher } from "../systems/stock-exchange.js";
import { defaultTotalShares, listingBlockReason } from "../systems/ipo.js";

function suggestedTotalShares(levels) {
  return defaultTotalShares(levels);
}

export function selectIpoView(state, content) {
  const serial = daySerialOf(state, content);
  const gate = listingGate(state);
  const exchangeBuilt = hasStockExchange(state);
  const householdName = (id) => state.households?.byId?.[id]?.name || "业主";
  const applications = Object.entries(state.ipoApplications || {}).map(([buildingId, application]) => {
    const building = state.buildings.find(row => row.id === buildingId) || null;
    const owner = building ? buildingOwner(state, building) : null;
    const levels = Math.max(1, building?.level || 1);
    const valid = Boolean(building) && owner?.kind === "household" && owner.id === application.householdId;
    const valuationVoucher = valid ? buildingValuationVoucher(state, buildingId, content) : 0;
    return {
      buildingId,
      buildingName: building ? content.buildings[building.typeId]?.name || building.typeId : buildingId,
      level: levels,
      householdId: application.householdId,
      householdName: householdName(application.householdId),
      filedSerial: application.filedSerial,
      daysPending: Math.max(0, serial - (application.filedSerial || 0)),
      valid,
      valuationVoucher,
      suggestedTotalShares: suggestedTotalShares(levels),
      suggestedOfferPercent: application.offerPercent,
      suggestedPriceVoucherPerShare: application.priceVoucherPerShare,
      blockedReason: valid ? listingBlockReason(state, building, content) : "业主已变更，申请待作废"
    };
  });
  const buildings = (state.buildings || []).filter(building => isIndustryType(content, building.typeId)).map(building => {
    const owner = buildingOwner(state, building);
    const company = companyOfBuilding(state, building.id);
    const levels = Math.max(1, building.level || 1);
    const pending = Boolean(state.ipoApplications?.[building.id]);
    const definition = content.buildings[building.typeId];
    let route;
    let canList = false;
    let reason = null;
    if (company) {
      // 已有公司：未上市的老公司直接挂牌；已上市的不再上市。
      route = company.listing?.listed ? null : "exchange";
      if (company.listing?.listed) reason = "已上市";
      else reason = gate;
      canList = route === "exchange" && !gate;
    } else {
      route = owner.kind === "household" ? "application" : "mayor";
      reason = listingBlockReason(state, building, content);
      if (!reason && owner.kind === "household" && !pending) reason = "民营业主尚未递交上市申请";
      canList = !reason;
    }
    // 估值只为能上市或待批的建筑计算，避免界面每次刷新都跑全量估值。
    const needsValuation = canList || pending || route === "exchange";
    const valuationVoucher = needsValuation ? buildingValuationVoucher(state, building.id, content) : null;
    const totalShares = suggestedTotalShares(levels);
    return {
      buildingId: building.id,
      name: definition?.name || building.typeId,
      level: levels,
      owner: owner.kind,
      ownerName: owner.kind === "household" ? householdName(owner.id) : owner.kind === "company" ? (company?.name || "公司") : "镇库",
      ownerHouseholdId: owner.kind === "household" ? owner.id : null,
      companyId: company?.id || null,
      listed: Boolean(company?.listing?.listed),
      pending,
      route,
      canList,
      reason,
      valuationVoucher,
      suggestedTotalShares: totalShares,
      suggestedOfferPercent: owner.kind === "household" ? (content.rules.ipoDefaultOfferPercent ?? 49) : (content.rules.ipoTownDefaultOfferPercent ?? 0),
      suggestedPriceVoucherPerShare: valuationVoucher === null ? null : suggestedSharePriceVoucher(valuationVoucher, totalShares)
    };
  });
  return {
    exchangeBuilt,
    gateReason: gate,
    serial,
    defaultOfferPercent: content.rules.ipoDefaultOfferPercent ?? 49,
    applicationCheckDays: content.rules.ipoApplicationCheckDays ?? 30,
    reapplyCooldownDays: content.rules.ipoReapplyCooldownDays ?? 180,
    applications,
    cooldowns: Object.entries(state.ipoCooldowns || {}).map(([buildingId, cooldown]) => ({
      buildingId, householdId: cooldown.householdId, householdName: householdName(cooldown.householdId), untilSerial: cooldown.untilSerial, active: serial < cooldown.untilSerial
    })),
    buildings
  };
}
