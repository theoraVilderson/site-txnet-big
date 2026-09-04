---
id: governance
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — governance

**DRAFT — schema only, no service implements this yet.** Intent derived from
`txnet-backend/prisma/domains/governance.prisma`.

## TL;DR

Low-traffic key/value config for users, plus two opposite tools: `temporal_access_grant` (extra access, one-time or recurring-daily window, in a timezone) and `user_restriction` (a cap: max daily traffic, max active configs, max daily spend, ...).

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| get/set user setting | userId, key, JSON value | row | sync | — |
| grant temporal access | grantee, permissionKey, mode, window | `temporal_access_grant` | sync | overlapping active grant |
| assign restriction | userId, restrictionKey, limit JSON, scope | `user_restriction` | sync | — |
| evaluate effective access | userId, permissionKey, now | allow/deny (role ∪ active grants, minus hard blocks) | sync | — |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId`; base role/permissions to combine with grants | access evaluation falls back to base role only |

## Guarantees (intended)

- Grants and restrictions are time-bounded; an expired row has no effect.
- `timezone` defaults to `Asia/Tehran`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
