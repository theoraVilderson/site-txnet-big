import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TenantBillingReasonType,
  TenantBillingTransaction,
  TenantLedgerDirection,
} from '@prisma/client';
import { OutboxEventType } from '../../automation/routing-keys';

/**
 * The one place a reseller's billing balance changes (F-019-a, D-41; tenant
 * invariants 3 and 14-15, C-02).
 *
 * The same primitive as billing's `WalletLedgerService`, for the wallet a
 * reseller holds **with the platform** rather than a user's wallet with a
 * reseller (ADR-0006: the two never meet). Each call conditionally bumps
 * `tenant_billing_wallet.cachedBalance` under its `version` and appends the
 * `tenant_billing_transaction` row that proves it, carrying `balanceAfter`.
 *
 * It lives in `shared-core` because it has more than one writer: the platform
 * owner's manual adjustment (`billing-service`, F-019-a), a settled top-up
 * (F-019-b) and a subscription renewal (F-019-c).
 *
 * It takes the caller's `tx` and opens none, so a caller writes its own row —
 * a payment's status, an audit row — in the same transaction. The tables carry
 * no `TENANT_SCOPED_MODELS` entry; the tenant is the mandatory `tenantId`
 * argument, and `tenant_billing_wallet`'s strict RLS policy stands behind it on
 * the app pool.
 *
 * **Prepaid only (D-01).** A debit below zero is refused here and, for any
 * other writer, by the `tenant_billing_wallet_balance_non_negative` CHECK.
 * **One entry per (reason, reference):** checked here so a caller gets a
 * named refusal, and held by the unique index for two writers racing.
 * A lost version race is thrown, not retried: only restarting the caller's
 * whole transaction reads the row fresh.
 *
 * **Every credit announces itself** (F-019-c): a `tenant.billing.credited`
 * outbox row in the same transaction, so a reseller whose renewal is unpaid is
 * charged as soon as money lands — whichever writer credited it, including
 * ones not written yet. The renewal sweep stands behind a lost event.
 */
export type TenantBillingEntry = {
  tenantId: string;
  /** Base currency (ADR-0019), strictly positive, at most the column's 2 decimal places. */
  amount: Prisma.Decimal;
  reasonType: TenantBillingReasonType;
  /** What caused the movement — a payment, a renewal, an admin request. At most one entry per (reasonType, referenceId). */
  referenceId?: string;
};

/** `tenant_billing_transaction.amount` / `balanceAfter` are `Decimal(18, 2)`. */
const LEDGER_SCALE = 2;

/** Of two writers that read the same `version`, this is the one that lost. */
export class TenantBillingVersionConflict extends Error {
  constructor(readonly tenantId: string) {
    super(`billing wallet of tenant ${tenantId} changed under this transaction; restart it`);
    this.name = 'TenantBillingVersionConflict';
  }
}

/** A debit larger than the balance. A tenant with no wallet has a balance of zero. */
export class TenantBillingInsufficientBalance extends Error {
  constructor(readonly tenantId: string) {
    super(`billing wallet of tenant ${tenantId} cannot cover the debit`);
    this.name = 'TenantBillingInsufficientBalance';
  }
}

/** Zero, negative, or finer than the column — refused rather than rounded, as in billing's ledger. */
export class TenantBillingInvalidAmount extends Error {
  constructor(amount: Prisma.Decimal) {
    super(`billing amount must be > 0 with at most ${LEDGER_SCALE} decimal places, got ${amount.toString()}`);
    this.name = 'TenantBillingInvalidAmount';
  }
}

/** An entry for this (reasonType, referenceId) already exists. */
export class TenantBillingDuplicateEntry extends Error {
  constructor(
    readonly reasonType: TenantBillingReasonType,
    readonly referenceId: string,
  ) {
    super(`a ${reasonType} entry for reference ${referenceId} already exists`);
    this.name = 'TenantBillingDuplicateEntry';
  }
}

@Injectable()
export class TenantBillingLedger {
  async credit(tx: Prisma.TransactionClient, entry: TenantBillingEntry): Promise<TenantBillingTransaction> {
    const moved = await this.move(tx, entry, TenantLedgerDirection.credit);
    await tx.outboxEvent.create({
      data: {
        aggregate: 'tenant.billing_wallet',
        aggregateId: moved.walletId,
        type: OutboxEventType.TENANT_BILLING_CREDITED,
        payload: { tenantId: entry.tenantId, transactionId: moved.id, balanceAfter: moved.balanceAfter.toFixed(2) },
      },
      select: { id: true },
    });
    return moved;
  }

  debit(tx: Prisma.TransactionClient, entry: TenantBillingEntry): Promise<TenantBillingTransaction> {
    return this.move(tx, entry, TenantLedgerDirection.debit);
  }

  private async move(
    tx: Prisma.TransactionClient,
    entry: TenantBillingEntry,
    direction: TenantLedgerDirection,
  ): Promise<TenantBillingTransaction> {
    const { tenantId, amount, reasonType, referenceId } = entry;
    if (amount.lte(0) || amount.decimalPlaces() > LEDGER_SCALE) {
      throw new TenantBillingInvalidAmount(amount);
    }

    if (referenceId !== undefined) {
      const existing = await tx.tenantBillingTransaction.findFirst({
        where: { reasonType, referenceId },
        select: { id: true },
      });
      if (existing) throw new TenantBillingDuplicateEntry(reasonType, referenceId);
    }

    let wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId } });
    if (!wallet) {
      if (direction === TenantLedgerDirection.debit) throw new TenantBillingInsufficientBalance(tenantId);
      // Opens on the first credit; `skipDuplicates` lets two first credits meet
      // at the version guard below instead of at the unique `tenantId`.
      await tx.tenantBillingWallet.createMany({ data: [{ tenantId }], skipDuplicates: true });
      wallet = await tx.tenantBillingWallet.findUniqueOrThrow({ where: { tenantId } });
    }

    const balanceAfter =
      direction === TenantLedgerDirection.credit
        ? wallet.cachedBalance.plus(amount)
        : wallet.cachedBalance.minus(amount);
    if (balanceAfter.isNegative()) throw new TenantBillingInsufficientBalance(tenantId);

    // The cache first, under the version it was read at: a loser appends nothing.
    const { count } = await tx.tenantBillingWallet.updateMany({
      where: { id: wallet.id, version: wallet.version },
      data: { cachedBalance: balanceAfter, version: { increment: 1 } },
    });
    if (count !== 1) throw new TenantBillingVersionConflict(tenantId);

    try {
      return await tx.tenantBillingTransaction.create({
        data: { walletId: wallet.id, amount, direction, reasonType, referenceId, balanceAfter },
      });
    } catch (e) {
      // Two writers of the same reference both passed the check above; the
      // unique index lets one through. The transaction is aborted either way.
      if (referenceId !== undefined && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new TenantBillingDuplicateEntry(reasonType, referenceId);
      }
      throw e;
    }
  }
}
