import { Prisma, SpendingCap, SpendingCapPeriod, WalletHoldStatus } from '@prisma/client';

/**
 * The spending-cap engine every money path funds through (F-118-i, ADR-0105
 * (9)) — the rules are `spending-cap.ts`'s class comment; the owner's routes
 * are there too.
 *
 * Kept apart from them because of what they import: the routes revive Grants
 * and top a reserve (`revival.ts`, `vpn-reserve.ts`), and those paths call
 * `withinCap` / `spendOnCap` themselves. Joined in one file, `vpn-reserve.ts`
 * reached `block-purchase.ts` through it before `VpnReserve` existed, and
 * Nest could not inject the reserve at boot (`traffic/reserve-load-order.spec.ts`).
 * This file imports nothing of this service.
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
