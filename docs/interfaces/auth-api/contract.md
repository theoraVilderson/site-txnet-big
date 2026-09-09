---
id: auth-api
layer: interface
status: active
version: 10
updated: 2026-09-08
---

# Contract — auth-api

The HTTP wire contract for `auth-service`. Business semantics and guarantees are
in `domains/identity/contract.md`; this file is shapes, status codes, headers,
cookies and rate limits. Field-level schemas live in code — link, do not copy:
`txnet-backend/auth-service/src/app/auth/auth.schema.ts`,
`.../auth/register/register.schema.ts`.

## Conventions

- Base path: routed by Traefik as `Host(api.<domain>) && PathPrefix(/api/auth)`.
  Controllers are mounted at `/auth` and `/admin`, and `/api` is a **Nest
  global prefix** (`main.ts`, `app.setGlobalPrefix('api')`) — Traefik matches on
  it but does not strip it, so the full path is `/api/auth/...` in-network as
  well as at the edge. A server-to-server caller must include it.
- **Read `ok`, never the status code.** Every response carries `ok`, and it is
  the only field that says whether the request succeeded. There are three
  envelopes and two of them mean failure — see "Response envelopes" below.
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
- **`phoneNumber` is E.164 in and out** — `+989123456789` (ADR-0018). Any
  spelling a person types is accepted (spaces, dashes, a leading `0`, Persian
  digits, `+`, `00`); every response and every stored value is E.164. Numbers
  from **every country** are valid, not only Iran, and a number that cannot
  receive an SMS (a fixed line) is refused with `phone.invalidFormat`. A
  number typed without a `+` is read as belonging to the region
  `DEFAULT_PHONE_COUNTRY` names, defaulting to the one `DEFAULT_LANGUAGE`
  implies; `SUPPORTED_PHONE_COUNTRIES`, empty by default, narrows which
  countries may sign up at all.
- The `/auth/accounts/*` routes are the mirror image of the F-0101 rule below:
  every one of them requires `Authorization: Bearer` and none is behind
  `NoActiveSessionGuard`. A live session is what they are *about* — the caller
  is adding to, or moving inside, their own switch group (C-21). Their
  rate-limit bucket is the caller's user id rather than the IP: the caller is
  known, and an IP key would let one signed-in account spend a shared NAT's
  budget for everyone behind it.
- **Switch scope** (ADR-0015). Every `/auth/accounts/*` route acts on the group
  belonging to the *surface* the call came from, never a global one, and the
  scope is never in a request body — a caller must not be able to name the
  surface it acts for. It is derived below the route: for a browser from a
  server-minted httpOnly `device_id` cookie (domain-wide, one year, set on the
  first response that lacks it); for `bot-service` from a verified
  `x-service-token` plus `x-bot-chat-id` **and** `x-bot-platform`. A service
  caller sending a chat id with no platform gets no scope and is refused
  (`accountSwitch.noScope` on the adds, `accountSwitch.notAMember` elsewhere) —
  the two messengers number chats independently, so guessing would merge two
  strangers' groups.
- Already authenticated (F-0101): `POST /auth/register`, `/auth/login/password`,
  `/auth/login/otp/request` and `/auth/login/otp/verify` reject with 409
  `auth.alreadyAuthenticated` if the caller's `Authorization: Bearer` token
  verifies to a still-live session. A missing/invalid/expired/revoked token is
  treated as "no session" and passes through — `POST /auth/logout` (or letting
  the session expire) is what clears the block.
- Service callers (v6, ADR-0011): another service of this platform —
  `bot-service` today — sends `X-Service-Token` (compared in constant time
  against `SERVICE_AUTH_TOKEN`) and optionally `X-Bot-Chat-Id`. A valid token
  does exactly two things: the captcha requirement is waived, and the per-IP
  rate-limit bucket becomes a per-chat one (every bot call shares one IP, so the
  per-IP bucket would lock out the whole bot). It is **not** an authentication:
  it names the calling process, never a user, and every route still proves the
  person the same way. A missing or wrong token behaves exactly as before.
- Bot check: `X-Captcha-Token` header, required on the routes marked below.
  Obtained from `POST /auth/captcha/challenge` + `POST /auth/captcha/verify`
  (F-0201). Single-use — consumed by the first gated request it satisfies —
  and expires 120s after the slide completes, whichever comes first.

