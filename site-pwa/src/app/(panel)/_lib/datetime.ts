/**
 * An instant, as the panel's language reads it (added by F-093-d for the kit).
 *
 * Every timestamp on the wire is an ISO-8601 instant — `billing` answers
 * `createdAt` and `expiresAt` that way on purpose, because a service that took
 * a calendar date would have to hold a calendar and guess a zone
 * (`domains/billing/contract.history.md`). The calendar is this side's, the
 * same way it is for `DatePicker`: Persian reads Jalali, everything else reads
 * Gregorian, and `Intl` already knows which from the language tag — so there
 * is no calendar table here and a new language needs no entry in one.
 *
 * The zone is the viewer's, deliberately. A user checking when a payment
 * expired wants the clock on their own wall, not the server's — and "their
 * own" is their resolved zone (TZ-1-e, ADR-0108 point 7): the one they chose,
 * else this browser's, else their tenant's. `lib/time-zone`'s `displayZone`
 * holds it; until the session has read it, the browser's own.
 */

import { PLATFORM_DEFAULT_TIMEZONE, displayZone } from "@/lib/time-zone";
import { numberLocale } from "./digits";

type Parts = Intl.DateTimeFormatOptions;

const DATE_ONLY: Parts = { year: "numeric", month: "2-digit", day: "2-digit" };
const WITH_TIME: Parts = { ...DATE_ONLY, hour: "2-digit", minute: "2-digit" };

/**
 * `"2026-09-12T08:30:00.000Z"`, in Persian -> `1405/06/21 12:00` (Jalali, Latin digits — `digits.ts`).
 *
 * `null` for an absent or unreadable instant rather than a placeholder string:
 * a caller that has nothing to show hides the line, and one that wants a dash
 * writes its own. Nothing here invents a date, because a wrong timestamp on a
 * receipt reads exactly like a right one.
 */
export function formatInstant(
  instant: string | null | undefined,
  lang: string,
  { withTime = true }: { withTime?: boolean } = {},
): string | null {
  if (!instant) return null;
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const parts = withTime ? WITH_TIME : DATE_ONLY;
  const zone = displayZone();
  try {
    return new Intl.DateTimeFormat(numberLocale(lang), zone ? { ...parts, timeZone: zone } : parts).format(date);
  } catch {
    // A zone this browser cannot read: its own clock beats no date.
    if (zone) {
      try {
        return new Intl.DateTimeFormat(numberLocale(lang), parts).format(date);
      } catch {
        // fall through
      }
    }
    // Not a tag Intl can read. The instant as it arrived beats nothing.
    return instant;
  }
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
];

/**
 * "5 minutes ago", "yesterday" — in `Intl`'s own words for the language; past
 * a week it is the date, as `formatInstant` draws it (UX-1-w: a ticket row).
 * `title` the row with `formatInstant` when the exact time matters.
 */
export function formatRelative(instant: string | null | undefined, lang: string, now: number = Date.now()): string | null {
  if (!instant) return null;
  const at = new Date(instant).getTime();
  if (Number.isNaN(at)) return null;
  let value = Math.round((at - now) / 1000);
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(value) < size) {
      try {
        return new Intl.RelativeTimeFormat(numberLocale(lang), { numeric: "auto" }).format(value, unit);
      } catch {
        return formatInstant(instant, lang);
      }
    }
    value = Math.round(value / size);
  }
  return formatInstant(instant, lang, { withTime: false });
}

/** The locale whose short date is `YYYY-MM-DD` — a sortable day key, never shown to a person (C-17). */
export const DAY_KEY_LOCALE = "en-CA";

/** `YYYY-MM-DD` of an instant on `zone`'s wall clock; this browser's when no zone is given or `Intl` refuses it. */
export function dayIn(instant: string | number | Date, zone?: string | null): string {
  const at = new Date(instant);
  try {
    return new Intl.DateTimeFormat(DAY_KEY_LOCALE, zone ? { ...DATE_ONLY, timeZone: zone } : DATE_ONLY).format(at);
  } catch {
    return new Intl.DateTimeFormat(DAY_KEY_LOCALE, DATE_ONLY).format(at);
  }
}

/** Today on the platform's clock — the day a price, a rate card or a coupon is picked in (FE-1-c). */
export const platformToday = (now: number | Date = Date.now()): string => dayIn(now, PLATFORM_DEFAULT_TIMEZONE);

/** Tehran has kept +03:30 all year since 2022 — the clock billing's weekday and hour gates read too. */
export const PLATFORM_UTC_OFFSET = "+03:30";

/** A picked platform day's first instant, as billing stores it. */
export const platformDayStart = (day: string): string => `${day}T00:00:00${PLATFORM_UTC_OFFSET}`;

/** A moment as the visitor's wall time, `YYYY-MM-DDTHH:mm` — what `DatePicker withTime` holds (GR-1-k, F-030-c). */
export type WallTime = string;

/** A saved instant as the visitor's wall time, minute precise — what a draft compares against. */
export function wallTimeOf(iso: string | null): WallTime | null {
  if (!iso) return null;
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A wall time in the visitor's zone as the instant the server stores. */
export const instantOf = (wall: WallTime) => new Date(`${wall}:00`).toISOString();
