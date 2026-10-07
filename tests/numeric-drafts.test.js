import test from "node:test";
import assert from "node:assert/strict";
import { jobCount } from "../src/systems/households.js";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { loadState, saveState } from "../src/persistence/storage.js";
import { SimulationClock } from "../src/ui/simulation-clock.js";
import {
  parseNumericDraft,
  renderNumericInput,
  shouldDeferNumericPanelRender
} from "../src/ui/numeric-drafts.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
}

test("numeric drafts accept complete decimals, preserve intermediate text, and explain invalid submissions", () => {
  assert.deepEqual(parseNumericDraft("12.5", { label: "日薪", minimum: 0 }), { ok: true, value: 12.5 });
  assert.deepEqual(parseNumericDraft("0,75", { label: "失业金", minimum: 0 }), { ok: true, value: 0.75 });
  assert.match(parseNumericDraft("", { label: "售价" }).reason, /请输入售价/);
  assert.match(parseNumericDraft(".", { label: "售价" }).reason, /格式不正确/);
  assert.match(parseNumericDraft("1.5", { label: "人数", integer: true }).reason, /必须是整数/);
  assert.match(parseNumericDraft("0", { label: "售价", positive: true }).reason, /大于0/);
  assert.match(parseNumericDraft("101", { label: "日薪", maximum: 100 }).reason, /不能超过100/);
});

test("numeric fields use text drafts, explicit confirmation, and mobile decimal/integer keyboards", () => {
  const view = { numericDrafts: { "bread-price": { value: "2.", error: "" } } };
  const decimalField = renderNumericInput(view, {
    key: "bread-price", kind: "bread-price", target: "bread", value: 2,
    label: "面包售价", minimum: 0, positive: true
  });
  assert.match(decimalField, /type="text"/);
  assert.match(decimalField, /inputmode="decimal"/);
  assert.match(decimalField, /enterkeyhint="done"/);
  assert.match(decimalField, /value="2\."/);
  assert.match(decimalField, /data-draft-commit="bread-price"/);
  const workers = renderNumericInput({}, {
    key: "workers:mill-01::millers", kind: "employment", target: "mill-01::millers",
    value: 3, label: "磨坊工人数", integer: true, minimum: 0, maximum: 12
  });
  assert.match(workers, /inputmode="numeric"/);
});

test("a focused numeric field defers panel reconstruction while 16x simulation advances", () => {
  let value = "1.";
  const input = {
    matches: selector => selector === "[data-draft-key]",
    get value() { return value; }
  };
  const panel = { contains: element => element === input };
  const game = simulation.createInitialState();
  const clock = new SimulationClock(CONTENT);
  clock.setSpeed(16);
  const before = game.day;
  const advanced = clock.advanceFrame(1, () => simulation.advanceDay(game));
  assert.ok(advanced > 0, "16x speed should advance the simulation clock");
  assert.notEqual(game.day, before);
  assert.equal(shouldDeferNumericPanelRender(panel, input), true);
  assert.equal(input.value, "1.", "simulation ticks must not replace or normalize the active draft");
  value = "";
  assert.equal(input.value, "", "deleting the draft must remain possible before submission");
});

test("submitted employment, wage, price, and policy settings survive save and reload", () => {
  const state = simulation.createInitialState();
  assert.equal(simulation.setEmployment(state, "farmers", 390).ok, true);
  assert.equal(simulation.setWageRate(state, "millers", 12.5).ok, true);
  assert.equal(simulation.setBreadPrice(state, 2.75).ok, true);
  assert.equal(simulation.setUnemploymentPolicy(state, { dailyPerWorkerJin: 0.75 }).ok, true);

  const storage = memoryStorage();
  saveState(storage, state, CONTENT);
  const restored = loadState(storage, CONTENT).state;
  assert.equal(jobCount(restored, "farmers"), 390);
  assert.equal(restored.employment.wageRates.millers, 12.5);
  assert.equal(restored.market.breadPriceWheatPerJin, 2.75);
  assert.equal(restored.policy.unemploymentBenefit.dailyPerWorkerJin, 0.75);
});
