import { amountPattern } from "../../../_lib/money";

/**
 * The amount box's arithmetic (F-093-e), and the only arithmetic on this page.
 *
 * It is deliberately not about money: nothing here prices anything, applies a
 * discount or works out what is payable — that whole breakdown is
 * `POST /deposit/quote`'s answer and the panel derives none of it (F-0612,
 * `billing/contract.deposit.md`). What is left is the input control itself: a
 * slider and a set of preset buttons need a *number* to work with, and the
 * wire wants an exact decimal string in the payer's currency (C-02).
 *
 * So the number is **integer minor units of that currency** — cents for a
 * dollar, whole rials, thousandths of a dinar (`currencyDecimals`, F-116-s). A
 * slider that emits a float is how `0.1 + 0.2` reaches a payment route as
 * `0.30000000000000004`; a `Number` holds every minor unit exactly well past
 * any top-up a gateway takes.
 */

/**
 * A decimal string as whole minor units at `decimals` places, or `null` when it
 * is not an amount this currency can hold (a fraction of a rial, a third cent).
 * `null` rather than `NaN`: a caller has to decide what an unreadable box
 * means, and `NaN` silently becomes a zero on the way to a comparison.
 */
export function toMinor(amount: string, decimals: number): number | null {
  const trimmed = amount.trim();
  if (!amountPattern(decimals).test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 10 ** decimals + Number(fraction.padEnd(decimals, "0") || "0");
}

/** Whole minor units back as the decimal string the API takes. */
export function fromMinorNumber(minor: number, decimals: number): string {
  const scale = 10 ** decimals;
  const whole = Math.trunc(minor / scale);
  return decimals === 0 ? String(whole) : `${whole}.${String(Math.abs(minor % scale)).padStart(decimals, "0")}`;
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

/**
 * The buttons one gateway offers (F-093-k): billing's answer, as it is — the
 * gateway's own list, else its tenant's, else the automatic ladder from its
 * range. The ladder moved to billing (2026-10-15) so the bot offers the same.
 */
export function offeredPresets(gateway: { presets?: readonly string[] }): string[] {
  return [...(gateway.presets ?? [])];
}

/**
 * A rial amount in toman, as a decimal string: `"4563010"` -> `"456301"`,
 * `"4563015"` -> `"456301.5"`. Ten rial to the toman is a unit, not an exchange
 * rate, so this is string work, and an odd rial stays visible as a tenth rather
 * than being rounded off a figure the bank will charge exactly.
 */
export function tomanFromRial(rial: string): string | null {
  if (!/^\d+$/.test(rial)) return null;
  const padded = rial.padStart(2, "0");
  const whole = padded.slice(0, -1).replace(/^0+(?=\d)/, "");
  const tenth = padded.slice(-1);
  return tenth === "0" ? whole : `${whole}.${tenth}`;
}
