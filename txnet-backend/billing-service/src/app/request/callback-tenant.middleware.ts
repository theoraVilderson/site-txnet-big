import { Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import { TenantDomainPurpose } from '@prisma/client';
import { normalizeHost, runWithTenant, tenantOfHost } from '@txnet-backend/shared-core';
import type { NextFunction, Request, Response } from 'express';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/**
 * The tenant of a **public** billing route, resolved from the Host it arrived
 * on (F-092-j, ADR-0025).
 *
 * Every other route in this service is behind the gate and gets its tenant
 * handed to it in a header (`identity.middleware.ts`). The gateway callback
 * cannot be: a bank redirects a browser to it, with no session, no token and
 * nothing forgeable-but-checked to read. So the Host becomes the claim, and
 * `tenant_domain` the thing that proves it — the same chain `auth-service`'s
 * `TenantResolverService` walks, minus the session and bot entries it has no
 * way to carry.
 *
 * **A middleware and not a guard**, because Nest runs middleware first and the
 * rate limiter needs the answer: `RateLimiter.hit` keys its counters on the
 * tenant in context, so a guard-time resolution would be one request too late
 * and every callback would fail on a missing scope instead of being counted.
 *
 * **Unknown host is a neutral 404** (ADR-0025 decision 3): no branding, no hint
 * that a platform exists, and above all no fallback tenant — a callback absorbed
 * into the wrong tenant is a payment credited to the wrong wallet.
 *
 * `start` and this must agree on which rows count, or a tenant mints callbacks
 * to a host this refuses: both take a `panel` row that is either a platform
 * subdomain or a **proven** custom domain (`deposit-start.service.ts`).
 */
@Injectable()
export class CallbackTenantMiddleware implements NestMiddleware {
  constructor(private readonly prisma: CrossTenantPrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const host = normalizeHost(req.headers.host);
    const tenantId = host ? await this.tenantOf(host) : null;
    // The same answer for a host with no row, an unproven custom domain and a
    // request with no Host at all. Distinguishing them here would be a
    // discovery oracle for an unauthenticated caller.
    if (!tenantId) throw new NotFoundException();
    runWithTenant({ id: tenantId }, () => next());
  }

  /**
   * The one cross-tenant read in this service. It cannot be scoped: the tenant
   * it returns is what everything downstream is then scoped **by**, and on the
   * application pool `tenant_domain`'s RLS policy would show a connection with
   * no `app.tenant_id` bound exactly nothing.
   *
   * Uncached, unlike `auth-service`'s, which holds this in Redis because it is
   * on the path of every request it serves. This one is on the path of a
   * payment: a single indexed lookup on a small table, once per settlement, is
   * not worth a second copy of a cache whose invalidation rules (ADR-0025
   * decision 4) are `tenant`'s to own and F-018's to write.
   */
  private tenantOf(host: string): Promise<string | null> {
    return tenantOfHost(this.prisma, host, [TenantDomainPurpose.panel]);
  }
}
