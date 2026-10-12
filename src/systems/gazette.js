// 年度镇报（《麦乡镇报》）：每年年终、年报生成之后编一期。纯读取：只看年报与当前 state，不消耗随机数
// （措辞用 (年份 + 栏目) 的稳定哈希选模板，同种子同结果）。素材库见 economy/gazette-notes.js。
//
// 一期 issue：{ year, headline, sections: [{ title, lines, kind? }] }；每期 <8KB（UTF-8），超了按 TRIM_ORDER 从副刊、要闻等处逐行减。
// marks 是年终快照（物价指数、各商品批发价、上市公司股价、外镇繁荣度、闲人数、斗兽场出席累计），
// 只用来算"较上年"；下一期生成后被覆盖。

import { populationStats } from "../selectors/labor.js";
import { selectFoodDays } from "../selectors/economy.js";
import { selectDurableCoverage } from "../selectors/durable-goods.js";
import { ironPlowAcresOf } from "../selectors/farmland.js";
import { householdList, householdPopulation, isActiveHousehold } from "./households.js";
import { householdIncomePerCapitaJin, householdPriceIndex, householdWealthUnits } from "./household-budget.js";
import { computeLaborMarket } from "./labor-market.js";
import { wholesaleMarketItemIds } from "./wholesale-market.js";
import { wholesalePrice } from "./wholesale-price.js";
import { gdpOfReport } from "../selectors/gdp.js";
import { GAZETTE_ISSUE_LIMIT } from "../economy/gazette-notes.js";

export const GAZETTE_BYTE_LIMIT = 8192;
// 超长时按此顺序逐行去掉（每栏至少留一行）。
const TRIM_ORDER = ["茶馆闲谈", "集市小广告", "工商要闻", "人物", "年度大事记", "市井物价"];

const SECTOR_NAMES = {
  forestry: "伐木", salt: "盐业", coal: "煤炭", iron: "铁器", smelting: "冶炼", jewelry: "金银器",
  brewing: "酿酒", textile: "织布", housing: "营造", tea: "茶叶", clay: "陶土", pottery: "陶器", silk: "丝绸"
};

// ---------------------------------------------------------------- 小工具

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// 稳定选模板：同一年、同一栏目总是选同一句（同种子可复现，且不碰随机数流）。
function say(year, slot, variants) {
  return variants[hashText(`${year}:${slot}`) % variants.length]();
}

const num = value => Math.round(value).toLocaleString("zh-CN");
const wan = value => (Math.abs(value) >= 10000 ? `${(value / 10000).toFixed(Math.abs(value) >= 1e6 ? 0 : 1)}万` : num(value));
// 涨跌说法：几乎不动写"持平"，否则带符号。
const changeText = value => (Math.abs(value) < 0.05 ? "持平" : signedPct(value));
const signedPct = value => `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(1)}%`;
const signedNum = (value, digits = 0) => `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(digits)}`;
// 四舍五入后为零的变动写"持平"（否则会出现"-0"）。
const deltaText = (value, digits = 0) => (Number(value.toFixed(digits)) === 0 ? "持平" : `较上年${signedNum(value, digits)}`);
const byteLength = text => new TextEncoder().encode(text).length;

// ---------------------------------------------------------------- 事实（只读）

