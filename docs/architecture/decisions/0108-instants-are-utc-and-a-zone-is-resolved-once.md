---
id: adr-0108
status: accepted
updated: 2026-10-02
---

# ADR 0108 — instants are UTC; a time zone is resolved once, in one place

- **Status:** accepted, not built (series TZ-1-a … TZ-1-h)
- **Date:** 2026-10-02 (user: "resellers and users may be in different
  time zones — how should the system behave in general?"; approved as its own
  series, before the AI work that needs it)
- **Affects units:** identity, tenant, auth-api, notification, automation,
  governance, panel-web, bot-app
- **Leaves alone:** ADR-0107 point 7 (`quotaTimeZone`, the platform's clock
  for a sold quota's day and week)

## Context

Four tables each carry their own IANA zone column, all defaulting to the
literal `Asia/Tehran`: `automation` schedules, `governance` temporal grants,
`notification.notification_preference` (quiet hours) and the tenant
settings row (`quotaTimeZone`). There is no zone for a tenant and none for a
user outside the notification preference. Every new feature that needs a
wall clock (quiet hours, "send when the user is usually online", a
reseller's "yesterday") would add a fifth column, and two of them disagreeing
is a message at 3 a.m. that no test catches.

## Decision

1. **Every instant is stored in UTC.** A zone is read only to answer a
   wall-clock question. No fixed offset is stored anywhere; DST is the IANA
   database's job.
2. **Two new zones.** `tenant.timezone` (IANA, not null, default the platform
   constant) and `identity.user.timezone` (IANA, nullable) with
   `timezoneSource: user | browser`.
3. **One resolver in `shared-core`:** `resolveTimeZone({ user, tenant })` =
   the user's own choice → the zone the panel's browser reported → the
   tenant's zone → `PLATFORM_DEFAULT_TIMEZONE` (`Asia/Tehran`, one constant;
   every `'Asia/Tehran'` literal in code reads it). It is pure: each service
   loads the two rows it already has and calls it.
4. **Never inferred from an IP or a messenger.** Users sit behind a VPN, so
   an IP names the exit server; Telegram and Bale send no zone. The only
   automatic source is the panel browser (`Intl`), reported after sign-in. A
   browser report never overwrites a zone the user chose.
5. **Which clock answers what:**

   | Question | Clock |
   |---|---|
   | expiry, "N days left", exhaustion forecasts | UTC (a duration has no zone) |
   | caps on messages (attention budget, cooldowns) | rolling windows (last 24 h / 7 d), no zone |
   | quiet hours | the user's resolved zone |
   | "when is this user usually active" | learned from UTC event times — needs no zone |
   | a reseller's daily/monthly report, "yesterday" | the tenant's zone |
   | dated occasions (Nowruz, Yalda) | the user's local date |
   | platform-owner dashboards | the platform constant |

   The Jalali calendar is a display and calendar concern, not a zone.
6. **Existing columns.** `notification_preference.timezone` becomes nullable;
   null means the resolver, existing rows keep their value. `automation` and
   `governance` keep their per-row zone (an admin's explicit choice) but a row
   created without one takes the tenant's zone from the resolver, not a
   literal. `quotaTimeZone` is unchanged.
7. **Where a person sets it.** A user in panel settings and in bot settings;
   a tenant admin in tenant settings. Dates in the panel render in the
   resolved zone.

## Consequences

- A new unit that needs a wall clock calls the resolver and adds no column.
- AI quiet hours and send-time (ADR-0109) are correct for a reseller outside
  Iran from their first day.
- Rejected: a zone guessed from IP (wrong behind a VPN by construction); a
  zone per feature (the present drift); storing local times (DST and travel
  rewrite history).
