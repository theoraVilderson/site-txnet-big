import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ConsentView } from "@/lib/auth-api";

/** The support-access strings, both sides (C-06). */
export const SUPPORT_KEYS = FrontendI18nKeys.common.supportAccess;

/**
 * Every refusal the consent surface names (auth `SupportConsentRejection`) and
 * the door's two (shared-core `SupportConsentRefused`, F-117-b), each with its
 * own sentence. A reason not here keeps the generic answer.
 */
export type SupportRefusal = keyof typeof SUPPORT_KEYS.refusals;

export function supportRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in SUPPORT_KEYS.refusals ? SUPPORT_KEYS.refusals[reason as SupportRefusal] : null;
}

/** `SUPPORT_CONSENT_MAX_HOURS` (shared-core): a grant and the default both live 1..24 hours. */
const MAX_HOURS = 24;

/** Hours typed: a whole number 1..24, else `undefined` and nothing is sent. */
export function hoursOf(typed: string): number | undefined {
  const v = typed.trim();
  if (!/^\d{1,2}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 && n <= MAX_HOURS ? n : undefined;
}

/**
 * What is left of an access, rounded **up** to the minute: one still open
 * never reads "0 minutes". `null` once it has run out, or with no end.
 */
export function timeLeft(until: string | null, now: number): { hours: number; minutes: number } | null {
  if (!until) return null;
  const ms = Date.parse(until) - now;
  if (!(ms > 0)) return null;
  const total = Math.ceil(ms / 60_000);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/**
 * The open request, the live grant and the rest, by the `state` the service
 * derived — never by comparing dates here. The service keeps one of each at
 * most (one open request; a grant revokes the one before it).
 */
export function consentSides(items: readonly ConsentView[]): { pending: ConsentView | null; live: ConsentView | null; past: ConsentView[] } {
  return {
    pending: items.find((c) => c.state === "requested") ?? null,
    live: items.find((c) => c.state === "live") ?? null,
    past: items.filter((c) => c.state !== "requested" && c.state !== "live"),
  };
}
