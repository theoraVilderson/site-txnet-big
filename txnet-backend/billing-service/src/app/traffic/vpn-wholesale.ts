import { Grant, GrantMeter, GrantStatus, PanelOwnershipType, Prisma } from '@prisma/client';
import type { TenantBillingLedger } from '@txnet-backend/shared-core';

import { toCents, unitsCovered, ZERO } from '../usage/usage-price';
import { WholesaleLeg } from '../usage/usage-wholesale';
import { vpnMeterOf } from './vpn-meter';

/**
 * The wholesale leg of a VPN block (F-118-n3, ADR-0105 (10), §14.5): a block
 * on a reseller's metered Grant is also bought on the reseller's
 * `tenant_billing_wallet`, prepaid whatever the user's mode, at the rate the
 * Grant locked (F-118-n2). The per-use door's `WholesaleLeg` moves the money;
 * this says how many bytes the reseller owes for.
 *
 * `wholesaleBilled` is the cursor, over `wholesaleConsumed` — the bytes served
 * on **platform** panels (F-118-n6). A block moves it to
 *
 *     wholesaleConsumed + headroom after the block        (group has a platform panel)
 *     wholesaleConsumed                                   (its own panels only)
 *
 * and never down: a byte the reseller bought ahead and its own panel served
 * funds the next platform byte instead of being charged again, and whatever is
 * left comes back at close (`giveBack`). Headroom is prepaid only where a
 * platform panel could serve it (user, 2026-09-29), so a reseller at zero cuts
 * the users on groups holding a platform panel and no others.
 */

/** What a reseller's side allows a block. `room` is the most bytes it may add to the bag; null is no bound. */
export type WholesaleRoom = { ahead: boolean; room: bigint | null };

type Bag = Pick<Grant, 'variantId' | 'purchasedBytes' | 'consumedBytes'>;

const CLOSED: ReadonlySet<GrantStatus> = new Set([GrantStatus.expired, GrantStatus.cancelled, GrantStatus.exhausted]);

const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** Whether a variant's group holds a platform-owned panel now — members change after the sale. Also a package plan's question (F-118-p). */
export async function onPlatformPanel(tx: Prisma.TransactionClient, variantId: string): Promise<boolean> {
  const variant = await tx.productVariant.findUnique({ where: { id: variantId }, select: { panelGroupId: true } });
  if (!variant?.panelGroupId) return false;
  const member = await tx.panelGroupMember.findFirst({
    where: { groupId: variant.panelGroupId, panel: { ownershipType: PanelOwnershipType.platform } },
    select: { panelId: true },
  });
  return member !== null;
}

export class VpnWholesale {
  private readonly leg: WholesaleLeg;

  constructor(ledger: TenantBillingLedger) {
    this.leg = new WholesaleLeg(ledger);
  }

  /** Whether the Grant's group holds a platform-owned panel now — members change after the sale. */
  onPlatformPanel(tx: Prisma.TransactionClient, variantId: string): Promise<boolean> {
    return onPlatformPanel(tx, variantId);
  }

  /** What the reseller's balance allows the next block; null when the meter has no wholesale leg. Reads only. */
  async room(tx: Prisma.TransactionClient, grant: Bag, meter: GrantMeter): Promise<WholesaleRoom | null> {
    if (!meter.wholesalePayerTenantId) return null;
    const ahead = await this.onPlatformPanel(tx, grant.variantId);
    const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId: meter.wholesalePayerTenantId } });
    const rate = { unitSize: meter.wholesaleUnitSize!, unitPrice: meter.wholesaleUnitPrice!, includedQuantity: ZERO };
    // Every byte it can buy past its cursor, rounded down: the price of any figure up to it is at most the balance.
    const reach = meter.wholesaleBilled + unitsCovered(rate, toCents(wallet?.cachedBalance ?? new Prisma.Decimal(0)));
    if (meter.wholesaleConsumed > reach) return { ahead, room: ZERO };
    if (!ahead) return { ahead, room: null };
    return { ahead, room: reach - meter.wholesaleConsumed - (grant.purchasedBytes - grant.consumedBytes) };
  }

  /**
   * The cursor to the figure a block of `bytes` leaves owed, and one
   * `metered_usage_charge` naming the block's own wallet row. Nothing when the
   * cursor already covers it. `room` bounded the block, so this is funded.
   */
  async buy(tx: Prisma.TransactionClient, grant: Bag, meter: GrantMeter, room: WholesaleRoom, bytes: bigint, blockId: string): Promise<void> {
    const headroom = room.ahead ? max(ZERO, grant.purchasedBytes + bytes - grant.consumedBytes) : ZERO;
    const plan = await this.leg.plan(tx, meter, meter.wholesaleConsumed + headroom);
    if (plan) await this.leg.buy(tx, meter, plan, blockId);
  }

  /**
   * At close: what the reseller bought and no platform panel served, back as
   * `metered_usage_refund` priced down, the cursor to `wholesaleConsumed`. The
   * cursor is the guard, so a second close gives nothing. An open Grant, or one
   * with no leg, moves nothing.
   */
  async giveBack(tx: Prisma.TransactionClient, grantId: string): Promise<void> {
    const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { status: true } });
    if (!grant || !CLOSED.has(grant.status)) return;
    const meter = await vpnMeterOf(tx, grantId);
    if (!meter?.wholesalePayerTenantId) return;
    await this.leg.giveBack(tx, meter, meter.wholesaleConsumed, grantId);
  }
}