function annualFacts(state, content, report) {
  const scale = content.precision.currencyUnitsPerVoucher;
  const qeq = content.precision.qeqUnitsPerJin;
  const year = report.year;
  const reports = (state.annualReports || []).filter(row => row && Number.isInteger(row.year) && row.year < year);
  const prev = reports.find(row => row.year === year - 1) || null;
  const marks = state.gazette?.marks || null;
  const f = { year, scale };

  // 人口与户数
  f.people = report.populationAfterAging ?? populationStats(state).total;
  f.prevPeople = prev?.populationAfterAging ?? null;
  f.peopleMaxBefore = reports.reduce((max, row) => Math.max(max, row.populationAfterAging || 0), 0);
  f.households = householdList(state).filter(isActiveHousehold).length;
  f.satisfaction = Number(state.satisfaction) || 0;
  f.births = Number(report.births) || 0;
  f.deaths = Number(report.deaths) || 0;
  f.marriages = Number(report.marriages) || 0;
  f.prevBirths = prev ? Number(prev.births) || 0 : null;
  f.prevDeaths = prev ? Number(prev.deaths) || 0 : null;
  f.gdp = gdpOfReport(report, content);
  f.prevGdp = prev ? gdpOfReport(prev, content) : null;
  f.gdpGrowth = f.gdp && f.prevGdp && f.prevGdp.total > 0 ? (f.gdp.total / f.prevGdp.total - 1) * 100 : null;
  f.perCapitaGrowth = f.gdp?.perCapita != null && f.prevGdp?.perCapita > 0 ? (f.gdp.perCapita / f.prevGdp.perCapita - 1) * 100 : null;
  f.gdpMaxBefore = reports.reduce((max, row) => Math.max(max, gdpOfReport(row, content)?.total || 0), 0);
  f.monthDays = content.rules.monthDays || 30;
  f.gini = report.wealth?.gini ?? 0;
  f.prevGini = prev?.wealth?.gini ?? null;

  // 秋收（年报里是全年合计，单位 qeq）
  f.harvestJin = (report.harvestQeq || 0) / qeq;
  f.prevHarvestJin = prev ? (prev.harvestQeq || 0) / qeq : null;
  f.harvestMaxBefore = reports.reduce((max, row) => Math.max(max, (row.harvestQeq || 0) / qeq), 0);

  // 镇库仓粮折口粮年数（镇库 = 全镇口粮 − 居民口粮）
  const allDays = selectFoodDays(state, content, true);
  const residentDays = selectFoodDays(state, content, false);
  f.townYears = Number.isFinite(allDays) && Number.isFinite(residentDays) && content.rules.daysPerYear > 0
    ? Math.max(0, (allDays - residentDays) / content.rules.daysPerYear) : null;

  // 农具：铁制农具覆盖率（有耐用品目标时才有），铁犁耕地占比
  const iron = selectDurableCoverage(state, content, "iron_farm_tool");
  f.ironCoverage = iron.targetPieces > 0 ? iron.coverage : null;
  const reclaimed = Number(state.agriculture?.reclaimedAcres) || 0;
  f.plowShare = reclaimed > 0 ? ironPlowAcresOf(state, content) / reclaimed : null;

  // 物价：物价指数（开局为 1）与各商品批发价，都跟上一期快照比
  f.priceIndex = householdPriceIndex(state, content);
  f.prevPriceIndex = Number.isFinite(marks?.priceIndex) && marks.priceIndex > 0 ? marks.priceIndex : 1;
  f.movers = [];
  f.priceNow = {};
  for (const itemId of wholesaleMarketItemIds(content)) {
    if (itemId === "wheat") continue;
    const now = wholesalePrice(state, itemId, content);
    if (!(now > 0)) continue;
    f.priceNow[itemId] = now;
    const base = Number(marks?.prices?.[itemId]) > 0
      ? Number(marks.prices[itemId])
      : Number(content.rules.wholesaleDefaultSalePrices?.[itemId] || content.rules.marketPricesVoucherPerUnit?.[itemId]);
    if (!(base > 0)) continue;
    f.movers.push({ itemId, name: content.items[itemId]?.name || itemId, unit: itemId === "wood" ? "单位" : "斤", base, now, change: (now / base - 1) * 100 });
  }
  f.movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.itemId.localeCompare(b.itemId));

  // 失业（闲人）
  f.idle = computeLaborMarket(state, content).idle || 0;
  f.prevIdle = Number.isFinite(marks?.idle) ? marks.idle : null;

  // 股市：上市公司年涨跌（以上期快照为基准；新挂牌的没有基准，不进榜）
  f.stockMoves = [];
  for (const company of Object.values(state.companies || {})) {
    if (!company?.listing?.listed || !(company.sharePriceVoucherUnits > 0)) continue;
    const base = Number(marks?.shares?.[company.id]);
    if (!(base > 0)) continue;
    f.stockMoves.push({ id: company.id, name: company.name, change: (company.sharePriceVoucherUnits / base - 1) * 100 });
  }
  f.stockMoves.sort((a, b) => b.change - a.change || a.id.localeCompare(b.id));
  f.listedCount = Object.values(state.companies || {}).filter(company => company?.listing?.listed).length;
  f.stampDutyVoucher = (report.stampDuty?.stampDutyUnits || 0) / scale;

  // 外镇：繁荣度与关系分，较上期
  f.towns = Object.entries(content.outsideTowns || {}).map(([id, profile]) => {
    const row = state.outsideTowns?.[id] || {};
    const base = marks?.towns?.[id] || null;
    return {
      id, name: profile.name,
      prosperity: Number(row.prosperity) || 0,
      relations: Number(row.relations) || 0,
      dProsperity: base ? (Number(row.prosperity) || 0) - base.prosperity : null,
      dRelations: base ? (Number(row.relations) || 0) - base.relations : null
    };
  });

  // 贸易行（年报的店铺年账）与工商行业
  const shopRows = Object.values(report.shops || {});
  const isTrade = row => content.rules.shopTypes?.[row.typeId]?.kind === "trade";
  const tradeRows = shopRows.filter(isTrade);
  f.trade = {
    count: tradeRows.length,
    revenueVoucher: tradeRows.reduce((sum, row) => sum + (row.accounts?.revenueVoucherUnits || 0), 0) / scale,
    profitVoucher: tradeRows.reduce((sum, row) => sum + (row.accounts?.profitVoucherUnits || 0), 0) / scale
  };
  f.topSector = Object.entries(report.industries || {})
    .map(([sector, row]) => ({ sector, name: SECTOR_NAMES[sector] || sector, revenue: row?.revenueWheatUnits || 0 }))
    .filter(row => row.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue || a.sector.localeCompare(b.sector))[0] || null;
  const profitByName = new Map();
  const addProfit = (name, units) => profitByName.set(name, (profitByName.get(name) || 0) + units / scale);
  for (const row of Object.values(report.companies || {})) {
    addProfit(content.buildings[row.typeId]?.name || row.name || "公司", row.accounts?.profitVoucherUnits || 0);
  }
  for (const row of shopRows) {
    if (isTrade(row)) continue;
    addProfit(content.rules.shopTypes?.[row.typeId]?.name || row.name || "店铺", row.accounts?.profitVoucherUnits || 0);
  }
  const ranked = [...profitByName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  f.topProfit = ranked.length && ranked[0][1] > 0 ? { name: ranked[0][0], profit: ranked[0][1] } : null;
  const last = ranked[ranked.length - 1];
  f.topLoss = last && last[1] < 0 ? { name: last[0], profit: last[1] } : null;

  // 人物：家底最厚、人口最多、年收入最高的一户
  let richest = null;
  let biggest = null;
  let richestIncome = null;
  for (const household of householdList(state)) {
    if (!isActiveHousehold(household)) continue;
    const wealth = householdWealthUnits(state, household, content) / scale;
    const people = householdPopulation(household);
    const income = householdIncomePerCapitaJin(household, content) * people;
    if (!richest || wealth > richest.wealth) richest = { name: household.name, wealth };
    if (!biggest || people > biggest.people) biggest = { name: household.name, people };
    if (!richestIncome || income > richestIncome.income) richestIncome = { name: household.name, income };
  }
  f.richest = richest;
  f.biggest = biggest;
  f.topIncome = richestIncome;

  // 斗兽场：年出席（累计差，年报之后已清年账，所以用累计）
  f.arenaAttendance = Math.max(0, (Number(state.arena?.cumulative?.attendance) || 0) - (Number(marks?.arenaAttendance) || 0));

  // 要闻：素材库里权重最高的（同权重先发生的在前）
  f.notes = (state.gazette?.notes || []).slice().sort((a, b) => b.weight - a.weight || a.day - b.day);
  f.reports = reports;
  return f;
}

