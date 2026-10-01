import { ApiError } from "@/lib/api-error";
import type { ResellerLimitKey } from "@/lib/tenant-api";

/** shared-core's `RESELLER_LIMITS`, in its order; `resellers/limits.test.tsx` holds the two together. */
export const RESELLER_LIMIT_KEYS = [
  "user_metered_cap_max",
  "platform_open_grants_max",
  "admin_issues_30d_max",
  "custom_domains_max",
  "staff_members_max",
] as const satisfies readonly ResellerLimitKey[];

/**
 * Keys whose refusal is not a count: `user_metered_cap_max` bounds a number
 * typed, and billing's `used` is that number, with a sentence of its own
 * (`grantLimitAboveCeiling`, `entitlement/contract.limits.md`).
 */
const NOT_A_COUNT: readonly ResellerLimitKey[] = ["user_metered_cap_max"];

const isCountedKey = (key: unknown): key is ResellerLimitKey =>
  (RESELLER_LIMIT_KEYS as readonly unknown[]).includes(key) && !(NOT_A_COUNT as readonly unknown[]).includes(key);

/**
 * A `reseller_limit_reached` refusal's figures (`tenant/contract.limits.md`):
 * the key, the limit and what is used — or `null` when the error is another,
 * names a key this panel has no name for, or one that is not a count. Then
 * the server's text stands.
 */
export function resellerLimitReachedOf(e: unknown): { key: ResellerLimitKey; limit: number; used: number } | null {
  if (!(e instanceof ApiError) || e.reason !== "reseller_limit_reached") return null;
  const { key, limit, used } = e.facts;
  return isCountedKey(key) && typeof limit === "number" && typeof used === "number" ? { key, limit, used } : null;
}
