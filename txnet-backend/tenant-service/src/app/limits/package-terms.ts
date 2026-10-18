import { Prisma, QuotaOverageMode } from '@prisma/client';
import { isResellerLimitKey, isResellerQuotaKey, RESELLER_LIMITS, type ResellerLimitKey, type ResellerQuotaKey } from '@txnet-backend/shared-core';

import type { SetOverageInput, SetPackageProductInput } from './reseller-limits.schema';
import { ResellerLimitsRefused } from './reseller-limits.service';

/**
 * The checks and columns a limit, an overage mode or a product listing gets,
 * whichever route writes it: the limits endpoints one at a time, a package's
 * create all at once (ADR-0154 decision 4). One home, so a package written
 * whole is held to exactly the rules of one written piece by piece.
 */

/** A registry key (ADR-0106) — `unknown_limit` otherwise. */
export function limitKeyOf(key: string): ResellerLimitKey {
  if (!isResellerLimitKey(key)) throw new ResellerLimitsRefused('unknown_limit', key);
  return key;
}

/** A registry key whose value is within its bound — `limit_out_of_range` otherwise. */
export function limitWithin(key: string, value: number | null): ResellerLimitKey {
  const k = limitKeyOf(key);
  if (value !== null && value > RESELLER_LIMITS[k].max) throw new ResellerLimitsRefused('limit_out_of_range', `${k} ≤ ${RESELLER_LIMITS[k].max}`);
  return k;
}

/** A known key whose registry kind is `quota`; a guard is never sold past (ADR-0107 point 1). */
export function quotaKeyOf(key: string): ResellerQuotaKey {
  const k = limitKeyOf(key);
  if (!isResellerQuotaKey(k)) throw new ResellerLimitsRefused('not_a_quota', k);
  return k;
}

/**
 * The overage columns past a quota: `stop` has no price; an `overage` price is
 * in the currency `currencyFor` answers — the platform's, checked for places or
 * not as the caller's route always has (F-116-r).
 */
export async function overageColumns(input: SetOverageInput, currencyFor: (price: Prisma.Decimal) => Promise<string>) {
  if (input.mode === 'stop') return { mode: QuotaOverageMode.stop, unitPrice: null, currencyCode: null };
  const unitPrice = new Prisma.Decimal(input.unitPrice);
  return { mode: QuotaOverageMode.overage, unitPrice, currencyCode: await currencyFor(unitPrice) };
}

/** A listing's quota columns (F-019-v6): a window left out is no bound, an overage left out is `stop`. */
export async function productQuotaColumns(input: SetPackageProductInput, currencyFor: (price: Prisma.Decimal) => Promise<string>) {
  return {
    dayIncluded: input.day ?? null,
    weekIncluded: input.week ?? null,
    monthIncluded: input.month ?? null,
    ...(await overageColumns(input.overage ?? { mode: 'stop' }, currencyFor)),
  };
}

/** The first id that is not a platform product — only the platform's are listed on a package (ADR-0107 point 3) — or `null`. */
export async function firstNotPlatformProduct(tx: Pick<Prisma.TransactionClient, 'product'>, platformTenantId: string, productIds: string[]): Promise<string | null> {
  if (productIds.length === 0) return null;
  const found = await tx.product.findMany({ where: { id: { in: productIds }, tenantId: platformTenantId }, select: { id: true } });
  const platforms = new Set(found.map((p) => p.id));
  return productIds.find((id) => !platforms.has(id)) ?? null;
}
