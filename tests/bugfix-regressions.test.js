import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { changeInventory, addInventory } from "../src/economy/inventory.js";
import { SimulationClock } from "../src/ui/simulation-clock.js";
import { populationStats } from "../src/selectors/labor.js";
import { isChoosingBuildPlot } from "../src/ui/navigation-state.js";
import { clearAllHouseholdVouchers } from "./helpers-monetary.js";

test("clock stops within the same frame when a simulation step pauses it", () => {
  const clock = new SimulationClock(CONTENT);
  clock.setSpeed(16);
  let steps = 0;
  const advanced = clock.advanceFrame(0.5, () => {
    steps += 1;
    clock.pause();
  });
  assert.equal(advanced, 1);
  assert.equal(steps, 1);
  assert.equal(clock.paused, true);
  assert.equal(clock.fractionalDays, 0);

  clock.resume();
  assert.equal(clock.advanceFrame(0.1, () => { steps += 1; }), 0,
    "resuming after an automatic pause must not replay queued whole days");
});

test("a shortage on the final day of a year survives year-end rollover", () => {
  const state = simulation.createInitialState({ seed: 20260925 });
  state.autoRelief = false;
  state.day = CONTENT.rules.daysPerYear - 1;
  changeInventory(
    state, "residents", "wheat", -state.accounts.residents.wheat,
    "test empty resident grain", "test_adjustment", CONTENT
  );
  // 开局即粮券：居民没粮也有券时会去镇库买粮，断粮要同时没钱。
  clearAllHouseholdVouchers(state);

  const result = simulation.advanceDay(state);
  assert.equal(state.year, 2);
  assert.equal(state.day, 0);
  assert.ok(result.shortageQeq > 0);
  assert.equal(state.shortageQeq, result.shortageQeq,
    "year-end bookkeeping must not erase the last day's active shortage");
});

test("events emitted before the daily increment use the visible calendar day", () => {
  const construction = simulation.createInitialState();
  addInventory(construction, "town", "wood", 600, "test stock", "test", CONTENT);
  simulation.advanceDays(construction, 40);
  assert.equal(construction.day, 40);
  const started = simulation.buildAt(construction, "mill", "east");
  assert.equal(started.ok, true);
  assert.equal(construction.events[0].day, 41,
    "an action taken while the UI shows day 41 must be recorded as day 41");

  const shortage = simulation.createInitialState();
  simulation.advanceDays(shortage, 2);
  shortage.autoRelief = false;
  changeInventory(
    shortage, "residents", "wheat", -shortage.accounts.residents.wheat,
    "test empty resident grain", "test_adjustment", CONTENT
  );
  clearAllHouseholdVouchers(shortage);
  simulation.advanceDay(shortage);
  const shortageEvent = shortage.events.find(event => event.text.includes("居民口粮短缺"));
  assert.equal(shortageEvent?.day, 3,
    "a shortage during the third simulated day must not be dated one day early");
});


test("married couple count is aggregated across age cohorts", () => {
  const state = simulation.createInitialState();
  state.cohorts = [
    { age: 20, m: 5, f: 3, marriedM: 5, marriedF: 3 },
    { age: 21, m: 3, f: 5, marriedM: 3, marriedF: 5 }
  ];
  const stats = populationStats(state);
  assert.equal(stats.marriedWomen, 8);
  assert.equal(stats.marriedCouples, 8,
    "spouses in different age cohorts must still count as married couples");
});


test("mobile build picking state is distinct from build preview state", () => {
  assert.equal(isChoosingBuildPlot({ activePanel: "build", buildType: "mill", previewPlotId: null }), true);
  assert.equal(isChoosingBuildPlot({ activePanel: "build", buildType: "mill", previewPlotId: "east" }), false,
    "after a plot is tapped the panel must be allowed to return for confirmation");
  assert.equal(isChoosingBuildPlot({ activePanel: "build", buildType: null, previewPlotId: null }), false);
});

test("[slow] fresh-game history starts on day 1 and harvest ledger matches harvest day", () => {
  const state = simulation.createInitialState({ seed: 20260925 });
  assert.equal(state.events[0].day, 1, "the first visible day must not be recorded as day 0");

  simulation.advanceDays(state, CONTENT.rules.growingDays);
  const harvestRows = state.ledger.filter(row => row.type === "harvest");
  assert.ok(harvestRows.length >= 2);
  assert.ok(harvestRows.every(row => row.day === CONTENT.rules.growingDays),
    "harvest ledger rows must use the same day as the harvest event");
  const harvestEvent = state.events.find(event => event.text.includes("麦收入仓"));
  assert.equal(harvestEvent?.day, CONTENT.rules.growingDays);
});

test("construction metadata uses the visible calendar day", () => {
  const state = simulation.createInitialState({ seed: 7 });
  addInventory(state, "town", "wood", 500, "test stock", "test", CONTENT);
  simulation.advanceDays(state, 40);
  const started = simulation.buildAt(state, "bakery", "east");
  assert.equal(started.ok, true);
  assert.equal(state.project.started.day, 41);

  simulation.setEmployment(state, "builders", 10);
  simulation.advanceDays(state, 40);
  const building = state.buildings.find(row => row.id === started.instanceId);
  assert.ok(building);
  assert.equal(building.completed.day, 80,
    "completion during the 80th visible day must be stored as day 80");
});

test("dismissed event bubble can be revealed again for a later event", async () => {
  const { createNavigationState } = await import("../src/ui/navigation-state.js");
  const nav = createNavigationState();
  nav.state.eventsExpanded = true;
  nav.dismissEvents();
  assert.equal(nav.state.eventsDismissed, true);
  assert.equal(nav.state.eventsExpanded, false);
  nav.revealEvents();
  assert.equal(nav.state.eventsDismissed, false);
});

test("settings error text is HTML-escaped", async () => {
  const { renderSettings } = await import("../src/ui/panel-settings.js");
  const html = renderSettings(null, '<img src=x onerror="boom">');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;boom&quot;&gt;/);
});
