import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DesiredRemote, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { OutboxEventType, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { GRANT_AGGREGATE } from './delivered';

type PurgeNotice = typeof OutboxEventType.GRANT_PURGE_SOON | typeof OutboxEventType.GRANT_PURGE_SOON_METERED;

/** One suspended Grant whose purge is a day or less away, and not yet told for this suspension. */
export type PurgeNoticeDue = {
  id: string;
  tenantId: string;
  userId: string;
  billingMode: VariantBillingMode;
  suspendedAt: Date;
  purgeNoticeFor: Date | null;
};

export type PurgeNoticeResult = { scanned: number; told: number };

/**
 * What keeps the configs: a renewal for a prepaid Grant, a top-up for a
 * metered one — a metered renewal adds days alone and revives nothing
 * (`reviveFundedGrants`), the reason F-601-b's cutoff notices split the same way.
 */
export function purgeNoticeType(billingMode: VariantBillingMode): PurgeNotice {
  return billingMode === VariantBillingMode.metered ? OutboxEventType.GRANT_PURGE_SOON_METERED : OutboxEventType.GRANT_PURGE_SOON;
}

/**
 * Before purge (F-601-j, spec 9.5): a suspended Grant is told, a day before
 * `purgeAfterDays` drops its configs from the panel (F-027-y, `purge.ts`),
 * that renewing — or topping up — keeps them. Entitlement only emits (spec
 * 9.2); `worker-service` tells, once per suspension by notification's ledger.
 *
 * **The window is the purge's, less a day**, resolved the same way and read
 * live: `coalesce(grant, tenant)`, and a window of `0` (purge off) is never
 * scanned — so never told. A window of one day is due at the suspension
 * itself. A Grant whose configs are already `absent` is not due: the purge
 * got there first, and "within a day" would be a lie.
 *
 * **The clock is `purgeNoticeFor`**, the `suspendedAt` told for. The scan
 * skips a Grant whose clock matches its suspension, so it drains itself; the
 * write is conditional on the value read, so two sweeps emit once. A revival
 * clears `suspendedAt`, and the next suspension no longer matches — nothing
 * resets the clock.
 *
 * Asked by the purge job's own hourly call, after the purge (the controller),
 * so a Grant purged in the same tick is not told. Cross-tenant scan,
 * per-tenant write, as `purge.ts` does.
 */
@Injectable()
export class GrantPurgeNoticeService {
  private readonly logger = new Logger(GrantPurgeNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async noticeDue(now: Date = new Date()): Promise<PurgeNoticeResult> {
    const take = this.config.get('GRANT_PURGE_BATCH_SIZE', { infer: true });

    const due = await this.crossTenant.$queryRaw<PurgeNoticeDue[]>`
      SELECT g."id", g."tenantId", g."userId", g."billingMode", g."suspendedAt", g."purgeNoticeFor"
        FROM "entitlement"."grant" g
        JOIN "tenant"."tenant" t ON t."id" = g."tenantId"
       WHERE g."status" = ${GrantStatus.suspended}::"entitlement"."GrantStatus"
         AND g."suspendedAt" IS NOT NULL
         AND COALESCE(g."purgeAfterDays", t."purgeAfterDays") > 0
         AND g."suspendedAt" + make_interval(days => COALESCE(g."purgeAfterDays", t."purgeAfterDays") - 1) <= ${now}
         AND g."purgeNoticeFor" IS DISTINCT FROM g."suspendedAt"
         AND EXISTS (
               SELECT 1 FROM "network"."config" c
                WHERE c."grantId" = g."id"
                  AND c."desiredRemote" = ${DesiredRemote.present}::"network"."DesiredRemote")
       ORDER BY g."suspendedAt" ASC
       LIMIT ${take}`;

    let told = 0;
    for (const grant of due) {
      const notice = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.tell(tx, grant)));
      if (notice) told += 1;
    }
    if (told > 0) this.logger.log(`told ${told} of ${due.length} suspended Grant(s) their purge is within a day`);
    return { scanned: due.length, told };
  }

  /** One due Grant, in its tenant's transaction. Answers the notice it emitted, if any. */
  private async tell(tx: Prisma.TransactionClient, grant: PurgeNoticeDue): Promise<PurgeNotice | null> {
    const moved = await tx.grant.updateMany({
      where: { id: grant.id, status: GrantStatus.suspended, suspendedAt: grant.suspendedAt, purgeNoticeFor: grant.purgeNoticeFor },
      data: { purgeNoticeFor: grant.suspendedAt },
    });
    if (moved.count !== 1) return null;

    const type = purgeNoticeType(grant.billingMode);
    await tx.outboxEvent.create({
      data: {
        aggregate: GRANT_AGGREGATE,
        aggregateId: grant.id,
        type,
        payload: { tenantId: grant.tenantId, userId: grant.userId, grantId: grant.id, period: grant.suspendedAt.toISOString() },
      },
      select: { id: true },
    });
    return type;
  }
}