// ---------------------------------------------------------------- 头条

function headlineFor(f) {
  const year = f.year;
  const candidates = [];
  const crossed = f.prevPeople != null ? Math.floor(f.people / 10000) : 0;
  if (crossed >= 1 && crossed > Math.floor(f.prevPeople / 10000)) {
    candidates.push({ score: 95, text: say(year, "head-pop-milestone", [
      () => `人丁兴旺，全镇人口已过${crossed}万。`,
      () => `户口簿又厚了：全镇破${crossed}万口。`,
      () => `生齿日繁，人口跨过${crossed}万大关。`
    ]) });
  }
  if (f.prevHarvestJin != null && f.prevHarvestJin > 0 && f.harvestJin < f.prevHarvestJin * 0.85) {
    const drop = (1 - f.harvestJin / f.prevHarvestJin) * 100;
    candidates.push({ score: 85, text: say(year, "head-harvest-bad", [
      () => `歉收：秋收只得${wan(f.harvestJin)}斤，较上年减${drop.toFixed(0)}%。`,
      () => `秋风早来，麦浪不足，收成减了${drop.toFixed(0)}%。`,
      () => `田里欠收，秋收比上年少了${drop.toFixed(0)}%，家家勒紧裤腰。`
    ]) });
  }
  if (f.townYears != null && f.townYears < 0.5) {
    candidates.push({ score: 80, text: say(year, "head-granary-low", [
      () => `仓粮告急：镇库小麦只够吃${f.townYears.toFixed(1)}年口粮。`,
      () => `粮仓见底，镇库存粮仅够${f.townYears.toFixed(1)}年口粮。`,
      () => `镇库存粮不多，眼下只够${f.townYears.toFixed(1)}年口粮。`
    ]) });
  }
  if (f.harvestJin > 0 && f.harvestJin > f.harvestMaxBefore && f.prevHarvestJin != null) {
    candidates.push({ score: 70, text: say(year, "head-harvest-record", [
      () => `秋收创新高，麦子入仓${wan(f.harvestJin)}斤。`,
      () => `金黄满田，今秋收成${wan(f.harvestJin)}斤，创下新高。`,
      () => `仓门推不开了：秋收${wan(f.harvestJin)}斤，是有镇以来最多的一年。`
    ]) });
  }
  if (f.gdpGrowth != null && f.gdpGrowth <= -10) {
    candidates.push({ score: 75, text: say(year, "head-gdp-down", [
      () => `镇上GDP缩水${Math.abs(f.gdpGrowth).toFixed(0)}%，全年总产出降至${wan(f.gdp.total)}券。`,
      () => `经济转冷：全镇产出${wan(f.gdp.total)}券，较上年减${Math.abs(f.gdpGrowth).toFixed(0)}%。`
    ]) });
  } else if (f.gdpGrowth != null && f.gdpGrowth >= 15 && f.gdp.total > f.gdpMaxBefore) {
    candidates.push({ score: 68, text: say(year, "head-gdp-up", [
      () => `GDP增长${f.gdpGrowth.toFixed(0)}%，全镇总产出${wan(f.gdp.total)}券创新高。`,
      () => `经济腾飞：全年产出${wan(f.gdp.total)}券，比上年多${f.gdpGrowth.toFixed(0)}%。`
    ]) });
  }
  const topNote = f.notes[0];
  if (topNote) {
    candidates.push({ score: topNote.weight * 10 + 5, text: topNote.text });
  }
  const stock = f.stockMoves[0];
  const stockLow = f.stockMoves[f.stockMoves.length - 1];
  const bigStock = stock && Math.abs(stock.change) >= 30 ? stock : (stockLow && Math.abs(stockLow.change) >= 30 ? stockLow : null);
  if (bigStock) {
    const up = bigStock.change >= 0;
    candidates.push({ score: 60, text: say(year, "head-stock", [
      () => `${bigStock.name}股价年${up ? "涨" : "跌"}${Math.abs(bigStock.change).toFixed(0)}%，交易所里人声鼎沸。`,
      () => `${bigStock.name}一年间${up ? "涨" : "跌"}了${Math.abs(bigStock.change).toFixed(0)}%。`,
      () => `股市风云：${bigStock.name}年${up ? "涨" : "跌"}${Math.abs(bigStock.change).toFixed(0)}%。`
    ]) });
  }
  const movers = f.movers[0];
  if (movers && Math.abs(movers.change) >= 25) {
    const up = movers.change >= 0;
    candidates.push({ score: 58, text: say(year, "head-price", [
      () => `${movers.name}价格${up ? "涨" : "跌"}${Math.abs(movers.change).toFixed(0)}%，市井议论纷纷。`,
      () => `${movers.name}年内${up ? "涨" : "跌"}了${Math.abs(movers.change).toFixed(0)}%，街上都在说这事。`,
      () => `市面上${movers.name}${up ? "贵" : "贱"}了${Math.abs(movers.change).toFixed(0)}%。`
    ]) });
  }
  if (f.gini != null && f.prevGini != null && Math.abs(f.gini - f.prevGini) >= 0.02) {
    const widen = f.gini > f.prevGini;
    candidates.push({ score: 50, text: say(year, "head-gini", [
      () => `贫富差距${widen ? "拉大" : "收窄"}，基尼系数${f.gini.toFixed(3)}。`,
      () => `家底分化${widen ? "加剧" : "回落"}：基尼系数由${f.prevGini.toFixed(3)}到${f.gini.toFixed(3)}。`,
      () => `镇上的贫富${widen ? "差得更远了" : "差距缩小了些"}。`
    ]) });
  }
  if (f.prevIdle != null && Math.abs(f.idle - f.prevIdle) >= 100 && Math.abs(f.idle - f.prevIdle) >= f.prevIdle * 0.3) {
    const more = f.idle > f.prevIdle;
    candidates.push({ score: 52, text: say(year, "head-idle", [
      () => `闲人${more ? "增" : "减"}至${num(f.idle)}人。`,
      () => `待业的人${more ? "多" : "少"}了，眼下共${num(f.idle)}人闲着。`,
      () => `人手${more ? "富余" : "紧俏"}，闲人一年间${more ? "添" : "去"}了不少。`
    ]) });
  }
  if (f.prevPeople != null && f.people > f.peopleMaxBefore && crossed < 1) {
    candidates.push({ score: 48, text: say(year, "head-pop-record", [
      () => `人口再创新高，全镇${num(f.people)}人。`,
      () => `生息繁衍，人口创了新高：${num(f.people)}人。`,
      () => `镇上又添了人口，共${num(f.people)}人，是历来最多。`
    ]) });
  }
  if (f.trade.count > 0 && f.trade.profitVoucher >= 5000) {
    candidates.push({ score: 46, text: say(year, "head-trade", [
      () => `贸易行一年获利${wan(f.trade.profitVoucher)}券，商路上满载而归。`,
      () => `外贸有利可图，贸易行全年赚了${wan(f.trade.profitVoucher)}券。`,
      () => `船来车往，贸易行一年入账${wan(f.trade.profitVoucher)}券利。`
    ]) });
  }
  if (f.arenaAttendance >= 300) {
    candidates.push({ score: 44, text: say(year, "head-arena", [
      () => `斗兽场一年出席${num(f.arenaAttendance)}人次，押注热闹。`,
      () => `看台上人满为患，斗兽场全年到场${num(f.arenaAttendance)}人次。`,
      () => `斗兽场的吆喝声不绝，一年下来${num(f.arenaAttendance)}人次进场。`
    ]) });
  }
  if (f.townYears != null && f.townYears >= 3) {
    candidates.push({ score: 30, text: say(year, "head-granary-plenty", [
      () => `仓廪充实，镇库小麦够吃${f.townYears.toFixed(1)}年。`,
      () => `粮仓殷实，存粮可供${f.townYears.toFixed(1)}年口粮。`,
      () => `家家有余粮，镇库存粮够吃${f.townYears.toFixed(1)}年。`
    ]) });
  }
  if (!candidates.length) {
    return say(year, "head-calm", [
      () => "平安年，镇务如常。",
      () => "风调雨顺，日子照旧。",
      () => "无大事，便是好年成。"
    ]);
  }
  // 分高者胜；同分取先列入的（列表顺序即优先级）。
  let best = candidates[0];
  for (const row of candidates) if (row.score > best.score) best = row;
  return best.text;
}

