import { binomial } from "../core/random.js";
import { populationStats } from "../selectors/labor.js";
import { reconcileEmployment } from "./employment.js";
import { accountQeqUnits } from "../economy/inventory.js";
import { recordEvent } from "../economy/ledger.js";
import { selectHousing } from "../selectors/housing.js";
import { applyHouseholdDemography, totalHouseholdAgeBands } from "./households.js";
import { syncShopEmployment } from "./shops.js";
import { settleYearEstates, snapshotEstates } from "./redistribution.js";

function deathRate(age) {
  if (age < 5) return 0.004;
  if (age < 18) return 0.001;
  if (age < 65) return 0.0025;
  if (age < 75) return 0.025;
  if (age < 85) return 0.065;
  if (age < 95) return 0.14;
  return 0.28;
}

function addToCohort(cohorts, age, field, count) {
  if (count <= 0) return;
  let cohort = cohorts.find(item => item.age === age);
  if (!cohort) { cohort = { age, m: 0, f: 0, marriedM: 0, marriedF: 0 }; cohorts.push(cohort); }
  cohort[field] += count;
}

function marrySingles(cohorts) {
  let male = 0, female = 0;
  for (const cohort of cohorts) {
    if (cohort.age < 20 || cohort.age > 39) continue;
    male += Math.max(0, cohort.m - cohort.marriedM);
    female += Math.max(0, cohort.f - cohort.marriedF);
  }
  const couples = Math.min(Math.floor(male * 0.08), Math.floor(female * 0.08));
  let leftMale = couples, leftFemale = couples;
  for (const cohort of cohorts) {
    if (cohort.age < 20 || cohort.age > 39) continue;
    const pairMale = Math.min(leftMale, Math.max(0, cohort.m - cohort.marriedM));
    const pairFemale = Math.min(leftFemale, Math.max(0, cohort.f - cohort.marriedF));
    cohort.marriedM += pairMale; cohort.marriedF += pairFemale;
    leftMale -= pairMale; leftFemale -= pairFemale;
  }
  return couples;
}

function assertHouseholdBandsMatchCohorts(state) {
  const people = populationStats(state);
  const bands = totalHouseholdAgeBands(state);
  if (bands.children !== people.children || bands.workers !== people.workers || bands.elders !== people.elders) {
    throw new Error(`家庭人口与cohort不一致：家庭${bands.children}/${bands.workers}/${bands.elders}，cohort${people.children}/${people.workers}/${people.elders}`);
  }
}

