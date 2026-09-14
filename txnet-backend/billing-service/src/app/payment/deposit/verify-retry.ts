import { PaymentStatus, Prisma } from '@prisma/client';

/**
 * A verifying payment's own retry clock (F-092-x, ADR-0044 decisions 1, 2).
 *
 * "Verifying" is not a status. It is a `pending` row whose `nextVerifyAt` is
 * set: the gateway was asked and said nothing settled, so somebody must ask
 * again, soon. Keeping the row `pending` is what leaves every status guard
 * ADR-0028 hangs off (`status: pending`) exactly as it was.
 *
 * The ladder starts short because the silence it answers usually is — the
 * user's measured Zarinpal downtime is about a minute (2026-09-14) — and
 * settles at hourly so a gateway that stays down is not hammered.
 */
export const VERIFY_RETRY_LADDER_SEC: readonly number[] = [30, 60, 120, 300, 600, 1800];
export const VERIFY_RETRY_HOURLY_SEC = 3600;

/** The wait before the next attempt, given how many attempts have already been made. */
export function verifyRetryDelaySec(attemptsSoFar: number): number {
  return VERIFY_RETRY_LADDER_SEC[attemptsSoFar] ?? VERIFY_RETRY_HOURLY_SEC;
}

/**
 * Silence: schedule the next ask and count this one.
 *
 * Guarded by `status: pending` **and** the attempt count the caller read, so a
 * callback and a sweep hearing silence at the same moment cannot both climb
 * from the same rung, and a row settled in between is left alone. Answers the
 * time scheduled, or `null` when the guard matched nothing.
 */
export async function scheduleVerifyRetry(
  tx: Prisma.TransactionClient,
  payment: { id: string; verifyAttempts: number },
  now: Date,
): Promise<Date | null> {
  const nextVerifyAt = new Date(now.getTime() + verifyRetryDelaySec(payment.verifyAttempts) * 1000);
  const { count } = await tx.paymentTransaction.updateMany({
    where: { id: payment.id, status: PaymentStatus.pending, verifyAttempts: payment.verifyAttempts },
    data: { verifyAttempts: payment.verifyAttempts + 1, nextVerifyAt },
  });
  return count === 1 ? nextVerifyAt : null;
}

/**
 * A settled answer: the payment is no longer verifying. `verifyAttempts` stays
 * — how many times it took is part of the record a person reads later.
 */
export async function clearVerifyRetry(tx: Prisma.TransactionClient, paymentId: string): Promise<void> {
  await tx.paymentTransaction.updateMany({
    where: { id: paymentId, nextVerifyAt: { not: null } },
    data: { nextVerifyAt: null },
  });
}
