import { escapeHtml } from "./format.js";

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

export function parseNumericDraft(rawValue, options = {}) {
  const label = options.label || "数值";
  const raw = String(rawValue ?? "").trim();
  if (!raw) return { ok: false, reason: `请输入${label}。` };
  if (!NUMBER_PATTERN.test(raw)) return { ok: false, reason: `${label}格式不正确，请输入数字。` };

  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value)) return { ok: false, reason: `${label}必须是有限数值。` };
  if (options.integer && !Number.isInteger(value)) return { ok: false, reason: `${label}必须是整数。` };
  if (options.positive && value <= 0) return { ok: false, reason: `${label}必须大于0。` };
  if (options.minimum !== undefined && value < options.minimum) {
    return { ok: false, reason: `${label}不能小于${options.minimum}。` };
  }
  if (options.maximum !== undefined && value > options.maximum) {
    return { ok: false, reason: `${label}不能超过${options.maximum}。` };
  }
  return { ok: true, value };
}

export function shouldDeferNumericPanelRender(panel, activeElement) {
  return Boolean(
    panel && activeElement && panel.contains(activeElement) &&
    activeElement.matches("[data-draft-key]")
  );
}

export function shouldCommitNumericDraftOnChange(kind) {
  return kind === "wage" || kind === "company-wage";
}

export function renderNumericInput(view, options) {
  const key = String(options.key);
  const draft = view.numericDrafts?.[key];
  const shownValue = draft ? draft.value : String(options.value ?? "");
  const disabled = Boolean(options.disabled);
  const attributes = [
    `type="text"`,
    `inputmode="${options.integer ? "numeric" : "decimal"}"`,
    `enterkeyhint="done"`,
    `autocomplete="off"`,
    `spellcheck="false"`,
    `value="${escapeHtml(shownValue)}"`,
    `aria-label="${escapeHtml(options.label)}"`,
    `data-draft-key="${escapeHtml(key)}"`,
    `data-draft-kind="${escapeHtml(options.kind)}"`,
    `data-draft-target="${escapeHtml(options.target)}"`,
    `data-draft-label="${escapeHtml(options.label)}"`,
    `data-draft-minimum="${options.minimum ?? 0}"`,
    `data-draft-integer="${Boolean(options.integer)}"`,
    `data-draft-positive="${Boolean(options.positive)}"`
  ];
  if (options.maximum !== undefined) attributes.push(`data-draft-maximum="${options.maximum}"`);
  if (disabled) attributes.push("disabled");
  if (draft?.error) attributes.push('aria-invalid="true"');

  const confirmLabel = options.confirmLabel || "确认";
  return `<div class="number-editor ${escapeHtml(options.className || "")}">
    <div class="number-editor-control"><input ${attributes.join(" ")}><button type="button" class="draft-confirm" data-draft-commit="${escapeHtml(key)}" aria-label="确认${escapeHtml(options.label)}" ${disabled ? "disabled" : ""}>${escapeHtml(confirmLabel)}</button></div>
    <span class="input-error" data-draft-error="${escapeHtml(key)}" aria-live="polite" ${draft?.error ? "" : "hidden"}>${escapeHtml(draft?.error || "")}</span>
  </div>`;
}
