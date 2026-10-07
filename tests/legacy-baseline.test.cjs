const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Legacy = require("./fixtures/engine-v1.cjs");

const baseline = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/legacy-baseline.json"), "utf8")
);

test("deployed v1 engine baseline remains reproducible", () => {
  assert.deepEqual(Legacy.verifyCore(), baseline.verifyCore);
  const state = Legacy.createNewState();
  const initial = {
    population: Legacy.peopleStats(state),
    jobs: { ...state.jobs, employed: Legacy.employed(state) },
    resident: Legacy.accountEq(state.stocks.residents),
    town: Legacy.accountEq(state.stocks.town)
  };
  assert.deepEqual(initial, baseline.initial);

  let harvest = null;
  for (let day = 0; day < 274; day += 1) {
    const result = Legacy.tickDay(state);
    if (result.harvest) harvest = result.harvest;
  }
  assert.deepEqual({
    year: state.year,
    day: state.day,
    resident: Legacy.accountEq(state.stocks.residents),
    town: Legacy.accountEq(state.stocks.town),
    harvest
  }, baseline.afterHarvest);
});

test("v1 one-year demographic and building replay matches recorded behavior", () => {
  const annual = Legacy.createNewState();
  for (let day = 0; day < 365; day += 1) Legacy.tickDay(annual);
  assert.deepEqual({
    year: annual.year,
    day: annual.day,
    population: Legacy.peopleStats(annual),
    totalEq: Legacy.allEq(annual),
    residentEq: Legacy.accountEq(annual.stocks.residents),
    townEq: Legacy.accountEq(annual.stocks.town),
    seed: annual.seed
  }, baseline.afterYear);

  const buildingState = Legacy.createNewState();
  const started = Legacy.startBuild(buildingState, "mill", "east");
  for (let day = 0; day < 40; day += 1) Legacy.tickDay(buildingState);
  assert.deepEqual({
    started,
    year: buildingState.year,
    day: buildingState.day,
    buildings: buildingState.buildings,
    jobs: buildingState.jobs,
    project: buildingState.project,
    residentEq: Legacy.accountEq(buildingState.stocks.residents),
    townEq: Legacy.accountEq(buildingState.stocks.town)
  }, baseline.build);
});
