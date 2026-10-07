import { householdEmploymentCount, householdList } from "../systems/households.js";

export function createDashboardRuntime(state) {
  const households = householdList(state);
  const jobCounts = new Map();
  for (const household of households) {
    for (const [jobKey, rawCount] of Object.entries(household.jobs || {})) {
      const count = Math.max(0, Number(rawCount) || 0);
      if (count <= 0) continue;
      jobCounts.set(jobKey, (jobCounts.get(jobKey) || 0) + count);
    }
  }

  const buildingById = new Map();
  const buildingByPlotId = new Map();
  const buildingTypeCounts = new Map();
  const firstBuildingByType = new Map();
  for (const building of state.buildings || []) {
    buildingById.set(building.id, building);
    if (building.plotId) buildingByPlotId.set(building.plotId, building);
    buildingTypeCounts.set(building.typeId, (buildingTypeCounts.get(building.typeId) || 0) + 1);
    if (!firstBuildingByType.has(building.typeId)) firstBuildingByType.set(building.typeId, building);
  }

  const plotById = new Map();
  const plotsByFeature = new Map();
  const ordinaryPlots = [];
  for (const plot of state.plots || []) {
    plotById.set(plot.id, plot);
    if (plot.feature) {
      const rows = plotsByFeature.get(plot.feature) || [];
      rows.push(plot);
      plotsByFeature.set(plot.feature, rows);
    } else {
      ordinaryPlots.push(plot);
    }
  }
  const companyByBuildingId = new Map();
  for (const company of Object.values(state.companies || {})) {
    if (company?.buildingId) companyByBuildingId.set(company.buildingId, company);
  }
  const privateDayByBuildingId = new Map((state.privateEconomy?.lastDay || []).map(row => [row.buildingId, row]));

  return {
    households,
    jobCounts,
    buildingById,
    buildingByPlotId,
    buildingTypeCounts,
    firstBuildingByType,
    plotById,
    plotsByFeature,
    ordinaryPlots,
    companyByBuildingId,
    privateDayByBuildingId
  };
}


export function employmentExchangeRemainingUnits(state, content, runtime) {
  const households = runtime?.households || householdList(state);
  const exchange = state.households?.exchange || null;
  const currentKey = `${state.year}:${state.day}`;
  const sameDay = exchange?.dayKey === currentKey;
  const policyJin = Math.max(content.rules.employmentExchangeMinimumJin ?? 0,
    Math.min(content.rules.employmentExchangeMaximumJin ?? 10,
      Number(state.policy?.employmentExchangeJin ?? content.rules.employmentExchangeDefaultJin ?? 2)));
  const unitsPerJin = content.precision.inventoryUnitsPerJin;
  let remaining = 0;
  for (const household of households) {
    const eligible = sameDay
      ? Math.max(0, Number(exchange?.eligibleByHousehold?.[household.id]) || 0)
      : householdEmploymentCount(household);
    const used = sameDay ? Math.max(0, Number(exchange?.usedByHousehold?.[household.id]) || 0) : 0;
    const gross = Math.round(eligible * policyJin * unitsPerJin);
    remaining += Math.max(0, gross - used);
  }
  return remaining;
}
