import { IdentityHeaders } from '@txnet-backend/shared-core';
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
 * What the `tenant_domain` row a request arrived on is *for* (catalog 13.1 /
 * C-16, mirrored by `tenant.TenantDomainPurpose` in the schema).
 *
 * A tenant holds several domains at once and the roles never collapse onto one
 * host: the panel on a `panel` domain, subscription links on a `subscription`
 * one. All of them resolve to the same tenant — purpose is not a second
 * tenancy — but only a `panel` domain serves this process's routes.
 */
export type TenantSurfacePurpose = 'panel' | 'subscription' | 'assets';

/**
 * The paths each non-panel surface serves, as path prefixes.
 *
 * **Both lists are empty, and that is the answer rather than a gap** (F-066-q).
 * `auth-service` has no route a subscription or assets domain should ever
 * answer: every controller it holds is `/auth/*`, `/admin/*` or `/internal/*` —
 * panel, admin and service-caller routes without exception. The `/sub` link
 * catalog 13.1 names is `network`'s, and `network` has no service yet; when it
 * gains one, its prefix goes here in the same change.
 *
 * ASSUMED(2026-09-09): an `assets` domain serves nothing from this process
 * either. F-1212 names only `subscription`, but an assets host answering
 * `/auth/login` is the same bug under a different name, and denying is the
 * side that fails safe — see `docs/domains/tenant/open-questions.md`.
 */
const SERVED_PATHS: Record<Exclude<TenantSurfacePurpose, 'panel'>, readonly string[]> =
  {
    subscription: [],
    assets: [],
  };

/**
 * May a surface with this purpose serve this path? (F-066-q, catalog F-1212.)
 *
 * Pure, and separate from the guard that calls it, so the rule can be asserted
 * without an execution context — the same split {@link normalizeHost} makes.
 *
 * A prefix matches the path itself or a path below it, and never a longer
 * sibling: `/sub` would allow `/sub` and `/sub/abc`, never `/subscribers`.
 */
export function surfaceServesPath(
  purpose: TenantSurfacePurpose,
  path: string,
): boolean {
  if (purpose === 'panel') return true;
  return SERVED_PATHS[purpose].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

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
  /**
   * The purpose of the `tenant_domain` row the host matched, when one did
   * (F-066-q). Absent means there was **no surface at all** — an internal
   * caller on a container name no row names, whose claim answered alone — and
   * absent is therefore unrestricted rather than denied.
   *
   * It is deliberately a fact about the *surface* and not about `via`. A
   * tenant's own session presented on that tenant's subscription domain
   * resolves through the `session` entry and is exactly the request this row
   * refuses, so a check that read `via` would let every signed-in browser
   * through the door it is meant to close.
   */
  surfacePurpose?: TenantSurfacePurpose;
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
 * header so a single name survives into the platform-staff case.
 *
 * One name, two directions: a service caller *sends* it and `auth-handler`
 * *writes* it on the way back out. HTTP header names are case-insensitive, so
 * `x-tenant-id` and `X-Tenant-Id` were one string declared twice — read it
 * with `headerValue`, which lowercases, rather than by indexing with this
 * constant (ADR-0036, C-04). */
export const TENANT_ID_HEADER = IdentityHeaders.tenantId;

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
