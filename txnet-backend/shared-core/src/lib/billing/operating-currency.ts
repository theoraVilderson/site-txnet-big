import { Prisma, TenantType } from '@prisma/client';

/**
 * The currency a new money row is written in (F-116-b, ADR-0098 parts 2-3).
 *
 * A tenant's own money — its users' wallets, its invoices, payments, coupons,
 * rules, deposit settings and gateway configs — is in its operating currency
 * **at the moment the row is written**. The row then records that code and
 * never looks at the tenant again: the tenant's currency may change (F-116-f),
 * and a row's meaning must not change with it.
 *
 * Read in the writer's own `tx`, so the row and the currency it names come
 * from one snapshot. `tenant.tenant` is not a tenant-scoped model, so this reads
 * the same inside `tenantTransaction` and on the cross-tenant pool.
 */
export async function operatingCurrencyOf(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
  const row = await tx.tenant.findUnique({ where: { id: tenantId }, select: { operatingCurrencyCode: true } });
  // Never a fallback to USD: a row labelled with a guessed currency is the
  // implied currency ADR-0098 forecloses, and a missing tenant is a caller bug.
  if (!row) throw new Error(`tenant ${tenantId} not found reading its operating currency`);
  return row.operatingCurrencyCode;
}

/**
 * The platform's own currency: the `platform_owner` tenant's operating
 * currency (ADR-0098 part 1). A platform gateway, a platform coupon and a
 * tenant's billing top-up are written in it (part 4).
 */
export async function platformCurrencyOf(tx: Prisma.TransactionClient): Promise<string> {
  const row = await tx.tenant.findFirst({
    where: { tenantType: TenantType.platform_owner },
    select: { operatingCurrencyCode: true },
  });
  if (!row) throw new Error('no platform_owner tenant to read the platform currency from');
  return row.operatingCurrencyCode;
}
