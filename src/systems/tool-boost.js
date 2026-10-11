// 铁制工具（金银消费第二期 B）：配置在建筑的 toolBoost（content/buildings.js）。
// 建筑每天投产前备工具：库存不够当日需要量（在岗人数 × perWorkerDay 件）的部分向批发市场补货；
// 库存够则获得人均产出加成 bonus（乘进 laborBatches 的 toolFactor），不够按覆盖率得到比例加成。
// - 镇营：从批发市场无偿内部调拨（成本随货转入建筑），不付钱。
// - 民营 / 公司：按批发售价向市场付款；民营的付款计入当日投入（同原料采购行），公司的成本在投产时并入原料成本。
// 库存在建筑上（building.toolStock 件、building.toolCostUnits 成本基础）。投产成功才消耗（applyToolUse），
// 成本按库存加权平均结转到产品；损耗记 tool_wear 账。只读预估（toolFactorEstimate）供预览与经营计划用。
import { buyWholesaleForOwner, procureTownInputFromWholesale, recordTownInputConsumption } from "./wholesale-market.js";
import { removeTownInventoryWithCost } from "../economy/business.js";
import { recordLedger, makeTransactionId } from "../economy/ledger.js";
import { jobKeyForBuilding, listedJobKeyForBuilding, privateJobKeyForBuilding, readJobCount } from "../selectors/labor.js";

const EPS = 1e-9;

export function toolBoostSpec(content, typeId) {
  const spec = content.buildings?.[typeId]?.toolBoost;
  return spec && content.items?.[spec.itemId] && spec.perWorkerDay > 0 && spec.bonus > 0 ? spec : null;
}

// 建筑的生产工人数（按所有制取对应岗位键：镇营、民营、公司）。
export function toolWorkerCount(state, building, content) {
  const def = content.buildings[building.typeId];
  const job = (def?.jobs || []).find(row => row.id === def.productionRoleId);
  if (!job) return 0;
  if ((building.ownership?.listedLevels || 0) > 0) return readJobCount(state, listedJobKeyForBuilding(building.id, job.id));
  if ((building.ownership?.privateLevels || 0) > 0) return readJobCount(state, privateJobKeyForBuilding(building.id, job.id));
  return readJobCount(state, jobKeyForBuilding(building.id, job.id));
}

// 当日需要量（件）：在岗人数 × 每人每日耗量。
export function toolNeedPieces(content, typeId, workers) {
  const spec = toolBoostSpec(content, typeId);
  return spec && workers > 0 ? workers * spec.perWorkerDay : 0;
}

export function toolFactorFromCoverage(spec, coverage) {
  return 1 + spec.bonus * Math.max(0, Math.min(1, coverage));
}

function roundPieces(value) {
  return Math.round(Math.max(0, value) * 1e6) / 1e6;
}

// 只读预估（预览、经营计划、产能显示用）：库存够则满额；不够按上一天实际覆盖率（building.toolCoverage），
// 没有记录时按库存加批发市场可售量估。与 stockBuildingTools 同口径，所以补货之后的预估即实际值。
export function toolFactorEstimate(state, building, content, workers) {
  const spec = toolBoostSpec(content, building.typeId);
  if (!spec) return 1;
  const need = toolNeedPieces(content, building.typeId, workers);
  if (!(need > 0)) return 1;
  const stock = Math.max(0, building.toolStock || 0);
  if (stock + EPS >= need) return toolFactorFromCoverage(spec, 1);
  let coverage = building.toolCoverage;
  if (!Number.isFinite(coverage)) {
    const market = Math.max(0, state.wholesaleMarket?.inventory?.[spec.itemId] || 0) / content.precision.inventoryUnitsPerJin;
    coverage = (stock + market) / need;
  }
  return toolFactorFromCoverage(spec, coverage);
}

