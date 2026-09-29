import { Injectable } from '@nestjs/common';
import { GrantMeter, GrantStatus, Prisma, VariantBillingMode, WalletReasonType } from '@prisma/client';
import { TenantBillingLedger, tenantTransaction } from '@txnet-backend/shared-core';

import { PackageWholesale } from '../entitlement/package-wholesale';
import { PrismaService } from '../prisma/prisma.service';
import { WalletCreditService } from '../wallet/wallet-credit.service';
import { GIB, rateUnitsOf } from './block-purchase';
import { creditPrepaidRemainder } from './prepaid-remainder';
import { vpnMeterOf } from './vpn-meter';
import { releaseVpnReserve } from './vpn-reserve';
import { VpnWholesale } from './vpn-wholesale';

/**
 * The remainder credit (F-027-r; ADR-0072 rule 3).
 *
 * The other half of charging before serving. `BlockPurchaseService` takes money
 * out of the wallet for bytes the user has not consumed yet — that is the
 * accepted cost of ADR-0072 — and this gives back the ones a Grant closed
 * without ever serving. A close that skipped it would turn a reservation into a
 * charge, quietly, for every metered Grant that ever expires.
 *
 * It runs inside the **caller's** transaction, as the purchase does, so the
 * credit commits with the status move that closed the Grant and there is no
 * window where one landed and the other did not.
 *
 * Nothing here reads the catalog either: the refund prices on the Grant's
 * `vpn.traffic` meter (F-118-l), the same rate the blocks were bought at
 * (ADR-0073), so a rate raised after the sale never refunds more than was taken.
 */

/** `wallet_transaction.amount` is `Decimal(18, 2)`: whole cents, never rounded (C-02). */
const CENTS = BigInt(100);
const RATE_UNIT = BigInt(100_000_000);

/** Why nothing was credited back. Nothing was written. */
export type RemainderCreditRejection =
  | 'grant_not_found'
  /** Still `active`, `pending` or `suspended`: money a live Grant will spend again within minutes. */
  | 'grant_not_closed'
  /** Prepaid, or metered with no locked rate — nothing here would price a byte. */
  | 'grant_not_metered'
  /** Same rule as the purchase: a zero rate, or one finer than `Decimal(18, 8)`. */
  | 'rate_not_priceable'
  /** Everything bought was served, or what is left is worth under a cent. Already settled. */
  | 'nothing_to_credit'
  /** The money cursor moved between the read and the write; the refund was not taken twice. */
  | 'cursor_moved'
  /** Prepaid (F-311-m): the metered path's opposite — a metered Grant settles by its money cursor. */
  | 'grant_not_prepaid'
  /** Prepaid: not bought with money — an admin's, a trial's, a coupon's Grant, or a free invoice. */
  | 'nothing_paid'
  /** Prepaid: unlimited **and** permanent — neither volume nor time says how much is left. */
  | 'not_measurable';

