import { escapeHtml, number, compact } from "./format.js";

// 宏观经济信息面板（金融扩展第一期）：右上角透明面板，折叠时摘要常显失业率。
// 国债/银行利率/流动性三行预留，后续期数接入后自动点亮。
const LIQUIDITY_LABEL = { tight: "偏紧", normal: "适中", loose: "宽松" };
const DASH = "—";

function row(label, valueHtml) {
  return `<div class="macro-row"><span>${escapeHtml(label)}</span><strong>${valueHtml}</strong></div>`;
}

function jin(value) {
  return value == null ? DASH : `${number(value)}斤`;
}

function voucher(value) {
  return value == null ? DASH : `${compact(value)}券`;
}

export function macroPanelSummary(view) {
  const macro = view.macro;
  if (!macro) return "宏观";
  let text = `宏观 · 失业${number(macro.unemploymentRate * 100, 1)}%`;
  if (macro.liquidityLevel && LIQUIDITY_LABEL[macro.liquidityLevel]) {
    text += ` · 流动性${LIQUIDITY_LABEL[macro.liquidityLevel]}`;
  }
  return text;
}

export function renderMacroPanel(view) {
  const macro = view.macro;
  if (!macro) return "";
  const marketCap = macro.listedCount > 0
    ? voucher(macro.stockMarketCapVoucher)
    : "暂无上市公司";
  const bond = macro.bondOutstandingVoucher > 0
    ? voucher(macro.bondOutstandingVoucher)
    : "未发行";
  const rates = macro.depositRateAnnualPercent == null || macro.loanRateAnnualPercent == null
    ? "银行系统未上线"
    : `存${number(macro.depositRateAnnualPercent, 2)}% / 贷${number(macro.loanRateAnnualPercent, 2)}%`;
  const liquidity = macro.liquidityLevel && LIQUIDITY_LABEL[macro.liquidityLevel]
    ? LIQUIDITY_LABEL[macro.liquidityLevel]
    : DASH;
  return row("失业率", `${number(macro.unemploymentRate * 100, 1)}%`)
    + row("民间小麦", jin(macro.residentWheatJin))
    + row("民间粮券", voucher(macro.residentVoucher))
    + row("镇库小麦", jin(macro.townWheatJin))
    + row("镇库粮券", voucher(macro.townVoucher))
    + row("小麦价格", macro.wheatPrice == null ? DASH : `${number(macro.wheatPrice, 2)}券/斤`)
    + row("股市总市值", marketCap)
    + row("国债余额", bond)
    + row("存/贷利率", rates)
    + row("流动性", liquidity);
}
