import type { CheckName, DomainPurpose, DomainStatus } from "@/lib/tenant-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The page's strings as generated constants (C-06). */
export const DOMAIN_KEYS = FrontendI18nKeys.common.resellerDomains;
const K = DOMAIN_KEYS;

/**
 * Every reason the three domain routes refuse with: shared-core's
 * `ResellerAccessRejection` (invariant 21) and tenant-service's own
 * `DomainRejection`. The spec reads both unions from source.
 */
export type DomainRefusal =
  | "not_allowed"
  | "reseller_not_found"
  | "reseller_suspended"
  | "reseller_terminated"
  | "domain_not_found"
  | "domain_taken"
  | "domain_reserved";

export const DOMAIN_REFUSAL_KEYS: Record<DomainRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this page knows. */
export function domainRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in DOMAIN_REFUSAL_KEYS ? DOMAIN_REFUSAL_KEYS[reason as DomainRefusal] : null;
}

export const DOMAIN_STATUS_KEYS: Record<DomainStatus, string> = K.status;
export const CHECK_LINE_KEYS: Record<CheckName, string> = K.lines;

/** `panel` first: it is the one that lifts the onboarding gate (`contract.domains.md` rule 6). */
export const DOMAIN_PURPOSES = ["panel", "subscription", "assets"] as const satisfies readonly DomainPurpose[];

/** Only `verified` routes; `revalidating` is `verified` inside its grace. */
export const isRoutable = (status: DomainStatus) => status === "verified" || status === "revalidating";

/** The check route moves `pending` and `failed` to `verifying` and returns any other status as it is. */
export const canRequestCheck = (status: DomainStatus) => status === "pending" || status === "failed";

/** tenant-service's `addDomainSchema`: two labels at least, each a DNS label, the last not numeric. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host to send, or `null` where the schema would refuse it. A pasted
 * address loses its scheme and path — what an owner copies from the browser
 * bar — but a port is still refused, as the schema does: it is a typo, not a
 * host.
 */
export function domainHost(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.+$/, "");
  if (host.includes(":")) return null;
  return HOST.test(host) ? host : null;
}
