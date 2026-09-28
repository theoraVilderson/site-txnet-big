import { Injectable, Logger } from '@nestjs/common';
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import {
  END_NOTICE_LEVELS,
  endNoticeStep,
  heldUsageNotice,
  remainingLabel,
  RETENTION_HOLD_MS,
  retentionEvent,
  retentionToTell,
  runWithTenant,
  tenantTransaction,
  type OutboxEventType,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { GRANT_AGGREGATE } from './delivered';

const DAY_MS = 86_400_000;

/** Due Grants each of the sweep's two questions reads. A told check clears what it told, so the scan drains itself. */
const END_NOTICE_BATCH = 500;

/** How far ahead the sweep looks: the farthest level. */
const END_HORIZON_MS = END_NOTICE_LEVELS[0].days * DAY_MS;

export type EndNoticeResult = { scanned: number; told: number };

/**
 * Time thresholds (F-601-e, spec 9.5): an active Grant 7, 3 and 1 day(s)
 * from its end emits a retention event, and `worker-service` tells the user
 * how long is left (notification `contract.retention.md`). Only a level that
 * is news is told: at most half the span since the end was set (`endSetAt`,
 * F-601-r, ADR-0097). Unlimited and
 * metered Grants alike — only a permanent one (`endsAt = null`) has no end.
 *
 * **Two due the same day are one message (F-601-n).** A 7- or 3-day level,
 * and a 50 / 80 % usage level billing's metering held on the Grant, wait up to
 * 24 h for the other kind (`retentionToTell`); both due is one event, now —
 * the usage type carrying the time level. The last day and 95 % are never
 * held. What is told is computed when it is told: the days left, and what is
 * left of the volume.
 *
 * **The clock belongs to the end it was set for.** `endNoticeFor` records
 * that end and `endNoticeAt` its next level; a renewal moves `endsAt`, and the
 * sweep finds the mismatch by itself, so no writer of `endsAt` has to reset
 * anything. A held level leaves the clock where it is, so the next hour reads
 * it due again. The write is conditional on everything it read: two sweeps
 * racing, a charge, or a renewal landing between read and write, emit nothing
 * twice, and the ledger's `(Grant, level, period)` row holds the line past
 * that.
 *
 * Cross-tenant scan, per-tenant write, as `unused-notice.ts` does.
 */
@Injectable()
export class GrantEndNoticeService {
  private readonly logger = new Logger(GrantEndNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  async noticeDue(now: Date = new Date()): Promise<EndNoticeResult> {
    const fields = this.crossTenant.grant.fields;
    const select = { id: true, tenantId: true } as const;
    // Two questions, each its own batch, so held time levels never starve a usage notice's 24 h.
    const [ending, held] = await Promise.all([
      this.crossTenant.grant.findMany({
        where: {
          status: GrantStatus.active,
          endsAt: { gt: now, lte: new Date(now.getTime() + END_HORIZON_MS) },
          // Never checked, set for another end (renewed), or its next level due.
          OR: [{ endNoticeFor: null }, { NOT: { endNoticeFor: { equals: fields.endsAt } } }, { endNoticeAt: { lte: now } }],
        },
        select,
        orderBy: { endsAt: 'asc' },
        take: END_NOTICE_BATCH,
      }),
      this.crossTenant.grant.findMany({
        where: { status: GrantStatus.active, usageNoticeSince: { lte: new Date(now.getTime() - RETENTION_HOLD_MS) } },
        select,
        orderBy: { usageNoticeSince: 'asc' },
        take: END_NOTICE_BATCH,
      }),
    ]);
    const due = [...new Map([...ending, ...held].map((g) => [g.id, g])).values()];
    let told = 0;
    for (const grant of due) {
      const notice = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.check(tx, grant.id, now)));
      if (notice) told += 1;
    }
    if (told > 0) this.logger.log(`told ${told} of ${due.length} due Grant(s) their end is near or their volume is running low`);
    return { scanned: due.length, told };
  }

  /** One Grant's check, in the caller's tenant transaction. Answers the event type it emitted, if any. */
  async check(tx: Prisma.TransactionClient, grantId: string, now: Date): Promise<OutboxEventType | null> {
    const grant = await tx.grant.findFirst({
      where: { id: grantId, status: GrantStatus.active },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        startsAt: true,
        activatedAt: true,
        endsAt: true,
        endSetAt: true,
        endNoticeFor: true,
        endNoticeAt: true,
        billingMode: true,
        trafficUnlimited: true,
        purchasedBytes: true,
        consumedBytes: true,
        usagePeriodStartedAt: true,
        usageNoticeLevel: true,
        usageNoticeSince: true,
      },
    });
    if (!grant) return null;

    const step = grant.endsAt
      ? endNoticeStep({ ...grant, endsAt: grant.endsAt, endSetAt: grant.endSetAt ?? grant.startsAt, activeSince: grant.activatedAt ?? grant.startsAt }, now)
      : { notice: null, next: null };
    const usagePeriod = grant.usagePeriodStartedAt ?? grant.startsAt;
    // A held level is told only while it is still true: a bag, not yet spent (that is the cutoff notice, F-601-b).
    const bag =
      grant.billingMode === VariantBillingMode.prepaid && !grant.trafficUnlimited && grant.consumedBytes < grant.purchasedBytes;
    const usage = bag ? heldUsageNotice({ ...grant, usagePeriod }) : null;
    const tell = retentionToTell({ time: step.notice, usage }, now);

    const data: Prisma.GrantUpdateManyMutationInput = {};
    // The clock moves past a level only once it is told; a held one stays due. No level due: set it for this end.
    if (grant.endsAt && (tell.time || !step.notice)) Object.assign(data, { endNoticeFor: grant.endsAt, endNoticeAt: step.next });
    // A held usage level leaves once told, or once it is no longer true.
    if (grant.usageNoticeSince && (tell.usage || !usage)) Object.assign(data, { usageNoticeLevel: null, usageNoticeSince: null });
    if (Object.keys(data).length === 0) return null;

    const moved = await tx.grant.updateMany({
      where: {
        id: grant.id,
        status: GrantStatus.active,
        endsAt: grant.endsAt,
        endNoticeFor: grant.endNoticeFor,
        endNoticeAt: grant.endNoticeAt,
        usageNoticeLevel: grant.usageNoticeLevel,
        usageNoticeSince: grant.usageNoticeSince,
      },
      data,
    });
    if (moved.count !== 1) return null;

    const event = retentionEvent(
      { tenantId: grant.tenantId, userId: grant.userId, grantId: grant.id, usagePeriod, endsAt: grant.endsAt },
      {
        usage: tell.usage && usage ? { level: usage.level, remaining: remainingLabel(grant.purchasedBytes - grant.consumedBytes) } : null,
        time: tell.time ? step.notice : null,
      },
      now,
    );
    if (!event) return null;
    await tx.outboxEvent.create({ data: { aggregate: GRANT_AGGREGATE, aggregateId: grant.id, type: event.type, payload: event.payload }, select: { id: true } });
    return event.type;
  }
}
