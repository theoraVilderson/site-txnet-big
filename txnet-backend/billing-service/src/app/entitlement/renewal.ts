import { GrantSource, GrantStatus, Prisma, QuotaMetric, VariantBillingMode } from '@prisma/client';

import { EntitlementRefused } from './grant';
import { PackageWholesale } from './package-wholesale';
import { reviveOnRenewal, reviveOnTopUp } from './purge';
import { emitReactivated, runs, standingClose } from './reactivated';
import { PERIOD_ENDED, QUOTA_EXHAUSTED, isSpentReason } from './suspension';

/**
 * A renewal is `Quota += X` on the same Grant (F-027-dg; SPEC weakness #30).
 *
 * Quota is `purchasedBytes` and Used is Σ lifetime counters over every config
 * of the Grant, retired ones included — both cumulative, both what the lease
 * planner reads (`network/contract.lease.md` rule 1). So a renewal on the same
 * Grant carries a period's over- or under-delivery to the next by arithmetic
 * alone: a credit is bytes still under Quota, a debt is Used already past it.
 * A new Grant per period would start Used at zero and drop both.
 *
 * The one rule on top is the user's (2026-09-27): **a debt of up to 2 GiB is
 * forgiven** — it is the panel's tick lag (±`v·J/√12`), which happens to
 * everyone and is nobody's doing — by raising Quota by the debt as well, as its
 * own `quota_adjustment` row. A debt above that is carried whole.
 *
 * The planner reopens a closed Grant when its Quota or end moved
 * (`contract.lease.md` rule 25), so this writes nothing on the network side.
 * A Grant whose days ran out is `suspended` as `period_ended` (F-027-do), not
 * `expired` — which `grant_status_one_way` makes terminal — so it is renewed
 * here in place until the purge: revived once its end is ahead again and, for
 * a bag, Quota past Used; with days but a spent bag, it waits as
 * `quota_exhausted`, its purge clock still running, for the bytes that revive it.
 */

/** Its ledger holds no state. */
const PACKAGE_WHOLESALE = new PackageWholesale();

const GIB = BigInt(1024 ** 3);
const DAY_MS = 86_400_000;

/** The largest debt a renewal forgives (user, 2026-09-27). */
export const DEBT_FORGIVEN_UP_TO = BigInt(2) * GIB;

/** `quota_adjustment.reason` of the row that forgives a debt. */
export const DEBT_FORGIVEN = 'debt_forgiven';

export type CarryOver = {
  /** Used past Quota at the renewal; zero when there was a credit. */
  debtBytes: bigint;
  /** The part of the debt added to Quota: all of it up to the bound, none above it. */
  forgivenBytes: bigint;
  /** What Quota rises by: the renewal's bytes plus what was forgiven. */
  raiseBytes: bigint;
};

/** How a renewal of `bytes` lands on a Grant at `purchasedBytes` / `usedBytes`. */
export function carryOver(input: { purchasedBytes: bigint; usedBytes: bigint; bytes: bigint }): CarryOver {
  const over = input.usedBytes - input.purchasedBytes;
  const debtBytes = over > BigInt(0) ? over : BigInt(0);
  const forgivenBytes = debtBytes <= DEBT_FORGIVEN_UP_TO ? debtBytes : BigInt(0);
  return { debtBytes, forgivenBytes, raiseBytes: input.bytes + forgivenBytes };
}

export type RenewGrant = {
  grantId: string;
  /** Traffic added; 0 for a renewal of days alone (the only kind a metered or unlimited Grant takes). */
  bytes: bigint;
  /** Days added to the end, from now when the end has already passed; a permanent Grant stays permanent. */
  days: number;
  source: GrantSource;
  at?: Date;
  reason?: string | null;
  createdByAdminId?: string | null;
  /** False: the caller tells the revival in its own notice (an admin's renewal, F-311-s); `reactivated` reports it. */
  tellReactivated?: boolean;
};

export type Renewal = CarryOver & {
  grantId: string;
  purchasedBytes: bigint;
  endsAt: Date | null;
  /** A Grant suspended for quota that the raise gave room again. */
  revived: boolean;
  /** A stop the user was told of is undone and the Grant runs (F-601-k's test). */
  reactivated: boolean;
};

/** Used: Σ lifetime counters over every config of the Grant, retired ones included — the planner's sum. */
export async function usedBytesOf(tx: Prisma.TransactionClient, grantId: string): Promise<bigint> {
  const configs = await tx.config.findMany({
    where: { grantId },
    select: { counterState: { select: { lifetimeUpBytes: true, lifetimeDownBytes: true } } },
  });
  return configs.reduce(
    (sum, c) => sum + (c.counterState ? c.counterState.lifetimeUpBytes + c.counterState.lifetimeDownBytes : BigInt(0)),
    BigInt(0),
  );
}

const RENEWABLE: ReadonlySet<GrantStatus> = new Set([GrantStatus.active, GrantStatus.suspended]);

