---
id: auth-api
layer: interface
status: active
version: 41
updated: 2026-10-05
---

# Contract — auth-api / the caller's name and password

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. The wire shapes of `/api/auth/me/name` and
`/api/auth/me/password` (UX-1-t). What each does is
[identity/contract.account.md](../../domains/identity/contract.account.md);
this file is shapes, codes and limits.

Request schemas live in code: `meNameSchema`, `mePasswordSchema` in
`txnet-backend/auth-service/src/app/auth/auth.schema.ts`.

## Routes

Both are **Bearer required**, tenant capability `account`, per caller.

| Method + path | Request | Response | Limit |
|---|---|---|---|
| PUT `/auth/me/name` | `{fullName}`, strict; trimmed, 2–120 | `{fullName}` (`auth.nameSaved`) | `ME_NAME` 30 / 900s (`ME_NAME_RATE_LIMIT`) |
| POST `/auth/me/password` | `{currentPassword, newPassword, endOtherSessions?: bool = true}`, strict; `newPassword` the register form's rules | `{otherSessionsEnded: n}` (`auth.passwordChanged`); 400 `error.reason: 'wrong_password'` (`auth.wrongPassword`); 200 `ok: false` `password.containsProfileData` | `ME_PASSWORD` 5 / 900s (`ME_PASSWORD_RATE_LIMIT`) |

## Rules

| # | Rule |
|---|---|
| 1 | A wrong current password is a **400 with a reason**, not a 401: the session is fine and a client must not treat it as signed out |
| 2 | The password budget counts every try, right or wrong: five per user per fifteen minutes is what a guesser holding a stolen session gets at the current password |
| 3 | The caller's own session survives a change; no new token is issued and no cookie is set |
| 4 | The password route is 403 from an impersonated session |

Consumers: panel-web (UX-1-u, Settings > Profile).
