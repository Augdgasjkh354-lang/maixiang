import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { BUILD_ID } from "../src/content/version.js";
import { processPrivateBuilding } from "../src/systems/private-industry.js";
import { privateJobKeyForBuilding, selectJobRows } from "../src/selectors/labor.js";
import { setJobCount, syncResidentAggregates } from "../src/systems/households.js";
import { payDailyWages } from "../src/systems/payroll.js";
import { grantResidentVouchers } from "./helpers-v16.js";
import { shouldCommitNumericDraftOnChange } from "../src/ui/numeric-drafts.js";
import { drawBuilding } from "../src/ui/terrain-art.js";

const INV = CONTENT.precision.inventoryUnitsPerJin;

function addBuilding(state, typeId, id, { townLevels = 1, privateLevels = 0, ownerId = null } = {}) {
  const definition = CONTENT.buildings[typeId];
  const required = definition.requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const level = Math.max(1, townLevels + privateLevels);
  const building = {
    id, typeId, level,
    ownership: { townLevels, privateLevels, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 }
  };
  if (ownerId) building.privateOwners = [ownerId];
  state.buildings.push(building);
  return building;
}

function households(state) {
  return Object.values(state.households.byId).sort((a, b) => a.id.localeCompare(b.id));
}

test("0.1.10-r03 民营磨坊会从镇库采购小麦，同时保留业主家庭口粮储备", () => {
  const state = simulation.createInitialState({ seed: 110301 });
  const owner = households(state)[0];
  const mill = addBuilding(state, "mill", "private-mill", { townLevels: 0, privateLevels: 1, ownerId: owner.id });
  owner.inventory.wheat = 0;
  syncResidentAggregates(state, CONTENT);
  assert.equal(grantResidentVouchers(state, 10000, CONTENT, owner.id).ok, true);
  setJobCount(state, privateJobKeyForBuilding(mill.id, "millers"), 1, CONTENT, { type: "private", id: mill.id });

  const ownerVoucherBefore = owner.voucherUnits;
  const townWheatBefore = state.accounts.town.wheat;
  const result = processPrivateBuilding(state, mill, CONTENT);

  assert.equal(result.status, "ready", result.reason);
  assert.equal(result.batches, 4);
  assert.ok(result.inputPurchases.length > 0);
  assert.equal(result.inputPurchases[0].itemId, "wheat");
  assert.equal(result.inputPurchases[0].sellerRows[0].seller, "town", "生产原料应优先从镇库供应");
  assert.ok(owner.voucherUnits < ownerVoucherBefore, "业主应真实支付原料货款");
  assert.ok(state.accounts.town.wheat < townWheatBefore, "镇库应真实出库小麦");
  assert.ok(owner.inventory.flour > 0, "采购后应实际完成磨粉");
  assert.ok(owner.inventory.wheat >= 300 * INV, "生产后仍须保留家庭口粮储备，不能把家中口粮烧掉");
  assert.equal(simulation.validateState(state).valid, true);
});

