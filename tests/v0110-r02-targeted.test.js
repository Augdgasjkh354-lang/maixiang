import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { BUILD_ID } from "../src/content/version.js";
import { selectJobRows, listedJobKeyForBuilding } from "../src/selectors/labor.js";
import { setJobCount } from "../src/systems/households.js";
import { payListedCompanyWages } from "../src/systems/companies.js";
import { renderJobs } from "../src/ui/panel-jobs.js";
import { renderSettings } from "../src/ui/panel-settings.js";
import { createIndexedSaveManager } from "../src/persistence/indexed-save-manager.js";
import { SAVE_KEY, exportState } from "../src/persistence/storage.js";

const SCALE = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = { id, typeId, level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 }, plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  return building;
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
}

function createFakeIndexedDb() {
  const stores = new Map();
  const keyPaths = new Map();
  let initialized = false;
  const controller = { failStore: null, failAllWrites: false };

  function request(value, error = null) {
    const req = { result: undefined, error, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (error) req.onerror?.();
      else { req.result = value; req.onsuccess?.(); }
    });
    return req;
  }

  class Tx {
    constructor(names, mode) {
      this.names = Array.isArray(names) ? names : [names];
      this.mode = mode;
      this.error = null;
      this.failed = false;
      this.oncomplete = null;
      this.onabort = null;
      this.onerror = null;
      setImmediate(() => { if (!this.failed) this.oncomplete?.(); });
    }
    objectStore(name) {
      if (!this.names.includes(name) || !stores.has(name)) throw new Error(`missing store ${name}`);
      const map = stores.get(name);
      const keyPath = keyPaths.get(name);
      const failWrite = () => this.mode === "readwrite" && (controller.failAllWrites || controller.failStore === name);
      const fail = () => {
        const error = new Error(`forced ${name} write failure`);
        error.name = "QuotaExceededError";
        this.error = error;
        this.failed = true;
        queueMicrotask(() => { this.onerror?.(); this.onabort?.(); });
        return request(undefined, error);
      };
      return {
        getAll: () => request([...map.values()].map(row => structuredClone(row))),
        get: key => request(map.has(key) ? structuredClone(map.get(key)) : undefined),
        put: row => {
          if (failWrite()) return fail();
          const key = row[keyPath];
          map.set(key, structuredClone(row));
          return request(key);
        },
        delete: key => {
          if (failWrite()) return fail();
          map.delete(key);
          return request(undefined);
        }
      };
    }
    abort() {
      if (this.failed) return;
      this.failed = true;
      this.error = new Error("aborted");
      queueMicrotask(() => this.onabort?.());
    }
  }

  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, options = {}) {
      if (!stores.has(name)) stores.set(name, new Map());
      keyPaths.set(name, options.keyPath || "id");
      return {};
    },
    transaction(names, mode) { return new Tx(names, mode); },
    close() {}
  };

  const factory = {
    open() {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (!initialized) { initialized = true; req.onupgradeneeded?.(); }
        queueMicrotask(() => req.onsuccess?.());
      });
      return req;
    },
    controller
  };
  return factory;
}

test("0.1.10-r02 就业面板的公司岗位读取公司工资，并只提交到对应公司", () => {
  const state = simulation.createInitialState({ seed: 110201 });
  addBuilding(state, "mill", "mill-a", 1);
  addBuilding(state, "mill", "mill-b", 1);
  const a = simulation.createCompany(state, "mill-a", { name: "甲磨坊", levels: 1, operatingCapitalVoucher: 0, initialMaterialQuantity: 0 });
  const b = simulation.createCompany(state, "mill-b", { name: "乙磨坊", levels: 1, operatingCapitalVoucher: 0, initialMaterialQuantity: 0 });
  assert.equal(a.ok && b.ok, true);
  simulation.setWageRate(state, "millers", 10);
  simulation.configureCompanyWage(state, a.companyId, 20);
  simulation.configureCompanyWage(state, b.companyId, 30);
  state.companies[a.companyId].cashWheatUnits = 1000 * SCALE;
  state.companies[b.companyId].cashWheatUnits = 1000 * SCALE;
  setJobCount(state, listedJobKeyForBuilding("mill-a", "millers"), 1, CONTENT, { type: "company", id: a.companyId });
  setJobCount(state, listedJobKeyForBuilding("mill-b", "millers"), 1, CONTENT, { type: "company", id: b.companyId });

  const rows = selectJobRows(state, CONTENT).rows.filter(row => row.scope === "listed");
  const rowA = rows.find(row => row.wageTarget === a.companyId);
  const rowB = rows.find(row => row.wageTarget === b.companyId);
  assert.equal(rowA.wagePerWorkerDay, 20);
  assert.equal(rowB.wagePerWorkerDay, 30);
  assert.equal(rowA.wageKind, "company-wage");

  const view = simulation.selectDashboard(state, { panel: "residents" });
  view.numericDrafts = {};
  const html = renderJobs(view);
  assert.match(html, new RegExp(`data-draft-kind="company-wage"[^>]*data-draft-target="${a.companyId}"`));
  assert.match(html, new RegExp(`data-draft-kind="company-wage"[^>]*data-draft-target="${b.companyId}"`));

  const result = simulation.configureCompanyWage(state, a.companyId, 25);
  assert.equal(result.ok, true);
  assert.equal(state.companies[a.companyId].settings.wagePerWorkerDay, 25);
  assert.equal(state.companies[b.companyId].settings.wagePerWorkerDay, 30, "同工种另一家公司不得被误改");
  assert.equal(state.employment.wageRates.millers, 10, "公司工资不得回写全局工种工资");

  const paid = payListedCompanyWages(state, CONTENT);
  assert.equal(paid.find(row => row.companyId === a.companyId).dueVoucherUnits, 25 * SCALE);
  assert.equal(paid.find(row => row.companyId === b.companyId).dueVoucherUnits, 30 * SCALE);
});

