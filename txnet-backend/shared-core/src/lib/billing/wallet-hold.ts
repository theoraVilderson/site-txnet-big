import { Injectable } from '@nestjs/common';
import { Prisma, Wallet, WalletHold, WalletHoldStatus, WalletTransaction } from '@prisma/client';

import {
  assertLedgerAmount,
  InsufficientFunds,
  LedgerCurrencyMismatch,
  LedgerEntry,
  WalletLedgerService,
  WalletVersionConflict,
} from './wallet-ledger';

/**
 * Wallet holds (F-118-a, ADR-0105 (6)): money locked for what a wallet has
 * promised — a postpaid Grant's usage, the VPN reserve (F-118-b), a per-use
 * token (F-118-h) — so no other debit can spend it.
 *
 * A hold is **not a ledger row**. It moves no money: `wallet.heldAmount` goes
 * up, and `WalletLedgerService` bounds every debit by `cachedBalance -
 * heldAmount`. Money leaves a hold two ways:
 *
 * - **capture** — one ledger debit and the hold reduced by the same amount, in
 *   the caller's `tx` and under one wallet `version`;
 * - **release** — the hold reduced (or closed) with no money moving.
 *
 * `heldAmount` is written only here and in `WalletLedgerService.debitHeld`,
 * each time under the wallet `version` as the ledger writes `cachedBalance`, so
 * every hold write on a wallet is serialised with every debit on it. Postgres
 * backs all of it: `CHECK (cachedBalance - heldAmount >= 0)`, and a deferred
 * trigger that `heldAmount` equals the open holds' sum, in the wallet's
 * currency (migration `20260929000100_held_money_is_not_spendable`).
 *
 * One open hold per `(wallet, ownerRef)`: a second hold for the same owner tops
 * the first up. A closed hold is history.
 *
 * `tx` is the caller's, as for the ledger; `wallet_hold` carries no `tenantId`
 * and is reached through the wallet's owner, like `wallet` itself.
 */
export type HoldEntry = {
  /** The wallet owner, from a tenant-scoped source (as `LedgerEntry.userId`). */
  userId: string;
  /** What the money is held for — a Grant, a per-use token. */
  ownerRef: string;
  /** Strictly positive, at most 2 decimal places. */
  amount: Prisma.Decimal;
  /** Must be the wallet's: a hold is never converted on the way in. */
  currencyCode: string;
};

/** A capture: the hold it comes from, and the ledger row it becomes. */
export type CaptureEntry = LedgerEntry & { ownerRef: string };

export type ReleaseEntry = {
  userId: string;
  ownerRef: string;
  /** Omitted: release all of it and close the hold. */
  amount?: Prisma.Decimal;
};

/** No open hold for this owner, or one smaller than the amount asked of it. */
export class HoldExceeded extends Error {
  constructor(readonly userId: string, readonly ownerRef: string, readonly amount: Prisma.Decimal | null) {
    super(`wallet of user ${userId} has no open hold for ${ownerRef} covering ${amount?.toString() ?? 'a release'}`);
    this.name = 'HoldExceeded';
  }
}

@Injectable()
export class WalletHoldService {
  constructor(private readonly ledger: WalletLedgerService) {}

  /** Opens a hold, or tops up this owner's open one, from the balance not already held. */
  async hold(tx: Prisma.TransactionClient, entry: HoldEntry): Promise<WalletHold> {
    assertLedgerAmount(entry.amount);
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: entry.userId } });
    if (!wallet) throw new InsufficientFunds(entry.userId);
    if (wallet.currencyCode !== entry.currencyCode) {
      throw new LedgerCurrencyMismatch(entry.userId, wallet.currencyCode, entry.currencyCode);
    }
    const heldAfter = wallet.heldAmount.plus(entry.amount);
    if (wallet.cachedBalance.lt(heldAfter)) throw new InsufficientFunds(entry.userId);
    await writeHeld(tx, wallet, heldAfter, entry.userId);

    const open = await openHold(tx, wallet.id, entry.ownerRef);
    if (!open) {
      return tx.walletHold.create({
        data: { walletId: wallet.id, ownerRef: entry.ownerRef, amount: entry.amount, currencyCode: wallet.currencyCode },
      });
    }
    await tx.walletHold.updateMany({
      where: { id: open.id, status: WalletHoldStatus.open },
      data: { amount: { increment: entry.amount } },
    });
    return tx.walletHold.findUniqueOrThrow({ where: { id: open.id } });
  }

  /**
   * Turns held money into a ledger debit: the hold row down by `amount` and
   * `captured` up, then the ledger's `debitHeld` — the row, `cachedBalance`
   * and `heldAmount` under one `version`. The free balance does not change.
   */
  async capture(tx: Prisma.TransactionClient, entry: CaptureEntry): Promise<WalletTransaction> {
    assertLedgerAmount(entry.amount);
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: entry.userId } });
    const open = wallet ? await openHold(tx, wallet.id, entry.ownerRef) : null;
    if (!open || open.amount.lt(entry.amount)) throw new HoldExceeded(entry.userId, entry.ownerRef, entry.amount);

    // Guarded on the amount it read, so of two captures racing on one hold the
    // second finds too little rather than taking the same money twice.
    const { count } = await tx.walletHold.updateMany({
      where: { id: open.id, status: WalletHoldStatus.open, amount: { gte: entry.amount } },
      data: { amount: { decrement: entry.amount }, captured: { increment: entry.amount } },
    });
    if (count !== 1) throw new WalletVersionConflict(entry.userId);
    return this.ledger.debitHeld(tx, entry);
  }

  /** Gives held money back to the free balance; with no `amount`, all of it, and the hold closes. */
  async release(tx: Prisma.TransactionClient, entry: ReleaseEntry): Promise<WalletHold> {
    if (entry.amount) assertLedgerAmount(entry.amount);
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: entry.userId } });
    const open = wallet ? await openHold(tx, wallet.id, entry.ownerRef) : null;
    const amount = entry.amount ?? open?.amount;
    if (!wallet || !open || !amount || open.amount.lt(amount)) {
      throw new HoldExceeded(entry.userId, entry.ownerRef, entry.amount ?? null);
    }

    if (amount.gt(0)) await writeHeld(tx, wallet, wallet.heldAmount.minus(amount), entry.userId);
    const closing = entry.amount === undefined;
    const { count } = await tx.walletHold.updateMany({
      where: { id: open.id, status: WalletHoldStatus.open, amount: { gte: amount } },
      data: {
        amount: { decrement: amount },
        ...(closing ? { status: WalletHoldStatus.closed, closedAt: new Date() } : {}),
      },
    });
    if (count !== 1) throw new WalletVersionConflict(entry.userId);
    return tx.walletHold.findUniqueOrThrow({ where: { id: open.id } });
  }
}

function openHold(tx: Prisma.TransactionClient, walletId: string, ownerRef: string): Promise<WalletHold | null> {
  return tx.walletHold.findFirst({ where: { walletId, ownerRef, status: WalletHoldStatus.open } });
}

/** `heldAmount`, under the `version` the wallet was read at — as the ledger writes `cachedBalance`. */
async function writeHeld(
  tx: Prisma.TransactionClient,
  wallet: Wallet,
  heldAmount: Prisma.Decimal,
  userId: string,
): Promise<void> {
  const { count } = await tx.wallet.updateMany({
    where: { id: wallet.id, version: wallet.version },
    data: { heldAmount, version: { increment: 1 } },
  });
  if (count !== 1) throw new WalletVersionConflict(userId);
}
