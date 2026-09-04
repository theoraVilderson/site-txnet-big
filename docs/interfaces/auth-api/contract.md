---
id: auth-api
layer: interface
status: active
version: 1
updated: 2026-09-04
---

# Contract — auth-api

The HTTP wire contract for `auth-service`. Business semantics and guarantees are
in `domains/identity/contract.md`; this file is shapes, status codes, headers,
cookies and rate limits. Field-level schemas live in code — link, do not copy:
`txnet-backend/auth-service/src/app/auth/auth.schema.ts`,
`.../auth/register/register.schema.ts`.

## Conventions

- Base path: routed by Traefik as `Host(api.<domain>) && PathPrefix(/api/auth)`.
  Controllers are mounted at `/auth`, `/i18n`, `/admin` (the `/api` prefix is the
  ingress route, not a Nest global prefix).
- Success envelope: `{ ok: true, msg: "<i18n key/translated>", data: {...} }`
  (`response.util.ts`). Error envelope (global filter):
  `{ ok: false, msg: "<translated>", ref: "<id>", fieldErrors?: [{path,message}] }`.
- Language: `Accept-Language` -> resolved by `LanguageMiddleware` via
  `i18n` (`locale-service`); every `msg` is localized.
- Auth: `Authorization: Bearer <access JWT>` for protected routes
  (`/admin/*`). Refresh token travels as an httpOnly cookie `refresh_token`
  (`path=/api/auth`, `SameSite=Lax`, `Secure` unless `COOKIE_SECURE=false`)
  and/or a JSON body field.
- CORS: credentials on; allowed origin is `FRONTEND_ORIGIN` (fail-closed in
  production if unset).

## Endpoints

| Method + path | Body (zod) | Success | Rate limit (per IP) |
|---|---|---|---|
| POST `/auth/register` | fullName, username, phoneNumber, password | 201 `{userId, requiresPhoneVerification}` | 10 / 3600s |
| POST `/auth/register/verify-phone` | userId, otpCode(6) | 200 tokens + sets `refresh_token` cookie | 20 / 3600s |
| POST `/auth/login/password` | identifier, password | 200 tokens, **or** `{requiresOtp:true, otpToken}` | 20 / 900s |
| POST `/auth/login/otp/request` | phoneNumber, channel? | 200 `{accepted:true}` | 10 / 900s |
| POST `/auth/login/otp/verify` | (phoneNumber \| otpToken) + otpCode(6) | 200 tokens | 20 / 900s |
| POST `/auth/refresh` | refreshToken? (else cookie) | 200 tokens (rotated) | — |
| POST `/auth/logout` | refreshToken? (else cookie) | 200 `{success:true}`; clears cookie | — |
| POST `/auth/password/forgot` | phoneNumber, channel? | 200 `{accepted:true}` | 10 / 900s |
| POST `/auth/password/forgot/verify-otp` | phoneNumber, otpCode(6) | 200 `{resetToken}` | 20 / 900s |
| POST `/auth/password/reset` | resetToken, newPassword | 200 `{success:true}` | — |
| GET  `/i18n/:lang/:ns` | — | 200 nested namespace tree | — |
| POST `/admin/users/:userId/impersonate` | reasonNote (>=10) | 200 `{accessToken, expiresIn:1800}` | — (needs `user.impersonate`) |
| POST `/admin/impersonate/end` | — | 200 | — (Bearer of the impersonated session) |

`tokens` = `{ accessToken, expiresIn }` in `data`; `refreshToken` is stripped
from the body and set as the cookie.

## Status codes

- 200 / 201 success. 400 validation or business error (envelope carries the key).
- 401 bad/missing/expired token or revoked session (`AuthGuard`).
- 403 insufficient permission / impersonation of a non-lower role / sensitive
  action during impersonation.
- 409 duplicate registration, OTP issue already in progress.
- 429 rate limit (`RateLimitGuard` or per-identifier login lockout).
- 500 unexpected — envelope `msg` = `system.unexpected`, real error only in logs
  keyed by `ref`.

## Emits / Consumes

Emits: nothing (no bus). Consumes: `identity` (all logic), `i18n` (strings),
`redis-keyspace` (sessions/OTP/rate limits).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
