import { CONTENT } from "../src/content/index.js";
import { issueTownVouchers, transferVouchers } from "../src/economy/currency.js";
import { householdList, householdPopulation, syncResidentAggregates } from "../src/systems/households.js";

function enableLegacyVoucherFixture(state) {
  state.monetaryReform ||= {};
  state.monetaryReform.targetVoucherBps = 10000;
  state.monetaryReform.residentExchangeEnabled = true;
  state.monetaryReform.legacyBankAccess = true;
  state.monetaryReform.completed ||= { year: state.year, day: Math.max(1, (state.day || 0) + 1), legacyFixture: true };
}

export function grantResidentVouchers(state, amountVoucher, content = CONTENT, householdId = null) {
  enableLegacyVoucherFixture(state);
  const units = Math.round(amountVoucher * content.precision.currencyUnitsPerVoucher);
  const issued = issueTownVouchers(state, units, content, "测试：镇库印制用于居民收入");
  if (!issued.ok) return issued;
  if (householdId) return transferVouchers(state, "town", `household:${householdId}`, units, content, "test_income", "测试居民收入");
  return transferVouchers(state, "town", "residents", units, content, "test_income", "测试居民收入");
}

export function setResidentInventoryJin(state, itemId, quantityJin, content = CONTENT) {
  const target = Math.round(quantityJin * content.precision.inventoryUnitsPerJin);
  const households = householdList(state);
  const totalMembers = households.reduce((sum, household) => sum + householdPopulation(household), 0) || 1;
  let assigned = 0;
  households.forEach((household, index) => {
    const amount = index === households.length - 1
      ? target - assigned
      : Math.floor(target * householdPopulation(household) / totalMembers);
    household.inventory[itemId] = Math.max(0, amount);
    assigned += household.inventory[itemId];
  });
  syncResidentAggregates(state, content);
  return { ok: true, amountUnits: target };
}

export function setHouseholdInventoryJin(state, householdId, itemId, quantityJin, content = CONTENT) {
  const household = state.households.byId[householdId];
  household.inventory[itemId] = Math.round(quantityJin * content.precision.inventoryUnitsPerJin);
  syncResidentAggregates(state, content);
  return household;
}

export function richestHousehold(state) {
  return householdList(state).slice().sort((a, b) => (b.voucherUnits || 0) - (a.voucherUnits || 0) || a.id.localeCompare(b.id))[0];
}
