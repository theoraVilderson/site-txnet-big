import { GrantSource, GrantStatus, Prisma, QuotaMetric, VariantBillingMode } from '@prisma/client';

import { EntitlementRefused } from './grant';
import { reviveOnTopUp } from './purge';
import { emitReactivated, runs, standingClose } from './reactivated';
import { usedBytesOf } from './renewal';
import { QUOTA_EXHAUSTED } from './suspension';

export type TrafficChange = {
  adjustmentId: string;
  purchasedBytesBefore: bigint;
  purchasedBytesAfter: bigint;
  /** Σ lifetime counters at the change — the planner's Used. */
  usedBytes: bigint;
  /** The new Quota is at or below Used: the planner closes it on its next pass, and billing suspends it from that close. */
  spent: boolean;
  /** A Grant suspended for quota that the raise gave room again. */
  revived: boolean;
};

/** A Grant whose traffic only a renewal brings back (§4.4 one way, F-311-d). */
const CLOSED: readonly GrantStatus[] = [GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled];

/**
 * An admin changes a prepaid Grant's traffic by ±bytes (F-311-j), in the
 * caller's transaction. Quota is `purchasedBytes` — what the lease planner
 * splits into ceilings every pass (`network/contract.lease.md` rule 1) — so
 * the column moves, and one `quota_adjustment` row (source `admin_grant`, the
 * admin, the reason) says why (invariant 3). The planner reallocates on its
 * next pass; nothing is written on the network side.
 *
 * **A cut below Used is written, not refused.** It does not suspend here: the
 * planner's close is the one rule for "spent" (ADR-0096) — it closes on the
 * new Quota, and `suspendIfClosed` suspends the Grant as exhausted. `spent`
 * tells the admin that is coming. A raise that leaves room revives a Grant
 * suspended for quota (`reviveOnTopUp`, which leaves a frozen one frozen) and
 * tells the user (F-601-k), as a renewal does. No debt is forgiven and no
 * usage period is opened: the admin's figure is the change, whole.
 *
 * The write is conditional on the status and Quota read, so a renewal in
 * between is `grant_moved` — retry.
 */
export async function adjustGrantTraffic(
  tx: Prisma.TransactionClient,
  grantId: string,
  input: { at: Date; actorUserId: string; deltaBytes: bigint; reason: string },
): Promise<TrafficChange> {
  if (input.deltaBytes === BigInt(0)) throw new RangeError('a traffic change moves Quota: delta 0');

  const grant = await tx.grant.findUnique({
    where: { id: grantId },
    select: { id: true, tenantId: true, userId: true, status: true, statusReason: true, suspendedAt: true, billingMode: true, trafficUnlimited: true, purchasedBytes: true, endsAt: true },
  });
  if (!grant) throw new EntitlementRefused('grant_not_found', grantId);
  if (CLOSED.includes(grant.status)) throw new EntitlementRefused('grant_closed', grant.status);
  if (grant.status !== GrantStatus.active && grant.status !== GrantStatus.suspended) throw new EntitlementRefused('grant_not_active', grant.status);
  if (grant.billingMode !== VariantBillingMode.prepaid || grant.trafficUnlimited) throw new EntitlementRefused('traffic_not_adjustable', grantId);

  const before = grant.purchasedBytes;
  const after = before + input.deltaBytes;
  if (after < BigInt(0)) throw new EntitlementRefused('quota_below_zero', `${before} ${input.deltaBytes}`);

  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: grant.status, purchasedBytes: before },
    data: { purchasedBytes: after },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved', grantId);

  const row = await tx.quotaAdjustment.create({
    data: {
      tenantId: grant.tenantId,
      grantId,
      metric: QuotaMetric.traffic_bytes,
      delta: input.deltaBytes,
      source: GrantSource.admin_grant,
      reason: input.reason,
      createdByAdminId: input.actorUserId,
    },
    select: { id: true },
  });

  const usedBytes = await usedBytesOf(tx, grantId);
  const spent = after <= usedBytes;
  const revived =
    !spent && grant.status === GrantStatus.suspended && grant.statusReason === QUOTA_EXHAUSTED
      ? (await reviveOnTopUp(tx, grantId)).revived
      : false;
  // F-601-k: a stop this raise undid is told — a revival, or a close that
  // stood on the old Quota of a Grant not yet suspended for it (rule 25).
  if (!spent && input.deltaBytes > BigInt(0) && runs(grant.endsAt, input.at)) {
    const owner = { grantId, tenantId: grant.tenantId, userId: grant.userId };
    if (revived && grant.suspendedAt) await emitReactivated(tx, owner, grant.suspendedAt);
    else if (grant.status === GrantStatus.active) {
      const closedAt = await standingClose(tx, { id: grantId, purchasedBytes: before, endsAt: grant.endsAt }, true, input.at);
      if (closedAt) await emitReactivated(tx, owner, closedAt);
    }
  }

  return { adjustmentId: row.id, purchasedBytesBefore: before, purchasedBytesAfter: after, usedBytes, spent, revived };
}
