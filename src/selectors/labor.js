import { CORE_ROLES } from "../content/roles.js";
import { householdList, householdEmploymentCount, householdWorkingAge, jobCount } from "../systems/households.js";
import { reclaimedAcres } from "../systems/agriculture.js";
import { computePoachable } from "../systems/labor-market.js";

export function jobKeyForBuilding(buildingId, roleId) { return buildingId + "::" + roleId; }
export function privateJobKeyForBuilding(buildingId, roleId) { return buildingId + "::" + roleId + "::private"; }
export function listedJobKeyForBuilding(buildingId, roleId) { return buildingId + "::" + roleId + "::listed"; }

export function readJobCount(state, jobKey, runtime = null) {
  return runtime?.jobCounts ? (runtime.jobCounts.get(jobKey) || 0) : jobCount(state, jobKey);
}

export function populationStats(state) {
  const stats = { children: 0, workers: 0, elders: 0, total: 0, marriedCouples: 0, marriedWomen: 0 };
  let marriedMen = 0;
  for (const cohort of state.cohorts) {
    const count = cohort.m + cohort.f;
    stats.total += count;
    if (cohort.age < 18) stats.children += count;
    else if (cohort.age < 65) stats.workers += count;
    else stats.elders += count;
    marriedMen += cohort.marriedM;
    stats.marriedWomen += cohort.marriedF;
  }
  stats.marriedCouples = Math.min(marriedMen, stats.marriedWomen);
  return stats;
}

function shopRoleCount(state, buildingId, job, runtime = null) {
  const role = job.shopRole || (job.id === "merchants" ? "merchant" : job.id === "shop_clerks" ? "clerk" : null);
  const suffix = role ? `:${role}` : null;
  if (!suffix) return 0;
  return Object.values(state.shops || {}).filter(shop => shop.buildingId === buildingId && shop.status !== "closed" && shop.status !== "liquidating")
    .reduce((sum, shop) => sum + readJobCount(state, `shop:${shop.id}${suffix}`, runtime), 0);
}

function companyForBuilding(state, buildingId, runtime = null) {
  return runtime?.companyByBuildingId?.get(buildingId) || Object.values(state.companies || {}).find(company => company.buildingId === buildingId) || null;
}

