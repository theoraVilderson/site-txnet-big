/**
 * A verifying payment (F-092-x, ADR-0044 decisions 1, 2, 4).
 *
 * What would break silently here, and nowhere else:
 *  - "verifying" is `nextVerifyAt` being set on a `pending` row — never a new
 *    status. A write that touched `status` would slip past every guard
 *    ADR-0028 hangs off `status: pending`;
 *  - the ladder is 30 s, 1, 2, 5, 10, 30 min and then hourly, indexed by the
 *    attempts already made, and the write is guarded by that count so two
 *    silences racing cannot both schedule from the same rung;
 *  - silence at the callback schedules; a settled answer clears; the expiry
 *    sweep never closes a verifying row, because its holds must outlive it.
 */
import { PaymentStatus } from '@prisma/client';

import { clearVerifyRetry, scheduleVerifyRetry, verifyRetryDelaySec } from './verify-retry';

const PAYMENT = '77777777-7777-4777-8777-777777777777';

function fakeTx(count = 1) {
  const updated: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const tx = {
    paymentTransaction: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updated.push(args);
        return { count };
      },
    },
  };
  return { tx, updated };
}

describe('verifyRetryDelaySec', () => {
  it('climbs 30s, 1, 2, 5, 10, 30 min, then stays hourly', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 40].map(verifyRetryDelaySec)).toEqual([
      30, 60, 120, 300, 600, 1800, 3600, 3600, 3600,
    ]);
  });
});

describe('scheduleVerifyRetry', () => {
  it('sets the next rung and counts the attempt, guarded by status and the count it read', async () => {
    const { tx, updated } = fakeTx();
    const now = new Date('2026-09-14T10:00:00Z');

    const at = await scheduleVerifyRetry(tx as never, { id: PAYMENT, verifyAttempts: 2 }, now);

    expect(at).toEqual(new Date('2026-09-14T10:02:00Z'));
    expect(updated).toEqual([
      {
        where: { id: PAYMENT, status: PaymentStatus.pending, verifyAttempts: 2 },
        data: { verifyAttempts: 3, nextVerifyAt: new Date('2026-09-14T10:02:00Z') },
      },
    ]);
    expect(updated[0].data).not.toHaveProperty('status');
  });

  it('answers null when another path moved the row first', async () => {
    const { tx } = fakeTx(0);
    expect(await scheduleVerifyRetry(tx as never, { id: PAYMENT, verifyAttempts: 0 }, new Date())).toBeNull();
  });
});

describe('clearVerifyRetry', () => {
  it('clears the clock and keeps the attempt count as history', async () => {
    const { tx, updated } = fakeTx();

    await clearVerifyRetry(tx as never, PAYMENT);

    expect(updated).toEqual([
      { where: { id: PAYMENT, nextVerifyAt: { not: null } }, data: { nextVerifyAt: null } },
    ]);
  });
});
