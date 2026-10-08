// 上市（整栋）与民营业主上市申请（docs/OWNERSHIP.md 第 2 条）。
//
// 一步完成：建筑的现主人（镇里或某一户）把整栋建筑放进一家新公司，并在交易所挂牌。不再有单独的“成立公司”。
// 民营建筑由业主申请：经营好（近 ownerUpgradeProfitDays 天利润为正）但现金不够下一次升级的，日结每隔 ipoApplicationCheckDays 天
// 递交申请（state.ipoApplications[buildingId]）；镇长批准才上市，驳回后同一业主 ipoReapplyCooldownDays 天内不得再申请。

import { isIndustryType } from "../content/buildings.js";
import { recordEvent } from "../economy/ledger.js";
import { quantityToUnits } from "../economy/inventory.js";
import { currencyScale } from "../economy/currency.js";
import { currentUnitPrice } from "../economy/prices.js";
import { maximumPayableValueUnits } from "../economy/payment.js";
import { householdConvertibleWheatUnits } from "./households.js";
import { privateJobKeyForBuilding, readJobCount } from "../selectors/labor.js";
import { buildingOwner, companyOfBuilding, daySerialOf, valueUnitsOfGoods } from "./ownership.js";
import { createIndependentCompany } from "./companies.js";
import {
  DEFAULT_TOTAL_SHARES, applyCompanyListing, buildingValuationVoucher, ensureStockExchangeState, hasStockExchange,
  listingGate, nearbyDivisibleShareCounts, resolveListingTerms, suggestedSharePriceVoucher
} from "./stock-exchange.js";

function projectsOn(state, building) {
  return (state.projects || []).some(project => project.buildingId === building.id || project.plotId === building.plotId);
}

// 默认总股本（与 resolveListingTerms 缺省口径一致）。
export function defaultTotalShares(levels) {
  return nearbyDivisibleShareCounts(levels, DEFAULT_TOTAL_SHARES)[0];
}

// 上市的前置条件（整栋上市与批准申请共用）。返回原因字符串；null 表示可以上市。
export function listingBlockReason(state, building, content) {
  if (!building) return "建筑不存在";
  if (!isIndustryType(content, building.typeId)) return "此建筑不支持上市";
  const gate = listingGate(state);
  if (gate) return gate;
  if (companyOfBuilding(state, building.id)) return "这栋建筑已有公司（未上市的公司请直接挂牌）";
  if (projectsOn(state, building)) return "施工或升级期间不能上市";
  return null;
}

// 民营业主下一次升级的花费与留底（与 building-development.js 的业主自主升级口径一致；那里的函数未导出，公式在此重算）。
// 花费 = 材料按当前价折算 + 工日 × 建筑工工资；现金还须留 ownerUpgradeReserveWageDays 天在岗工资。
export function nextOwnerUpgradeQuote(state, building, ownerId, content) {
  const definition = content.buildings[building.typeId];
  const config = definition?.upgrade;
  const job = definition?.jobs?.[0];
  const level = Math.max(1, building.level || 1);
  if (!config || !job || !ownerId) return null;
  if (level >= (config.maxLevel || content.rules.buildingMaxLevel || 10)) return null;
  const moneyScale = content.precision.currencyUnitsPerVoucher;
  const materialCostUnits = (config.materialRequirements || []).reduce((sum, row) =>
    sum + valueUnitsOfGoods(quantityToUnits(row.quantity, content), currentUnitPrice(state, row.itemId, content), content), 0);
  const builderWage = state.employment.wageRates?.builders ?? 10;
  const labourCostUnits = Math.round(config.workDays * builderWage * moneyScale);
  const workers = readJobCount(state, privateJobKeyForBuilding(building.id, job.id));
  const wageRate = state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 5;
  const dailyWageUnits = Math.round(workers * wageRate * moneyScale);
  return {
    nextLevel: level + 1,
    costUnits: materialCostUnits + labourCostUnits,
    reserveUnits: dailyWageUnits * (content.rules.ownerUpgradeReserveWageDays ?? 60)
  };
}

// 业主现金能否付得起下一次升级（含留底）。无可升级时返回 null。
export function ownerUpgradeAffordability(state, building, ownerId, content) {
  const quote = nextOwnerUpgradeQuote(state, building, ownerId, content);
  if (!quote) return null;
  const household = state.households?.byId?.[ownerId];
  const payOptions = household ? { maxWheatUnits: householdConvertibleWheatUnits(state, household, content, content.rules.householdFoodReserveDays ?? 30) } : {};
  const payableUnits = maximumPayableValueUnits(state, `household:${ownerId}`, content, payOptions);
  return { ...quote, payableUnits, affordable: payableUnits >= quote.costUnits + quote.reserveUnits };
}

