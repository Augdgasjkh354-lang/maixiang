import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/content/index.js";
import { simulation } from "../src/engine.js";
import { settleHousingRent } from "../src/systems/housing.js";
import { publicHousingRentPerResidentDayJin } from "../src/selectors/housing.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { renderSite } from "../src/ui/panel-site.js";

const SCALE = CONTENT.precision.currencyUnitsPerVoucher || CONTENT.precision.inventoryUnitsPerJin;

function validOf(state) {
  return simulation.validateState(state);
}

function freshState(seed) {
  const state = simulation.createInitialState({ seed });
  const household = Object.values(state.households.byId)[0];
  return { state, household };
}

// 直接构造“当日入住公租房”的快照，结算只读 householdHousing 与 rentDuePeople。
function housingFor(household, people) {
  return { rentDuePeople: people, householdHousing: [{ householdId: household.id, rentalPeople: people }] };
}

function settle(state, household, people) {
  return settleHousingRent(state, housingFor(household, people), CONTENT);
}

test("默认 1 斤：未设置或旧档无字段时，收取额与改动前一致（每人每日 1 斤等值）", () => {
  const { state, household } = freshState(990101);
  assert.equal(state.policy.publicHousingRentPerResidentDayJin, CONTENT.rules.rentPerResidentDayWheatJin);
  assert.equal(publicHousingRentPerResidentDayJin(state, CONTENT), 1);
  const day = settle(state, household, 7);
  assert.equal(day.dueWheatJin, 7 * 1);
  assert.equal(day.collectedWheatJin, 7 * 1);
  assert.equal(day.waivedWheatJin, 0);

  // 旧档：政策里没有该字段，缺省仍是 1 斤。
  const legacy = freshState(990102);
  delete legacy.state.policy.publicHousingRentPerResidentDayJin;
  assert.equal(publicHousingRentPerResidentDayJin(legacy.state, CONTENT), 1);
  const legacyDay = settle(legacy.state, legacy.household, 7);
  assert.equal(legacyDay.dueWheatJin, day.dueWheatJin);
  assert.equal(legacyDay.collectedWheatJin, day.collectedWheatJin);
});

test("设为 0 即免租：收取 0、不报错、validateState 通过", () => {
  const { state, household } = freshState(990103);
  assert.equal(simulation.setPublicHousingRent(state, 0).ok, true);
  assert.equal(state.policy.publicHousingRentPerResidentDayJin, 0);
  assert.equal(publicHousingRentPerResidentDayJin(state, CONTENT), 0, "0 不得回落到缺省 1");
  const day = settle(state, household, 9);
  assert.equal(day.dueWheatJin, 0);
  assert.equal(day.collectedWheatJin, 0);
  assert.equal(day.waivedWheatJin, 0);
  assert.equal(validOf(state).valid, true, validOf(state).errors.join("；"));
});

test("设为 3.5：按比例收取（入住人数 × 3.5 斤）", () => {
  const { state, household } = freshState(990104);
  assert.equal(simulation.setPublicHousingRent(state, 3.5).ok, true);
  const day = settle(state, household, 4);
  assert.equal(day.dueWheatJin, 4 * 3.5);
  assert.equal(day.collectedWheatJin, 4 * 3.5);
  assert.equal(Math.round(state.fiscal.lastRentDay.dueVoucher * SCALE), Math.round(4 * 3.5 * SCALE));
  assert.equal(validOf(state).valid, true, validOf(state).errors.join("；"));
});

test("非法值被拒绝（-1、21、NaN），原值保持不变，并给出规则上下限说明", () => {
  const { state } = freshState(990105);
  assert.equal(simulation.setPublicHousingRent(state, 2.5).ok, true);
  for (const bad of [-1, 21, NaN, "abc", ""]) {
    const result = simulation.setPublicHousingRent(state, bad);
    assert.equal(result.ok, false, `应拒绝 ${String(bad)}`);
    assert.equal(result.reason, "公租房日租须为0—20斤");
  }
  assert.equal(state.policy.publicHousingRentPerResidentDayJin, 2.5, "被拒绝的设置不得改动租金");
  assert.equal(simulation.setPublicHousingRent(state, 20).ok, true, "上限 20 本身合法");
  assert.equal(simulation.setPublicHousingRent(state, 0).ok, true, "下限 0 本身合法");
});

test("一位小数：设为 3.456 存为 3.5", () => {
  const { state } = freshState(990106);
  assert.equal(simulation.setPublicHousingRent(state, 3.456).value, 3.5);
  assert.equal(state.policy.publicHousingRentPerResidentDayJin, 3.5);
});

test("validateState 拦截非法租金（NaN、超上限、负数、无穷）", () => {
  for (const bad of [NaN, 21, -1, Infinity]) {
    const { state } = freshState(990107);
    state.policy.publicHousingRentPerResidentDayJin = bad;
    assert.equal(validOf(state).valid, false, `应判定 ${String(bad)} 无效`);
  }
});

test("存档往返保留租金设置（JSON 序列化 + migrateSave 读回）", () => {
  const { state } = freshState(990108);
  assert.equal(simulation.setPublicHousingRent(state, 6.5).ok, true);
  const loaded = migrateSave(JSON.parse(JSON.stringify(state)), CONTENT);
  assert.equal(loaded.policy.publicHousingRentPerResidentDayJin, 6.5);
  assert.equal(publicHousingRentPerResidentDayJin(loaded, CONTENT), 6.5);
  assert.equal(validOf(loaded).valid, true, validOf(loaded).errors.join("；"));
});

test("选择器：日租读同一入口，且只读不写 state", () => {
  const { state } = freshState(990109);
  simulation.setPublicHousingRent(state, 2);
  const before = JSON.stringify(state);
  const view = simulation.selectDashboard(state, { panel: "policy" });
  assert.equal(view.housing.rentPerResidentDayJin ?? view.housing.rentPerResidentDayWheatJin, 2);
  assert.equal(JSON.stringify(state), before, "选择器不得写 state");
});

test("公租房建筑面板：渲染日租输入框（data-draft 绑定）与预估收入", () => {
  const state = simulation.createInitialState({ seed: 990110 });
  const plot = state.plots.find(row => !row.feature);
  state.buildings.push({ id: "housing-rent-ui", typeId: "public_housing", level: 1, ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: 1, day: 1 } });
  simulation.setPublicHousingRent(state, 3.5);
  const view = simulation.selectDashboard(state, { panel: "site", site: "building:housing-rent-ui" });
  const html = renderSite(view);
  assert.match(html, /data-draft-kind="public-housing-rent"/);
  assert.match(html, /data-draft-key="public-housing-rent"/);
  assert.match(html, /公租房日租（券\/人·日）/);
  assert.match(html, /预估每日租金收入/);
  assert.match(html, /value="3\.5"/);
});