test("0.1.10-r03 私营面包房会购买上游面粉，不要求老板家里预先囤面粉", () => {
  const state = simulation.createInitialState({ seed: 110302 });
  const [millOwner, bakeryOwner] = households(state);
  const mill = addBuilding(state, "mill", "upstream-mill", { townLevels: 0, privateLevels: 1, ownerId: millOwner.id });
  const bakery = addBuilding(state, "bakery", "private-bakery", { townLevels: 0, privateLevels: 1, ownerId: bakeryOwner.id });
  millOwner.inventory.wheat = 0;
  bakeryOwner.inventory.flour = 0;
  syncResidentAggregates(state, CONTENT);
  assert.equal(grantResidentVouchers(state, 20000, CONTENT, millOwner.id).ok, true);
  assert.equal(grantResidentVouchers(state, 20000, CONTENT, bakeryOwner.id).ok, true);
  setJobCount(state, privateJobKeyForBuilding(mill.id, "millers"), 2, CONTENT, { type: "private", id: mill.id });
  setJobCount(state, privateJobKeyForBuilding(bakery.id, "bakers"), 1, CONTENT, { type: "private", id: bakery.id });

  const millResult = processPrivateBuilding(state, mill, CONTENT);
  assert.equal(millResult.status, "ready", millResult.reason);
  const bakeryResult = processPrivateBuilding(state, bakery, CONTENT);

  assert.equal(bakeryResult.status, "ready", bakeryResult.reason);
  assert.equal(bakeryResult.batches, 16);
  const flourPurchase = bakeryResult.inputPurchases.find(row => row.itemId === "flour");
  assert.ok(flourPurchase);
  assert.equal(flourPurchase.sellerRows[0].seller, "town", "面粉税收/镇库库存优先进入原料供应");
  assert.ok(flourPurchase.sellerRows.some(row => row.seller.startsWith("household:")), "镇库不足时应继续购买其他民营业主的面粉");
  assert.ok(bakeryOwner.inventory.bread > 0, "面包房应实际产出面包");
  assert.equal(simulation.validateState(state).valid, true);
});

test("0.1.10-r03 民营停工原因明确指出缺哪种原料", () => {
  const state = simulation.createInitialState({ seed: 110303 });
  const owner = households(state)[0];
  const bakery = addBuilding(state, "bakery", "dry-bakery", { townLevels: 0, privateLevels: 1, ownerId: owner.id });
  owner.inventory.flour = 0;
  syncResidentAggregates(state, CONTENT);
  assert.equal(grantResidentVouchers(state, 1000, CONTENT, owner.id).ok, true);
  setJobCount(state, privateJobKeyForBuilding(bakery.id, "bakers"), 1, CONTENT, { type: "private", id: bakery.id });

  const result = processPrivateBuilding(state, bakery, CONTENT);
  assert.equal(result.status, "no_materials");
  assert.match(result.reason, /缺面粉/);
  assert.match(result.reason, /市场/);
});

test("0.1.10-r03 完整日结中民营磨坊→面包房采购链能连续运转", () => {
  const state = simulation.createInitialState({ seed: 110305 });
  const [millOwner, bakeryOwner] = households(state);
  const mill = addBuilding(state, "mill", "daily-private-mill", { townLevels: 0, privateLevels: 1, ownerId: millOwner.id });
  const bakery = addBuilding(state, "bakery", "daily-private-bakery", { townLevels: 0, privateLevels: 1, ownerId: bakeryOwner.id });
  millOwner.inventory.wheat = 0;
  bakeryOwner.inventory.flour = 0;
  syncResidentAggregates(state, CONTENT);
  assert.equal(grantResidentVouchers(state, 30000, CONTENT, millOwner.id).ok, true);
  assert.equal(grantResidentVouchers(state, 30000, CONTENT, bakeryOwner.id).ok, true);
  state.policy.unemploymentBenefit.enabled = false;

  let millBatches = 0;
  let bakeryBatches = 0;
  let inputPurchases = 0;
  for (let day = 0; day < 3; day += 1) {
    const outcome = simulation.advanceDay(state);
    const millRow = outcome.privateProduction.find(row => row.buildingId === mill.id);
    const bakeryRow = outcome.privateProduction.find(row => row.buildingId === bakery.id);
    millBatches += millRow?.batches || 0;
    bakeryBatches += bakeryRow?.batches || 0;
    inputPurchases += (millRow?.inputPurchases?.length || 0) + (bakeryRow?.inputPurchases?.length || 0);
  }
  assert.ok(millBatches > 0, "完整日结中民营磨坊应能采购小麦并生产");
  assert.ok(bakeryBatches > 0, "完整日结中民营面包房应能采购面粉并生产");
  assert.ok(inputPurchases > 0, "原料采购必须真实经过市场支付路径");
  assert.equal(simulation.validateState(state).valid, true);
});

