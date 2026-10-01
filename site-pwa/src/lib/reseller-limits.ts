import { ApiError } from "@/lib/api-error";
import type { ResellerLimitKey } from "@/lib/tenant-api";

/** shared-core's `RESELLER_LIMITS`, in its order; `resellers/limits.test.tsx` holds the two together. */
export const RESELLER_LIMIT_KEYS = [
  "user_metered_cap_max",
  "platform_open_grants_max",
  "admin_issues_30d_max",
  "custom_domains_max",
  "staff_members_max",
  "bulk_job_grants_max",
  "campaign_sends_daily_max",
  "end_users_max",
  "platform_traffic_gib_monthly_max",
  "user_purchases_daily_max",
  "user_purchases_weekly_max",
  "user_purchases_monthly_max",
] as const satisfies readonly ResellerLimitKey[];

/**
 * `user_metered_cap_max` is said by billing itself: its `used` is the number
 * typed, with a sentence of its own (`grantLimitAboveCeiling`,
 * `entitlement/contract.limits.md`).
 */
const SAID_BY_SERVER: readonly ResellerLimitKey[] = ["user_metered_cap_max"];

/** Ceilings: `used` is the size asked for, not a count held — "at most N; this asks M" (F-019-t5). */
const CEILINGS: readonly ResellerLimitKey[] = ["bulk_job_grants_max"];

const isSaidHere = (key: unknown): key is ResellerLimitKey =>
  (RESELLER_LIMIT_KEYS as readonly unknown[]).includes(key) && !(SAID_BY_SERVER as readonly unknown[]).includes(key);

/**
 * A `reseller_limit_reached` refusal's figures (`tenant/contract.limits.md`):
 * the key, the limit and what is used — or `null` when the error is another,
 * names a key this panel has no name for, or one billing says itself. Then
 * the server's text stands.
 */
export function resellerLimitReachedOf(e: unknown): { key: ResellerLimitKey; limit: number; used: number; ceiling: boolean } | null {
  if (!(e instanceof ApiError) || e.reason !== "reseller_limit_reached") return null;
  const { key, limit, used } = e.facts;
  if (!isSaidHere(key) || typeof limit !== "number" || typeof used !== "number") return null;
  return { key, limit, used, ceiling: CEILINGS.includes(key) };
}

/** Why the engine refused a unit past a quota (`billing/contract.reseller-quota.md` rule 6). */
export const QUOTA_STOP_REASONS = ["stop", "wallet_empty", "spend_cap", "price_unavailable"] as const;
export type QuotaStopReason = (typeof QUOTA_STOP_REASONS)[number];

/**
 * A `reseller_quota_exhausted` refusal the reseller is meant to read (F-019-v10):
 * why — an empty billing wallet, its own spend cap, a price not in the
 * wallet's currency, or `stop` — and the quota's key when the meter is one the
 * panel names (a product's meter is not). `null` with no `stoppedBy`: the
 * buyer's refusal carries no figures (ADR-0107 point 11) and keeps the server's text.
 */
export function resellerQuotaExhaustedOf(e: unknown): { stoppedBy: QuotaStopReason; key: ResellerLimitKey | null } | null {
  if (!(e instanceof ApiError) || e.reason !== "reseller_quota_exhausted") return null;
  const { stoppedBy, meter } = e.facts;
  if (!(QUOTA_STOP_REASONS as readonly unknown[]).includes(stoppedBy)) return null;
  const key = (RESELLER_LIMIT_KEYS as readonly unknown[]).includes(meter) ? (meter as ResellerLimitKey) : null;
  return { stoppedBy: stoppedBy as QuotaStopReason, key };
}
