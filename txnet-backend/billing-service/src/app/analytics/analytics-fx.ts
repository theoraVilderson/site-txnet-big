import { Prisma } from '@prisma/client';
import { DERIVED_CURRENCIES, FX_PIVOT_CURRENCY } from '@txnet-backend/shared-core';

import type { CostDayRow } from './analytics-cost';
import type { Day } from './analytics-days';
import { dayIn } from './analytics-rollup';

/**
 * A cost in the currency its tenant sells in (F-1001-l, ADR-0149): every cost
 * row is converted at **its own day's** rate, so a margin never subtracts
 * dollars from tomans and a rate moving today never rewrites last month — and
 * into **its own day's** currency, so a currency change (F-116) never moves
 * last month's cost into this month's money (F-1001-q).
 */

/** A cost is kept to six places, as the attribution writes it. */
const COST_PLACES = 6;

/** A tenant's currency change on the tenant day it took effect, and the currency it left. */
export type CurrencyChangeDay = { day: Day; fromCode: string };

/** The currency a tenant sold in at a day's end. */
export type CurrencyOn = (day: Day) => string;

/** Units of a root currency per one USD on a day, as `currency_exchange_rate` quotes it. */
export type RateRow = { code: string; day: Day; rate: Prisma.Decimal };

/** One currency's rate on one day; `null` when none is on record. */
export type RateOf = (code: string, day: Day) => Prisma.Decimal | null;

/** A cost row and what it is in the tenant's operating currency; `saleCost` null when no rate converts it. */
export type ConvertedCost = CostDayRow & { saleCurrencyCode: string; saleCost: Prisma.Decimal | null };

/** `rows` as a lookup: the pivot is 1, a derived currency its root over its divisor (the toman, F-116-m). */
export function rateLookup(rows: readonly RateRow[]): RateOf {
  const byKey = new Map(rows.map((r) => [`${r.code}|${r.day}`, r.rate]));
  return (code, day) => {
    if (code === FX_PIVOT_CURRENCY) return new Prisma.Decimal(1);
    const derived = DERIVED_CURRENCIES[code];
    if (derived) return byKey.get(`${derived.of}|${day}`)?.div(derived.divisor) ?? null;
    return byKey.get(`${code}|${day}`) ?? null;
  };
}

/** The root currencies `codes` are read through: the pivot needs no row, a derived one its root's. */
export function rootsOf(codes: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const code of codes) {
    const root = DERIVED_CURRENCIES[code]?.of ?? code;
    if (root !== FX_PIVOT_CURRENCY) roots.add(root);
  }
  return [...roots].sort();
}

/**
 * The currency in force at each day's end: the currency the first change after
 * that day left, else `operating`. `changes` in the order they were made — two
 * on one day leave the day in the second one's money.
 */
export function currencyOnDay(operating: string, changes: readonly CurrencyChangeDay[]): CurrencyOn {
  return (day) => changes.find((c) => c.day > day)?.fromCode ?? operating;
}

/**
 * The currency the tenant in scope sold in at `instant` (F-1001-r): the one
 * the first change after it left, else its operating currency now. For a cost
 * that has an instant of its own; a whole day's cost takes `currencyOnDay`.
 */
export const currencyAt = (instant: Prisma.Sql) => Prisma.sql`COALESCE(
  (SELECT c."fromCode" FROM billing.currency_change c
   WHERE c."tenantId" = public.current_tenant_id() AND c."createdAt" > ${instant} ORDER BY c."createdAt" LIMIT 1),
  (SELECT t."operatingCurrencyCode" FROM tenant.tenant t WHERE t."id" = public.current_tenant_id()))`;

/** A tenant's currency changes in the order made, each on its day in `zone` (the tenant in scope; RLS). */
export function readCurrencyChanges(tx: Prisma.TransactionClient, zone: string): Promise<CurrencyChangeDay[]> {
  return tx.$queryRaw<CurrencyChangeDay[]>`
    SELECT to_char(${dayIn(Prisma.sql`c."createdAt"`, zone)}, 'YYYY-MM-DD') AS "day", c."fromCode"
    FROM billing.currency_change c
    WHERE c."tenantId" = public.current_tenant_id()
    ORDER BY c."createdAt"`;
}

/** The currency a cost row is answered in: its sale's when it has one, else the one in force at its day's end. */
export const saleCurrencyOf = (row: CostDayRow, toOn: CurrencyOn): string => row.soldIn ?? toOn(row.day);

/** Each row converted into its sale's or its day's currency (`saleCurrencyOf`) at its day's rate, through the pivot. */
export function convertCosts(rows: readonly CostDayRow[], toOn: CurrencyOn, rateOf: RateOf): ConvertedCost[] {
  return rows.map((row) => {
    const to = saleCurrencyOf(row, toOn);
    if (row.currencyCode === to) return { ...row, saleCurrencyCode: to, saleCost: row.cost };
    const from = rateOf(row.currencyCode, row.day);
    const into = rateOf(to, row.day);
    const saleCost = from && into ? row.cost.mul(into).div(from).toDecimalPlaces(COST_PLACES) : null;
    return { ...row, saleCurrencyCode: to, saleCost };
  });
}

/**
 * Each root's rate in force at the end of each day, read as `readFxRate` reads
 * today's (shared-core `fx-rate.ts`): a pin live then — not yet expired, not
 * yet ended, the tenant's own before the platform's — over the newest
 * discovered rate. A day with neither has no row. Read in the rollup's tenant
 * scope, which is what lets RLS show that tenant's pins and no other's.
 */
export function readRates(tx: Prisma.TransactionClient, codes: readonly string[], days: readonly Day[]): Promise<RateRow[]> {
  const roots = rootsOf(codes);
  if (roots.length === 0 || days.length === 0) return Promise.resolve([]);
  return tx.$queryRaw<RateRow[]>`
    SELECT c."code", to_char(d."day", 'YYYY-MM-DD') AS "day", r."rate"
    FROM currency.currency c
    CROSS JOIN unnest(${[...days]}::date[]) AS d("day")
    CROSS JOIN LATERAL (
      SELECT x."rate" FROM currency.currency_exchange_rate x
      LEFT JOIN currency.currency_rate_pin_end e ON e."rateId" = x."id"
      WHERE x."currencyId" = c."id" AND x."isActive" AND x."rate" > 0 AND x."effectiveAt" < d."day" + 1
        AND (x."tenantId" IS NULL OR x."tenantId" = public.current_tenant_id())
        AND (x."source" = 'external_api'
             OR (x."expiresAt" IS NULL OR x."expiresAt" >= d."day" + 1) AND (e."endedAt" IS NULL OR e."endedAt" >= d."day" + 1))
      ORDER BY (x."source" = 'manual_admin') DESC, (x."tenantId" IS NULL), x."effectiveAt" DESC
      LIMIT 1
    ) r
    WHERE c."code" = ANY(${roots})`;
}
