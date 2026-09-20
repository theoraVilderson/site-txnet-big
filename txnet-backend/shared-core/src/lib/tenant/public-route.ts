import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaClient, TenantDomainPurpose } from '@prisma/client';

import { doorClosed } from './door';
import type { HostSurface } from './host-surface';

/**
 * **The one way to add a route nobody signs in to** (F-018-ak, ADR-0065).
 *
 * A public route lives under `public/<service>/` — `GET /api/public/tenant/branding`
 * — and three things then hold without anyone opting in:
 *
 * 1. Traefik sends `/api/public/<service>` to that service without `my-auth`:
 *    one router pair per service, written once, never one per route.
 * 2. The service's host middleware skips the identity gate for `public/*path`,
 *    reads the one `tenant_domain` row the Host names ({@link surfaceOfHost}),
 *    puts it on the request under {@link PUBLIC_SURFACE} and opens its tenant's
 *    scope.
 * 3. {@link PublicRouteGuard} holds each route to the doors it declared with
 *    {@link PublicRoute}, and refuses a public request that reached a route
 *    declaring none — a controller moved under `public/` without the decorator
 *    is a 404, not an open route.
 *
 * Adding one is a controller and a decorator. Adding a service to the scheme is
 * the router pair and its host middleware, once.
 */
export const PUBLIC_PREFIX = 'public';

/** `public/<service>/<route>` — the controller path of a public route. */
export function publicPath(service: string, route: string): string {
  return `${PUBLIC_PREFIX}/${service}/${route}`;
}

/** The surface a public request's Host proves, or `null` for none (set by the host middleware). */
export const PUBLIC_SURFACE = Symbol('publicSurface');

/**
 * The surface a Host proves: its `tenant_domain` row, if that row is proof. A
 * subdomain is issued by the platform, so matching it is the whole proof; a
 * custom domain is the tenant's only once ownership has been shown. The same
 * rule as `auth-service`'s resolver and {@link tenantOfHost}.
 *
 * **It selects `slug` and `ownerUserId` although no public route reads them**
 * (F-018-al): the answer is cached under `tenant:host:<host>`, the key
 * `auth-service` shares, and a value missing a field that service requires is a
 * permanent miss for it. {@link HostSurface} is that shared shape; this query
 * is what fills it, and it is deliberately the same select as
 * `TenantResolverService.lookupHost`.
 *
 * `db` must be the **cross-tenant** client: the tenant this returns is what the
 * request is then scoped by, and `tenant_domain`'s RLS shows an unscoped
 * connection nothing.
 */
export async function surfaceOfHost(
  db: Pick<PrismaClient, 'tenantDomain'>,
  host: string | null,
): Promise<HostSurface | null> {
  if (!host) return null;
  const row = await db.tenantDomain.findUnique({
    where: { domainValue: host },
    select: {
      domainType: true,
      purpose: true,
      verificationStatus: true,
      tenant: { select: { id: true, slug: true, ownerUserId: true, tenantType: true } },
    },
  });
  if (!row) return null;
  if (row.domainType !== 'subdomain' && row.verificationStatus !== 'verified') return null;
  return { ...row.tenant, purpose: row.purpose, domainType: row.domainType };
}

/**
 * Which doors a public route answers on:
 *
 * - a list of purposes — a surface of one of them, on a door that is not closed
 *   (ADR-0063). The usual case: files and branding are `['panel', 'assets']`.
 * - `'any'` — any surface, closed doors included. For a route whose answer *is*
 *   the door's state: `serves-panel` must answer on exactly the doors it names.
 * - `'none'` — the Host is not the proof, and the handler checks its own: the
 *   domain probe answers for a custom domain that has not been verified yet,
 *   because it is how it gets verified.
 */
export type PublicDoors = readonly TenantDomainPurpose[] | 'any' | 'none';

export const PUBLIC_ROUTE = 'publicRoute';

export const PublicRoute = (options: { doors: PublicDoors }) => SetMetadata(PUBLIC_ROUTE, options.doors);

/**
 * Every refusal is the same neutral 404: an unknown host, an unproven domain, a
 * door of the wrong purpose and a closed one all look alike to a stranger.
 */
@Injectable()
export class PublicRouteGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Record<symbol, HostSurface | null | undefined>>();
    const doors = this.reflector.getAllAndOverride<PublicDoors | undefined>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isPublic = PUBLIC_SURFACE in request;

    if (!doors) {
      if (isPublic) throw new NotFoundException();
      return true;
    }
    // A public route reached without the host middleware has had no Host
    // checked at all — a routing mistake, and it must not answer.
    if (!isPublic) throw new NotFoundException();
    if (doors === 'none') return true;

    const surface = request[PUBLIC_SURFACE];
    if (!surface) throw new NotFoundException();
    if (doors === 'any') return true;
    if (!doors.includes(surface.purpose) || doorClosed(surface)) throw new NotFoundException();
    return true;
  }
}
