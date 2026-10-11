import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { splitOversizedHouseholds } from "../src/systems/household-split.js";
import { householdList, householdPopulation, householdWorkingAge, jobTenureDays, setHouseholdJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { grantResidentVouchers } from "./helpers-v16.js";

const MAX = CONTENT.rules.householdSplitMaxPeople;

function valid(state) {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, check.errors.join("；"));
}

function setBands(state, household, bands) {
  const ranges = { children: [0, 17], workers: [18, 64], elders: [65, 200] };
  for (const band of ["children", "workers", "elders"]) {
    const delta = (bands[band] || 0) - household.ageBands[band];
    if (delta > 0) {
      const [low, high] = ranges[band];
      const cohort = state.cohorts.find(row => row.age >= low && row.age <= high);
      cohort.m += delta;
      household.ageBands[band] += delta;
    } else if (delta < 0) {
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
    }
  }
  syncResidentAggregates(state, CONTENT);
}

function addBuilding(state, id, typeId) {
  const used = new Set(state.buildings.map(row => row.plotId));
  const plot = state.plots.find(row => !row.feature && !used.has(row.id));
  assert.ok(plot, "需要空地");
  state.buildings.push({
    id, typeId, level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 }
  });
  return id;
}

// 一户 10 人（7 孩子、3 劳动力）：分家后原户剩 1 名劳动力、新户 2 名。
function tenHouseholdState(seed) {
  const state = simulation.createInitialState({ seed });
  const owner = householdList(state).find(household => household.id !== "household-1") || householdList(state)[0];
  owner.jobs = {};
  owner.jobSince = {};
  setBands(state, owner, { children: 7, workers: 3, elders: 0 });
  assert.equal(householdPopulation(owner), 10);
  assert.equal(householdWorkingAge(owner), 3);
  return { state, ownerId: owner.id };
}

test("分家：搬去新户的工人保留入职日，原户留下的人入职日也裁成对应人数", () => {
  const { state, ownerId } = tenHouseholdState(8101);
  const owner = state.households.byId[ownerId];
  owner.jobs = { "farmers": 3 };
  const now = (Math.max(1, state.year || 1) - 1) * CONTENT.rules.daysPerYear + (state.day || 0);
  owner.jobSince = { farmers: [now - 400, now - 100, now - 5] };

  const result = splitOversizedHouseholds(state, CONTENT, { recordEvents: false });
  assert.ok(result.splits > 0);
  valid(state);

  const kept = state.households.byId[ownerId];
  const movedRow = result.rows.find(row => row.from === ownerId);
  assert.ok(movedRow, "原户应分出新户");
  const moved = state.households.byId[movedRow.to];
  assert.equal(kept.jobs.farmers + moved.jobs.farmers, 3, "岗位总数守恒");
  assert.equal(kept.jobs.farmers, householdWorkingAge(kept), "原户按劳动力留岗");
  assert.equal(kept.jobSince.farmers.length, kept.jobs.farmers, "原户入职日与人数一致");
  assert.equal(moved.jobSince.farmers.length, moved.jobs.farmers, "新户入职日与人数一致");

  // 原户留最早入职的人，搬走的是最近入职的人（入职 5 天、100 天）。
  assert.deepEqual(jobTenureDays(state, kept, "farmers"), [400]);
  assert.deepEqual(jobTenureDays(state, moved, "farmers").slice().sort((a, b) => a - b), [5, 100]);
});

test("分家：刚入职的工人搬去新户后仍是刚入职（不会被当成入职最久、可立即辞退）", () => {
  const { state, ownerId } = tenHouseholdState(8102);
  const owner = state.households.byId[ownerId];
  owner.jobs = { "farmers": 3 };
  const now = (Math.max(1, state.year || 1) - 1) * CONTENT.rules.daysPerYear + (state.day || 0);
  owner.jobSince = { farmers: [now, now, now] };
  const result = splitOversizedHouseholds(state, CONTENT, { recordEvents: false });
  assert.ok(result.splits > 0);
  valid(state);
  const movedRow = result.rows.find(row => row.from === ownerId);
  const moved = state.households.byId[movedRow.to];
  const tenure = jobTenureDays(state, moved, "farmers");
  assert.equal(tenure.length, moved.jobs.farmers);
  assert.ok(tenure.every(days => days === 0), "新户的工人应仍是今日入职，不显示为入职很久");
  assert.ok(tenure.every(days => days < 30), "新户的工人不满 30 天，不能辞退");
});

test("分家：商人岗位超过原户劳动力时，整店交给新户，店铺仍营业、店员不遣散", () => {
  const { state, ownerId } = tenHouseholdState(8103);
  const owner = state.households.byId[ownerId];
  const street = addBuilding(state, "street-split-jobs", "commercial_street");
  grantResidentVouchers(state, 300000, CONTENT, owner.id);
  const opened = simulation.openResidentShop(state, street, "general", owner.id);
  assert.equal(opened.ok, true, opened.reason);
  const shop = state.shops[opened.shopId];
  const merchantKey = `shop:${shop.id}:merchant`;
  const clerkKey = `shop:${shop.id}:clerk`;
  // 原户 3 名劳动力：1 名商人 + 1 名商人（共 2 名商人岗位）+ 1 名店员。
  const added = setHouseholdJobCount(state, ownerId, merchantKey, 2, CONTENT);
  assert.equal(added.ok, true, added.reason);
  const hiredClerk = setHouseholdJobCount(state, ownerId, clerkKey, 1, CONTENT);
  assert.equal(hiredClerk.ok, true, hiredClerk.reason);
  valid(state);
  const statusBefore = shop.status;

  const result = splitOversizedHouseholds(state, CONTENT, { recordEvents: false });
  assert.ok(result.splits > 0);
  valid(state);

  const kept = state.households.byId[ownerId];
  const movedRow = result.rows.find(row => row.from === ownerId);
  const moved = state.households.byId[movedRow.to];
  assert.ok(kept.jobs[merchantKey] === undefined || kept.jobs[merchantKey] <= householdWorkingAge(kept), "商人岗位不得超过原户劳动力");
  assert.equal(shop.ownerHouseholdId, moved.id, "店铺整体交给有劳动力的新户");
  assert.equal(moved.jobs[merchantKey], 2, "商人岗位随店铺去新户");
  assert.ok(!kept.shopIds?.includes(shop.id));
  assert.ok(moved.shopIds.includes(shop.id));
  assert.equal(shop.status, statusBefore, "店铺仍营业，没有暂停");
  assert.equal(state.shops[shop.id].status, "open");
  // 店员没有被释放：店员岗位数不变（原户留着）。
  const clerks = Object.values(state.households.byId).reduce((total, household) => total + (household.jobs?.[clerkKey] || 0), 0);
  assert.equal(clerks, 1, "店员不得被遣散");
});