// 近 ownerUpgradeProfitDays 天的民营利润合计（privateProfitHistory 由民营生产逐日记录）。
export function privateRecentProfitUnits(state, building, content) {
  const days = content.rules.ownerUpgradeProfitDays ?? 60;
  const serial = daySerialOf(state, content);
  return (building.privateProfitHistory || [])
    .filter(row => Number.isInteger(row.serial) && row.serial > serial - days && row.serial <= serial)
    .reduce((sum, row) => sum + (row.profitVoucherUnits || 0), 0);
}

function cooldownActive(state, buildingId, householdId, serial) {
  const cooldown = state.ipoCooldowns?.[buildingId];
  return Boolean(cooldown && cooldown.householdId === householdId && serial < cooldown.untilSerial);
}

// 上市（整栋）。建筑的现主人（镇里或某一户）把整栋建筑放进一家新公司，并在交易所挂牌，一步完成。
// options:
//   ticker            股票代码（三位数字）；缺省取第一个空闲代码
//   totalShares       总股本；缺省 10 万股（取最接近且能被建筑级数整除的值）
//   offerPercent      卖出比例（%）；缺省 rules.ipoDefaultOfferPercent（49）。卖方保留其余股份
//   priceVoucherPerShare 每股价（粮券）；缺省 整栋估值 ÷ 总股本（不低于 0.001）
//   name              公司名；缺省 建筑名 + "公司"
//   operatingCapitalVoucher / initialMaterials / initialMaterialQuantity  仅镇里为主人时可用：镇库投入营运资金与实物
// 卖方 = 挂牌时的主人：镇里 → townShares；一户 → householdShares[户]。发行池 offeredShares 由卖方出售，股款付给卖方。
export function listBuilding(state, buildingId, options, content) {
  ensureStockExchangeState(state);
  const building = state.buildings.find(row => row.id === buildingId);
  const block = listingBlockReason(state, building, content);
  if (block) return { ok: false, reason: block };
  const owner = buildingOwner(state, building);
  // 民营建筑是业主的产业：只能由业主递申请、镇长批准后上市（approveIpoApplication），镇长不能直接拿去上市。
  if (owner.kind === "household" && !options?.fromApplication) return { ok: false, reason: "民营建筑须由业主递交上市申请，镇长批准后才能上市" };
  const levels = Math.max(1, building.level || 1);
  const terms = resolveListingTerms(state, {
    buildingId, levels, ticker: options?.ticker, totalShares: options?.totalShares,
    offerPercent: options?.offerPercent, priceVoucherPerShare: options?.priceVoucherPerShare
  }, content);
  if (!terms.ok) return terms;
  const created = createIndependentCompany(state, buildingId, {
    name: options?.name, operatingCapitalVoucher: options?.operatingCapitalVoucher,
    initialMaterials: options?.initialMaterials, initialMaterialQuantity: options?.initialMaterialQuantity
  }, content);
  if (!created.ok) return created;
  const company = state.companies[created.companyId];
  const seller = owner.kind === "household" ? { kind: "household", householdId: owner.id } : { kind: "town" };
  applyCompanyListing(state, company, terms, seller, content);
  delete building.privateProfitHistory;
  if (state.market?.operatingRightPrices) delete state.market.operatingRightPrices[buildingId];
  if (state.ipoApplications) delete state.ipoApplications[buildingId];
  const definition = content.buildings[building.typeId];
  const sellerName = seller.kind === "household" ? (state.households.byId[owner.id]?.name || "业主") : "镇库";
  const price = (terms.priceUnits / currencyScale(content)).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  recordEvent(state, `${company.name}（${terms.ticker}）由${sellerName}整栋划入${definition.name}（${levels}级），在交易所挂牌，总股本${terms.totalShares.toLocaleString("zh-CN")}股；挂出${terms.offeredShares.toLocaleString("zh-CN")}股，每股${price}粮券，${sellerName}保留其余股份。`, content, { day: state.day + 1 });
  return {
    ok: true, companyId: company.id, ticker: terms.ticker, levels,
    totalShares: terms.totalShares, offeredShares: terms.offeredShares, keptShares: terms.totalShares - terms.offeredShares,
    priceVoucherUnits: terms.priceUnits, sellerOwner: seller.kind === "household" ? seller.householdId : "town"
  };
}

