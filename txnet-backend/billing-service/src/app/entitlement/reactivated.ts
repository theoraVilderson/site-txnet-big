import { Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import type { CutOffGrant } from './cut-off';
import { GRANT_AGGREGATE } from './delivered';

/**
 * "Your service is active again" (F-601-k) — the answer to a cutoff notice
 * (F-601-b), told where the stop is undone:
 *
 * - a suspension revived (`reviveOnTopUp`), by a renewal or a top-up;
 *   `period` = the `suspendedAt` it cleared;
 * - a close that stood on an active Grant broken by a renewal — an unlimited
 *   or metered Grant past its end, which nothing suspends, or a prepaid one
 *   whose suspension has not been seen yet (`network/contract.lease.md` rule
 *   25); `period` = the close's `closedAt`.
 *
 * Either way only when the Grant can run once the write commits (`runs`): a
 * revival onto a passed end is closed again by the planner, and "active
 * again" would be the one false notice here.
 */
export async function emitReactivated(tx: Prisma.TransactionClient, grant: CutOffGrant, period: Date): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      aggregate: GRANT_AGGREGATE,
      aggregateId: grant.grantId,
      type: OutboxEventType.GRANT_REACTIVATED,
      payload: { tenantId: grant.tenantId, userId: grant.userId, grantId: grant.grantId, period: period.toISOString() },
    },
    select: { id: true },
  });
}

/** Whether a Grant ending at `endsAt` is still inside its time at `at` (a permanent one always is). */
export function runs(endsAt: Date | null, at: Date): boolean {
  return endsAt === null || endsAt.getTime() > at.getTime();
}

/**
 * The instant of the close that stands on this Grant as read, or null — the
 * same test `suspendIfClosed` holds (rule 25): the close's end is the Grant's,
 * and for a bag its Quota too. A bagless Grant's close counts only on a passed
 * end: a metered close on its bag is the wallet's, and a renewal of days
 * leaves it closed.
 */
export async function standingClose(
  tx: Prisma.TransactionClient,
  grant: { id: string; purchasedBytes: bigint; endsAt: Date | null },
  bagged: boolean,
  at: Date,
): Promise<Date | null> {
  const close = await tx.leaseClose.findUnique({
    where: { grantId: grant.id },
    select: { quotaBytes: true, expiresAt: true, closedAt: true },
  });
  if (!close || close.expiresAt?.getTime() !== grant.endsAt?.getTime()) return null;
  if (bagged) return close.quotaBytes === grant.purchasedBytes ? close.closedAt : null;
  return close.expiresAt !== null && close.expiresAt.getTime() <= at.getTime() ? close.closedAt : null;
}
