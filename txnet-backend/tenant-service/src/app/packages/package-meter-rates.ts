import { Prisma } from '@prisma/client';
import { type PackageMeterRate, packageMeterRatesAt } from '@txnet-backend/shared-core';

import type { MeterRateEdit } from './tenant-package.schema';

/**
 * The wholesale price list's writer (F-118-n1, ADR-0105 (10)): the package
 * routes' `meterRates`. Rows are history — the migration's trigger lets only
 * `isActive` change — so a new price is a new row, and a Grant that locked the
 * old one (F-118-n2) can still be traced to it.
 */

/** A rate as the package view shows it: strings, as they were sent (C-02). */
export type MeterRateView = { meterKey: string; unitSize: string; unitPrice: string; currencyCode: string; effectiveFrom: string };

export const rateView = (r: PackageMeterRate): MeterRateView => ({
  meterKey: r.meterKey,
  unitSize: r.unitSize.toString(),
  unitPrice: r.unitPrice.toString(),
  currencyCode: r.currencyCode,
  effectiveFrom: r.effectiveFrom.toISOString(),
});

type Db = Pick<Prisma.TransactionClient, 'tenantPackageMeterRate'>;

/** The rates in force now of each package, by package id. */
export async function ratesOf(db: Db, packages: { id: string; currencyCode: string }[]): Promise<Map<string, MeterRateView[]>> {
  const rates = await packageMeterRatesAt(db, new Map(packages.map((p) => [p.id, p.currencyCode])));
  return new Map([...rates].map(([id, list]) => [id, list.map(rateView)]));
}

/** The meters named that the catalog does not have — checked before anything is written. */
export async function unknownMeters(tx: Pick<Prisma.TransactionClient, 'meter'>, edits: MeterRateEdit[]): Promise<string[]> {
  const keys = edits.map((e) => e.meterKey);
  if (keys.length === 0) return [];
  const known = new Set((await tx.meter.findMany({ where: { key: { in: keys } }, select: { key: true } })).map((m) => m.key));
  return keys.filter((k) => !known.has(k));
}

/**
 * Brings the package's list to `edits`, in the caller's transaction, and says
 * whether anything was written. A meter left out is left as it is; the same
 * price again writes nothing; `null` switches **every** active row of the
 * meter off, so an older price does not come back into force.
 */
export async function writeMeterRates(
  tx: Db,
  pkg: { id: string; currencyCode: string },
  current: MeterRateView[],
  edits: MeterRateEdit[],
  adminId: string,
): Promise<boolean> {
  let changed = false;
  for (const edit of edits) {
    const now = current.find((r) => r.meterKey === edit.meterKey);
    if (!('unitSize' in edit)) {
      if (!now) continue;
      await tx.tenantPackageMeterRate.updateMany({ where: { packageId: pkg.id, meterKey: edit.meterKey, isActive: true }, data: { isActive: false } });
      changed = true;
      continue;
    }
    if (now && now.unitSize === edit.unitSize && new Prisma.Decimal(now.unitPrice).eq(edit.unitPrice)) continue;
    await tx.tenantPackageMeterRate.create({
      data: {
        packageId: pkg.id,
        meterKey: edit.meterKey,
        unitSize: BigInt(edit.unitSize),
        unitPrice: edit.unitPrice,
        // The package's, the platform's (ADR-0098 part 4).
        currencyCode: pkg.currencyCode,
        createdByAdminId: adminId,
      },
    });
    changed = true;
  }
  return changed;
}