test("0.1.10-r02 设置页显示唯一构建号和当前页面地址", () => {
  // 基线清理：构建号跟随版本演进（现为 src/content/version.js 的 BUILD_ID），不再硬编码旧值；
  // 本测试只断言"设置页展示了当前构建号"这一行为。
  assert.ok(typeof BUILD_ID === "string" && BUILD_ID.length > 0, "构建号应为非空字符串");
  const html = renderSettings(null, null, { managerOpen: true, appVersion: "0.1.10", buildId: BUILD_ID, pageAddress: "https://example.test/maixiang/", slots: [], persistenceIssue: { message: "测试故障" } });
  assert.match(html, /当前运行版本/);
  assert.match(html, /0\.1\.10/);
  assert.ok(html.includes(BUILD_ID), "设置页应显示当前构建号");
  assert.match(html, /https:\/\/example\.test\/maixiang\//);
  assert.match(html, /真实写入探测/);
  assert.doesNotMatch(html, />重试本机存储</);

  const unverified = renderSettings(null, null, { managerOpen: true, slots: [], legacyArtifacts: [{ key: "legacy-a", label: "旧单存档", bytes: 100, verified: false, readable: true, stillInLocalStorage: true }] });
  assert.match(unverified, /归档未完成校验；原数据保留/);
  assert.doesNotMatch(unverified, /data-clean-legacy=/);
  assert.doesNotMatch(unverified, /data-export-legacy=/);
});

test("0.1.10-r02 遗留归档失败不阻断现有IndexedDB读取或新建，原localStorage保留", async () => {
  const factory = createFakeIndexedDb();
  const legacyStorage = memoryStorage();
  const first = await createIndexedSaveManager({ indexedDB: factory, legacyStorage, content: CONTENT });
  const existing = await first.createNew("已有进度");
  first.close();

  const legacyRaw = exportState(simulation.createInitialState({ seed: 110202 }));
  legacyStorage.setItem(SAVE_KEY, legacyRaw);
  factory.controller.failStore = "legacy";

  const recovered = await createIndexedSaveManager({ indexedDB: factory, legacyStorage, content: CONTENT });
  const initialized = recovered.initialize();
  assert.equal(initialized.activeId, existing.id);
  assert.ok(initialized.state, "现有IndexedDB进度仍应可读");
  assert.match(initialized.warning || "", /遗留 localStorage 迁移未完成/);
  assert.equal(legacyStorage.getItem(SAVE_KEY), legacyRaw, "迁移故障不得删除或覆盖原localStorage");

  const created = await recovered.createNew("迁移故障下的新局");
  assert.ok(created.id);
  assert.equal(recovered.list().activeId, created.id);
});

test("0.1.10-r02 IndexedDB自身不可写时真实写入探测仍失败，不假报恢复", async () => {
  const factory = createFakeIndexedDb();
  const legacyStorage = memoryStorage({ [SAVE_KEY]: exportState(simulation.createInitialState({ seed: 110203 })) });
  factory.controller.failAllWrites = true;
  const manager = await createIndexedSaveManager({ indexedDB: factory, legacyStorage, content: CONTENT });
  assert.match(manager.list().warning || "", /迁移未完成/);
  await assert.rejects(() => manager.probePersistentStorage(), /forced meta write failure|写入|空间|存储/i);
});
