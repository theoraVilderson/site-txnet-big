import { Injectable } from '@nestjs/common';
import {
  LedgerDirection,
  Prisma,
  WalletReasonType,
  WalletTransaction,
} from '@prisma/client';

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
 * A lost version race is refused, not retried. The caller owns the transaction,
 * and a retry inside it would re-read a row this transaction has already seen
 * change — only restarting the whole transaction reads it fresh.
 */
export type LedgerEntry = {
  /** The wallet owner. Must come from a tenant-scoped source — the gate's `X-User-Id`, or a scoped row. */
  userId: string;
  /** Base currency (ADR-0019), strictly positive, at most the column's 2 decimal places. */
  amount: Prisma.Decimal;
  reasonType: WalletReasonType;
  /** The row that caused this movement — a payment, a redemption, a transfer. */
  referenceId?: string;
  /**
   * The wallet owner's tenant, for a `tx` the tenant extension does not stamp
   * (a cross-tenant pool). Inside `tenantTransaction` leave it out: the
   * extension stamps it, and refuses a different one.
   */
  tenantId?: string;
};

/** `wallet_transaction.amount` / `balanceAfter` are `Decimal(18, 2)`. */
const LEDGER_SCALE = 2;

/** Of two writers that read the same `version`, this is the one that lost. */
export class WalletVersionConflict extends Error {
  constructor(readonly userId: string) {
    super(`wallet of user ${userId} changed under this transaction; restart it`);
    this.name = 'WalletVersionConflict';
  }
}

/** A debit larger than the balance. A user with no wallet has a balance of zero. */
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

@Injectable()
export class WalletLedgerService {
  credit(tx: Prisma.TransactionClient, entry: LedgerEntry): Promise<WalletTransaction> {
    return this.move(tx, entry, LedgerDirection.credit);
  }

  debit(tx: Prisma.TransactionClient, entry: LedgerEntry): Promise<WalletTransaction> {
    return this.move(tx, entry, LedgerDirection.debit);
  }

  private async move(
    tx: Prisma.TransactionClient,
    entry: LedgerEntry,
    direction: LedgerDirection,
  ): Promise<WalletTransaction> {
    const { userId, amount } = entry;
    if (amount.lte(0) || amount.decimalPlaces() > LEDGER_SCALE) {
      throw new InvalidLedgerAmount(amount);
    }

    let wallet = await tx.wallet.findUnique({ where: { ownerUserId: userId } });
    if (!wallet) {
      if (direction === LedgerDirection.debit) throw new InsufficientFunds(userId);
      // A wallet opens on its first credit. `skipDuplicates` is `ON CONFLICT DO
      // NOTHING`, so two first credits racing both proceed to the read below
      // and meet again at the version guard, instead of one failing on the
      // unique `ownerUserId`.
      await tx.wallet.createMany({ data: [{ ownerUserId: userId }], skipDuplicates: true });
      wallet = await tx.wallet.findUniqueOrThrow({ where: { ownerUserId: userId } });
    }

    const balanceAfter =
      direction === LedgerDirection.credit
        ? wallet.cachedBalance.plus(amount)
        : wallet.cachedBalance.minus(amount);
    if (balanceAfter.isNegative()) throw new InsufficientFunds(userId);

    // The cache first, under the version it was read at: a writer that lost the
    // race appends nothing even if its caller swallows the error. Postgres
    // re-checks this `where` after waiting on the winner's row lock, so under
    // READ COMMITTED the loser sees `count: 0`, never a stale match.
    const { count } = await tx.wallet.updateMany({
      where: { id: wallet.id, version: wallet.version },
      data: { cachedBalance: balanceAfter, version: { increment: 1 } },
    });
    if (count !== 1) throw new WalletVersionConflict(userId);

    return tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount,
        direction,
        reasonType: entry.reasonType,
        referenceId: entry.referenceId,
        ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
        balanceAfter,
      },
    });
  }
}
