import { GrantMeter, GrantSource, GrantStatus, Prisma, QuotaMetric, VariantBillingMode } from '@prisma/client';
import { AdmittedReseller, TenantBillingLedger } from '@txnet-backend/shared-core';

import { EntitlementRefused } from '../entitlement/grant';
import { usedBytesOf } from '../entitlement/renewal';
import { settle, TrafficChange } from '../entitlement/traffic';
import { WholesaleCursorMoved, WholesaleUnfunded } from '../usage/usage-wholesale';
import { vpnMeterOf } from './vpn-meter';
import { VpnWholesale, type WholesaleRoom } from './vpn-wholesale';

/** A Grant whose bytes only a renewal brings back (§4.4 one way, F-311-d). */
const CLOSED: readonly GrantStatus[] = [GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled];

/** Whose gift it is on a reseller's Grant (F-118-ac): the platform's staff's, or the reseller's own. */
export type GiftGiver = 'platform' | 'reseller';

/** The door's answer says it: platform staff are admitted `as: 'staff'`. */
export const giverOf = (admitted: Pick<AdmittedReseller, 'as'>): GiftGiver => (admitted.as === 'staff' ? 'platform' : 'reseller');

const WHOLESALE = new VpnWholesale(new TenantBillingLedger());

/**
 * An admin gifts bytes to a metered Grant (F-311-l), in the caller's
 * transaction. The second writer of a metered Grant's `purchasedBytes` beside the block
 * purchaser (invariant 15), and the only one that debits nothing.
 *
 * **Only the bag moves, never the money cursor.** `purchasedBytes` is the
 * planner's Quota, so no block is bought while the gift lasts; the meter's
 * `billed` is what the wallet paid for, and it stays. That is the whole exclusion from
 * the remainder credit (F-027-r): it gives back `billed - consumedBytes`,
 * so a gift is never in it: every byte served counts against what was paid
 * for first, and bytes unused at close are the gift's before they are the
 * wallet's. One `quota_adjustment` row, source
 * `admin_gift`, says whose bytes they were (invariant 3).
 *
 * On a reseller's Grant with a wholesale leg (F-118-ac, D-59 (f)) the
 * `giver` decides the reseller's side: a platform gift raises its cursor at no
 * charge (`VpnWholesale.gift`); its own staff's gift is bought as a block's
 * headroom is, the charge naming the adjustment row, and refused
 * `wholesale_unfunded` before anything moves when its wallet cannot fund it.
 *
 * A gift that leaves room revives a Grant suspended because its bag was spent
 * and is told (`settle`, as a prepaid raise). The write is conditional on the
 * status and bag read, so a block bought in between is `grant_moved` — retry.
 */
export async function giftGrantBytes(
  tx: Prisma.TransactionClient,
  grantId: string,
  input: { at: Date; actorUserId: string; bytes: bigint; reason: string; giver: GiftGiver },
): Promise<TrafficChange> {
  if (input.bytes <= BigInt(0)) throw new RangeError(`a gift adds bytes: ${input.bytes}`);

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
      variantId: true,
      purchasedBytes: true,
      consumedBytes: true,
      endsAt: true,
    },
  });
  if (!grant) throw new EntitlementRefused('grant_not_found', grantId);
  if (CLOSED.includes(grant.status)) throw new EntitlementRefused('grant_closed', grant.status);
  if (grant.status !== GrantStatus.active && grant.status !== GrantStatus.suspended) throw new EntitlementRefused('grant_not_active', grant.status);
  if (grant.billingMode !== VariantBillingMode.metered || grant.trafficUnlimited) throw new EntitlementRefused('grant_not_metered', grantId);

  const meter = await vpnMeterOf(tx, grantId);
  const leg = meter?.wholesalePayerTenantId ? meter : null;
  const room = leg && input.giver === 'reseller' ? await WHOLESALE.room(tx, grant, leg) : null;
  if (room?.room != null && room.room < input.bytes) throw new EntitlementRefused('wholesale_unfunded', grantId);

  const before = grant.purchasedBytes;
  const after = before + input.bytes;
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
      delta: input.bytes,
      source: GrantSource.admin_gift,
      reason: input.reason,
      createdByAdminId: input.actorUserId,
    },
    select: { id: true },
  });
  if (leg) await wholesaleOf(tx, grant, leg, room, input, row.id);
  const usedBytes = await usedBytesOf(tx, grantId);
  const settled = await settle(tx, grant, input.at, before, after, usedBytes);
  return { adjustmentId: row.id, purchasedBytesBefore: before, purchasedBytesAfter: after, usedBytes, ...settled };
}

/** The reseller's side of the gift, after the bag moved; the leg's errors as this route's refusals. */
async function wholesaleOf(
  tx: Prisma.TransactionClient,
  grant: { variantId: string; purchasedBytes: bigint; consumedBytes: bigint },
  meter: GrantMeter,
  room: WholesaleRoom | null,
  input: { bytes: bigint; giver: GiftGiver },
  adjustmentId: string,
): Promise<void> {
  try {
    if (input.giver === 'platform') await WHOLESALE.gift(tx, meter, input.bytes);
    else await WHOLESALE.buy(tx, grant, meter, room as WholesaleRoom, input.bytes, adjustmentId);
  } catch (e) {
    if (e instanceof WholesaleUnfunded) throw new EntitlementRefused('wholesale_unfunded', meter.grantId);
    if (e instanceof WholesaleCursorMoved) throw new EntitlementRefused('grant_moved', meter.grantId);
    throw e;
  }
}