// ---------------------------------------------------------------- 栏目

function sectionStats(f) {
  const lines = [];
  let people = `全镇人口${num(f.people)}人、${num(f.households)}户`;
  if (f.prevPeople != null) {
    const delta = f.people - f.prevPeople;
    people += `，较上年${delta >= 0 ? "增" : "减"}${num(Math.abs(delta))}人`;
  }
  lines.push(people + "。");
  let mood = `居民满意度${f.satisfaction.toFixed(1)}，基尼系数${f.gini.toFixed(3)}`;
  if (f.prevGini != null) mood += `（${deltaText(f.gini - f.prevGini, 3)}）`;
  lines.push(mood + "。");
  const index = f.priceIndex;
  lines.push(`物价指数${index.toFixed(2)}，较上年${changeText((index / f.prevPriceIndex - 1) * 100)}。`);
  if (f.peopleMaxBefore > 0 && f.people >= f.peopleMaxBefore) lines.push("人口为有镇以来最多。");
  return { title: "镇情数据", lines: lines.slice(0, 4) };
}

// 国民经济：GDP、人均 GDP、同比与构成（口径见 selectors/gdp.js）。
function sectionEconomy(f) {
  const g = f.gdp;
  if (!g || !(g.total > 0)) return null;
  let line = `GDP约${wan(g.total)}券`;
  if (f.gdpGrowth != null) line += `，同比${changeText(f.gdpGrowth)}`;
  const lines = [line + "。"];
  if (g.perCapita != null) {
    let per = `人均GDP${num(g.perCapita)}券`;
    if (f.perCapitaGrowth != null) per += `，同比${changeText(f.perCapitaGrowth)}`;
    lines.push(per + "。");
  }
  const share = value => `${(value / g.total * 100).toFixed(0)}%`;
  lines.push(`构成：农业${share(g.agriculture)}、劳动报酬${share(g.wages)}、经营利润${share(g.profit)}${g.townSurplus > 0 ? `、镇营盈余${share(g.townSurplus)}` : ""}。`);
  return { title: "国民经济", lines };
}

