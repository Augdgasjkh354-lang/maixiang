import { escapeHtml, number, numberMax, accountLines, moneyMixHint } from "./format.js";

const LABELS = {
  harvest: "收获", consume: "消耗", relief: "救济", wage: "工资", construction: "建设",
  process_input: "加工投入", process_output: "加工产出", process_loss: "加工损耗",
  processing_loss: "加工损耗", wage_expense: "工资计提", wage_payment: "当期工资发放",
  wage_arrears_payment: "偿还欠薪", wage_prepaid_credit: "旧预付工资抵扣",
  unemployment_benefit: "失业金发放", unemployment_shortfall: "失业金未足额",
  construction_material: "施工材料", rent_payment: "租金转账", rent_waiver: "租金减免",
  salt_consume: "食盐消费", market_trade: "物资买卖",
  construction_prepaid_remainder: "建设预付款留存",
  voucher_issue: "粮券印制", voucher_exchange: "粮食换券", voucher_redeem: "粮券注销/兑回",
  enterprise_capital_injection: "企业营运资金", enterprise_material_contribution: "企业实物投入",
  enterprise_input_payment: "企业原料采购", enterprise_sale: "企业销售", enterprise_dividend: "企业分红", enterprise_annual_distribution: "企业年度利润分配",
  enterprise_production_tax: "企业实物税", operating_right_sale: "经营权交易",
  transfer: "转账", deposit: "入库", withdrawal: "出库", legacy_consume: "旧版消耗",
  legacy_process: "旧版加工", legacy_loss: "旧版损耗", legacy_transfer: "旧版转账"
};

const ACCOUNT_NAMES = {
  town: "镇库", residents: "居民", households: "居民家庭", wholesale_market: "批发市场",
  field: "麦田", consumed: "消耗", consumption: "消耗", loss: "损耗", currency_issuer: "印制",
  private_production: "民营生产", wage_expense: "工资计提", unpaid: "未付", waived: "减免",
  rent_due: "应收租金", construction_payroll: "施工工资", construction_investment: "建设投入"
};

// 账户名解析（0.1.11 补回）：把内部 token 翻译成中文
function resolveAccountName(view, token) {
  if (!token) return "";
  if (ACCOUNT_NAMES[token]) return ACCOUNT_NAMES[token];
  const parts = String(token).split(":");
  const prefix = parts[0];
  const id = parts.slice(1).join(":");
  if (prefix === "household") {
    const m = /^household-(\d+)$/.exec(id);
    if (m) return `第${m[1]}户`;
    return view.householdNames?.[id] || id;
  }
  if (prefix === "shop") return view.shops?.find(s => s.id === id)?.name || "店铺";
  if (prefix === "company") return view.companies?.find(c => c.id === id)?.name || "公司";
  if (prefix === "building") return view.buildings?.find(b => b.id === id)?.name || "建筑";
  return token;
}