- Three of the numbers below are **deployment config, not fixed limits**. The
  value in the table is the default an environment that sets nothing gets;
  a deployment overrides it without a rebuild:
  `CAPTCHA_RATE_LIMIT` (both `/auth/captcha/*` routes),
  `FORGOT_VERIFY_RATE_LIMIT` (`/auth/password/forgot/verify-otp`) and
  `LOGIN_FAILURE_LOCK_THRESHOLD` (the per-account lock on `/auth/login/password`
  and `/auth/accounts/add/password`). A client must not assume any of the three:
  429 and `auth.temporarilyLocked` are the contract, the counts are not.
  Every other limit in the table is fixed at the route.

## Endpoints

| Method + path | Body (zod) | Success | Rate limit (per IP) | Captcha |
|---|---|---|---|---|
| POST `/auth/register` | fullName, username, phoneNumber, password | 201 `{phoneNumber, requiresPhoneVerification}` — no `user` row created yet | 10 / 3600s | required |
| POST `/auth/register/verify-phone` | phoneNumber, otpCode(6) | 200 tokens + sets `refresh_token` cookie — this is where the `user` row is actually created | 20 / 3600s | — |
| POST `/auth/login/password` | identifier, password | 200 tokens, **or** `{requiresOtp:true, otpToken}`. Every pre-password rejection is the same `auth.invalidCredentials`; `auth.phoneVerificationRequired` is only ever returned to a caller whose password was correct. Beyond the per-IP limit below, failures are also counted 10 / 900s per account (normalized identifier, default — `LOGIN_FAILURE_LOCK_THRESHOLD`) -> `auth.temporarilyLocked` | 20 / 900s | required |
| GET  `/auth/otp/channels` | — | 200 `{channels:[{channel:"sms"\|"telegram"\|"bale", requiresLink:boolean}]}` — only what this environment has switched on **and** configured. A client renders this list; it must not hard-code the three names | 60 / 900s | — |
| POST `/auth/login/otp/request` | phoneNumber, channel? | 200 `{accepted:true}`, **or** 200 `{accepted:true, linkRequired:true, platform, linkToken, deepLink, expiresIn}` when the chosen messenger is not linked yet — no code was sent, the bot will send it after the user shares their contact | 10 / 900s | required |
| POST `/auth/login/otp/verify` | (phoneNumber \| otpToken) + otpCode(6) | 200 tokens | 20 / 900s | — |
| POST `/auth/refresh` | refreshToken? (else cookie) | 200 tokens (rotated); on `ok:false` **clears the `refresh_token` cookie** — a token that no longer resolves to a live session can never succeed again, so it is not left in the browser. **Rotating, so single-use and single-caller**: it revokes the session the token names and mints a replacement, and a caller that does not store the new cookie has signed the user out. Ask `GET /auth/session` instead of using this as a probe (ADR-0013) | — | — |
| GET `/auth/session` | cookie only | 200 `{active}` — read-only "does this refresh token still resolve to a live session?". Mutates nothing; a dead cookie is still cleared, since it can never succeed again. Answers from Postgres, not the Redis liveness cache. This is the question `panel-web`'s proxy asks server-to-server before rendering an auth screen (F-0101) | — | — |
| POST `/auth/logout` | refreshToken? (else cookie) | 200 `{success:true}`; clears cookie | — | — |
| POST `/auth/password/forgot` | phoneNumber, channel? | 200 `{accepted:true}`, or the same `linkRequired` shape as `login/otp/request` | 10 / 900s | required |
| POST `/auth/password/forgot/verify-otp` | phoneNumber, otpCode(6) | 200 `{resetToken}` | 20 / 900s (default — `FORGOT_VERIFY_RATE_LIMIT`) | — |
| POST `/auth/password/reset` | resetToken, newPassword | 200 `{success:true}` + tokens + sets `refresh_token` cookie. Every session the account had is revoked first; the returned one is minted after that revocation, so this device stays signed in and no other does | — | — |
| POST `/auth/bots/link/status` | linkToken | 200 `{state:"pending"\|"linked"\|"failed", otpSent, failureKey?}` — polled by the screen showing the deep link | 120 / 900s | — |
| POST `/auth/bots/link/resolve` | platform, chatId, startToken?, languageCode? | 200 `{state, needsContact, otpSent, messageKey, failureKey?, lang}` — what a `/start` means for this chat. **Service callers only**; anyone else gets 404 | 30 / 60s per chat | — |
| POST `/auth/bots/link/contact` | platform, chatId, senderId, contact | 200, same outcome shape — the shared contact, checked against its sender (invariant #12). **Service callers only**; 404 otherwise | 10 / 300s per chat | — |
| POST `/auth/bots/session` | platform, chatId, senderId?, contact? | 200 `{state:"authenticated", tokens}` — the ordinary token pair, because a contact-verified link **is** a credential (ADR-0012); `{state:"needsContact"}` when this chat has none yet and must send its card; `{ok:false, msg}` when the factor does not apply (`auth.botFactorNotAllowed` for a privileged role, `otp.botLink.noAccount`, `auth.invalidCredentials`). **Service callers only**; 404 otherwise | 10 / 300s per chat | — |
| POST `/auth/bots/webapp/session` | platform, initData | 200 `{state:"authenticated", accessToken, expiresIn}` + sets `refresh_token` cookie — the Mini App presenting the signature its platform handed it (`F-310`, ADR-0017). `initData` is verified against that bot's token (HMAC-SHA-256, secret = `HMAC("WebAppData", token)`) and accepted for one hour after it was signed; the account it names is then subject to the identical rule as `/auth/bots/session`. `{state:"needsContact"}` when that messenger account has never shared its card — a Mini App cannot ask for one, so this is a refusal the *chat* closes. Every verification failure — forged, replayed, edited, or a bot this deployment has not configured — is the one answer `auth.invalidCredentials`. **Public**: the caller is a browser, and the signature is the credential | 20 / 900s | — |
| POST `/auth/bots/:platform/webhook/:secret` | a Telegram/Bale `Update` | 200 `{ok:true}` **always** (a non-2xx makes the platform redeliver). `platform` is `telegram`\|`bale`; `:secret` is `TELEGRAM_WEBHOOK_SECRET`/`BALE_WEBHOOK_SECRET`, compared in constant time, and Telegram's `X-Telegram-Bot-Api-Secret-Token` header is checked too when present. A wrong secret, an unknown platform, or an unconfigured bot answers **404**, indistinguishable from a route that does not exist | 30 / 60s per chat | — |
| POST `/auth/accounts/add/otp/request` | phoneNumber, channel? | 200 `{accepted:true}`, or the same `linkRequired` shape as `login/otp/request`. **Bearer required**; deliberately not behind the F-0101 check — a live session is this route's premise (C-21). The code is `OtpPurpose.account_switch_link`, its own purpose, so it can never be spent as a login | 10 / 900s **per caller** | — |
| POST `/auth/accounts/add/otp/verify` | phoneNumber, otpCode(6) | 200 `{groupId, added, userId}`. `added:false` means it was already in the caller's own group. `userId` is the account that joined — the caller typed a phone number, so this is the only name it has for it, and it is what a surface then switches to | 20 / 900s per caller | — |
| POST `/auth/accounts/add/password` | identifier, password | 200 `{groupId, added, userId}`, `userId` as above. Consumes the same per-account `login-failures` bucket as a password login | 20 / 900s per caller | — |
| GET  `/auth/accounts` | — | 200 `{groupId, current, members}` — `{userId, fullName, phoneMasked}` each, `current` being the caller. Members are the caller's **own tenant** only (C-22); no group yet answers `members: []` | 120 / 900s per caller | — |
| POST `/auth/accounts/switch` | userId | 200 tokens + `{userId, fullName}` + sets `refresh_token` cookie, and the caller's session is revoked `account_switched` in the same transaction. **No credential in the body** — that is the point of the group. Not a member, another group, another tenant, deleted or suspended all answer the one business rejection `accountSwitch.notAMember` | 30 / 900s per caller | — |
| POST `/auth/accounts/remove` | userId | 200 `{userId, removed}` (F-0208). Removes that member from the group **on this surface only**, and revokes that account's sessions in this scope alone (`account_unlinked`) — its sessions elsewhere are untouched. Works from either side: `userId` may be the caller's own, which is how an account leaves. Mints nothing and sets no cookie, so a self-removal is a sign-out. Every refusal is `accountSwitch.notAMember` | 30 / 900s per caller | — |
| POST `/auth/captcha/challenge` | — | 200 `{challengeId}`, 60s to complete the slide | 30 / 900s (default — `CAPTCHA_RATE_LIMIT`) | — |
| POST `/auth/captcha/verify` | challengeId | 200 `{token, expiresIn:120}` — `err('captcha.invalid')` if unknown/expired/too-fast | 30 / 900s (default — `CAPTCHA_RATE_LIMIT`) | — |
| POST `/admin/users/:userId/impersonate` | reasonNote (>=10) | 200 `{accessToken, expiresIn:1800}` | — (needs `user.impersonate`) | — |
| POST `/admin/impersonate/end` | — | 200 | — (Bearer of the impersonated session) | — |

`tokens` = `{ accessToken, expiresIn }` in `data`; `refreshToken` is stripped
from the body and set as the cookie.

## Response envelopes

Three shapes, all from `response.util.ts` + the global `I18nExceptionFilter`.
`msg` is always an i18n key, translated into the request's language.

| | shape | HTTP status | when |
|---|---|---|---|
| success | `{ ok: true, msg, data }` | the handler's own (200/201) | `ok(...)` |
| business rejection | `{ ok: false, msg, error: null }` | **the handler's own — 200, or 201 on `register`** | `err(...)` |
| thrown error | `{ ok: false, msg, ref, fieldErrors?: [{path,message}] }` | 4xx / 5xx | any exception |

A **business rejection** is an expected outcome the service decided on, not a
failure of the request: wrong password, a phone number already registered, a
refresh token that no longer resolves to a session. `err(...)` is a returned
*value*, so it never reaches the exception filter — which is why it carries no
`ref` (there is no server-side log line to correlate with) and why the status
code is whatever the route declares. `POST /auth/register` answers **201 with
`ok: false`** for `register.duplicateUser`.

A **thrown error** is everything else: validation, the guards (`captcha.required`,
429, 409 `auth.alreadyAuthenticated`), and any bug. It is sanitized —
`ref` is a correlation id for the one server log line that holds the real
detail, which is never sent to the client.

This is deliberate (decided 2026-09-05), and it is the reason for the rule
above: a client that branches on the status code reads every business
rejection as a success. `panel-web` branches on `ok`; so must any new client.
Pinned by `auth-service-e2e/src/auth-service/contract.e2e.spec.ts`.

## Status codes

On a **thrown** error the status is meaningful; on a business rejection it is
not (see above).

- 200 / 201 success — **or a business rejection**; `ok` tells them apart.
- 400 validation (`fieldErrors`) or a guard's refusal (`captcha.required`).
- 401 bad/missing/expired token or revoked session (`AuthGuard`).
- 403 insufficient permission / impersonation of a non-lower role / sensitive
  action during impersonation.
- 409 `auth.alreadyAuthenticated` (F-0101), or an OTP issue already in flight
  for this (phone, purpose). A duplicate registration is **not** a 409 — it is
  a business rejection, `register.duplicateUser` with the route's own 201.
- 429 `RateLimitGuard` (the per-IP limits in the table), the OTP request
  cooldown, or OTP attempts exhausted. The per-account login lockout is **not**
  a 429 — it is a business rejection, `auth.temporarilyLocked` with 200.
- 500 unexpected — envelope `msg` = `system.unexpected`, real error only in logs
  keyed by `ref`.

## Emits / Consumes

Emits: nothing (no bus). Consumes: `identity` (all logic), `i18n` (strings),
`redis-keyspace` (sessions/OTP/rate limits/captcha).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `POST /auth/bots/:platform/webhook/:secret` | 2026-09-06 | 2026-12-06 | `POST /api/bot/:platform/webhook/:secret` on `bot-service`. A bot token holds exactly one webhook URL, so only one service may own it (ADR-0011); this route still answers, but `BotWebhookRegistrar` moved and nothing points a bot here any more |
| `POST /auth/register/verify-phone` body keyed by `userId` | 2026-09-04 | already removed | keyed by `phoneNumber` — register no longer creates a `user` row to key by |

## Version history

Every version of this contract, what it changed and who it affected, is in
[contract.versions.md](contract.versions.md). It moved out of this file at 250
lines (§10): a wire contract is read to answer "what does this endpoint do
now", and a growing history of what it used to do pushes that answer further
down the page every release.
