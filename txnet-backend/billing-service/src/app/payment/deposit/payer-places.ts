import { Prisma } from '@prisma/client';
import { currencyPlacesOf, fitsPlaces } from '@txnet-backend/shared-core';

/** A payer's amount finer than its currency's minor unit (a rial top-up of 1000.5): the payer's to fix (400), not a bug. */
export class AmountFinerThanCurrency extends Error {
  constructor(
    readonly amount: Prisma.Decimal,
    readonly places: number,
  ) {
    super(`amount ${amount.toFixed()} has more than ${places} decimal places`);
    this.name = 'AmountFinerThanCurrency';
  }
}

/**
 * The payer currency's places, read before anything prices `amount` — and the
 * refusal of an amount finer than them, before a coupon's check or the
 * calculator's would turn the payer's typo into a 500 (F-116-r). The schema
 * takes any amount a column holds; only the currency knows its unit.
 */
export async function payerPlaces(tx: Pick<Prisma.TransactionClient, 'currency'>, currencyCode: string, amount: Prisma.Decimal): Promise<number> {
  const places = await currencyPlacesOf(tx, currencyCode);
  if (!fitsPlaces(amount, places)) throw new AmountFinerThanCurrency(amount, places);
  return places;
}
