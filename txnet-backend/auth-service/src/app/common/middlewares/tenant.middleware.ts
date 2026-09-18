import { REFRESH_TOKEN_COOKIE, headerValue } from '@txnet-backend/shared-core';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TenantResolverService } from '../../tenant/tenant-resolver.service';
import {
  ResolvedTenant,
  TENANT_ID_HEADER,
  TenantClaim,
  TenantClaimConflict,
} from '../../tenant/tenant';
import { TokenService } from '../../auth/token.service';
import { isServiceCaller } from '../security/service-caller';
import { readCookie } from '../http/cookies';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';

/**
 * Assembles the request's tenant claim and attaches what it resolved to, once,
 * at the edge (ADR-0020, ADR-0025).
 *
 * **This is the only place a header is read for tenancy** (catalog F-1209: one
 * reader, one decision, one context object). `req.hostname` rather than the raw
 * `Host` header: Express strips the port for us and, with `trust proxy` set
 * (`main.ts`), reads `X-Forwarded-Host` — which is what Traefik actually
 * forwards, so the raw header would be the container's own name in every
 * deployed environment.
 *
 * It runs on every route rather than only the ones that use a tenant. A route
 * that resolves its own tenant would resolve it differently the first time
 * someone forgot to, and the resolution is a cached read, not a cost worth
 * spreading across handlers.
 *
 * Failure is not fatal here: an unresolved tenant is `null` on the request, and
 * the routes that need one refuse for themselves. A middleware that threw would
 * take down `/auth/refresh` and every other route that does not care. A
 * *disagreement* is recorded rather than thrown for a narrower reason — a
 * global exception filter does not catch what Express middleware throws, so the
 * refusal is raised by `TenantAgreementGuard` where the client still gets the
 * translated envelope.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly tenants: TenantResolverService,
    private readonly tokens: TokenService,
    // The session a refresh cookie names is read before any tenant is in
    // scope — which tenant it is, is the question (ADR-0059 (2)).
    private readonly all: CrossTenantPrismaService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const scoped = req as {
      tenant?: ResolvedTenant | null;
      tenantConflict?: TenantClaimConflict;
    };

    try {
      scoped.tenant = await this.tenants.resolve(this.claim(req));
    } catch (error) {
      if (!(error instanceof TenantClaimConflict)) throw error;
      // No tenant is in scope for a refused request, so anything that runs
      // before the guard fails loudly rather than reading either tenant's data.
      scoped.tenant = null;
      scoped.tenantConflict = error;
    }
    next();
  }

  private claim(req: Request): TenantClaim {
    const session = this.sessionClaim(req);
    return {
      host: req.hostname,
      session: session?.tenantId ?? null,
      sessionUser: session?.userId ?? null,
      bot: this.botClaim(req),
      cookieSession: () => this.cookieSession(req),
    };
  }

  /**
   * The live session this request's refresh cookie names. A cookie is not a
   * claim the way a signed token is: it only ever admits the surface's owner
   * (the resolver ignores any other answer), and it resolves to nothing unless
   * its hash names a session that is neither revoked nor expired.
   */
  private async cookieSession(
    req: Request,
  ): Promise<{ tenantId: string; userId: string } | null> {
    const token = readCookie(req.headers.cookie, REFRESH_TOKEN_COOKIE);
    if (!token) return null;
    const row = await this.all.session.findUnique({
      where: { refreshTokenHash: this.tokens.refreshHash(token) },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { tenantId: true } },
      },
    });
    if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
    return { tenantId: row.user.tenantId, userId: row.userId };
  }

  /**
   * The tenant an access token asserts, or `null`.
   *
   * The signature is checked — an unverified token is a client input, and
   * ADR-0025 forecloses resolving a tenant from one. Nothing is *rejected*
   * here: a bad, expired or purpose-bound token simply carries no claim, and
   * `AuthGuard` is still the one that decides whether the route may run. A
   * middleware that answered 401 would do it for `/auth/login` too.
   */
  private sessionClaim(req: Request): { tenantId: string; userId: string } | null {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) return null;

    try {
      const claims = this.tokens.verify(header.slice(7));
      // An OTP or reset token carries `tenantId: ''` and names no session; it
      // is a step in a login, not a session that belongs to a tenant.
      if (claims.purpose || !claims.sessionId) return null;
      if (!claims.tenantId || !claims.sub) return null;
      return { tenantId: claims.tenantId, userId: claims.sub };
    } catch {
      return null;
    }
  }

  /**
   * The tenant a calling service is acting for, or `null`.
   *
   * Trusted only from a verified `x-service-token` caller (ADR-0011's marker),
   * because the header itself is forgeable and the service token is not. Until
   * F-066-i the bot is one process with one tenant, so this is the seam that
   * lets it name the tenant a chat belongs to rather than inheriting the host
   * the API happens to be called on.
   */
  private botClaim(req: Request): string | null {
    if (!isServiceCaller(req)) return null;
    // `headerValue` lowercases the declared name and drops a blank value, so
    // a header that arrived carrying nothing cannot become tenant `""`.
    return headerValue(req.headers, TENANT_ID_HEADER) ?? null;
  }
}
