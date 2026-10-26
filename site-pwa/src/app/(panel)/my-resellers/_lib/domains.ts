import { getDomain } from "tldts";

import type { CheckName, DomainPath, DomainPurpose, DomainStatus, EdgeStatus, PathOffer, ResellerDomain } from "@/lib/tenant-domains-api";
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
  | "domain_reserved"
  | "own_edge_unavailable";

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

/**
 * Live = verified (or inside its grace) and its certificate issued (ADR-0129
 * (3)) — or verified on its own edge, which holds no certificate of ours (NIN-1-e1).
 */
export const isLive = (status: DomainStatus, edge: EdgeStatus, path: DomainPath) =>
  isRoutable(status) && (edge === "issued" || isOwnEdge(path));

/** The reseller's own edge account, not our Cloudflare (NIN-1-e1): no Custom Hostname, no certificate of ours. */
export const isOwnEdge = (path: DomainPath) => path === "own_edge";

/** Prisma's `TenantDomainPath`, ours first: the default, as the add route takes it (NIN-1-e3). */
export const DOMAIN_PATHS = ["platform_cdn", "own_edge"] as const satisfies readonly DomainPath[];
/** The offers in that order, whatever order they arrived in: ours stays the first choice. */
export const offersInOrder = (offers: readonly PathOffer[]) => DOMAIN_PATHS.flatMap((p) => offers.filter((o) => o.path === p));
export const PATH_KEYS: Record<DomainPath, string> = { platform_cdn: K.path.platform_cdn, own_edge: K.path.own_edge };

/** An approved edge's name as people know it (`scripts/edge/edges.json` names), or null for one with no label yet. */
export function edgeLabelKey(name: string): string | null {
  const names: Record<string, string> = K.edgeNames;
  return names[name] ?? null;
}

/** One thing to set in the reseller's own edge account: copied as is, or a word the page says (`key`). */
export type OwnEdgeSetting = { id: "origin" | "port" | "protocol" | "host" | "cloud" | "websocket"; value: string; copy: boolean; key?: string };

/**
 * What the reseller sets in its own edge account (ADR-0165 point 7): our
 * target as the origin, on the domestic door's port over HTTPS, the
 * visitor's host kept (ADR-0063: the target serves nothing), the cloud on so
 * DNS never names our address, and WebSockets for live updates. The checks
 * `door`, `address` and `websocket` fail each one left out.
 */
export function ownEdgeSettings(offer: Pick<PathOffer, "target" | "port">, host: string): OwnEdgeSetting[] {
  return [
    { id: "origin", value: offer.target, copy: true },
    { id: "port", value: String(offer.port ?? ""), copy: true },
    { id: "protocol", value: "HTTPS", copy: false },
    { id: "host", value: host, copy: true, key: K.own.hostVisitor },
    { id: "cloud", value: "", copy: false, key: K.own.on },
    { id: "websocket", value: "", copy: false, key: K.own.on },
  ];
}

/** A row of the records table. */
export type DnsRecord = { type: string; name: string; value: string };

/**
 * The records the reseller publishes at its DNS: the TXT always; on ours the
 * CNAME to the target, and the edge's ownership TXT while it asks. On its own
 * edge the origin is set in the edge account instead ({@link ownEdgeSettings}).
 */
export function domainRecords(d: Pick<ResellerDomain, "domainValue" | "record" | "cnameTarget" | "edge" | "path">): DnsRecord[] {
  const own = isOwnEdge(d.path);
  return [
    { type: d.record.type, name: d.record.name, value: d.record.value },
    ...(own ? [] : [{ type: "CNAME", name: d.domainValue, value: d.cnameTarget }]),
    ...(!own && d.edge.record ? [d.edge.record] : []),
  ];
}

/** An apex cannot be a Custom Hostname below Enterprise (D1), so only our Cloudflare path refuses one. */
export const apexRefused = (host: string, path: DomainPath) => !isOwnEdge(path) && isApex(host);

/** The registrable domain, by the public suffix list: `shop.co.ir`, not `co.ir`. `_` labels are DNS names, not hosts. */
const zoneOf = (name: string) => getDomain(name, { validateHostname: false }) ?? name;

/**
 * The zone itself is an apex (`example.com`, `shop.co.ir`), which a Custom
 * Hostname cannot be below Enterprise (ADR-0129 Consequences).
 */
export const isApex = (host: string) => zoneOf(host) === host;

/**
 * A record's name as a DNS panel takes it (EDGE-1-o, D-72): relative to the
 * domain's zone, `@` for the zone itself. ArvanCloud and most others append the
 * zone to what is typed, so a pasted full name lands one zone too deep.
 */
export function dnsName(full: string): { short: string; zone: string; full: string } {
  const zone = zoneOf(full);
  return { short: full === zone ? "@" : full.slice(0, -(zone.length + 1)), zone, full };
}

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
export const DOMAIN_PURPOSES = ["panel", "subscription", "assets", "legacy_sub"] as const satisfies readonly DomainPurpose[];

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
