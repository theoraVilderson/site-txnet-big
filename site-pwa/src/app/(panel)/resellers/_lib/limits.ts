import { RESELLER_KEYS } from "./resellers";

/** The limits page's strings (C-06). */
export const LIMIT_KEYS = RESELLER_KEYS.limits;

/** shared-core's `RESELLER_LIMITS`, in its order — one list for the panel, in `lib/reseller-limits.ts`. */
export { RESELLER_LIMIT_KEYS } from "@/lib/reseller-limits";

/**
 * A limit typed in a box: a whole number, or `null` when "no limit" is ticked;
 * `undefined` for anything else (the save stays off). `max` is the key's own
 * bound, billing's — the box only helps.
 */
export function limitValueOf(typed: string, noLimit: boolean, max: number): number | null | undefined {
  if (noLimit) return null;
  const v = typed.trim();
  if (!/^\d{1,7}$/.test(v)) return undefined;
  const n = Number(v);
  return n <= max ? n : undefined;
}
