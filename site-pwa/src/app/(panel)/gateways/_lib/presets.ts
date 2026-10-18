import { MONEY_PATTERN, moneyTextOf, moneyUnits } from "../../_lib/money";

/**
 * Quick amounts on the top-up page (F-093-k over billing's F-092-v): the rules
 * of the list editor, the same ones `deposit-presets.ts` stores by — positive,
 * as the API writes an amount, no repeats, ascending, at most {@link MAX_PRESETS}. Billing
 * still decides; this only keeps a refused list from looking saved.
 */
export const MAX_PRESETS = 8;

export type PresetError = "decimal" | "positive" | "duplicate" | "limit";


export function addPreset(list: readonly string[], raw: string): { list: string[] } | { error: PresetError } {
  const value = raw.trim();
  if (!MONEY_PATTERN.test(value)) return { error: "decimal" };
  // Written as billing writes it, so the list compares with what it answered (F-116-s).
  const amount = moneyTextOf(value);
  if (moneyUnits(amount) <= BigInt(0)) return { error: "positive" };
  if (list.includes(amount)) return { error: "duplicate" };
  if (list.length >= MAX_PRESETS) return { error: "limit" };
  const next = [...list, amount].sort((a, b) => (moneyUnits(a) < moneyUnits(b) ? -1 : moneyUnits(a) > moneyUnits(b) ? 1 : 0));
  return { list: next };
}

export const samePresets = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
