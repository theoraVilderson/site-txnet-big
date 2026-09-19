import { Injectable, NestMiddleware } from '@nestjs/common';
import { normalizeHost, PUBLIC_SURFACE, runWithTenant, surfaceOfHost } from '@txnet-backend/shared-core';
import type { NextFunction, Request, Response } from 'express';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/**
 * The Host half of every public route here (F-018-ak, ADR-0065): the routes
 * under `public/tenant/`, which Traefik sends with no `my-auth` and no session.
 *
 * It names the surface the Host proves (`surfaceOfHost`) and puts it on the
 * request — `null` for none — and opens that tenant's scope, so a route holds a
 * key against it and one reseller's domain never serves another's file. It
 * refuses nothing itself: which doors a route answers on is the route's own
 * `@PublicRoute`, and `PublicRouteGuard` enforces it.
 *
 * tenant-service reads `Host`, not `X-Forwarded-Host`: the panel's internal hop
 * sets `Host` itself (`site-pwa/src/lib/host-get.ts`).
 *
 * **Injecting the cross-tenant pool is the audit** (`CrossTenantPrismaService`):
 * this reads one `tenant_domain` row by its unique host, before any tenant is
 * known, and nothing else.
 */
@Injectable()
export class PublicHostMiddleware implements NestMiddleware {
  constructor(private readonly prisma: CrossTenantPrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const surface = await surfaceOfHost(this.prisma, normalizeHost(req.headers.host));
    (req as unknown as Record<symbol, unknown>)[PUBLIC_SURFACE] = surface;
    runWithTenant(surface ? { id: surface.tenantId } : null, () => next());
  }
}
