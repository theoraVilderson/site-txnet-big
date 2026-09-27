import { Injectable, Logger } from '@nestjs/common';
import { ConfigStatus, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { OutboxEventType, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { GRANT_AGGREGATE } from './delivered';
import { runs, standingClose } from './reactivated';

/** Due Grants one sweep reads. The scan drains itself: every check clears the clock. */
const IDLE_NOTICE_BATCH = 500;

/**
 * Whether an idle Grant is asked: only one that could carry traffic now. A
 * Grant past its end, under a standing close or with its bag spent is idle
 * because it stopped — its cutoff notice (F-601-b) says so, and "trouble
 * connecting?" would be the wrong question. With no config confirmed on a
 * panel there is nothing to connect to (F-601-i's).
 */
export function idleNoticeTold(g: { endsAt: Date | null; bagSpent: boolean; closed: boolean; confirmed: boolean }, now: Date): boolean {
  return runs(g.endsAt, now) && !g.bagSpent && !g.closed && g.confirmed;
}

export type IdleNoticeResult = { scanned: number; told: number };

/**
 * "Trouble connecting?" (F-601-l, spec 9.5, beyond the catalog): an active
 * Grant that was used, and then consumed nothing for 7 days, emits one
 * retention event per idle stretch; `worker-service` tells the user how to
 * reconnect and where support is (notification `contract.retention.md`).
 *
 * **The clock is `idleCheckAt`**, set by metering's charge to 7 days after
 * each one that consumed a byte (`idleCheckOf`), and cleared here whether or
 * not anyone is told — so a stretch is asked about once, and only the next
 * use opens another. A Grant never used has no clock: that is F-601-c's
 * "not connected yet?". The write is conditional on the clock read: a charge
 * or a second sweep in between emits nothing, and the event's period is the
 * clock itself, for the ledger (notification invariant 14).
 *
 * Cross-tenant scan, per-tenant write, as `unused-notice.ts` does.
 */
@Injectable()
export class GrantIdleNoticeService {
  private readonly logger = new Logger(GrantIdleNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  async noticeDue(now: Date = new Date()): Promise<IdleNoticeResult> {
    const due = await this.crossTenant.grant.findMany({
      where: { status: GrantStatus.active, idleCheckAt: { lte: now } },
      select: { id: true, tenantId: true },
      orderBy: { idleCheckAt: 'asc' },
      take: IDLE_NOTICE_BATCH,
    });
    let told = 0;
    for (const grant of due) {
      const asked = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.check(tx, grant.id, now)));
      if (asked) told += 1;
    }
    if (told > 0) this.logger.log(`checked in on ${told} of ${due.length} idle Grant(s)`);
    return { scanned: due.length, told };
  }

  /** One Grant's check, in the caller's tenant transaction. Answers whether it emitted the check-in. */
  async check(tx: Prisma.TransactionClient, grantId: string, now: Date): Promise<boolean> {
    const grant = await tx.grant.findFirst({
      where: { id: grantId, status: GrantStatus.active, idleCheckAt: { lte: now } },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        idleCheckAt: true,
        endsAt: true,
        billingMode: true,
        trafficUnlimited: true,
        purchasedBytes: true,
        consumedBytes: true,
        configs: { where: { status: ConfigStatus.active, confirmedAt: { not: null } }, select: { id: true }, take: 1 },
      },
    });
    if (!grant?.idleCheckAt) return false;

    const bagged = grant.billingMode === VariantBillingMode.prepaid && !grant.trafficUnlimited;
    const tell = idleNoticeTold(
      {
        endsAt: grant.endsAt,
        bagSpent: bagged && grant.consumedBytes >= grant.purchasedBytes,
        closed: (await standingClose(tx, grant, bagged, now)) !== null,
        confirmed: grant.configs.length > 0,
      },
      now,
    );
    const cleared = await tx.grant.updateMany({
      where: { id: grant.id, status: GrantStatus.active, idleCheckAt: grant.idleCheckAt },
      data: { idleCheckAt: null },
    });
    if (cleared.count !== 1 || !tell) return false;

    // The tenant's own support link, when it set one (F-018-h); the notice reads without it.
    const branding = await tx.tenantBranding.findUnique({ where: { tenantId: grant.tenantId }, select: { supportUrl: true } });
    await tx.outboxEvent.create({
      data: {
        aggregate: GRANT_AGGREGATE,
        aggregateId: grant.id,
        type: OutboxEventType.GRANT_IDLE,
        payload: {
          tenantId: grant.tenantId,
          userId: grant.userId,
          grantId: grant.id,
          period: grant.idleCheckAt.toISOString(),
          ...(branding?.supportUrl ? { supportUrl: branding.supportUrl } : {}),
        },
      },
      select: { id: true },
    });
    return true;
  }
}
