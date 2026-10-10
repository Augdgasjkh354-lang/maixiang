import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { createSimulation, simulation } from "../src/engine.js";
import { splitOversizedHouseholds } from "../src/systems/household-split.js";
import { householdList, householdPopulation, householdWorkingAge, householdEmploymentCount, householdIdleWorkers, syncResidentAggregates } from "../src/systems/households.js";
import { validateCurrencyInvariant } from "../src/economy/currency.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { grantResidentVouchers } from "./helpers-v16.js";

const MAX = CONTENT.rules.householdSplitMaxPeople;
const BIG_CONTENT = { ...CONTENT, rules: { ...CONTENT.rules, initialHouseholdCount: 250 } };
const bigSimulation = createSimulation(BIG_CONTENT);

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

function households(state) {
  return householdList(state);
}

function cohortBands(state) {
  const totals = { children: 0, workers: 0, elders: 0 };
  for (const cohort of state.cohorts) {
    const count = cohort.m + cohort.f;
    if (cohort.age < 18) totals.children += count;
    else if (cohort.age < 65) totals.workers += count;
    else totals.elders += count;
  }
  return totals;
}

function bandTotals(state) {
  const totals = { children: 0, workers: 0, elders: 0 };
  for (const household of households(state)) {
    totals.children += household.ageBands.children;
    totals.workers += household.ageBands.workers;
    totals.elders += household.ageBands.elders;
  }
  return totals;
}

function inventoryTotals(state) {
  const totals = {};
  for (const household of households(state)) {
    for (const [itemId, units] of Object.entries(household.inventory || {})) totals[itemId] = (totals[itemId] || 0) + units;
  }
  return totals;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function voucherTotal(state) {
  return sum(households(state).map(household => household.voucherUnits || 0));
}

function depositTotal(state) {
  return sum(Object.values(state.bank?.deposits || {}));
}

function jobTotal(state) {
  return sum(households(state).map(household => householdEmploymentCount(household)));
}

// 给某户加人（同步 cohort，保证 validateState 的年龄段汇总一致）。
function addPeople(state, household, band, count) {
  const ranges = { children: [0, 17], workers: [18, 64], elders: [65, 200] };
  const [low, high] = ranges[band];
  const cohort = state.cohorts.find(row => row.age >= low && row.age <= high);
  cohort.m += count;
  household.ageBands[band] += count;
  syncResidentAggregates(state, CONTENT);
}

// 把某户年龄段改成指定人数（增减都做，cohort 同步扣加，保证总人口与 validateState 一致）。
function setBands(state, household, bands) {
  const ranges = { children: [0, 17], workers: [18, 64], elders: [65, 200] };
  for (const band of ["children", "workers", "elders"]) {
    const delta = (bands[band] || 0) - household.ageBands[band];
    if (delta > 0) addPeople(state, household, band, delta);
    if (delta < 0) {
      const [low, high] = ranges[band];
      let left = -delta;
      for (const cohort of state.cohorts.filter(row => row.age >= low && row.age <= high)) {
        const take = Math.min(left, cohort.m + cohort.f);
        const fromM = Math.min(take, cohort.m);
        cohort.m -= fromM;
        cohort.f -= take - fromM;
        left -= take;
        if (left === 0) break;
      }
      assert.equal(left, 0, "cohort 人数不足以减员");
      household.ageBands[band] = bands[band];
      syncResidentAggregates(state, CONTENT);
    }
  }
}

// 给某户换成指定的年龄段（只增不减）。
function growTo(state, household, bands) {
  for (const band of ["children", "workers", "elders"]) {
    const extra = (bands[band] || 0) - household.ageBands[band];
    if (extra > 0) addPeople(state, household, band, extra);
  }
}

function freePlot(state) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => !row.feature && !used.has(row.id));
  assert.ok(plot, "需要空地");
  return plot;
}

function addBuilding(state, id, typeId) {
  const plot = freePlot(state);
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return id;
}

test("新局：户数约为人口 ÷ 5，每户不超过 8 人，状态合法", () => {
  const state = simulation.createInitialState({ seed: 7001 });
  const population = sum(state.cohorts.map(cohort => cohort.m + cohort.f));
  const list = households(state);
  assert.equal(list.length, Math.round(population / CONTENT.rules.initialHouseholdSize));
  for (const household of list) assert.ok(householdPopulation(household) <= MAX, `${household.id} 人口超过 ${MAX}`);
  valid(state);
});

test("250 户大户开局：一次分家后每户不超过 8 人，钱粮、库存、存款、岗位、年龄段全部守恒，幂等", () => {
  const state = bigSimulation.createInitialState({ seed: 7002 });
  // 分家前：确有超过 8 人的大户
  assert.ok(households(state).some(household => householdPopulation(household) > MAX));
  const cohort = cohortBands(state);
  const before = {
    bands: bandTotals(state),
    vouchers: voucherTotal(state),
    deposits: depositTotal(state),
    inventory: inventoryTotals(state),
    jobs: jobTotal(state),
    count: households(state).length
  };
  assert.deepEqual(before.bands, cohort);

  const first = splitOversizedHouseholds(state, BIG_CONTENT);
  assert.ok(first.splits > 0);
  assert.equal(households(state).length, before.count + first.splits);
  for (const household of households(state)) {
    assert.ok(householdPopulation(household) <= MAX, `${household.id} 仍有 ${householdPopulation(household)} 人`);
    assert.ok(householdEmploymentCount(household) <= householdWorkingAge(household), `${household.id} 就业超过劳动力`);
  }

  assert.deepEqual(bandTotals(state), cohort);
  assert.equal(voucherTotal(state), before.vouchers);
  assert.equal(depositTotal(state), before.deposits);
  assert.deepEqual(inventoryTotals(state), before.inventory);
  assert.equal(jobTotal(state), before.jobs);
  assert.equal(validateCurrencyInvariant(state, BIG_CONTENT).valid, true);
  valid(state);

  const again = splitOversizedHouseholds(state, BIG_CONTENT);
  assert.equal(again.splits, 0);
  assert.equal(households(state).length, before.count + first.splits);
});