export class RemainderCreditRefused extends Error {
  constructor(
    readonly reason: RemainderCreditRejection,
    detail = '',
  ) {
    super(`remainder credit refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'RemainderCreditRefused';
  }
}

/**
 * Which statuses are a close, in an exhaustive table so a new `GrantStatus`
 * does not compile until somebody says whether it settles the money (C-09's
 * habit). `exhausted` is here too: it has nothing left to give back in the
 * normal case, and asking is cheaper than a status that silently keeps money.
 */
const IS_CLOSED: Record<GrantStatus, boolean> = {
  [GrantStatus.pending]: false,
  [GrantStatus.active]: false,
  // Revived by F-027-x/y; its ceiling is still standing and its bytes are still its own.
  [GrantStatus.suspended]: false,
  [GrantStatus.exhausted]: true,
  [GrantStatus.expired]: true,
  [GrantStatus.cancelled]: true,
};

export type RemainderSizing = {
  /** Whole cents, as the ledger takes it: `Decimal` with exactly two places. */
  amount: Prisma.Decimal;
  /** The bytes those cents paid for, rounded **down** — what comes off the money cursor. */
  bytes: bigint;
};

/**
 * Prices the unconsumed remainder, rounding the price **down** to a whole cent.
 *
 * The exact mirror of `sizeBlock`, which rounds a purchase **up**: both round
 * in the platform's favour by less than a cent, so a Grant is never refunded
 * more than its blocks cost. What is left under a cent stays taken — it is the
 * same dust `sizeBlock` charged for, and it is what makes a second call a
 * no-op rather than a second row.
 *
 * Integer `bigint` throughout, for the reason `sizeBlock` gives: a `Decimal.div`
 * rounds at its own precision, and a cent refunded that was never charged is as
 * wrong as a byte served that was never bought.
 */
export function sizeRemainder(input: { rate: Prisma.Decimal; remainderBytes: bigint }): RemainderSizing {
  const { rate, remainderBytes } = input;
  const rateUnits = rateUnitsOf(rate);
  if (remainderBytes <= BigInt(0)) throw new RemainderCreditRefused('nothing_to_credit', remainderBytes.toString());

  // floor(rate x remainder x 100 / (1e8 x 2^30)) — what the remainder is worth, in cents.
  const cents = (rateUnits * remainderBytes * CENTS) / (RATE_UNIT * GIB);
  if (cents < BigInt(1)) throw new RemainderCreditRefused('nothing_to_credit', remainderBytes.toString());

  // floor(cents x 1e8 x 2^30 / (100 x rate)) — the bytes those cents paid for.
  const bytes = (cents * RATE_UNIT * GIB) / (CENTS * rateUnits);
  return { amount: new Prisma.Decimal(cents.toString()).div(CENTS.toString()), bytes };
}

export type CreditRemainder = { grantId: string };

export type CreditedRemainder = RemainderSizing & {
  grantId: string;
  /** The ledger row that gave it back; `wallet_transaction.referenceId` is the Grant. */
  walletTransactionId: string;
  /** The meter's money cursor, `billed`, as it stands after the credit. */
  billed: bigint;
};

@Injectable()
export class RemainderCreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: WalletCreditService,
  ) {}

  /** Its ledger holds no state, so it needs no injection. */
  private readonly wholesale = new VpnWholesale(new TenantBillingLedger());
  private readonly packageWholesale = new PackageWholesale();

  /** One credit in a transaction of its own, for a caller with no other work to commit with it. */
  creditForGrant(input: CreditRemainder): Promise<CreditedRemainder> {
    return tenantTransaction(this.prisma, (tx) => this.credit(tx, input));
  }

  /**
   * Either Grant's remainder, for a close that does not know its billing mode
   * (F-311-m, an admin's delete): a metered bag by its money cursor, below; a
   * prepaid one by the larger share of volume or time used (`prepaid-remainder.ts`).
   * `stoppedAt` is when a frozen Grant's clock stopped, null otherwise.
   */
  async settle(tx: Prisma.TransactionClient, input: { grantId: string; at: Date; stoppedAt: Date | null }): Promise<{ amount: Prisma.Decimal; walletTransactionId: string }> {
    const grant = await tx.grant.findUnique({ where: { id: input.grantId }, select: { billingMode: true } });
    if (!grant) throw new RemainderCreditRefused('grant_not_found', input.grantId);
    if (grant.billingMode === VariantBillingMode.prepaid) return creditPrepaidRemainder(tx, this.ledger, input);
    const back = await this.credit(tx, { grantId: input.grantId });
    return { amount: back.amount, walletTransactionId: back.walletTransactionId };
  }

  /**
   * The reseller's side of a close (F-118-n3, F-118-p): wholesale bytes bought
   * and never served on a platform panel — a metered Grant's blocks, or a
   * package plan's bag — back on its billing wallet. Owed to the reseller
   * whatever the admin answered about the user's own remainder. A Grant has
   * at most one of the two legs; the other gives nothing.
   */
  async wholesaleBack(tx: Prisma.TransactionClient, grantId: string): Promise<void> {
    await this.wholesale.giveBack(tx, grantId);
    await this.packageWholesale.giveBack(tx, grantId);
  }

  /**
   * Gives back what a closed Grant bought and never served, in the caller's
   * transaction.
   *
   * **The money cursor is the record of the refund, and its guard.** The
   * remainder is the meter's `billed` less `grant.consumedBytes`, and `billed` comes down by
   * exactly the bytes the refunded cents paid for — so a second call over the
   * same Grant computes a remainder of dust and refuses `nothing_to_credit`.
   * That is the whole idempotency of this path: a retried sweeper, or a cancel
   * racing an expiry, cannot pay the same remainder twice, and no column was
   * added to say so. `purchasedBytes` never moves: it is what was bought, it
   * bounds the ceilings that were written against it (F-027-s), and rewriting
   * history to record a refund would lose both facts.
   *
   * A Grant the panels reported **past** its ceiling (ADR-0074) has a negative
   * remainder and is refused, not refunded into the red: that gap is a debt the
   * holds queue settles, and it is not this code's to net off.
   *
   * The cursor is claimed before the credit is written and under a guard on the
   * value that was read, so a block bought between the two loses here with
   * nothing written — the same shape as the ledger's own version guard.
   */
  async credit(tx: Prisma.TransactionClient, input: CreditRemainder): Promise<CreditedRemainder> {
    const grant = await tx.grant.findUnique({ where: { id: input.grantId } });
    if (!grant) throw new RemainderCreditRefused('grant_not_found', input.grantId);
    if (!IS_CLOSED[grant.status]) throw new RemainderCreditRefused('grant_not_closed', `${input.grantId} is ${grant.status}`);
    if (grant.billingMode !== VariantBillingMode.metered || !(await vpnMeterOf(tx, grant.id))) {
      throw new RemainderCreditRefused('grant_not_metered', input.grantId);
    }

    // A closed Grant is not planned: its reserve is free again, whatever the remainder (F-118-b).
    await releaseVpnReserve(tx, grant);
    // Read after it: a postpaid meter's close captures, and moves `billed` (F-118-k).
    const meter = (await vpnMeterOf(tx, grant.id)) as GrantMeter;
    const back = sizeRemainder({ rate: meter.unitPrice, remainderBytes: meter.billed - grant.consumedBytes });

    const claimed = await tx.grantMeter.updateMany({
      where: { id: meter.id, billed: meter.billed },
      data: { billed: { decrement: back.bytes } },
    });
    if (claimed.count === 0) throw new RemainderCreditRefused('cursor_moved', input.grantId);

    const movement = await this.ledger.credit(tx, {
      userId: grant.userId,
      amount: back.amount,
      // The rate's own, locked on the meter with it at issue (F-116-d).
      currencyCode: meter.currencyCode,
      reasonType: WalletReasonType.traffic_refund,
      referenceId: grant.id,
    });

    return {
      ...back,
      grantId: grant.id,
      walletTransactionId: movement.id,
      billed: meter.billed - back.bytes,
    };
  }
}
