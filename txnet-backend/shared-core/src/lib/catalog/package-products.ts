import { TenantType, type Prisma } from '@prisma/client';

import { productOfLockKey } from '../billing/product-quota';

/**
 * What a reseller may sell of the platform's catalog (ADR-0107 point 3,
 * F-019-v5): a platform product only if its package lists it
 * (`tenant.package_product`). The reseller's own products are its own business
 * and never bounded here; a reseller with no subscription sells none of the
 * platform's (user, 2026-10-01); a tenant that is not a reseller — the
 * platform's own — is not bounded at all. A product taken off the package
 * during the reseller's paid period is still its to sell until the period ends
 * (F-019-v6: a period lock holds it, `product-quota.ts`).
 *
 * Asked by every place that sells or hands out a variant: the shop list, an
 * invoice, a Grant bought or redeemed, a reseller admin's issue (billing), and
 * the onboarding checklist's `offeredToTenant` (tenant). A renewal of what a
 * user already holds, and the platform's staff acting on a reseller, are not
 * sales of a new product and do not ask.
 */

export type PackageProductReader = Pick<Prisma.TransactionClient, 'tenant' | 'tenantSubscription' | 'packageProduct' | 'resellerQuotaTermsLock'>;

/**
 * The platform products `tenantId` may sell, by id: its package's list, an
 * empty set with no subscription, or `null` — nothing bounds this tenant.
 * Read on the caller's `tx`, so a sale and the list it was checked against are
 * one snapshot.
 */
export async function platformProductsSoldBy(tx: PackageProductReader, tenantId: string): Promise<ReadonlySet<string> | null> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
  if (tenant?.tenantType !== TenantType.reseller) return null;
  const sub = await tx.tenantSubscription.findUnique({ where: { tenantId }, select: { packageId: true, currentPeriodEnd: true } });
  if (!sub) return new Set();
  const [rows, held] = await Promise.all([
    tx.packageProduct.findMany({ where: { packageId: sub.packageId }, select: { productId: true } }),
    // Taken off the package this period: still sold until it ends, on the terms it was held at (F-019-v6, ADR-0107 point 8).
    tx.resellerQuotaTermsLock.findMany({ where: { tenantId, periodEnd: sub.currentPeriodEnd, key: { startsWith: 'product:' } }, select: { key: true } }),
  ]);
  return new Set([...rows.map((r) => r.productId), ...held.flatMap((r): string[] => {
    const id = productOfLockKey(r.key);
    return id ? [id] : [];
  })]);
}

/** The rule on a product in hand: its own tenant's always, the platform's only when listed; `null` sells everything. */
export function sellsProduct(listed: ReadonlySet<string> | null, product: { id: string; tenantId: string | null }): boolean {
  return listed === null || product.tenantId !== null || listed.has(product.id);
}

/**
 * One product in hand, for one sale: the tenant's own without reading
 * anything, a platform product against its package's list.
 */
export async function tenantSellsProduct(tx: PackageProductReader, tenantId: string, product: { id: string; tenantId: string | null }): Promise<boolean> {
  if (product.tenantId !== null) return true;
  return sellsProduct(await platformProductsSoldBy(tx, tenantId), product);
}
