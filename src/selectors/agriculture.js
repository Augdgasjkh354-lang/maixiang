import { readJobCount } from "./labor.js";
import { reclaimedAcres } from "../systems/agriculture.js";
import { educationBonus } from "../economy/productivity.js";
import { farmTotalOutputJin, farmerCapacityOf } from "./farmland.js";
export function selectHarvestForecast(state, content) {
  const acres = reclaimedAcres(state, content);
  const capacity = farmerCapacityOf(state, content, { exact: true });
  const elapsed = Math.min(state.day, content.rules.growingDays);
  const farmers = readJobCount(state, "farmers");
  const expectedWork = state.day < content.rules.growingDays
    ? state.agriculture.workUnits + farmers * (content.rules.growingDays - elapsed)
    : farmers * content.rules.growingDays;
  const maximum = farmTotalOutputJin(state, content);
  const ratio = Math.max(0, Math.min(1, expectedWork / (capacity * content.rules.growingDays)));
  return Math.round(maximum * ratio * educationBonus(state) * 100) / 100;
}
