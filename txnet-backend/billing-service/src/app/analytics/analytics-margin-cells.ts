import { Prisma } from '@prisma/client';

import { Amounts, amountsOf, byCurrency } from './analytics-figures';

/**
 * Margin arithmetic (F-1001-l), pure so the spec holds it: net − cost per
 * currency, never across two (principle 6). A cost no rate converted stays in
 * its own currency, so it shows beside the sale rather than vanishing.
 */

/** A sum for one row of a split (a product, a panel, a user, a reseller; null = none) in one currency. */
export type MoneyRow = { key: string | null; currencyCode: string; amount: Prisma.Decimal };

export type MarginCell = {
  id: string | null;
  net: Amounts;
  cost: Amounts;
  margin: Amounts;
  /** Margin ÷ net in the operating currency, to four places; null where nothing was sold in it. */
  marginRate: number | null;
  /** The operating currency's margin is below zero. */
  loss: boolean;
  /** It sold and no cost row names it: its margin is not a margin (ADR-0151 (5)) — a cost of 0 is a cost. */
  noCost: boolean;
};

const ZERO = new Prisma.Decimal(0);
/** A rate is answered as a ratio to four places, as a delta is. */
const RATE_PLACES = 4;

/** One cell's figures from its own net and cost rows. */
export function marginCellOf(id: string | null, net: readonly MoneyRow[], cost: readonly MoneyRow[], how: { currencies: readonly string[]; operating: string }): MarginCell {
  const n = byCurrency(net, (r) => r.amount);
  const k = byCurrency(cost, (r) => r.amount);
  const m = new Map(how.currencies.map((c) => [c, (n.get(c) ?? ZERO).minus(k.get(c) ?? ZERO)]));
  const sold = n.get(how.operating) ?? ZERO;
  const own = m.get(how.operating) ?? ZERO;
  return {
    id,
    net: amountsOf(n, how.currencies),
    cost: amountsOf(k, how.currencies),
    margin: amountsOf(m, how.currencies),
    marginRate: sold.isZero() ? null : own.div(sold).toDecimalPlaces(RATE_PLACES).toNumber(),
    loss: own.lt(ZERO),
    noCost: net.length > 0 && cost.length === 0,
  };
}

/** Every key with a net or a cost, largest net first in the operating currency, then the deepest loss. */
export function marginCellsOf(net: readonly MoneyRow[], cost: readonly MoneyRow[], how: { currencies: readonly string[]; operating: string }): MarginCell[] {
  const keys = [...new Set([...net.map((r) => r.key), ...cost.map((r) => r.key)])];
  const cells = keys.map((key) => marginCellOf(key, net.filter((r) => r.key === key), cost.filter((r) => r.key === key), how));
  const of = (cell: MarginCell, field: 'net' | 'margin') => new Prisma.Decimal(cell[field][how.operating] ?? 0);
  return cells.sort((a, b) => of(b, 'net').comparedTo(of(a, 'net')) || of(a, 'margin').comparedTo(of(b, 'margin')) || String(a.id).localeCompare(String(b.id)));
}
