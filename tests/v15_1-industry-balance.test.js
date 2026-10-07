import test from "node:test";
import assert from "node:assert/strict";
import { jobCount, setJobCount } from "../src/systems/households.js";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { theoreticalFullSaleProfitPerWorker, currentUnitPrice } from "../src/economy/prices.js";
import { buyInputForCompany } from "../src/systems/companies.js";
import { previewTownMaterialProcurement } from "../src/systems/public-procurement.js";
import { migrateSave } from "../src/persistence/migrations.js";
import { setResidentInventoryJin } from "./helpers-v16.js";
import { legacyVoucherState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function addBuilding(state, typeId, id, level = 1, townLevels = level, privateLevels = 0) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = state.plots.find(row => (required ? row.feature === required : !row.feature) &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot, `missing plot for ${typeId}`);
  const building = {
    id, typeId, level,
    ownership: { townLevels, privateLevels, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 }
  };
  state.buildings.push(building);
  const job = CONTENT.buildings[typeId].jobs[0];
  return building;
}

function assertFinitePreview(preview) {
  for (const key of ["maximumPriceWheatJin", "dailyNetWheatJin", "estimatedAnnualReferenceReturn", "demandFactor"]) {
    assert.equal(Number.isFinite(preview[key]), true, `${key} must be finite`);
  }
}

test("新版默认价下四行业满产满销人均日利润符合校验值", () => {
  const state = legacyVoucherState();
  // 0.2.3 流通改革：批发市场做成市商后默认挂价改为面包 2.6 / 木材 16 / 盐 12，
  // 四行业人均日利润校验值随之上调（小麦/面粉价不变）。
  // 默认日薪 10→5 斤（8cf03ae）：四个岗位成本各降 5 斤/工日 → 人均日利润各 +5。
  const expected = { mill: 18.68, bakery: 75.64, lumberyard: 9.4, saltworks: 49 };
  assert.deepEqual(state.market.pricesVoucherPerUnit, { wheat: 1, flour: 1.8, bread: 2, wood: 15, salt: 10 });
  for (const [typeId, profit] of Object.entries(expected)) {
    const row = theoreticalFullSaleProfitPerWorker(state, typeId, CONTENT);
    assert.ok(row);
    assert.ok(Math.abs(row.profitVoucher - profit) < 1e-9, `${typeId}: ${row.profitVoucher}`);
  }
});

test("面粉调价后企业真实采购与磨坊经营权估值读取同一当前价", () => {
  const state = legacyVoucherState();
  const bakery = addBuilding(state, "bakery", "price-bakery");
  const mill = addBuilding(state, "mill", "price-mill");
  assert.equal(simulation.issueGrainVouchers(state, "town", 5000).ok, true);
  const listed = simulation.listCompany(state, bakery.id, { levels: 1, operatingCapitalVoucher: 1000, initialMaterialQuantity: 0 });
  assert.equal(listed.ok, true, listed.reason);
  const company = state.companies[listed.companyId];
  setJobCount(state, `${bakery.id}::bakers::listed`, 1, CONTENT);
  // 基线清理：0.2.3 起公司采购原料走批发市场（buyWholesaleForOwner），镇库库存不再直接可买。
  // 所以先建成批发市场并把面粉放进市场库存。
  const wholesalePlot = state.plots.find(row => !row.feature &&
    !state.buildings.some(building => building.plotId === row.id));
  assert.ok(wholesalePlot, "需要一块空地建批发市场");
  state.buildings.push({
    id: "wm-price", typeId: "wholesale_market", level: 1,
    ownership: { townLevels: 1, privateLevels: 0, listedLevels: 0 },
    plotId: wholesalePlot.id, x: wholesalePlot.x, y: wholesalePlot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 }
  });
  const market = state.wholesaleMarket;
  market.inventory.flour = 10 * I;
  market.inventoryCostVoucherUnits.flour = 0;

  assert.equal(simulation.configureIntermediatePrice(state, "flour", 2.2).ok, true);
  const purchase = buyInputForCompany(state, company, "flour", 5 * I, CONTENT);
  assert.equal(purchase.boughtUnits, 5 * I);
  assert.equal(purchase.paidVoucherUnits, 11 * V);
  const preview = simulation.selectOperatingRightPreview(state, mill.id);
  assert.equal(preview.outputPriceVoucherPerUnit, 2.2);
  assert.equal(preview.inputPricesVoucherPerUnit.wheat, 1);
  assert.equal(currentUnitPrice(state, "flour", CONTENT), 2.2);
});

