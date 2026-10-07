import { performance } from "node:perf_hooks";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { parseSaveFile } from "../src/persistence/storage.js";
import { checksumSaveText, encodeSaveContainer, decodeSaveContainer } from "../src/persistence/save-manager.js";
import { summarizeLegacyAnnualReports } from "../src/systems/annual-reports.js";

const ID = "bench-active";
const NAME = "活跃快照";
const SAVED_AT = "2026-09-27T12:00:00.000Z";

function byteLength(text) { return Buffer.byteLength(text, "utf8"); }
function median(values) { const s=[...values].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }
function measure(fn, { warmup = 5, reps = 25 } = {}) {
  for (let i=0;i<warmup;i++) fn();
  const values=[];
  for (let i=0;i<reps;i++) { const t=performance.now(); fn(); values.push(performance.now()-t); }
  return { meanMs: values.reduce((a,b)=>a+b,0)/values.length, medianMs: median(values), minMs: Math.min(...values), reps };
}

function oldEncode(state) {
  const check = simulation.validateState(state);
  if (!check.valid) throw new Error(check.errors.join("；"));
  const stateText = JSON.stringify(state); // 第一次完整状态序列化：校验和
  return JSON.stringify({ containerVersion: 1, id: ID, name: NAME, savedAt: SAVED_AT, checksum: checksumSaveText(stateText), state }); // 第二次遍历state
}
function oldDecode(raw) {
  const entry=JSON.parse(raw);
  const checkText=JSON.stringify(entry.state); // 校验重新序列化
  if (entry.checksum !== checksumSaveText(checkText)) throw new Error("checksum");
  return parseSaveFile(JSON.stringify(entry.state), CONTENT); // 再序列化后 parse
}

function activeSnapshot() {
  const state = simulation.createInitialState({ seed: 11010 });
  // 固定新局向前运行一个月，形成账本、家庭生活、历史和市场数据；不构造多年场景。
  simulation.advanceDays(state, 30);
  return state;
}

function fakeCompany(year) {
  return {
    id: "c1", name: "代表公司", typeId: "mill", buildingId: "mill-1", listedLevels: 2,
    listing: { listed: true, ticker: "001" },
    accounts: { day: { revenueVoucherUnits: 10 }, year: { revenueVoucherUnits: 250000 + year, expenseVoucherUnits: 180000, profitVoucherUnits: 70000, distributedVoucherUnits: 0 }, cumulative: { revenueVoucherUnits: year * 250000 } },
    history: Array.from({ length: 365 }, (_, d) => ({ serial: (year-1)*365+d, revenueVoucherUnits: 700+d, expenseVoucherUnits: 500+d, profitVoucherUnits: 200 })),
    dividendHistory: Array.from({ length: year }, (_, i) => ({ year:i+1, totalVoucherUnits:60000, townVoucherUnits:40000, residentVoucherUnits:20000, retainedBeforeVoucherUnits:90000, lastYearNetProfitVoucherUnits:70000, workingCapitalReserveVoucherUnits:30000, debtPaidVoucherUnits:0 })),
    inventory: { wheat: 200000, flour: 100000 }, settings: { targetWorkers: 8 }, dailyTradeHistory: Array.from({length:60},(_,i)=>({day:i,units:100+i}))
  };
}
function fakeShop(year) {
  return {
    id:"s1", name:"代表店铺", typeId:"general", buildingId:"street-1", ownerHouseholdId:"household-1", status:"open",
    accounts:{ day:{revenueVoucherUnits:20}, year:{revenueVoucherUnits:80000,expenseVoucherUnits:62000,profitVoucherUnits:18000,distributedVoucherUnits:12000}, cumulative:{revenueVoucherUnits:year*80000}},
    history:Array.from({length:90},(_,d)=>({serial:(year-1)*365+d,revenueVoucherUnits:800+d,profitVoucherUnits:150})), inventory:{wheat:30000,bread:12000,salt:5000}, dailyBudget:{foo:1}
  };
}
function fakeLegacyReport(year) {
  return {
    year, harvestQeq: 1000000, consumptionQeq: 850000, operatingWagesQeq: 30000, constructionPayQeq:5000, reliefQeq:4000, processingLossQeq:1000, unemploymentPaidQeq:2000, wagePaidQeq:28000, wageArrearsQeq:500,
    business:{day:{revenue:1},year:{revenue:90000,expense:70000},cumulative:{revenue:year*90000}}, payroll:{day:{},year:{paidVoucherUnits:30000},cumulative:{paidVoucherUnits:year*30000}},
    industries:{salt:{day:{producedUnits:{salt:10}},year:{producedUnits:{salt:3650},soldUnits:{salt:3300}},cumulative:{producedUnits:{salt:year*3650}}}},
    privateEconomy:{day:{},year:{outputUnits:{wood:1000}},cumulative:{outputUnits:{wood:year*1000}},rightSales:{yearWheatUnits:100}}, agricultureTax:[{year,averageRateBps:5000}],
    financialFlows:{day:{},year:{income:100000,expense:80000},cumulative:{income:year*100000}}, fiscal:{day:{},year:{incomeVoucherUnits:20000,expenseVoucherUnits:15000},cumulative:{incomeVoucherUnits:year*20000}}, salt:{day:{},year:{demandUnits:1000,satisfiedUnits:950},cumulative:{}},
    companies:{c1:fakeCompany(year)}, shops:{s1:fakeShop(year)}, householdLife:{year,households:250,people:1000,totals:{incomeVoucherUnits:500000,expenseVoucherUnits:450000}},
    populationAtClose:1000+year, populationAfterAging:1002+year, births:20,deaths:18,marriages:8,laborChange:{openingWorkers:600,closingWorkers:602,adults:20,retirees:18},closingQeq:5000000
  };
}

