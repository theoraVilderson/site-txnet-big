import { Prisma, TenantType } from '@prisma/client';

import { finerThanPlaces } from './money-rounding';

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
 * The platform's own currency: the platform tenant's operating
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

/**
 * The places of `code`'s minor unit, from the registry (`currency.decimalPlaces`):
 * what every money amount in it is rounded to (ADR-0153 point 1). Never a
 * fallback to 2 — a rial has none, and an unregistered code is a caller bug.
 */
export async function currencyPlacesOf(tx: Pick<Prisma.TransactionClient, 'currency'>, code: string): Promise<number> {
  const row = await tx.currency.findUnique({ where: { code }, select: { decimalPlaces: true } });
  if (!row) throw new Error(`currency ${code} is not registered`);
  return row.decimalPlaces;
}

/** `currencyPlacesMap`'s answer: the places of each code asked, and a refusal for any it was not asked or does not know. */
export type CurrencyPlaces = { of(code: string): number };

type CurrencyRegistry = {
  currency: { findMany(args: { where?: { code: { in: string[] } }; select: { code: true; decimalPlaces: true } }): Promise<Array<{ code: string; decimalPlaces: number }>> };
};

/**
 * The places of several currencies in one query — a list or a report in many
 * currencies asks once, not per row (C-28); with no codes, of every registered
 * one (a reference table of a few dozen rows). Unregistered is a caller bug.
 */
export async function currencyPlacesMap(tx: CurrencyRegistry, codes?: Iterable<string>): Promise<CurrencyPlaces> {
  const wanted = codes === undefined ? null : [...new Set(codes)];
  const select = { code: true, decimalPlaces: true } as const;
  const rows = wanted === null ? await tx.currency.findMany({ select }) : wanted.length ? await tx.currency.findMany({ where: { code: { in: wanted } }, select }) : [];
  const places = new Map(rows.map((r) => [r.code, r.decimalPlaces]));
  return {
    of(code: string) {
      const found = places.get(code);
      if (found === undefined) throw new Error(`currency ${code} is not registered`);
      return found;
    },
  };
}

/**
 * The first of `amounts` finer than `currencyCode`'s places, by field name, or
 * null — what a write refuses with its own reason before it stores money a
 * ledger would later refuse (F-116-r).
 */
export async function finerThanCurrency(
  tx: Pick<Prisma.TransactionClient, 'currency'>,
  currencyCode: string,
  amounts: Parameters<typeof finerThanPlaces>[0],
): Promise<string | null> {
  return finerThanPlaces(amounts, await currencyPlacesOf(tx, currencyCode));
}

/**
 * `currencyCode`, once every one of `amounts` is at its places — else the
 * write's own refusal for the first that is not (F-116-r). One line at the
 * write: `currencyCode: await inCurrency(tx, code, { price }, (f) => new XRefused(f))`.
 */
export async function inCurrency(
  tx: Pick<Prisma.TransactionClient, 'currency'>,
  currencyCode: string,
  amounts: Parameters<typeof finerThanPlaces>[0],
  refuse: (field: string) => Error,
): Promise<string> {
  const finer = await finerThanCurrency(tx, currencyCode, amounts);
  if (finer) throw refuse(finer);
  return currencyCode;
}
