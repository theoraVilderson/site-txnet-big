import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { resolveTenant, tenantConflict } from './tenant';
import { TENANT_AGNOSTIC } from './tenant-agnostic.decorator';

/**
 * The two ways a request's tenancy can be refused, in the one place a refusal
 * is observable (ADR-0024 decision 4, ADR-0025).
 *
 * Global, and deliberately not per-route: the routes that would remember to
 * opt in are the ones that already think about tenancy, and the leak is in the
 * ones that do not. `TenantMiddleware` decides; this only reports, so there is
 * still one reader and one decision (F-1209).
 *
 * 1. **No tenant at all** — an unknown or unverified host, on a request that
 *    carries no claim of its own. ADR-0025 removed the fallback that used to
 *    answer here, so the honest response is that there is nothing at this
 *    address (F-1210).
 * 2. **A claim that disagrees with its surface** — `403 tenant.claimMismatch`.
 *    The message says the session does not belong here and deliberately not
 *    *which* tenant it does belong to.
 *
 * The 404 is **neutral**: a bare `NotFoundException`, whose message is not an
 * i18n key, so `sanitizeError` replaces it with the generic `system.notFound`
 * that every unmatched route already produces. A stranger cannot tell a host
 * the platform does not serve from a path that does not exist, which is what
 * "must not reveal that a platform exists" asks for. The host is named in the
 * server log and nowhere else.
 *
 * Order matters between the two: a refused claim leaves no tenant on the
 * request, so checking the conflict first is what keeps that case a 403
 * instead of collapsing into the 404.
 *
 * One kind of route is exempt, and only after the conflict check: a route
 * whose job is to *resolve* a tenant cannot be made to have one first
 * ({@link TenantAgnostic}). A claim that disagrees with its surface is still
 * refused there — being tenant-agnostic is not permission to carry someone
 * else's session.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const conflict = tenantConflict(request);
    if (conflict) {
      this.logger.warn(
        `${request.method} ${request.originalUrl} refused: ${conflict.message}`,
      );
      throw new ForbiddenException('tenant.claimMismatch');
    }

    const agnostic = this.reflector.getAllAndOverride<boolean>(
      TENANT_AGNOSTIC,
      [context.getHandler(), context.getClass()],
    );
    if (agnostic) return true;

    if (!resolveTenant(request)) {
      this.logger.warn(
        `${request.method} ${request.originalUrl} refused: host '${request.hostname}' ` +
          `resolves to no tenant — there is no fallback (ADR-0025)`,
      );
      throw new NotFoundException();
    }

    return true;
  }
}
