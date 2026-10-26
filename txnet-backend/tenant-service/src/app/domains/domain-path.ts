import { DomainVerificationStatus, Prisma, TenantDomainPath } from '@prisma/client';
import { cnameTargetHost } from '@txnet-backend/shared-core';

/**
 * How a reseller's custom domain reaches the platform (ADR-0165 point 7,
 * NIN-1-e1). Pure: the service reads the config once and asks these.
 *
 * - `platform_cdn` — our Cloudflare, as before: a Custom Hostname on the
 *   platform zone, CNAME to `<slug>.edge.<DOMAIN_NAME>` (ADR-0129). It closes
 *   when the internet goes national.
 * - `own_edge` — the reseller's own account at an approved edge (Arvan
 *   first). Its origin is `<slug>.edge.<DOMESTIC_DOMAIN_NAME>` on the domestic
 *   door's port, a DNS-only name to the nodes that serves nothing as itself
 *   (ADR-0063), so it never chains through our CDN. Never a Custom Hostname:
 *   no reseller's domain enters an account of ours.
 */

/** The domestic door's port (hosting O12): what an own edge sends its origin requests to. */
export const OWN_EDGE_PORT = 8443;

/** The platform's two domains and the domestic door's approved edges, from the validated env. */
export type PlatformDomains = { domain: string; domestic: string; ownEdges: readonly string[] };

/** One path a reseller may choose, with what it points the domain at. `edges`: who may sit in front (own edge only). */
export type PathOffer = { path: TenantDomainPath; target: string; port: number | null; edges: readonly string[] };

/** Own edge needs a domestic domain to point at and an edge its door admits. */
export function ownEdgeOffered(domains: PlatformDomains): boolean {
  return domains.domestic !== '' && domains.ownEdges.length > 0;
}

/** Where a domain on `path` points: its reseller's own target on that path's domain. */
export function targetOf(path: TenantDomainPath, slug: string, domains: PlatformDomains): string {
  return cnameTargetHost(slug, path === TenantDomainPath.own_edge ? domains.domestic : domains.domain);
}

/** The paths this platform offers a reseller, ours first (the default). */
export function pathOffers(slug: string, domains: PlatformDomains): PathOffer[] {
  const ours: PathOffer = { path: TenantDomainPath.platform_cdn, target: targetOf(TenantDomainPath.platform_cdn, slug, domains), port: null, edges: [] };
  if (!ownEdgeOffered(domains)) return [ours];
  return [ours, { path: TenantDomainPath.own_edge, target: targetOf(TenantDomainPath.own_edge, slug, domains), port: OWN_EDGE_PORT, edges: domains.ownEdges }];
}

/** A host inside either of the platform's domains is the platform's, never a reseller's to add. */
export function isReservedHost(host: string, domains: PlatformDomains): boolean {
  return [domains.domain, domains.domestic].some((base) => base !== '' && (host === base || host.endsWith(`.${base}`)));
}

/**
 * The rows the Cloudflare edge holds (ADR-0129 amendment 3): verified, or
 * verifying with ownership proven — on our CDN, or a verified domain still
 * moving off it, whose Custom Hostname serves until the new path is proven.
 */
export const HELD: Prisma.TenantDomainWhereInput[] = [
  { verificationStatus: DomainVerificationStatus.verified, edgePath: TenantDomainPath.platform_cdn },
  { verificationStatus: DomainVerificationStatus.verified, pathSwitchedAt: { not: null } },
  { verificationStatus: DomainVerificationStatus.verifying, ownershipProvenAt: { not: null }, edgePath: TenantDomainPath.platform_cdn },
];

/** Rows the edge must let go of: no longer held, or settled on an own edge. */
export const RELEASED: Prisma.TenantDomainWhereInput[] = [
  {
    verificationStatus: { not: DomainVerificationStatus.verified },
    edgeHostnameId: { not: null },
    OR: [{ verificationStatus: { not: DomainVerificationStatus.verifying } }, { ownershipProvenAt: null }],
  },
  { edgeHostnameId: { not: null }, edgePath: TenantDomainPath.own_edge, pathSwitchedAt: null },
];

type HeldRow = { verificationStatus: DomainVerificationStatus; ownershipProvenAt: Date | null; edgePath: TenantDomainPath; pathSwitchedAt: Date | null };

/** {@link HELD}, for one row in hand. */
export function isHeld(row: HeldRow): boolean {
  const onOurs = row.edgePath === TenantDomainPath.platform_cdn;
  if (row.verificationStatus === DomainVerificationStatus.verified) return onOurs || row.pathSwitchedAt !== null;
  return row.verificationStatus === DomainVerificationStatus.verifying && row.ownershipProvenAt !== null && onOurs;
}