// 备工具（投产前调用）。buyer："town" 为镇营无偿调拨；否则为付款主体 "household:<id>" / "company:<id>"。
// 返回 { need, factor, boughtUnits, paidVoucherUnits, costUnits, purchaseRow }：
//   paidVoucherUnits 为付给市场的现金（民营 / 公司）；costUnits 为入库成本（镇营为内部成本基础，公司、民营同为买价）。
export function stockBuildingTools(state, building, content, workers, buyer) {
  const spec = toolBoostSpec(content, building.typeId);
  if (!spec) return null;
  const need = toolNeedPieces(content, building.typeId, workers);
  if (!(need > 0)) return { need: 0, factor: 1, boughtUnits: 0, paidVoucherUnits: 0, costUnits: 0, purchaseRow: null, reason: null };
  const scale = content.precision.inventoryUnitsPerJin;
  const stock = Math.max(0, building.toolStock || 0);
  const shortage = need - stock;
  const requestedUnits = shortage > EPS ? Math.ceil(shortage * scale - EPS) : 0;
  const name = content.items[spec.itemId]?.name || spec.itemId;
  const buildingName = content.buildings[building.typeId]?.name || building.typeId;
  let boughtUnits = 0;
  let costUnits = 0;
  let reason = null;
  if (requestedUnits > 0) {
    if (buyer === "town") {
      const got = procureTownInputFromWholesale(state, spec.itemId, requestedUnits, content, `${buildingName}备${name}（批发市场无偿调拨）`);
      boughtUnits = got.boughtUnits || 0;
      reason = got.reason || null;
      if (boughtUnits > 0) {
        // 调拨进镇库后立即转入建筑：成本基础随货转移，不付钱。
        costUnits = removeTownInventoryWithCost(state, spec.itemId, boughtUnits, content).costWheatUnits || 0;
      }
      // 镇营领用计入需求（与市场售出一起决定产出闸门）：全部请求量都算，缺货也要让市场知道需要工具。
      recordTownInputConsumption(state, spec.itemId, requestedUnits, content);
    } else {
      const got = buyWholesaleForOwner(state, buyer, spec.itemId, requestedUnits, content, `${buildingName}备${name}`);
      boughtUnits = got.boughtUnits || 0;
      costUnits = got.paidVoucherUnits || 0;
      reason = got.reason || null;
      // 成交的部分已计入市场售出；缺的部分记为需求，同样让市场知道需要工具。
      if (requestedUnits > boughtUnits) recordTownInputConsumption(state, spec.itemId, requestedUnits - boughtUnits, content);
    }
  }
  const stockAfter = roundPieces(stock + boughtUnits / scale);
  building.toolStock = stockAfter;
  building.toolCostUnits = Math.max(0, Math.round((building.toolCostUnits || 0) + costUnits));
  const coverage = Math.min(1, stockAfter / need);
  building.toolCoverage = coverage;
  building.toolBoostToday = toolFactorFromCoverage(spec, coverage) - 1;
  const paid = buyer === "town" ? 0 : costUnits;
  const purchaseRow = buyer === "town" || requestedUnits <= 0 ? null : {
    itemId: spec.itemId, requestedUnits, purchasedUnits: boughtUnits, paidVoucherUnits: paid,
    reason: reason || (boughtUnits < requestedUnits ? "批发市场可售量不足" : null), sellerRows: []
  };
  return { need, factor: toolFactorFromCoverage(spec, coverage), boughtUnits, paidVoucherUnits: paid, costUnits, purchaseRow, reason };
}

// 投产当日的工具用量：min(库存, 需要量) 件，成本按库存加权平均。只算不改；投产成功后再 applyToolUse。
export function planToolUse(building, need) {
  const stock = Math.max(0, building.toolStock || 0);
  const pieces = Math.min(stock, Math.max(0, need || 0));
  if (!(pieces > EPS)) return { pieces: 0, costUnits: 0 };
  const cost = Math.max(0, building.toolCostUnits || 0);
  const costUnits = stock > 0 ? Math.min(cost, Math.round(cost * pieces / stock)) : 0;
  return { pieces, costUnits };
}

export function applyToolUse(state, building, use, content) {
  const spec = toolBoostSpec(content, building.typeId);
  if (!use || !spec || !(use.pieces > EPS)) return null;
  const stockAfter = roundPieces((building.toolStock || 0) - use.pieces);
  building.toolStock = stockAfter > EPS ? stockAfter : 0;
  building.toolCostUnits = building.toolStock > 0 ? Math.max(0, (building.toolCostUnits || 0) - use.costUnits) : 0;
  recordLedger(state, {
    type: "tool_wear", transactionId: makeTransactionId(state),
    source: `building:${building.id}`, destination: "tool_wear", itemId: spec.itemId,
    quantityUnits: Math.round(use.pieces * content.precision.inventoryUnitsPerJin), qeqUnits: 0,
    reason: `${content.buildings[building.typeId]?.name || building.typeId}使用${content.items[spec.itemId]?.name || spec.itemId}（损耗）`
  }, content);
  return use;
}
