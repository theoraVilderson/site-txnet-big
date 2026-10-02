---
id: auth-api
layer: interface
status: active
version: 38
updated: 2026-10-02
---

# Contract — auth-api / the caller's time zone

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. The wire shapes of `/api/auth/me/timezone` (TZ-1-c,
ADR-0108). What a zone means and which one wins is
[identity/contract.time-zone.md](../../domains/identity/contract.time-zone.md);
this file is shapes, codes and limits.

Field schema lives in code: `meTimeZoneSchema` in
`txnet-backend/auth-service/src/app/auth/auth.schema.ts` (source from the
Prisma enum, C-09; zone through shared-core `isIanaZone`).

## Routes

| Method + path | Request | Response | Rate limit | Idempotency |
|---|---|---|---|---|
| GET `/auth/me/timezone` | — | 200 `{timezone: string\|null, source: 'user'\|'browser'\|null, resolved: {zone, from: 'user'\|'browser'\|'tenant'\|'platform'}}` (`auth.timezone`). **Bearer required**, tenant capability `account` | `ME_TIMEZONE` 30 / 900s per caller | — |
| PUT `/auth/me/timezone` | `{zone: IANA\|null, source: 'user'\|'browser'}`, strict | 200, the same shape plus `applied` (`auth.timezoneSaved`). `applied: false` = a browser report met the user's choice and was not stored — not an error. 400: a zone that is not IANA (an offset like `+03:30` included), `zone: null` with `browser`, another `source`, an extra field | the same bucket | yes — the same report twice writes once |

## Rules

| # | Rule |
|---|---|
| 1 | The panel sends `browser` with `Intl.DateTimeFormat().resolvedOptions().timeZone` after sign-in; a person's pick in settings sends `user`. `zone: null` with `user` clears the choice |
| 2 | A `browser` write is conditional in the UPDATE itself (`timezoneSource` null or `browser`), so a choice saved between the read and the write is never overwritten |
| 3 | The zone is stored canonical (`Iran` -> `Asia/Tehran`); the answer shows the stored form |

Consumers: panel-web (TZ-1-e, built: `panel-web/contract.kit.md` Z1–Z3), bot-app (TZ-1-h, built: `bot-app/conversation.md` "Which clock a user is on").
