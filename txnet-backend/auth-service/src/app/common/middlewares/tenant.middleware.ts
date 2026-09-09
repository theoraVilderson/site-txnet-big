import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantResolverService } from '../../tenant/tenant-resolver.service';
import { ResolvedTenant } from '../../tenant/tenant';

/**
 * Attaches the request's tenant, once, at the edge (ADR-0020).
 *
 * `req.hostname` rather than the raw `Host` header: Express strips the port for
 * us and, with `trust proxy` set (`main.ts`), reads `X-Forwarded-Host` — which
 * is what Traefik actually forwards, so the raw header would be the container's
 * own name in every deployed environment.
 *
 * It runs on every route rather than only the ones that use a tenant. A route
 * that resolves its own tenant would resolve it differently the first time
 * someone forgot to, and the resolution is a cached read, not a cost worth
 * spreading across handlers.
 *
 * Failure is not fatal here: an unresolved tenant is `null` on the request, and
 * the routes that need one refuse for themselves. A middleware that threw would
 * take down `/auth/refresh` and every other route that does not care.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenants: TenantResolverService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    (req as { tenant?: ResolvedTenant | null }).tenant =
      await this.tenants.resolve(req.hostname);
    next();
  }
}