function sectionGranary(f) {
  const lines = [];
  let harvest = `秋收${wan(f.harvestJin)}斤`;
  if (f.prevHarvestJin > 0) harvest += `，较上年${changeText((f.harvestJin / f.prevHarvestJin - 1) * 100)}`;
  else if (f.prevHarvestJin === 0) harvest += "，上年无收";
  lines.push(harvest + "。");
  if (f.townYears != null && Number.isFinite(f.townYears)) {
    lines.push(`镇库存小麦够吃${f.townYears.toFixed(1)}年口粮。`);
  }
  const tools = [];
  if (f.ironCoverage != null) tools.push(`铁制农具覆盖${(f.ironCoverage * 100).toFixed(0)}%`);
  if (f.plowShare != null && f.plowShare > 0) tools.push(`铁犁耕地占${(f.plowShare * 100).toFixed(0)}%`);
  if (tools.length) lines.push(tools.join("，") + "。");
  return { title: "农事与粮仓", lines: lines.slice(0, 3) };
}

function sectionPrices(f) {
  // 只列真有涨跌的（变动不足 0.5% 的不算新闻）。
  const rows = f.movers.filter(row => Math.abs(row.change) >= 0.5).slice(0, 5)
    .map(row => `${row.name}${signedPct(row.change)}：${row.base.toFixed(2)}→${row.now.toFixed(2)}券/${row.unit}`);
  return rows.length ? { title: "市井物价", lines: rows } : null;
}