test("木材无需求、有需求、库存不足和资金不足均为有限估值并给出明确原因", () => {
  const state = legacyVoucherState();
  const lumber = addBuilding(state, "lumberyard", "wood-value");
  let preview = simulation.selectOperatingRightPreview(state, lumber.id);
  assertFinitePreview(preview);
  assert.equal(preview.maximumPriceWheatJin, 0);
  assert.match(preview.demandReason, /暂无采购需求/);
  assert.match(preview.reason, /预期收益缺乏吸引力/);

  assert.equal(simulation.issueGrainVouchers(state, "town", 40000).ok, true);
  assert.equal(simulation.setPublicProcurementIntent(state, { kind: "build", typeId: "public_housing" }).ok, true);
  preview = simulation.selectOperatingRightPreview(state, lumber.id);
  assertFinitePreview(preview);
  // 0.2.3 流通改革：批发市场做市商默认木材售价为 16。
  assert.equal(preview.outputPriceVoucherPerUnit, 16);
  assert.ok(preview.maximumPriceWheatJin > 0);
  assert.match(preview.demandReason, /公共建设|公租住宅区建设|采购/);

  setResidentInventoryJin(state, "wood", 500, CONTENT);
  let procurement = previewTownMaterialProcurement(state, "wood", 2000 * I, CONTENT);
  assert.equal(procurement.purchasableUnits, 500 * I);
  assert.match(procurement.reason, /库存不足/);
  assert.equal(Number.isFinite(procurement.costVoucherUnits), true);

  setResidentInventoryJin(state, "wood", 2000, CONTENT);
  state.currency.balances.town = 0;
  state.currency.issuedUnits = state.currency.balances.residents + Object.values(state.companies || {}).reduce((sum, c) => sum + (c.cashVoucherUnits || 0), 0);
  state.currency.reserveWheatUnits = state.currency.issuedUnits;
  procurement = previewTownMaterialProcurement(state, "wood", 2000 * I, CONTENT);
  assert.equal(procurement.purchasableUnits, 0);
  assert.match(procurement.reason, /可支付资产不足/);
  preview = simulation.selectOperatingRightPreview(state, lumber.id);
  assertFinitePreview(preview);
  assert.equal(preview.maximumPriceWheatJin, 0);
  assert.match(preview.demandReason, /可支付资产不足/);
});

test("木材调价后公共建设采购与经营权估值同价，民营和上市卖家共享同一需求", () => {
  const state = legacyVoucherState();
  const lumber = addBuilding(state, "lumberyard", "wood-shared", 2, 2, 0);
  assert.equal(simulation.issueGrainVouchers(state, "town", 50000).ok, true);
  const listed = simulation.listCompany(state, lumber.id, { levels: 1, operatingCapitalVoucher: 0, initialMaterialQuantity: 0 });
  assert.equal(listed.ok, true, listed.reason);
  const company = state.companies[listed.companyId];
  setResidentInventoryJin(state, "wood", 1000, CONTENT);
  company.inventory.wood = 1000 * I;
  company.inventoryCostVoucherUnits.wood = 0;
  assert.equal(simulation.configureIntermediatePrice(state, "wood", 17).ok, true);
  assert.equal(simulation.setPublicProcurementIntent(state, { kind: "build", typeId: "public_housing" }).ok, true);
  const valuation = simulation.selectOperatingRightPreview(state, lumber.id);
  assert.equal(valuation.outputPriceVoucherPerUnit, 17);

  const plot = state.plots.find(row => !row.feature && !state.buildings.some(building => building.plotId === row.id));
  assert.ok(plot);
  const residentCashBefore = state.currency.balances.residents;
  const companyCashBefore = company.cashVoucherUnits;
  const townCashBefore = state.currency.balances.town;
  const started = simulation.buildAt(state, "public_housing", plot.id);
  assert.equal(started.ok, true, started.reason);
  assert.equal(state.accounts.residents.wood, 0);
  assert.equal(company.inventory.wood, 0);
  assert.equal(state.accounts.town.wood, 0, "采购后同一次开工立即入工程，不保留重复材料");
  const paid = townCashBefore - state.currency.balances.town;
  assert.equal(paid, 2000 * 17 * V);
  assert.equal((state.currency.balances.residents - residentCashBefore) + (company.cashVoucherUnits - companyCashBefore), paid);
  assert.equal(state.market.publicProcurementDemand.wood, undefined, "同一建设需求成交开工后必须清除");
});

test("v7旧存档不再自动迁移", () => {
  const legacy = legacyVoucherState();
  legacy.version = 7;
  legacy.schemaVersion = 7;
  assert.throws(() => migrateSave(legacy, CONTENT), /旧版存档不兼容/);
});
