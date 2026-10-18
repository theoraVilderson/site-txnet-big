import { Prisma } from '@prisma/client';
import { inCurrency, platformTenantIdOf } from '@txnet-backend/shared-core';

import { firstNotPlatformProduct, limitWithin, overageColumns, productQuotaColumns, quotaKeyOf } from '../limits/package-terms';
import { ResellerLimitsRefused } from '../limits/reseller-limits.service';
import type { CreatePackageInput, PackageProductInput } from './tenant-package.schema';
import { TenantPackageRefused } from './tenant-package.service';

/**
 * The rest of a package, written with it (ADR-0154 decision 4): its limits,
 * its overage modes past a quota and the platform products it sells. Each
 * entry is checked by the same function its own endpoint uses
 * (`limits/package-terms.ts`), and a refusal names the request field it came
 * from — `limits.2.value` — so the wizard returns to that step.
 *
 * A new package has no subscribers, so nothing here freezes paid terms
 * (ADR-0107 point 8) the way an edit on the limits endpoints must.
 */

/** The limits refusals a part can earn, all `422` on the package route. */
export const PACKAGE_PART_REJECTIONS = ['unknown_limit', 'limit_out_of_range', 'not_a_quota', 'product_not_found', 'amount_finer_than_currency'] as const;
export type PackagePartRejection = (typeof PACKAGE_PART_REJECTIONS)[number];

/** The field of an entry each refusal is about. */
const FIELD_OF: Record<PackagePartRejection, string> = {
  unknown_limit: 'key',
  limit_out_of_range: 'value',
  not_a_quota: 'key',
  product_not_found: 'productId',
  amount_finer_than_currency: 'unitPrice',
};

const isPartRejection = (reason: string): reason is PackagePartRejection => (PACKAGE_PART_REJECTIONS as readonly string[]).includes(reason);

/** Runs a limits check on the entry at `at`, its refusal raised as the package's with the field it names. */
function asEntry<T>(at: string, check: () => T): T {
  try {
    return check();
  } catch (e) {
    if (e instanceof ResellerLimitsRefused && isPartRejection(e.reason)) throw new TenantPackageRefused(e.reason, e.detail, `${at}.${FIELD_OF[e.reason]}`);
    throw e;
  }
}

/** The checks that need no database — every limit key and value, every overage key — so a bad body costs no transaction. */
export function checkPackageParts(input: CreatePackageInput): void {
  (input.limits ?? []).forEach((limit, i) => asEntry(`limits.${i}`, () => limitWithin(limit.key, limit.value)));
  (input.quotaOverages ?? []).forEach((overage, i) => asEntry(`quotaOverages.${i}`, () => quotaKeyOf(overage.key)));
}

/** Writes the parts of a package just created, in its transaction; checks first, so a refusal writes none of them. */
export async function writePackageParts(
  tx: Prisma.TransactionClient,
  pkg: { id: string; currencyCode: string },
  { input, adminId }: { input: CreatePackageInput; adminId: string },
): Promise<void> {
  const limits = input.limits ?? [];
  const overages = input.quotaOverages ?? [];
  const products = input.products ?? [];
  await overagePricesFit(tx, pkg.currencyCode, input);
  await platformProductsOnly(tx, products);
  // Every price is the platform's currency, which the package is priced in too (ADR-0098 part 4).
  const inPackageCurrency = async () => pkg.currencyCode;
  const by = { packageId: pkg.id, updatedByUserId: adminId };
  if (limits.length > 0) {
    await tx.packageLimit.createMany({ data: limits.map((l) => ({ ...by, key: l.key, value: l.value })) });
  }
  if (overages.length > 0) {
    const data = await Promise.all(overages.map(async (o) => ({ ...by, key: o.key, ...(await overageColumns(o, inPackageCurrency)) })));
    await tx.packageQuotaOverage.createMany({ data });
  }
  if (products.length > 0) {
    const data = await Promise.all(products.map(async (p) => ({ ...by, productId: p.productId, ...(await productQuotaColumns(p, inPackageCurrency)) })));
    await tx.packageProduct.createMany({ data });
  }
}

/** Every overage price at most the currency's places, as `PUT …/overage` and `PUT …/products/:id` hold it (F-116-r, F-019-v6-a) — all of them in one read. */
async function overagePricesFit(tx: Prisma.TransactionClient, currencyCode: string, input: CreatePackageInput): Promise<void> {
  const prices: Record<string, Prisma.Decimal> = {};
  (input.quotaOverages ?? []).forEach((o, i) => {
    if (o.mode === 'overage') prices[`quotaOverages.${i}.unitPrice`] = new Prisma.Decimal(o.unitPrice);
  });
  (input.products ?? []).forEach((p, i) => {
    if (p.overage?.mode === 'overage') prices[`products.${i}.overage.unitPrice`] = new Prisma.Decimal(p.overage.unitPrice);
  });
  if (Object.keys(prices).length === 0) return;
  await inCurrency(tx, currencyCode, prices, (field) => new TenantPackageRefused('amount_finer_than_currency', currencyCode, field));
}

/** Only the platform's products are listed on a package (ADR-0107 point 3); one read for all of them. */
async function platformProductsOnly(tx: Prisma.TransactionClient, products: PackageProductInput[]): Promise<void> {
  if (products.length === 0) return;
  const ids = products.map((p) => p.productId);
  const stranger = await firstNotPlatformProduct(tx, await platformTenantIdOf(tx), ids);
  if (stranger) throw new TenantPackageRefused('product_not_found', stranger, `products.${ids.indexOf(stranger)}.productId`);
}
