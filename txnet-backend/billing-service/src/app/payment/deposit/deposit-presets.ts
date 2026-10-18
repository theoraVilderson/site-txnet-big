import { Prisma } from '@prisma/client';
import { moneyText, MONEY_PATTERN } from '@txnet-backend/shared-core';

/**
 * Quick amounts on the top-up page (F-092-v): the tenant's default list
 * (`billing.deposit_setting`) and a gateway's own override (`depositPresets`).
 * Every write goes through {@link normalizePresets} and every read through
 * {@link resolvePresets}, so the two lists cannot come to mean different things.
 */

export const MAX_DEPOSIT_PRESETS = 8;


export class InvalidDepositPresets extends Error {
  constructor(detail: string) {
    super(`invalid deposit presets: ${detail}`);
    this.name = 'InvalidDepositPresets';
  }
}

/** A list as it is stored: positive, no repeats, ascending — its currency's places checked where it is saved (F-116-r). Empty means "inherit". */
export function normalizePresets(values: readonly string[]): string[] {
  const amounts = values.map((v) => {
    const trimmed = v.trim();
    if (!MONEY_PATTERN.test(trimmed)) throw new InvalidDepositPresets(`"${trimmed}" is not an amount`);
    const amount = new Prisma.Decimal(trimmed);
    if (amount.lte(0)) throw new InvalidDepositPresets('an amount must be positive');
    return amount;
  });
  const unique = [...new Map(amounts.map((a) => [moneyText(a), a])).values()].sort((a, b) => a.comparedTo(b));
  if (unique.length > MAX_DEPOSIT_PRESETS) {
    throw new InvalidDepositPresets(`at most ${MAX_DEPOSIT_PRESETS} amounts`);
  }
  return unique.map((a) => moneyText(a));
}

/**
 * Each automatic quick amount as a multiple of the gateway's minimum (moved
 * from the panel, 2026-10-15): a ladder from the range the gateway already
 * publishes beats a constant that is nobody's pricing.
 */
const LADDER_STEPS = [1, 2, 5, 10, 20, 50];

/**
 * The quick amounts for a gateway nobody gave a list (F-092-v): its minimum
 * times {@link LADDER_STEPS} inside its range, one slot held back for its
 * maximum — the amount a payer most often wants and least often types right.
 * A gateway with no floor starts at one unit; an empty range offers nothing.
 */
export function automaticPresets(range: { min: Prisma.Decimal | null; max: Prisma.Decimal | null }): string[] {
  const { min, max } = range;
  if (max !== null && (max.lte(0) || (min !== null && min.gt(max)))) return [];
  const base = min !== null && min.gt(0) ? min : new Prisma.Decimal(1);
  const steps = LADDER_STEPS.map((step) => base.mul(step));
  if (max === null) return steps.map((a) => moneyText(a));
  const ladder = steps.filter((a) => a.lte(max)).slice(0, LADDER_STEPS.length - 1);
  return [...new Map([...ladder, max].map((a) => [moneyText(a), a])).values()].sort((a, b) => a.comparedTo(b)).map((a) => moneyText(a));
}

/**
 * What one gateway offers: its own list when it has one, otherwise the
 * tenant's, keeping only amounts the gateway accepts — else the automatic
 * ladder ({@link automaticPresets}), so the panel and the bot show the same.
 */
export function resolvePresets(
  gateway: readonly Prisma.Decimal[] | null | undefined,
  tenantDefault: readonly Prisma.Decimal[] | null | undefined,
  /** A bound left `null` is no limit on that side. */
  range: { min: Prisma.Decimal | null; max: Prisma.Decimal | null },
): string[] {
  const list = gateway && gateway.length > 0 ? gateway : (tenantDefault ?? []);
  const fits = list
    .filter((a) => (range.min == null || a.gte(range.min)) && (range.max == null || a.lte(range.max)))
    .map((a) => moneyText(new Prisma.Decimal(a)));
  // Nothing configured that fits: the ladder, so every surface offers the same buttons (2026-10-15).
  return fits.length > 0 ? fits : automaticPresets(range);
}
