import { Injectable } from '@nestjs/common';
import { GrantStatus, Prisma, SpendingCap, SpendingCapPeriod, WalletHoldStatus } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { reviveFundedGrants } from '../entitlement/revival';
import { PrismaService } from '../prisma/prisma.service';
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
 * (`vpn-reserve.ts`). `WalletModule` installs the real one at boot.
 */

const ZERO = new Prisma.Decimal(0);
const max0 = (v: Prisma.Decimal) => (v.lt(0) ? ZERO : v);
const minOf = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.lt(b) ? a : b);

/** Days in a UTC month (`month` 0-based, may overflow into the next year). */
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** `anchor` moved on by `months`, its day clamped to the month's last (31 Jan -> 28 Feb), its time kept. */
function addMonths(anchor: Date, months: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + months;
  const day = Math.min(anchor.getUTCDate(), daysIn(y, m));
  return new Date(Date.UTC(y, m, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

/** The start of the monthly period `at` falls in: the latest anniversary of `anchor` not after it. */
export function periodStart(anchor: Date, at: Date): Date {
  let months = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (at.getUTCMonth() - anchor.getUTCMonth());
  if (months <= 0) return anchor;
  let start = addMonths(anchor, months);
  while (start.getTime() > at.getTime() && months > 0) start = addMonths(anchor, --months);
  return start;
}

export class SpendingCaps {
  /**
   * `off` is a set of caps that bounds nothing — a spec of something else,
   * whose fake has no `spendingCap` table.
   */
  constructor(private readonly off = false) {}

  /** The Grant's cap with its period brought up to `at`, or null for none. */
  async of(tx: Prisma.TransactionClient, grantId: string, at: Date = new Date()): Promise<SpendingCap | null> {
    if (this.off) return null;
    const cap = await tx.spendingCap.findUnique({ where: { grantId } });
    if (!cap || cap.period !== SpendingCapPeriod.monthly) return cap;
    const start = periodStart(cap.startsAt, at);
    if (start.getTime() <= cap.periodStartsAt.getTime()) return cap;
    // Guarded on the period read: two decisions crossing the date restart it once.
    await tx.spendingCap.updateMany({ where: { grantId, periodStartsAt: cap.periodStartsAt }, data: { periodStartsAt: start, spent: ZERO } });
    return { ...cap, periodStartsAt: start, spent: ZERO };
  }

  /** What is held for this Grant now: its reserve and every one of its meters' holds. */
  async heldFor(tx: Prisma.TransactionClient, grant: { id: string; userId: string }): Promise<Prisma.Decimal> {
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
    if (!wallet) return ZERO;
    const meters = await tx.grantMeter.findMany({ where: { grantId: grant.id }, select: { id: true } });
    const open = await tx.walletHold.findMany({
      where: { walletId: wallet.id, status: WalletHoldStatus.open, ownerRef: { in: [grant.id, ...meters.map((m) => m.id)] } },
    });
    return open.reduce((sum, h) => sum.plus(h.amount), ZERO);
  }

  /**
   * `available` bounded by the Grant's cap: what may be debited or held for
   * it now. `own` is the part of what is held for it that the caller counts
   * in `available` too — the hold it is about to spend or resize — so it is
   * not taken off twice. No cap is `available` unchanged.
   */
  async within(
    tx: Prisma.TransactionClient,
    grant: { id: string; userId: string },
    available: Prisma.Decimal,
    own: Prisma.Decimal = ZERO,
    at: Date = new Date(),
  ): Promise<Prisma.Decimal> {
    const cap = await this.of(tx, grant.id, at);
    if (!cap) return available;
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
    // A cap in another currency than the wallet is not this code's to convert (C-02): it funds nothing.
    if (!wallet || wallet.currencyCode !== cap.currencyCode) return ZERO;
    const room = max0(cap.amount.minus(cap.spent).minus(await this.heldFor(tx, grant)).plus(own));
    return minOf(max0(available), room);
  }

  /** A usage charge on this Grant, counted on its cap in the charge's transaction. No cap, no write. */
  async spend(tx: Prisma.TransactionClient, grantId: string, amount: Prisma.Decimal, at: Date = new Date()): Promise<void> {
    if (this.off || amount.lte(0)) return;
    if (!(await this.of(tx, grantId, at))) return;
    await tx.spendingCap.updateMany({ where: { grantId }, data: { spent: { increment: amount } } });
  }
}

/** For a spec of something else: bounds nothing, reads nothing. */
export const NO_SPENDING_CAPS = new SpendingCaps(true);

let installed: SpendingCaps = NO_SPENDING_CAPS;

export function installSpendingCaps(caps: SpendingCaps): SpendingCaps {
  installed = caps;
  return caps;
}

/** `available` bounded by the Grant's cap (see `SpendingCaps.within`). */
export function withinCap(
  tx: Prisma.TransactionClient,
  grant: { id: string; userId: string },
  available: Prisma.Decimal,
  own: Prisma.Decimal = ZERO,
): Promise<Prisma.Decimal> {
  return installed.within(tx, grant, available, own);
}

/** Counts a usage charge on the Grant's cap, in the charge's transaction. */
export function spendOnCap(tx: Prisma.TransactionClient, grantId: string, amount: Prisma.Decimal): Promise<void> {
  return installed.spend(tx, grantId, amount);
}

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
