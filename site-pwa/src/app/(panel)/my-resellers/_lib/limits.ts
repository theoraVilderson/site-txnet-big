import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ResellerLimitInEffect } from "@/lib/tenant-api";

/** The workspace's limits card strings (C-06). */
export const MY_LIMIT_KEYS = FrontendI18nKeys.common.resellerOnboarding.limits;

export type LimitReading = {
  /** Which line of `MY_LIMIT_KEYS` says it. */
  text: "usedOf" | "usedNoLimit" | "upTo" | "noLimit";
  vars: Record<string, number> | undefined;
  /** At or past the limit: the next one is refused. */
  full: boolean;
  /** 0..1 for the bar; `null` when there is nothing to fill. */
  share: number | null;
};

/**
 * How one key reads on the workspace (F-019-s, `panel-web/contract.reseller-limits.md`):
 * tenant-service's `limit` and `used` as they came — `null` limit is no limit,
 * `null` used is a key that counts nothing (the per-user ceiling, checked
 * against the number typed). Nothing is counted or resolved here.
 */
export function limitReading(row: ResellerLimitInEffect): LimitReading {
  const { limit, used } = row;
  if (used === null) return limit === null ? { text: "noLimit", vars: undefined, full: false, share: null } : { text: "upTo", vars: { limit }, full: false, share: null };
  if (limit === null) return { text: "usedNoLimit", vars: { used }, full: false, share: null };
  const full = used >= limit;
  return { text: "usedOf", vars: { used, limit }, full, share: full ? 1 : used / limit };
}
