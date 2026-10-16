/**
 * The one usage forecast rule (F-1525-a), shared so that a second reader —
 * analytics' capacity tab (F-1005-a) — forecasts the same way rather than its
 * own: a rate is the mean of the last 7 days, and a younger history is read
 * over itself, from a day up.
 */

const DAY_MS = 86_400_000;

/** The rate is the last 7 days. */
export const FORECAST_RATE_DAYS = 7;
/** What a forecast covers ahead: 30 days of use, and a top-up that lasts that long. */
export const FORECAST_AHEAD_DAYS = 30;

/** How long a rate is read over: since the first observation, at most 7 days; null under a day — too young to forecast. */
export function forecastSpanMs(firstAt: number, now: number): number | null {
  const span = Math.min(FORECAST_RATE_DAYS * DAY_MS, now - firstAt);
  return span < DAY_MS ? null : span;
}
