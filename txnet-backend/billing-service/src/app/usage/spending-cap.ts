import { Injectable } from '@nestjs/common';
import { GrantStatus, Prisma, SpendingCap, SpendingCapPeriod } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { reviveFundedGrants } from '../entitlement/revival';
import { PrismaService } from '../prisma/prisma.service';
import { SpendingCaps } from './cap-funding';
import { topVpnReserve } from '../traffic/vpn-reserve';

/**
 * A spending cap on one product — the sub-account (F-118-i, ADR-0105 (9)).
 *
 * The owner sets it on a Grant they hold for someone else — family, a friend,
 * a colleague — with a label, an amount in the wallet's currency and a
 * `period`. The Grant is then funded to `min(what the wallet backs, amount −
 * spent − what is held for it)` and cut at whichever runs out first; the
 * owner's other products spend the rest of the wallet as before. The holder
 * needs no account of their own.
 *
 * - **What it bounds**: usage charges — a VPN block, a meter's block or
 *   capture. The plan's own price was paid at purchase and is not counted.
 * - **Held money counts**: the Grant's reserve (F-118-b) and each postpaid
 *   meter's hold (F-118-g) are promises of this Grant's money, so they come
 *   out of the room before anything new is funded. A capture moves money from
 *   held to spent and leaves the room where it was.
 * - **`spent`** is advanced in the transaction of every usage charge
 *   (`spend`), and restarts when a `monthly` period does — on the cap's own
 *   start date (billing open-questions 2026-09-29), read lazily by the next
 *   funding decision rather than by a clock.
 *
 * The planner reads none of this: the cap bounds the bag billing sells and
 * the hold it keeps, so it reaches Quota through them (network
 * `contract.reserve.md`), never per config.
 *
 * Every write is in the caller's `tx` (from `tenantTransaction`). The funding
 * paths reach it through `withinCap` / `spendOnCap`, which the free functions
 * that revive and suspend Grants can call without DI — as they top a reserve
 * (`vpn-reserve.ts`). `WalletModule` installs the real one at boot. That
 * engine is `cap-funding.ts`; this file is the owner's routes.
 */

const ZERO = new Prisma.Decimal(0);
const max0 = (v: Prisma.Decimal) => (v.lt(0) ? ZERO : v);

// ── The owner's routes ───────────────────────────────────────────────────────

export const MAX_CAP_LABEL_LENGTH = 40;

export type SpendingCapInput = { label: string; amount: string; period: SpendingCapPeriod | `${SpendingCapPeriod}` };

export type SpendingCapView = {
  grantId: string;
  label: string;
  amount: string;
  currencyCode: string;
  period: SpendingCapPeriod;
  periodStartsAt: string;
  /** Charged this period. */
  spent: string;
  /** Held for the Grant now — promised, not yet charged. */
  held: string;
  /** `amount − spent`, never below zero. */
  left: string;
};

export type SpendingCapRejection = 'grant_not_found' | 'no_wallet';

export class SpendingCapRefused extends Error {
  constructor(readonly reason: SpendingCapRejection) {
    super(`spending cap refused: ${reason}`);
    this.name = 'SpendingCapRefused';
  }
}

/** A closed Grant is charged nothing more; a cap on it would bound nothing. */
const CLOSED: ReadonlySet<GrantStatus> = new Set<GrantStatus>([GrantStatus.expired, GrantStatus.cancelled]);

const REAL = new SpendingCaps();

@Injectable()
export class SpendingCapService {
  constructor(private readonly prisma: PrismaService) {}

  get(userId: string, grantId: string): Promise<SpendingCapView | null> {
    return tenantTransaction(this.prisma, async (tx) => {
      const grant = await this.owned(tx, userId, grantId);
      const cap = await REAL.of(tx, grantId);
      return cap ? this.view(tx, grant, cap) : null;
    });
  }

  set(userId: string, grantId: string, input: SpendingCapInput): Promise<SpendingCapView> {
    return tenantTransaction(this.prisma, (tx) => this.setIn(tx, userId, grantId, input));
  }

  remove(userId: string, grantId: string): Promise<void> {
    return tenantTransaction(this.prisma, (tx) => this.removeIn(tx, userId, grantId));
  }

  /**
   * Sets, raises or lowers the cap, in the wallet's currency. A new cap, or a
   * new `period`, counts from now; a changed amount or label keeps the count.
   * Then the Grant is funded to the new bound at once: a Grant the cap had
   * cut comes back as a top-up brings it back, and a reserve past a lowered
   * cap is given back.
   */
  async setIn(tx: Prisma.TransactionClient, userId: string, grantId: string, input: SpendingCapInput, at: Date = new Date()): Promise<SpendingCapView> {
    const grant = await this.owned(tx, userId, grantId);
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: userId } });
    if (!wallet) throw new SpendingCapRefused('no_wallet');

    const amount = new Prisma.Decimal(input.amount);
    const period = input.period as SpendingCapPeriod;
    const label = input.label.trim();
    const current = await REAL.of(tx, grantId, at);
    const cap =
      current && current.period === period
        ? await tx.spendingCap.update({ where: { grantId }, data: { label, amount, currencyCode: wallet.currencyCode } })
        : current
          ? await tx.spendingCap.update({
              where: { grantId },
              data: { label, amount, currencyCode: wallet.currencyCode, period, startsAt: at, periodStartsAt: at, spent: ZERO },
            })
          : await tx.spendingCap.create({
              data: { tenantId: grant.tenantId, grantId, label, amount, currencyCode: wallet.currencyCode, period, startsAt: at, periodStartsAt: at },
            });

    await this.refund(tx, grant, wallet.cachedBalance);
    return this.view(tx, grant, cap);
  }

  /** Removes the cap: the Grant is bounded by the wallet alone again, from now. */
  async removeIn(tx: Prisma.TransactionClient, userId: string, grantId: string): Promise<void> {
    const grant = await this.owned(tx, userId, grantId);
    const { count } = await tx.spendingCap.deleteMany({ where: { grantId } });
    if (count === 0) return;
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: userId } });
    await this.refund(tx, grant, wallet?.cachedBalance ?? ZERO);
  }

  /** The Grant funded to its new bound: revived if the cap had cut it, its reserve resized. */
  private async refund(tx: Prisma.TransactionClient, grant: { id: string; userId: string }, balance: Prisma.Decimal): Promise<void> {
    await reviveFundedGrants(tx, grant.userId, balance);
    await topVpnReserve(tx, grant.id);
  }

  /** Another user's Grant is the same refusal as a missing one: the route is not a way to ask whether an id exists. */
  private async owned(tx: Prisma.TransactionClient, userId: string, grantId: string) {
    const grant = await tx.grant.findUnique({ where: { id: grantId } });
    if (!grant || grant.userId !== userId || CLOSED.has(grant.status)) throw new SpendingCapRefused('grant_not_found');
    return grant;
  }

  private async view(tx: Prisma.TransactionClient, grant: { id: string; userId: string }, cap: SpendingCap): Promise<SpendingCapView> {
    const held = await REAL.heldFor(tx, grant);
    return {
      grantId: cap.grantId,
      label: cap.label,
      amount: cap.amount.toFixed(2),
      currencyCode: cap.currencyCode,
      period: cap.period,
      periodStartsAt: cap.periodStartsAt.toISOString(),
      spent: cap.spent.toFixed(2),
      held: held.toFixed(2),
      left: max0(cap.amount.minus(cap.spent)).toFixed(2),
    };
  }
}
