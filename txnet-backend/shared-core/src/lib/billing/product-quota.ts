import { TenantType, type Prisma } from '@prisma/client';

import { overageTermsOf } from '../tenant/reseller-limits';
import { kinderQuotaTerms, type QuotaLockScope, type QuotaTermsInEffect } from './quota-terms-lock';
import type { QuotaPeriodKind } from './quota-period';
import { ResellerQuota, type QuotaMeterTerms, type QuotaWindow } from './reseller-quota';

/**
 * A product's sales quota (ADR-0107 point 3, F-019-v6): what a reseller's
 * package includes of one **platform** product per fixed day, week and
 * month — each optional — counted over all of the reseller's sales of it, and
 * past any of them `stop` or `overage` at one price. One engine meter per
 * product (`product:<id>`), consumed by the sale and given back only by a sale
 * never delivered (user, 2026-10-01: a service used kept the platform's room).
 *
 * The terms are the package's `package_product` row, held for the paid period
 * as a registry key's are (F-019-v3): one `reseller_quota_terms_lock` row per
 * window, key `product:<id>:<window>`, written before the platform changes the
 * row, takes it off the package, or moves the reseller to another package.
 * The kinder part wins, window by window. A product taken off mid-period is
 * still sold, on its locked terms, until the period ends (`platformProductsSoldBy`).
 *
 * The reseller's own products and a tenant that is not a reseller are never
 * counted: nothing is read or written.
 */

export const PRODUCT_QUOTA_WINDOWS = ['day', 'week', 'month'] as const satisfies readonly QuotaPeriodKind[];
export type ProductQuotaWindow = (typeof PRODUCT_QUOTA_WINDOWS)[number];

const COLUMN = { day: 'dayIncluded', week: 'weekIncluded', month: 'monthIncluded' } as const satisfies Record<ProductQuotaWindow, string>;

/** The engine's reference for one sale: the Grant it made. */
export const productSaleRef = (grantId: string) => `grant:${grantId}`;

/** The engine meter a product's sales are counted on. */
export const productQuotaMeter = (productId: string) => `product:${productId}`;

/** The period-lock key of one window of a product's quota. */
export const productQuotaLockKey = (productId: string, window: ProductQuotaWindow) => `product:${productId}:${window}`;

/** The product a period-lock key names, or null for a registry key. */
export function productOfLockKey(key: string): string | null {
  const m = /^product:([0-9a-f-]{36}):(day|week|month)$/.exec(key);
  return m ? m[1] : null;
}

/** A listing's quota columns, as `package_product` stores them. */
export type ProductQuotaRow = {
  dayIncluded: number | null;
  weekIncluded: number | null;
  monthIncluded: number | null;
  mode: Parameters<typeof overageTermsOf>[0]['mode'];
  unitPrice: Prisma.Decimal | null;
  currencyCode: string | null;
};

type LockRow = { key: string; included: number | null; mode: ProductQuotaRow['mode']; unitPrice: Prisma.Decimal | null; currencyCode: string | null };

const PACKAGE = 'package' as const;

function inEffect(included: number | null, row: Pick<ProductQuotaRow, 'mode' | 'unitPrice' | 'currencyCode'>): QuotaTermsInEffect {
  return { included, includedSource: PACKAGE, overage: overageTermsOf(row), overageSource: PACKAGE };
}

/**
 * A product's quota for one reseller as the engine applies it, or `null`: not
 * a reseller, its own product, or a platform product its package neither lists
 * nor held for this period (not sold at all — F-019-v5 refuses it first).
 */
export async function productQuotaTermsOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  product: { id: string; tenantId: string | null },
): Promise<QuotaMeterTerms | null> {
  if (product.tenantId !== null) return null;
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
  if (tenant?.tenantType !== TenantType.reseller) return null;
  const sub = await tx.tenantSubscription.findUnique({ where: { tenantId }, select: { packageId: true, currentPeriodEnd: true } });
  if (!sub) return null;
  const [live, locks] = await Promise.all([
    tx.packageProduct.findUnique({ where: { packageId_productId: { packageId: sub.packageId, productId: product.id } } }),
    tx.resellerQuotaTermsLock.findMany({
      where: { tenantId, periodEnd: sub.currentPeriodEnd, key: { in: PRODUCT_QUOTA_WINDOWS.map((w) => productQuotaLockKey(product.id, w)) } },
      select: { key: true, included: true, mode: true, unitPrice: true, currencyCode: true },
    }),
  ]);
  return termsFrom(product.id, live, locks);
}

