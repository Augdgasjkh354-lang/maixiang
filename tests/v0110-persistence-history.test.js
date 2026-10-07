import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { renderPeople } from "../src/ui/panel-people.js";
import { renderLedger } from "../src/ui/panel-ledger.js";
import {
  SAVE_CONTAINER_VERSION,
  checksumSaveText,
  createSaveManager,
  decodeSaveContainer,
  encodeSaveContainer
} from "../src/persistence/save-manager.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    raw(key) { return data.get(key); }
  };
}

function legacyV1Container(id, name, state, savedAt) {
  const stateText = JSON.stringify(state);
  return JSON.stringify({ containerVersion: 1, id, name, savedAt, checksum: checksumSaveText(stateText), state });
}

test("0.1.10 新v2容器只持久化一个规范state文本，并兼容读取v1容器", () => {
  const state = simulation.createInitialState({ seed: 11001 });
  simulation.advanceDays(state, 3);
  const id = "slot-a";
  const savedAt = "2026-09-27T12:00:00.000Z";
  const raw = encodeSaveContainer(id, "测试", state, savedAt, CONTENT);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.containerVersion, SAVE_CONTAINER_VERSION);
  assert.equal(SAVE_CONTAINER_VERSION, 2);
  assert.equal(parsed.checksum, checksumSaveText(JSON.stringify(state)));
  const normalized = migrateSave(state, CONTENT);
  assert.deepEqual(decodeSaveContainer(raw, id, CONTENT).state, normalized);

  const legacy = legacyV1Container(id, "旧容器", state, savedAt);
  const loadedLegacy = decodeSaveContainer(legacy, id, CONTENT);
  assert.equal(loadedLegacy.name, "旧容器");
  assert.deepEqual(loadedLegacy.state, normalized);
});

test("0.1.10 校验失败仍回退上一份可读备份，坏主档不覆盖备份", () => {
  const storage = memoryStorage();
  const saves = createSaveManager(storage, CONTENT);
  const opened = saves.createNew("主档");
  const changed = structuredClone(opened.state);
  simulation.advanceDay(changed);
  saves.saveCurrent(changed, opened.id);
  const primaryKey = `maixiang-save-slot-v1:${opened.id}`;
  const backupKey = `${primaryKey}:backup`;
  const backup = storage.raw(backupKey);
  assert.ok(backup);
  const corrupt = storage.raw(primaryKey).replace(/"checksum":"[0-9a-f]+"/, '"checksum":"deadbeef"');
  storage.setItem(primaryKey, corrupt);
  const recovered = saves.read(opened.id);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.state.day, 0);
  assert.equal(storage.raw(backupKey), backup);
});

