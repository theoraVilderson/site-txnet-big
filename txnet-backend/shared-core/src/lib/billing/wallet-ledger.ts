import { Injectable } from '@nestjs/common';
import {
  LedgerDirection,
  Prisma,
  WalletReasonType,
  WalletTransaction,
  WalletTransactionNote,
} from '@prisma/client';

import { OutboxEventType } from '../automation/routing-keys';
import { convertedByChanges } from './currency-change';

/**
 * The one place a wallet balance changes (F-092-b, billing invariants 1-4, C-02).
 *
 * Each call conditionally bumps `wallet.cachedBalance` under its `version` and
 * appends the `wallet_transaction` row that proves it, carrying `balanceAfter`.
 * It takes the caller's `tx` rather than opening a transaction of its own, so a
 * payment callback or a coupon redemption credits in the same transaction that
 * flips its own status (F-092-j, F-092-m) — the balance and the reason it moved
 * commit or roll back together.
 *
 * `tx` must come from `tenantTransaction(prisma, fn)`: `walletTransaction` is a
 * registered model, so the extension stamps the row's `tenantId` there and
 * refuses the write in a transaction opened any other way
 * (`tenant-context/contract.md` rule 5). The one exception is a transaction on
 * a cross-tenant pool, which carries no extension: its caller names the
 * wallet owner's tenant in `entry.tenantId` (F-019-h).
 *
 * It lives in `shared-core` because it has more than one service writing it:
 * `billing-service` (deposits, gifts) and `tenant-service`'s reseller purchase,
 * which debits the buyer in the transaction that creates the reseller
 * (ADR-0061).
 *
 * **Every movement is announced** (F-111-m): `billing.wallet.changed` goes
 * into the outbox in the same `tx`, so the owner's open panel re-reads the
 * balance the moment it commits, and a rolled-back movement announces nothing
 * (ADR-0021). Here and not at each caller, so a new writer cannot forget it.
 *
 * **Held money is not spendable** (F-118-a, ADR-0105 (6)): a debit is bounded
 * by `cachedBalance - heldAmount`, not the balance, so every existing debit
 * refuses what a hold locked without knowing holds exist. Postgres holds the
 * same line as a CHECK. Holds themselves are `WalletHoldService`'s
 * (`wallet-hold.ts`); a capture is the one debit that also lowers `heldAmount`.
 *
 * A lost version race is refused, not retried. The caller owns the transaction,
 * and a retry inside it would re-read a row this transaction has already seen
 * change — only restarting the whole transaction reads it fresh.
 */
export type LedgerEntry = {
  /** The wallet owner. Must come from a tenant-scoped source — the gate's `X-User-Id`, or a scoped row. */
  userId: string;
  /** Strictly positive, at most the column's 2 decimal places. */
  amount: Prisma.Decimal;
  /**
   * The currency `amount` is in (F-116-b), taken from the row that priced it —
   * the payment's, the invoice's, the coupon's. It must be the wallet's; a
   * wallet with none yet opens in it. A **credit** priced before the tenant's
   * currency changed (F-116-f) is converted at that change's rate, and the row
   * records what it was; a debit in another currency is always refused.
   */
  currencyCode: string;
  reasonType: WalletReasonType;
  /** The row that caused this movement — a payment, a redemption, a transfer. */
  referenceId?: string;
  /** A postpaid capture's usage (F-118-am): the meter and the units it paid for. */
  usage?: { meterKey: string; quantity: bigint };
  /** A fact about the row beyond `reasonType` (F-118-am). */
  note?: WalletTransactionNote;
  /**
   * The wallet owner's tenant, for a `tx` the tenant extension does not stamp
   * (a cross-tenant pool). Inside `tenantTransaction` leave it out: the
   * extension stamps it, and refuses a different one.
   */
  tenantId?: string;
};

/**
 * A movement in another currency than the wallet's (ADR-0098 part 3), and not
 * a credit a recorded currency change converts (F-116-f). Refused before
 * anything is written; `wallet_transaction`'s trigger refuses the same row for
 * a writer that is not this class.
 */
export class LedgerCurrencyMismatch extends Error {
  constructor(readonly userId: string, readonly walletCurrency: string, readonly entryCurrency: string) {
    super(`wallet of user ${userId} is kept in ${walletCurrency}; refused a movement in ${entryCurrency}`);
    this.name = 'LedgerCurrencyMismatch';
  }
}

/** `wallet_transaction.amount` / `balanceAfter` are `Decimal(18, 2)`. */
const LEDGER_SCALE = 2;

/** Of two writers that read the same `version`, this is the one that lost. */
export class WalletVersionConflict extends Error {
  constructor(readonly userId: string) {
    super(`wallet of user ${userId} changed under this transaction; restart it`);
    this.name = 'WalletVersionConflict';
  }
}

/**
 * A debit larger than the balance not already held, or a hold larger than what
 * is left to hold. A user with no wallet has a balance of zero.
 */
export class InsufficientFunds extends Error {
  constructor(readonly userId: string) {
    super(`wallet of user ${userId} cannot cover the debit`);
    this.name = 'InsufficientFunds';
  }
}

/**
 * Zero, negative, or finer than the column. The last is refused rather than
 * rounded: Postgres would round the stored amount while `balanceAfter` was
 * computed from the unrounded one, and the two would disagree by a fraction
 * forever.
 */