export function selectJobRows(state, content, runtime = null) {
  const people = populationStats(state);
  const rows = [];
  for (const role of Object.values(content.roles || CORE_ROLES)) {
    let capacity = 0;
    if (role.capacity === "farmland") capacity = Math.floor(reclaimedAcres(state, content) / content.agriculture.acresPerFarmer);
    // 营造岗位容量即各在建工程投入人数之和；没有工程时容量为 0。
    else if (role.capacity === "project") capacity = (state.projects || []).reduce(function (sum, project) {
      return sum + Math.max(0, Math.floor(project.workers || 0));
    }, 0);
    else capacity = Math.max(0, Number(role.capacity) || 0);
    const count = readJobCount(state, role.id, runtime);
    const targetCount = role.id === content.agriculture.farmerRoleId
      ? Math.max(0, Math.min(capacity, Math.floor(Number(state.employment?.targets?.farmers ?? count))))
      : count;
    rows.push({ key: role.id, roleId: role.id, name: role.name, note: role.note || "",
      count, targetCount, targetShortage: Math.max(0, targetCount - count), capacity,
      wagePerWorkerDay: state.employment.wageRates?.[role.id] ?? role.wagePerWorkerDay ?? 0,
      releasePriority: role.releasePriority || 0, scope: role.scope || "core" });
  }
  for (const building of state.buildings) {
    const definition = content.buildings[building.typeId];
    if (!definition) continue;
    for (const job of definition.jobs || []) {
      const ownership = building.ownership || { townLevels: building.level || 1, privateLevels: 0, listedLevels: 0 };
      const townLevels = Math.max(0, Math.min(content.rules.buildingMaxLevel || 5, ownership.townLevels ?? building.level ?? 1));
      const localCapacity = job.capacityMode === "building" ? job.slots : job.slots * townLevels;
      const managedShop = job.managedBy === "shops";
      rows.push({
        key: jobKeyForBuilding(building.id, job.id), roleId: job.id, buildingId: building.id,
        buildingName: definition.name, name: job.name, note: job.note || "",
        count: managedShop ? shopRoleCount(state, building.id, job, runtime) : readJobCount(state, jobKeyForBuilding(building.id, job.id), runtime),
        capacity: localCapacity,
        wagePerWorkerDay: state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 0,
        releasePriority: job.releasePriority || 0,
        scope: managedShop ? "shop" : "building", managedBy: job.managedBy || null,
        globalDemandKind: job.globalDemand || null
      });
      const privateLevels = Math.max(0, ownership.privateLevels || 0);
      if (privateLevels > 0 && !job.managedBy) rows.push({
        key: privateJobKeyForBuilding(building.id, job.id), roleId: job.id, buildingId: building.id, buildingName: definition.name,
        name: job.name + "（民营）", note: "民营经营自动安排", count: readJobCount(state, privateJobKeyForBuilding(building.id, job.id), runtime),
        capacity: job.slots * privateLevels, wagePerWorkerDay: state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 0,
        releasePriority: job.releasePriority || 0, scope: "private" });
      const listedLevels = Math.max(0, ownership.listedLevels || 0);
      if (listedLevels > 0 && !job.managedBy) {
        const company = companyForBuilding(state, building.id, runtime);
        const companyWage = Number.isFinite(company?.settings?.wagePerWorkerDay)
          ? company.settings.wagePerWorkerDay
          : (state.employment.wageRates?.[job.id] ?? job.wagePerWorkerDay ?? 0);
        rows.push({
          key: listedJobKeyForBuilding(building.id, job.id), roleId: job.id, buildingId: building.id, buildingName: definition.name,
          name: job.name + "（企业）", note: "独立公司雇佣并按当前货币制度支付工资", count: readJobCount(state, listedJobKeyForBuilding(building.id, job.id), runtime),
          capacity: job.slots * listedLevels, wagePerWorkerDay: companyWage, wageKind: "company-wage", wageTarget: company?.id || null,
          releasePriority: job.releasePriority || 0, scope: "listed" });
      }
    }
  }
  const households = runtime?.households || householdList(state);
  const employed = households.reduce((sum, household) => sum + householdEmploymentCount(household), 0);
  const householdWorkers = households.reduce((sum, household) => sum + householdWorkingAge(household), 0);
  // householdWorkers is validated against cohorts. Use cohort workers for the public-facing population total.
  const idle = Math.max(0, people.workers - employed);
  const publicDemand = Math.ceil(people.total / (content.rules.publicServiceDemandPopulation || 500));
  const globalRoles = new Set(rows.filter(row => row.globalDemandKind === "public_service").map(row => row.roleId));
  for (const roleId of globalRoles) {
    const roleRows = rows.filter(row => row.roleId === roleId && row.globalDemandKind === "public_service");
    const inPost = roleRows.reduce((sum, row) => sum + row.count, 0);
    const totalCapacity = roleRows.reduce((sum, row) => sum + row.capacity, 0);
    for (const row of roleRows) {
      row.globalDemand = publicDemand; row.globalInPost = inPost;
      row.globalShortage = Math.max(0, publicDemand - inPost); row.globalCapacity = totalCapacity;
    }
  }
  // 用户 0.1.11：待业为 0 时，镇营建筑岗位可按出价挖人；poachable 计入 maxAssignable。
  const poachableFor = idle <= 0 ? computePoachable(state, content) : null;
  for (const row of rows) {
    row.poachable = poachableFor && row.scope === "building" ? poachableFor(row.wagePerWorkerDay || 0) : 0;
    let room = Math.max(0, row.capacity - row.count);
    if (row.globalDemandKind === "public_service") room = Math.min(room, Math.max(0, row.globalDemand - row.globalInPost));
    row.maxAssignable = row.roleId === content.agriculture.farmerRoleId && row.key === content.agriculture.farmerRoleId
      ? row.capacity
      : row.count + Math.min(room, idle + row.poachable);
  }
  return { rows, employed, idle, workingAge: people.workers, householdWorkingAge: householdWorkers,
    publicServiceDemand: publicDemand,
    civilServants: rows.filter(row => row.roleId === "civil_servants").reduce((sum, row) => sum + row.count, 0),
    police: rows.filter(row => row.roleId === "police").reduce((sum, row) => sum + row.count, 0) };
}
