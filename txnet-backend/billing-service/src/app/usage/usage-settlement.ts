import { Injectable, Logger } from '@nestjs/common';
import { GrantMeter, GrantStatus, Prisma, RateCardAfterIncluded, RateCardMode, WalletHoldStatus, WalletReasonType } from '@prisma/client';
import { METER_KEYS, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletHoldService, WalletLedgerService, WalletVersionConflict } from '../wallet/wallet-ledger.service';
import {
  blockFor,
  capturable,
  ceilDiv,
  CENT,
  max,
  min,
  moveCursors,
  priceUnits,
  toAmount,
  toCents,
  unitsCovered,
  UsageSettlementRefused,
  ZERO,
} from './usage-price';
import { UsageRefundService } from './usage-refund';

export { blockFor, capturable, UsageSettlementRefused } from './usage-price';
export type { UsageSettlementRefusal } from './usage-price';

/**
 * Rating and settlement of a Grant's meters (F-118-g, ADR-0105 (5)(6)(11)):
 * the money side of `grant_meter`. Usage intake (F-118-f) advances `consumed`;
 * this turns `consumed − billed` into ledger rows, and says how far a meter is
 * `funded` — what its enforcer may serve (decision 7).
 *
 * - **Prepaid** is ADR-0072 for every meter: a block is debited before its
 *   units are served (`funded` and `billed` up together), and at close the
 *   units bought and never used are credited back.
 * - **Postpaid** holds money (`WalletHoldService`, `ownerRef` = the
 *   `grant_meter` id) topped up to a target, captures what was measured —
 *   hourly, before each re-top and at close — and releases the rest at close.
 *
 * **Whole cents, in the buyer's favour.** A block's price is rounded up and
 * buys the units its cents cover, rounded down; a capture is rounded down and
 * `billed` advances only by the units its cents cover, so the rounded-away
 * part is carried to the next capture rather than charged or lost. What is
 * left under a cent at close is never charged. The included quantity is free:
 * the cursors jump over it and nothing prices it.
 *
 * Every write here is in the caller's `tx`, which must come from
 * `tenantTransaction` (the ledger writes a registered model). Each cursor move
 * is guarded on the value read, so a racing settlement loses with
 * `cursor_moved` and nothing written.
 *
 * `vpn.traffic` keeps its byte engine (`traffic/block-purchase.ts`) until
 * F-118-k moves VPN postpaid onto this one.
 */


export type MeterRef = { grantId: string; meterKey: string };

export type Captured = { amount: Prisma.Decimal; billed: bigint; walletTransactionId: string | null };
export type Bought = { amount: Prisma.Decimal; units: bigint; funded: bigint; walletTransactionId: string };
export type ToppedUp = { captured: Prisma.Decimal; held: Prisma.Decimal; funded: bigint };
/** Hold owners one sweep reads; each capture clears its own due. */
const CAPTURE_BATCH = 500;

export type CaptureDueResult = { scanned: number; captured: number; errors: number };

export type Ctx = { grant: { id: string; userId: string; status: GrantStatus }; meter: GrantMeter };

@Injectable()
export class UsageSettlementService {
  private readonly logger = new Logger(UsageSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly ledger: WalletLedgerService,
    private readonly holds: WalletHoldService,
    private readonly refunds: UsageRefundService,
  ) {}

  /** Prepaid: debits a block of about `targetUnits` (`usage_charge`), then `funded` and `billed` up by it. */
  async buyBlock(tx: Prisma.TransactionClient, input: MeterRef & { targetUnits: bigint }): Promise<Bought> {
    const { grant, meter } = await this.load(tx, input, RateCardMode.prepaid);
    if (grant.status !== GrantStatus.active) throw new UsageSettlementRefused('grant_not_active', grant.status);

    const block = blockFor(meter, input.targetUnits, await this.freeBalance(tx, grant.userId));
    const funded = max(meter.funded, meter.includedQuantity) + block.units;
    await moveCursors(tx, meter, { funded, billed: max(meter.billed, meter.includedQuantity) + block.units });
    const amount = toAmount(block.cents);
    const row = await this.ledger.debit(tx, {
      userId: grant.userId,
      amount,
      currencyCode: meter.currencyCode,
      reasonType: WalletReasonType.usage_charge,
      referenceId: grant.id,
    });
    return { amount, units: block.units, funded, walletTransactionId: row.id };
  }

