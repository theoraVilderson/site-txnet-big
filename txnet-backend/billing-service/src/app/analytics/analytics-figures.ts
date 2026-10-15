import { Prisma } from '@prisma/client';

import { FEWER_THAN, hiddenCells } from '../revenue/revenue-breakdown';

/**
 * The shapes every analytics tab answers in (billing/contract.analytics.md
 * "Read routes"). Money is a decimal string per currency (principles 6, 7) —
 * `{ "USD": "41.25" }` — and never one sum across two; counts are ints.
 */
export type Amounts = Record<string, string>;

/** A change against the previous window: a ratio, `new` when it was zero, `null` with nothing to compare. */
export type Delta = number | 'new' | null;

export type CountKpi = { value: number; previous: number | null; delta: Delta };
export type MoneyKpi = { value: Amounts; previous: Amounts | null; delta: Record<string, Delta> };

/** Sums per currency. */
export type ByCurrency = Map<string, Prisma.Decimal>;

/** What a hidden cell says instead of its figures (ADR-0104 (3)). */
export { FEWER_THAN };

const ZERO = new Prisma.Decimal(0);
/** A delta is reported to four places: a percentage with two decimals. */
const DELTA_PLACES = 4;

export function deltaOf(value: Prisma.Decimal.Value, previous: Prisma.Decimal.Value | null): Delta {
  if (previous === null) return null;
  const v = new Prisma.Decimal(value);
  const p = new Prisma.Decimal(previous);
  if (p.isZero()) return v.isZero() ? 0 : 'new';
  return v.minus(p).div(p.abs()).toDecimalPlaces(DELTA_PLACES).toNumber();
}

export function countKpi(value: number, previous: number | null): CountKpi {
  return { value, previous, delta: deltaOf(value, previous) };
}

/** Rows summed into one figure per currency. */
export function byCurrency<R extends { currencyCode: string }>(rows: readonly R[], amountOf: (row: R) => Prisma.Decimal.Value): ByCurrency {
  const out: ByCurrency = new Map();
  for (const row of rows) out.set(row.currencyCode, (out.get(row.currencyCode) ?? ZERO).plus(amountOf(row)));
  return out;
}

/** A per-currency figure as answered: every currency of the answer, a missing one at zero. */
export function amountsOf(sums: ByCurrency, currencies: readonly string[]): Amounts {
  return Object.fromEntries(currencies.map((c) => [c, (sums.get(c) ?? ZERO).toFixed(2)]));
}

export function moneyKpi(value: ByCurrency, previous: ByCurrency | null, currencies: readonly string[]): MoneyKpi {
  return {
    value: amountsOf(value, currencies),
    previous: previous ? amountsOf(previous, currencies) : null,
    delta: Object.fromEntries(currencies.map((c) => [c, previous ? deltaOf(value.get(c) ?? ZERO, previous.get(c) ?? ZERO) : null])),
  };
}

/** `sums` divided by `by` per currency (an average order, revenue per buyer); nothing where `by` is 0. */
export function perUnit(sums: ByCurrency, by: number): ByCurrency {
  return new Map(by > 0 ? [...sums].map(([c, v]) => [c, v.div(by).toDecimalPlaces(2)]) : []);
}

/** Every currency the figures hold, the tenant's operating currency first (principle 6). */
export function currenciesOf(operating: string, ...sets: readonly Iterable<string>[]): string[] {
  const all = new Set<string>();
  for (const set of sets) for (const c of set) all.add(c);
  all.delete(operating);
  return [operating, ...[...all].sort()];
}

/**
 * ADR-0104 (3), as `/revenue/breakdown` holds it: for the platform's staff
 * reading a reseller, which cells of one split are hidden — each under 5
 * people, and the smallest others it would otherwise be the difference of.
 * Answers the hidden keys; with `hides` false, none.
 */
export function hiddenKeys<K>(cells: readonly { key: K; people: number; count: number; currencies: ReadonlySet<string> }[], hides: boolean): Set<K> {
  if (!hides) return new Set();
  const hidden = hiddenCells(cells, (cell) => cell.currencies);
  return new Set(cells.filter((cell) => hidden.has(cell)).map((cell) => cell.key));
}
