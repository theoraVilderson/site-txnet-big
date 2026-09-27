import { Injectable } from '@nestjs/common';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { type ClosedVerdict, suspendIfClosed } from './exhaustion';

/**
 * `network.grant.closed`, answered (F-027-dw, ADR-0096): the lease planner
 * closed a Grant, and a prepaid one becomes `suspended` now rather than
 * reading `active` with its configs off on every panel. The rule is
 * `suspendIfClosed`; this only finds the Grant's tenant, because the queue
 * consumer that asks carries none.
 */
@Injectable()
export class GrantCloseService {
  constructor(
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly prisma: PrismaService,
  ) {}

  async onClosed(grantId: string): Promise<ClosedVerdict> {
    const grant = await this.crossTenant.grant.findUnique({ where: { id: grantId }, select: { tenantId: true } });
    if (!grant) return 'grant_not_found';
    const closed = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => suspendIfClosed(tx, grantId)));
    return closed.verdict;
  }
}
