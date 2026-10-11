// 上市公司产出卖给批发市场：按收购价结算（与民营收购 buyPrivateOutput 同口径）；
// 欠薪清算时存货变现：镇库付现金给公司，公司用现金偿付欠薪，市场 purchaseSpend 只记实付。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { householdList, isActiveHousehold } from "../src/systems/households.js";
import { sellCompanyOutputsToWholesale, liquidateCompanyForArrears } from "../src/systems/companies.js";
import { wholesalePurchasePrice, wholesaleUnitPrice } from "../src/systems/wholesale-market.js";
import { currencyScale, voucherBalance } from "../src/economy/currency.js";
import { formCompany } from "./helpers-ipo.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const V = CONTENT.precision.currencyUnitsPerVoucher;

function freePlot(state, feature = null) {
  return state.plots.find(row => (feature ? row.feature === feature : !row.feature) && !state.buildings.some(b => b.plotId === row.id));
}

// 直接放一栋建筑（不经施工），主人为镇里。
function addTownBuilding(state, typeId, id, { level = 1 } = {}) {
  const required = CONTENT.buildings[typeId].requiredPlotFeature || null;
  const plot = freePlot(state, required);
  assert.ok(plot, `缺少地块 ${typeId}`);
  const ownership = { townLevels: level, privateLevels: 0, listedLevels: 0 };
  const building = { id, typeId, level, ownership, plotId: plot.id, x: plot.x, y: plot.y,
    materialInvestments: [], completed: { year: state.year, day: 1 } };
  state.buildings.push(building);
  return building;
}

function assertValid(state, label = "") {
  const check = simulation.validateState(state);
  assert.equal(check.valid, true, `${label} ${check.errors.join("；")}`);
}

function setupMarketAndCompany(seed) {
  const state = simulation.createInitialState({ seed });
  addTownBuilding(state, "wholesale_market", `wm-${seed}`);
  const mill = addTownBuilding(state, "mill", `mill-${seed}`, { level: 2 });
  const created = formCompany(state, mill.id, { name: "测试磨坊", operatingCapitalVoucher: 0, initialMaterialQuantity: 0 });
  assert.equal(created.ok, true, created.reason);
  return { state, company: state.companies[created.companyId], companyId: created.companyId };
}

test("上市公司卖产出给批发市场：按收购价结算，不按售价；付款由镇库真实到账，市场 purchaseSpend 只记实付", () => {
  const { state, company } = setupMarketAndCompany(9101);
  const qtyJin = 1000;
  company.inventory.flour = qtyJin * I;
  company.inventoryCostVoucherUnits.flour = 0;
  const purchase = wholesalePurchasePrice(state, "flour", CONTENT);
  const sale = wholesaleUnitPrice(state, "flour", CONTENT);
  assert.ok(purchase > 0 && sale > purchase, `测试前提：收购价 ${purchase} 低于售价 ${sale}`);
  const townBefore = voucherBalance(state, "town");
  const companyBefore = voucherBalance(state, `company:${company.id}`);
  const spendBefore = state.wholesaleMarket.day?.purchaseSpend || 0;
  const result = sellCompanyOutputsToWholesale(state, CONTENT);
  assert.equal(result.soldUnits.flour, qtyJin * I, "全部产出卖给市场");
  assert.equal(company.inventory.flour || 0, 0, "公司存货清空");
  const revenue = company.accounts.day?.revenueVoucherUnits || 0;
  const expected = Math.round(qtyJin * purchase * currencyScale(CONTENT));
  const atSalePrice = Math.round(qtyJin * sale * currencyScale(CONTENT));
  assert.ok(Math.abs(revenue - expected) <= 1, `公司收入按收购价：期望 ${expected}，实际 ${revenue}（售价口径会是 ${atSalePrice}）`);
  // 守恒：镇库付出 = 公司收到 = 市场 purchaseSpend 增量。
  const townPaid = townBefore - voucherBalance(state, "town");
  const companyGot = voucherBalance(state, `company:${company.id}`) - companyBefore;
  assert.equal(townPaid, companyGot, "镇库付款全额到公司账户");
  assert.equal(townPaid, revenue, "收入与实付一致");
  assert.equal((state.wholesaleMarket.day?.purchaseSpend || 0) - spendBefore, townPaid, "市场 purchaseSpend 只记实付");
  assertValid(state, "收购价结算后");
});

test("上市公司欠薪清算：存货按收购价变现，镇库付现金给工人（债权核减与现金到账一致），市场 purchaseSpend 只记实付", () => {
  const { state, company } = setupMarketAndCompany(9102);
  const holder = householdList(state).filter(isActiveHousehold)[3];
  const arrears = 20 * V;
  company.payroll.arrearsVoucherUnits = arrears;
  company.payroll.claimsVoucherUnits = { [holder.id]: arrears };
  company.payroll.claimsPayment = {};
  company.inventory.flour = 10 * I;
  company.inventoryCostVoucherUnits.flour = 0;
  company.listing = { listed: true, ticker: "124", listedAt: null };
  company.totalShares = 1000;
  company.townShares = 1000;
  company.residentShares = 0;
  company.fundShares = 0;
  company.householdShares = {};
  company.shareSale = { ...company.shareSale, offeredShares: 0 };
  const householdBefore = voucherBalance(state, `household:${holder.id}`);
  const townBefore = voucherBalance(state, "town");
  const spendBefore = state.wholesaleMarket.day?.purchaseSpend || 0;
  const companyId = company.id;
  const row = liquidateCompanyForArrears(state, companyId, CONTENT);
  assert.equal(row.ok, true, row.reason);
  const householdGot = voucherBalance(state, `household:${holder.id}`) - householdBefore;
  const townPaid = townBefore - voucherBalance(state, "town");
  // 工人拿到的现金 = 存货变现（抵欠薪部分）+ 镇库垫付余额，欠薪全部清偿。
  assert.ok(row.inKindValueUnits > 0, "存货变现有价值");
  assert.equal(householdGot, arrears, "工人拿回全部欠薪（现金）");
  assert.equal(row.inKindValueUnits + row.townAdvanceUnits, arrears, "变现 + 垫付 = 欠薪");
  assert.equal(townPaid, arrears, "镇库付出的现金 = 工人收到的现金（钱不凭空增减）");
  assert.equal((state.wholesaleMarket.day?.purchaseSpend || 0) - spendBefore, row.inKindValueUnits, "市场 purchaseSpend 只记实际付给公司的收购款");
  assert.equal(state.companies[companyId], undefined, "公司已清算");
  assertValid(state, "清算后");
});
