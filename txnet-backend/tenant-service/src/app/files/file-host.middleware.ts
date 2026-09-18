import { Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import { TenantDomainPurpose } from '@prisma/client';
import { normalizeHost, runWithTenant, tenantOfHost } from '@txnet-backend/shared-core';
import type { NextFunction, Request, Response } from 'express';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/** Where a file may be fetched from: the tenant's panel, or its asset domain (rule 2). */
const FILE_DOORS = [TenantDomainPurpose.panel, TenantDomainPurpose.assets] as const;

/**
 * The tenant of a file request, from the Host it arrived on (F-018-m) — and
 * of the public branding read (F-018-h), so the two agree on every door.
 *
 * The file route is public — an `<img>` on the landing site carries no
 * session — so the Host is the claim and `tenant_domain` the proof, as for
 * `billing-service`'s callback (`tenantOfHost`). The scope it opens is what the
 * route then holds a key against, so one reseller's domain never serves
 * another's file, and never says that it exists.
 *
 * **Injecting the cross-tenant pool is the audit** (`CrossTenantPrismaService`):
 * this reads one `tenant_domain` row by its unique host, before any tenant is
 * known, and nothing else.
 */
@Injectable()
export class FileHostMiddleware implements NestMiddleware {
  constructor(private readonly prisma: CrossTenantPrismaService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const host = normalizeHost(req.headers.host);
    const tenantId = host ? await tenantOfHost(this.prisma, host, FILE_DOORS) : null;
    // One neutral 404 for an unknown host, an unproven domain and a
    // subscription door alike — no discovery oracle for a stranger.
    if (!tenantId) throw new NotFoundException();
    runWithTenant({ id: tenantId }, () => next());
  }
}
