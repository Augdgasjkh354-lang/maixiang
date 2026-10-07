import { number, moneyMixHint } from "./format.js";

function items(map, names, units, scale) {
  return Object.entries(map || {}).filter(([, value]) => value > 0)
    .map(([id, value]) => `${names[id] || id} ${number(value / scale)}${units[id] || "单位"}`).join(" · ") || "无";
}

export function renderAnnualFlows(view) {
  const flow = view.financialFlows?.year || {};
  const residents = flow.residents || {};
  const town = flow.town || {};
  const scale = view.inventoryUnitsPerJin;
  return `<section class="panel-section"><h2>本年收支</h2>
    <div class="cardlet"><h3>居民</h3>
      <div class="row"><span class="label">农业分粮</span><strong class="value">${number(residents.agricultureWheatUnits / scale)}斤小麦</strong></div>
      <div class="row"><span class="label">工资 / 建筑工钱 / 失业金</span><strong class="value">${number(residents.wagesWheatUnits / scale)} / ${number(residents.constructionWagesWheatUnits / scale)} / ${number(residents.unemploymentWheatUnits / scale)}小麦等值</strong></div>
      <div class="row"><span class="label">面包 / 食盐</span><strong class="value">${number(residents.breadPurchaseWheatUnits / scale)} / ${number(residents.saltPurchaseWheatUnits / scale)}小麦等值</strong></div>
      <div class="row"><span class="label">经营权 / 房租</span><strong class="value">${number(residents.operatingRightWheatUnits / scale)} / ${number(residents.rentWheatUnits / scale)}小麦等值</strong></div>
      <div class="row"><span class="label">口粮消费</span><strong class="value">${number(residents.consumptionQeqUnits / view.qeqUnitsPerJin)}斤</strong></div>
      <div class="row"><span class="label">民营投入 / 所得</span><strong class="value">${items(residents.privateInputs, view.itemNames, view.itemUnits, scale)} / ${items(residents.privateOutputs, view.itemNames, view.itemUnits, scale)}</strong></div>
    </div>
    <div class="cardlet"><h3>镇库</h3>
      <div class="row"><span class="label">农业税 / 生产税</span><strong class="value">${number(town.agricultureWheatUnits / scale)}斤小麦 / ${items(town.privateTaxes, view.itemNames, view.itemUnits, scale)}</strong></div>
      <div class="row"><span class="label">商品已收入</span><strong class="value">${number(((view.market?.business?.year?.revenueWheatUnits || 0) + (view.salt?.year?.paidWheatUnits || 0)) / scale)}小麦等值</strong></div>
      <div class="row"><span class="label">租金 / 经营权收入</span><strong class="value">${number((view.housing.rentFiscal?.year?.collectedWheatUnits || 0) / scale)} / ${number((view.privateEconomy?.rightSales?.yearWheatUnits || 0) / scale)}小麦等值</strong></div>
      <div class="row"><span class="label">工资 / 建筑工钱 / 新欠薪</span><strong class="value">${number(residents.wagesWheatUnits / scale)} / ${number(residents.constructionWagesWheatUnits / scale)} / ${number((view.payroll?.year?.unpaidWheatUnits || 0) / scale)}小麦等值</strong></div>
      <div class="row"><span class="label">失业金</span><strong class="value">${number(town.unemploymentWheatUnits / scale)}小麦等值</strong></div>
      <div class="row"><span class="label">建设投入 / 拆除返还</span><strong class="value">${items(town.constructionMaterials, view.itemNames, view.itemUnits, scale)} / ${items(town.constructionMaterialsReturned, view.itemNames, view.itemUnits, scale)}</strong></div>
      <div class="row"><span class="label">民营人工折算</span><strong class="value">${number((view.privateEconomy?.year?.internalLaborCostWheatUnits || 0) / scale)}小麦等值</strong></div>
          <div class="subtle">货币收支按小麦等值汇总，实际小麦与粮券支付可在账目中逐笔查看。${moneyMixHint(view)}。</div>
    </div></section>`;
}
