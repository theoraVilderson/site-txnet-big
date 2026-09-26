import type { LineNameTemplateProblem } from "@/lib/tenant-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The page's strings as generated constants (C-06). */
export const BRANDING_KEYS = FrontendI18nKeys.common.resellerBranding;
const K = BRANDING_KEYS;

/** shared-core's `ResellerAccessRejection` (invariant 21): the only refusals the three routes this page calls have. */
export type BrandingRefusal = "not_allowed" | "reseller_not_found" | "reseller_suspended" | "reseller_terminated";

export const BRANDING_REFUSAL_KEYS: Record<BrandingRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this page knows. */
export function brandingRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in BRANDING_REFUSAL_KEYS ? BRANDING_REFUSAL_KEYS[reason as BrandingRefusal] : null;
}

/** Why a template would be refused, as the preview answers it. */
export const LINE_NAME_PROBLEM_KEYS: Record<LineNameTemplateProblem, string> = K.lineName.problems;

/** What a template may name (shared-core `LINE_NAME_PLACEHOLDERS`), offered as buttons that insert them. */
export const LINE_NAME_PLACEHOLDERS = ["brand", "region"] as const;
export const LINE_NAME_PLACEHOLDER_KEYS: Record<(typeof LINE_NAME_PLACEHOLDERS)[number], string> = K.lineName.placeholders;

/** tenant-service's cap (`MAX_LINE_NAME_TEMPLATE_LENGTH`), counted in characters as it counts them. */
export const MAX_LINE_NAME_TEMPLATE_LENGTH = 40;

/** A template as it will be stored: trimmed, and empty is `null`, the platform default. */
export function templateToSend(typed: string): string | null {
  const t = typed.trim();
  return t === "" ? null : t;
}

/** `typed` with `{placeholder}` put where the caret was, and where the caret goes after it. */
export function insertPlaceholder(typed: string, caret: number, placeholder: string): { value: string; caret: number } {
  const at = Math.max(0, Math.min(caret, typed.length));
  const token = `{${placeholder}}`;
  return { value: typed.slice(0, at) + token + typed.slice(at), caret: at + token.length };
}
