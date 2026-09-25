import { Prisma } from '@prisma/client';

/** A top-up amount has at most this many decimal places (`deposit.schema.ts`, `priceAtGateway`). */
const TOP_UP_SCALE = 2;

export type InvoiceShortfall = {
  total: Prisma.Decimal;
  balance: Prisma.Decimal;
  /**
   * `total - balance` rounded **up** to the cent (spec §5.9): the least amount a
   * top-up accepts that covers the invoice. A top-up credits `amount + gap`
   * with fee and tax on top (`priceAtGateway`), so a top-up of exactly this
   * always pays it; half-up would leave a sub-cent balance short.
   */
  missing: Prisma.Decimal;
};

/** What an `insufficient_balance` refusal carries (F-111-c). Only for a balance short of `total`. */
export function invoiceShortfall(total: Prisma.Decimal, balance: Prisma.Decimal): InvoiceShortfall {
  if (balance.gte(total)) throw new RangeError(`balance ${balance.toFixed()} covers ${total.toFixed()}`);
  const missing = total.minus(balance).toDecimalPlaces(TOP_UP_SCALE, Prisma.Decimal.ROUND_UP);
  return { total, balance, missing };
}
