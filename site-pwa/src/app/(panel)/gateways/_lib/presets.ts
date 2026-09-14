/**
 * Quick amounts on the top-up page (F-093-k over billing's F-092-v): the rules
 * of the list editor, the same ones `deposit-presets.ts` stores by — positive,
 * two decimals, no repeats, ascending, at most {@link MAX_PRESETS}. Billing
 * still decides; this only keeps a refused list from looking saved.
 */
export const MAX_PRESETS = 8;

const AMOUNT = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

export type PresetError = "decimal" | "positive" | "duplicate" | "limit";

/** Two decimals, as a string (C-02): `"2.5"` -> `"2.50"`. */
function twoPlaces(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/** Cents as a bigint, for ordering without a float. */
const cents = (v: string) => BigInt(v.replace(".", ""));

export function addPreset(list: readonly string[], raw: string): { list: string[] } | { error: PresetError } {
  const value = raw.trim();
  if (!AMOUNT.test(value)) return { error: "decimal" };
  const amount = twoPlaces(value);
  if (cents(amount) <= BigInt(0)) return { error: "positive" };
  if (list.includes(amount)) return { error: "duplicate" };
  if (list.length >= MAX_PRESETS) return { error: "limit" };
  const next = [...list, amount].sort((a, b) => (cents(a) < cents(b) ? -1 : cents(a) > cents(b) ? 1 : 0));
  return { list: next };
}

export const samePresets = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
