import { Injectable } from '@nestjs/common';
import { Grant, GrantStatus, Prisma, VariantBillingMode, WalletReasonType } from '@prisma/client';
import { METERED_RATE_UNIT_BYTES, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';

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
 * Nothing here reads the catalog: the rate is `grant.meteredRate`, locked at
 * issue (F-027-p), so yesterday's traffic prices at yesterday's rate.
 */

/** Bytes per unit of `grant.meteredRate` — 2^30, spelled once (ADR-0073). */
export const GIB = BigInt(METERED_RATE_UNIT_BYTES);

/** `grant.meteredRate` is `Decimal(18, 8)`; a rate finer than that did not come from the column. */
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
 * `grant.meteredRate` as an integer number of `1e-8` dollars per 2^30 bytes —
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
  /** The cursors as they stand after this purchase. */
  purchasedBytes: bigint;
  billedBytes: bigint;
};

@Injectable()
export class BlockPurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: WalletLedgerService,
  ) {}

  /** One purchase in a transaction of its own, for a caller with no other work to commit with it. */
  purchaseForGrant(input: PurchaseBlock): Promise<PurchasedBlock> {
    return tenantTransaction(this.prisma, (tx) => this.purchase(tx, input));
  }

  /**
   * Buys the next block for a Grant and advances `purchasedBytes` and
   * `billedBytes` by it, in the caller's transaction.
   *
   * The two cursors move together and by the same figure — they are one number
   * until a Grant closes (F-027-r credits the remainder back) or a hold is
   * written off (ADR-0074). They are separate columns so that those later
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
    if (grant.billingMode !== VariantBillingMode.metered || grant.meteredRate === null) {
      throw new BlockPurchaseRefused('grant_not_metered', input.grantId);
    }

    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
    const block = sizeBlock({
      rate: grant.meteredRate,
      targetBytes: input.targetBytes,
      maxSpend: wallet?.cachedBalance ?? new Prisma.Decimal(0),
    });

    const movement = await this.ledger.debit(tx, {
      userId: grant.userId,
      amount: block.amount,
      reasonType: WalletReasonType.traffic_consumption,
      referenceId: grant.id,
    });

    // `increment`, not a computed value: the cursors are advanced by the
    // database from whatever they hold, so nothing here can write back a
    // figure it read before the debit.
    const advanced: Grant = await tx.grant.update({
      where: { id: grant.id },
      data: { purchasedBytes: { increment: block.bytes }, billedBytes: { increment: block.bytes } },
    });

    return {
      ...block,
      grantId: grant.id,
      walletTransactionId: movement.id,
      purchasedBytes: advanced.purchasedBytes,
      billedBytes: advanced.billedBytes,
    };
  }
}
