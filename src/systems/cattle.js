// 养牛场与耕牛（金银消费第三期）。
//
// - 养牛场（shopTypes.cattle_farm，kind "farm"）：店主 / 饲养员按 outputPerWorkerDay 每日新开小牛（头，攒整头）；
//   每头小牛每日吃 herd.feedPerCalfDayJin 斤小麦（从店里库存扣，不够按比例少喂，小牛少长）；养满 herd.growthDays 天成耕牛，入养牛场库存（ox）。
//   新开小牛的排产闸门：存栏（库存 + 小牛）不超过一个养殖周期（herd.growthDays 天）的需求，需求 = 近 7 天卖出与缺口的较大日均。
// - 耕牛卖给农民户（durable-goods 的 seller "farm"）：按养牛场定价（farmSalePriceVoucher），户内付钱，库存记在户上。
// - 维护费与饲料（每日，daily 步 oxMaintenance）：每户每头在役耕牛每日付 5 券（oxMaintenancePerOxYearVoucher ÷ 360）给养牛场（轮转）；
//   养牛场收到后为这些耕牛向镇库买 5 斤/头/日的小麦（小麦留口粮储备线，买到当日消耗），欠养按缺口累计，效力随之下降（selectors/farmland.js 的 oxEfficiency）。
//   维护费与饲料货款都是养牛场的收支：维护费为收入，小麦为饲料成本（利润 = 维护费 − 小麦 − 工资 − 店租 ...）。

import { currencyScale } from "../economy/currency.js";
import { householdOwner, shopOwner } from "../economy/accounts.js";
import { ensureBook, bookAdd } from "../economy/books.js";
import { currentPaymentComposition, settleMonetaryPayment } from "../economy/payment.js";
import { putStock, takeStock } from "../economy/trade.js";
import { farmSalePriceVoucher } from "./farm-pricing.js";
import { addBookMap, addBookValue, applyProfit, farmDailyOutputUnits, shopDefinition } from "./shops.js";
import { buyWholesaleForOwner } from "./wholesale-market.js";
import { creditHouseholdInventory, householdList, isActiveHousehold, reserveWheatFullPaymentOptions } from "./households.js";
import { herdFeedNeedUnits, herdHeads } from "./cattle-herd.js";

const round = value => Math.round(value);

function isCattleFarm(def) {
  return def?.kind === "farm" && !!def.herd;
}