test("0.1.10 v14年报迁移为年度摘要，不嵌套公司店铺日史与历年分红史", () => {
  const old = simulation.createInitialState({ seed: 11002 });
  old.version = 14;
  old.schemaVersion = 14;
  old.annualReports = [{
    year: 1,
    harvestQeq: 100,
    consumptionQeq: 80,
    operatingWagesQeq: 12,
    constructionPayQeq: 3,
    reliefQeq: 4,
    processingLossQeq: 5,
    unemploymentPaidQeq: 6,
    wagePaidQeq: 7,
    wageArrearsQeq: 8,
    business: { revenueWheatUnits: 11 },
    payroll: { paidVoucherUnits: 22 },
    industries: { salt: { day: { producedUnits: { salt: 1 } }, year: { producedUnits: { salt: 365 }, soldUnits: 300 }, cumulative: { producedUnits: { salt: 9000 } } } },
    privateEconomy: { day: { outputUnits: { wood: 1 } }, year: { outputUnits: { wood: 20 } }, cumulative: { outputUnits: { wood: 100 } }, rightSales: { dayWheatUnits: 2, yearWheatUnits: 30, cumulativeWheatUnits: 200 }, plans: { huge: { ageDays: 99 } } },
    financialFlows: { day: { income: 1 }, year: { income: 200 }, cumulative: { income: 900 } },
    fiscal: { day: { dueWheatUnits: 1 }, year: { dueWheatUnits: 40 }, cumulative: { dueWheatUnits: 400 } },
    salt: { demandUnits: 1000, satisfiedUnits: 800 },
    agricultureTax: [{ year: 1, averageRateBps: 5000 }],
    companies: {
      c1: {
        id: "c1", name: "一号公司", typeId: "mill", buildingId: "mill-1", listedLevels: 1,
        listing: { listed: true, ticker: "001" },
        accounts: { day: { profitVoucherUnits: 1 }, year: { revenueVoucherUnits: 500, profitVoucherUnits: 90 }, cumulative: { revenueVoucherUnits: 5000 } },
        history: Array.from({ length: 20 }, (_, serial) => ({ serial, profitVoucherUnits: serial })),
        dividendHistory: [{ year: 1, totalVoucherUnits: 70, townVoucherUnits: 50, residentVoucherUnits: 20, retainedBeforeVoucherUnits: 100, lastYearNetProfitVoucherUnits: 90, workingCapitalReserveVoucherUnits: 30, debtPaidVoucherUnits: 2 }],
        inventory: { wheat: 999 }
      }
    },
    shops: {
      s1: {
        id: "s1", name: "一号店", typeId: "general_store", buildingId: "street-1", ownerHouseholdId: "h1", status: "open",
        accounts: { day: { revenueVoucherUnits: 2 }, year: { revenueVoucherUnits: 100, profitVoucherUnits: 15 }, cumulative: { revenueVoucherUnits: 900 } },
        history: Array.from({ length: 14 }, (_, serial) => ({ serial, revenueVoucherUnits: serial })),
        inventory: { wheat: 100 }
      }
    },
    householdLife: { year: 1, households: 10, people: 1000, totals: { incomeVoucherUnits: 2000 } },
    populationAtClose: 1000,
    populationAfterAging: 1002,
    births: 10,
    deaths: 8,
    marriages: 4,
    laborChange: { openingWorkers: 600, closingWorkers: 602 },
    closingQeq: 12345
  }];

  const restored = migrateSave(old, CONTENT);
  assert.equal(restored.version, 15);
  assert.equal(restored.schemaVersion, 15);
  const report = restored.annualReports[0];
  assert.equal(report.summaryVersion, 1);
  assert.equal(report.industries.salt.producedUnits.salt, 365);
  assert.equal(report.industries.salt.cumulative, undefined);
  assert.equal(report.privateEconomy.year.outputUnits.wood, 20);
  assert.equal(report.privateEconomy.plans, undefined);
  assert.equal(report.financialFlows.income, 200);
  assert.equal(report.fiscal.dueWheatUnits, 40);
  assert.equal(report.companies.c1.accounts.profitVoucherUnits, 90);
  assert.equal(report.companies.c1.history, undefined);
  assert.equal(report.companies.c1.dividendHistory, undefined);
  assert.equal(report.companies.c1.distribution.totalVoucherUnits, 70);
  assert.equal(report.shops.s1.accounts.profitVoucherUnits, 15);
  assert.equal(report.shops.s1.history, undefined);
  assert.equal(report.shops.s1.distributedVoucherUnits, null, "旧年报无法安全推导店铺分配时不得猜成0");
  assert.equal(report.householdLife.totals.incomeVoucherUnits, 2000);

  const peopleView = annualReport => ({
    people: { total: 1002, children: 200, workers: 602, elders: 200 },
    housingCapacity: 1200, housing: { shortage: 0 }, salt: { historyCoverage: 1 }, satisfaction: 80,
    lastDemography: null, annualReports: [annualReport]
  });
  assert.equal(renderPeople(peopleView(old.annualReports[0])), renderPeople(peopleView(report)), "迁移前后人口年度展示应一致");

  const ledgerView = annualReport => ({
    annualReports: [annualReport], ledger: [], yearTotals: { harvest: 0, consumption: 0, relief: 0, processingLoss: 0 },
    payroll: { year: {}, arrearsVoucherUnits: {} }, currencyUnitsPerVoucher: 100, inventoryUnitsPerJin: 100, qeqUnitsPerJin: 100,
    accounts: { residents: { qeq: 0, items: {} }, town: { qeq: 0, items: {} } },
    totalQeq: 0, dailyNeed: 0, residentFoodDays: 0, day: 0, itemNames: {}, itemUnits: {},
    monetaryReform: { stage: "wheat", targetVoucherBps: 0 }
  });
  assert.equal(renderLedger(ledgerView(old.annualReports[0])), renderLedger(ledgerView(report)), "迁移前后账本上一年展示应一致");
});