/** Live row and locked rows, window by window, the kinder part winning; exported for the spec. */
export function termsFrom(productId: string, live: ProductQuotaRow | null, locks: readonly LockRow[]): QuotaMeterTerms | null {
  if (!live && locks.length === 0) return null;
  // Every window's lock row carries the same overage: the listing's one price.
  const heldOverage = locks.length > 0 ? inEffect(null, locks[0]) : null;
  const overage = live ? kinderQuotaTerms(heldOverage, inEffect(null, live)).overage : (heldOverage as QuotaTermsInEffect).overage;
  const windows: QuotaWindow[] = PRODUCT_QUOTA_WINDOWS.map((period) => {
    const lock = locks.find((l) => l.key === productQuotaLockKey(productId, period));
    const held = lock ? inEffect(lock.included, lock) : null;
    // Taken off the package mid-period: only the locked terms are left (locks are written three at a time).
    if (!live) return { period, included: held?.included ?? null };
    return { period, included: kinderQuotaTerms(held, inEffect(live[COLUMN[period]], live)).included };
  });
  return { meter: productQuotaMeter(productId), windows, overage };
}

/**
 * One sale of `product` by the reseller in scope: refused past its quota, or
 * charged past it (`ResellerQuotaExhausted` / the engine's overage), in the
 * sale's transaction. `sourceRef` names the sale (`grant:<id>`), so a retry is a
 * replay. Nothing for the reseller's own product, a non-reseller, or no terms.
 */
export async function consumeProductSale(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; product: { id: string; tenantId: string | null }; sourceRef: string; now?: Date },
): Promise<void> {
  const terms = await productQuotaTermsOf(tx, input.tenantId, input.product);
  if (!terms) return;
  await ResellerQuota.consumeMeter(tx, { tenantId: input.tenantId, terms, qty: 1, sourceRef: input.sourceRef, now: input.now });
}

/** Would one more sale be refused now? Throws what `consumeProductSale` would; writes nothing (an invoice). */
export async function admitProductSale(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; product: { id: string; tenantId: string | null }; now?: Date },
): Promise<void> {
  const terms = await productQuotaTermsOf(tx, input.tenantId, input.product);
  if (!terms) return;
  await ResellerQuota.admit(tx, { tenantId: input.tenantId, terms, qty: 1, now: input.now });
}

/**
 * Freezes, for every reseller in `scope` with a subscription, the product
 * quotas its package sells now — only `productIds` when given — for its current
 * period, unless already frozen. Call it in the write's transaction, **before**
 * the write: a listing changed or taken off, or a reseller moved to another
 * package. Answers how many rows it froze.
 */
export async function lockProductQuotaTerms(tx: Prisma.TransactionClient, scope: QuotaLockScope, productIds?: readonly string[]): Promise<number> {
  const subWhere = 'packageId' in scope ? { packageId: scope.packageId } : 'tenantIds' in scope ? { tenantId: { in: scope.tenantIds } } : {};
  const subs = await tx.tenantSubscription.findMany({ where: subWhere, select: { tenantId: true, packageId: true, currentPeriodEnd: true } });
  if (subs.length === 0) return 0;
  const resellers = new Set(
    (await tx.tenant.findMany({ where: { id: { in: subs.map((s) => s.tenantId) }, tenantType: TenantType.reseller, deletedAt: null }, select: { id: true } })).map((t) => t.id),
  );
  const reach = subs.filter((s) => resellers.has(s.tenantId));
  if (reach.length === 0) return 0;

  const listings = await tx.packageProduct.findMany({
    where: { packageId: { in: [...new Set(reach.map((s) => s.packageId))] }, ...(productIds ? { productId: { in: [...productIds] } } : {}) },
  });
  if (listings.length === 0) return 0;
  const locked = await tx.resellerQuotaTermsLock.findMany({
    where: { tenantId: { in: reach.map((s) => s.tenantId) }, key: { startsWith: 'product:' } },
    select: { tenantId: true, key: true, periodEnd: true },
  });
  const done = new Set(locked.map((r) => `${r.tenantId}|${r.key}|${r.periodEnd.getTime()}`));

  const data: Prisma.ResellerQuotaTermsLockCreateManyInput[] = [];
  for (const s of reach) {
    for (const row of listings.filter((l) => l.packageId === s.packageId)) {
      for (const window of PRODUCT_QUOTA_WINDOWS) {
        const key = productQuotaLockKey(row.productId, window);
        if (done.has(`${s.tenantId}|${key}|${s.currentPeriodEnd.getTime()}`)) continue;
        data.push({
          tenantId: s.tenantId,
          key,
          periodEnd: s.currentPeriodEnd,
          included: row[COLUMN[window]],
          includedSource: PACKAGE,
          mode: row.mode,
          unitPrice: row.unitPrice,
          currencyCode: row.currencyCode,
          overageSource: PACKAGE,
        });
      }
    }
  }
  if (data.length === 0) return 0;
  // skipDuplicates: two writes racing for one period freeze it once — both read the same terms in force.
  return (await tx.resellerQuotaTermsLock.createMany({ data, skipDuplicates: true })).count;
}