test("商人岗位与店铺主人留在原户", () => {
  const state = simulation.createInitialState({ seed: 7003 });
  addBuilding(state, "bank-split", "bank");
  const street = addBuilding(state, "street-split", "commercial_street");
  // 开店需要空闲劳动力，挑一户还有闲人的家庭。
  const owner = households(state).find(household => householdIdleWorkers(household) > 0 && householdWorkingAge(household) >= 2);
  grantResidentVouchers(state, 300000, CONTENT, owner.id);
  const opened = simulation.openResidentShop(state, street, "general", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  const merchantKey = `shop:${shop.id}:merchant`;
  assert.equal(shop.ownerHouseholdId, owner.id);
  assert.equal(owner.jobs[merchantKey], 1);

  growTo(state, owner, { children: 2, workers: 6, elders: 2 });
  assert.ok(householdPopulation(owner) > MAX);
  const result = splitOversizedHouseholds(state, CONTENT);
  assert.ok(result.splits > 0);

  assert.equal(shop.ownerHouseholdId, owner.id);
  assert.equal(owner.jobs[merchantKey], 1);
  assert.ok(owner.shopIds.includes(shop.id));
  for (const household of households(state)) {
    if (household.id !== owner.id) assert.equal(household.jobs[merchantKey], undefined, `${household.id} 不应拿到商人岗位`);
  }
  assert.ok(householdPopulation(owner) <= MAX);
  valid(state);
});

test("股票与经营权留在原户，不随人搬去新户", () => {
  const state = simulation.createInitialState({ seed: 7004 });
  const owner = households(state).find(household => householdWorkingAge(household) >= 2);
  owner.shares = { "company-test": 120 };
  owner.operatingRights = [{ buildingId: "building-test", level: 1 }];
  growTo(state, owner, { children: 2, workers: 6, elders: 2 });
  const result = splitOversizedHouseholds(state, CONTENT);
  assert.ok(result.splits > 0);

  assert.deepEqual(owner.shares, { "company-test": 120 });
  assert.deepEqual(owner.operatingRights, [{ buildingId: "building-test", level: 1 }]);
  for (const household of households(state)) {
    if (household.id === owner.id) continue;
    assert.deepEqual(household.shares, {});
    assert.deepEqual(household.operatingRights, []);
  }
  valid(state);
});

test("劳动力只有 1 人的大户不拆", () => {
  const state = simulation.createInitialState({ seed: 7005 });
  const lonely = households(state).find(household => householdWorkingAge(household) >= 1);
  lonely.jobs = {};
  setBands(state, lonely, { children: 6, workers: 1, elders: 3 });
  assert.equal(householdWorkingAge(lonely), 1);
  assert.equal(householdPopulation(lonely), 10);
  const beforeCount = households(state).length;
  const result = splitOversizedHouseholds(state, CONTENT);
  assert.equal(result.splits, 0);
  assert.equal(households(state).length, beforeCount);
  assert.equal(householdPopulation(lonely), 10);
  valid(state);
});

test("读档：250 户大户局面序列化后读回，每户不超过 8 人并写入读档报告", () => {
  const state = bigSimulation.createInitialState({ seed: 7006 });
  const raw = JSON.parse(JSON.stringify(state));
  // migrateSave 用默认 CONTENT（5 人一户），读档后应分到每户不超过 8 人。
  const loaded = migrateSave(raw, CONTENT);
  for (const household of householdList(loaded)) {
    assert.ok(householdPopulation(household) <= MAX, `${household.id} 仍有 ${householdPopulation(household)} 人`);
  }
  assert.ok(loaded._loadReport.households.some(line => /分家/.test(line)));
  valid(loaded);
});

test("年终推进：超过 8 人的户被分家，事件里有“分了家”", () => {
  const state = simulation.createInitialState({ seed: 7007 });
  const owner = households(state).find(household => householdWorkingAge(household) >= 2);
  growTo(state, owner, { children: 4, workers: 8, elders: 3 });
  // 留足余量：年终死亡、出生后仍远超 8 人，分家一定发生。
  assert.ok(householdPopulation(owner) >= 12);
  const countBefore = households(state).length;
  state.day = CONTENT.rules.daysPerYear - 1;
  simulation.advanceDay(state);
  assert.ok(households(state).length > countBefore, "年终应新增户");
  for (const household of households(state)) {
    assert.ok(householdPopulation(household) <= MAX, `${household.id} 年终后仍超过 ${MAX} 人`);
  }
  assert.ok(state.events.some(event => /分了家/.test(event.text)), "应有分家事件");
  valid(state);
});
