import type { CheckName, DomainPurpose, DomainStatus, EdgeStatus } from "@/lib/tenant-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { holdsPermission } from "@/lib/permissions";
import { tenantChannel, userChannel } from "@/lib/realtime";

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
export const EDGE_STATUS_KEYS: Record<EdgeStatus, string> = K.edge.status;
export const EDGE_HINT_KEYS: Record<EdgeStatus, string> = K.edge.hint;

/** Live = verified (or inside its grace) and its certificate issued (ADR-0129 (3)). */
export const isLive = (status: DomainStatus, edge: EdgeStatus) => isRoutable(status) && edge === "issued";

/**
 * Two labels is an apex (`example.com`), which a Custom Hostname cannot be
 * below Enterprise (ADR-0129 Consequences). A suffix of two labels
 * (`example.co.uk`) is not told apart without the public suffix list.
 */
export const isApex = (host: string) => host.split(".").length === 2;

/** What the page re-reads on (RT-1-e): the domain service writes it on every change of status or edge step. */
export const DOMAIN_LIVE_EVENTS: readonly string[] = [RealtimeEvents.tenantDomainChanged];

/**
 * Where that event reaches this viewer: the reseller owner's own `user:`
 * channel, and the platform's `tenant:` channel for its staff — the page is
 * on the platform's panel. `null` where the viewer has no such channel.
 */
export function domainLiveChannels(
  userId: string | null,
  me: { tenant: { id: string }; permissions: readonly string[] } | null | undefined,
): [string | null, string | null] {
  return [
    userId ? userChannel(userId) : null,
    me && holdsPermission(me.permissions, "realtime.tenant.read") ? tenantChannel(me.tenant.id) : null,
  ];
}

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
