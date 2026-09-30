import { GrantMeter, GrantStatus, Prisma, RateCardAfterIncluded, RateCardMode, WalletHoldStatus, WalletReasonType } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import type { WalletHoldService } from '../wallet/wallet-ledger.service';
import { spendOnCap, withinCap } from './cap-funding';
import { capturable, CENT, max, min, moveCursors, priceUnits, toAmount, toCents, unitsCovered, UsageSettlementRefused, ZERO } from './usage-price';

/**
 * A postpaid meter's hold (F-118-g, ADR-0105 (6)): captured, topped, released.
 * Only `WalletHoldService` is needed, so the settlement's sweep and the VPN
 * reserve's free functions (F-118-k, `traffic/vpn-postpaid.ts`) share it.
 *
 * **`vpn.traffic` postpaid (F-118-k).** Its bytes arrive on the Grant's
 * `consumedBytes`, every Grant's measure, not on `grant_meter.consumed`
 * (F-118-f), so its `consumed` is read off it less what an admin gifted
 * (`purchasedBytes − funded`, F-311-l): gifted bytes are served first and
 * never charged. A `funded` move is mirrored onto the Grant's bag,
 * `purchasedBytes`, so the planner's bag is `funded` (plus any gift) and its
 * ceiling what the hold covers past what was billed; `billed` lives on the
 * meter alone (F-118-l). A prepaid `vpn.traffic` meter stays with the block
 * purchaser (`meter_on_its_own_path`).
 */

export type MeterRef = { grantId: string; meterKey: string };

export type Captured = { amount: Prisma.Decimal; billed: bigint; walletTransactionId: string | null };
export type ToppedUp = { captured: Prisma.Decimal; held: Prisma.Decimal; funded: bigint };

type HeldGrant = { id: string; userId: string; status: GrantStatus; variantId?: string; consumedBytes?: bigint; purchasedBytes?: bigint };
export type Ctx = { grant: HeldGrant; meter: GrantMeter };

/**
 * A second payer the bag's growth is bought on first (F-118-n4): the
 * reseller's wholesale leg of a postpaid VPN Grant, prepaid whatever the
 * user's mode (§14.5). `room` is how far `funded` may rise — null is no bound —
 * and `buy` pays for a rise of `grow` before `funded` moves.
 */
export type FundingLeg = {
  room(tx: Prisma.TransactionClient, ctx: Ctx): Promise<bigint | null>;
  buy(tx: Prisma.TransactionClient, ctx: Ctx, grow: bigint): Promise<void>;
};

/** A Grant that is never served again: its last capture leaves nothing to carry. */
const CLOSED: ReadonlySet<GrantStatus> = new Set([GrantStatus.expired, GrantStatus.cancelled, GrantStatus.exhausted]);

const isVpn = (meter: Pick<GrantMeter, 'meterKey'>) => meter.meterKey === METER_KEYS.vpnTraffic;

/** A postpaid `vpn.traffic` meter's `consumed`: the Grant's bytes less its gifts, which are served first. */
export function vpnConsumed(grant: { consumedBytes: bigint; purchasedBytes: bigint }, meter: Pick<GrantMeter, 'funded'>): bigint {
  const gifted = max(grant.purchasedBytes - meter.funded, ZERO);
  return max(grant.consumedBytes - gifted, ZERO);
}

export class PostpaidHolds {
  constructor(private readonly holds: WalletHoldService) {}

  async load(tx: Prisma.TransactionClient, ref: MeterRef, mode?: RateCardMode): Promise<Ctx> {
    const grant = await tx.grant.findUnique({
      where: { id: ref.grantId },
      select: { id: true, userId: true, status: true, variantId: true, consumedBytes: true, purchasedBytes: true },
    });
    if (!grant) throw new UsageSettlementRefused('grant_not_found', ref.grantId);
    const meter = await tx.grantMeter.findUnique({ where: { grantId_meterKey: { grantId: ref.grantId, meterKey: ref.meterKey } } });
    if (isVpn(ref) && meter?.mode !== RateCardMode.postpaid) throw new UsageSettlementRefused('meter_on_its_own_path');
    if (!meter) throw new UsageSettlementRefused('meter_not_on_grant', ref.meterKey);
    if (mode && meter.mode !== mode) throw new UsageSettlementRefused('wrong_mode', `${ref.meterKey} is ${meter.mode}`);
    if (mode && meter.afterIncluded === RateCardAfterIncluded.stop) throw new UsageSettlementRefused('not_metered_past_included', ref.meterKey);
    if (!isVpn(meter)) return { grant, meter };
    return { grant, meter: { ...meter, consumed: vpnConsumed(grant, meter) } };
  }

