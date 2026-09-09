---
id: auth-api
layer: interface
status: active
version: 12
updated: 2026-09-09
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
  `bot-service` and, since F-031-c, `worker-service` — sends `X-Service-Token` (compared in constant time
  against `SERVICE_AUTH_TOKEN`) and optionally `X-Bot-Chat-Id`. A valid token
  does exactly two things: the captcha requirement is waived, and the per-IP
  rate-limit bucket becomes a per-chat one (every bot call shares one IP, so the
  per-IP bucket would lock out the whole bot). It is **not** an authentication:
  it names the calling process, never a user, and every route still proves the
  person the same way. A missing or wrong token behaves exactly as before.
  On the `/internal/*` routes it does more, because those have no user to
  prove: there it is the whole door, and `ServiceOnlyGuard` answers 404 without
  it — the same answer a route that does not exist gives, so the seam cannot be
  mapped by probing. Two callers use it for opposite reasons: `bot-service`
  asks *which tenant* an inbound webhook belongs to, and `worker-service` asks
  for work to be done in a process it cannot import (an Nx app cannot import an
  Nx app). Both are `@TenantAgnostic`, and that is not a widening: a sweep
  across every tenant's expired credential versions has no tenant to be scoped
  to, and neither does the question "whose webhook is this".
- **Every rate-limit bucket is per tenant** (F-1206, catalog 20.2 layer 6). The
  subject a route names — an IP, a bot chat id, a caller's user id, or the
  identity a login attempt was made against — is prefixed with the request's
  resolved tenant before it becomes a counter, in `RedisKeys.rateLimit` rather
  than in `rateLimitSubject()`, so the two captcha routes and the
  `login-failures:<identity>` counter are covered without having asked. Two
  resellers therefore never share a budget: an IP is the internet's and a chat
  id is the messenger's, so both arrive identical at every reseller's front
  door, and one tenant's traffic used to be able to lock out another's users —
  most sharply through `login-failures`, where ten bad passwords against one
  reseller's `admin` locked every reseller's. A request that resolved to no
  tenant is still counted, under a segment no tenant id can equal. The rule and
  what it costs are in `redis-keyspace/contract.md`.
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
| POST `/internal/bot-integrations/resolve` | platform, webhookPath | 200 the `BotIntegration` that path names — tenant, platform, username, role, status, `credentialRef`. **Never a credential.** **Service callers only**; anyone else, and any unknown path, gets 404 | — | — |
| POST `/internal/bot-integrations/registrable` | — | 200 every integration whose webhook the platform should keep live, `disabled` rows excluded (F-321). No credentials. **Service callers only** | — | — |
| POST `/internal/bot-integrations/registration-result` | platform, webhookPath, ok | 200 `{recorded:true}` — writes `status` and `lastErrorAt`, which is what a tenant sees when its bot stops answering. **Service callers only** | — | — |
| POST `/internal/bot-integrations/has-token` | platform, webhookPath | 200 `{configured}` — asked without decrypting anything, so it writes no audit row. **Service callers only** | — | — |
| POST `/internal/bot-integrations/verify-secret` | platform, webhookPath, candidate | 200 `{valid}` — a fingerprint comparison, honouring a superseded version inside its rotation grace window (ADR-0026 decision 4). No decryption. **Service callers only** | — | — |
| POST `/internal/bot-integrations/webhook-secret` | platform, webhookPath, caller? | 200 `{secret}` — a **plaintext**, for the process registering the webhook upstream. Audited. **Service callers only** | — | — |
| POST `/internal/bot-integrations/token` | platform, webhookPath, caller? | 200 `{token}` — a **plaintext** bot token, for the process that is about to send as that bot. Every call writes a vault audit row naming `bot-service:<caller>` (F-1215). **Service callers only** | — | — |
| POST `/internal/vault/destroy-expired` | — | 200 `{destroyed}` — how many superseded credential versions were past their rotation grace window and are now gone (ADR-0026 rule 4). A **count**, and nothing that names what was destroyed. Idempotent: a second call inside the same window answers 0. Called by `worker-service`'s `vault_credential_retention` job (F-031-c). **Service callers only**; anyone else gets 404 | — | — |
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
| POST `/admin/bots/:platform/:botUsername/webhook/rotate` | — | 200 `{rotated:true, registered, status}` (F-322). The bot is named by its `@handle` **within the tenant this request resolved to**, never by its path: the path is a credential, so it is neither an input nor an output. The old path stops resolving before the platform is called, so `registered:false` means a bot that is quiet, never one still listening on a burned address. 404 for an unknown platform, an unknown handle, or another tenant's bot | — (needs `bot.webhook_rotate`) | — |
| GET  `/admin/workers` | — | 200 `[{key, name, description, category, isActive, schedules:[{id, scheduleType, windowStartAt, windowEndAt, cronExpression, timezone, isActive, shapeError}], lastRun}]` (F-031-b). `shapeError` is non-null on a schedule that could never run — the one way a row typed straight into the database becomes visible | — (needs `worker.manage`) | — |
| POST `/admin/workers/:key/schedules` | scheduleType (`always_on`\|`time_window`\|`cron_expression`), windowStartAt?, windowEndAt?, cronExpression?, timezone (default `Asia/Tehran`) | 200 `{scheduleId}`. A shape the three types do not allow is a **business rejection** — `automation.invalidSchedule` with `error: {reason}` naming the rule that broke, checked by the same function the tick publisher declines on. 404 for a key no worker has registered | — (needs `worker.manage`) | — |
| PATCH `/admin/workers/:key/schedules/:scheduleId` | isActive | 200 `{scheduleId, isActive}`. There is no delete — a schedule is switched off, because `bot_execution_log` and `setByAdminId` explain past runs. 404 if that schedule is not that worker's | — (needs `worker.manage`) | — |
| PATCH `/admin/workers/:key` | isActive | 200 `{key, isActive}` — the kill switch (automation invariant #1), with a `bot_toggle` audit row written in the same transaction | — (needs `worker.manage`) | — |
| POST `/admin/workers/:key/run` | — | 200 `{published:true}` — publishes an `admin_manual` tick. It means **asked for**, never finished: the run happens in `worker-service` and its outcome is a `bot_execution_log` row. `automation.workerInactive` (a business rejection) for a worker switched off — a manual run bypasses the schedule, never the switch. 503 if the broker is unreachable or `RABBITMQ_URL` is unset | — (needs `worker.manage`) | — |

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

**`msg` is translated from one namespace: `errors`.** All three shapes, both
paths — `ResponseInterceptor` for a returned envelope, `I18nExceptionFilter` for
a thrown one — and the Go gateway too (`auth-handler`, `forward-auth` v2). A key
that can arrive both ways (`otp.invalid`, `captcha.invalid`) therefore has one
sentence, not two that drift. The interceptor used to read a `messages`
namespace no locale file defines, so every returned `msg` reached the client as
the raw key; F-064 fixed that and `response.interceptor.spec.ts` holds every
`ok()` / `err()` key in the service to both languages. The namespace is named
`errors` for history rather than accuracy — it carries success text too — and
renaming it would mean moving the Go gateway and every consumer at once.

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

Emits: `automation.tick.<key>` with `triggeredBy: admin_manual`, to the
`txnet.automation` topic exchange, from `POST /admin/workers/:key/run` alone
(F-031-b, `domains/automation/contract.md`). The connection is lazy and
`RABBITMQ_URL` is optional here: this process answers logins, so an unreachable
broker fails that one route and nothing else.

Consumes: `identity` (all logic), `i18n` (strings), `redis-keyspace`
(sessions/OTP/rate limits/captcha), `automation` (the worker registry the
`/admin/workers` routes write).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `POST /auth/bots/:platform/webhook/:secret` | 2026-09-06 | **removed 2026-09-09** | `POST /api/bots/:platform/:webhookPath` on `bot-service`. Deprecated for one release with nothing pointed at it, then removed by F-066-i: its `:secret` was `TELEGRAM_WEBHOOK_SECRET`, a variable that no longer exists, so the route could not have answered anyway |
| `POST /auth/register/verify-phone` body keyed by `userId` | 2026-09-04 | already removed | keyed by `phoneNumber` — register no longer creates a `user` row to key by |

## Version history

Every version of this contract, what it changed and who it affected, is in
[contract.versions.md](contract.versions.md). It moved out of this file at 250
lines (§10): a wire contract is read to answer "what does this endpoint do
now", and a growing history of what it used to do pushes that answer further
down the page every release.