export function advancePopulation(state, content) {
  assertHouseholdBandsMatchCohorts(state);
  const workersAtStart = populationStats(state).workers;
  const old = state.cohorts.slice().sort((a, b) => a.age - b.age);
  const next = [];
  let deaths = 0, adults = 0, retirees = 0, laborAgeDeaths = 0;
  let childDeaths = 0, workerDeaths = 0, elderDeaths = 0;
  for (const cohort of old) {
    const rate = deathRate(cohort.age);
    const marriedMaleDeaths = binomial(state, cohort.marriedM, rate);
    const marriedFemaleDeaths = binomial(state, cohort.marriedF, rate);
    const singleMaleDeaths = binomial(state, Math.max(0, cohort.m - cohort.marriedM), rate);
    const singleFemaleDeaths = binomial(state, Math.max(0, cohort.f - cohort.marriedF), rate);
    const randomDeaths = marriedMaleDeaths + marriedFemaleDeaths + singleMaleDeaths + singleFemaleDeaths;
    deaths += randomDeaths;
    if (cohort.age < 18) childDeaths += randomDeaths;
    else if (cohort.age < 65) { workerDeaths += randomDeaths; laborAgeDeaths += randomDeaths; }
    else elderDeaths += randomDeaths;
    const people = {
      age: cohort.age + 1,
      m: cohort.m - marriedMaleDeaths - singleMaleDeaths,
      f: cohort.f - marriedFemaleDeaths - singleFemaleDeaths,
      marriedM: cohort.marriedM - marriedMaleDeaths,
      marriedF: cohort.marriedF - marriedFemaleDeaths
    };
    const survivors = people.m + people.f;
    if (cohort.age === 17) adults += survivors;
    if (cohort.age === 64) retirees += survivors;
    if (people.age <= content.rules.maxAge && survivors > 0) next.push(people);
    else if (survivors > 0) { deaths += survivors; elderDeaths += survivors; }
  }
  state.cohorts = next;

  const marriedMale = state.cohorts.reduce((sum, cohort) => sum + cohort.marriedM, 0);
  const marriedFemale = state.cohorts.reduce((sum, cohort) => sum + cohort.marriedF, 0);
  let unmatched = Math.abs(marriedMale - marriedFemale);
  const field = marriedMale > marriedFemale ? "marriedM" : "marriedF";
  for (const cohort of state.cohorts.slice().reverse()) {
    if (unmatched <= 0) break;
    const cut = Math.min(cohort[field], unmatched); cohort[field] -= cut; unmatched -= cut;
  }

  const beforeBirths = populationStats(state);
  const availableFood = accountQeqUnits(state, "residents", content) + accountQeqUnits(state, "town", content);
  const annualNeed = Math.max(1, beforeBirths.total * content.rules.foodPerPersonDay * content.rules.daysPerYear * content.precision.qeqUnitsPerJin);
  const foodSupport = Math.max(0.3, Math.min(1, availableFood / (annualNeed * 0.85)));
  const housingCapacity = selectHousing(state, content).capacity;
  const housingSupport = Math.max(0.35, Math.min(1, housingCapacity / Math.max(housingCapacity, beforeBirths.total)));
  const birthRate = 0.31 * foodSupport * housingSupport;
  let births = 0;
  for (const cohort of state.cohorts) if (cohort.age >= 20 && cohort.age <= 39) births += binomial(state, cohort.marriedF, birthRate);
  const maleBirths = binomial(state, births, 0.5);
  addToCohort(state.cohorts, 0, "m", maleBirths);
  addToCohort(state.cohorts, 0, "f", births - maleBirths);
  const marriages = marrySingles(state.cohorts);

  // 遗产税要用去世前的家底与成年人数，所以在家庭人口变动之前取快照（税率为 0 时不取）。
  const estateSnapshot = snapshotEstates(state, content);
  const householdChange = applyHouseholdDemography(state, { childDeaths, workerDeaths, elderDeaths, adults, retirees, births });
  const employmentAdjustments = reconcileEmployment(state, content);
  syncShopEmployment(state, content);
  // 遗产税（有成年人去世的家庭）与家产归公（整户失效，全部归镇库 / 镇营）。
  const estates = settleYearEstates(state, content, estateSnapshot, householdChange.adultDeathsByHousehold);
  assertHouseholdBandsMatchCohorts(state);

  const workersAtClose = populationStats(state).workers;
  const laborBalance = workersAtStart + adults - retirees - laborAgeDeaths;
  const laborDifference = workersAtClose - laborBalance;
  if (laborDifference !== 0) throw new Error("年度劳动力账不平：年初" + workersAtStart + " + 成年" + adults + " - 退休" + retirees + " - 劳动年龄死亡" + laborAgeDeaths + " = " + laborBalance + "，实际年末" + workersAtClose);
  const laborChange = { openingWorkers: workersAtStart, adults, retirees, laborAgeDeaths, closingWorkers: workersAtClose, netChange: workersAtClose - workersAtStart, balanceDifference: laborDifference };
  const directReleases = householdChange.employmentReleases.reduce((sum, row) => sum + row.count, 0);
  const capacityReleases = employmentAdjustments.reduce((sum, change) => sum + Math.max(0, change.before - change.after), 0);
  const releasedJobs = directReleases + capacityReleases;
  state.lastDemography = { births, deaths, marriages, laborChange, householdAllocation: { childDeaths, workerDeaths, elderDeaths, adults, retirees, births, releasedJobs } };
  if (births || deaths || marriages) recordEvent(state, "一年将尽：新生" + births + "人，离世" + deaths + "人，新结" + marriages + "对。", content);
  if (directReleases > 0) recordEvent(state, `人口变化使家庭劳动力减少，稳定释放${directReleases}个超额岗位。`, content);
  for (const change of employmentAdjustments) {
    const jobName = change.buildingName ? change.buildingName + "（" + change.buildingId + "）· " + change.name : change.name;
    const cut = change.before - change.after;
    recordEvent(state, change.reason + "：" + jobName + "由" + change.before + "人调为" + change.after + "人" + (cut > 0 ? "，释放" + cut + "个岗位。" : "。"), content);
  }
  return { births, deaths, marriages, releasedJobs, employmentAdjustments, laborChange, householdAllocation: householdChange, estates };
}
