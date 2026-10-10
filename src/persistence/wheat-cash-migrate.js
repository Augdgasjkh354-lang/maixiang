// 读档换算：早先店铺、公司、社保基金账上可以持有“付款用小麦”（cashWheatUnits），现在只有粮券一种货币。
// 读档时把这些现金小麦按 1 斤 = 1 券卖给镇库：镇库收小麦（带成本）、付粮券；镇库券池不够时只补发缺口
// （小麦已入镇库，发行有对应小麦），保证粮券总账守恒。债权/出资记录里的小麦分项并入粮券分项。
import { addTownCostBasis } from "../economy/business.js";
import { voucherUnitsForWheatUnits } from "../economy/money-units.js";

function sellWheatToTown(state, content, wheatUnits) {
  const units = Math.max(0, Math.floor(Number(wheatUnits) || 0));
  if (!units) return 0;
  const voucherUnits = voucherUnitsForWheatUnits(units, content, "floor");
  state.accounts ||= {};
  state.accounts.town ||= {};
  state.accounts.town.wheat = (state.accounts.town.wheat || 0) + units;
  addTownCostBasis(state, "wheat", voucherUnits);
  state.currency ||= {};
  state.currency.balances ||= {};
  const town = state.currency.balances.town || 0;
  if (town < voucherUnits) {
    const shortfall = voucherUnits - town;
    state.currency.issuedUnits = (state.currency.issuedUnits || 0) + shortfall;
    state.currency.issuedCumulativeUnits = (state.currency.issuedCumulativeUnits || 0) + shortfall;
    state.currency.balances.town = town + shortfall;
  }
  state.currency.balances.town -= voucherUnits;
  return voucherUnits;
}

function foldWheatPart(obj, wheatKey, voucherKey) {
  if (!obj || typeof obj !== "object" || !(obj[wheatKey] > 0)) {
    if (obj && typeof obj === "object") delete obj[wheatKey];
    return;
  }
  obj[voucherKey] = (obj[voucherKey] || 0) + obj[wheatKey];
  delete obj[wheatKey];
}

export function convertResidualWheatCash(state, content, report) {
  let soldUnits = 0;
  let holders = 0;
  const convert = (holder, voucherKey) => {
    const wheat = holder?.cashWheatUnits || 0;
    if (wheat > 0) {
      holder[voucherKey] = (holder[voucherKey] || 0) + sellWheatToTown(state, content, wheat);
      soldUnits += wheat;
      holders += 1;
    }
    if (holder) delete holder.cashWheatUnits;
  };
  for (const shop of Object.values(state.shops || {})) {
    convert(shop, "cashVoucherUnits");
    foldWheatPart(shop.initialCapital, "wheatValueUnits", "voucherValueUnits");
    for (const claim of Object.values(shop.liabilities || {})) {
      if (claim && typeof claim === "object" && !Array.isArray(claim)) foldWheatPart(claim, "wheatValueUnits", "voucherValueUnits");
    }
  }
  for (const company of Object.values(state.companies || {})) {
    convert(company, "cashVoucherUnits");
    foldWheatPart(company.initialInvestment, "cashWheatValueUnits", "cashVoucherPaidUnits");
  }
  convert(state.socialSecurity, "cashVoucherUnits");
  if (holders > 0 && report) report.wheatCash = [`旧存档里${holders}个账户的现金小麦已按1斤=1券卖给镇库换成粮券`];
  return { holders, soldUnits };
}
