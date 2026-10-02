/**
 * The panel's half of one clock rule (TZ-1-e, ADR-0108;
 * `domains/identity/contract.time-zone.md`). Every instant on the wire is
 * UTC; which wall clock it is drawn on is the caller's **resolved** zone —
 * their choice, else this browser's report, else their tenant's, else the
 * platform's — which `GET /auth/me/timezone` answers. The resolver itself is
 * the server's; this side never re-derives it.
 */

/** The platform's clock — shared-core's `PLATFORM_DEFAULT_TIMEZONE`, spelled here because the panel cannot import it. */
export const PLATFORM_DEFAULT_TIMEZONE = "Asia/Tehran";

/** Where the caller's own zone came from (auth-api `contract.time-zone.md`). */
export type TimeZoneSource = "user" | "browser";
export type ResolvedTimeZone = { zone: string; from: TimeZoneSource | "tenant" | "platform" };
export type StoredZone = { timezone: string | null; source: TimeZoneSource | null };

/** This browser's IANA zone, or null where `Intl` names none. */
export function browserZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && !/^[+-]/.test(zone) ? zone : null;
  } catch {
    return null;
  }
}

/**
 * What to report after sign-in, or null for nothing (ADR-0108 point 4): a
 * browser report never goes over the user's choice, and is not sent when the
 * row already holds it.
 */
export function browserReport(stored: StoredZone, browser: string | null): { zone: string; source: "browser" } | null {
  if (!browser || stored.source === "user") return null;
  if (stored.source === "browser" && stored.timezone === browser) return null;
  return { zone: browser, source: "browser" };
}

/** Every zone this browser knows, with `saved` first when it does not — opening a picker never changes what is stored. */
export function zoneChoices(saved: string | null): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return saved && !all.includes(saved) ? [saved, ...all] : all;
}

/** The zone dates are drawn in — the session's resolved zone, remembered so the next load draws in it from its first frame. */
const REMEMBERED = "txnet.displayZone";
let display: string | null | undefined;

/** The resolved zone, or null for this browser's own until the session has read it. */
export function displayZone(): string | null {
  if (display === undefined) {
    try {
      display = typeof localStorage === "undefined" ? null : localStorage.getItem(REMEMBERED);
    } catch {
      display = null;
    }
  }
  return display;
}

/** Set by the panel session once `GET /auth/me/timezone` answers; null forgets it. */
export function setDisplayZone(zone: string | null): void {
  display = zone;
  try {
    if (zone) localStorage.setItem(REMEMBERED, zone);
    else localStorage.removeItem(REMEMBERED);
  } catch {
    // Storage blocked: the zone still holds for this page load.
  }
}
