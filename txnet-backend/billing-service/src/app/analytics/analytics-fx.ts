import { Prisma } from '@prisma/client';
import { DERIVED_CURRENCIES, FX_PIVOT_CURRENCY, roundRate } from '@txnet-backend/shared-core';

import type { CostDayRow } from './analytics-cost';
import type { Day } from './analytics-days';

/**
 * Analytics in the tenant's currency now (ADR-0152): every money figure is
 * converted at **its own day's** rate before it is summed, so a page reads one
 * currency, a currency change (F-116) never splits it in two, and a rate moving
 * today never rewrites last month. An amount no rate converts keeps its own
 * currency and is shown apart — never summed in (ADR-0152 (5)).
 */

/** A cost is kept to six places, as the attribution writes it. */
const COST_PLACES = 6;

/** Units of a root currency per one USD on a day, as `currency_exchange_rate` quotes it. */
export type RateRow = { code: string; day: Day; rate: Prisma.Decimal };

/** One currency's rate on one day; `null` when none is on record. */
export type RateOf = (code: string, day: Day) => Prisma.Decimal | null;

/** A cost row and what it is in the tenant's operating currency; `saleCost` null when no rate converts it. */
export type ConvertedCost = CostDayRow & { saleCurrencyCode: string; saleCost: Prisma.Decimal | null };

/**
 * Each currency other than `to`, on each day, with the factor that takes it
 * into `to` — as three parallel arrays, the shape `unnest` reads. A day no
 * rate covers is left out, and an amount on it keeps its own currency.
 */
export type FxTable = { to: string; codes: string[]; days: Day[]; factors: string[] };

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

/** What multiplies an amount in `from` on `day` into `to`, through the pivot: 1 for the same currency, `null` with no rate for either. */
export function factorOf(rateOf: RateOf, from: string, to: string, day: Day): Prisma.Decimal | null {
  if (from === to) return new Prisma.Decimal(1);
  const a = rateOf(from, day);
  const b = rateOf(to, day);
  return a && b ? b.div(a) : null;
}

/** Each row converted into `to` at its day's rate, kept to six places; `saleCost` null where no rate converts it. */
export function convertCosts(rows: readonly CostDayRow[], to: string, rateOf: RateOf): ConvertedCost[] {
  return rows.map((row) => {
    const factor = factorOf(rateOf, row.currencyCode, to, row.day);
    return { ...row, saleCurrencyCode: to, saleCost: factor ? roundRate(row.cost.mul(factor), COST_PLACES) : null };
  });
}

/** The factors for every currency of `codes` but `to`, on every day of `days` a rate covers. */
export function fxTableOf(to: string, codes: Iterable<string>, days: readonly Day[], rateOf: RateOf): FxTable {
  const table: FxTable = { to, codes: [], days: [], factors: [] };
  for (const code of [...new Set(codes)].filter((c) => c !== to).sort()) {
    for (const day of days) {
      const factor = factorOf(rateOf, code, to, day);
      if (!factor) continue;
      table.codes.push(code);
      table.days.push(day);
      table.factors.push(factor.toString());
    }
  }
  return table;
}

/** `fxTableOf` with the rates read for those currencies and days, in the tenant scope `tx` holds (its pins). */
export async function readFx(tx: Prisma.TransactionClient, to: string, codes: Iterable<string>, days: readonly Day[]): Promise<FxTable> {
  const foreign = [...new Set(codes)].filter((c) => c !== to);
  if (foreign.length === 0 || days.length === 0) return { to, codes: [], days: [], factors: [] };
  return fxTableOf(to, foreign, days, rateLookup(await readRates(tx, [to, ...foreign], days)));
}

/**
 * The factor table joined to a row by its currency and its day, as `f`:
 * `f."factor"` is null for the same currency and where no rate converts it.
 */
export function fxJoin(fx: FxTable, f: Prisma.Sql, code: Prisma.Sql, day: Prisma.Sql): Prisma.Sql {
  // An empty array has no element type to cast from: no factor at all is a table with no rows.
  const rows = fx.codes.length
    ? Prisma.sql`unnest(${fx.codes}::text[], ${fx.days}::date[], ${fx.factors}::numeric[])`
    : Prisma.sql`(SELECT NULL::text, NULL::date, NULL::numeric WHERE false)`;
  return Prisma.sql`LEFT JOIN ${rows} AS ${f}("code", "day", "factor") ON ${f}."code" = ${code} AND ${f}."day" = ${day}`;
}

/** `amount` in `fx.to` where `fxJoin`'s factor converts it, else as it is — unrounded: a sum rounds once. */
export const fxAmount = (amount: Prisma.Sql, f: Prisma.Sql) => Prisma.sql`(${amount} * COALESCE(${f}."factor", 1))`;

/** The currency `fxAmount` is in: `fx.to` where converted, else the row's own (already `fx.to`, or no rate). */
export const fxCurrency = (fx: FxTable, code: Prisma.Sql, f: Prisma.Sql) => Prisma.sql`(CASE WHEN ${f}."factor" IS NOT NULL THEN ${fx.to} ELSE ${code} END)`;

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
