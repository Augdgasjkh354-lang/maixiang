import { readJobCount } from "./labor.js";
import { reclaimedAcres } from "../systems/agriculture.js";
export function selectHarvestForecast(state, content) {
  const acres = reclaimedAcres(state, content);
  const capacity = acres / content.agriculture.acresPerFarmer;
  const elapsed = Math.min(state.day, content.rules.growingDays);
  const farmers = readJobCount(state, "farmers");
  const expectedWork = state.day < content.rules.growingDays
    ? state.agriculture.workUnits + farmers * (content.rules.growingDays - elapsed)
    : farmers * content.rules.growingDays;
  const maximum = acres * content.agriculture.yieldPerAcre;
  const ratio = Math.max(0, Math.min(1, expectedWork / (capacity * content.rules.growingDays)));
  return Math.round(maximum * ratio * 100) / 100;
}
