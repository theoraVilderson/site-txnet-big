import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

export type RetentionClaim = { eventId: string; userId: string; grantId: string; notice: string; period: string };

/**
 * The retention ledger (F-601-a, invariant 14): a retention notice is told
 * once per Grant period. worker-service claims the (Grant, notice, period) row
 * before it tells anyone; the unique index decides between two events racing
 * for one period, and `skipDuplicates` makes the loser a read, not an error.
 *
 * **The row is held by the event that wrote it.** The same event claims again,
 * so a notice whose send failed after its claim is still told when the event
 * is redelivered; any other event is refused.
 *
 * The app pool: the table has no `tenantId` and no RLS, and the caller is a
 * process on the internal seam, never a user.
 */
@Injectable()
export class RetentionLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(input: RetentionClaim): Promise<{ claimed: boolean }> {
    const row = { eventId: input.eventId, userId: input.userId, grantId: input.grantId, notice: input.notice, period: input.period };
    const { count } = await this.prisma.retentionNotice.createMany({ data: [row], skipDuplicates: true });
    if (count === 1) return { claimed: true };
    const held = await this.prisma.retentionNotice.findUnique({
      where: { grantId_notice_period: { grantId: input.grantId, notice: input.notice, period: input.period } },
      select: { eventId: true },
    });
    return { claimed: held?.eventId === input.eventId };
  }
}