function sectionIndustry(f) {
  const lines = [];
  const parts = [];
  if (f.topSector) parts.push(`产值冠军是${f.topSector.name}`);
  if (f.topProfit) parts.push(`获利最多的是${f.topProfit.name}（${wan(f.topProfit.profit)}券）`);
  if (f.topLoss) parts.push(`亏得最多的是${f.topLoss.name}（${wan(f.topLoss.profit)}券）`);
  if (parts.length) lines.push(parts.join("，") + "。");
  return lines.length ? { title: "工商要闻", lines: lines.slice(0, 3) } : null;
}

function sectionStocks(f) {
  if (!f.listedCount && !f.stockMoves.length) return null;
  const lines = [];
  if (f.stockMoves.length) {
    const up = f.stockMoves.filter(row => row.change > 0).slice(0, 2);
    const down = f.stockMoves.filter(row => row.change < 0).slice(-2).reverse();
    if (up.length) lines.push(`涨幅榜：${up.map(row => `${row.name}${signedPct(row.change)}`).join("、")}。`);
    if (down.length) lines.push(`跌幅榜：${down.map(row => `${row.name}${signedPct(row.change)}`).join("、")}。`);
  }
  lines.push(`印花税收入${wan(f.stampDutyVoucher)}券。`);
  return { title: "股市简讯", lines: lines.slice(0, 3) };
}

function sectionTowns(f) {
  const lines = f.towns.map(town => {
    const trend = town.dProsperity == null ? "" : `，${deltaText(town.dProsperity, 0)}`;
    const ties = town.relations >= 0 ? "交好" : "失和";
    const rel = town.dRelations == null || Number(town.dRelations.toFixed(0)) === 0 ? "" : `，关系${signedNum(town.dRelations, 0)}`;
    return `${town.name}繁荣${town.prosperity.toFixed(0)}${trend}，与我镇${ties}${rel}。`;
  });
  if (f.trade.count > 0) lines.push(`贸易行全年成交${wan(f.trade.revenueVoucher)}券，获利${wan(f.trade.profitVoucher)}券。`);
  return lines.length ? { title: "外镇来信", lines: lines.slice(0, 3) } : null;
}

function sectionPeople(f) {
  const lines = [];
  if (f.richest && f.richest.wealth > 0) lines.push(`家底最厚：${f.richest.name}，粮券与家财约${wan(f.richest.wealth)}券。`);
  if (f.biggest && f.biggest.people > 0) lines.push(`人口最多：${f.biggest.name}，${f.biggest.people}口。`);
  if (f.topIncome && f.topIncome.income > 0) lines.push(`进项最多：${f.topIncome.name}，约${wan(f.topIncome.income)}斤小麦等值。`);
  return lines.length ? { title: "人物", lines: lines.slice(0, 3) } : null;
}

function sectionAdvice(f) {
  const tips = [];
  if (f.idle >= 100) tips.push(`闲人${num(f.idle)}，就业面板上多设些岗位，或开一两间工坊。`);
  if (f.townYears != null && f.townYears < 1) tips.push("仓粮不足一年口粮，秋收前宜留心粮价。");
  if (f.townYears != null && f.townYears > 4) tips.push(`仓粮已够吃${f.townYears.toFixed(0)}年，不妨多买些银条，让存粮少压些仓。`);
  if (f.satisfaction < 50) tips.push(`居民舒心值只有${f.satisfaction.toFixed(0)}，不妨看看口粮、盐与日用品够不够。`);
  if (f.gini != null && f.prevGini != null && f.gini - f.prevGini >= 0.02) tips.push("贫富差距拉大，富人税可以议一议。");
  if (f.ironCoverage != null && f.ironCoverage < 0.5) tips.push("铁制农具覆盖不足，农户耕作吃力。");
  if (!tips.length) tips.push("镇务平稳，不必多虑。");
  return { title: "镇长手记", lines: tips.slice(0, 2) };
}


function dateText(day, monthDays) {
  const d = Math.max(1, Math.floor(day));
  return `${Math.floor((d - 1) / monthDays) + 1}月${((d - 1) % monthDays) + 1}日`;
}

// 年度大事记：当年素材库按发生先后列出（权重 ≥2，最多 6 条；头条已用的那条不重复）。
function sectionChronicle(f, headline) {
  const rows = f.notes.filter(row => row.weight >= 2 && row.text !== headline).slice(0, 6)
    .sort((a, b) => a.day - b.day || b.weight - a.weight);
  if (!rows.length) return null;
  return { title: "年度大事记", kind: "wide", lines: rows.map(row => `${dateText(row.day, f.monthDays)}　${row.text}`) };
}

