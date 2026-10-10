// 旧存档换算（docs/OWNERSHIP.md「旧存档换算」）：读档时按等级拆开的建筑整栋交给一个主人。
import test from "node:test";
import assert from "node:assert/strict";
import { simulation } from "../src/engine.js";
import { CONTENT } from "../src/content/index.js";
import { validateState } from "../src/core/validation.js";
import { householdList, householdWorkingAge, isActiveHousehold } from "../src/systems/households.js";
import { createIndependentCompany } from "../src/systems/companies.js";
import { isWholeBuilding } from "../src/systems/ownership-migrate.js";
import { jobKeyForBuilding, privateJobKeyForBuilding } from "../src/selectors/labor.js";
import { checksumSaveText, decodeSaveContainer, SAVE_CONTAINER_VERSION } from "../src/persistence/save-container.js";
import { parseSaveFile } from "../src/persistence/storage.js";
import { loadReportMessage } from "../src/persistence/migrations.js";
import { wheatEraState } from "./helpers-monetary.js";

const I = CONTENT.precision.inventoryUnitsPerJin;
const VOUCHER = CONTENT.precision.currencyUnitsPerVoucher;
const clone = value => JSON.parse(JSON.stringify(value));

function activeHouseholds(state) {
  return householdList(state).filter(isActiveHousehold);
}

function freePlot(state) {
  return state.plots.find(row => !row.feature && !state.buildings.some(b => b.plotId === row.id));
}

// 新建一座磨坊（不经施工），整栋归镇里。
function addMill(state, id, level) {
  const plot = freePlot(state);
  assert.ok(plot, "缺少空地块");
  const building = {
    id, typeId: "mill", level, ownership: { townLevels: level, privateLevels: 0, listedLevels: 0 },
    plotId: plot.id, x: plot.x, y: plot.y, materialInvestments: [], completed: { year: state.year, day: 1 }
  };
  state.buildings.push(building);
  return building;
}

// 建一座磨坊并挂上上市公司（走真实建公司路径），再把磨坊和公司改成旧存档的拆分形态。
// split: 旧存档的 ownership；privateOwners: 旧存档的业主列表；residents: 居民持有的股数（由第一户持有）。
function addSplitListedMill(state, id, { level, split, privateOwners = null, listed = true, residents = 0, price = 1000 }) {
  const mill = addMill(state, id, level);
  const result = createIndependentCompany(state, mill.id, {}, CONTENT);
  assert.equal(result.ok, true, result.reason);
  const company = state.companies[result.companyId];
  company.settings.targetWorkers = 0;
  company.sharePriceVoucherUnits = price;
  company.shareSale = { ...(company.shareSale || {}), offeredShares: 0, sharePriceVoucherUnits: price, cumulativeProceedsVoucherUnits: 0 };
  company.listedLevels = split.listedLevels;
  if (listed) {
    const holder = activeHouseholds(state)[0];
    company.listing = { listed: true, ticker: "101", listedAt: { year: 1, day: 1 } };
    company.totalShares = 1000;
    company.residentShares = residents;
    company.townShares = 1000 - residents;
    company.householdShares = residents > 0 ? { [holder.id]: residents } : {};
    if (residents > 0) holder.shares = { [company.id]: residents };
  }
  mill.ownership = { ...split };
  if (privateOwners) mill.privateOwners = privateOwners;
  else delete mill.privateOwners;
  return { mill, company };
}

// 旧存档经真实的 IndexedDB 容器读档路径加载（decodeSaveContainer → migrateSave）。
function loadOldSave(old) {
  const stateText = JSON.stringify(old);
  const header = JSON.stringify({
    containerVersion: SAVE_CONTAINER_VERSION, id: "slot-old", name: "旧存档",
    savedAt: new Date().toISOString(), checksum: checksumSaveText(stateText)
  });
  const raw = header.slice(0, -1) + ',"state":' + stateText + "}";
  return decodeSaveContainer(raw, "slot-old", CONTENT).state;
}

function assertValid(state, label = "") {
  const { errors } = validateState(state, CONTENT);
  assert.deepEqual(errors, [], label);
}

function millLines(state) {
  return state._loadReport.ownership.filter(line => line.startsWith("磨坊整栋归属"));
}

