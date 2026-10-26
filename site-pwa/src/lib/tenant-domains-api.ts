// A reseller's custom domains (F-018-i) and the path each takes (NIN-1-e1),
// tenant `contract.domains.md` and `contract.domain-path.md`: their own module
// beside `tenant-api.ts`, on the same tenant-service caller.
import { call } from "./tenant-call";

/** A custom domain as the reseller sees it; `revalidating` is `verified` inside its grace. */
export type DomainStatus = "pending" | "verifying" | "verified" | "revalidating" | "failed";
/** Prisma's `TenantDomainPurpose`. */
export type DomainPurpose = "panel" | "subscription" | "assets" | "legacy_sub";
export type CheckName = "txt" | "cname" | "address" | "http" | "https" | "door" | "websocket" | "cache" | "edge_owner";
/** Prisma's `TenantDomainPath`: our Cloudflare, or the reseller's own edge account (NIN-1-e1, ADR-0165 point 7). */
export type DomainPath = "platform_cdn" | "own_edge";
/** A path the platform offers, with what it points at (`tenant/contract.domain-path.md` "Routes"). */
export interface PathOffer {
  path: DomainPath;
  target: string;
  /** The origin port an own edge sends to; null on ours. */
  port: number | null;
  /** The approved edges' names (`scripts/edge/edges.json`), own edge only. */
  edges: string[];
}
/** Prisma's `TenantDomainEdgeStatus`: the domain's step at the CDN (EDGE-1-e). */
export type EdgeStatus = "none" | "registering" | "issuing" | "issued" | "renew_failed" | "failed";
/** One line of a check: what it expected, what it found (`tenant/contract.domains.md` "What a check is"). */
export interface CheckLine {
  check: CheckName;
  expected: string[];
  found: string[];
  ok: boolean;
}

/** The domain view (`tenant/contract.domains.md` "The routes"). */
export interface ResellerDomain {
  id: string;
  domainValue: string;
  purpose: DomainPurpose;
  status: DomainStatus;
  /** The record to publish at the reseller's own DNS provider. */
  record: { type: "TXT"; name: string; value: string };
  /** How it reaches us; `switching` while a verified domain's new path is unproven (NIN-1-e1). */
  path: DomainPath;
  switching: boolean;
  /** Where the domain, or its CDN's origin, points: its path's target. */
  cnameTarget: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheck: { at: string; ok: boolean; lines: CheckLine[] } | null;
  /**
   * The domain at the CDN. `record` is the edge's ownership TXT while it still
   * asks for it: needed behind the reseller's own CDN, where the edge answers
   * 409 until it is published (EDGE-1-d).
   */
  edge: {
    status: EdgeStatus;
    record: { type: "TXT"; name: string; value: string } | null;
    lastError: string | null;
  };
}

/**
 * A reseller's custom domains (F-018-i), by the reseller the path names
 * (ADR-0064): the owner, a staff seat with `domain.manage`, or platform staff
 * are admitted there (invariant 21) — so no permission key is checked here.
 */
export const resellerDomainsApi = {
  async list(tenantId: string): Promise<ResellerDomain[]> {
    return call<ResellerDomain[]>(`/tenants/${encodeURIComponent(tenantId)}/domains`, { method: "GET" });
  },
  async add(tenantId: string, body: { domainValue: string; purpose: DomainPurpose; path?: DomainPath }): Promise<ResellerDomain> {
    return call<ResellerDomain>(`/tenants/${encodeURIComponent(tenantId)}/domains`, { method: "POST", body: JSON.stringify(body) });
  },
  /** The paths offered, ours first; own edge only where the platform has a domestic domain (NIN-1-e1). */
  async paths(tenantId: string): Promise<PathOffer[]> {
    return call<PathOffer[]>(`/tenants/${encodeURIComponent(tenantId)}/domains/paths`, { method: "GET" });
  },
  /** A verified domain keeps routing while its new path is checked (`switching`). */
  async setPath(tenantId: string, domainId: string, path: DomainPath): Promise<ResellerDomain> {
    return call<ResellerDomain>(
      `/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domainId)}/path`,
      { method: "PUT", body: JSON.stringify({ path }) },
    );
  },
  /** `pending` / `failed` -> `verifying`; the sweep does the checking, within five minutes. */
  async check(tenantId: string, domainId: string): Promise<ResellerDomain> {
    return call<ResellerDomain>(
      `/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domainId)}/check`,
      { method: "POST" },
    );
  },
};