// 民生：出生、去世、婚嫁与闲人，各与上年比。
function sectionLivelihood(f) {
  const lines = [];
  const vs = (now, before, unit) => (before == null ? "" : `（${Math.abs(now - before) < 1 ? "与上年持平" : `较上年${now >= before ? "多" : "少"}${num(Math.abs(now - before))}${unit}`}）`);
  if (f.births || f.deaths) lines.push(`添丁${num(f.births)}口${vs(f.births, f.prevBirths, "口")}，故去${num(f.deaths)}人${vs(f.deaths, f.prevDeaths, "人")}。`);
  if (f.marriages > 0) lines.push(`${num(f.marriages)}对新人成家。`);
  if (f.births + f.deaths > 0) {
    const net = f.births - f.deaths;
    lines.push(net >= 0 ? `生多于死，净增${num(net)}口。` : `死多于生，净减${num(-net)}口。`);
  }
  lines.push(f.prevIdle != null ? `待业闲人${num(f.idle)}，${deltaText(f.idle - f.prevIdle)}。` : `待业闲人${num(f.idle)}。`);
  return { title: "民生", lines: lines.slice(0, 4) };
}

// 本报评论：根据全年形势给出两三句编者评语，措辞按年份稳定选取。
function sectionEditorial(f) {
  const y = f.year;
  const lines = [];
  if (f.prevHarvestJin != null && f.prevHarvestJin > 0) {
    const r = f.harvestJin / f.prevHarvestJin;
    if (r < 0.85) lines.push(say(y, "ed-harvest-bad", [() => "歉收之年，各家宜惜粮，镇库也该早作打算。", () => "收成不济，开春前口粮要精打细算。"]));
    else if (r > 1.15) lines.push(say(y, "ed-harvest-good", [() => "丰年固然可喜，却别忘了粮多伤农，价贱时留意收储。", () => "仓里有粮心不慌，盼来年风调雨顺。"]));
  }
  if (f.perCapitaGrowth != null && f.perCapitaGrowth >= 5) lines.push(say(y, "ed-pcgdp-up", [() => "人均产出见涨，家家户户的日子有了起色。", () => "人均GDP上了台阶，是实打实的进步。"]));
  else if (f.perCapitaGrowth != null && f.perCapitaGrowth <= -5) lines.push(say(y, "ed-pcgdp-down", [() => "人口在添而产出没跟上，人均GDP下滑，须设法添岗位、增产出。", () => "人均产出回落，每个人分到的蛋糕小了。"]));
  if (f.idle >= 300) lines.push(say(y, "ed-idle", [() => `闲人逾${num(Math.floor(f.idle / 100) * 100)}，有力气没处使，镇上该多开些工坊。`, () => "人手富余是好事也是隐忧，岗位须跟上。"]));
  else if (f.prevIdle != null && f.idle < f.prevIdle * 0.5) lines.push(say(y, "ed-jobs", [() => "找活干不难了，雇主需拿出像样的工钱才留得住人。", () => "人手趋紧，工钱怕是要往上走。"]));
  if (f.prevGini != null && f.gini - f.prevGini >= 0.02) lines.push(say(y, "ed-gini-up", [() => "贫富渐远，本报以为税收与救济可以斟酌。", () => "富者愈富非镇之福，望镇长留意。"]));
  else if (f.prevGini != null && f.prevGini - f.gini >= 0.02) lines.push(say(y, "ed-gini-down", [() => "家底差距收窄，乡里和睦之象。", () => "贫富相近，邻里自然少些口角。"]));
  if (f.priceIndex / f.prevPriceIndex > 1.1) lines.push(say(y, "ed-price-up", [() => "物价上扬，薪水追不上，百姓怨声渐起。", () => "东西越买越贵，主妇们直摇头。"]));
  else if (f.priceIndex / f.prevPriceIndex < 0.92) lines.push(say(y, "ed-price-down", [() => "物价回落，买卖人利薄，居家过日子倒松快。", () => "市面渐贱，店家须当心积货。"]));
  if (f.satisfaction < 50) lines.push(say(y, "ed-mood-low", [() => "居民舒心值偏低，口粮、盐与日用品供得上吗？", () => "民心不安，当务之急是让百姓吃饱穿暖。"]));
  else if (f.satisfaction >= 80) lines.push(say(y, "ed-mood-high", [() => "家家安乐，镇上笑声多。", () => "人心安定，正是谋长远的好时候。"]));
  if (!lines.length) lines.push(say(y, "ed-calm", [() => "本年无大起落，稳扎稳打，便是进步。", () => "平淡的一年，细水长流。", () => "没有大事可议，倒也难得清静。"]));
  return { title: "本报评论", kind: "editorial", lines: lines.slice(0, 3) };
}

