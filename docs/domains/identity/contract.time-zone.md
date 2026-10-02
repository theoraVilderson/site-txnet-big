---
id: identity
layer: domain
status: active
version: 26
updated: 2026-10-02
---

# Contract — identity / a person's time zone

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. Which wall clock a question about a user is answered in
(TZ-1, ADR-0108). Every instant is stored in UTC; a zone is read only to
answer a wall-clock question — the ADR's table says which clock answers what.

## Operations

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| resolve a zone | the user's `{timezone, timezoneSource}` and the tenant's `{timezone}`, either absent | `{zone, from}` — `from` is `user` \| `browser` \| `tenant` \| `platform` | sync, pure | — |
| read / save my zone | the caller's session; on save `{zone, source}` | `{timezone, source, resolved}`, plus `applied` on a save | sync | a non-IANA zone, or `browser` without one (400) |
| next user zone | the stored pair and a report `{zone, source}` | the pair to write, or null for "write nothing" | sync, pure | a zone that is not IANA throws `RangeError` (the caller validates first) |

## Columns (TZ-1-b)

`identity.user.timezone` (nullable) + `timezoneSource` (`user` \| `browser`):
both null or both set, a CHECK holds it (`user_timezone_has_a_source`). Null
for every existing user. `tenant.tenant.timezone` is not null, default
`Asia/Tehran`; `time-zone-columns.spec.ts` holds that default and the enum
equal to shared-core's constant and `TIME_ZONE_SOURCES`. Migration
`20261002000000_a_person_has_a_time_zone`, additive.

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | One resolver: the user's own zone (chosen or browser-reported) -> the tenant's -> `PLATFORM_DEFAULT_TIMEZONE` (`Asia/Tehran`). No unit adds a zone column of its own | four columns defaulting to a literal is the drift ADR-0108 ends |
| 2 | A stored zone the runtime cannot read is **skipped** to the next, never thrown | a zone dropped from the IANA database must not stop a send |
| 3 | A zone is an IANA name, stored **canonical** (`Iran` -> `Asia/Tehran`). A fixed offset (`+03:30`) is refused | DST is the IANA database's job; an offset is wrong half the year somewhere |
| 4 | A browser report **never overwrites** a zone the user chose. The user may choose over a report, or clear their choice so the browser may report again | the only automatic source must not undo a deliberate one |
| 5 | Never inferred from an IP or a messenger | users sit behind a VPN; Telegram and Bale send no zone |
| 6 | Every `'Asia/Tehran'` in TypeScript reads `PLATFORM_DEFAULT_TIMEZONE`; `isTimeZone` (quota clock) is the same validator as `isIanaZone` | one constant, one validator |

## Not built here

- The tenant's own setting is tenant's: [tenant/contract.time-zone.md](../tenant/contract.time-zone.md) (TZ-1-d).
- Quiet hours are notification's: [notification/contract.retention.md](../notification/contract.retention.md) (TZ-1-f).
- The panel is panel-web's: `contract.kit.md` "The zone a date is drawn in" (TZ-1-e).
- Schedules (TZ-1-g), the bot (TZ-1-h). Prisma `@default("Asia/Tehran")`
  cannot read the constant; the panel spells it once, `src/lib/time-zone.ts`.

Code: `shared-core/src/lib/time/time-zone.ts`, `auth/me/me-time-zone.service.ts`.
Wire shapes: [auth-api/contract.time-zone.md](../../interfaces/auth-api/contract.time-zone.md).