/** Renews a Grant in place, inside the caller's transaction. */
export async function renewGrant(tx: Prisma.TransactionClient, input: RenewGrant): Promise<Renewal> {
  const at = input.at ?? new Date();
  if (input.bytes < BigInt(0) || input.days < 0 || !Number.isInteger(input.days)) {
    throw new RangeError(`a renewal adds: bytes ${input.bytes}, days ${input.days}`);
  }
  if (input.bytes === BigInt(0) && input.days === 0) throw new EntitlementRefused('nothing_to_renew', input.grantId);

  const grant = await tx.grant.findUnique({
    where: { id: input.grantId },
    select: { id: true, tenantId: true, userId: true, suspendedAt: true, status: true, statusReason: true, billingMode: true, trafficUnlimited: true, purchasedBytes: true, endsAt: true, consumedBytes: true },
  });
  if (!grant) throw new EntitlementRefused('grant_not_found', input.grantId);
  if (!RENEWABLE.has(grant.status)) throw new EntitlementRefused('grant_not_renewable', `${grant.id} is ${grant.status}`);

  // A metered Grant's bytes are bought by its blocks, an unlimited one has no
  // bag: neither carries a debt, and both renew by days alone.
  const bagged = grant.billingMode === VariantBillingMode.prepaid && !grant.trafficUnlimited;
  if (!bagged && input.bytes > BigInt(0)) throw new EntitlementRefused('traffic_not_renewable', grant.id);

  const usedBytes = await usedBytesOf(tx, grant.id);
  const carry = bagged
    ? carryOver({ purchasedBytes: grant.purchasedBytes, usedBytes, bytes: input.bytes })
    : { debtBytes: BigInt(0), forgivenBytes: BigInt(0), raiseBytes: BigInt(0) };

  const purchasedBytes = grant.purchasedBytes + carry.raiseBytes;
  const from = grant.endsAt && grant.endsAt.getTime() > at.getTime() ? grant.endsAt : at;
  const endsAt = grant.endsAt === null ? null : new Date(from.getTime() + input.days * DAY_MS);

  // Conditional on what was read: two renewals racing would each forgive the
  // same debt, and a block purchase between would be overwritten.
  const moved = await tx.grant.updateMany({
    where: { id: grant.id, status: grant.status, purchasedBytes: grant.purchasedBytes, endsAt: grant.endsAt },
    data: {
      purchasedBytes,
      endsAt,
      // A moved end is set now: its notices are counted from here (F-601-r).
      ...(endsAt === null ? {} : { endSetAt: at }),
      // Bytes bought open a new usage period (F-601-d): its thresholds are a
      // share of what it starts with, measured from here. Days alone do not —
      // the bag is the one already being counted.
      ...(input.bytes > BigInt(0) ? { usagePeriodFromBytes: grant.consumedBytes, usagePeriodStartedAt: at } : {}),
    },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved', grant.id);

  // Invariant 3: a quota changes only by an adjustment row, never edited.
  const row = (delta: bigint, reason: string | null) =>
    tx.quotaAdjustment.create({
      data: {
        tenantId: grant.tenantId,
        grantId: grant.id,
        metric: QuotaMetric.traffic_bytes,
        delta,
        source: input.source,
        reason,
        createdByAdminId: input.createdByAdminId ?? null,
      },
    });
  const added = input.bytes > BigInt(0) ? await row(input.bytes, input.reason ?? null) : null;
  const forgiven = carry.forgivenBytes > BigInt(0) ? await row(carry.forgivenBytes, DEBT_FORGIVEN) : null;
  // A reseller's plan buys what the raise added, wholesale (F-118-p); the charge names the raise.
  const raise = added ?? forgiven;
  if (raise) {
    const refused = await PACKAGE_WHOLESALE.settle(tx, grant.id, raise.id);
    if (refused) throw new EntitlementRefused(refused, grant.id);
  }

  const room = !bagged || purchasedBytes > usedBytes;
  let revived = false;
  if (grant.status === GrantStatus.suspended && isSpentReason(grant.statusReason) && bagged && room) {
    revived = (await reviveOnTopUp(tx, grant.id)).revived;
  } else if (grant.status === GrantStatus.suspended && grant.statusReason === PERIOD_ENDED && runs(endsAt, at)) {
    if (room) revived = (await reviveOnRenewal(tx, grant.id)).revived;
    else await lapseToQuota(tx, grant.id);
  }

  // F-601-k: a stop this renewal undid is told, once the Grant can run again.
  // The close is read only for an active Grant — a suspended one is back by
  // the revival or not at all.
  let undone: Date | null = null;
  if (runs(endsAt, at)) {
    if (revived && grant.suspendedAt) undone = grant.suspendedAt;
    else if (grant.status === GrantStatus.active && room) undone = await standingClose(tx, grant, bagged, at);
  }
  const owner = { grantId: grant.id, tenantId: grant.tenantId, userId: grant.userId };
  if (undone && input.tellReactivated !== false) await emitReactivated(tx, owner, undone);

  return { grantId: grant.id, ...carry, purchasedBytes, endsAt, revived, reactivated: undone !== null };
}

/**
 * A Grant whose days ran out, renewed by days onto a spent bag: time is back,
 * traffic is not. Its reason becomes the one the next bytes revive; the purge
 * clock keeps running, as the user has had no service since it started.
 */
export async function lapseToQuota(tx: Prisma.TransactionClient, grantId: string): Promise<void> {
  await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.suspended, statusReason: PERIOD_ENDED },
    data: { statusReason: QUOTA_EXHAUSTED },
  });
}
