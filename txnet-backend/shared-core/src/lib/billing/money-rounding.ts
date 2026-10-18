import { Prisma } from '@prisma/client';

/**
 * Money is rounded here and nowhere else (ADR-0153, C-02; `conventions.py`
 * refuses `toDecimalPlaces` and a rounding mode outside this file).
 *
 * An amount is computed whole and rounded once, at the write, to its row
 * currency's `currency.decimalPlaces` — the places are always the caller's,
 * read from the registry (`currencyPlacesOf`), never a literal 2: a rial has
 * none, a dinar three. The function names the intent, and the intent sets the
 * direction, so the error stays with whoever can bear it (point 2):
 *
 * - `roundCharge` — what the payer is asked, or the least they must reach: up;
 * - `roundCredit` — what is given (a wallet credit from what arrived, a
 *   discount, a coupon's cap): down — what did not arrive is not given;
 * - `roundHold` — a hold and what a cap has counted: down;
 * - `roundConverted` — a price, a converted balance or setting: half up, and a
 *   positive amount never to nothing (point 3);
 * - `splitWhole` — parts that sum to their whole (point 4).
 *
 * Each returns an instance of the decimal it is given, so a caller's
 * high-precision clone (`gateway-pricing.ts`) keeps every digit until here.
 */

type Dec = Prisma.Decimal;

/**
 * The scale of every money column, `DECIMAL(20,4)` (ADR-0153 point 6): the most
 * places a registered currency may have (CHECK `currency_decimal_places_fit_money`)
 * and the most an amount may arrive or leave with.
 */
export const MONEY_MAX_PLACES = 4;
/** `DECIMAL(20,4)` leaves 16 whole digits. */
const MONEY_WHOLE_DIGITS = 16;

/**
 * An amount as a request carries it: a decimal string the columns can hold,
 * no sign, no leading zero, at most four places. The edge cannot know the
 * currency; the service that does refuses one finer than it (`fitsPlaces`).
 */