// 乡里经济榜：本期各行业产值前三。
function sectionSectors(report) {
  const rows = Object.entries(report.industries || {})
    .map(([sector, row]) => ({ name: SECTOR_NAMES[sector] || sector, revenue: row?.revenueWheatUnits || 0 }))
    .filter(row => row.revenue > 0).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name)).slice(0, 3);
  if (rows.length < 2) return null;
  return { title: "行业产值榜", lines: rows.map((row, i) => `第${i + 1}名　${row.name}`) };
}

const CHAT_LINES = [
  "老张说：今年的麦穗沉甸甸，来年准是好光景。", "李婶嫌盐贵，隔壁王嫂偏说比去年便宜了些。", "茶摊上有人打赌：下一座要盖的是戏园还是斗兽场。",
  "张木匠说，修房的木头是越来越好找了。", "渡口的老艄公讲，外镇来的货船比往年多了。", "村头的老人念叨：粮仓满，心不慌。",
  "小孩们在晒谷场追闹，说要赶在秋收前学会打算盘。", "有人说镇长近来总在仓房转，怕是在算账。", "货郎叹气：路好走了，竞争的人也多了。"
];
const AD_LINES = [
  "【启事】东街面铺招学徒，管饭，月钱面议。", "【寻物】丢失蓝布包一个，内有账本，拾者酬谢小麦十斤。", "【出让】农具成色九成新，价格好商量。",
  "【招租】向阳铺面一间，临近集市，欲租从速。", "【启事】本镇戏班择日开唱，各位乡亲捧场。", "【代写】书信契约，价廉。",
  "【收购】上好木料，量大价优。", "【招工】工坊缺人手，薪酬按月结。"
];
function pickDistinct(year, slot, pool, count) {
  const out = [];
  let k = 0;
  while (out.length < count && k < pool.length * 3) {
    const line = pool[hashText(`${year}:${slot}:${k}`) % pool.length];
    if (!out.includes(line)) out.push(line);
    k += 1;
  }
  return out;
}
function sectionChat(f) { return { title: "茶馆闲谈", lines: pickDistinct(f.year, "chat", CHAT_LINES, 2) }; }
function sectionAds(f) { return { title: "集市小广告", lines: pickDistinct(f.year, "ads", AD_LINES, 2) }; }

// ---------------------------------------------------------------- 编期

export function buildGazette(state, content, { report }) {
  const f = annualFacts(state, content, report);
  const headline = headlineFor(f);
  const sections = [
    sectionStats(f),
    sectionEconomy(f),
    sectionChronicle(f, headline),
    sectionLivelihood(f),
    sectionGranary(f),
    sectionPrices(f),
    sectionSectors(report),
    sectionIndustry(f),
    sectionStocks(f),
    sectionTowns(f),
    sectionPeople(f),
    sectionEditorial(f),
    sectionAdvice(f),
    sectionChat(f),
    sectionAds(f)
  ].filter(section => section && section.lines.length);
  const issue = { year: f.year, headline, sections: sections.map(({ title, lines, kind }) => (kind ? { title, lines, kind } : { title, lines })) };
  // 超长就按 TRIM_ORDER 逐栏逐行去掉（每栏至少留一行）；仍超则保留现状（测试会报）。
  for (const title of TRIM_ORDER) {
    const section = issue.sections.find(row => row.title === title);
    while (section && byteLength(JSON.stringify(issue)) > GAZETTE_BYTE_LIMIT && section.lines.length > 1) section.lines.pop();
  }
  const marks = {
    year: f.year,
    priceIndex: f.priceIndex,
    prices: f.priceNow,
    shares: Object.fromEntries(Object.values(state.companies || {})
      .filter(company => company?.listing?.listed && company.sharePriceVoucherUnits > 0)
      .map(company => [company.id, company.sharePriceVoucherUnits])),
    towns: Object.fromEntries(f.towns.map(town => [town.id, { prosperity: town.prosperity, relations: town.relations }])),
    idle: f.idle,
    arenaAttendance: Number(state.arena?.cumulative?.attendance) || 0
  };
  return { issue, marks };
}

// 年终入口（日结 gazette 步骤）：编一期、存入 issues（最近 12 期）、清空当年素材、更新快照。
export function settleGazetteYear(state, content, report) {
  const gazette = (state.gazette ||= { notes: [], issues: [], readYear: 0, marks: null });
  const { issue, marks } = buildGazette(state, content, { report });
  gazette.issues = [...(gazette.issues || []), issue].slice(-GAZETTE_ISSUE_LIMIT);
  gazette.notes = [];
  gazette.marks = marks;
  return issue;
}

export function gazetteBytes(issue) {
  return byteLength(JSON.stringify(issue));
}
