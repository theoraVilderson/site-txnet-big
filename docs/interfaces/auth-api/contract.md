---
id: auth-api
layer: interface
status: active
version: 5
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
  Controllers are mounted at `/auth`, `/i18n`, `/admin`, and `/api` is a **Nest
  global prefix** (`main.ts`, `app.setGlobalPrefix('api')`) — Traefik matches on
  it but does not strip it, so the full path is `/api/auth/...` in-network as
  well as at the edge. A server-to-server caller must include it.
- Success envelope: `{ ok: true, msg: "<i18n key/translated>", data: {...} }`
  (`response.util.ts`). Error envelope (global filter):
  `{ ok: false, msg: "<translated>", ref: "<id>", fieldErrors?: [{path,message}] }`.
- Language: `Accept-Language` -> resolved by `LanguageMiddleware` via
  `i18n` (`locale-service`); every `msg` is localized.
- Auth: `Authorization: Bearer <access JWT>` for protected routes
  (`/admin/*`). Refresh token travels as an httpOnly cookie `refresh_token`
  (`path=/`, `Domain=.<DOMAIN_NAME>`, `SameSite=Lax`, `Secure` unless
  `COOKIE_SECURE=false`, 30d) and/or a JSON body field. The domain-wide scope is
  deliberate (decided 2026-09-05): the cookie must reach `panel.<domain>`, where
  `panel-web`'s proxy reads it server-side to keep a signed-in visitor off the
  auth screens (F-0101). Narrowing it to `api.<domain>` would break that check.
  It stays httpOnly, so no script on any subdomain can read it.
- CORS: credentials on; allowed origin is `FRONTEND_ORIGIN` (fail-closed in
  production if unset).
- Already authenticated (F-0101): `POST /auth/register`, `/auth/login/password`,
  `/auth/login/otp/request` and `/auth/login/otp/verify` reject with 409
  `auth.alreadyAuthenticated` if the caller's `Authorization: Bearer` token
  verifies to a still-live session. A missing/invalid/expired/revoked token is
  treated as "no session" and passes through — `POST /auth/logout` (or letting
  the session expire) is what clears the block.
- Bot check: `X-Captcha-Token` header, required on the routes marked below.
  Obtained from `POST /auth/captcha/challenge` + `POST /auth/captcha/verify`
  (F-0201). Single-use — consumed by the first gated request it satisfies —
  and expires 120s after the slide completes, whichever comes first.

## Endpoints

| Method + path | Body (zod) | Success | Rate limit (per IP) | Captcha |
|---|---|---|---|---|
| POST `/auth/register` | fullName, username, phoneNumber, password | 201 `{phoneNumber, requiresPhoneVerification}` — no `user` row created yet | 10 / 3600s | required |
| POST `/auth/register/verify-phone` | phoneNumber, otpCode(6) | 200 tokens + sets `refresh_token` cookie — this is where the `user` row is actually created | 20 / 3600s | — |
| POST `/auth/login/password` | identifier, password | 200 tokens, **or** `{requiresOtp:true, otpToken}`. Every pre-password rejection is the same `auth.invalidCredentials`; `auth.phoneVerificationRequired` is only ever returned to a caller whose password was correct. Beyond the per-IP limit below, failures are also counted 10 / 900s per account (normalized identifier) -> `auth.temporarilyLocked` | 20 / 900s | required |
| GET  `/auth/otp/channels` | — | 200 `{channels:[{channel:"sms"\|"telegram"\|"bale", requiresLink:boolean}]}` — only what this environment has switched on **and** configured. A client renders this list; it must not hard-code the three names | 60 / 900s | — |
| POST `/auth/login/otp/request` | phoneNumber, channel? | 200 `{accepted:true}`, **or** 200 `{accepted:true, linkRequired:true, platform, linkToken, deepLink, expiresIn}` when the chosen messenger is not linked yet — no code was sent, the bot will send it after the user shares their contact | 10 / 900s | required |
| POST `/auth/login/otp/verify` | (phoneNumber \| otpToken) + otpCode(6) | 200 tokens | 20 / 900s | — |
| POST `/auth/refresh` | refreshToken? (else cookie) | 200 tokens (rotated); on `ok:false` **clears the `refresh_token` cookie** — a token that no longer resolves to a live session can never succeed again, so it is not left in the browser. This doubles as the "is this visitor signed in?" question: it is the only route that takes a refresh token, so `panel-web`'s proxy asks it (server-to-server) before rendering an auth screen | — | — |
| POST `/auth/logout` | refreshToken? (else cookie) | 200 `{success:true}`; clears cookie | — | — |
| POST `/auth/password/forgot` | phoneNumber, channel? | 200 `{accepted:true}`, or the same `linkRequired` shape as `login/otp/request` | 10 / 900s | required |
| POST `/auth/password/forgot/verify-otp` | phoneNumber, otpCode(6) | 200 `{resetToken}` | 20 / 900s | — |
| POST `/auth/password/reset` | resetToken, newPassword | 200 `{success:true}` + tokens + sets `refresh_token` cookie. Every session the account had is revoked first; the returned one is minted after that revocation, so this device stays signed in and no other does | — | — |
| POST `/auth/bots/link/status` | linkToken | 200 `{state:"pending"\|"linked"\|"failed", otpSent, failureKey?}` — polled by the screen showing the deep link | 120 / 900s | — |
| POST `/auth/bots/:platform/webhook/:secret` | a Telegram/Bale `Update` | 200 `{ok:true}` **always** (a non-2xx makes the platform redeliver). `platform` is `telegram`\|`bale`; `:secret` is `TELEGRAM_WEBHOOK_SECRET`/`BALE_WEBHOOK_SECRET`, compared in constant time, and Telegram's `X-Telegram-Bot-Api-Secret-Token` header is checked too when present. A wrong secret, an unknown platform, or an unconfigured bot answers **404**, indistinguishable from a route that does not exist | 30 / 60s per chat | — |
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

## Breaking: v5 — `password/reset` returns a session

`POST /auth/password/reset` now answers with `{success:true, accessToken,
expiresIn}` and sets the `refresh_token` cookie, where it previously returned
`{success:true}` alone. The revocation is unchanged and still total — the
returned session is created after it. **Affected consumer:** `panel-web`,
updated in the same change. Additive for any client that ignores the new
fields.

Also in v5, additive: `GET /auth/otp/channels`, `POST /auth/bots/link/status`,
`POST /auth/bots/:platform/webhook/:secret`, and the `linkRequired` variant of
the two OTP-request responses. A client that does not understand `linkRequired`
will show "code sent" for a code that is not coming, so treat adopting it as
required rather than optional for anything offering a messenger channel.

## Breaking: v3 — captcha now required on register/login/forgot

`register`, `login/password`, `login/otp/request` and `password/forgot` now
reject with `captcha.required` (400) if `X-Captcha-Token` is missing, expired,
or already spent. **Affected consumer:** `panel-web` — updated in the same
change (`lib/auth-api.ts` + the three auth pages now run `useCaptcha()` first).
Any other client of this API must adopt the challenge/verify flow before
calling these four routes.