test("整栋的存档读档是空操作：归属不变、报告没有换算行", () => {
  const state = wheatEraState({ seed: 8100 });
  const [h1] = activeHouseholds(state);
  addMill(state, "mill-whole-town", 2);
  const priv = addMill(state, "mill-whole-private", 2);
  priv.ownership = { townLevels: 0, privateLevels: 2, listedLevels: 0 };
  priv.privateOwners = [h1.id];
  addSplitListedMill(state, "mill-whole-company", { level: 1, split: { townLevels: 0, privateLevels: 0, listedLevels: 1 }, residents: 300 });
  const old = clone(state);
  assertValid(old, "输入");
  const loaded = loadOldSave(old);
  assertValid(loaded, "读档后");
  assert.deepEqual(loaded._loadReport.ownership, []);
  assert.equal(JSON.stringify(loaded), JSON.stringify(old));
});

test("镇里多：民营少数户按每级估值得到补偿，整栋归镇里", () => {
  const state = wheatEraState({ seed: 8101 });
  const [h1] = activeHouseholds(state);
  const mill = addMill(state, "mill-town", 3);
  mill.ownership = { townLevels: 2, privateLevels: 1, listedLevels: 0 };
  mill.privateOwners = [h1.id];
  const old = clone(state);
  const townWheat = old.accounts.town.wheat;
  const h1Wheat = old.households.byId[h1.id].inventory.wheat;
  const loaded = loadOldSave(old);
  assertValid(loaded);
  const building = loaded.buildings.find(row => row.id === "mill-town");
  assert.deepEqual(building.ownership, { townLevels: 3, privateLevels: 0, listedLevels: 0 });
  assert.equal(building.privateOwners, undefined);
  assert.equal(millLines(loaded).length, 1);
  assert.match(millLines(loaded)[0], /^磨坊整栋归属：镇里（补偿民营 1 户 [\d.]+ 粮券）$/);
  // 补偿是真实转账：镇库减少的小麦等于业主增加的小麦。
  const paid = loaded.households.byId[h1.id].inventory.wheat - h1Wheat;
  assert.ok(paid > 0, "民营业主应收到补偿");
  assert.equal(townWheat - loaded.accounts.town.wheat, paid);
});

test("民营多：户内等级最多者得整栋，其他户补偿；镇营等级并入不另付钱", () => {
  const state = wheatEraState({ seed: 8102 });
  const [h1, h2] = activeHouseholds(state);
  const mill = addMill(state, "mill-private", 3);
  mill.ownership = { townLevels: 0, privateLevels: 3, listedLevels: 0 };
  mill.privateOwners = [h1.id, h2.id, h2.id];
  const loaded = loadOldSave(clone(state));
  assertValid(loaded);
  const building = loaded.buildings.find(row => row.id === "mill-private");
  assert.deepEqual(building.ownership, { townLevels: 0, privateLevels: 3, listedLevels: 0 });
  assert.deepEqual(building.privateOwners, [h2.id]);
  assert.ok(loaded.households.byId[h2.id].operatingRights.some(row => row.buildingId === "mill-private" && row.level === 3));
  assert.ok(!(loaded.households.byId[h1.id].operatingRights || []).some(row => row.buildingId === "mill-private"));
  assert.match(millLines(loaded)[0], new RegExp(`^磨坊整栋归属：民营户${h2.name}（补偿民营 1 户 [\\d.]+ 粮券）$`));
});

test("平手归镇里：镇里与民营各占一半时整栋归镇里，民营补偿", () => {
  const state = wheatEraState({ seed: 8103 });
  const [h1] = activeHouseholds(state);
  const mill = addMill(state, "mill-tie", 2);
  mill.ownership = { townLevels: 1, privateLevels: 1, listedLevels: 0 };
  mill.privateOwners = [h1.id];
  const loaded = loadOldSave(clone(state));
  assertValid(loaded);
  assert.deepEqual(loaded.buildings.find(row => row.id === "mill-tie").ownership, { townLevels: 2, privateLevels: 0, listedLevels: 0 });
  assert.match(millLines(loaded)[0], /^磨坊整栋归属：镇里（补偿民营 1 户/);
});

