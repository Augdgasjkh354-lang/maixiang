// 时代广场集市：每座广场一个集体摊位（kind: "stall"、collective 的店铺），不属于某一户。
// 待业的人自动来摆，人数每 3 天按销量调整：卖得动、赚钱就加人，卖不动或亏钱就减人；
// 总人数不超过政策里的"允许摆摊人数"，也不超过广场摊位数 × 2。
// 进货、卖货、按摊交租、利润税走店铺那套；每天的利润按人头 ×（0.8—1.2 随机）分给摆摊家庭（见 shops.js）。
import { jobCount, setJobCount } from "./households.js";
import { closeShop, ensureShops, farmsHaveStock, openCollectiveShop, refundCollectiveIfStranded, shopDefinition, shopHostSlots, stallItemIds } from "./shops.js";

const ADJUST_DAYS = 3;
const START_KEEPERS = 2;

export function stallKeeperLimit(state, content) {
  return Math.max(0, Math.floor(state.policy?.stallKeeperLimit ?? content.rules.stallKeeperDefaultLimit ?? 50));
}

function isStall(shop, content) {
  return shopDefinition(content, shop.typeId)?.kind === "stall";
}

function keeperKey(shop) {
  return `shop:${shop.id}:merchant`;
}

function average(rows, pick) {
  return rows.length ? rows.reduce((sum, row) => sum + (pick(row) || 0), 0) / rows.length : 0;
}

function goodsAvailable(state, content) {
  return stallItemIds(content).some(itemId => (state.wholesaleMarket?.inventory?.[itemId] || 0) > 0 || (content.items[itemId]?.livestock && farmsHaveStock(state, itemId, content)));
}

// 每座广场保证有且只有一个集体摊位；旧版本按户开的摊位收摊清算，清算完删档。
function collectiveFor(state, square, content) {
  const shops = Object.values(ensureShops(state, content)).filter(shop => shop.buildingId === square.id && isStall(shop, content));
  for (const shop of shops) {
    if (shop.collective) continue;
    if (shop.status === "open" || shop.status === "paused") closeShop(state, shop.id, content, true);
    if (shop.status === "closed") {
      const owner = state.households?.byId?.[shop.ownerHouseholdId];
      if (owner?.shopIds) owner.shopIds = owner.shopIds.filter(id => id !== shop.id);
      delete state.shops[shop.id];
    }
  }
  return shops.find(shop => shop.collective && shop.status !== "closed") || openCollectiveShop(state, square, "stall", content);
}

function targetKeepers(state, shop, content, current) {
  const def = shopDefinition(content, shop.typeId);
  const perKeeper = (def.perKeeperSalesJin || 25) * content.precision.inventoryUnitsPerJin;
  const history = (shop.history || []).slice(-7);
  if (current <= 0) return goodsAvailable(state, content) ? START_KEEPERS : 0;
  if (history.length < ADJUST_DAYS) return current;
  const sold = average(history, row => row.soldUnits);
  const profit = average(history, row => row.profitVoucherUnits);
  const utilization = sold / (current * perKeeper);
  if (profit < 0 || utilization < 0.5) return current - Math.max(1, Math.floor(current * 0.2));
  if (utilization >= 0.85 && profit > 0) return current + Math.max(2, Math.ceil(current * 0.2));
  return current;
}

export function manageStalls(state, content) {
  const result = [];
  const serial = (state.year - 1) * content.rules.daysPerYear + state.day;
  for (const square of (state.buildings || []).filter(building => building.typeId === "times_square")) {
    const shop = collectiveFor(state, square, content);
    shop.plan ||= {};
    refundCollectiveIfStranded(state, shop, content);
    const current = jobCount(state, keeperKey(shop));
    const cap = Math.min(stallKeeperLimit(state, content), shopHostSlots(square, content) * 2);
    let target = current;
    if (current > cap) target = cap;
    else if (current === 0 || serial - (shop.plan.keeperAdjustedSerial ?? -Infinity) >= ADJUST_DAYS) {
      target = Math.max(0, Math.min(cap, targetKeepers(state, shop, content, current)));
      shop.plan.keeperAdjustedSerial = serial;
    }
    if (target !== current) setJobCount(state, keeperKey(shop), target, content, { type: "shop", id: shop.id });
    const keepers = jobCount(state, keeperKey(shop));
    shop.statusReason = keepers > 0 ? "营业中" : (cap <= 0 ? "未开放摆摊" : "没人来摆");
    result.push({ shopId: shop.id, keepers });
  }
  return result;
}
