import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import {
  householdList, householdPopulation, householdEmploymentCount, householdIdleWorkers,
  totalHouseholdAgeBands, setHouseholdJobCount, setJobCount, releaseJobFromHousehold,
  releaseExcessHouseholdEmployment, syncResidentAggregates
} from "../src/systems/households.js";
import { initializeBuildingJobs } from "../src/systems/employment.js";
import { payDailyWages } from "../src/systems/payroll.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { loadState, saveState, SAVE_KEY } from "../src/persistence/storage.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const V = CONTENT.precision.currencyUnitsPerVoucher;

function assertPopulationAuthority(state) {
  const people = simulation.populationStats(state);
  const bands = totalHouseholdAgeBands(state);
  assert.deepEqual(bands, { children: people.children, workers: people.workers, elders: people.elders });
  const employed = householdList(state).reduce((sum, h) => sum + householdEmploymentCount(h), 0);
  assert.equal(simulation.selectJobRows(state).employed, employed);
  assert.ok(employed <= people.workers);
  for (const h of householdList(state)) assert.ok(householdEmploymentCount(h) <= h.ageBands.workers, h.id + " 就业不得超过劳动年龄人数");
  const valid = simulation.validateState(state);
  assert.equal(valid.valid, true, valid.errors.join("；"));
}

function memoryStorage(raw = null) {
  const data = new Map(raw == null ? [] : [[SAVE_KEY, raw]]);
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    keys() { return [...data.keys()]; },
    raw() { return data.get(SAVE_KEY); }
  };
}