  /**
   * Postpaid: captures what was measured, then tops the hold up to the price
   * of `targetUnits` (rounded up). A short balance holds what it can; only a
   * meter left with no hold at all is refused.
   */
  async topUp(tx: Prisma.TransactionClient, input: MeterRef & { targetUnits: bigint }): Promise<ToppedUp> {
    if (input.targetUnits <= ZERO) throw new UsageSettlementRefused('target_not_positive', input.targetUnits.toString());
    const ctx = await this.load(tx, input, RateCardMode.postpaid);
    if (ctx.grant.status !== GrantStatus.active) throw new UsageSettlementRefused('grant_not_active', ctx.grant.status);
    return this.topUpTo(tx, ctx, ceilDiv(input.targetUnits * priceUnits(ctx.meter), ctx.meter.unitSize * CENT));
  }

  /** Postpaid: `consumed − billed` captured from the hold (`usage_charge`), rounded down, never past the hold. */
  async capture(tx: Prisma.TransactionClient, input: MeterRef): Promise<Captured> {
    return this.captureIn(tx, await this.load(tx, input, RateCardMode.postpaid));
  }

  /**
   * Every non-VPN meter of a Grant that is closing, in the closing `tx`:
   * prepaid gives back what was bought and not used (`usage_refund`, rounded
   * down); postpaid captures, then releases the rest of its hold. `billed`
   * lands where the money left it, so a second close moves nothing.
   */
  async settleAtClose(tx: Prisma.TransactionClient, input: { grantId: string }): Promise<void> {
    // A `stop` card sold nothing past its included part, so it has nothing to settle.
    const meters = await tx.grantMeter.findMany({
      where: { grantId: input.grantId, meterKey: { not: METER_KEYS.vpnTraffic }, afterIncluded: RateCardAfterIncluded.metered },
    });
    for (const m of meters) {
      const ctx = await this.load(tx, { grantId: input.grantId, meterKey: m.meterKey }, m.mode);
      if (ctx.meter.mode === RateCardMode.prepaid) await this.refunds.creditRemainder(tx, ctx);
      else await this.closeHold(tx, ctx);
    }
  }

  /**
   * The hourly capture (billing open-questions 2026-09-29): every active
   * postpaid meter with usage past its cursor is captured, and its hold put
   * back to what it was, so it stays funded to the same target. Cross-tenant
   * scan, per-tenant write, one transaction per meter.
   */
  async captureDue(): Promise<CaptureDueResult> {
    const rows = await this.crossTenant.grantMeter.findMany({
      where: {
        mode: RateCardMode.postpaid,
        afterIncluded: RateCardAfterIncluded.metered,
        meterKey: { not: METER_KEYS.vpnTraffic },
        grant: { status: GrantStatus.active },
      },
      select: { id: true, tenantId: true, grantId: true, meterKey: true, consumed: true, billed: true, includedQuantity: true },
      orderBy: { updatedAt: 'asc' },
      take: CAPTURE_BATCH,
    });
    const due = rows.filter((r) => r.consumed > max(r.billed, r.includedQuantity));
    let captured = 0;
    let errors = 0;
    for (const r of due) {
      try {
        const out = await runWithTenant({ id: r.tenantId }, () =>
          tenantTransaction(this.prisma, async (tx) => {
            const ctx = await this.load(tx, r, RateCardMode.postpaid);
            const before = await this.heldCents(tx, ctx);
            return this.topUpTo(tx, ctx, before);
          }),
        );
        if (out.captured.gt(0)) captured += 1;
      } catch (e) {
        // A lost race is the next hour's; anything else is counted and told.
        if (!(e instanceof WalletVersionConflict) && !(e instanceof UsageSettlementRefused && e.reason === 'cursor_moved')) {
          errors += 1;
          this.logger.error(`capture of grant_meter ${r.id} failed: ${(e as Error).message}`);
        }
      }
    }
    return { scanned: due.length, captured, errors };
  }

