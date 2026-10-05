import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import { AI_OFFER_REFUSALS } from "@/lib/ai-api";

export const K = FrontendI18nKeys.common.ai;

export const input =
  "w-full rounded-xl border border-card-border bg-[var(--bg-inner)] px-3 py-2.5 text-sm text-[var(--text-input)] placeholder:text-[var(--text-label)] transition-colors hover:border-[var(--accent-primary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)] disabled:opacity-60";
export const primaryButton = "rounded-2xl bg-primary px-5 py-2.5 text-sm font-bold text-on-accent hover:brightness-110 disabled:opacity-50";
export const card = "rounded-3xl border border-card-border bg-card-bg p-5";

/** ai's refusal worded by its reason; anything else is the page's generic line. */
export function refusalKey(e: unknown): string | null {
  const reason = e instanceof ApiError ? e.reason : undefined;
  return reason && (AI_OFFER_REFUSALS as readonly string[]).includes(reason) ? K.refused[reason as (typeof AI_OFFER_REFUSALS)[number]] : null;
}

/** The server's bounds, held here too so a value it would refuse is never sent (ai contract.admin.md rule 4). */
export const THRESHOLD_RE = /^(0(\.\d{1,2})?|1(\.0{1,2})?)$/;
export const PERCENT_RE = /^\d{1,3}(\.\d{1,2})?$/;
export const AMOUNT_RE = /^\d{1,16}(\.\d{1,2})?$/;
export const HOLDOUT = { min: 5, max: 20 } as const;
