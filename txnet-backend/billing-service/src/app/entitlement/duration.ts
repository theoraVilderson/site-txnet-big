import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { EntitlementRefused } from './grant';
import { reviveOnRenewal } from './purge';
import { lapseToQuota, usedBytesOf } from './renewal';
import { PERIOD_ENDED } from './suspension';

const DAY_MS = 86_400_000;

/** ±N whole days from the end it has, or a new end. */
export type DurationMove = { days: number } | { endsAt: Date };

export type DurationChange = {
  changeId: string;
  endsAtBefore: Date;
  endsAtAfter: Date;
  /** A lapsed Grant (`period_ended`) the move returned to `active` (F-311-z). */
  revived: boolean;
  /** The move undid a stop the user was told of: the admin's notice says so, in the same message (F-311-s). */
  reactivated: boolean;
};

/** A Grant whose days only a renewal brings back (§4.4 one way, F-311-d). */
const CLOSED: readonly GrantStatus[] = [GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled];

/**
 * An admin moves a Grant's end (F-311-i), in the caller's transaction, and
 * writes the move down as one `grant_duration_change` row — duration is
 * `endsAt`, not a quota metric (§4.5), so it has its own history.
 *
 * `days` counts from the end the Grant has, not from now: "+3 days after an
 * outage" is three more days whatever is left. An `active` or `suspended`
 * Grant moves — frozen or out of volume alike, its reason untouched; a frozen
 * one still gets its frozen span on top when unfrozen (`freeze.ts`). The moved
 * end is what the lease planner reopens a standing close on (network
 * `contract.lease.md` rule 25) and what the time-threshold clock starts over
 * from (invariant 19), as for a renewal.
 *
 * **Days given back to a lapsed Grant revive it** (F-311-z, user 2026-09-28):
 * a Grant `suspended` as `period_ended` whose end the move puts ahead comes
 * back exactly as a renewal of days brings it (`renewal.ts`) — `active` and
 * told (F-601-k) when its bag has room or it has no bag, or waiting as
 * `quota_exhausted` on a spent bag. Otherwise it would be purged with days on it.
 *
 * The write is conditional on the status and end read, so a renewal or an
 * unfreeze in between is `grant_moved` — retry — and never an end moved twice.
 */
export async function changeGrantDuration(
  tx: Prisma.TransactionClient,
  grantId: string,
  input: { at: Date; actorUserId: string; change: DurationMove; reason: string },
): Promise<DurationChange> {
  const grant = await tx.grant.findFirst({
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
      startsAt: true,
      endsAt: true,
    },
  });
  if (!grant) throw new EntitlementRefused('grant_not_found');
  if (CLOSED.includes(grant.status)) throw new EntitlementRefused('grant_closed', grant.status);
  if (grant.status !== GrantStatus.active && grant.status !== GrantStatus.suspended) throw new EntitlementRefused('grant_not_active', grant.status);
  if (!grant.endsAt) throw new EntitlementRefused('grant_permanent');

  const before = grant.endsAt;
  const after = 'days' in input.change ? new Date(before.getTime() + input.change.days * DAY_MS) : input.change.endsAt;
  if (after.getTime() === before.getTime()) throw new EntitlementRefused('duration_unchanged');
  if (after.getTime() <= Math.max(input.at.getTime(), grant.startsAt.getTime())) throw new EntitlementRefused('duration_end_not_future');

  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: grant.status, endsAt: before },
    data: { endsAt: after },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved');

  const row = await tx.grantDurationChange.create({
    data: { tenantId: grant.tenantId, grantId, actorUserId: input.actorUserId, endsAtBefore: before, endsAtAfter: after, reason: input.reason },
    select: { id: true },
  });

  // The new end is in the future (refused above otherwise), so a lapsed Grant
  // has its time back; a bag must have room too, as for a renewal.
  let revived = false;
  if (grant.status === GrantStatus.suspended && grant.statusReason === PERIOD_ENDED) {
    const bagged = grant.billingMode === VariantBillingMode.prepaid && !grant.trafficUnlimited;
    if (!bagged || grant.purchasedBytes > (await usedBytesOf(tx, grant.id))) {
      revived = (await reviveOnRenewal(tx, grant.id)).revived;
    } else await lapseToQuota(tx, grant.id);
  }
  return { changeId: row.id, endsAtBefore: before, endsAtAfter: after, revived, reactivated: revived };
}
