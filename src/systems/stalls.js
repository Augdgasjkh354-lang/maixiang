// 时代广场摆摊：摊位是 kind: "stall" 的店铺。
// 有闲人的家庭自动来摆摊（总人数不超过政策里的"允许摆摊人数"），亏钱就收摊；
// 卖得动、家里还有闲人时第二个人来帮忙（每摊最多 2 人）。进货、卖货、摊租、利润税都走店铺那套。
import { householdIdleWorkers } from "./households.js";
import { closeShop, ensureShops, openShop, setShopMerchants, shopDefinition, shopHostSlots, shopsForStreet } from "./shops.js";
import { jobCount } from "./households.js";

function stallDef(content) {
  return content.rules.shopTypes?.stall;
}

function isStall(shop, content) {
  return shopDefinition(content, shop.typeId)?.kind === "stall";
}

function keepers(state, shop) {
  return jobCount(state, `shop:${shop.id}:merchant`);
}

function activeStalls(state, content) {
  return Object.values(ensureShops(state, content)).filter(shop => isStall(shop, content) && (shop.status === "open" || shop.status === "paused"));
}

export function stallKeeperLimit(state, content) {
  return Math.max(0, Math.floor(state.policy?.stallKeeperLimit ?? content.rules.stallKeeperDefaultLimit ?? 50));
}

function recentProfit(shop, days) {
  const rows = (shop.history || []).slice(-days);
  return rows.length ? rows.reduce((sum, row) => sum + (row.profitVoucherUnits || 0), 0) / rows.length : 0;
}

function recentSoldUnits(shop, days) {
  const rows = (shop.history || []).slice(-days);
  return rows.length ? rows.reduce((sum, row) => sum + (row.soldUnits || 0), 0) / rows.length : 0;
}

function stallGoodsAvailable(state, content) {
  return Object.keys(content.rules.householdGoods || {}).some(itemId => (state.wholesaleMarket?.inventory?.[itemId] || 0) > 0);
}

export function manageStalls(state, content) {
  const def = stallDef(content);
  const squares = (state.buildings || []).filter(building => building.typeId === "times_square");
  const result = { opened: 0, closed: 0, helpers: 0 };
  if (!def || !squares.length) return result;
  const reviewDays = content.rules.stallReviewDays || 10;
  const limit = stallKeeperLimit(state, content);

  const serial = (state.year - 1) * content.rules.daysPerYear + state.day;
  const meta = (state.stallMarket ||= { cooldownUntilSerial: 0 });

  // 1. 收摊：暂停的、或摆满复核期仍平均亏损的。亏损收摊后一段时间内不再有人来摆。
  for (const shop of activeStalls(state, content)) {
    const losing = (shop.history || []).length >= reviewDays && recentProfit(shop, reviewDays) < 0;
    if (shop.status === "paused" || losing) {
      closeShop(state, shop.id, content, true);
      result.closed += 1;
      if (losing) meta.cooldownUntilSerial = serial + (content.rules.stallCooldownDays || 30);
    }
  }

  // 清算完的摊位直接删档，避免摊位来来去去把存档撑大。
  for (const shop of Object.values(state.shops || {})) {
    if (!isStall(shop, content) || shop.status !== "closed") continue;
    const owner = state.households?.byId?.[shop.ownerHouseholdId];
    if (owner?.shopIds) owner.shopIds = owner.shopIds.filter(id => id !== shop.id);
    delete state.shops[shop.id];
  }

  // 2. 政策调低了允许人数：先撤帮手，再撤摊。
  let stalls = activeStalls(state, content);
  let total = stalls.reduce((sum, shop) => sum + keepers(state, shop), 0);
  for (const shop of stalls.slice().sort((a, b) => recentProfit(a, 7) - recentProfit(b, 7))) {
    if (total <= limit) break;
    if (keepers(state, shop) > 1 && setShopMerchants(state, shop.id, 1, content).ok) { total -= 1; continue; }
    closeShop(state, shop.id, content, true);
    total -= 1;
    result.closed += 1;
  }

  // 3. 卖得动（近 7 天接近一人上限）且家里有闲人：加一个帮手。
  stalls = activeStalls(state, content).filter(shop => shop.status === "open");
  for (const shop of stalls) {
    if (total >= limit) break;
    if (keepers(state, shop) >= (def.maxMerchants || 2)) continue;
    if (recentSoldUnits(shop, 7) < (def.perKeeperSalesJin || 30) * content.precision.inventoryUnitsPerJin * 0.9) continue;
    if (recentProfit(shop, 7) <= 0) continue;
    const owner = state.households?.byId?.[shop.ownerHouseholdId];
    if (!owner || householdIdleWorkers(owner) <= 0) continue;
    if (setShopMerchants(state, shop.id, keepers(state, shop) + 1, content).ok) { total += 1; result.helpers += 1; }
  }

  // 4. 出新摊：还有名额和空位、批发市场有日用品可进，且现有摊位整体赚钱（或还没人摆）。
  if (serial < (meta.cooldownUntilSerial || 0) || !stallGoodsAvailable(state, content)) return result;
  const seasoned = stalls.filter(shop => (shop.history || []).length >= 3);
  // 现有摊位整体赚钱、而且货卖得动（平均达到上限的 60%）才有新人来摆。
  const capUnits = (def.dailySalesCapJin || 50) * content.precision.inventoryUnitsPerJin;
  const profitable = !seasoned.length || (seasoned.reduce((sum, shop) => sum + recentProfit(shop, 3), 0) / seasoned.length > 0
    && seasoned.reduce((sum, shop) => sum + recentSoldUnits(shop, 3), 0) / seasoned.length >= capUnits * 0.6);
  if (!profitable) return result;
  const maxOpens = content.rules.stallMaxOpensPerDay || 5;
  for (const square of squares) {
    while (result.opened < maxOpens && total < limit && shopsForStreet(state, square.id).length < shopHostSlots(square, content)) {
      const opened = openShop(state, square.id, "stall", content);
      if (!opened.ok) break;
      total += 1;
      result.opened += 1;
    }
  }
  return result;
}
