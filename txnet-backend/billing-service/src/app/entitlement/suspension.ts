import { GrantStatus, Prisma } from '@prisma/client';

import { releaseVpnReserveOf } from '../traffic/vpn-reserve';

/**
 * `grant.statusReason` for a Grant suspended because its bag is spent and its
 * wallet cannot buy the next block (F-027-x, ADR-0075). `suspended` has two
 * meanings — out of quota, and suspended by someone — and this is the value
 * that tells them apart: the top-up that revives a Grant (F-027-y) revives
 * only this one.
 */
export const QUOTA_EXHAUSTED = 'quota_exhausted';

/**
 * `grant.statusReason` for a Grant whose bag is spent and whose **spending
 * cap** refuses the next block the wallet could buy (F-118-t, billing
 * `contract.spending-cap.md`). Its own reason, so the user is told "raise the
 * cap" rather than "top up". Revived like `quota_exhausted` — by bytes, or by
 * money the cap lets through (`reviveFundedGrants`, which a cap write runs).
 */
export const CAP_REACHED = 'cap_reached';

/** The reasons a usage stop carries: what a top-up, a cap write or new bytes revive (`reviveOnTopUp`). */
export const SPENT_REASONS: readonly string[] = [QUOTA_EXHAUSTED, CAP_REACHED];

/** Whether a Grant's `statusReason` is a usage stop — one bytes or money bring back. */
export const isSpentReason = (statusReason: string | null): boolean => statusReason !== null && SPENT_REASONS.includes(statusReason);

/**
 * `grant.statusReason` for a Grant an admin froze (F-311-h, `freeze.ts`): the
 * other meaning. Only `unfreezeGrant` lifts it, and it is never purged.
 */
export const ADMIN_FROZEN = 'admin_frozen';

/**
 * `grant.statusReason` for a Grant whose days ran out (F-027-do): the lease
 * planner's close stood on its passed end. `suspended`, not `expired` — which
 * `grant_status_one_way` makes terminal — so a renewal of days reaches the same
 * Grant, link and configs until the purge. Bytes alone never revive it.
 */
export const PERIOD_ENDED = 'period_ended';

export type Suspension = {
  /** False where the Grant was no longer `active` when the write reached it. Nothing was written. */
  suspended: boolean;
  configsDisabled: number;
};

/**
 * Suspends an `active` Grant for quota exhaustion, in the caller's transaction.
 *
 * **`suspended`, never `exhausted`.** `grant_status_one_way` makes `exhausted`
 * terminal, so a Grant put there could never be revived by the top-up the user
 * makes next (entitlement invariant 12). `suspendedAt` is written with it —
 * `grant_suspended_has_a_clock` refuses the row otherwise, and it is what the
 * purge clock (F-027-y) runs from.
 *
 * **Every config of the Grant, on every panel, gets `desiredEnabled = false`.**
 * It is desired state, not a command: the convergence loop carries it to each
 * panel when it next compares, and a top-up that sets it back before then is
 * simply what the loop finds (ADR-0075, no replay).
 *
 * It does not decide whether the Grant *is* exhausted — that is a question
 * about money, and the caller answers it (`traffic/exhaustion.ts`). The write
 * is conditional on `active`, so a Grant that moved on meanwhile is left
 * where it is, and a second call is a no-op.
 */
export async function suspendForExhaustion(tx: Prisma.TransactionClient, grantId: string, at: Date): Promise<Suspension> {
  return suspend(tx, grantId, at, QUOTA_EXHAUSTED);
}

/** The same stop when its spending cap, not the wallet, refuses the next block (F-118-t). */
export async function suspendForCap(tx: Prisma.TransactionClient, grantId: string, at: Date): Promise<Suspension> {
  return suspend(tx, grantId, at, CAP_REACHED);
}

/** The same stop for a Grant whose days ran out (F-027-do): its own reason, so bytes do not revive it. */
export async function suspendForPeriodEnd(tx: Prisma.TransactionClient, grantId: string, at: Date): Promise<Suspension> {
  return suspend(tx, grantId, at, PERIOD_ENDED);
}

async function suspend(tx: Prisma.TransactionClient, grantId: string, at: Date, statusReason: string): Promise<Suspension> {
  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.active },
    data: { status: GrantStatus.suspended, statusReason, suspendedAt: at },
  });
  if (moved.count === 0) return { suspended: false, configsDisabled: 0 };
  // Not planned while suspended: what its reserve held is free again (F-118-b).
  await releaseVpnReserveOf(tx, grantId);

  const disabled = await tx.config.updateMany({
    where: { grantId, desiredEnabled: true },
    data: { desiredEnabled: false },
  });
  return { suspended: true, configsDisabled: disabled.count };
}