const state = activeSnapshot();
const oldRaw = oldEncode(state);
const newRaw = encodeSaveContainer(ID, NAME, state, SAVED_AT, CONTENT);
const encodeOld = measure(() => oldEncode(state));
const encodeNew = measure(() => encodeSaveContainer(ID, NAME, state, SAVED_AT, CONTENT));
const decodeOld = measure(() => oldDecode(oldRaw), {warmup:3,reps:15});
const decodeNew = measure(() => decodeSaveContainer(newRaw, ID, CONTENT).state, {warmup:3,reps:15});

const annualGrowth = [1,5,10,20].map(years => {
  const legacy = { annualReports: Array.from({length:years},(_,i)=>fakeLegacyReport(i+1)), companies:{}, shops:{} };
  const oldText=JSON.stringify(legacy.annualReports);
  const summaries=summarizeLegacyAnnualReports(legacy);
  const newText=JSON.stringify(summaries);
  return { years, legacyBytes:byteLength(oldText), summaryBytes:byteLength(newText), reductionPct:(1-byteLength(newText)/byteLength(oldText))*100 };
});

console.log(JSON.stringify({
  scenario:{seed:11010,daysAdvanced:30,year:state.year,day:state.day,households:Object.keys(state.households?.byId||{}).length,ledgerRows:state.ledger.length},
  serialization:{baselineStateStringifyTraversalsPerEncode:2,optimizedStateStringifyTraversalsPerEncode:1},
  encoding:{baseline:encodeOld,optimized:encodeNew,improvementPct:(1-encodeNew.meanMs/encodeOld.meanMs)*100},
  decoding:{baseline:decodeOld,optimized:decodeNew,improvementPct:(1-decodeNew.meanMs/decodeOld.meanMs)*100},
  containerSize:{baselineBytes:byteLength(oldRaw),optimizedBytes:byteLength(newRaw),differenceBytes:byteLength(newRaw)-byteLength(oldRaw)},
  annualGrowthConstructed:annualGrowth
}, null, 2));
