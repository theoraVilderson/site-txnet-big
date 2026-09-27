import { Injectable, Logger } from '@nestjs/common';
import { ConfigStatus, GrantStatus, Prisma } from '@prisma/client';
import { OutboxEventType, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { GRANT_AGGREGATE } from './delivered';
import { UNUSED_SECOND_AFTER_MS } from './unused-clock';

export { unusedClockOf } from './unused-clock';

/** Due Grants one sweep reads. The scan drains itself: every check moves or clears the clock. */
const UNUSED_NOTICE_BATCH = 500;

type UnusedNotice = typeof OutboxEventType.GRANT_NOT_CONNECTED | typeof OutboxEventType.GRANT_STILL_NOT_CONNECTED;

/**
 * One due check: what to tell, and when the next check is (`null` = none).
 * `confirmed` is whether any live config of the Grant was confirmed on its
 * panel — without one there is nothing to connect to yet, and "not connected
 * yet?" would blame the user for a service still being built (F-601-i's).
 */
export function unusedNoticeStep(
  g: { activatedAt: Date | null; unusedCheckAt: Date; consumedBytes: bigint; confirmed: boolean },
  now: Date,
): { notice: UnusedNotice | null; next: Date | null } {
  if (g.activatedAt === null || g.consumedBytes > BigInt(0)) return { notice: null, next: null };
  const second = new Date(g.activatedAt.getTime() + UNUSED_SECOND_AFTER_MS);
  // A sweep down past 72 h tells the second ask alone, never both at once.
  const isSecond = g.unusedCheckAt.getTime() >= second.getTime() || now.getTime() >= second.getTime();
  const next = isSecond ? null : second;
  if (!g.confirmed) return { notice: null, next };
  return { notice: isSecond ? OutboxEventType.GRANT_STILL_NOT_CONNECTED : OutboxEventType.GRANT_NOT_CONNECTED, next };
}

export type UnusedNoticeResult = { scanned: number; told: number };

/**
 * "Not connected yet?" (F-601-c, spec 9.5): an active Grant with nothing
 * consumed 24 h and again 72 h after activation emits a retention event, and
 * `worker-service` tells the user how to connect and where support is
 * (notification `contract.retention.md`). Entitlement only emits (spec 9.2).
 *
 * **The clock is `unusedCheckAt`**, started at activation (`markDelivered`,
 * or `issue` for a Grant born `active`) and moved or cleared by every check,
 * so the scan drains itself and a second call finds nothing. The write is
 * conditional on the clock it read: two sweeps racing emit once, and the
 * ledger's `(Grant, notice, period)` row — the period is the activation
 * instant — holds the line past that.
 *
 * Cross-tenant scan, per-tenant write, as `purge.ts` and `delivery.ts` do.
 */
@Injectable()
export class GrantUnusedNoticeService {
  private readonly logger = new Logger(GrantUnusedNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  async noticeDue(now: Date = new Date()): Promise<UnusedNoticeResult> {
    const due = await this.crossTenant.grant.findMany({
      where: { status: GrantStatus.active, unusedCheckAt: { lte: now } },
      select: { id: true, tenantId: true },
      orderBy: { unusedCheckAt: 'asc' },
      take: UNUSED_NOTICE_BATCH,
    });
    let told = 0;
    for (const grant of due) {
      const notice = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.check(tx, grant.id, now)));
      if (notice) told += 1;
    }
    if (told > 0) this.logger.log(`asked ${told} of ${due.length} due Grant(s) whether they connected`);
    return { scanned: due.length, told };
  }

  /** One Grant's check, in the caller's tenant transaction. Answers the notice it emitted, if any. */
  async check(tx: Prisma.TransactionClient, grantId: string, now: Date): Promise<UnusedNotice | null> {
    const grant = await tx.grant.findFirst({
      where: { id: grantId, status: GrantStatus.active, unusedCheckAt: { lte: now } },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        activatedAt: true,
        unusedCheckAt: true,
        consumedBytes: true,
        configs: { where: { status: ConfigStatus.active, confirmedAt: { not: null } }, select: { id: true }, take: 1 },
      },
    });
    if (!grant?.unusedCheckAt) return null;

    const step = unusedNoticeStep({ ...grant, unusedCheckAt: grant.unusedCheckAt, confirmed: grant.configs.length > 0 }, now);
    const moved = await tx.grant.updateMany({
      where: { id: grant.id, status: GrantStatus.active, unusedCheckAt: grant.unusedCheckAt },
      data: { unusedCheckAt: step.next },
    });
    if (moved.count !== 1 || !step.notice || !grant.activatedAt) return null;

    // The tenant's own support link, when it set one (F-018-h); the notice reads without it.
    const branding = await tx.tenantBranding.findUnique({ where: { tenantId: grant.tenantId }, select: { supportUrl: true } });
    await tx.outboxEvent.create({
      data: {
        aggregate: GRANT_AGGREGATE,
        aggregateId: grant.id,
        type: step.notice,
        payload: {
          tenantId: grant.tenantId,
          userId: grant.userId,
          grantId: grant.id,
          period: grant.activatedAt.toISOString(),
          ...(branding?.supportUrl ? { supportUrl: branding.supportUrl } : {}),
        },
      },
      select: { id: true },
    });
    return step.notice;
  }
}
