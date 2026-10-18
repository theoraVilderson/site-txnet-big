import { Prisma } from '@prisma/client';
import { roundCharge } from '@txnet-backend/shared-core';

export type InvoiceShortfall = {
  total: Prisma.Decimal;
  balance: Prisma.Decimal;
  /**
   * `total - balance` rounded **up** to the invoice currency's minor unit (spec §5.9, ADR-0153): the least amount a
   * top-up accepts that covers the invoice. A top-up credits `amount + gap`
   * with fee and tax on top (`priceAtGateway`), so a top-up of exactly this
   * always pays it; half-up would leave a sub-cent balance short.
   */
  missing: Prisma.Decimal;
};

/**
 * What an `insufficient_balance` refusal carries (F-111-c). Only for a balance
 * short of `total`; `places` is the invoice currency's `decimalPlaces`.
 */
export function invoiceShortfall(total: Prisma.Decimal, balance: Prisma.Decimal, places: number): InvoiceShortfall {
  if (balance.gte(total)) throw new RangeError(`balance ${balance.toFixed()} covers ${total.toFixed()}`);
  const missing = roundCharge(total.minus(balance), places);
  return { total, balance, missing };
}
