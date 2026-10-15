/**
 * The Jalali calendar — the runtime's own (`Intl`, `ca-persian`): no table of
 * equinoxes to drift. Moved from `catalog/seasons.ts` (F-505-a) for the
 * analytics buckets (F-1001-b), so both count months the same way.
 */

const DAY_MS = 86_400_000;

const persian = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });

/** The Jalali (year, month, day) of a UTC calendar day. */
export function jalaliOf(utcNoon: Date): { year: number; month: number; day: number } {
  const parts = persian.formatToParts(utcNoon);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/**
 * The Gregorian day of a Jalali date, or `null` for one the year does not have
 * (30 Esfand outside a leap year, a 31st past the sixth month).
 */
export function jalaliToGregorian(jy: number, jm: number, jd: number): { year: number; month: number; day: number } | null {
  if (!Number.isInteger(jm) || !Number.isInteger(jd) || jm < 1 || jm > 12 || jd < 1 || jd > (jm <= 6 ? 31 : 30)) return null;
  // 1 Farvardin is the equinox's day: between 19 and 22 March of year + 621.
  const gy = jy + 621;
  let nowruz: number | null = null;
  for (let d = 19; d <= 22 && nowruz === null; d += 1) {
    const at = Date.UTC(gy, 2, d, 12);
    const j = jalaliOf(new Date(at));
    if (j.year === jy && j.month === 1 && j.day === 1) nowruz = at;
  }
  if (nowruz === null) return null;
  const dayOfYear = (jm <= 6 ? (jm - 1) * 31 : 186 + (jm - 7) * 30) + (jd - 1);
  const at = new Date(nowruz + dayOfYear * DAY_MS);
  const back = jalaliOf(at);
  if (back.year !== jy || back.month !== jm || back.day !== jd) return null;
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}
