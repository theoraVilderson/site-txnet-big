---
id: auth-api
layer: interface
status: active
version: 37
updated: 2026-10-08
---

# Contract — auth-api / a blocked account

A topic file of [contract.md](contract.md) (§10), opened because that file is at
its 250-line cap. Shapes only; what the levels mean is
[identity/contract.blocked-accounts.md](../../domains/identity/contract.blocked-accounts.md)
(BAN-1, ADR-0133).

## Routes

| Method + path | Body | Answer | Rate limit | Auth |
|---|---|---|---|---|
| GET `/auth/users/:userId/status` | — | 200 `{id, status, statusReason}` | — | Bearer; `restriction.assign` or `user.ban`, own tenant |
| PUT `/auth/users/:userId/status` | `{status: "active"\|"suspended"\|"banned", reason?: string ≤500}` | 200 `{id, status, statusReason}`; the same status and reason again writes nothing | 20 / 900s per caller (`RESELLER_USER_WRITE_RATE_LIMIT`, shared) | Bearer; `user.ban` when `banned` is on either side, else `restriction.assign` |

Refusals carry `error.reason`: `reason_required` 400; `user_not_found` 404;
`wrong_tenant`, `no_permission`, `self`, `owner`, `not_above` 403.

POST `/auth/tenants/:tenantId/users/:userId/block` (F-311-a) takes an optional
`{reason}` (≤500) and stores it as `statusReason`; unblock clears it.

## What changed on existing routes

- **Sign-in of a `banned` account**, once the password matched or the code
  verified (password, code, two-factor, `bots/session`): `{ok:false, msg:
  "auth.accountBanned", error:{reason:"accountBanned", facts:{statusReason?}}}`.
  `bots/session` answers the key alone.
- **A `suspended` account signs in** on every path, and its access token
  carries `restricted: true` with `permissions: []`.
- **`refresh` of a banned account** is `auth.invalidRefreshToken`.
- **`GET /auth/me`** answers a restricted account too, with
  `restriction: {reason}`; `null` for everyone else.
- **A restricted token on any unmarked handler** is `403` `{i18nKey:
  "auth.accountRestricted", reason: "accountRestricted"}` — the same reason the
  gate answers with. A client draws the restricted screen on it; refreshing
  will not change it.
