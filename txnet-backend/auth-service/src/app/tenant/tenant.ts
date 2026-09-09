import { Request } from 'express';

/**
 * How a request's tenant was decided (ADR-0025, catalog C-01).
 *
 * The chain is ordered, and the order is the point: a claim carried by the
 * request outranks the host it arrived on, because the host is the surface and
 * the claim is the identity. There is no fourth entry: ADR-0025 removed the
 * deployment fallback, so a request that matches none of these has no tenant
 * and is refused rather than absorbed (F-1210).
 */
export type TenantVia = 'session' | 'bot' | 'domain';

/**
 * The tenant a request belongs to (ADR-0020, ADR-0025).
 *
 * A **resolved** tenant, not the whole row: the id is what every scoped query
 * needs, and the slug is what a log line has to say for a refusal to be
 * diagnosable at all. Anything more — branding, entitlements — is a separate
 * read by whoever actually needs it, and belongs to F-018.
 */
export interface ResolvedTenant {
  id: string;
  slug: string;
  /**
   * Which entry of the chain answered. `session` and `bot` mean the request
   * named its tenant and the surface agreed (or had nothing to say); `domain`
   * means a `tenant_domain` row matched the host. Nothing else answers — a
   * request with no claim and no surface resolves to `null` and is refused
   * (ADR-0025), so `via` is now a fact about which proof was used rather than
   * a warning about which fallback fired.
   */
  via: TenantVia;
}

/**
 * What a request says about its own tenant, before anything is looked up.
 *
 * Every field is a *claim*, not an answer: assembled at the edge, weighed by
 * `TenantResolverService.resolve`. Splitting the claim from the resolution is
 * what keeps F-1209 true — the edge is the one place that touches a header,
 * and the resolver is the one place that decides.
 */
export type TenantClaim = {
  /** The host the request arrived on, unnormalized. */
  host?: string | null;
  /**
   * The tenant an authenticated session asserts — `tenantId` out of an access
   * token whose signature has already been checked. A token is not a client
   * input: forging one requires the signing secret, which is why this may
   * outrank the host at all (ADR-0025 forecloses resolving from anything a
   * client can simply set).
   */
  session?: string | null;
  /**
   * The tenant a calling service asserts on behalf of a bot chat. Trusted
   * **only** when `x-service-token` verified — the edge is responsible for not
   * filling this in otherwise, so the resolver never has to ask who is asking.
   */
  bot?: string | null;
};

/** Which tenant a service caller is acting for. Honoured only from a verified
 * service caller — see {@link TenantClaim.bot}. Named after catalog C-01's
 * header so a single name survives into the platform-staff case. */
export const TENANT_ID_HEADER = 'x-tenant-id';

/**
 * Thrown when a request's claimed tenant and its surface's tenant disagree
 * (ADR-0024 decision 4).
 *
 * This is the leak ADR-0024 records, refused: a tenant-A session presented on
 * tenant-B's host used to resolve to whichever of the two the reader happened
 * to consult. Refusing is the only answer that cannot be wrong — picking either
 * side serves one tenant's data under the other's brand.
 */
export class TenantClaimConflict extends Error {
  constructor(
    readonly claimed: string,
    readonly surface: ResolvedTenant,
  ) {
    super(
      `A request claiming tenant ${claimed} arrived on a surface belonging to ` +
        `tenant ${surface.id} (${surface.slug}). It is refused, not resolved.`,
    );
    this.name = 'TenantClaimConflict';
  }
}

/**
 * The host, reduced to the form `tenant_domain.domainValue` is stored in.
 *
 * Pure, and separate from the lookup, so the rule can be asserted without a
 * database — the same split `common/security/switch-scope.ts` makes.
 */
export function normalizeHost(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;

  if (host.startsWith('[')) {
    // An IPv6 literal is bracketed and its port sits outside the brackets:
    // `[::1]:3001`. Splitting on the first colon would truncate the address.
    const close = host.indexOf(']');
    if (close === -1) return null; // malformed — no host to speak of
    host = host.slice(0, close + 1);
  } else {
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }

  // A fully-qualified name may carry the root dot: `myvpn.com.` is `myvpn.com`.
  host = host.replace(/\.+$/, '');
  return host || null;
}

/**
 * The tenant this request resolved to, or `null` when it resolved to none.
 *
 * `null` is a real answer and never a reason to guess: an unknown or
 * unverified host names no tenant, and inventing one would serve a stranger's
 * request as the platform owner. `TenantRequiredGuard` turns it into a neutral
 * 404 before any handler runs (ADR-0025, F-1210).
 *
 * Set by `TenantMiddleware`, which runs on every route.
 *
 * @deprecated since 2026-09-09 (ADR-0024), remove after F-066-b. Application
 * code reads `TenantContext.current()` instead — the request object is not
 * reachable from a service, which is the whole reason the tenant used to be
 * threaded through signatures. The one remaining caller is
 * `TenantContextMiddleware`, which turns this into the ambient scope.
 */
export function resolveTenant(req: Request): ResolvedTenant | null {
  return (req as { tenant?: ResolvedTenant | null }).tenant ?? null;
}

/**
 * The disagreement this request was refused for, if it was.
 *
 * Recorded by `TenantMiddleware` and read by `TenantAgreementGuard`, rather
 * than thrown out of the middleware: a global exception filter does not catch
 * what Express middleware throws, so a refusal raised there would leave the
 * client with an untranslated 500 instead of the envelope every other error
 * uses.
 */
export function tenantConflict(req: Request): TenantClaimConflict | null {
  return (req as { tenantConflict?: TenantClaimConflict }).tenantConflict ?? null;
}