test("0.1.10-r03 银行、交易所和公租房岗位容量与实际工资一致，旧档缺工资字段也不付0薪", () => {
  const state = simulation.createInitialState({ seed: 110304 });
  const bank = addBuilding(state, "bank", "bank-1");
  const exchange = addBuilding(state, "stock_exchange", "exchange-1");
  const housing = addBuilding(state, "public_housing", "housing-1");

  delete state.employment.wageRates.bank_staff;
  delete state.employment.wageRates.exchange_staff;
  delete state.employment.wageRates.housing_managers;

  let labor = selectJobRows(state, CONTENT);
  const byRole = roleId => labor.rows.find(row => row.roleId === roleId);
  assert.equal(byRole("bank_staff").capacity, 8);
  assert.equal(byRole("exchange_staff").capacity, 8);
  assert.equal(byRole("housing_managers").capacity, 20);
  // 默认日薪 10→5 斤（8cf03ae）：旧档缺工资字段时按内容默认 5，而不是 0。
  assert.equal(byRole("bank_staff").wagePerWorkerDay, 5);
  assert.equal(byRole("exchange_staff").wagePerWorkerDay, 5);
  assert.equal(byRole("housing_managers").wagePerWorkerDay, 5);

  assert.equal(simulation.setEmployment(state, `${bank.id}::bank_staff`, 8).assigned, 8);
  assert.equal(simulation.setEmployment(state, `${exchange.id}::exchange_staff`, 8).assigned, 8);
  assert.equal(simulation.setEmployment(state, `${housing.id}::housing_managers`, 20).assigned, 20);
  labor = selectJobRows(state, CONTENT);
  const paid = payDailyWages(state, labor, CONTENT);
  const rows = Object.fromEntries(paid.workers.filter(row => ["bank_staff", "exchange_staff", "housing_managers"].includes(row.roleId)).map(row => [row.roleId, row]));
  assert.equal(rows.bank_staff.count, 8);
  assert.equal(rows.bank_staff.dailyRateVoucher, 5);
  assert.equal(rows.exchange_staff.count, 8);
  assert.equal(rows.exchange_staff.dailyRateVoucher, 5);
  assert.equal(rows.housing_managers.count, 20);
  assert.equal(rows.housing_managers.dailyRateVoucher, 5);
  assert.equal(rows.bank_staff.expectedVoucher + rows.exchange_staff.expectedVoucher + rows.housing_managers.expectedVoucher, 180);
});

test("0.1.10-r05 工资输入在手机 change/失焦时直接提交，构建号可识别", () => {
  // 基线清理：构建号跟随版本演进，不再硬编码旧值；只断言其为可识别的非空字符串。
  assert.ok(typeof BUILD_ID === "string" && BUILD_ID.length > 0, "构建号应为非空字符串");
  assert.equal(shouldCommitNumericDraftOnChange("company-wage"), true);
  assert.equal(shouldCommitNumericDraftOnChange("workers"), false);
  assert.equal(shouldCommitNumericDraftOnChange("bread-price"), false);
});

test("0.1.10-r03 银行、交易所、政务厅、警察局、商业街、面包房使用不同地图绘制签名", () => {
  function signature(type) {
    const calls = [];
    const gradient = { addColorStop: (...args) => calls.push(["gradient.addColorStop", ...args]) };
    const ctx = new Proxy({}, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args) => {
          calls.push([String(prop), ...args]);
          if (String(prop).startsWith("create") && String(prop).includes("Gradient")) return gradient;
          if (prop === "measureText") return { width: 0 };
          return undefined;
        };
      },
      set(target, prop, value) {
        calls.push([`set:${String(prop)}`, value]);
        target[prop] = value;
        return true;
      }
    });
    drawBuilding(ctx, 0, 0, 64, { type, level: 1, working: false }, 0);
    return JSON.stringify(calls);
  }
  const types = ["bank", "stock_exchange", "town_hall", "police_station", "commercial_street", "bakery"];
  const signatures = types.map(signature);
  assert.equal(new Set(signatures).size, types.length, "这些建筑不应继续落到同一套普通小屋造型");
});
