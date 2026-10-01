import { Prisma, TenantBillingModel } from '@prisma/client';
import { addBillingPeriod, nameBasedUuid } from '../renewal/tenant-renewal.service';

/**
 * When a reseller's change of package or period takes effect, and what it
 * costs (F-019-v7, ADR-0107 point 9). Pure: the service reads the facts under
 * its locks and writes what this answers.
 *
 * - **Upgrade now, prorated.** On the same period, a package priced higher
 *   applies at once for (new − old) × days left / days in the period.
 * - **Monthly -> yearly now** (user, 2026-10-01: the option that neither
 *   loses the platform money nor makes a reseller wait to pay it more): the
 *   year's price less the month's unused days, and the year starts now —
 *   unless the new package is cheaper by the year than the old one.
 * - **Everything else waits for the renewal**: a cheaper or equal package,
 *   yearly -> monthly. A quota is never used high and paid low, and a year
 *   paid is never refunded.
 * - **An unpaid period changes at once and free** — a trial, or a period
 *   already over: the renewal charges the new price (F-019-c).
 *
 * Days are whole: a day begun is a day left. The charge is rounded half up to
 * the cent, the ledger's precision (C-02).
 */

const DAY_MS = 86_400_000;
const ZERO = new Prisma.Decimal(0);

export type PackageChangePlan =
  | { when: 'none' }
  | { when: 'now'; charge: Prisma.Decimal; periodEnd: Date }
  | { when: 'renewal' };

export type PackageChangeFacts = {
  samePackage: boolean;
  /** The package the reseller is on: its period, its price for that period, and its price for the period asked. */
  from: { model: TenantBillingModel; price: Prisma.Decimal | null; priceForNewModel: Prisma.Decimal | null };
  to: { model: TenantBillingModel; price: Prisma.Decimal };
  periodEnd: Date;
  /** The current period was paid for: not a trial, and not over. */
  paid: boolean;
  now: Date;
};

export function planPackageChange(f: PackageChangeFacts): PackageChangePlan {
  if (f.samePackage && f.from.model === f.to.model) return { when: 'none' };
  if (!f.paid) return { when: 'now', charge: ZERO, periodEnd: f.periodEnd };
  // `package_price_in_use` keeps a subscriber's price; without one there is nothing to credit.
  if (f.from.price === null) return { when: 'renewal' };
  const { left, length } = daysLeft(f.periodEnd, f.from.model, f.now);

  if (f.from.model === f.to.model) {
    if (!f.to.price.gt(f.from.price)) return { when: 'renewal' };
    return { when: 'now', charge: cents(f.to.price.sub(f.from.price).mul(left).div(length)), periodEnd: f.periodEnd };
  }
  if (f.from.model !== TenantBillingModel.subscription_monthly || f.to.model !== TenantBillingModel.subscription_yearly) return { when: 'renewal' };
  if (f.from.priceForNewModel !== null && f.to.price.lt(f.from.priceForNewModel)) return { when: 'renewal' };
  const charge = cents(f.to.price.sub(f.from.price.mul(left).div(length)));
  if (!charge.gt(0)) return { when: 'renewal' };
  return { when: 'now', charge, periodEnd: addBillingPeriod(f.now, TenantBillingModel.subscription_yearly) };
}

/** The upgrade debit's `referenceId`: one per (tenant, period, package, period kind), so a retried change never charges twice. */
export function upgradeChargeReference(tenantId: string, periodEnd: Date, packageId: string, model: TenantBillingModel): string {
  return nameBasedUuid(`tenant-subscription-upgrade:${tenantId}:${periodEnd.toISOString()}:${packageId}:${model}`);
}

/** Whole days left in the period ending `periodEnd`, and the period's own length in days. */
function daysLeft(periodEnd: Date, model: TenantBillingModel, now: Date): { left: number; length: number } {
  const start = addBillingPeriod(periodEnd, model, -1);
  const length = Math.round((periodEnd.getTime() - start.getTime()) / DAY_MS);
  const left = Math.min(length, Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / DAY_MS)));
  return { left, length };
}

function cents(v: Prisma.Decimal): Prisma.Decimal {
  return v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
