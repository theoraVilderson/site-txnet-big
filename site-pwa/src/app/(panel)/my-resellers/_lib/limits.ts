import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ResellerLimitInEffect, SubscriptionChangePreview } from "@/lib/tenant-api";

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

/** The workspace's quota, spend-cap and upgrade strings (C-06). */
export const MY_QUOTA_KEYS = FrontendI18nKeys.common.resellerOnboarding.quotas;

/**
 * Units included and used of them (F-019-v10): a bar, **Full** at or past what
 * is included — the next unit is then sold past it or refused. `included: null`
 * is no bound: nothing to fill.
 */
export function includedReading(included: number | null, used: number): { share: number | null; full: boolean } {
  if (included === null) return { share: null, full: false };
  const full = used >= included;
  return { share: full ? 1 : used / included, full };
}

/** A spend cap typed: 0 or more, at most two places (`0` = no extras at all); `undefined` keeps save off. */
export function capAmountOf(typed: string): string | undefined {
  const v = typed.trim();
  return /^\d{1,16}(\.\d{1,2})?$/.test(v) ? v : undefined;
}

/** Two decimal strings compared exactly (C-02): negative, zero or positive; `null` if either is unreadable. */
export function compareAmounts(a: string, b: string): number | null {
  const scaled = (v: string): bigint | null => {
    const m = /^(-)?(\d+)(?:\.(\d{1,8}))?$/.exec(v.trim());
    if (!m) return null;
    const n = BigInt(m[2] + (m[3] ?? "").padEnd(8, "0"));
    return m[1] ? -n : n;
  };
  const x = scaled(a);
  const y = scaled(b);
  if (x === null || y === null) return null;
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * What a package change would do, as the preview says (F-019-v7, ADR-0107
 * point 9): `now` — charged at once, prorated; `short` — the wallet holds less
 * than that, so the service would refuse (`insufficient_balance`); `renewal` —
 * a cheaper one waits; `none` — the package it holds. Nothing is priced here.
 */
export function changeVerdict(p: SubscriptionChangePreview): "now" | "short" | "renewal" | "none" {
  if (p.when !== "now") return p.when;
  const c = compareAmounts(p.balance, p.charge);
  return c !== null && c < 0 ? "short" : "now";
}