function addStreet(state, id) {
  const plot = state.plots.find(row => !state.buildings.some(building => building.plotId === row.id));
  const building = { id, typeId: "commercial_street", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  initializeBuildingJobs(state, building, CONTENT);
  return building;
}

function toLegacyV10(state, { addPopulationMismatch = false } = {}) {
  const old = structuredClone(state);
  old.version = 10;
  old.schemaVersion = 10;
  old.households.members = {};
  let next = 1;
  for (const household of Object.values(old.households.byId)) {
    const bands = { ...household.ageBands };
    const jobs = { ...household.jobs };
    household.memberIds = [];
    const workers = [];
    const add = (age) => {
      const id = `member-${next++}`;
      old.households.members[id] = { id, householdId: household.id, age, jobKey: null };
      household.memberIds.push(id);
      return id;
    };
    for (let i = 0; i < bands.children; i += 1) add(10);
    for (let i = 0; i < bands.workers; i += 1) workers.push(add(30));
    for (let i = 0; i < bands.elders; i += 1) add(70);
    let cursor = 0;
    for (const jobKey of Object.keys(jobs).sort()) {
      for (let i = 0; i < jobs[jobKey]; i += 1) {
        assert.ok(workers[cursor], `v10 fixture ${household.id} 岗位多于劳动力`);
        old.households.members[workers[cursor++]].jobKey = jobKey;
      }
    }
    delete household.ageBands;
    delete household.jobs;
  }
  old.households.nextMemberNumber = next;
  if (addPopulationMismatch) {
    const h = Object.values(old.households.byId)[0];
    const id = `member-${next++}`;
    old.households.members[id] = { id, householdId: h.id, age: 10, jobKey: null };
    h.memberIds.push(id);
    old.households.nextMemberNumber = next;
  }
  // v10 carried several mutable employment mirrors. Their values must not survive as v11 authority.
  old.employment.roles = { farmers: 999, builders: 999 };
  old.employment.byBuilding = {};
  old.employment.privateByBuilding = {};
  old.employment.listedByBuilding = {};
  return old;
}

function totalHouseholdAssets(state) {
  const inventory = {};
  let vouchers = 0;
  for (const h of householdList(state)) {
    vouchers += h.voucherUnits || 0;
    for (const [itemId, units] of Object.entries(h.inventory || {})) inventory[itemId] = (inventory[itemId] || 0) + units;
  }
  return { inventory, vouchers };
}

test("0.1.3 新局只保留 cohort + 家庭年龄段 + 家庭岗位三层聚合权威", () => {
  const state = simulation.createInitialState({ seed: 130101 });
  assert.equal(state.version, 16);
  assert.equal(state.schemaVersion, 16);
  assert.equal("members" in state.households, false);
  assert.equal("nextMemberNumber" in state.households, false);
  for (const h of householdList(state)) assert.equal("memberIds" in h, false);
  assert.equal("roles" in state.employment, false);
  assert.equal("byBuilding" in state.employment, false);
  assertPopulationAuthority(state);
});

test("固定种子五年推进中家庭三年龄段始终与 cohort 一致，就业不超过劳动力", () => {
  const state = simulation.createInitialState({ seed: 130102 });
  for (let year = 0; year < 5; year += 1) {
    simulation.advanceDays(state, CONTENT.rules.daysPerYear);
    assertPopulationAuthority(state);
    assert.ok(state.lastDemography?.householdAllocation);
  }
  assert.equal(state.annualReports.length, 5);
});

test("家庭劳动力减少时稳定释放超额岗位；新增成年劳动力可再次就业", () => {
  const state = simulation.createInitialState({ seed: 130103 });
  setJobCount(state, "farmers", 0, CONTENT);
  const a = householdList(state).find(h => h.ageBands.workers >= 2);
  const b = householdList(state).find(h => h.id !== a.id);
  assert.ok(a && b);
  assert.equal(setHouseholdJobCount(state, a.id, "test-role", 2, CONTENT).ok, true);
  const movedWorkers = a.ageBands.workers - 1;
  a.ageBands.workers = 1;
  b.ageBands.workers += movedWorkers; // 测试只改变家庭分配，不改变 cohort 总量。
  const released = releaseExcessHouseholdEmployment(state);
  assert.deepEqual(released, [{ householdId: a.id, jobKey: "test-role", count: 1 }]);
  assert.equal(a.jobs["test-role"], 1);
  assert.equal(householdEmploymentCount(a), 1);
  assert.equal(setHouseholdJobCount(state, b.id, "test-role", 1, CONTENT).ok, true);
  assertPopulationAuthority(state);
});

test("换岗后旧欠薪仍属于形成欠薪时的原债权家庭", () => {
  const state = legacyVoucherState({ seed: 130104 });
  setJobCount(state, "farmers", 0, CONTENT);
  const [a, b] = householdList(state).filter(h => h.ageBands.workers > 0).slice(0, 2);
  const plot = state.plots.find(row => !state.buildings.some(building => building.plotId === row.id));
  const mill = { id: "v013-wage-mill", typeId: "mill", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(mill);
  initializeBuildingJobs(state, mill, CONTENT);
  const jobKey = `${mill.id}::millers`;
  assert.equal(setHouseholdJobCount(state, a.id, jobKey, 1, CONTENT).ok, true);
  payDailyWages(state, simulation.selectJobRows(state), CONTENT);
  const oldClaim = state.payroll.creditorClaims[jobKey][a.id];
  assert.ok(oldClaim > 0);
  assert.equal(releaseJobFromHousehold(state, a.id, jobKey, 1), 1);
  assert.equal(setHouseholdJobCount(state, b.id, jobKey, 1, CONTENT).ok, true);
  assert.equal(simulation.issueGrainVouchers(state, "town", oldClaim / V).ok, true);
  const beforeA = a.voucherUnits;
  const beforeB = b.voucherUnits;
  payDailyWages(state, simulation.selectJobRows(state), CONTENT);
  assert.equal(a.voucherUnits - beforeA, oldClaim, "旧债权先支付给原家庭");
  assert.equal(b.voucherUnits - beforeB, 0, "新员工家庭不能继承旧欠薪");
  assert.equal(state.payroll.creditorClaims[jobKey][a.id], 0);
});

test("无人家庭停止生活消费和福利，但资产与应收欠薪继续保留", () => {
  const state = simulation.createInitialState({ seed: 130105 });
  const [empty, receiver] = householdList(state).slice(0, 2);
  releaseExcessHouseholdEmployment(state);
  for (const [band, count] of Object.entries(empty.ageBands)) {
    receiver.ageBands[band] += count;
    empty.ageBands[band] = 0;
  }
  for (const jobKey of Object.keys(empty.jobs || {})) releaseJobFromHousehold(state, empty.id, jobKey);
  empty.inventory.wheat += 1234;
  assert.equal(grantResidentVouchers(state, 77, CONTENT, empty.id).ok, true);
  state.payroll.creditorClaims ||= {};
  state.payroll.creditorClaims.legacy_test = { [empty.id]: 9 * V };
  state.payroll.arrearsVoucherUnits ||= {};
  state.payroll.arrearsVoucherUnits.legacy_test = 9 * V;
  syncResidentAggregates(state, CONTENT);
  const beforeInventory = structuredClone(empty.inventory);
  const beforeVouchers = empty.voucherUnits;
  simulation.advanceDay(state);
  assert.equal(householdPopulation(empty), 0);
  assert.deepEqual(empty.inventory, beforeInventory, "无人家庭不再发生生活消费");
  assert.equal(empty.voucherUnits, beforeVouchers, "无人家庭不领取普通福利，也不会无故丢失资产");
  assert.equal(state.payroll.creditorClaims.legacy_test[empty.id], 9 * V, "无人家庭旧工资债权仍可追踪");
  assertPopulationAuthority(state);
});