test("公司胜出：镇营等级并入公司，镇里按股本折算拿到新增股份，总股本取新等级的整数倍", () => {
  const state = wheatEraState({ seed: 8104 });
  const [h1] = activeHouseholds(state);
  const { company } = addSplitListedMill(state, "mill-co", {
    level: 3, split: { townLevels: 1, privateLevels: 0, listedLevels: 2 }, residents: 300
  });
  const loaded = loadOldSave(clone(state));
  assertValid(loaded);
  assert.deepEqual(loaded.buildings.find(row => row.id === "mill-co").ownership, { townLevels: 0, privateLevels: 0, listedLevels: 3 });
  const merged = loaded.companies[company.id];
  assert.equal(merged.listedLevels, 3);
  // 镇营 1 级按 1000 股 ÷ 2 级 = 500 股；总股本 1500 已是 3 的倍数，不需要取整。
  assert.equal(merged.totalShares, 1500);
  assert.equal(merged.townShares, 700 + 500);
  assert.equal(merged.residentShares, 300);
  assert.deepEqual(merged.householdShares, { [h1.id]: 300 });
  assert.match(millLines(loaded)[0], /^磨坊整栋归属：公司.+（镇里增发 500 股）$/);
});

test("公司胜出（未上市）：只合并等级，不增发股份；民营等级先补偿", () => {
  const state = wheatEraState({ seed: 8105 });
  const [h1] = activeHouseholds(state);
  const { company } = addSplitListedMill(state, "mill-co-unlisted", {
    level: 4, split: { townLevels: 1, privateLevels: 1, listedLevels: 2 }, privateOwners: [h1.id], listed: false
  });
  const loaded = loadOldSave(clone(state));
  assertValid(loaded);
  assert.deepEqual(loaded.buildings.find(row => row.id === "mill-co-unlisted").ownership, { townLevels: 0, privateLevels: 0, listedLevels: 4 });
  assert.equal(loaded.companies[company.id].listedLevels, 4);
  assert.equal(loaded.companies[company.id].listing.listed, false);
  assert.match(millLines(loaded)[0], /^磨坊整栋归属：公司.+（补偿民营 1 户 [\d.]+ 粮券）$/);
});

test("镇里胜过上市公司：公司清算，居民股份按股价由镇库回购，公司与股份记录消失", () => {
  const state = wheatEraState({ seed: 8106 });
  const [h1] = activeHouseholds(state);
  const { company } = addSplitListedMill(state, "mill-town-wins", {
    level: 3, split: { townLevels: 2, privateLevels: 0, listedLevels: 1 }, residents: 300, price: 1000
  });
  const old = clone(state);
  const townWheat = old.accounts.town.wheat;
  const h1Wheat = old.households.byId[h1.id].inventory.wheat;
  const loaded = loadOldSave(old);
  assertValid(loaded);
  assert.equal(loaded.companies[company.id], undefined);
  assert.deepEqual(loaded.buildings.find(row => row.id === "mill-town-wins").ownership, { townLevels: 3, privateLevels: 0, listedLevels: 0 });
  assert.equal(loaded.households.byId[h1.id].shares?.[company.id], undefined);
  // 300 股 × 1000 单位 = 300000 单位 = 100 粮券。
  assert.match(millLines(loaded)[0], /^磨坊整栋归属：镇里（公司.+清算：股东回购 100 粮券）$/);
  const paid = loaded.households.byId[h1.id].inventory.wheat - h1Wheat;
  assert.equal(paid, 300 * 1000 / VOUCHER * I);
  assert.equal(townWheat - loaded.accounts.town.wheat, paid);
});

test("民营胜过上市公司：公司清算，民营业主得整栋，镇营等级并入不另付钱", () => {
  const state = wheatEraState({ seed: 8107 });
  const [h1] = activeHouseholds(state);
  const { company } = addSplitListedMill(state, "mill-private-wins", {
    level: 4, split: { townLevels: 1, privateLevels: 2, listedLevels: 1 }, privateOwners: [h1.id, h1.id], residents: 300, price: 1000
  });
  const loaded = loadOldSave(clone(state));
  assertValid(loaded);
  assert.equal(loaded.companies[company.id], undefined);
  const building = loaded.buildings.find(row => row.id === "mill-private-wins");
  assert.deepEqual(building.ownership, { townLevels: 0, privateLevels: 4, listedLevels: 0 });
  assert.deepEqual(building.privateOwners, [h1.id]);
  assert.match(millLines(loaded)[0], new RegExp(`^磨坊整栋归属：民营户${h1.name}（公司.+清算：股东回购 100 粮券）$`));
});

