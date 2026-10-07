import { householdEmploymentCount, householdList } from "../systems/households.js";

// Preview/selectors may call the normal payment quote layer, which lazily normalizes
// the current employment-exchange day. Give those quotes an ephemeral copy so a
// read-only view never changes authoritative game state.
export function createPaymentViewState(state) {
  const preview = { ...state };
  if (state.monetaryReform) {
    preview.monetaryReform = {
      ...state.monetaryReform,
      paymentHistory: Array.isArray(state.monetaryReform.paymentHistory)
        ? state.monetaryReform.paymentHistory.slice()
        : state.monetaryReform.paymentHistory,
      voucherShortfallByKey: state.monetaryReform.voucherShortfallByKey
        ? { ...state.monetaryReform.voucherShortfallByKey }
        : state.monetaryReform.voucherShortfallByKey
    };
  }
  if (!state.households?.byId) return preview;

  const currentKey = `${state.year}:${state.day}`;
  const source = state.households.exchange || {};
  let eligibleByHousehold;
  let usedByHousehold;
  let peakEmploymentCount;
  if (source.dayKey === currentKey) {
    eligibleByHousehold = { ...(source.eligibleByHousehold || {}) };
    usedByHousehold = { ...(source.usedByHousehold || {}) };
    peakEmploymentCount = Number.isInteger(source.peakEmploymentCount) && source.peakEmploymentCount >= 0
      ? source.peakEmploymentCount
      : Object.values(eligibleByHousehold).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
  } else {
    eligibleByHousehold = Object.fromEntries(householdList(state).map(household => [household.id, householdEmploymentCount(household)]));
    usedByHousehold = {};
    peakEmploymentCount = Object.values(eligibleByHousehold).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
  }
  preview.households = {
    ...state.households,
    exchange: { dayKey: currentKey, eligibleByHousehold, usedByHousehold, peakEmploymentCount }
  };
  return preview;
}
