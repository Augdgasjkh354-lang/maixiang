import { simulation } from "../src/engine.js";

/**
 * Legacy regression fixture: 0.1.4-era saves are migrated as already-completed
 * monetary reform with a compatibility bank entry. Old tests that exercise
 * voucher-era mechanics should use this instead of assuming a fresh 0.1.5 game
 * can issue vouchers before building a bank and starting reform.
 */
export function legacyVoucherState(options = {}) {
  const state = simulation.createInitialState(options);
  state.monetaryReform = {
    stage: "voucher",
    targetVoucherBps: 10000,
    residentExchangeEnabled: true,
    legacyBankAccess: true,
    started: null,
    completed: { legacy: true },
    paymentHistory: [],
    voucherShortfallByKey: {}
  };
  return state;
}
