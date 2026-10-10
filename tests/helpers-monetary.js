import { simulation } from "../src/engine.js";
import { householdList, syncResidentAggregates } from "../src/systems/households.js";

/**
 * 把开局发行的粮券全部清零（居民与镇库都为 0，发行量为 0），还原成"旧制度切到粮券前没有券"的起点。
 * 旧式 legacy 夹具的断言（镇库券池紧张、印券不足等）是按这个起点写的。
 */
export function clearOpeningVouchers(state) {
  for (const household of householdList(state)) household.voucherUnits = 0;
  state.currency.balances.town = 0;
  state.currency.issuedUnits = 0;
  state.currency.issuedCumulativeUnits = 0;
  syncResidentAggregates(state, simulation.content);
  return state;
}

/**
 * Legacy regression fixture: 0.1.4-era saves are migrated as already-completed
 * monetary reform with a compatibility bank entry. Old tests that exercise
 * voucher-era mechanics should use this instead of assuming a fresh 0.1.5 game
 * can issue vouchers before building a bank and starting reform.
 */
export function legacyVoucherState(options = {}) {
  const state = clearOpeningVouchers(simulation.createInitialState(options));
  state.monetaryReform = { legacyBankAccess: true };
  return state;
}

/**
 * 直接改家庭粮券余额，同时让镇库券池按差额找平（粮券总量不变，守恒校验照常通过）。
 * 开局即粮券，家庭手里本来就有券，测试里要"清空/设定"家庭余额时用它，不要裸写 household.voucherUnits。
 */
export function setHouseholdVoucherUnits(state, household, units) {
  state.currency.balances.town += (household.voucherUnits || 0) - units;
  household.voucherUnits = units;
  syncResidentAggregates(state, simulation.content);
  return household;
}

/** 把全体家庭的粮券都收到镇库（粮券总量不变）：要造"居民没钱买粮"的断粮场景时用。 */
export function clearAllHouseholdVouchers(state) {
  for (const household of householdList(state)) setHouseholdVoucherUnits(state, household, 0);
  return state;
}
