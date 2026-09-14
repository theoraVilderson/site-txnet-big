import { Prisma } from '@prisma/client';

/**
 * Quick amounts on the top-up page (F-092-v): the tenant's default list
 * (`billing.deposit_setting`) and a gateway's own override (`depositPresets`).
 * Every write goes through {@link normalizePresets} and every read through
 * {@link resolvePresets}, so the two lists cannot come to mean different things.
 */

export const MAX_DEPOSIT_PRESETS = 8;

/** Base currency, two places (ADR-0019), as the top-up amount itself takes it. */
const AMOUNT = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

export class InvalidDepositPresets extends Error {
  constructor(detail: string) {
    super(`invalid deposit presets: ${detail}`);
    this.name = 'InvalidDepositPresets';
  }
}

/** A list as it is stored: positive, two decimals, no repeats, ascending. Empty means "inherit". */
export function normalizePresets(values: readonly string[]): string[] {
  const amounts = values.map((v) => {
    const trimmed = v.trim();
    if (!AMOUNT.test(trimmed)) throw new InvalidDepositPresets(`"${trimmed}" is not an amount`);
    const amount = new Prisma.Decimal(trimmed);
    if (amount.lte(0)) throw new InvalidDepositPresets('an amount must be positive');
    return amount;
  });
  const unique = [...new Map(amounts.map((a) => [a.toFixed(2), a])).values()].sort((a, b) => a.comparedTo(b));
  if (unique.length > MAX_DEPOSIT_PRESETS) {
    throw new InvalidDepositPresets(`at most ${MAX_DEPOSIT_PRESETS} amounts`);
  }
  return unique.map((a) => a.toFixed(2));
}

/**
 * What one gateway offers: its own list when it has one, otherwise the
 * tenant's, keeping only amounts the gateway accepts. Empty tells the panel to
 * draw its automatic ladder.
 */
export function resolvePresets(
  gateway: readonly Prisma.Decimal[] | null | undefined,
  tenantDefault: readonly Prisma.Decimal[] | null | undefined,
  /** A bound left `null` is no limit on that side. */
  range: { min: Prisma.Decimal | null; max: Prisma.Decimal | null },
): string[] {
  const list = gateway && gateway.length > 0 ? gateway : (tenantDefault ?? []);
  return list
    .filter((a) => (range.min == null || a.gte(range.min)) && (range.max == null || a.lte(range.max)))
    .map((a) => new Prisma.Decimal(a).toFixed(2));
}