  private async topUpTo(tx: Prisma.TransactionClient, ctx: Ctx, targetCents: bigint): Promise<ToppedUp> {
    const captured = await this.captureIn(tx, ctx);
    const heldBefore = await this.heldCents(tx, ctx);
    const add = min(targetCents - heldBefore, toCents(await this.freeBalance(tx, ctx.grant.userId)));
    if (add >= BigInt(1)) {
      await this.holds.hold(tx, { userId: ctx.grant.userId, ownerRef: ctx.meter.id, amount: toAmount(add), currencyCode: ctx.meter.currencyCode });
    } else if (heldBefore < BigInt(1) && targetCents > ZERO) {
      throw new UsageSettlementRefused('insufficient_funds');
    }
    const held = heldBefore + max(add, ZERO);
    const billed = captured.billed;
    const funded = max(billed, ctx.meter.includedQuantity) + unitsCovered(ctx.meter, held);
    await moveCursors(tx, ctx.meter, { funded });
    return { captured: captured.amount, held: toAmount(held), funded };
  }

  private async captureIn(tx: Prisma.TransactionClient, ctx: Ctx): Promise<Captured> {
    const { meter, grant } = ctx;
    const { cents, billedTo } = capturable(meter, meter.billed, meter.consumed, await this.heldCents(tx, ctx));
    if (cents === ZERO) return { amount: new Prisma.Decimal(0), billed: meter.billed, walletTransactionId: null };

    await moveCursors(tx, meter, { billed: billedTo });
    ctx.meter = { ...meter, billed: billedTo };
    const amount = toAmount(cents);
    const row = await this.holds.capture(tx, {
      userId: grant.userId,
      ownerRef: meter.id,
      amount,
      currencyCode: meter.currencyCode,
      reasonType: WalletReasonType.usage_charge,
      referenceId: grant.id,
    });
    return { amount, billed: billedTo, walletTransactionId: row.id };
  }

  private async closeHold(tx: Prisma.TransactionClient, ctx: Ctx): Promise<void> {
    const { billed } = await this.captureIn(tx, ctx);
    if (await this.openHold(tx, ctx)) await this.holds.release(tx, { userId: ctx.grant.userId, ownerRef: ctx.meter.id });
    // Nothing more is served: funded comes down to what was paid for.
    if (ctx.meter.funded !== billed) await moveCursors(tx, ctx.meter, { funded: billed });
  }

  private async load(tx: Prisma.TransactionClient, ref: MeterRef, mode?: RateCardMode): Promise<Ctx> {
    if (ref.meterKey === METER_KEYS.vpnTraffic) throw new UsageSettlementRefused('meter_on_its_own_path');
    const grant = await tx.grant.findUnique({ where: { id: ref.grantId }, select: { id: true, userId: true, status: true } });
    if (!grant) throw new UsageSettlementRefused('grant_not_found', ref.grantId);
    const meter = await tx.grantMeter.findUnique({ where: { grantId_meterKey: { grantId: ref.grantId, meterKey: ref.meterKey } } });
    if (!meter) throw new UsageSettlementRefused('meter_not_on_grant', ref.meterKey);
    if (mode && meter.mode !== mode) throw new UsageSettlementRefused('wrong_mode', `${ref.meterKey} is ${meter.mode}`);
    if (mode && meter.afterIncluded === RateCardAfterIncluded.stop) throw new UsageSettlementRefused('not_metered_past_included', ref.meterKey);
    return { grant, meter };
  }

  private async freeBalance(tx: Prisma.TransactionClient, userId: string): Promise<Prisma.Decimal> {
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: userId } });
    return wallet ? wallet.cachedBalance.minus(wallet.heldAmount) : new Prisma.Decimal(0);
  }

  private async openHold(tx: Prisma.TransactionClient, { grant, meter }: Ctx) {
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
    return wallet ? tx.walletHold.findFirst({ where: { walletId: wallet.id, ownerRef: meter.id, status: WalletHoldStatus.open } }) : null;
  }

  private async heldCents(tx: Prisma.TransactionClient, ctx: Ctx): Promise<bigint> {
    const hold = await this.openHold(tx, ctx);
    return hold ? toCents(hold.amount) : ZERO;
  }
}
