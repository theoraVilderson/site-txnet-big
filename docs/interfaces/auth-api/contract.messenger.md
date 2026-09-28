---
id: auth-api
layer: interface
status: active
version: 36
updated: 2026-09-28
---

# Contract — auth-api / the caller's notice messenger

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. The wire shapes of `/api/auth/me/messenger` (F-601-u).
What the choice means is
[identity/contract.messenger.md](../../domains/identity/contract.messenger.md);
this file is shapes, codes and limits.

Field schema lives in code: `meMessengerSchema` in
`txnet-backend/auth-service/src/app/auth/auth.schema.ts` (from the Prisma
enum, C-09).

## Routes

| Method + path | Request | Response | Rate limit | Idempotency |
|---|---|---|---|---|
| GET `/auth/me/messenger` | — | 200 `{messenger: 'telegram'\|'bale'\|'both', chosen, linked: ['telegram'\|'bale']}` (`auth.messenger`). Unchosen answers `both` with `chosen: false`. **Bearer required**, tenant capability `account` | `ME_MESSENGER` 30 / 900s per caller | — |
| PUT `/auth/me/messenger` | `{messenger: 'telegram'\|'bale'\|'both'}` | 200, the same shape as stored (`auth.messengerSaved`); another value is 400 | the same bucket | yes — the same value twice stores it once |

Consumer: panel-web `/settings` (`MessengerSection`).