test("镇库付不起补偿：按能付的付，报告和事件写明未付金额", () => {
  const state = wheatEraState({ seed: 8108 });
  const [h1] = activeHouseholds(state);
  const mill = addMill(state, "mill-broke", 3);
  mill.ownership = { townLevels: 2, privateLevels: 1, listedLevels: 0 };
  mill.privateOwners = [h1.id];
  const old = clone(state);
  old.accounts.town.wheat = 0;
  const loaded = loadOldSave(old);
  assertValid(loaded);
  assert.match(millLines(loaded)[0], /补偿民营 1 户 0 粮券，镇库付不起 [\d.]+ 粮券/);
  assert.ok(loaded.events.some(row => JSON.stringify(row).includes("还差")), "应有未付补偿的事件");
  assert.ok(loadReportMessage(loaded).includes("整栋归属换算 1 栋"));
});

test("找不到的业主：其民营等级归镇里，不付补偿", () => {
  const state = wheatEraState({ seed: 8109 });
  const mill = addMill(state, "mill-ghost", 2);
  mill.ownership = { townLevels: 0, privateLevels: 2, listedLevels: 0 };
  mill.privateOwners = ["household-missing"];
  const loaded = loadOldSave(clone(state));
  assertValid(loaded);
  assert.deepEqual(loaded.buildings.find(row => row.id === "mill-ghost").ownership, { townLevels: 2, privateLevels: 0, listedLevels: 0 });
  assert.equal(millLines(loaded)[0], "磨坊整栋归属：镇里");
});

test("孤儿公司：建筑归镇里但仍挂着公司对象（公司等级为0），读档时公司清算、建筑留在镇里", () => {
  const state = wheatEraState({ seed: 8117 });
  const { company } = addSplitListedMill(state, "mill-orphan", {
    level: 2, split: { townLevels: 2, privateLevels: 0, listedLevels: 0 }, listed: false
  });
  const loaded = loadOldSave(clone(state));
  assertValid(loaded);
  assert.equal(loaded.companies[company.id], undefined);
  assert.deepEqual(loaded.buildings.find(row => row.id === "mill-orphan").ownership, { townLevels: 2, privateLevels: 0, listedLevels: 0 });
});

test("换算失败时整栋划归镇里、不付补偿，并写进报告", () => {
  const state = wheatEraState({ seed: 8110 });
  const [h1] = activeHouseholds(state);
  // 镇里多（2 比 1）：走清算路径，库存转移时抛错。
  const { company } = addSplitListedMill(state, "mill-fallback", {
    level: 3, split: { townLevels: 2, privateLevels: 0, listedLevels: 1 }, residents: 300, price: 1000
  });
  const old = clone(state);
  // 公司库存里混入非整数（坏数据）：清算时库存转移会抛错，触发兜底。
  old.companies[company.id].inventory.wheat = 1.5;
  const h1Wheat = old.households.byId[h1.id].inventory.wheat;
  const loaded = loadOldSave(old);
  assertValid(loaded);
  assert.equal(loaded.companies[company.id], undefined);
  assert.deepEqual(loaded.buildings.find(row => row.id === "mill-fallback").ownership, { townLevels: 3, privateLevels: 0, listedLevels: 0 });
  assert.equal(loaded.households.byId[h1.id].inventory.wheat, h1Wheat, "兜底不付补偿");
  assert.match(millLines(loaded)[0], /^磨坊整栋归属：无法换算（.+），整栋划归镇里，未付补偿$/);
});

