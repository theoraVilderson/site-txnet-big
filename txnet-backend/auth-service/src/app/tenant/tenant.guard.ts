import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { resolveTenant, surfaceServesPath, tenantConflict } from './tenant';
import { DOOR_PROBE, doorClosed } from './door';
import { TENANT_AGNOSTIC } from './tenant-agnostic.decorator';
import {
  BackendI18nKeys,
  TENANT_STATUS_STORE,
  TenantStatusStore,
} from '@txnet-backend/shared-core';

/**
 * The four ways a request's tenancy can be refused, in the one place a refusal
 * is observable (ADR-0024 decision 4, ADR-0025, catalog F-1212, F-018-ag).
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
 * 3. **A surface that does not serve this path** — a `purpose = subscription`
 *    domain resolves its tenant perfectly well and still serves no panel route
 *    (F-066-q). It is the same neutral 404 as (1), and on purpose: a
 *    subscription host must not tell a stranger that a panel lives elsewhere.
 * 4. **A closed platform host** — a reseller's CNAME target, always
 *    (ADR-0063), or a gated reseller's other platform subdomain: the same rule
 *    as (3) with the onboarding gate as a third input instead of the purpose. It serves
 *    nothing, to anyone: its end users (F-018-ag, D-01) and, since F-066-x,
 *    the reseller itself, which configures from the platform's own panel
 *    (user, 2026-09-19). Also the neutral 404 — on the platform's own domain,
 *    a stranger must not learn that a particular reseller lives at this
 *    address.
 *
 * The 404 is **neutral**: a bare `NotFoundException`, whose message is not an
 * i18n key, so `sanitizeError` replaces it with the generic `system.notFound`
 * that every unmatched route already produces. A stranger cannot tell a host
 * the platform does not serve from a path that does not exist, which is what
 * "must not reveal that a platform exists" asks for. The host is named in the
 * server log and nowhere else.
 *
 * Order matters: a refused claim leaves no tenant on the request, so checking
 * the conflict first is what keeps that case a 403 instead of collapsing into
 * the 404. (3) and (4) then run before (1) for the opposite reason — a
 * wrong-purpose or closed host *did* resolve, so it would otherwise be waved
 * through.
 *
 * One kind of route is exempt from (1), and only from it: a route whose job is
 * to *resolve* a tenant cannot be made to have one first
 * ({@link TenantAgnostic}). None of the other three is waived there — being
 * tenant-agnostic is not permission to carry someone else's session, nor to be
 * served on a door this process, or this tenant, serves nothing on.
 *
 * One route is exempt from (3) and (4), and only from them: the one that asks
 * whether the door is open ({@link DoorProbe}, F-066-x). It has to answer on
 * exactly the doors those two close.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_STATUS_STORE) private readonly store: TenantStatusStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const conflict = tenantConflict(request);
    if (conflict) {
      this.logger.warn(
        `${request.method} ${request.originalUrl} refused: ${conflict.message}`,
      );
      throw new ForbiddenException(BackendI18nKeys.errors.tenant.claimMismatch);
    }

    // Before the exemption, because this refusal is about the door and not
    // about the route: a surface that serves no path of this process serves
    // none of its tenant-agnostic ones either.
    const tenant = resolveTenant(request);
    const probe = this.reflector.getAllAndOverride<boolean>(DOOR_PROBE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const purpose = tenant?.surfacePurpose;
    if (!probe && purpose && !surfaceServesPath(purpose, request.path)) {
      this.logger.warn(
        `${request.method} ${request.originalUrl} refused: host ` +
          `'${request.hostname}' is a '${purpose}' domain and serves no such ` +
          `path (F-1212)`,
      );
      throw new NotFoundException();
    }

    if (!probe && tenant && (await doorClosed(tenant, this.store))) {
      this.logger.warn(
        `${request.method} ${request.originalUrl} refused: host ` +
          `'${request.hostname}' is ` +
          (tenant.surfaceIsTarget
            ? `a reseller's CNAME target, which serves nothing (ADR-0063)`
            : `a platform subdomain of a reseller that has proved no domain, and serves nothing (F-066-x)`),
      );
      throw new NotFoundException();
    }

    const agnostic = this.reflector.getAllAndOverride<boolean>(
      TENANT_AGNOSTIC,
      [context.getHandler(), context.getClass()],
    );
    if (agnostic) return true;

    if (!tenant) {
      this.logger.warn(
        `${request.method} ${request.originalUrl} refused: host '${request.hostname}' ` +
          `resolves to no tenant — there is no fallback (ADR-0025)`,
      );
      throw new NotFoundException();
    }

    return true;
  }
}
