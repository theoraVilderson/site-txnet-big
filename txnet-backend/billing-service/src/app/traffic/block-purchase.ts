import { Injectable } from '@nestjs/common';
import { Grant, GrantStatus, Prisma, RateCardMode, VariantBillingMode, WalletReasonType } from '@prisma/client';
import { METERED_RATE_UNIT_BYTES, TenantBillingLedger, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { spendOnCap, withinCap } from '../usage/cap-funding';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { releaseAboveShare, reserveShareOf } from './reserve-share';
import { vpnMeterOf } from './vpn-meter';
import { NO_VPN_RESERVE, VpnReserve } from './vpn-reserve';
import { VpnWholesale } from './vpn-wholesale';

/**
 * The block purchaser (F-027-q; ADR-0072, ADR-0073).
 *
 * **No byte is served that has not been paid for.** Before a metered config
 * carries traffic, a block of bytes is bought here at a whole-cent price, and
 * the ceiling written to the panel is bounded by what this has advanced
 * (`Σ ceilings ≤ purchasedBytes`, F-027-s). The wallet debit and the two
 * cursors move in **one** transaction, so a block that was billed and not
 * granted — or granted and not billed — is not a state this code can reach.
 *
 * It runs inside the caller's `tx`, as `GrantService` does, so a purchase made
 * while allocating a ceiling commits with that allocation.
 * `purchaseForGrant` is for a caller with nothing else to commit; either way
 * the transaction must come from `tenantTransaction`, because
 * `WalletLedgerService` writes a registered model.
 *
 * Nothing here reads the catalog: the rate is the Grant's `vpn.traffic`
 * meter's (`vpn-meter.ts`, F-118-l), locked at issue (ADR-0073), so
 * yesterday's traffic prices at yesterday's rate.
 */

/** Bytes per unit of a `vpn.traffic` rate — 2^30, spelled once (ADR-0073). */
export const GIB = BigInt(METERED_RATE_UNIT_BYTES);

/** `grant_meter.unitPrice` is `Decimal(18, 8)`; a rate finer than that did not come from the column. */
const RATE_SCALE = 8;
const RATE_UNIT = BigInt(100_000_000);
/** `wallet_transaction.amount` is `Decimal(18, 2)`: whole cents, never rounded (C-02). */
const CENTS = BigInt(100);

/** Why a block was not bought. Nothing was written. */
export type BlockPurchaseRejection =
  | 'grant_not_found'
  /** Only an `active` Grant buys traffic; a suspended one is revived by F-027-x/y first. */
  | 'grant_not_active'
  /** Prepaid, or metered with no locked rate — nothing here would price a byte. */
  | 'grant_not_metered'
  /** A zero rate, or one finer than `Decimal(18, 8)`. A free byte is a catalog decision, not an arithmetic one. */
  | 'rate_not_priceable'
  /** The balance cannot fund a single cent. The ceiling stays where it is and the panel cuts the user off (ADR-0072). */
  | 'insufficient_funds'
  /** The wallet could fund it, the Grant's spending cap cannot (F-118-i). Cut as an empty wallet cuts it. */
  | 'cap_reached'
  /** A postpaid `vpn.traffic` card (F-118-k): held and captured (`vpn-postpaid.ts`), never sold a block. */
  | 'grant_postpaid'
  /** The user could fund it, the reseller's billing wallet cannot fund its wholesale side (F-118-n3). Short of funds, as the others. */
  | 'wholesale_unfunded'
  /** A rate so high that a whole cent buys less than one byte. Never a zero-byte block. */
  | 'block_below_one_byte'
  | 'target_not_positive';

export class BlockPurchaseRefused extends Error {
  constructor(
    readonly reason: BlockPurchaseRejection,
    detail = '',
  ) {
    super(`block purchase refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'BlockPurchaseRefused';
  }
}

/** Integer ceiling division. Both arguments are positive here. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - BigInt(1)) / b;

/**
 * A `vpn.traffic` rate as an integer number of `1e-8` dollars per 2^30 bytes —
 * the form every price here is computed in, so nothing rounds at `Decimal`'s
 * precision on the way. Refuses the rates no arithmetic can price: a zero rate
 * is a catalog decision (F-027-al) and one finer than the column's scale did
 * not come from it.
 *
 * The remainder credit (F-027-r) prices with the same function, so a Grant is
 * refunded on the rate it was charged on and not on a second reading of it.
 */
export function rateUnitsOf(rate: Prisma.Decimal): bigint {
  if (rate.lte(0) || rate.decimalPlaces() > RATE_SCALE) throw new BlockPurchaseRefused('rate_not_priceable', rate.toString());
  return BigInt(rate.mul(RATE_UNIT.toString()).toFixed(0));
}

export type BlockSizing = {
  /** Whole cents, as the ledger takes it: `Decimal` with exactly two places. */
  amount: Prisma.Decimal;
  /** What those cents buy at this rate, rounded **down**. Always > 0. */
  bytes: bigint;
};

/**
 * Sizes one block **from its price, not from its bytes** (ADR-0072).
 *
 * The target headroom is priced, the price is rounded **up** to a whole cent —
 * so nothing sub-cent is ever computed, and catalog §8.5's Redis accumulator
 * has nothing to accumulate — and those cents are converted back to bytes by
 * integer division rounding **down**. The block therefore covers the target and
 * is never larger than what the debited amount buys.
 *
 * `maxSpend` clamps it to what the wallet holds. A balance short of the target
 * buys the largest whole-cent block it can fund rather than nothing: ADR-0072's
 * worst acceptable failure is a user who stalls, and stalling with 99c unspent
 * is that failure arriving early.
 *
 * All of it is integer arithmetic on `bigint`. A `Decimal.div` here would round
 * at its own precision and a floor taken afterwards could be a byte out — which
 * is a byte sold and not paid for, in the one place that must not happen.
 */
export function sizeBlock(input: { rate: Prisma.Decimal; targetBytes: bigint; maxSpend: Prisma.Decimal }): BlockSizing {
  const { rate, targetBytes, maxSpend } = input;
  if (targetBytes <= BigInt(0)) throw new BlockPurchaseRefused('target_not_positive', targetBytes.toString());
  const rateUnits = rateUnitsOf(rate);
  // ceil(rate x target x 100 / (1e8 x 2^30)) — the target's price, in cents.
  const wanted = ceilDiv(rateUnits * targetBytes * CENTS, RATE_UNIT * GIB);
  const affordable = BigInt(maxSpend.mul(CENTS.toString()).floor().toFixed(0));
  const cents = wanted < affordable ? wanted : affordable;
  if (cents < BigInt(1)) throw new BlockPurchaseRefused('insufficient_funds', maxSpend.toString());

  // floor(cents x 1e8 x 2^30 / (100 x rate)) — what those cents actually buy.
  const bytes = (cents * RATE_UNIT * GIB) / (CENTS * rateUnits);
  if (bytes < BigInt(1)) throw new BlockPurchaseRefused('block_below_one_byte', rate.toString());

  return { amount: new Prisma.Decimal(cents.toString()).div(CENTS.toString()), bytes };
}

/**
 * What a balance would buy at this rate, rounded **down** — the headroom side
 * of `sizeBlock`, with nothing debited and nothing refused (F-027-w).
 *
 * It answers a different question from a purchase, so it answers it
 * differently: a rate no arithmetic can price buys **nothing** here rather
 * than throwing. The refusal belongs on the path that moves money
 * (`rate_not_priceable` above); on this one it is a Grant whose ceiling is not
 * extended, and failing the rebalance over it would leave every config on that
 * Grant without a share at all.
 *
 * The same integer arithmetic as `sizeBlock`, for the same reason: a
 * `Decimal.div` rounds at its own precision, and this figure bounds a ceiling
 * that gets written to a panel.
 */
export function bytesAffordable(rate: Prisma.Decimal | null, balance: Prisma.Decimal): bigint {
  if (rate === null || rate.lte(0) || rate.decimalPlaces() > RATE_SCALE || balance.lte(0)) return BigInt(0);
  const cents = BigInt(balance.mul(CENTS.toString()).floor().toFixed(0));
  if (cents < BigInt(1)) return BigInt(0);
  return (cents * RATE_UNIT * GIB) / (CENTS * rateUnitsOf(rate));
}

export type PurchaseBlock = {
  grantId: string;
  /** The headroom the caller wants covered — the hot loop's horizon (F-027-u), in bytes. */
  targetBytes: bigint;
};

export type PurchasedBlock = BlockSizing & {
  grantId: string;
  /** The ledger row that paid for it; `wallet_transaction.referenceId` is the Grant. */
  walletTransactionId: string;
  /** The bag and the meter's money cursor as they stand after this purchase. */
  purchasedBytes: bigint;
  billed: bigint;
  /** The wallet's balance after the debit — what the low-balance notice reads (F-601-g). */
  balanceAfter: Prisma.Decimal;
};

@Injectable()
export class BlockPurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: WalletLedgerService,
    // Defaulted so a spec that builds the purchaser by hand holds no reserve.
    private readonly reserve: VpnReserve = NO_VPN_RESERVE,
  ) {}

  /** The reseller's side of a block (F-118-n3). Its ledger holds no state, so it needs no injection. */
  private readonly wholesale = new VpnWholesale(new TenantBillingLedger());

  /** One purchase in a transaction of its own, for a caller with no other work to commit with it. */
  purchaseForGrant(input: PurchaseBlock): Promise<PurchasedBlock> {
    return tenantTransaction(this.prisma, (tx) => this.purchase(tx, input));
  }

  /**
   * Buys the next block for a Grant and advances the bag, `purchasedBytes`,
   * and its meter's `billed` and `funded` by it, in the caller's transaction.
   *
   * The bag and `billed` move together and by the same figure — they are one
   * number until a Grant closes (F-027-r credits the remainder back) or a hold
   * is written off (ADR-0074). They are separate so that those later
   * movements do not have to move the number a ceiling is written against.
   *
   * The balance is read once to size the block, and the debit re-reads it under
   * its own version guard. A purchase that raced another loses there, with
   * `WalletVersionConflict` and nothing written — never with a block granted
   * from a balance that was already spent.
   */
  async purchase(tx: Prisma.TransactionClient, input: PurchaseBlock): Promise<PurchasedBlock> {
    const grant = await tx.grant.findUnique({ where: { id: input.grantId } });
    if (!grant) throw new BlockPurchaseRefused('grant_not_found', input.grantId);
    if (grant.status !== GrantStatus.active) throw new BlockPurchaseRefused('grant_not_active', `${input.grantId} is ${grant.status}`);
    const meter = grant.billingMode === VariantBillingMode.metered ? await vpnMeterOf(tx, grant.id) : null;
    if (!meter) throw new BlockPurchaseRefused('grant_not_metered', input.grantId);
    if (meter.mode === RateCardMode.postpaid) throw new BlockPurchaseRefused('grant_postpaid', input.grantId);

    let wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
    // The Grant's own reserve (F-118-b) is its money: the bytes it backed are
    // what this block pays for. Another hold is not (F-118-a).
    const reserved = await this.reserve.heldFor(tx, grant);
    // Short of its even share while another Grant's reserve holds more
    // (F-118-ag): that excess is released first — never spent by this block.
    const share = wallet ? await reserveShareOf(tx, grant) : null;
    if (share && (await releaseAboveShare(tx, grant.userId, share)).gt(0)) {
      wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
    }
    const free = wallet ? wallet.cachedBalance.minus(wallet.heldAmount).plus(reserved) : new Prisma.Decimal(0);
    // Its spending cap, if the owner set one (F-118-i): the reserve is inside it.
    const maxSpend = await withinCap(tx, grant, free, reserved);
    if (maxSpend.lt(free) && maxSpend.lt('0.01')) throw new BlockPurchaseRefused('cap_reached', grant.id);
    // The reseller's side bounds it first (F-118-n3): the block is what both wallets fund.
    const wholesale = await this.wholesale.room(tx, grant, meter);
    const room = wholesale?.room ?? null;
    if (room !== null && room < BigInt(1)) throw new BlockPurchaseRefused('wholesale_unfunded', grant.id);
    const targetBytes = room !== null && room < input.targetBytes ? room : input.targetBytes;
    let block = sizeBlock({ rate: meter.unitPrice, targetBytes, maxSpend });
    // A price rounded up can buy past the room; one cent less cannot reach the target.
    if (room !== null && block.bytes > room) {
      const less = block.amount.minus('0.01');
      if (less.lt('0.01')) throw new BlockPurchaseRefused('wholesale_unfunded', grant.id);
      block = sizeBlock({ rate: meter.unitPrice, targetBytes, maxSpend: less });
    }

    // Sized before anything is written, so a refusal leaves the transaction clean.
    if (reserved.gt(0)) await this.reserve.release(tx, grant);
    const movement = await this.ledger.debit(tx, {
      userId: grant.userId,
      amount: block.amount,
      // The rate's own, locked on the meter with it at issue (F-116-d).
      currencyCode: meter.currencyCode,
      reasonType: WalletReasonType.traffic_consumption,
      referenceId: grant.id,
    });
    await spendOnCap(tx, grant.id, block.amount);
    // Read before the bag moves: the owed figure is computed from it.
    if (wholesale) await this.wholesale.buy(tx, grant, meter, wholesale, block.bytes, movement.id);

    // `increment`, not a computed value: the cursors are advanced by the
    // database from whatever they hold, so nothing here can write back a
    // figure it read before the debit.
    const advanced: Grant = await tx.grant.update({ where: { id: grant.id }, data: { purchasedBytes: { increment: block.bytes } } });
    const billed = await tx.grantMeter.update({
      where: { id: meter.id },
      data: { billed: { increment: block.bytes }, funded: { increment: block.bytes } },
    });
    // The reserve back to its target from what the block left.
    await this.reserve.top(tx, grant.id);

    return {
      ...block,
      grantId: grant.id,
      walletTransactionId: movement.id,
      purchasedBytes: advanced.purchasedBytes,
      billed: billed.billed,
      balanceAfter: movement.balanceAfter,
    };
  }
}
