import { GrantSource, GrantStatus, Prisma, QuotaMetric, VariantBillingMode } from '@prisma/client';

import { EntitlementRefused } from './grant';
import { PackageWholesale } from './package-wholesale';
import { reviveOnTopUp } from './purge';
import { runs, standingClose } from './reactivated';
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
  /** A stop the user was told of is undone and the Grant runs: the admin's notice says so, in the same message (F-311-s). */
  reactivated: boolean;
};

/** Its ledger holds no state. */
const PACKAGE_WHOLESALE = new PackageWholesale();

/** A raise of a reseller's plan buys what it added, wholesale, naming its adjustment row (F-118-p). */
async function buyWholesale(tx: Prisma.TransactionClient, grantId: string, adjustmentId: string): Promise<void> {
  const refused = await PACKAGE_WHOLESALE.settle(tx, grantId, adjustmentId);
  if (refused) throw new EntitlementRefused(refused, grantId);
}

/** A Grant whose traffic only a renewal brings back (§4.4 one way, F-311-d). */
const CLOSED: readonly GrantStatus[] = [GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled];

/** What both moves read, and refuse on: only a prepaid, limited, active or suspended Grant has a bag an admin moves. */
async function adjustable(tx: Prisma.TransactionClient, grantId: string) {
  const grant = await tx.grant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      tenantId: true,
      userId: true,
      status: true,
      statusReason: true,
      suspendedAt: true,
      billingMode: true,
      trafficUnlimited: true,
      purchasedBytes: true,
      trafficResetFromBytes: true,
      consumedBytes: true,
      endsAt: true,
    },
  });
  if (!grant) throw new EntitlementRefused('grant_not_found', grantId);
  if (CLOSED.includes(grant.status)) throw new EntitlementRefused('grant_closed', grant.status);
  if (grant.status !== GrantStatus.active && grant.status !== GrantStatus.suspended) throw new EntitlementRefused('grant_not_active', grant.status);
  if (grant.billingMode !== VariantBillingMode.prepaid || grant.trafficUnlimited) throw new EntitlementRefused('traffic_not_adjustable', grantId);
  return grant;
}

type Adjustable = Awaited<ReturnType<typeof adjustable>>;

/** What `settle` reads of a Grant — also a metered one's, for a gift (F-311-l, `traffic/gift-bytes.ts`). */
export type Settled = Pick<Adjustable, 'id' | 'tenantId' | 'userId' | 'status' | 'statusReason' | 'suspendedAt' | 'endsAt'>;

/** The row beside the column (invariant 3): source `admin_grant`, the admin, the reason. */
async function adjustmentRow(tx: Prisma.TransactionClient, grant: Adjustable, delta: bigint, input: { actorUserId: string; reason: string }) {
  const row = await tx.quotaAdjustment.create({
    data: {
      tenantId: grant.tenantId,
      grantId: grant.id,
      metric: QuotaMetric.traffic_bytes,
      delta,
      source: GrantSource.admin_grant,
      reason: input.reason,
      createdByAdminId: input.actorUserId,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * After Quota moved from `before` to `after`: whether it is spent, and — for a
 * raise that leaves room — the revival of a Grant suspended for quota
 * (`reviveOnTopUp`, which leaves a frozen one frozen), and whether a stop was
 * undone (F-601-k's test) — reported, not told: every caller is an admin's act,
 * whose own notice says it (F-311-s).
 */
export async function settle(tx: Prisma.TransactionClient, grant: Settled, at: Date, before: bigint, after: bigint, usedBytes: bigint) {
  const spent = after <= usedBytes;
  const revived =
    !spent && grant.status === GrantStatus.suspended && grant.statusReason === QUOTA_EXHAUSTED
      ? (await reviveOnTopUp(tx, grant.id)).revived
      : false;
  // F-601-k's test: a stop this raise undid — a revival, or a close that
  // stood on the old Quota of a Grant not yet suspended for it (rule 25).
  let reactivated = false;
  if (!spent && after > before && runs(grant.endsAt, at)) {
    if (revived && grant.suspendedAt) reactivated = true;
    else if (grant.status === GrantStatus.active) {
      reactivated = (await standingClose(tx, { id: grant.id, purchasedBytes: before, endsAt: grant.endsAt }, true, at)) !== null;
    }
  }
  return { spent, revived, reactivated };
}

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

  const grant = await adjustable(tx, grantId);
  const before = grant.purchasedBytes;
  const after = before + input.deltaBytes;
  if (after < BigInt(0)) throw new EntitlementRefused('quota_below_zero', `${before} ${input.deltaBytes}`);

  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: grant.status, purchasedBytes: before },
    data: { purchasedBytes: after },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved', grantId);

  const adjustmentId = await adjustmentRow(tx, grant, input.deltaBytes, input);
  if (input.deltaBytes > BigInt(0)) await buyWholesale(tx, grantId, adjustmentId);
  const usedBytes = await usedBytesOf(tx, grantId);
  const settled = await settle(tx, grant, input.at, before, after, usedBytes);
  return { adjustmentId, purchasedBytesBefore: before, purchasedBytesAfter: after, usedBytes, ...settled };
}

export type TrafficReset = TrafficChange & {
  /** What Quota rose by: Used since the last reset (`trafficResetFromBytes`). */
  resetBytes: bigint;
};

/**
 * An admin resets a prepaid Grant's traffic (F-311-k): the full bag is left
 * again. **The meter is never rewritten** (user, 2026-09-26) — `consumedBytes`
 * and the lifetime counters are usage history and billing evidence — so Quota
 * rises by what was used instead, one `admin_grant` row as any admin move.
 *
 * "What was used" is since the last reset: `trafficResetFromBytes` is Used at
 * that reset and moves to Used at this one, so Quota - Used after any number
 * of resets is the bag before the first. Like a renewal's bytes, a reset opens
 * a usage period (F-601-d), so the usage levels are told again of the bag it
 * leaves. It revives and is told as a raise is (`settle`). Nothing used since
 * the last reset is `nothing_to_reset`; the write is conditional on the
 * status, Quota and cursor read, so two resets racing are `grant_moved`.
 */
export async function resetGrantTraffic(
  tx: Prisma.TransactionClient,
  grantId: string,
  input: { at: Date; actorUserId: string; reason: string },
): Promise<TrafficReset> {
  const grant = await adjustable(tx, grantId);
  const usedBytes = await usedBytesOf(tx, grantId);
  const resetBytes = usedBytes - grant.trafficResetFromBytes;
  if (resetBytes <= BigInt(0)) throw new EntitlementRefused('nothing_to_reset', grantId);

  const before = grant.purchasedBytes;
  const after = before + resetBytes;
  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: grant.status, purchasedBytes: before, trafficResetFromBytes: grant.trafficResetFromBytes },
    data: { purchasedBytes: after, trafficResetFromBytes: usedBytes, usagePeriodFromBytes: grant.consumedBytes, usagePeriodStartedAt: input.at },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved', grantId);

  const adjustmentId = await adjustmentRow(tx, grant, resetBytes, input);
  await buyWholesale(tx, grantId, adjustmentId);
  const settled = await settle(tx, grant, input.at, before, after, usedBytes);
  return { adjustmentId, purchasedBytesBefore: before, purchasedBytesAfter: after, usedBytes, resetBytes, ...settled };
}