export const MONEY_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MONEY_WHOLE_DIGITS - 1}})(\\.\\d{1,${MONEY_MAX_PLACES}})?$`);

/** Whether `amount` has no more places than its currency's `places` — a rial takes no fraction, a dinar three. */
export function fitsPlaces(amount: Dec, places: number): boolean {
  checkPlaces(places);
  return amount.decimalPlaces() <= places;
}

/**
 * The first of `amounts` finer than its currency's `places`, by its field name —
 * so a service refuses a price, a cap or a bound at its write, with its own
 * refusal, instead of a ledger refusing a payment later. Null when all fit.
 */
export function finerThanPlaces(amounts: Record<string, Dec | readonly Dec[] | null | undefined>, places: number): string | null {
  for (const [field, value] of Object.entries(amounts)) {
    const all = value == null ? [] : Array.isArray(value) ? value : [value as Dec];
    if (all.some((v) => !fitsPlaces(v, places))) return field;
  }
  return null;
}

/** What the API has always sent for an amount: two places, kept for every consumer of a currency of two or fewer. */
const WIRE_MIN_PLACES = 2;
/** A ratio — a percentage, a share — is told to two places: 12.50. */
const RATIO_PLACES = 2;

function checkPlaces(places: number): void {
  if (!Number.isInteger(places) || places < 0) throw new RangeError(`places must be a non-negative integer, got ${places}`);
}

function at(amount: Dec, places: number, mode: Prisma.Decimal.Rounding): Dec {
  checkPlaces(places);
  return amount.toDecimalPlaces(places, mode);
}

/** One minor unit of a currency with `places` decimals: 0.01 at 2, 1 at 0. */
export function minorUnit(places: number): Dec {
  checkPlaces(places);
  return new Prisma.Decimal(10).pow(-places);
}

/** What the payer is asked, or the least they must reach: rounded up, so the platform is never short. */
export function roundCharge(amount: Dec, places: number): Dec {
  return at(amount, places, Prisma.Decimal.ROUND_UP);
}

/** What is given — credited from what arrived, a discount, a cap: rounded down. May be zero. */
export function roundCredit(amount: Dec, places: number): Dec {
  return at(amount, places, Prisma.Decimal.ROUND_DOWN);
}

/** A hold, and what a cap has counted: down, so free balance never goes negative and an owner's room never shrinks. */
export function roundHold(amount: Dec, places: number): Dec {
  return at(amount, places, Prisma.Decimal.ROUND_DOWN);
}

/**
 * A price, a converted balance or setting: half up. A positive amount is never
 * rounded to nothing — it is one minor unit, the platform carrying at most
 * half a unit (ADR-0153 point 3).
 */
export function roundConverted(amount: Dec, places: number): Dec {
  const rounded = at(amount, places, Prisma.Decimal.ROUND_HALF_UP);
  return rounded.isZero() && amount.gt(0) ? amount.mul(0).plus(minorUnit(places)) : rounded;
}

/**
 * `whole` split by `weights`: each part rounded down, the remainder on the
 * largest weight (the first, on a tie), so the parts sum to `whole` exactly.
 * `whole` is already at `places` — rounding it is its own intent.
 */
export function splitWhole(whole: Dec, weights: readonly bigint[], places: number): Dec[] {
  checkPlaces(places);
  if (whole.decimalPlaces() > places) throw new RangeError(`whole ${whole.toFixed()} is not at ${places} places`);
  const total = weights.reduce((a, b) => a + b, BigInt(0));
  if (total <= BigInt(0)) throw new RangeError('weights must sum to more than zero');
  const parts = weights.map((w) => at(whole.mul(w.toString()).div(total.toString()), places, Prisma.Decimal.ROUND_DOWN));
  const largest = weights.reduce((best, w, i) => (w > weights[best] ? i : best), 0);
  parts[largest] = parts[largest].plus(whole.minus(parts.reduce((a, b) => a.plus(b), whole.mul(0))));
  return parts;
}

/** An amount at `places` as an integer of minor units; refuses one that is not rounded to them yet. */
export function toMinorUnits(amount: Dec, places: number): bigint {
  checkPlaces(places);
  if (amount.decimalPlaces() > places) throw new RangeError(`amount ${amount.toFixed()} is not at ${places} places`);
  return BigInt(amount.mul(new Prisma.Decimal(10).pow(places)).toFixed(0));
}

/** Minor units as an amount: 1234 at 2 places is 12.34. */
export function fromMinorUnits(minor: bigint, places: number): Dec {
  checkPlaces(places);
  return new Prisma.Decimal(minor.toString()).div(new Prisma.Decimal(10).pow(places));
}

/** A rate or a unit price at its column's scale, half up: precision lives in rates, not balances (point 5). */
export function roundRate(rate: Dec, scale: number): Dec {
  return at(rate, scale, Prisma.Decimal.ROUND_HALF_UP);
}

/** A rate snapped to a gateway's `roundingStep`: up to the next step, or to the nearest. */
export function roundRateToStep(rate: Dec, step: Dec, direction: 'up' | 'nearest'): Dec {
  if (step.lte(0)) throw new RangeError('a rounding step must be positive');
  const mode = direction === 'up' ? Prisma.Decimal.ROUND_CEIL : Prisma.Decimal.ROUND_HALF_UP;
  return rate.div(step).toDecimalPlaces(0, mode).mul(step);
}

/** A ratio shown — a percentage, a share — half up. Not money: nothing is paid in it. */
export function roundRatio(ratio: Dec, places: number): Dec {
  return at(ratio, places, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * An amount as the API sends it: every place it holds and never fewer than two,
 * so `12.50` and `1000.00` read as they always did and a dinar's `1.234` keeps
 * its third place (F-116-r). A stored amount is already at its currency's
 * places; a computed one is rounded there first, by its intent. Past the
 * columns' scale it is rounded half up, as a column would store it.
 */
export function moneyText(amount: Dec): string {
  return amount.toFixed(Math.min(Math.max(amount.decimalPlaces(), WIRE_MIN_PLACES), MONEY_MAX_PLACES), Prisma.Decimal.ROUND_HALF_UP);
}

/** A converted figure as text at exactly its currency's `places` — `7500000` in rials, `12.50` in dollars: rounded half up there once. */
export function convertedText(amount: Dec, places: number): string {
  return roundConverted(amount, places).toFixed(places);
}

/** A ratio held as a JS number — a share of a period, a factor — to two places, half up, as a number. */
export function roundShare(ratio: number): number {
  return roundRatio(new Prisma.Decimal(ratio), RATIO_PLACES).toNumber();
}

/** A ratio — a percentage, a share — as text, to two places, half up. */
export function percentText(ratio: Dec): string {
  return roundRatio(ratio, RATIO_PLACES).toFixed(RATIO_PLACES);
}
