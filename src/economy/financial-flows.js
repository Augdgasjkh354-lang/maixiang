function emptyOwner() {
  return {
    agricultureWheatUnits: 0, wagesWheatUnits: 0, constructionWagesWheatUnits: 0, unemploymentWheatUnits: 0,
    reliefWheatUnits: 0, rentWheatUnits: 0, breadPurchaseWheatUnits: 0,
    saltPurchaseWheatUnits: 0, operatingRightWheatUnits: 0,
    consumptionQeqUnits: 0, privateInputs: {}, privateOutputs: {}, privateTaxes: {},
    constructionMaterials: {}, constructionMaterialsReturned: {},
    // 镇库小麦的实物流水：镇营加工投入（磨坊/酒坊）、居民用小麦换券入库、居民用券兑回小麦。
    productionInputWheatUnits: 0, wheatExchangeInUnits: 0, wheatRedeemedUnits: 0
  };
}

export function emptyFinancialFlowPeriod() {
  return { residents: emptyOwner(), town: emptyOwner() };
}

function add(map, key, value) { map[key] = (map[key] || 0) + value; }

export function recordFinancialFlow(state, row) {
  state.financialFlows ||= { day: emptyFinancialFlowPeriod(), year: emptyFinancialFlowPeriod(), cumulative: emptyFinancialFlowPeriod() };
  const periods = [state.financialFlows.day, state.financialFlows.year, state.financialFlows.cumulative];
  for (const period of periods) {
    const residents = period.residents;
    const town = period.town;
    const units = row.quantityUnits || 0;
    if (row.type === "harvest") {
      if (row.destination === "residents") residents.agricultureWheatUnits += units;
      if (row.destination === "town") town.agricultureWheatUnits += units;
    } else if (row.type === "construction_wage_payment" || row.type === "construction_wage_arrears_payment") {
      residents.constructionWagesWheatUnits += units; town.constructionWagesWheatUnits += units;
    } else if (row.type === "wage_payment" || row.type === "wage_arrears_payment") {
      residents.wagesWheatUnits += units; town.wagesWheatUnits += units;
    } else if (row.type === "unemployment_benefit") {
      residents.unemploymentWheatUnits += units; town.unemploymentWheatUnits += units;
    } else if (row.type === "relief") {
      residents.reliefWheatUnits += units; town.reliefWheatUnits += units;
    } else if (row.type === "rent_payment") {
      residents.rentWheatUnits += units; town.rentWheatUnits += units;
    } else if (row.type === "operating_right_sale") {
      residents.operatingRightWheatUnits += units; town.operatingRightWheatUnits += units;
    } else if (row.type === "bread_trade" && (row.itemId === "wheat" || row.itemId === "grain_voucher")) {
      residents.breadPurchaseWheatUnits += units; town.breadPurchaseWheatUnits += units;
    } else if (row.type === "salt_trade" && (row.itemId === "wheat" || row.itemId === "grain_voucher")) {
      residents.saltPurchaseWheatUnits += units; town.saltPurchaseWheatUnits += units;
    } else if (row.type === "consume") residents.consumptionQeqUnits += row.qeqUnits || 0;
    else if (row.type === "private_process_input") add(residents.privateInputs, row.itemId, units);
    else if (row.type === "private_production_output") add(residents.privateOutputs, row.itemId, units);
    else if (row.type === "private_production_tax") add(town.privateTaxes, row.itemId, units);
    else if (row.type === "process_input" && row.source === "town" && row.itemId === "wheat") add(town, "productionInputWheatUnits", units);
    else if (row.type === "voucher_exchange" && row.itemId === "wheat" && row.destination === "town") add(town, "wheatExchangeInUnits", units);
    else if (row.type === "voucher_redeem" && row.itemId === "wheat" && row.source === "town") add(town, "wheatRedeemedUnits", units);
    else if (row.type === "construction_material") add(town.constructionMaterials, row.itemId, units);
    else if (row.type === "construction_material_return") add(town.constructionMaterialsReturned, row.itemId, units);
  }
}
