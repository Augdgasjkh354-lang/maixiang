import { populationStats } from "./labor.js";
import { householdList, householdPopulation, isActiveHousehold } from "../systems/households.js";

export function selectHousing(state, content) {
  const people = populationStats(state).total;
  const villageCapacity = state.housing?.villageCapacity ?? content.rules.housingCapacity;
  const rentalDefs = [];
  for (const building of state.buildings) {
    const definition = content.buildings[building.typeId];
    if (!definition?.housingCapacity) continue;
    const capacity = definition.housingCapacity * Math.max(1, Math.min(content.rules.buildingMaxLevel || 10, building.level || 1));
    rentalDefs.push({ buildingId: building.id, plotId: building.plotId, name: definition.name, capacity, occupied: 0 });
  }
  let villageLeft = villageCapacity;
  const rentalLeft = rentalDefs.map(row => row.capacity);
  const householdHousing = [];
  for (const household of householdList(state).filter(isActiveHousehold)) {
    let remaining = householdPopulation(household);
    const villagePeople = Math.min(remaining, villageLeft);
    villageLeft -= villagePeople;
    remaining -= villagePeople;
    const rentals = [];
    for (let i = 0; i < rentalDefs.length && remaining > 0; i += 1) {
      const count = Math.min(remaining, rentalLeft[i]);
      if (count <= 0) continue;
      rentalLeft[i] -= count;
      rentalDefs[i].occupied += count;
      remaining -= count;
      rentals.push({ buildingId: rentalDefs[i].buildingId, people: count });
    }
    const rentalPeople = rentals.reduce((sum, row) => sum + row.people, 0);
    householdHousing.push({ householdId: household.id, people: householdPopulation(household), villagePeople, rentalPeople, unhousedPeople: remaining, rentals });
  }
  let unassignedPeople = Math.max(0, people - householdHousing.reduce((sum, row) => sum + row.people, 0));
  let unassignedVillage = Math.min(unassignedPeople, villageLeft); villageLeft -= unassignedVillage; unassignedPeople -= unassignedVillage;
  let unassignedRental = 0;
  for (let i = 0; i < rentalDefs.length && unassignedPeople > 0; i += 1) { const count=Math.min(unassignedPeople,rentalLeft[i]); rentalLeft[i]-=count; rentalDefs[i].occupied+=count; unassignedPeople-=count; unassignedRental+=count; }
  const rentals = rentalDefs.map((row, index) => ({ ...row, vacancies: rentalLeft[index], dailyRentDueWheatJin: row.occupied * (content.rules.rentPerResidentDayWheatJin || 1) }));
  const occupied = householdHousing.reduce((sum, row) => sum + row.people - row.unhousedPeople, 0) + unassignedVillage + unassignedRental;
  const shortage = householdHousing.reduce((sum, row) => sum + row.unhousedPeople, 0) + unassignedPeople;
  return {
    villageCapacity,
    villageOccupied: villageCapacity - villageLeft,
    villageVacancies: villageLeft,
    rentals,
    householdHousing,
    capacity: villageCapacity + rentalDefs.reduce((sum, row) => sum + row.capacity, 0),
    occupied,
    shortage,
    rentDuePeople: householdHousing.reduce((sum, row) => sum + row.rentalPeople, 0),
    unassignedRentalPeople: unassignedRental,
    dailyRentDueWheatJin: householdHousing.reduce((sum, row) => sum + row.rentalPeople, 0) * (content.rules.rentPerResidentDayWheatJin || 1)
  };
}
