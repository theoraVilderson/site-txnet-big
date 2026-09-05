---
id: auth-api
layer: interface
status: active
version: 3
updated: 2026-09-05
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
- Bot check: `X-Captcha-Token` header, required on the routes marked below.
  Obtained from `POST /auth/captcha/challenge` + `POST /auth/captcha/verify`
  (F-0201). Single-use — consumed by the first gated request it satisfies —
  and expires 120s after the slide completes, whichever comes first.

## Endpoints

| Method + path | Body (zod) | Success | Rate limit (per IP) | Captcha |
|---|---|---|---|---|
| POST `/auth/register` | fullName, username, phoneNumber, password | 201 `{phoneNumber, requiresPhoneVerification}` — no `user` row created yet | 10 / 3600s | required |
| POST `/auth/register/verify-phone` | phoneNumber, otpCode(6) | 200 tokens + sets `refresh_token` cookie — this is where the `user` row is actually created | 20 / 3600s | — |
| POST `/auth/login/password` | identifier, password | 200 tokens, **or** `{requiresOtp:true, otpToken}` | 20 / 900s | required |
| POST `/auth/login/otp/request` | phoneNumber, channel? | 200 `{accepted:true}` | 10 / 900s | required |
| POST `/auth/login/otp/verify` | (phoneNumber \| otpToken) + otpCode(6) | 200 tokens | 20 / 900s | — |
| POST `/auth/refresh` | refreshToken? (else cookie) | 200 tokens (rotated) | — | — |
| POST `/auth/logout` | refreshToken? (else cookie) | 200 `{success:true}`; clears cookie | — | — |
| POST `/auth/password/forgot` | phoneNumber, channel? | 200 `{accepted:true}` | 10 / 900s | required |
| POST `/auth/password/forgot/verify-otp` | phoneNumber, otpCode(6) | 200 `{resetToken}` | 20 / 900s | — |
| POST `/auth/password/reset` | resetToken, newPassword | 200 `{success:true}` | — | — |
| POST `/auth/captcha/challenge` | — | 200 `{challengeId}`, 60s to complete the slide | 30 / 900s | — |
| POST `/auth/captcha/verify` | challengeId | 200 `{token, expiresIn:120}` — `err('captcha.invalid')` if unknown/expired/too-fast | 30 / 900s | — |
| GET  `/i18n/:lang/:ns` | — | 200 nested namespace tree | — | — |
| POST `/admin/users/:userId/impersonate` | reasonNote (>=10) | 200 `{accessToken, expiresIn:1800}` | — (needs `user.impersonate`) | — |
| POST `/admin/impersonate/end` | — | 200 | — (Bearer of the impersonated session) | — |

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
`redis-keyspace` (sessions/OTP/rate limits/captcha).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `POST /auth/register/verify-phone` body keyed by `userId` | 2026-09-04 | already removed | keyed by `phoneNumber` — register no longer creates a `user` row to key by |

## Breaking: v3 — captcha now required on register/login/forgot

`register`, `login/password`, `login/otp/request` and `password/forgot` now
reject with `captcha.required` (400) if `X-Captcha-Token` is missing, expired,
or already spent. **Affected consumer:** `panel-web` — updated in the same
change (`lib/auth-api.ts` + the three auth pages now run `useCaptcha()` first).
Any other client of this API must adopt the challenge/verify flow before
calling these four routes.
