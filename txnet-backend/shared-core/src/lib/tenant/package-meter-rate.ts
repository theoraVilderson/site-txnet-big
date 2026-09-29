import type { Prisma } from '@prisma/client';

/**
 * The wholesale price list (F-118-n1, ADR-0105 decision 10): what the
 * platform charges a reseller, per `unitSize` of a platform meter, for usage
 * its users run on the platform's panels. It lives on the reseller's package
 * (user, 2026-09-29), so a tier prices every reseller on it.
 *
 * `tenant_package_meter_rate` is history like `rate_card`: a new price is a
 * new row and only `isActive` changes. The rate **in force** for a meter is
 * the newest active row at or before the instant, in the package's currency —
 * a platform currency change writes new rows beside the old ones, which stay
 * in the old money and are read by nothing.
 *
 * Written by the package routes (tenant-service `packages/`); read there for
 * the package view and, from F-118-n2, when a Grant locks its wholesale rate.
 */

export type PackageMeterRate = {
  id: string;
  packageId: string;
  meterKey: string;
  unitSize: bigint;
  unitPrice: Prisma.Decimal;
  currencyCode: string;
  effectiveFrom: Date;
};

type Reader = { tenantPackageMeterRate: Pick<Prisma.TransactionClient['tenantPackageMeterRate'], 'findMany'> };

/**
 * Every package's rates in force at `at`, keyed by package id, each list
 * ordered by meter key. `currencyOf` is the packages' own currency: a row in
 * another money predates a currency change.
 */
export async function packageMeterRatesAt(
  db: Reader,
  currencyOf: ReadonlyMap<string, string>,
  at: Date = new Date(),
): Promise<Map<string, PackageMeterRate[]>> {
  const packageIds = [...currencyOf.keys()];
  const byPackage = new Map<string, PackageMeterRate[]>(packageIds.map((id): [string, PackageMeterRate[]] => [id, []]));
  if (packageIds.length === 0) return byPackage;
  const rows = await db.tenantPackageMeterRate.findMany({
    where: { packageId: { in: packageIds }, isActive: true, effectiveFrom: { lte: at } },
    // Newest first; two rows from one instant (a change inside one transaction) by when they were written.
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, packageId: true, meterKey: true, unitSize: true, unitPrice: true, currencyCode: true, effectiveFrom: true },
  });
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.packageId}\u0000${row.meterKey}`;
    if (seen.has(key) || row.currencyCode !== currencyOf.get(row.packageId)) continue;
    seen.add(key);
    byPackage.get(row.packageId)?.push(row);
  }
  for (const list of byPackage.values()) list.sort((a, b) => a.meterKey.localeCompare(b.meterKey));
  return byPackage;
}
