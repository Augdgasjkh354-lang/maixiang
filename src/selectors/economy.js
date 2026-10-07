import {
  accountQeqUnits, itemQeqUnitsPerInventoryUnit, qeqUnitsToJin,
  unitsToQuantity
} from "../economy/inventory.js";

export function selectAccounts(state, content) {
  const accounts = {};
  for (const owner of ["residents", "town"]) {
    const balance = state.accounts[owner] || {};
    const items = {};
    for (const [itemId, item] of Object.entries(content.items)) {
      const quantityUnits = balance[itemId] || 0;
      items[itemId] = {
        itemId,
        name: item.name,
        unit: item.unit,
        quantity: unitsToQuantity(quantityUnits, content),
        quantityUnits,
        qeq: qeqUnitsToJin(
          itemQeqUnitsPerInventoryUnit(item, content) * quantityUnits,
          content
        )
      };
    }
    accounts[owner] = {
      items,
      qeqUnits: accountQeqUnits(state, owner, content),
      qeq: qeqUnitsToJin(accountQeqUnits(state, owner, content), content)
    };
  }
  return accounts;
}

export function selectFoodDays(state, content, includeTown) {
  const population = state.cohorts.reduce(function (sum, cohort) {
    return sum + cohort.m + cohort.f;
  }, 0);
  const perDay = population * content.rules.foodPerPersonDay * content.precision.qeqUnitsPerJin;
  if (perDay <= 0) return Infinity;
  const resident = accountQeqUnits(state, "residents", content);
  const town = includeTown ? accountQeqUnits(state, "town", content) : 0;
  return (resident + town) / perDay;
}

export function selectTotalQeq(state, content) {
  return qeqUnitsToJin(
    accountQeqUnits(state, "residents", content) + accountQeqUnits(state, "town", content),
    content
  );
}