test("整栋换主人时在岗人数搬到新主人的岗位键", () => {
  const state = wheatEraState({ seed: 8115 });
  const [h1] = activeHouseholds(state);
  const mill = addMill(state, "mill-workers", 3);
  mill.ownership = { townLevels: 2, privateLevels: 1, listedLevels: 0 };
  mill.privateOwners = [h1.id];
  const privateKey = privateJobKeyForBuilding(mill.id, "millers");
  const townKey = jobKeyForBuilding(mill.id, "millers");
  // 户内劳力 3 人（660 户开局，每户约 5 人，劳力最多 3）：3 人全部在民营磨坊岗位上（总数不超过劳力）。
  assert.ok(householdWorkingAge(h1) >= 3, "夹具需要一户至少 3 个劳力");
  h1.jobs = { ...(h1.jobs || {}), farmers: 0, [privateKey]: 3 };
  const loaded = loadOldSave(clone(state));
  assertValid(loaded);
  const after = loaded.households.byId[h1.id].jobs || {};
  assert.equal(after[townKey], 3, "镇营岗位接收在岗人数");
  assert.equal(after[privateKey] || 0, 0, "民营岗位清空");
});

test("公司清算时镇库付不起股份：付得起的回购，其余注销并写进报告", () => {
  const state = wheatEraState({ seed: 8116 });
  const [h1] = activeHouseholds(state);
  const { company } = addSplitListedMill(state, "mill-share-unpaid", {
    level: 3, split: { townLevels: 2, privateLevels: 0, listedLevels: 1 }, residents: 300, price: 1000
  });
  const old = clone(state);
  old.accounts.town.wheat = 0;
  const loaded = loadOldSave(old);
  assertValid(loaded);
  assert.equal(loaded.companies[company.id], undefined);
  assert.equal(loaded.households.byId[h1.id].shares?.[company.id], undefined);
  assert.match(millLines(loaded)[0], /^磨坊整栋归属：镇里（公司.+清算：股东回购 0 粮券，300股镇库付不起、注销（应付 100 粮券））$/);
  assert.ok(loaded.events.some(row => JSON.stringify(row).includes("注销")), "未付股份应有事件");
});

test("换算后再读一次是空操作（幂等）", () => {
  const state = wheatEraState({ seed: 8111 });
  const [h1, h2] = activeHouseholds(state);
  const priv = addMill(state, "mill-idem", 3);
  priv.ownership = { townLevels: 0, privateLevels: 3, listedLevels: 0 };
  priv.privateOwners = [h1.id, h2.id, h2.id];
  addSplitListedMill(state, "mill-idem-co", { level: 3, split: { townLevels: 1, privateLevels: 0, listedLevels: 2 }, residents: 300 });
  const once = loadOldSave(clone(state));
  assertValid(once);
  assert.equal(once._loadReport.ownership.length, 2);
  const twice = loadOldSave(clone(once));
  assertValid(twice);
  assert.deepEqual(twice._loadReport.ownership, []);
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test("导入存档文件（parseSaveFile）与 IndexedDB 容器读档得到同样的换算结果", () => {
  const state = wheatEraState({ seed: 8112 });
  const [h1] = activeHouseholds(state);
  const mill = addMill(state, "mill-import", 3);
  mill.ownership = { townLevels: 2, privateLevels: 1, listedLevels: 0 };
  mill.privateOwners = [h1.id];
  const text = JSON.stringify(clone(state));
  const imported = parseSaveFile(text, CONTENT);
  const container = loadOldSave(JSON.parse(text));
  assertValid(imported);
  assert.deepEqual(imported._loadReport.ownership, container._loadReport.ownership);
  assert.deepEqual(imported.buildings.find(row => row.id === "mill-import").ownership, container.buildings.find(row => row.id === "mill-import").ownership);
});

test("isWholeBuilding 只认整栋：拆分、业主缺失、公司缺失都不算整栋", () => {
  const state = wheatEraState({ seed: 8113 });
  const [h1] = activeHouseholds(state);
  const split = addMill(state, "mill-split", 2);
  split.ownership = { townLevels: 1, privateLevels: 1, listedLevels: 0 };
  split.privateOwners = [h1.id];
  assert.equal(isWholeBuilding(state, split), false);
  split.ownership = { townLevels: 0, privateLevels: 2, listedLevels: 0 };
  assert.equal(isWholeBuilding(state, split), true);
  split.privateOwners = ["household-missing"];
  assert.equal(isWholeBuilding(state, split), false);
  split.ownership = { townLevels: 0, privateLevels: 0, listedLevels: 2 };
  delete split.privateOwners;
  assert.equal(isWholeBuilding(state, split), false, "没有对应公司不算整栋");
});