export class InvalidLedgerAmount extends Error {
  constructor(amount: Prisma.Decimal) {
    super(
      `ledger amount must be > 0 with at most ${LEDGER_SCALE} decimal places, got ${amount.toString()}`,
    );
    this.name = 'InvalidLedgerAmount';
  }
}

/** Throws {@link InvalidLedgerAmount} unless `amount` fits the ledger's column. */
export function assertLedgerAmount(amount: Prisma.Decimal): void {
  if (amount.lte(0) || amount.decimalPlaces() > LEDGER_SCALE) throw new InvalidLedgerAmount(amount);
}

@Injectable()
export class WalletLedgerService {
  credit(tx: Prisma.TransactionClient, entry: LedgerEntry): Promise<WalletTransaction> {
    return this.move(tx, entry, LedgerDirection.credit);
  }

  debit(tx: Prisma.TransactionClient, entry: LedgerEntry): Promise<WalletTransaction> {
    return this.move(tx, entry, LedgerDirection.debit);
  }

  /**
   * A capture's debit (F-118-a): the ledger row, and the same amount off
   * `heldAmount`, under one `version`. Only `WalletHoldService.capture` calls
   * it, after taking the amount off its hold row in the same `tx` — the
   * deferred trigger refuses the commit if the two disagree.
   */
  debitHeld(tx: Prisma.TransactionClient, entry: LedgerEntry): Promise<WalletTransaction> {
    return this.move(tx, entry, LedgerDirection.debit, entry.amount);
  }

  private async move(
    tx: Prisma.TransactionClient,
    entry: LedgerEntry,
    direction: LedgerDirection,
    releasing: Prisma.Decimal = new Prisma.Decimal(0),
  ): Promise<WalletTransaction> {
    const { userId } = entry;
    assertLedgerAmount(entry.amount);

    let wallet = await tx.wallet.findUnique({ where: { ownerUserId: userId } });
    if (!wallet) {
      if (direction === LedgerDirection.debit) throw new InsufficientFunds(userId);
      // A wallet opens on its first credit. `skipDuplicates` is `ON CONFLICT DO
      // NOTHING`, so two first credits racing both proceed to the read below
      // and meet again at the version guard, instead of one failing on the
      // unique `ownerUserId`.
      // It opens in the currency of that credit (F-116-b).
      await tx.wallet.createMany({ data: [{ ownerUserId: userId, currencyCode: entry.currencyCode }], skipDuplicates: true });
      wallet = await tx.wallet.findUniqueOrThrow({ where: { ownerUserId: userId } });
    }
    let amount = entry.amount;
    let source: { sourceAmount: Prisma.Decimal; sourceCurrencyCode: string } | null = null;
    if (wallet.currencyCode !== entry.currencyCode) {
      const converted =
        direction === LedgerDirection.credit
          ? await convertedByChanges(tx, await tenantOf(tx, entry), entry.amount, entry.currencyCode, wallet.currencyCode)
          : null;
      if (!converted || converted.lte(0)) throw new LedgerCurrencyMismatch(userId, wallet.currencyCode, entry.currencyCode);
      amount = converted;
      source = { sourceAmount: entry.amount, sourceCurrencyCode: entry.currencyCode };
    }

    const balanceAfter =
      direction === LedgerDirection.credit
        ? wallet.cachedBalance.plus(amount)
        : wallet.cachedBalance.minus(amount);
    // What is held stays held: the free balance, not the balance, bounds a debit.
    const heldAfter = wallet.heldAmount.minus(releasing);
    if (balanceAfter.lt(heldAfter)) throw new InsufficientFunds(userId);

    // The cache first, under the version it was read at: a writer that lost the
    // race appends nothing even if its caller swallows the error. Postgres
    // re-checks this `where` after waiting on the winner's row lock, so under
    // READ COMMITTED the loser sees `count: 0`, never a stale match.
    const { count } = await tx.wallet.updateMany({
      where: { id: wallet.id, version: wallet.version },
      data: {
        cachedBalance: balanceAfter,
        ...(releasing.isZero() ? {} : { heldAmount: heldAfter }),
        version: { increment: 1 },
      },
    });
    if (count !== 1) throw new WalletVersionConflict(userId);

    const movement = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount,
        direction,
        reasonType: entry.reasonType,
        referenceId: entry.referenceId,
        ...(entry.usage ? { meterKey: entry.usage.meterKey, usageQuantity: entry.usage.quantity } : {}),
        ...(entry.note ? { note: entry.note } : {}),
        currencyCode: wallet.currencyCode,
        ...(source ?? {}),
        ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
        balanceAfter,
      },
    });
    // The payload names whose wallet and nothing it holds: the panel re-reads
    // the balance, so two events arriving out of order cannot show an old one.
    // The tenant is the one the row was stamped with.
    await tx.outboxEvent.create({
      data: {
        aggregate: 'billing.wallet',
        aggregateId: wallet.id,
        type: OutboxEventType.WALLET_CHANGED,
        payload: { tenantId: movement.tenantId ?? entry.tenantId ?? null, userId, walletTransactionId: movement.id },
      },
    });
    return movement;
  }
}

/** The wallet owner's tenant: the one named, or the user's own row. */
async function tenantOf(tx: Prisma.TransactionClient, entry: LedgerEntry): Promise<string> {
  if (entry.tenantId) return entry.tenantId;
  const user = await tx.user.findUniqueOrThrow({ where: { id: entry.userId }, select: { tenantId: true } });
  return user.tenantId;
}
