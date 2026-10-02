/**
 * An instant, as the panel's language reads it (added by F-093-d for the kit).
 *
 * Every timestamp on the wire is an ISO-8601 instant — `billing` answers
 * `createdAt` and `expiresAt` that way on purpose, because a service that took
 * a calendar date would have to hold a calendar and guess a zone
 * (`domains/billing/contract.history.md`). The calendar is this side's, the
 * same way it is for `DatePicker`: `fa` reads Jalali, everything else reads
 * Gregorian, and `Intl` already knows which from the language tag — so there
 * is no calendar table here and a new language needs no entry in one.
 *
 * The zone is the viewer's, deliberately. A user checking when a payment
 * expired wants the clock on their own wall, not the server's — and "their
 * own" is their resolved zone (TZ-1-e, ADR-0108 point 7): the one they chose,
 * else this browser's, else their tenant's. `lib/time-zone`'s `displayZone`
 * holds it; until the session has read it, the browser's own.
 */

import { displayZone } from "@/lib/time-zone";
import { numberLocale } from "./digits";

type Parts = Intl.DateTimeFormatOptions;

const DATE_ONLY: Parts = { year: "numeric", month: "2-digit", day: "2-digit" };
const WITH_TIME: Parts = { ...DATE_ONLY, hour: "2-digit", minute: "2-digit" };

/**
 * `"2026-09-12T08:30:00.000Z"`, `fa` -> `1405/06/21 12:00` (Jalali, Latin digits — `digits.ts`).
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
