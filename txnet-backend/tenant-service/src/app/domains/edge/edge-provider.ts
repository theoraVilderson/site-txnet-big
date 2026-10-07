import { Prisma, TenantDomainEdgeProvider } from '@prisma/client';

/**
 * The CDN that holds a reseller's custom domain and issues its certificate
 * (ADR-0129 (5)). `tenant-service` speaks only this port; Cloudflare is its
 * first driver. Our `tenant_domain` table is the list of domains, and the
 * provider's copy is rebuilt from it — so `register` of a host the provider
 * already holds answers that registration, never a second one.
 *
 * One hostname, one certificate (F-109): a driver never adds a host to another
 * domain's certificate, so no SAN is ever shared between resellers.
 */

/** Where a registered hostname stands, as `tenant_domain.edgeStatus` stores it after `registering`. */
export type EdgeHostnameStatus = 'issuing' | 'issued' | 'renew_failed' | 'failed';

/**
 * A record the provider needs at the reseller's DNS before it serves the host.
 * Behind a reseller's own CDN it is Cloudflare's ownership TXT (EDGE-1-d); with
 * the CNAME straight to the target the provider proves ownership by the CNAME.
 */
export type EdgeRecord = { type: 'TXT'; name: string; value: string };

export type EdgeHostname = {
  /** The provider's id for the hostname (`tenant_domain.edgeHostnameId`). */
  id: string;
  host: string;
  status: EdgeHostnameStatus;
  /** The ownership record while the provider still asks for it; null once it no longer does. */
  ownership: EdgeRecord | null;
  /** What the provider reports as wrong, verbatim; `[]` when nothing is. */
  errors: string[];
};

export interface EdgeProvider {
  readonly name: TenantDomainEdgeProvider;
  /** Adds the host with its own certificate. A host already there answers with that registration. */
  register(host: string): Promise<EdgeHostname>;
  /** The hostname now; null when the provider no longer has it. */
  status(id: string): Promise<EdgeHostname | null>;
  /** Removes the hostname and its certificate. A hostname already gone is not an error. */
  remove(id: string): Promise<void>;
}

export const EDGE_PROVIDER = Symbol('EDGE_PROVIDER');

/**
 * What a provider's answer writes to `tenant_domain`: the registration, where
 * it stands, and the ownership record while the provider still asks for it
 * (EDGE-1-d). A record no longer asked for is cleared, so the page stops
 * showing it.
 */
export function edgeColumns(provider: TenantDomainEdgeProvider, hostname: EdgeHostname, now: Date) {
  return {
    edgeProvider: provider,
    edgeHostnameId: hostname.id,
    edgeStatus: hostname.status,
    edgeCheckedAt: now,
    edgeLastError: hostname.status === 'issued' || hostname.errors.length === 0 ? null : hostname.errors.join('; '),
    edgeOwnershipName: hostname.ownership?.name ?? null,
    edgeOwnershipValue: hostname.ownership?.value ?? null,
  } satisfies Prisma.TenantDomainUpdateManyMutationInput;
}

/** The provider refused or could not be reached; `detail` is what it said. */
export class EdgeProviderError extends Error {
  constructor(
    readonly operation: 'register' | 'status' | 'remove',
    readonly detail: string,
  ) {
    super(`edge ${operation} failed: ${detail}`);
    this.name = 'EdgeProviderError';
  }
}

/**
 * No provider configured (no `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID`):
 * every call refuses, so a caller counts an error rather than believing a
 * domain was registered.
 */
export class UnconfiguredEdgeProvider implements EdgeProvider {
  readonly name = TenantDomainEdgeProvider.cloudflare;

  register(): Promise<EdgeHostname> {
    return Promise.reject(new EdgeProviderError('register', 'no edge provider configured'));
  }

  status(): Promise<EdgeHostname | null> {
    return Promise.reject(new EdgeProviderError('status', 'no edge provider configured'));
  }

  remove(): Promise<void> {
    return Promise.reject(new EdgeProviderError('remove', 'no edge provider configured'));
  }
}
