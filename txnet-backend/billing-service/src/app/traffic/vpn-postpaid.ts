import { randomUUID } from 'node:crypto';

import { GrantStatus, Prisma, RateCardMode } from '@prisma/client';
import { METER_KEYS, TenantBillingLedger } from '@txnet-backend/shared-core';

import { PostpaidHolds, type Ctx, type FundingLeg } from '../usage/postpaid-hold';
import { ceilDiv, CENT, max, priceUnits, UsageSettlementRefused } from '../usage/usage-price';
import type { WalletHoldService } from '../wallet/wallet-ledger.service';
import { vpnMeterOf } from './vpn-meter';
import { VpnWholesale, type WholesaleRoom } from './vpn-wholesale';

/**
 * VPN postpaid (F-118-k, ADR-0105 (6)(7)(12)): a metered Grant whose
 * `vpn.traffic` card was `postpaid` at the sale is served on **held** money
 * and charged after, never debited ahead.
 *
 * Its hold is its `grant_meter`'s (`ownerRef` = the meter id), as every
 * postpaid meter's is — so it is not the Grant's VPN reserve (F-118-b), which
 * the planner would count a second time. There is no reserve beside it: the
 * hold is the headroom, never below `VPN_RESERVE_BYTES` at the rate. Every
 * `funded` move mirrors onto the Grant's bag (`usage/postpaid-hold.ts`), so the
 * planner's bag, `purchasedBytes`, is `billed` plus what the hold covers —
 * the ceiling stands at what was consumed plus the held bytes (network
 * `contract.reserve.md`, unchanged: it leases the bag, and no reserve hold).
 *
 * - **The planner's block request** (`block-request.ts`) captures what was
 *   served, then holds what was asked on top of what is still held.
 * - **A top** (issue, every way back to active, the minute's sweep) holds the
 *   reserve's floor when the hold is short, and writes nothing otherwise —
 *   no capture a minute; the hourly settlement sweep captures.
 * - **A release** (suspension, freeze, cancel, close) captures what was
 *   served, gives the rest back, and brings the bag down to what was billed.
 *
 * On a reseller's Grant (F-118-n4, ADR-0105 (10)) the hold's growth is bought
 * wholesale first — the reseller's leg is prepaid whatever the user's mode —
 * so the bag grows only as far as its billing wallet reaches, by
 * `VpnWholesale`'s room, and each growth is one `metered_usage_charge` before
 * `funded` moves. A reseller at zero grows nothing; a hold still open is not
 * refused. Its own reference per growth: the guarded cursor is the guard.
 */

type Ref = { id: string; userId: string };

/** The Grant's `vpn.traffic` meter when it is postpaid, else null — a prepaid one keeps its blocks. */
export async function postpaidVpnMeter(tx: Prisma.TransactionClient, grantId: string) {
  const meter = await vpnMeterOf(tx, grantId);
  return meter?.mode === RateCardMode.postpaid ? meter : null;
}

/** What the planner's request came to. The bag is `purchasedBytes` as it now stands. */
export type ServedPostpaid = { captured: Prisma.Decimal; held: Prisma.Decimal; funded: bigint };

export class VpnPostpaid {
  private readonly postpaid: PostpaidHolds | null;
  /** The reseller's side of a growth (F-118-n4). Its ledger holds no state, so it needs no injection. */
  private readonly wholesale = new VpnWholesale(new TenantBillingLedger());

  constructor(
    holds: WalletHoldService | null,
    /** The hold's floor, in bytes at the Grant's rate: `VPN_RESERVE_BYTES`. */
    private readonly reserveBytes: bigint,
  ) {
    this.postpaid = holds ? new PostpaidHolds(holds) : null;
  }

  /**
   * The planner asked for `extraBytes` more headroom: capture what was served,
   * then hold that much on top of what is still held, and never less than
   * the floor. A short balance holds less; none at all is `insufficient_funds`,
   * which the block request reports as short, as it does a prepaid block's.
   */
  async serve(tx: Prisma.TransactionClient, grantId: string, extraBytes: bigint): Promise<ServedPostpaid> {
    const ctx = await this.load(tx, grantId);
    if (ctx.grant.status !== GrantStatus.active) throw new UsageSettlementRefused('grant_not_active', `${grantId} is ${ctx.grant.status}`);
    const holds = this.postpaid as PostpaidHolds;
    await holds.capture(tx, ctx);
    const held = await holds.heldCents(tx, ctx);
    const target = max(held + this.cents(ctx, extraBytes), this.cents(ctx, this.reserveBytes));
    return holds.topUpTo(tx, ctx, target, this.legOf(ctx));
  }

  /** Holds the floor when the hold is under it; answers what is held. Only a Grant the planner leases to (active, pending) holds more. */
  async top(tx: Prisma.TransactionClient, grantId: string): Promise<Prisma.Decimal> {
    if (!this.postpaid) return new Prisma.Decimal(0);
    const ctx = await this.load(tx, grantId);
    const held = await this.postpaid.heldCents(tx, ctx);
    const floor = this.cents(ctx, this.reserveBytes);
    const leased = ctx.grant.status === GrantStatus.active || ctx.grant.status === GrantStatus.pending;
    if (!leased || held >= floor) return new Prisma.Decimal(held.toString()).div(100);
    try {
      return (await this.postpaid.topUpTo(tx, ctx, floor, this.legOf(ctx))).held;
    } catch (e) {
      // An empty wallet — the user's or the reseller's — holds nothing: the planner's bag stays where it is and the block request reports it.
      if (e instanceof UsageSettlementRefused && (e.reason === 'insufficient_funds' || e.reason === 'wholesale_unfunded')) return new Prisma.Decimal(0);
      throw e;
    }
  }

  /** What is held for this Grant's traffic now. */
  async heldFor(tx: Prisma.TransactionClient, grant: Ref): Promise<Prisma.Decimal> {
    if (!this.postpaid) return new Prisma.Decimal(0);
    const cents = await this.postpaid.heldCents(tx, await this.load(tx, grant.id));
    return new Prisma.Decimal(cents.toString()).div(100);
  }

  /** Captures what was served and releases the rest; answers what was released. */
  async close(tx: Prisma.TransactionClient, grant: Ref): Promise<Prisma.Decimal> {
    if (!this.postpaid) return new Prisma.Decimal(0);
    return this.postpaid.close(tx, await this.load(tx, grant.id));
  }

  /** The reseller's leg of a growth, when the meter has one. `room` is read once and bounds the `buy` it precedes. */
  private legOf(ctx: Ctx): FundingLeg | undefined {
    if (!ctx.meter.wholesalePayerTenantId) return undefined;
    const bag = () => ctx.grant as { variantId: string; purchasedBytes: bigint; consumedBytes: bigint };
    let room: WholesaleRoom | null = null;
    return {
      room: async (tx, c) => (room = await this.wholesale.room(tx, bag(), c.meter))?.room ?? null,
      buy: (tx, c, grow) => this.wholesale.buy(tx, bag(), c.meter, room as WholesaleRoom, grow, randomUUID()),
    };
  }

  private load(tx: Prisma.TransactionClient, grantId: string): Promise<Ctx> {
    return (this.postpaid as PostpaidHolds).load(tx, { grantId, meterKey: METER_KEYS.vpnTraffic }, RateCardMode.postpaid);
  }

  /** `bytes` at the meter's rate, rounded **up** to a whole cent (the hold covers them). */
  private cents({ meter }: Ctx, bytes: bigint): bigint {
    if (bytes <= BigInt(0)) return BigInt(0);
    return ceilDiv(bytes * priceUnits(meter), meter.unitSize * CENT);
  }
}