export function openCattleFarms(state, content) {
  return Object.values(state.shops || {})
    .filter(shop => shop.status === "open" && isCattleFarm(shopDefinition(content, shop.typeId)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// 养牛场的产出（每日，livestock 步调用）：喂小牛、出栏成牛、新开小牛。返回一行结果。
export function produceCattle(state, farm, content) {
  const def = shopDefinition(content, farm.typeId);
  const scale = content.precision.inventoryUnitsPerJin;
  const productId = def.productItemId;
  farm.herd ||= [];
  // 1) 喂养：饲料不够时按比例少喂，每头小牛当日记的"吃饱天数"按比例加。
  const heads = herdHeads(farm);
  const needUnits = herdFeedNeedUnits(farm, def, content);
  const feedStock = farm.inventory?.[def.feedItemId] || 0;
  const fraction = needUnits > 0 ? Math.min(1, feedStock / needUnits) : 1;
  let feedUnits = 0;
  let feedCost = 0;
  if (needUnits > 0 && fraction > 0) {
    const feed = takeStock(farm, def.feedItemId, Math.ceil(fraction * needUnits));
    feedUnits = feed.units;
    feedCost = feed.costUnits;
    if (feedUnits > 0) addBookMap(farm, "consumedUnits", def.feedItemId, feedUnits);
  }
  for (const cohort of farm.herd) {
    if (feedCost > 0 && heads > 0) cohort.costUnits = (cohort.costUnits || 0) + feedCost * cohort.count / heads;
    if (needUnits > 0) cohort.fedDays = (cohort.fedDays || 0) + fraction;
  }
  // 2) 出栏：吃满养成天数的小牛成为耕牛，入养牛场库存（成本 = 它吃掉的饲料）。
  const growth = def.herd.growthDays;
  let matured = 0;
  let maturedCost = 0;
  const remaining = [];
  for (const cohort of farm.herd) {
    if ((cohort.fedDays || 0) >= growth - 1e-9) {
      matured += cohort.count;
      maturedCost += cohort.costUnits || 0;
    } else remaining.push(cohort);
  }
  farm.herd = remaining;
  if (matured > 0) {
    putStock(farm, productId, matured * scale, round(maturedCost));
    addBookMap(farm, "producedUnits", productId, matured * scale);
  }
  // 3) 新开小牛：排产上限 = 饲养人员当日能开的头数；闸门 = 存栏 + 库存不超过一个养殖周期的需求。
  const capacityUnits = farmDailyOutputUnits(state, farm, content);
  const capacityHeads = capacityUnits / scale;
  const stockHeads = (farm.inventory?.[productId] || 0) / scale;
  const rows = recentRows(farm, content);
  const avgSoldHeads = rows.length ? rows.reduce((sum, row) => sum + Math.max(0, row.soldUnitsByItem?.[productId] || 0), 0) / rows.length / scale : 0;
  const avgUnmetHeads = rows.length ? rows.reduce((sum, row) => sum + Math.max(0, row.unmetUnitsByItem?.[productId] || 0), 0) / rows.length / scale : 0;
  const bootstrap = (farm.history || []).length < 3 ? capacityHeads * growth : 0;
  const pipelineTarget = Math.max(avgSoldHeads * growth, avgUnmetHeads * growth, bootstrap);
  const room = Math.max(0, pipelineTarget - (herdHeads(farm) + stockHeads));
  const want = Math.min(capacityHeads, room);
  farm.herdCarry = Math.min(1, (farm.herdCarry || 0) + want);
  const started = Math.floor(farm.herdCarry + 1e-9);
  farm.herdCarry -= started;
  if (started > 0) farm.herd.push({ count: started, fedDays: 0, costUnits: 0 });
  // 产出状态（界面用）。
  farm.outputReason = capacityHeads <= 0 ? "无人饲养" : started <= 0 && room <= 0 ? "存栏充足，暂停开新" : fraction < 1 ? "饲料不足，小牛减长" : "满产";
  if (capacityHeads > 0 && fraction < 1) farm.statusReason = "缺饲料";
  return { shopId: farm.id, producedUnits: matured * scale, startedHeads: started, herdHeads: herdHeads(farm), feedUnits, fraction };
}

function recentRows(farm, content) {
  return (farm.history || []).slice(-Math.max(1, content.rules.priceAdjust?.reviewDays || 7));
}

// 耐用品（耕牛）的挂牌价：开着的养牛场里最便宜的一家的卖价（没有养牛场时用官价，供农户预算算需求）。
export function cattleListPrice(state, itemId, content, fallback) {
  let best = 0;
  for (const farm of openCattleFarms(state, content)) {
    if (shopDefinition(content, farm.typeId)?.productItemId !== itemId) continue;
    const price = farmSalePriceVoucher(state, farm, content);
    if (price > 0 && (best === 0 || price < best)) best = price;
  }
  return best > 0 ? best : fallback;
}

// 养牛场直接卖耕牛给农民户（每户付钱，库存进户）。needs：户号 → 想买的库存单位（耕牛 1 头 = 库存 3000 单位）。
// 付不起或农场没货的部分记为未满足，并把未满足挂到经营这种产品的养牛场上（驱动加派饲养员）。
export function sellOxToHouseholds(state, itemId, needs, content) {
  const scale = content.precision.inventoryUnitsPerJin;
  const money = currencyScale(content);
  const farms = openCattleFarms(state, content)
    .filter(farm => shopDefinition(content, farm.typeId)?.productItemId === itemId)
    .map(farm => ({ farm, price: farmSalePriceVoucher(state, farm, content) }))
    .filter(row => row.price > 0)
    .sort((a, b) => a.price - b.price || (b.farm.inventory[itemId] || 0) - (a.farm.inventory[itemId] || 0) || a.farm.id.localeCompare(b.farm.id));
  let purchasedUnits = 0;
  let paidVoucherUnits = 0;
  let desiredUnits = 0;
  for (const householdId of Object.keys(needs).sort()) {
    const household = state.households?.byId?.[householdId];
    let want = Math.max(0, Math.floor(needs[householdId] || 0));
    if (!household || !isActiveHousehold(household) || want <= 0) continue;
    desiredUnits += want;
    for (const row of farms) {
      if (want <= 0) break;
      const stock = row.farm.inventory[itemId] || 0;
      const units = Math.min(want, stock);
      if (units <= 0) continue;
      const value = Math.round(units / scale * row.price * money);
      if (value <= 0) continue;
      const payment = settleMonetaryPayment(state, householdOwner(householdId), shopOwner(row.farm.id), currentPaymentComposition(state, value), content,
        "farm_sale", `${household.name}向${row.farm.name}买${content.items[itemId]?.name || itemId}`,
        { requireFull: true, ...reserveWheatFullPaymentOptions(state, household, content, content.rules.basicCommerceFoodReserveDays ?? 30) });
      if (!payment.ok) break;
      const taken = takeStock(row.farm, itemId, units);
      addBookValue(row.farm, "revenueVoucherUnits", value);
      addBookValue(row.farm, "cogsVoucherUnits", taken.costUnits);
      addBookMap(row.farm, "soldUnits", itemId, taken.units);
      applyProfit(row.farm, value - taken.costUnits);
      creditHouseholdInventory(state, householdId, itemId, taken.units, content);
      purchasedUnits += taken.units;
      paidVoucherUnits += payment.paidValueUnits || value;
      want -= taken.units;
    }
  }
  const unmetUnits = Math.max(0, desiredUnits - purchasedUnits);
  if (unmetUnits > 0) {
    const producers = openCattleFarms(state, content).filter(farm => shopDefinition(content, farm.typeId)?.productItemId === itemId);
    for (const farm of producers) addBookMap(farm, "unmetUnits", itemId, unmetUnits / producers.length);
  }
  const reason = farms.length === 0 ? "没有养牛场" : desiredUnits <= 0 ? "无人需要" : null;
  return { purchasedUnits, paidVoucherUnits, unmetUnits, reason };
}

// ── 维护费与耕牛的饲料 ──────────────────────────────────────────────────────

const blankCattlePeriod = () => ({
  dueVoucherUnits: 0, paidVoucherUnits: 0, unpaidVoucherUnits: 0, unpaidHouseholds: 0,
  feedWheatUnits: 0, feedVoucherUnits: 0, unfedHouseholds: 0
});

export function ensureCattle(state) {
  state.cattle ||= {};
  ensureBook(state.cattle, blankCattlePeriod);
  return state.cattle;
}

export function resetCattleDay(state) {
  if (state.cattle) state.cattle.day = blankCattlePeriod();
}

export function resetCattleYear(state) {
  if (state.cattle) state.cattle.year = blankCattlePeriod();
}

// 养牛场替在役耕牛买饲料小麦：走批发市场的镇库采购（小麦留口粮储备线，见 buyWholesaleForOwner），
// 买到的小麦入养牛场库存后当天全部消耗（小麦被吃掉，不回流）。货款进镇库，成本计入养牛场的饲料成本（利润 = 维护费 − 饲料 − 工资 ...）。
// 返回喂饱比例 0 ~ 1：买到的量 ÷ 需要的量。
function feedWorkingOxen(state, farm, needUnits, content, book) {
  if (!(needUnits > 0)) return 1;
  const def = shopDefinition(content, farm.typeId);
  const feedItemId = def.feedItemId;
  const bought = buyWholesaleForOwner(state, shopOwner(farm.id), feedItemId, needUnits, content, `${farm.name}为在役耕牛买饲料`);
  const boughtUnits = bought.ok ? (bought.boughtUnits || 0) : 0;
  if (boughtUnits > 0) {
    const paid = bought.paidVoucherUnits || 0;
    putStock(farm, feedItemId, boughtUnits, paid);
    addBookValue(farm, "purchaseVoucherUnits", paid);
    addBookMap(farm, "purchasedUnits", feedItemId, boughtUnits);
    const taken = takeStock(farm, feedItemId, boughtUnits);
    addBookValue(farm, "cogsVoucherUnits", taken.costUnits);
    addBookMap(farm, "consumedUnits", feedItemId, taken.units);
    applyProfit(farm, -taken.costUnits);
    bookAdd(book, "feedWheatUnits", taken.units);
    bookAdd(book, "feedVoucherUnits", taken.costUnits);
  }
  return Math.min(1, boughtUnits / needUnits);
}

// 每日维护费与饲料（日结 oxMaintenance 步）：
//   1. 每户按在役耕牛头数付一天的维护费（每头 oxMaintenancePerOxYearVoucher ÷ daysPerYear 券），付给养牛场（户号排序后轮转）。
//   2. 收到维护费的养牛场为这些耕牛买饲料小麦（每头 oxFeedPerOxDayJin 斤/日），由镇库小麦供应，买到的当日消耗。
//   3. 欠养（没付全额，或喂不饱）按缺口累计：付不起或没有养牛场的户 +1；喂饱比例为 f 的户 +(1 − f)；全部喂饱即清零。
//      欠养超过宽限天数后耕牛效力下降（selectors/farmland.js 的 oxEfficiency），补上即恢复。没有耕牛的户欠养清零。
export function payOxMaintenanceDay(state, content) {
  const book = ensureCattle(state);
  const scale = content.precision.inventoryUnitsPerJin;
  const money = currencyScale(content);
  const oxId = content.agriculture.oxItemId;
  const perOxDay = (content.rules.oxMaintenancePerOxYearVoucher ?? 1800) / (content.rules.daysPerYear || 360);
  const feedPerOx = content.rules.oxFeedPerOxDayJin ?? 5;
  const farms = openCattleFarms(state, content);
  const rows = [];
  const needByFarm = new Map();
  let index = 0;
  for (const household of householdList(state)) {
    const held = Math.max(0, household.inventory?.[oxId] || 0) / scale;
    if (held <= 0) { if (household.oxGapDays) household.oxGapDays = 0; continue; }
    if (!isActiveHousehold(household)) continue;
    const due = Math.round(held * perOxDay * money);
    const turn = index++;
    if (due <= 0) { household.oxGapDays = 0; continue; }
    bookAdd(book, "dueVoucherUnits", due);
    const farm = farms.length ? farms[turn % farms.length] : null;
    const payment = farm
      ? settleMonetaryPayment(state, householdOwner(household.id), shopOwner(farm.id), currentPaymentComposition(state, due), content,
        "ox_maintenance", `${household.name}耕牛维护费（${held.toFixed(1)}头）`,
        { requireFull: true, ...reserveWheatFullPaymentOptions(state, household, content, content.rules.basicCommerceFoodReserveDays ?? 30) })
      : { ok: false };
    if (!payment.ok) {
      rows.push({ household, farmId: null });
      bookAdd(book, "unpaidVoucherUnits", due);
      bookAdd(book, "unpaidHouseholds", 1);
      continue;
    }
    const paid = payment.paidValueUnits || due;
    bookAdd(book, "paidVoucherUnits", paid);
    addBookValue(farm, "revenueVoucherUnits", paid);
    addBookValue(farm, "oxMaintenanceVoucherUnits", paid);
    applyProfit(farm, paid);
    const needUnits = Math.ceil(held * feedPerOx * scale);
    const row = needByFarm.get(farm.id) || { farm, needUnits: 0, households: [] };
    row.needUnits += needUnits;
    row.households.push(household);
    needByFarm.set(farm.id, row);
    rows.push({ household, farmId: farm.id });
  }
  // 养牛场为已付费的耕牛买饲料；喂饱比例按农场统一计。
  const fedByFarm = new Map();
  for (const [farmId, row] of needByFarm) fedByFarm.set(farmId, feedWorkingOxen(state, row.farm, row.needUnits, content, book));
  for (const row of rows) {
    const household = row.household;
    const fed = row.farmId ? (fedByFarm.get(row.farmId) ?? 0) : 0;
    if (fed >= 1) household.oxGapDays = 0;
    else {
      household.oxGapDays = (household.oxGapDays || 0) + (1 - fed);
      bookAdd(book, "unfedHouseholds", 1);
    }
  }
  return { dueVoucherUnits: book.day.dueVoucherUnits, paidVoucherUnits: book.day.paidVoucherUnits, unpaidHouseholds: book.day.unpaidHouseholds, farms: farms.length };
}