// 镇长批准民营业主的上市申请：以业主家庭为卖方上市。选项可覆盖申请里的卖出比例与每股价。
export function approveIpoApplication(state, buildingId, options, content) {
  const application = state.ipoApplications?.[buildingId];
  if (!application) return { ok: false, reason: "这栋建筑没有待批的上市申请" };
  const building = state.buildings.find(row => row.id === buildingId);
  const owner = building ? buildingOwner(state, building) : null;
  if (!owner || owner.kind !== "household" || owner.id !== application.householdId) {
    delete state.ipoApplications[buildingId];
    return { ok: false, reason: "业主已变更，原申请作废" };
  }
  const result = listBuilding(state, buildingId, {
    ticker: options?.ticker,
    totalShares: options?.totalShares,
    offerPercent: options?.offerPercent ?? application.offerPercent,
    priceVoucherPerShare: options?.priceVoucherPerShare ?? application.priceVoucherPerShare,
    name: options?.name,
    fromApplication: true
  }, content);
  if (!result.ok) return result;
  return { ...result, fromApplication: true };
}

// 镇长驳回民营业主的上市申请：同一业主在 ipoReapplyCooldownDays 天内不得再申请这栋建筑。
export function rejectIpoApplication(state, buildingId, content) {
  const application = state.ipoApplications?.[buildingId];
  if (!application) return { ok: false, reason: "这栋建筑没有待批的上市申请" };
  delete state.ipoApplications[buildingId];
  const untilSerial = daySerialOf(state, content) + (content.rules.ipoReapplyCooldownDays ?? 180);
  state.ipoCooldowns ||= {};
  state.ipoCooldowns[buildingId] = { householdId: application.householdId, untilSerial };
  const building = state.buildings.find(row => row.id === buildingId);
  const name = building ? content.buildings[building.typeId]?.name || building.typeId : buildingId;
  const household = state.households?.byId?.[application.householdId];
  recordEvent(state, `镇长驳回${household?.name || "业主"}对${name}的上市申请；${content.rules.ipoReapplyCooldownDays ?? 180}天内不得再申请。`, content, { day: state.day + 1 });
  return { ok: true, buildingId, householdId: application.householdId, cooldownUntilSerial: untilSerial };
}

// 日结：清理失效申请；每 ipoApplicationCheckDays 天检查一次，符合条件的民营建筑递交上市申请。
// 条件：交易所已建成；业主是一户；近期利润为正；现金不够下一次升级（含留底）；无待批申请；不在冷却期；建筑没有在施工程。
export function settleIpoApplications(state, content) {
  const applications = state.ipoApplications ||= {};
  state.ipoCooldowns ||= {};
  const serial = daySerialOf(state, content);
  const rows = [];
  for (const buildingId of Object.keys(applications)) {
    const building = state.buildings.find(row => row.id === buildingId);
    const owner = building ? buildingOwner(state, building) : null;
    if (!owner || owner.kind !== "household" || owner.id !== applications[buildingId].householdId) {
      delete applications[buildingId];
      rows.push({ buildingId, status: "dropped" });
    }
  }
  for (const [buildingId, cooldown] of Object.entries(state.ipoCooldowns)) {
    if (serial >= cooldown.untilSerial) delete state.ipoCooldowns[buildingId];
  }
  if (!hasStockExchange(state)) return rows;
  const checkDays = Math.max(1, content.rules.ipoApplicationCheckDays || 30);
  if (serial % checkDays !== 0) return rows;
  for (const building of state.buildings.slice()) {
    if (applications[building.id]) continue;
    const owner = buildingOwner(state, building);
    if (owner.kind !== "household" || !owner.id) continue;
    if (projectsOn(state, building)) continue;
    if (cooldownActive(state, building.id, owner.id, serial)) continue;
    if (privateRecentProfitUnits(state, building, content) <= 0) continue;
    const affordability = ownerUpgradeAffordability(state, building, owner.id, content);
    if (!affordability || affordability.affordable) continue;
    const valuation = buildingValuationVoucher(state, building.id, content);
    applications[building.id] = {
      householdId: owner.id,
      filedSerial: serial,
      offerPercent: content.rules.ipoDefaultOfferPercent ?? 49,
      priceVoucherPerShare: suggestedSharePriceVoucher(valuation, defaultTotalShares(Math.max(1, building.level || 1)))
    };
    const household = state.households.byId[owner.id];
    const definition = content.buildings[building.typeId];
    recordEvent(state, `${household?.name || "业主"}经营的${definition.name}近期盈利，但现金不足以支付下一次升级，递交上市申请，待镇长批准。`, content, { day: state.day + 1 });
    rows.push({ buildingId: building.id, status: "filed", householdId: owner.id });
  }
  return rows;
}