export function renderLedger(view) {
  const last = view.annualReports.at(-1);
  const rows = view.ledger.slice(0, 42).map(row => {
    const label = LABELS[row.type] || "记账";
    const isVoucher = row.itemId === "grain_voucher";
    const item = isVoucher ? "粮券" : row.itemId ? (view.itemNames[row.itemId] || row.itemId) : "口粮当量";
    const unit = isVoucher ? "券" : row.itemId ? (view.itemUnits[row.itemId] || "斤") : "口粮斤";
    const amount = row.quantityUnits && row.itemId
      ? row.quantityUnits / (isVoucher ? view.currencyUnitsPerVoucher : view.inventoryUnitsPerJin)
      : (row.qeqUnits || 0) / view.qeqUnitsPerJin;
    const where = [row.source, row.destination].filter(Boolean).map(t => resolveAccountName(view, t)).join(" → ");
    return `<tr><td>第${number(row.year)}年·${number(row.day)}日</td><td><span class="badge${["consume", "process_loss", "withdrawal", "salt_consume", "rent_waiver"].includes(row.type) ? " red" : ""}">${label}</span><br>${escapeHtml(item)} · ${escapeHtml(row.reason || "")}<div class="subtle">${escapeHtml(where)}${row.legacyDetail ? " · " + escapeHtml(row.legacyDetail) : ""}</div></td><td class="amount">${number(amount)}${escapeHtml(unit)}</td></tr>`;
  }).join("");
  const totals = view.yearTotals;
  const payroll = view.payroll?.year || {};
  const voucherScale = view.currencyUnitsPerVoucher;
  const wageAccrued = (payroll.accruedVoucherUnits || 0) / voucherScale;
  const wagePaid = (payroll.paidVoucherUnits || 0) / voucherScale;
  const unemploymentPaid = (payroll.unemploymentPaidVoucherUnits || 0) / voucherScale;
  const arrears = Object.values(view.payroll?.arrearsVoucherUnits || {}).reduce((sum, value) => sum + value, 0) / voucherScale;
  return `<h2>粮食与粮券账目</h2>
    <div class="cardlet"><div class="row"><span class="label">居民账（口粮当量）</span><strong class="value">${number(view.accounts.residents.qeq)} 斤</strong></div><div class="subtle">${accountLines(view.accounts.residents)}</div><div class="row" style="margin-top:10px"><span class="label">镇库账（口粮当量）</span><strong class="value">${number(view.accounts.town.qeq)} 斤</strong></div><div class="subtle">${accountLines(view.accounts.town)}</div><div class="row" style="margin-top:9px;padding-top:8px;border-top:1px solid #eee9db"><span class="label">全镇可食口粮合计</span><strong class="value">${number(view.totalQeq)} 斤</strong></div><div class="subtle">居民每日消费${number(view.dailyNeed)}斤；口粮${numberMax(view.residentFoodDays, 1)}天。</div></div>
    <h3>本年收支（已过${number(view.day)}天）</h3>
    <div class="cardlet"><div class="row"><span class="label">收成入库</span><strong class="value">${number(totals.harvest)}斤小麦</strong></div><div class="row"><span class="label">居民口粮消费</span><strong class="value">${number(totals.consumption)}口粮斤</strong></div><div class="row"><span class="label">镇营/施工工资计提 · 已付</span><strong class="value">${number(wageAccrued)} / ${number(wagePaid)}小麦等值</strong></div><div class="row"><span class="label">累计欠薪余额 / 本年失业金</span><strong class="value">${number(arrears)} / ${number(unemploymentPaid)}小麦等值</strong></div><div class="row"><span class="label">实物救济 / 加工损耗</span><strong class="value">${number(totals.relief)}斤小麦 / ${number(totals.processingLoss)}斤</strong></div><div class="subtle">工资、失业金、租金、商品和股份交易按实际支付媒介分别记账；农业税、救济口粮和生产税仍按实物记账。粮券先由镇库印制，镇库粮券可自由支出；换券时交出的小麦直接进入镇库，不设独立兑付储备。${moneyMixHint(view)}。</div></div>
    ${last ? `<h3>上一年汇总 · 第${number(last.year)}年</h3><div class="cardlet"><div class="row"><span class="label">年初至年末人口</span><strong class="value">${number(last.populationAtClose)} → ${number(last.populationAfterAging)}</strong></div><div class="row"><span class="label">出生 / 死亡</span><strong class="value">${number(last.births)} / ${number(last.deaths)} 人</strong></div><div class="subtle">显示上一年人口汇总。</div></div>` : ""}
    <h3>最近账目</h3><div class="ledger-list"><table class="ledger-table"><thead><tr><th>日期</th><th>缘由 / 去向</th><th style="text-align:right">数量</th></tr></thead><tbody>${rows || `<tr><td colspan="3">尚无账目。</td></tr>`}</tbody></table></div>`;
}
