/**
 * The amount box's arithmetic (F-093-e), and the only arithmetic on this page.
 *
 * It is deliberately not about money: nothing here prices anything, applies a
 * discount or works out what is payable — that whole breakdown is
 * `POST /deposit/quote`'s answer and the panel derives none of it (F-0612,
 * `billing/contract.deposit.md`). What is left is the input control itself: a
 * slider and a set of preset buttons need a *number* to work with, and the
 * wire wants an exact decimal string in the base currency (ADR-0019, C-02).
 *
 * So the number is **integer cents**. A slider that emits a float is how
 * `0.1 + 0.2` reaches a payment route as `0.30000000000000004`; a `Number`
 * holds every cent exactly up to about 90 trillion base-currency units, which
 * is well past `Decimal(18, 2)`.
 */

/** Two decimal places, because the base currency has two (ADR-0019). */
const DECIMALS = 2;
const SCALE = 100;

/** The wire format: an unsigned decimal with at most two places, as `deposit.schema.ts` takes it. */
const AMOUNT = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

/**
 * A decimal string as whole cents, or `null` when it is not an amount this
 * currency can hold. `null` rather than `NaN`: a caller has to decide what an
 * unreadable box means, and `NaN` silently becomes a zero on the way to a
 * comparison.
 */
export function toCents(amount: string): number | null {
  const trimmed = amount.trim();
  if (!AMOUNT.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * SCALE + Number(fraction.padEnd(DECIMALS, "0"));
}

/** Whole cents back as the decimal string the API takes. */
export function fromCents(cents: number): string {
  const whole = Math.trunc(cents / SCALE);
  const fraction = Math.abs(cents % SCALE);
  return `${whole}.${String(fraction).padStart(DECIMALS, "0")}`;
}

/**
 * How much each preset is worth relative to the gateway's own minimum. Legacy
 * hard-coded six rial figures in `_util/constants.ts` — which is a tenant's
 * pricing decision written into the app, and wrong for every tenant that is
 * not the one it was written for.
 */
const STEPS = [1, 2, 5, 10, 20, 50];

/**
 * The preset buttons for one gateway, as decimal strings.
 *
 * **The gateway's range is the configuration.** `minAmount` / `maxAmount` are
 * the tenant's own `tenant_gateway_config` columns, answered by
 * `GET /deposit/gateways`, so the presets move when the tenant moves them and
 * there is no second place to keep them in step. A row of its own can give a
 * tenant an explicit list later; until one exists, deriving the ladder from
 * the range the gateway already publishes beats a constant that is nobody's.
 *
 * The maximum is always offered last when it fits, because "everything this
 * gateway will take" is the one amount a user is most likely to want and the
 * least likely to type correctly. An unreadable or empty range offers nothing.
 */
export function presetAmounts(minAmount: string, maxAmount: string): string[] {
  const min = toCents(minAmount);
  const max = toCents(maxAmount);
  if (min === null || max === null || max <= 0 || min > max) return [];

  // A gateway with no floor of its own still needs somewhere to start the
  // ladder; one base-currency unit is the smallest step worth a button.
  const base = min > 0 ? min : SCALE;
  // One slot is held back for the maximum, so a long ladder cannot crowd it out.
  const ladder = STEPS.map((step) => base * step)
    .filter((c) => c > 0 && c <= max)
    .slice(0, STEPS.length - 1);
  const presets = [...new Set([...ladder, max])].sort((a, b) => a - b);
  return presets.map(fromCents);
}

/**
 * The gateway's own charge, as a decimal string in the gateway's own currency.
 *
 * `charge.amountMinor` is a string because JSON has no bigint, and it can be
 * large — a rial figure is six digits before it is interesting — so the split
 * is done on the digits and never through a `Number`. This is a *display*
 * conversion of a figure billing already computed at the rate that priced the
 * quote (ADR-0019); nothing here decides what is charged.
 */
export function fromMinor(amountMinor: string, decimals: number): string | null {
  if (!/^\d+$/.test(amountMinor) || !Number.isInteger(decimals) || decimals < 0) return null;
  if (decimals === 0) return amountMinor;
  const digits = amountMinor.padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
