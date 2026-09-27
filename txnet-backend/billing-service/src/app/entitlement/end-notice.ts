import { Injectable, Logger } from '@nestjs/common';
import { GrantStatus, Prisma } from '@prisma/client';
import { OutboxEventType, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { GRANT_AGGREGATE } from './delivered';

const DAY_MS = 86_400_000;

/** Due Grants one sweep reads. The scan drains itself: every check sets the clock for the end it read. */
const END_NOTICE_BATCH = 500;

type EndNotice = typeof OutboxEventType.GRANT_ENDS_IN_7D | typeof OutboxEventType.GRANT_ENDS_IN_3D | typeof OutboxEventType.GRANT_ENDS_IN_1D;

/** The levels, farthest first (F-601-e, spec 9.5). One type per level: notification's ledger holds each once per end. */
const END_LEVELS: ReadonlyArray<{ days: number; type: EndNotice }> = [
  { days: 7, type: OutboxEventType.GRANT_ENDS_IN_7D },
  { days: 3, type: OutboxEventType.GRANT_ENDS_IN_3D },
  { days: 1, type: OutboxEventType.GRANT_ENDS_IN_1D },
];

/** How far ahead the sweep looks: the farthest level. */
const END_HORIZON_MS = END_LEVELS[0].days * DAY_MS;

/**
 * One due check: the level to tell (with the whole days actually left), and
 * the instant of the next level (`null` = none left for this end).
 *
 * The levels already handled for this end are those before `endNoticeAt`,
 * while `endNoticeFor` is this end. For an end seen for the first time —
 * renewed, or never checked — they are those before `activeSince`: a level
 * that fell due before the Grant was active is not news, it is the product.
 */
export function endNoticeStep(
  g: { endsAt: Date; activeSince: Date; endNoticeFor: Date | null; endNoticeAt: Date | null },
  now: Date,
): { notice: { type: EndNotice; days: number } | null; next: Date | null } {
  const end = g.endsAt.getTime();
  const t = now.getTime();
  if (end <= t) return { notice: null, next: null };

  const sameEnd = g.endNoticeFor?.getTime() === end;
  if (sameEnd && g.endNoticeAt === null) return { notice: null, next: null };
  const floor = sameEnd && g.endNoticeAt ? g.endNoticeAt.getTime() : g.activeSince.getTime();

  const at = (days: number) => end - days * DAY_MS;
  // The nearest level due: a sweep late past two tells the latest truth alone.
  const due = END_LEVELS.filter((l) => at(l.days) <= t && at(l.days) >= floor).pop();
  const upcoming = END_LEVELS.find((l) => at(l.days) > t);
  return {
    notice: due ? { type: due.type, days: Math.ceil((end - t) / DAY_MS) } : null,
    next: upcoming ? new Date(at(upcoming.days)) : null,
  };
}

export type EndNoticeResult = { scanned: number; told: number };

/**
 * Time thresholds (F-601-e, spec 9.5): an active Grant 7, 3 and 1 day(s)
 * from its end emits a retention event, and `worker-service` tells the user
 * how long is left (notification `contract.retention.md`). Unlimited and
 * metered Grants alike — only a permanent one (`endsAt = null`) has no end.
 *
 * **The clock belongs to the end it was set for.** `endNoticeFor` records
 * that end and `endNoticeAt` its next level; a renewal moves `endsAt`, and the
 * sweep finds the mismatch by itself, so no writer of `endsAt` has to reset
 * anything. The write is conditional on everything it read: two sweeps racing,
 * or a renewal landing between read and write, emit nothing twice, and the
 * ledger's `(Grant, level, period)` row — the period is the end — holds the
 * line past that.
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
    const due = await this.crossTenant.grant.findMany({
      where: {
        status: GrantStatus.active,
        endsAt: { gt: now, lte: new Date(now.getTime() + END_HORIZON_MS) },
        // Never checked, set for another end (renewed), or its next level due.
        OR: [{ endNoticeFor: null }, { NOT: { endNoticeFor: { equals: fields.endsAt } } }, { endNoticeAt: { lte: now } }],
      },
      select: { id: true, tenantId: true },
      orderBy: { endsAt: 'asc' },
      take: END_NOTICE_BATCH,
    });
    let told = 0;
    for (const grant of due) {
      const notice = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.check(tx, grant.id, now)));
      if (notice) told += 1;
    }
    if (told > 0) this.logger.log(`told ${told} of ${due.length} due Grant(s) their end is near`);
    return { scanned: due.length, told };
  }

  /** One Grant's check, in the caller's tenant transaction. Answers the notice it emitted, if any. */
  async check(tx: Prisma.TransactionClient, grantId: string, now: Date): Promise<EndNotice | null> {
    const grant = await tx.grant.findFirst({
      where: { id: grantId, status: GrantStatus.active },
      select: { id: true, tenantId: true, userId: true, startsAt: true, activatedAt: true, endsAt: true, endNoticeFor: true, endNoticeAt: true },
    });
    if (!grant?.endsAt) return null;

    const step = endNoticeStep({ ...grant, endsAt: grant.endsAt, activeSince: grant.activatedAt ?? grant.startsAt }, now);
    const moved = await tx.grant.updateMany({
      where: { id: grant.id, status: GrantStatus.active, endsAt: grant.endsAt, endNoticeFor: grant.endNoticeFor, endNoticeAt: grant.endNoticeAt },
      data: { endNoticeFor: grant.endsAt, endNoticeAt: step.next },
    });
    if (moved.count !== 1 || !step.notice) return null;

    await tx.outboxEvent.create({
      data: {
        aggregate: GRANT_AGGREGATE,
        aggregateId: grant.id,
        type: step.notice.type,
        payload: {
          tenantId: grant.tenantId,
          userId: grant.userId,
          grantId: grant.id,
          period: grant.endsAt.toISOString(),
          days: String(step.notice.days),
        },
      },
      select: { id: true },
    });
    return step.notice.type;
  }
}
