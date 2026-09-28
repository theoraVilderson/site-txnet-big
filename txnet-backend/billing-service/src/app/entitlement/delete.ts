import { DesiredRemote, EnforcementState, GrantStatus, Prisma } from '@prisma/client';

import { RemainderCreditRefused } from '../traffic/remainder-credit';
import { EntitlementRefused } from './grant';
import { ADMIN_FROZEN } from './suspension';

/**
 * `grant.statusReason` for a Grant an admin deleted (F-311-m). `cancelled` is
 * terminal (`grant_status_one_way`), so nothing lifts it: a user who should
 * have the service again is issued a new Grant.
 */
export const ADMIN_DELETED = 'admin_deleted';

/**
 * The remainder credit, handed in by the caller: `RemainderCreditService.settle`
 * lives in the traffic module, and this stays a function over the caller's
 * transaction like every other admin action (`freeze.ts`, `duration.ts`).
 * `stoppedAt` is when a frozen Grant's clock stopped — the cancel has already
 * overwritten the reason that says so by the time the credit reads the Grant.
 */
export type RemainderSettler = (
  tx: Prisma.TransactionClient,
  grantId: string,
  clock: { at: Date; stoppedAt: Date | null },
) => Promise<{ amount: Prisma.Decimal; walletTransactionId: string }>;

/** Why a refund that was asked for credited nothing: the settler's refusals that leave nothing to give back. */
export type RefundSkipped = Exclude<RemainderCreditRefused['reason'], 'cursor_moved' | 'grant_not_found' | 'grant_not_closed' | 'grant_not_prepaid'>;

export type Deletion = {
  deletionId: string;
  statusBefore: GrantStatus;
  configsReleased: number;
  refund: boolean;
  /** Whole cents credited back (a string, as money leaves this service), or null. */
  refundedAmount: string | null;
  walletTransactionId: string | null;
  refundSkipped: RefundSkipped | null;
};

/** Already off: only a renewal or a new Grant answers these (§4.4). */
const CLOSED: readonly GrantStatus[] = [GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled];

/**
 * An admin deletes a user's service (F-311-m), in the caller's transaction.
 *
 * The Grant becomes `cancelled`, `statusReason = admin_deleted`, and every
 * config still `present` moves to `desiredRemote = absent` **now** — the
 * purge's own desired-state write (`purge.ts`), without waiting out
 * `purgeAfterDays`. **No row is deleted** (invariant 13): the loop deletes the
 * client and clears `remoteId` once the panel confirms, and the Grant, its
 * configs and its usage stay as the history of what the user held.
 *
 * **The remainder is the admin's call** (user, 2026-09-26): `refund` gives the
 * remainder back, after the cancel so the Grant reads closed, in this
 * transaction — a metered bag's unserved bytes (F-027-r), a prepaid Grant's
 * unused share of its price by the larger of volume or time used (user,
 * 2026-09-28); without it (fraud) nothing moves. A refund that finds nothing —
 * all of it used, a Grant nobody paid for — still deletes, and says why.
 * The choice, the reason and what was credited are one `grant_deletion` row. A block bought between the read and the credit
 * (`cursor_moved`) is `grant_moved`: the whole delete rolls back, retry.
 *
 * An `active` or `suspended` Grant — frozen or out of quota alike; a timed
 * freeze's `frozenUntil` is cleared with it (`grant_frozen_until_is_frozen`).
 * A `pending` one is the delivery's to deliver or refund (invariant 14).
 */
export async function deleteGrant(
  tx: Prisma.TransactionClient,
  grantId: string,
  input: { at: Date; actorUserId: string; reason: string; refund: boolean },
  settle: RemainderSettler,
): Promise<Deletion> {
  const grant = await tx.grant.findFirst({ where: { id: grantId }, select: { id: true, tenantId: true, status: true, statusReason: true, suspendedAt: true } });
  if (!grant) throw new EntitlementRefused('grant_not_found');
  if (CLOSED.includes(grant.status)) throw new EntitlementRefused('grant_closed', grant.status);
  if (grant.status !== GrantStatus.active && grant.status !== GrantStatus.suspended) throw new EntitlementRefused('grant_not_active', grant.status);

  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: grant.status, statusReason: grant.statusReason },
    data: { status: GrantStatus.cancelled, statusReason: ADMIN_DELETED, frozenUntil: null },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved');

  const released = await tx.config.updateMany({
    where: { grantId, desiredRemote: DesiredRemote.present },
    // `enforcementState` reports how far the loop got with a desired state that has just changed (`purge.ts`).
    data: { desiredRemote: DesiredRemote.absent, desiredEnabled: false, enforcementState: EnforcementState.pending },
  });

  let credited: { amount: Prisma.Decimal; walletTransactionId: string } | null = null;
  let refundSkipped: RefundSkipped | null = null;
  if (input.refund) {
    try {
      const stoppedAt = grant.statusReason === ADMIN_FROZEN ? grant.suspendedAt : null;
      credited = await settle(tx, grantId, { at: input.at, stoppedAt });
    } catch (e) {
      if (!(e instanceof RemainderCreditRefused)) throw e;
      if (e.reason === 'cursor_moved') throw new EntitlementRefused('grant_moved', 'a block was bought meanwhile');
      if (e.reason === 'grant_not_found' || e.reason === 'grant_not_closed' || e.reason === 'grant_not_prepaid') throw e;
      refundSkipped = e.reason;
    }
  }

  const row = await tx.grantDeletion.create({
    data: {
      tenantId: grant.tenantId,
      grantId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      statusBefore: grant.status,
      refundRemainder: input.refund,
      refundedAmount: credited?.amount ?? null,
      walletTransactionId: credited?.walletTransactionId ?? null,
      refundSkipped,
    },
    select: { id: true },
  });

  return {
    deletionId: row.id,
    statusBefore: grant.status,
    configsReleased: released.count,
    refund: input.refund,
    refundedAmount: credited ? credited.amount.toFixed(2) : null,
    walletTransactionId: credited?.walletTransactionId ?? null,
    refundSkipped,
  };
}
