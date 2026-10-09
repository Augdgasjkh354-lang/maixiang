import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT, simulation, validateState } from "../src/engine.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { selectSeason } from "../src/selectors/dashboard.js";

test("日历：一年 12 个月 × 30 天，季节与日期显示正确", () => {
  assert.equal(CONTENT.rules.daysPerYear, 360);
  assert.equal(CONTENT.rules.monthDays, 30);
  assert.equal(CONTENT.rules.growingDays, 270);

  const first = selectSeason(0, CONTENT.rules.monthDays);
  assert.equal(first.month, 1);
  assert.equal(first.dayOfMonth, 1);
  assert.equal(first.key, "spring");
  assert.equal(first.name, "春");

  const lastAutumn = selectSeason(269, CONTENT.rules.monthDays);
  assert.equal(lastAutumn.month, 9);
  assert.equal(lastAutumn.dayOfMonth, 30);
  assert.equal(lastAutumn.key, "autumn");
  assert.equal(lastAutumn.name, "秋");

  const harvest = selectSeason(270, CONTENT.rules.monthDays);
  assert.equal(harvest.month, 10);
  assert.equal(harvest.dayOfMonth, 1);
  assert.equal(harvest.key, "winter");
  assert.equal(harvest.name, "冬");

  const lastDay = selectSeason(359, CONTENT.rules.monthDays);
  assert.equal(lastDay.month, 12);
  assert.equal(lastDay.dayOfMonth, 30);
  assert.equal(lastDay.key, "winter");
});

test("旧存档（一年 365 天）读回后日期按比例换算到 360 天制，秋收日对应 270", () => {
  const fresh = simulation.createInitialState();
  const raw = JSON.parse(JSON.stringify(fresh));
  delete raw.calendarDaysPerYear;
  raw.day = 274;
  const migrated = migrateSave(raw, CONTENT);
  assert.equal(migrated.day, 270);
  assert.equal(migrated.calendarDaysPerYear, 360);
  assert.equal(validateState(migrated, CONTENT).valid, true);
});
