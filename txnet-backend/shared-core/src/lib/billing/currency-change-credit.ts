import { Prisma } from '@prisma/client';

/**
 * `amount` in `fromCode`, in `toCode` through the tenant's recorded changes —
 * or `null` when no chain of them leads there. Walked newest first from the
 * currency the money is in now back to the one it was priced in, so money
 * priced before a change and landing after it (an in-flight payment, a refund
 * of an older invoice) is converted at the rate(s) the wallet itself was.
 * Rounded once, to `toCode`'s decimals — and a positive amount never to
 * nothing: one that converts to less than a minor unit (1,000 IRR into a USD
 * wallet) is one minor unit. Rounded to zero, the ledger refused it and the
 * payment's settlement retried it forever; the unit is at most a cent more.
 */
export async function convertedByChanges(
  tx: Prisma.TransactionClient,
  tenantId: string,
  amount: Prisma.Decimal,
  fromCode: string,
  toCode: string,
): Promise<Prisma.Decimal | null> {
  const changes = await tx.currencyChange.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { fromCode: true, toCode: true, rate: true } });
  let code = toCode;
  let factor = new Prisma.Decimal(1);
  for (const change of changes) {
    if (change.toCode !== code) continue;
    factor = factor.mul(change.rate);
    code = change.fromCode;
    if (code === fromCode) {
      const target = await tx.currency.findUnique({ where: { code: toCode }, select: { decimalPlaces: true } });
      if (!target) return null;
      const converted = amount.mul(factor).toDecimalPlaces(target.decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
      return converted.isZero() && amount.gt(0) ? new Prisma.Decimal(10).pow(-target.decimalPlaces) : converted;
    }
  }
  return null;
}