  /** `consumed − billed` captured from the hold (`usage_charge`), rounded down unless `up`, never past the hold. */
  async capture(tx: Prisma.TransactionClient, ctx: Ctx, round: 'down' | 'up' = 'down'): Promise<Captured> {
    const { meter, grant } = ctx;
    const { cents, billedTo } = capturable(meter, meter.billed, meter.consumed, await this.heldCents(tx, ctx), round);
    if (cents === ZERO) return { amount: new Prisma.Decimal(0), billed: meter.billed, walletTransactionId: null };

    await this.move(tx, ctx, { billed: billedTo });
    const amount = toAmount(cents);
    const row = await this.holds.capture(tx, {
      userId: grant.userId,
      ownerRef: meter.id,
      amount,
      currencyCode: meter.currencyCode,
      reasonType: WalletReasonType.usage_charge,
      referenceId: grant.id,
    });
    await spendOnCap(tx, grant.id, amount);
    return { amount, billed: billedTo, walletTransactionId: row.id };
  }

  /**
   * Captures, then holds up to `targetCents` from the free balance; a short one holds less, none at all is refused.
   * A `leg` bounds how far `funded` may rise and is paid for the rise before `funded` moves (F-118-n4).
   */
  async topUpTo(tx: Prisma.TransactionClient, ctx: Ctx, targetCents: bigint, leg?: FundingLeg): Promise<ToppedUp> {
    const captured = await this.capture(tx, ctx);
    const heldBefore = await this.heldCents(tx, ctx);
    const base = max(captured.billed, ctx.meter.includedQuantity);
    // Inside the Grant's spending cap, if it has one (F-118-i): this hold is already counted in it.
    let add = min(targetCents - heldBefore, toCents(await withinCap(tx, ctx.grant, await this.freeBalance(tx, ctx.grant.userId))));
    let short: 'insufficient_funds' | 'wholesale_unfunded' = 'insufficient_funds';
    const room = leg ? await leg.room(tx, ctx) : null;
    if (room !== null) {
      // The most the hold may reach so `funded` rises by `room` at most: those bytes priced **down**.
      const most = max(ctx.meter.funded + room - base, ZERO) * priceUnits(ctx.meter) / (ctx.meter.unitSize * CENT) - heldBefore;
      if (most < add) [add, short] = [most, 'wholesale_unfunded'];
    }
    if (add >= BigInt(1)) {
      await this.holds.hold(tx, { userId: ctx.grant.userId, ownerRef: ctx.meter.id, amount: toAmount(add), currencyCode: ctx.meter.currencyCode });
    } else if (heldBefore < BigInt(1) && targetCents > ZERO) {
      throw new UsageSettlementRefused(short);
    }
    const held = heldBefore + max(add, ZERO);
    const funded = base + unitsCovered(ctx.meter, held);
    if (leg && funded > ctx.meter.funded) await leg.buy(tx, ctx, funded - ctx.meter.funded);
    await this.move(tx, ctx, { funded });
    return { captured: captured.amount, held: toAmount(held), funded };
  }

  /**
   * Captures, releases the rest of the hold, and brings `funded` down to what was paid for.
   * A closed Grant's capture is its last, so it rounds **up** (F-118-al); a suspended or
   * frozen one may come back, and its dust is carried to the next capture as ever.
   */
  async close(tx: Prisma.TransactionClient, ctx: Ctx): Promise<Prisma.Decimal> {
    const { billed } = await this.capture(tx, ctx, CLOSED.has(ctx.grant.status) ? 'up' : 'down');
    const open = await this.openHold(tx, ctx);
    if (open) await this.holds.release(tx, { userId: ctx.grant.userId, ownerRef: ctx.meter.id });
    if (ctx.meter.funded !== billed) await this.move(tx, ctx, { funded: billed });
    return open?.amount ?? new Prisma.Decimal(0);
  }

  async heldCents(tx: Prisma.TransactionClient, ctx: Ctx): Promise<bigint> {
    const hold = await this.openHold(tx, ctx);
    return hold ? toCents(hold.amount) : ZERO;
  }

  async freeBalance(tx: Prisma.TransactionClient, userId: string): Promise<Prisma.Decimal> {
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: userId } });
    return wallet ? wallet.cachedBalance.minus(wallet.heldAmount) : new Prisma.Decimal(0);
  }

  async openHold(tx: Prisma.TransactionClient, { grant, meter }: Pick<Ctx, 'grant' | 'meter'>) {
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
    return wallet ? tx.walletHold.findFirst({ where: { walletId: wallet.id, ownerRef: meter.id, status: WalletHoldStatus.open } }) : null;
  }

  /** The guarded cursor move; on `vpn.traffic`, the Grant's bag follows `funded` by the same delta. */
  private async move(tx: Prisma.TransactionClient, ctx: Ctx, data: { billed?: bigint; funded?: bigint }): Promise<void> {
    await moveCursors(tx, ctx.meter, data);
    const funded = (data.funded ?? ctx.meter.funded) - ctx.meter.funded;
    ctx.meter = { ...ctx.meter, ...data };
    if (!isVpn(ctx.meter) || funded === ZERO) return;
    await tx.grant.update({ where: { id: ctx.grant.id }, data: { purchasedBytes: { increment: funded } } });
  }
}
