import { randomUUID } from 'node:crypto';

import { GrantSource, Prisma, VariantBillingMode } from '@prisma/client';

import { trafficQuotaOf } from '../catalog/traffic-quota';
import { EntitlementRefused } from './grant';
import { renewGrant } from './renewal';

export type AdminRenew = {
  grantId: string;
  /** The caller's id for this one request: a repeat answers the renewal it made. */
  requestId: string;
  actorUserId: string;
  at: Date;
  reason: string | null;
  /** What the admin typed; absent = one period of the plan the user bought. */
  amount?: { bytes: bigint; days: number };
};

export type AdminRenewed = {
  renewalId: string;
  grantId: string;
  plan: boolean;
  bytes: bigint;
  days: number;
  forgivenBytes: bigint;
  purchasedBytesBefore: bigint;
  purchasedBytesAfter: bigint;
  endsAtBefore: Date | null;
  endsAtAfter: Date | null;
  /** A lapsed or spent Grant this renewal returned to `active`; false on a repeat. */
  revived: boolean;
  /** A stop the user was told of is undone: said in the admin's own notice (F-311-s); false on a repeat. */
  reactivated: boolean;
  /** False for a repeat of a request that already renewed this Grant. */
  renewed: boolean;
};

type RenewalRow = Omit<AdminRenewed, 'renewalId' | 'revived' | 'reactivated' | 'renewed'> & { id: string };

const renewedOf = (r: RenewalRow, revived: boolean, renewed: boolean, reactivated = false): AdminRenewed => ({
  renewalId: r.id,
  grantId: r.grantId,
  plan: r.plan,
  bytes: r.bytes,
  days: r.days,
  forgivenBytes: r.forgivenBytes,
  purchasedBytesBefore: r.purchasedBytesBefore,
  purchasedBytesAfter: r.purchasedBytesAfter,
  endsAtBefore: r.endsAtBefore,
  endsAtAfter: r.endsAtAfter,
  revived,
  reactivated,
  renewed,
});

/**
 * An admin renews a user's Grant in place (F-311-d): `renewGrant` with
 * `source = admin_grant` and the admin on each adjustment row — no invoice, no
 * money (user, 2026-09-28: the reseller collects outside the platform; a
 * renewal paid from the wallet is the user's own, F-305). Runs in the caller's
 * transaction and scope; the Grant being the path's user's is the caller's check.
 *
 * **One period of the plan the user bought**, unless the admin types an
 * amount: the Grant's own copied bag (`quotas.traffic_bytes`) and `periodDays`,
 * never the variant as it stands today. A metered or unlimited Grant's period
 * is its days alone. A dated Grant with no copied period (issued without a
 * variant) is `plan_period_unknown` — the admin types it.
 *
 * Everything else is `renewGrant`'s: the statuses it renews (a lapsed Grant
 * included, F-027-do), the debt it forgives, the revival, the refusals.
 *
 * **One request, one renewal.** `requestId` is unique on `grant_renewal`, so
 * a repeat answers the renewal it made with `renewed: false`; the same id on
 * another Grant is `request_reused`, and a concurrent repeat `already_renewed`.
 */
export async function renewGrantByAdmin(tx: Prisma.TransactionClient, input: AdminRenew): Promise<AdminRenewed> {
  const prior = await tx.grantRenewal.findUnique({ where: { requestId: input.requestId } });
  if (prior) {
    if (prior.grantId !== input.grantId) throw new EntitlementRefused('request_reused', input.requestId);
    return renewedOf(prior, false, false);
  }

  const grant = await tx.grant.findUnique({
    where: { id: input.grantId },
    select: { id: true, tenantId: true, billingMode: true, trafficUnlimited: true, quotas: true, periodDays: true, purchasedBytes: true, endsAt: true },
  });
  if (!grant) throw new EntitlementRefused('grant_not_found', input.grantId);

  const amount = input.amount ?? planPeriodOf(grant);
  // Chosen before the row exists: an unlimited plan's wholesale charge names it (F-118-z).
  const renewalId = randomUUID();
  const done = await renewGrant(tx, {
    grantId: grant.id,
    bytes: amount.bytes,
    days: amount.days,
    source: GrantSource.admin_grant,
    at: input.at,
    reason: input.reason,
    createdByAdminId: input.actorUserId,
    tellReactivated: false,
    referenceId: renewalId,
  });

  try {
    const row = await tx.grantRenewal.create({
      data: {
        id: renewalId,
        tenantId: grant.tenantId,
        grantId: grant.id,
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        plan: input.amount === undefined,
        bytes: amount.bytes,
        days: amount.days,
        forgivenBytes: done.forgivenBytes,
        purchasedBytesBefore: grant.purchasedBytes,
        purchasedBytesAfter: done.purchasedBytes,
        endsAtBefore: grant.endsAt,
        endsAtAfter: done.endsAt,
        reason: input.reason,
      },
    });
    return renewedOf(row, done.revived, true, done.reactivated);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new EntitlementRefused('already_renewed', input.requestId);
    throw e;
  }
}

/** One period of the plan the Grant was sold as: its own bag and days, copied at issue. */
function planPeriodOf(grant: { id: string; billingMode: VariantBillingMode; trafficUnlimited: boolean; quotas: Prisma.JsonValue; periodDays: number | null; endsAt: Date | null }) {
  if (grant.endsAt !== null && grant.periodDays === null) throw new EntitlementRefused('plan_period_unknown', grant.id);
  const traffic = grant.billingMode === VariantBillingMode.prepaid && !grant.trafficUnlimited ? trafficQuotaOf(grant.quotas) : null;
  return { bytes: traffic?.kind === 'limited' ? traffic.bytes : BigInt(0), days: grant.periodDays ?? 0 };
}
